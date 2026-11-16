// ORION gateway (ESP32): UNO link <-> MQTT, SIM800C alerts, offline buffering.
// The safety decisions are made by the UNO. This board never overrides them; it only reports and forwards
// allow-listed commands. SMS/calls are sent on UNO hazard events WITHOUT needing Wi-Fi or the server.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <Preferences.h>
#include <OrionCore.h>
#include "secrets.h"

using namespace orion;

// UART2 <-> UNO (through the level shifter), UART1 <-> SIM800C
const int PIN_UNO_RX = 16, PIN_UNO_TX = 17, PIN_GSM_RX = 26, PIN_GSM_TX = 27, PIN_GSM_PWRKEY = 25, PIN_STATUS_LED = 2;
HardwareSerial& UNO = Serial2;
HardwareSerial GSM(1);

WiFiClient plain;
WiFiClientSecure secure;
PubSubClient mqtt;
LinkParser unoLink;
const char* NUMBERS[] = EMERGENCY_NUMBERS;
const size_t NUMBERS_N = sizeof(NUMBERS) / sizeof(NUMBERS[0]);

// Emergency contacts from the ORION app (server → retained MQTT "config"), saved in flash so local alerts keep
// working after a reboot and without internet. The compiled-in EMERGENCY_NUMBERS are only a fallback.
struct Contact { char phone[20]; bool sms; bool call; };
Contact contacts[5]; uint8_t contactsN = 0;
Preferences nvs;
void loadContacts() {
  nvs.begin("orion", true);
  contactsN = nvs.getUChar("n", 0); if (contactsN > 5) contactsN = 0;
  if (contactsN) nvs.getBytes("c", contacts, sizeof(Contact) * contactsN);
  nvs.end();
}
void saveContacts() {
  nvs.begin("orion", false); nvs.putUChar("n", contactsN); nvs.putBytes("c", contacts, sizeof(Contact) * contactsN); nvs.end();
}

String topic(const char* kind) { return String("orion/") + HOME_ID + "/" + GATEWAY_ID + "/" + kind; }
uint32_t seq = 0, lastUnoRx = 0, unoBoot = 0, lastHb = 0, lastGsm = 0, mqttRetryAt = 0, mqttBackoff = 1000, attemptId = 1;
bool unoSeen = false;
char unoFw[16] = "unknown";

// ---------------- offline buffer for events and GSM reports (telemetry is not buffered: it would be stale) ----------------
struct Pending { char topic[64]; char body[480]; };
Pending pend[24]; uint8_t pendHead = 0, pendN = 0;
void publishOrBuffer(const String& t, const String& body) {
  if (mqtt.connected() && mqtt.publish(t.c_str(), body.c_str())) return;
  Pending& p = pend[(pendHead + pendN) % 24];
  strlcpy(p.topic, t.c_str(), sizeof(p.topic)); strlcpy(p.body, body.c_str(), sizeof(p.body));
  if (pendN < 24) pendN++; else pendHead = (pendHead + 1) % 24;   // keep the newest
}
void flushPending() {
  while (pendN && mqtt.connected()) {
    Pending& p = pend[pendHead];
    if (!mqtt.publish(p.topic, p.body)) break;
    pendHead = (pendHead + 1) % 24; pendN--;
  }
}

// ---------------- SIM800C adapter ----------------
struct GsmIO : ModemIO {
  void write(const char* s) override { GSM.print(s); }
  int read() override { return GSM.available() ? GSM.read() : -1; }
  uint32_t millis() override { return ::millis(); }
  void powerPulse() override { digitalWrite(PIN_GSM_PWRKEY, HIGH); delay(1200); digitalWrite(PIN_GSM_PWRKEY, LOW); }
} gsmIo;
Sim800 sim(gsmIo);
const char* HAZARD_NAME[] = {"none", "smoke", "flame", "water"};
const char* HAZARD_SENSOR[] = {"", SENSOR_MQ2, SENSOR_FLAME, SENSOR_WATER};
void raiseGsm(uint8_t hazard) {
  char text[160];
  snprintf(text, sizeof(text), "ORION ALERT: %s detected at home. Check immediately. If there is danger call 112 / 101.", hazard == 2 ? "FLAME" : hazard == 1 ? "SMOKE" : "HAZARD");
  if (contactsN) {
    bool called = false;
    for (uint8_t i = 0; i < contactsN; i++) {
      if (contacts[i].sms) sim.sms(attemptId++, contacts[i].phone, text, hazard);
      if (contacts[i].call && !called) { sim.call(attemptId++, contacts[i].phone, hazard); called = true; }  // one call: the first call contact
    }
    return;
  }
  for (size_t i = 0; i < NUMBERS_N; i++) sim.sms(attemptId++, NUMBERS[i], text, hazard);
  if (NUMBERS_N) sim.call(attemptId++, NUMBERS[0], hazard);
}

// ---------------- UNO frames -> MQTT ----------------
const char* QUALITY[] = {"valid", "warming_up", "fault", "disconnected"};
const char* LEVEL[] = {"normal", "warning", "critical", "unknown"};
const char* EVENT_TEXT[] = {"", "Smoke: red LED ON, buzzer ON, exhaust fan ON, MG995 door 180° for 5 s", "Smoke ended: buzzer OFF, fan cooldown 60 s started",
  "MG995 door returned to rest", "Exhaust fan OFF (cooldown ended)", "Flame: red LED ON, lights OFF, SMS and call requested", "Flame ended: lights restored",
  "Water detected", "Water no longer detected", "Smoke reached the critical level"};
String cmdIds[8]; uint8_t cmdNext = 0;

void onUnoFrame(const Frame& f) {
  uint32_t now = millis(); lastUnoRx = now; unoSeen = true;
  JsonDocument d;
  String out;
  if (f.type == 'T' && f.n >= 13) {
    d["seq"] = ++seq; d["controller"] = CONTROLLER_ID;
    JsonArray r = d["readings"].to<JsonArray>();
    JsonObject m = r.add<JsonObject>(); m["sensor"] = SENSOR_MQ2; m["quality"] = QUALITY[f.f[2] & 3]; m["state"] = LEVEL[f.f[3] & 3];
    if (f.f[2] == 0) m["fields"]["raw_adc"] = f.f[1]; else m["fields"]["raw_adc"] = nullptr;  // only valid readings carry a value
    m["warmup_remaining_s"] = f.f[4]; m["fw_threshold"]["warning"] = cfg::MQ2_WARNING; m["fw_threshold"]["critical"] = cfg::MQ2_CRITICAL;
    JsonObject fl = r.add<JsonObject>(); fl["sensor"] = SENSOR_FLAME; fl["quality"] = QUALITY[f.f[6] & 3]; fl["state"] = f.f[5] ? "critical" : "normal"; fl["fields"]["detected"] = (bool)f.f[5];
    JsonObject w = r.add<JsonObject>(); w["sensor"] = SENSOR_WATER; w["quality"] = QUALITY[f.f[8] & 3]; w["state"] = f.f[9] ? "warning" : "normal";
    w["fields"]["raw_adc"] = f.f[7]; w["fields"]["wet"] = (bool)f.f[9]; w["fw_threshold"]["wet"] = cfg::WATER_WET;
    JsonObject t = r.add<JsonObject>(); t["sensor"] = SENSOR_DHT;
    bool ok = f.f[10] != -9999 && f.f[12] == 0;
    t["quality"] = ok ? "valid" : "fault"; t["state"] = ok ? "normal" : "unknown";
    if (ok) { t["fields"]["temperature_c"] = f.f[10] / 10.0; t["fields"]["humidity_percent"] = f.f[11] / 10.0; }
    else { t["fields"]["temperature_c"] = nullptr; t["fields"]["humidity_percent"] = nullptr; t["fault"] = "read failure or stale"; }
    serializeJson(d, out); if (mqtt.connected()) mqtt.publish(topic("telemetry").c_str(), out.c_str());
  } else if (f.type == 'A' && f.n >= 10) {
    d["seq"] = ++seq; d["controller"] = CONTROLLER_ID; JsonObject a = d["actuators"].to<JsonObject>();
    a["fan"]["commanded"] = f.f[1] ? "on" : "off"; a["fan"]["name"] = "12 V exhaust fan"; a["fan"]["cooldown_remaining_s"] = f.f[8]; a["fan"]["feedback"] = false; a["fan"]["by"] = "UNO firmware";
    a["buzzer"]["commanded"] = f.f[2] ? "on" : "off"; a["buzzer"]["name"] = "Buzzer"; a["buzzer"]["feedback"] = false;
    a["mg995"]["target_angle"] = f.f[3]; a["mg995"]["name"] = "MG995 servo — model door"; a["mg995"]["reported_position"] = nullptr; a["mg995"]["feedback"] = false;
    a["sg90"]["name"] = "SG90 servo — purpose pending"; a["sg90"]["target_angle"] = nullptr; a["sg90"]["feedback"] = false;
    JsonObject rl = a["relay"].to<JsonObject>(); rl["name"] = "5 V relay module"; rl["active_level"] = "set in firmware"; rl["feedback"] = false;
    JsonObject ch = rl["channels"].to<JsonArray>().add<JsonObject>(); ch["ch"] = 1; ch["load"] = "Exhaust fan"; ch["commanded"] = f.f[1] ? "energised" : "de-energised";
    JsonObject leds = a["leds"].to<JsonObject>(); leds["name"] = "Indicator LEDs"; leds["feedback"] = false; JsonArray it = leds["items"].to<JsonArray>();
    const char* ids[] = {"led-red", "led-green", "led-white", "led-warm"}; const char* names[] = {"Red — warning", "Green — status normal", "White — model lighting", "Warm-white — model lighting"};
    for (int i = 0; i < 4; i++) { JsonObject l = it.add<JsonObject>(); l["id"] = ids[i]; l["name"] = names[i]; l["commanded"] = f.f[4 + i] ? "on" : "off"; }
    serializeJson(d, out); if (mqtt.connected()) mqtt.publish(topic("actuators").c_str(), out.c_str());
  } else if (f.type == 'E' && f.n >= 3) {
    uint8_t hz = f.f[1] & 3, code = f.f[2] < 10 ? f.f[2] : 0;
    d["seq"] = ++seq; d["controller"] = CONTROLLER_ID; d["kind"] = "action"; d["hazard"] = HAZARD_NAME[hz]; d["sensor"] = HAZARD_SENSOR[hz]; d["text"] = EVENT_TEXT[code];
    serializeJson(d, out); publishOrBuffer(topic("event"), out);
  } else if (f.type == 'G' && f.n >= 2) {
    raiseGsm(f.f[1] & 3);
  } else if (f.type == 'K' && f.n >= 3) {
    uint8_t idx = f.f[1] & 7; long res = f.f[2];
    const char* notes[] = {"Output driven by the UNO; physical result unverified (no feedback sensor)", "Refused by the UNO's local safety rule (smoke / cooldown)", "Not allowed by the UNO", "Expired before it reached the UNO"};
    auto ack = [&](const char* st, const char* note) { JsonDocument a; a["command_id"] = cmdIds[idx]; a["status"] = st; a["note"] = note; String s; serializeJson(a, s); publishOrBuffer(topic("cmd_ack"), s); };
    if (res == 0) { ack("accepted", "UNO accepted"); ack("executed_unverified", notes[0]); } else ack("rejected", notes[res & 3]);
  } else if (f.type == 'H' && f.n >= 3) {
    unoBoot = f.f[2];
  }
}

// ---------------- MQTT -> UNO ----------------
void onMqtt(char* t, byte* payload, unsigned int len) {
  JsonDocument d;
  if (deserializeJson(d, payload, len)) return;
  if (String(t).endsWith("/config")) {
    JsonArray cs = d["contacts"].as<JsonArray>();
    if (cs.isNull()) return;
    contactsN = 0;
    for (JsonObject c : cs) {
      const char* ph = c["phone"] | "";
      if (!*ph || contactsN >= 5) continue;
      strlcpy(contacts[contactsN].phone, ph, sizeof(contacts[0].phone));
      contacts[contactsN].sms = c["sms"] | true; contacts[contactsN].call = c["call"] | false; contactsN++;
    }
    saveContacts();
    return;
  }
  const char* id = d["command_id"] | ""; const char* act = d["actuator"] | ""; const char* action = d["action"] | ""; long ttl = d["ttl_ms"] | 0;
  if (!*id) return;
  uint8_t idx = cmdNext++ & 7; cmdIds[idx] = id;
  int a = !strcmp(act, "fan") ? 1 : !strcmp(act, "buzzer") ? 2 : 0;
  int b = !strcmp(action, "on") ? 1 : !strcmp(action, "off") ? 2 : !strcmp(action, "test") ? 3 : 0;
  auto reject = [&](const char* note) { JsonDocument r; r["command_id"] = id; r["status"] = "rejected"; r["note"] = note; String s; serializeJson(r, s); mqtt.publish(topic("cmd_ack").c_str(), s.c_str()); };
  if (!a || !b) { reject("Unknown command at the gateway"); return; }
  if (!unoSeen || millis() - lastUnoRx > cfg::LINK_TIMEOUT_MS) { reject("Safety controller (UNO) not reachable — command not delivered"); return; }
  long f[] = {(long)++seq, idx, a, b, ttl / 1000 > 0 ? ttl / 1000 : 1};
  char buf[kLinkMax + 8]; size_t n = buildFrame(buf, sizeof(buf), 'C', f, 5); UNO.write((const uint8_t*)buf, n);
}

void ensureMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected() || (int32_t)(millis() - mqttRetryAt) < 0) return;
  String will = topic("status");
  if (mqtt.connect(GATEWAY_ID, GATEWAY_ID, MQTT_PASSWORD, will.c_str(), 1, true, "{\"online\":false}")) {
    mqttBackoff = 1000;
    mqtt.publish(will.c_str(), "{\"online\":true,\"fw\":\"0.3.0\",\"boot_reason\":\"power_on\"}", true);
    mqtt.subscribe(topic("cmd").c_str(), 1);
    mqtt.subscribe(topic("config").c_str(), 1);
    flushPending();
  } else {
    mqttRetryAt = millis() + mqttBackoff; mqttBackoff = min<uint32_t>(mqttBackoff * 2, 30000);
  }
}

void reportGsm() {
  JsonDocument d; d["seq"] = ++seq;
  JsonObject m = d["module"].to<JsonObject>(); m["id"] = GSM_MODULE_ID; m["registered"] = sim.ready && sim.registered; m["csq"] = sim.csq; m["sim"] = sim.simReady ? "READY" : "NOT READY";
  JsonArray at = d["attempts"].to<JsonArray>();
  const char* ST[] = {"queued", "sending", "sent", "failed", "timeout", "answered"};
  bool any = false;
  for (uint8_t i = 0; i < sim.count; i++) {
    Attempt& a = sim.attempts[i];
    JsonObject o = at.add<JsonObject>(); char id[24]; snprintf(id, sizeof(id), "%s-%lu", GATEWAY_ID, (unsigned long)a.id);
    o["id"] = id; o["type"] = a.type == AttemptType::Sms ? "sms" : "call"; o["destination"] = a.number; o["status"] = ST[(int)a.status]; o["note"] = a.note;
    if (a.tag) { o["hazard"] = HAZARD_NAME[a.tag & 3]; o["sensor"] = HAZARD_SENSOR[a.tag & 3]; }
    any |= a.changed; a.changed = false;
  }
  String s; serializeJson(d, s); publishOrBuffer(topic("gsm"), s);
  (void)any;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_STATUS_LED, OUTPUT); pinMode(PIN_GSM_PWRKEY, OUTPUT); digitalWrite(PIN_GSM_PWRKEY, LOW);
  UNO.begin(38400, SERIAL_8N1, PIN_UNO_RX, PIN_UNO_TX);
  GSM.begin(9600, SERIAL_8N1, PIN_GSM_RX, PIN_GSM_TX);
  sim.begin();
  loadContacts();
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
#if MQTT_TLS
  secure.setCACert(MQTT_CA_CERT); mqtt.setClient(secure);
#else
  mqtt.setClient(plain);
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT); mqtt.setCallback(onMqtt); mqtt.setBufferSize(1024); mqtt.setKeepAlive(15);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wc = {.timeout_ms = 10000, .idle_core_mask = 0, .trigger_panic = true}; esp_task_wdt_reconfigure(&wc);
#else
  esp_task_wdt_init(10, true);
#endif
  esp_task_wdt_add(NULL);
}

void loop() {
  esp_task_wdt_reset();
  uint32_t now = millis();
  Frame fr;
  while (UNO.available()) if (unoLink.feed((char)UNO.read(), fr)) onUnoFrame(fr);
  sim.poll();                                  // GSM works with or without Wi-Fi
  ensureMqtt(); mqtt.loop();
  if (now - lastHb >= 2000) {
    lastHb = now;
    long hb[] = {(long)++seq, (long)(now / 1000)}; char buf[kLinkMax + 8]; size_t n = buildFrame(buf, sizeof(buf), 'H', hb, 2); UNO.write((const uint8_t*)buf, n);
    bool unoOk = unoSeen && now - lastUnoRx < cfg::LINK_TIMEOUT_MS;
    JsonDocument d; d["seq"] = ++seq; d["uptime_s"] = now / 1000; d["rssi"] = WiFi.RSSI();
    JsonObject c = d["controllers"].to<JsonArray>().add<JsonObject>(); c["id"] = CONTROLLER_ID; c["link_ok"] = unoOk;
    if (unoOk) c["last_rx_ms_ago"] = now - lastUnoRx;
    c["boot_reason"] = (unoBoot & 8) ? "watchdog" : (unoBoot & 4) ? "brown_out" : (unoBoot & 2) ? "reset" : "power_on";
    String s; serializeJson(d, s); if (mqtt.connected()) mqtt.publish(topic("heartbeat").c_str(), s.c_str());
    digitalWrite(PIN_STATUS_LED, mqtt.connected() ? HIGH : (now / 250) % 2);
  }
  bool gsmChanged = false; for (uint8_t i = 0; i < sim.count; i++) gsmChanged |= sim.attempts[i].changed;
  if (gsmChanged || now - lastGsm >= 10000) { lastGsm = now; reportGsm(); }
  delay(5);
}
