// ORION safety controller (Arduino UNO).
// Reads every sensor, decides every local emergency response and drives every output — with NO network involved.
// The ESP32 gateway only receives reports and forwards allow-listed commands, which this board may refuse.
// Pin map: docs/hardware-architecture.md (PROPOSED — confirm against your modules before powering anything).
#include <Arduino.h>
#include <Servo.h>
#include <avr/wdt.h>
#include <OrionCore.h>

using namespace orion;

// ---- pins ----
const uint8_t PIN_MQ2 = A0, PIN_WATER = A1, PIN_FLAME_AO = A2;
const uint8_t PIN_FLAME_DO = 2, PIN_DHT = 4, PIN_LED_RED = 5, PIN_LED_GREEN = 6, PIN_RELAY_FAN = 7, PIN_BUZZER = 8;
const uint8_t PIN_SERVO_DOOR = 9, PIN_SERVO_SG90 = 10, PIN_LIGHT_WHITE = 11, PIN_LIGHT_WARM = 12;
// ---- module polarity (MEASURE on your hardware, then set) ----
const bool FLAME_ACTIVE_LOW = true;    // most LM393 flame modules pull DO low when they see a flame
const bool RELAY_ACTIVE_LOW = true;    // many opto relay boards energise on LOW
const bool HAS_FLAME_AO = false;       // true if your flame module has an analog pin wired to A2

Mq2 mq2; Flame flame; Water water; Dht dht; SafetyController sc; LinkParser gwLink; Servo door;
uint32_t seq = 0, lastTelemetry = 0, lastHeartbeat = 0, lastDht = 0, lastRx = 0, lastActuators = 0;
uint8_t bootReason = 0;

// Optiboot clears MCUSR before the sketch starts but passes the reset flags in register r2.
// Capture them before the C runtime runs (standard technique), so we can tell power-on from a watchdog reset.
uint8_t resetFlags __attribute__((section(".noinit")));
void resetFlagsInit(void) __attribute__((naked)) __attribute__((used)) __attribute__((section(".init0")));
void resetFlagsInit(void) { __asm__ __volatile__("sts %0, r2\n" : "=m"(resetFlags) :); }

// ---------------- DHT22 (bit-banged; ≥ 2 s between reads) ----------------
static bool readDht22(float& t, float& h) {
  uint8_t d[5] = {0};
  pinMode(PIN_DHT, OUTPUT); digitalWrite(PIN_DHT, LOW); delay(2);
  digitalWrite(PIN_DHT, HIGH); delayMicroseconds(30); pinMode(PIN_DHT, INPUT_PULLUP);
  noInterrupts();
  // response: low ~80 µs, high ~80 µs, then 40 bits
  if (pulseIn(PIN_DHT, LOW, 200) == 0) { interrupts(); return false; }
  if (pulseIn(PIN_DHT, HIGH, 200) == 0) { interrupts(); return false; }
  for (uint8_t i = 0; i < 40; i++) {
    unsigned long hi = pulseIn(PIN_DHT, HIGH, 200);
    if (hi == 0) { interrupts(); return false; }
    d[i / 8] = (uint8_t)((d[i / 8] << 1) | (hi > 40 ? 1 : 0));
  }
  interrupts();
  if ((uint8_t)(d[0] + d[1] + d[2] + d[3]) != d[4]) return false;  // checksum
  h = ((d[0] << 8) | d[1]) * 0.1f;
  int16_t rawT = ((d[2] & 0x7F) << 8) | d[3];
  t = (d[2] & 0x80 ? -rawT : rawT) * 0.1f;
  return true;
}

static void send(char type, const long* f, uint8_t n) {
  char buf[kLinkMax + 8];
  size_t len = buildFrame(buf, sizeof(buf), type, f, n);
  if (len) Serial.write((const uint8_t*)buf, len);
}

static void writeOutputs() {
  const Outputs& o = sc.out;
  digitalWrite(PIN_RELAY_FAN, (o.fan ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
  digitalWrite(PIN_BUZZER, o.buzzer ? HIGH : LOW);
  digitalWrite(PIN_LED_RED, o.ledRed ? HIGH : LOW);
  bool blinkOff = o.faultBlink && ((millis() / 500) % 2);
  digitalWrite(PIN_LED_GREEN, (o.ledGreen && !blinkOff) ? HIGH : LOW);
  digitalWrite(PIN_LIGHT_WHITE, o.lightWhite ? HIGH : LOW);
  digitalWrite(PIN_LIGHT_WARM, o.lightWarm ? HIGH : LOW);
  door.write(o.doorAngle);
}

static void handleFrame(const Frame& f, uint32_t now) {
  lastRx = now;
  if (f.type == 'C' && f.n >= 5) {  // C,seq,cmd_idx,actuator,action,ttl_s
    CmdResult r = sc.command((Actuator)f.f[2], (Action)f.f[3], (uint32_t)f.f[4] * 1000UL, now);
    long k[] = {(long)++seq, f.f[1], (long)r};
    send('K', k, 3);
    writeOutputs();
  }
}

void setup() {
  bootReason = MCUSR | resetFlags; MCUSR = 0;   // why we restarted (watchdog, brown-out, power-on…)
  wdt_disable();
  // Safe defaults BEFORE anything else: fan off, buzzer off, door at rest, green LED on.
  pinMode(PIN_RELAY_FAN, OUTPUT); digitalWrite(PIN_RELAY_FAN, RELAY_ACTIVE_LOW ? HIGH : LOW);
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_LED_RED, OUTPUT); pinMode(PIN_LED_GREEN, OUTPUT); pinMode(PIN_LIGHT_WHITE, OUTPUT); pinMode(PIN_LIGHT_WARM, OUTPUT);
  pinMode(PIN_FLAME_DO, INPUT);
  door.attach(PIN_SERVO_DOOR); door.write(cfg::DOOR_REST_ANGLE);
  Serial.begin(38400);
  uint32_t now = millis();
  // Warm-up lockout only after a real power-on (PORF). A watchdog/brown-out restart keeps detecting immediately.
  // Unknown cause (no flags) is treated as a power-on: the boot reason is reported to the server either way.
  bool cold = (bootReason & _BV(PORF)) || !(bootReason & (_BV(WDRF) | _BV(BORF) | _BV(EXTRF)));
  mq2.begin(now, cold); sc.begin(now);
  writeOutputs();
  wdt_enable(WDTO_2S);                    // if the loop ever hangs for 2 s, the board resets to the safe defaults above
}

void loop() {
  wdt_reset();
  uint32_t now = millis();
  // ---- link input ----
  Frame fr;
  while (Serial.available()) if (gwLink.feed((char)Serial.read(), fr)) handleFrame(fr, now);
  bool linkOk = (uint32_t)(now - lastRx) < cfg::LINK_TIMEOUT_MS;
  // ---- sensors (every loop, ~10 ms) ----
  mq2.update(analogRead(PIN_MQ2), now);
  bool flameDo = digitalRead(PIN_FLAME_DO) == (FLAME_ACTIVE_LOW ? LOW : HIGH);
  flame.update(flameDo, HAS_FLAME_AO ? analogRead(PIN_FLAME_AO) : -1);
  water.update(analogRead(PIN_WATER));
  if ((uint32_t)(now - lastDht) >= 2500) {
    lastDht = now; float t, h;
    if (readDht22(t, h)) dht.success(t, h, now); else dht.failure();
  }
  // ---- decide + act (local, immediate) ----
  sc.step(now, mq2, flame, water, dht, linkOk);
  writeOutputs();
  // ---- report ----
  Event e;
  while (sc.popEvent(e)) { long f[] = {(long)++seq, (long)e.hazard, (long)e.code}; send('E', f, 3); }
  if (sc.gsmRequest) { long f[] = {(long)++seq, (long)sc.gsmHazard}; send('G', f, 2); sc.gsmRequest = false; }
  if ((uint32_t)(now - lastTelemetry) >= 2000) {
    lastTelemetry = now;
    bool dhtOk = dht.current(now) && dht.quality == Quality::Valid;
    long f[] = {(long)++seq, mq2.raw, (long)mq2.quality, (long)mq2.level, (long)mq2.warmupLeftS(now),
                flame.detected ? 1L : 0L, (long)flame.quality, water.raw, (long)water.quality, water.wet ? 1L : 0L,
                dhtOk ? (long)(dht.tempC * 10) : -9999L, dhtOk ? (long)(dht.humidity * 10) : -9999L,
                (long)(dht.current(now) ? dht.quality : Quality::Fault)};
    send('T', f, 13);
  }
  if ((uint32_t)(now - lastActuators) >= 2000) {
    lastActuators = now; const Outputs& o = sc.out;
    long f[] = {(long)++seq, o.fan, o.buzzer, o.doorAngle, o.ledRed, o.ledGreen, o.lightWhite, o.lightWarm, (long)sc.fanCooldownLeftS(now), o.faultBlink};
    send('A', f, 10);
  }
  if ((uint32_t)(now - lastHeartbeat) >= 2000) {
    lastHeartbeat = now; long f[] = {(long)++seq, (long)(now / 1000), (long)bootReason}; send('H', f, 3);
  }
  delay(10);
}
