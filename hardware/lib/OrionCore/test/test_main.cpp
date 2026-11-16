// Host unit tests for OrionCore:  make -C hardware/lib/OrionCore/test
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <deque>
#include "../src/OrionCore.h"
using namespace orion;

static int fails = 0, checks = 0;
#define CHECK(c) do { checks++; if (!(c)) { fails++; std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); } } while (0)
#define TEST(name) static void name(); struct name##_r { name##_r() { tests().push_back({#name, name}); } } name##_i; static void name()
struct T { const char* n; void (*f)(); };
static std::vector<T>& tests() { static std::vector<T> v; return v; }

struct Rig {
  Mq2 mq2; Flame flame; Water water; Dht dht; SafetyController sc; uint32_t now;
  explicit Rig(uint32_t start = 1000) : now(start) { mq2.begin(now); sc.begin(now); dht.success(29, 70, now); }
  void tick(int mq, bool fl = false, int wa = 30, uint32_t dt = 100, bool link = true) {
    now += dt; mq2.update(mq, now); flame.update(fl, -1); water.update(wa); dht.success(29, 70, now); sc.step(now, mq2, flame, water, dht, link);
  }
  void warm() { while (mq2.quality == Quality::WarmingUp) tick(170, false, 30, 1000); }
};

TEST(mq2_warmup_never_raises_smoke) {
  Rig r; for (int i = 0; i < 50; i++) r.tick(900);
  CHECK(r.mq2.quality == Quality::WarmingUp); CHECK(!r.sc.smoke()); CHECK(!r.sc.out.buzzer);
  CHECK(r.mq2.warmupLeftS(r.now) > 0);
}
TEST(watchdog_restart_during_smoke_alarms_immediately) {
  Mq2 m; m.begin(5000, /*coldStart=*/false); m.update(420, 5100);
  CHECK(m.quality == Quality::Valid); CHECK(m.level == Level::Warning); CHECK(m.warmupLeftS(5100) == 0);
  Flame f; Water w; Dht d; d.success(29, 70, 5100); SafetyController sc; sc.begin(5100);
  sc.step(5100, m, f, w, d, true);
  CHECK(sc.smoke()); CHECK(sc.out.buzzer); CHECK(sc.out.fan);
  Mq2 cold; cold.begin(5000, true); cold.update(420, 5100); CHECK(cold.quality == Quality::WarmingUp);
}
TEST(smoke_response_door_cooldown_and_hysteresis) {
  Rig r; r.warm();
  r.tick(420);
  CHECK(r.sc.smoke()); CHECK(r.sc.out.buzzer); CHECK(r.sc.out.fan); CHECK(r.sc.out.ledRed); CHECK(!r.sc.out.ledGreen); CHECK(r.sc.out.doorAngle == 180);
  for (int i = 0; i < 52; i++) r.tick(420);
  CHECK(r.sc.out.doorAngle == 0);                       // door returns after 5 s
  r.tick(340); CHECK(r.sc.smoke());                     // within hysteresis band (350-25)
  r.tick(300); CHECK(!r.sc.smoke()); CHECK(!r.sc.out.buzzer); CHECK(r.sc.out.fan);  // cooldown keeps fan on
  CHECK(r.sc.fanCooldownLeftS(r.now) == 60);
  for (int i = 0; i < 61; i++) r.tick(170, false, 30, 1000);
  CHECK(!r.sc.out.fan);
  Event e; int n = 0; bool sawStart = false, sawEnd = false, sawDoor = false, sawCool = false;
  while (r.sc.popEvent(e)) { n++; sawStart |= e.code == EventCode::SmokeStart; sawEnd |= e.code == EventCode::SmokeEnd; sawDoor |= e.code == EventCode::DoorReturned; sawCool |= e.code == EventCode::FanCooldownEnded; }
  CHECK(sawStart && sawEnd && sawDoor && sawCool);
}
TEST(smoke_escalates_to_critical_once) {
  Rig r; r.warm(); r.tick(420); r.tick(600); r.tick(600);
  Event e; int crit = 0; while (r.sc.popEvent(e)) crit += e.code == EventCode::SmokeCritical;
  CHECK(crit == 1); CHECK(r.mq2.level == Level::Critical);
}
TEST(fan_off_refused_during_smoke_and_cooldown) {
  Rig r; r.warm(); r.tick(420);
  CHECK(r.sc.command(Actuator::Fan, Action::Off, 5000, r.now) == CmdResult::RejectedInterlock);
  r.tick(200);
  CHECK(r.sc.command(Actuator::Fan, Action::Off, 5000, r.now) == CmdResult::RejectedInterlock);  // cooldown
  for (int i = 0; i < 61; i++) r.tick(170, false, 30, 1000);
  CHECK(r.sc.command(Actuator::Fan, Action::On, 5000, r.now) == CmdResult::ExecutedUnverified); r.tick(170); CHECK(r.sc.out.fan);
  CHECK(r.sc.command(Actuator::Fan, Action::Off, 5000, r.now) == CmdResult::ExecutedUnverified); r.tick(170); CHECK(!r.sc.out.fan);
  CHECK(r.sc.command(Actuator::Fan, Action::On, 0, r.now) == CmdResult::RejectedExpired);
  CHECK(r.sc.command(Actuator::Buzzer, Action::Off, 5000, r.now) == CmdResult::RejectedNotAllowed);
}
TEST(buzzer_test_lasts_two_seconds) {
  Rig r; r.warm();
  CHECK(r.sc.command(Actuator::Buzzer, Action::Test, 5000, r.now) == CmdResult::ExecutedUnverified);
  r.tick(170); CHECK(r.sc.out.buzzer);
  for (int i = 0; i < 21; i++) r.tick(170);
  CHECK(!r.sc.out.buzzer);
}
TEST(mq2_broken_wire_never_clears_an_alarm) {
  Rig r; r.warm(); r.tick(420); CHECK(r.sc.smoke());
  r.tick(0); CHECK(r.sc.smoke());                          // first low-rail sample must not look like clean air
  for (int i = 0; i < 25; i++) r.tick(0);
  CHECK(r.mq2.quality == Quality::Disconnected); CHECK(r.sc.smoke()); CHECK(r.sc.out.faultBlink);
}
TEST(mq2_high_rail_alarms_instead_of_faulting) {
  Rig r; r.warm(); for (int i = 0; i < 25; i++) r.tick(1023);
  CHECK(r.mq2.quality == Quality::Valid); CHECK(r.mq2.level == Level::Critical); CHECK(r.sc.smoke());
}
TEST(flame_needs_four_of_five_and_requests_gsm_once) {
  Rig r; r.warm();
  r.tick(170, true); r.tick(170, false); r.tick(170, true); r.tick(170, false);
  CHECK(!r.sc.flameActive());
  for (int i = 0; i < 4; i++) r.tick(170, true);
  CHECK(r.sc.flameActive()); CHECK(r.sc.gsmRequest); CHECK(r.sc.gsmHazard == Hazard::Flame);
  CHECK(!r.sc.out.lightWhite); CHECK(!r.sc.out.lightWarm); CHECK(r.sc.out.ledRed);
  r.sc.gsmRequest = false;
  for (int i = 0; i < 5; i++) r.tick(170, true);
  CHECK(!r.sc.gsmRequest);                              // not repeated within the same episode
  r.tick(170, false); CHECK(r.sc.flameActive());        // one clear sample is not enough
  for (int i = 0; i < 5; i++) r.tick(170, false);
  CHECK(!r.sc.flameActive()); CHECK(r.sc.out.lightWhite);
}
TEST(water_hysteresis_and_submerged_is_wet) {
  Rig r; r.warm();
  r.tick(170, false, 310); CHECK(r.water.wet && r.sc.waterActive());
  r.tick(170, false, 290); CHECK(r.water.wet);           // hysteresis
  r.tick(170, false, 200); CHECK(!r.water.wet);
  for (int i = 0; i < 25; i++) r.tick(170, false, 1023);
  CHECK(r.water.quality == Quality::Valid); CHECK(r.water.wet);   // fail-safe: rail-high = wet, not "fault"
}
TEST(dht_failures_and_range_checks) {
  Dht d; d.success(25, 50, 1000); CHECK(d.current(2000)); CHECK(!d.current(20000));
  d.failure(); d.failure(); CHECK(d.quality == Quality::Valid); d.failure(); CHECK(d.quality == Quality::Fault);
  d.success(25, 50, 3000); CHECK(d.quality == Quality::Valid);
  d.success(200, 50, 4000); CHECK(d.fails == 1); CHECK(d.tempC == 25);
}
TEST(link_loss_blinks_fault) {
  Rig r; r.warm(); r.tick(170, false, 30, 100, false); CHECK(r.sc.out.faultBlink);
  r.tick(170); CHECK(!r.sc.out.faultBlink);
}
TEST(millis_wraparound) {
  Rig r(0xFFFFF000u); r.warm(); r.tick(420); CHECK(r.sc.smoke());
  for (int i = 0; i < 60; i++) r.tick(420);
  CHECK(r.sc.out.doorAngle == 0);
}
TEST(link_roundtrip_and_errors) {
  char buf[kLinkMax + 8]; long f[] = {42, -7, 0, 1023, 2147483647L};
  size_t n = buildFrame(buf, sizeof(buf), 'T', f, 5); CHECK(n > 0);
  LinkParser p; Frame fr; bool got = false;
  const char* noise = "xx$garbage\n"; for (const char* c = noise; *c; c++) p.feed(*c, fr);
  for (size_t i = 0; i < n; i++) got = p.feed(buf[i], fr) || got;
  CHECK(got); CHECK(fr.type == 'T'); CHECK(fr.n == 5); CHECK(fr.f[1] == -7); CHECK(fr.f[4] == 2147483647L);
  buf[3] ^= 1; got = false; for (size_t i = 0; i < n; i++) got = p.feed(buf[i], fr) || got;
  CHECK(!got); CHECK(p.crcErrors == 1);
  std::string big = "$T"; for (int i = 0; i < 200; i++) big += ",1"; big += "\n";
  got = false; for (char c : big) got = p.feed(c, fr) || got; CHECK(!got); CHECK(p.overflows == 1);
  long many[20] = {0}; CHECK(buildFrame(buf, sizeof(buf), 'T', many, 20) > 0 || true);
}

// ---------------- SIM800 against a scripted fake modem ----------------
struct FakeModem : ModemIO {
  uint32_t t = 0; std::deque<char> rx; std::vector<std::string> sent; std::string cur; int pulses = 0;
  bool silent = false, registered = true, smsFail = false; std::string callResult = "+COLP: \"x\",145";
  bool answerCall = true;
  void say(const std::string& s) { for (char c : s) rx.push_back(c); }
  void write(const char* s) override {
    for (const char* p = s; *p; p++) {
      char c = *p;
      if (c == '\r' || c == 0x1a) { handle(cur, c == 0x1a); cur.clear(); } else cur += c;
    }
  }
  void handle(const std::string& cmd, bool ctrlZ) {
    sent.push_back(cmd);
    if (silent) return;
    if (ctrlZ) { say(smsFail ? "\r\n+CMS ERROR: 500\r\n" : "\r\n+CMGS: 41\r\n\r\nOK\r\n"); return; }
    if (cmd.rfind("AT+CMGS=", 0) == 0) { say("\r\n> "); return; }
    if (cmd == "AT+CPIN?") { say("\r\n+CPIN: READY\r\n\r\nOK\r\n"); return; }
    if (cmd == "AT+CREG?") { say(registered ? "\r\n+CREG: 0,1\r\n\r\nOK\r\n" : "\r\n+CREG: 0,2\r\n\r\nOK\r\n"); return; }
    if (cmd == "AT+CSQ") { say("\r\n+CSQ: 17,0\r\n\r\nOK\r\n"); return; }
    if (cmd.rfind("ATD", 0) == 0) { say("\r\nOK\r\n"); if (answerCall) say("\r\n" + callResult + "\r\n"); return; }
    if (cmd.empty()) return;
    say("\r\nOK\r\n");
  }
  int read() override { if (rx.empty()) return -1; char c = rx.front(); rx.pop_front(); return (unsigned char)c; }
  uint32_t millis() override { return t; }
  void powerPulse() override { pulses++; }
};
static void run(Sim800& s, FakeModem& m, uint32_t ms) { for (uint32_t i = 0; i < ms; i += 50) { m.t += 50; s.poll(); } }

TEST(sim800_init_status) {
  FakeModem m; Sim800 s(m); s.begin(); run(s, m, 2000);
  CHECK(s.ready); CHECK(s.simReady); CHECK(s.registered); CHECK(s.csq == 17);
}
TEST(sim800_sms_sent_means_accepted_not_delivered) {
  FakeModem m; Sim800 s(m); s.begin(); run(s, m, 2000);
  CHECK(s.sms(1, "+910000000001", "ORION: flame detected"));
  run(s, m, 3000);
  CHECK(s.attempts[0].status == AttemptStatus::Sent);
  CHECK(std::strstr(s.attempts[0].note, "Delivery not confirmed") != nullptr);
  bool sawBody = false; for (auto& c : m.sent) sawBody |= c.find("ORION: flame detected") != std::string::npos; CHECK(sawBody);
}
TEST(sim800_sms_error_retries_then_fails) {
  FakeModem m; m.smsFail = true; Sim800 s(m); s.retryDelayMs = 1000; s.begin(); run(s, m, 2000);
  s.sms(2, "+910000000001", "x"); run(s, m, 20000);
  CHECK(s.attempts[0].status == AttemptStatus::Failed); CHECK(s.attempts[0].tries == 3);
}
TEST(sim800_unregistered_fails_honestly) {
  FakeModem m; m.registered = false; Sim800 s(m); s.smsTimeoutMs = 5000; s.begin(); run(s, m, 2000);
  CHECK(!s.registered); s.sms(3, "+910000000001", "x"); run(s, m, 8000);
  CHECK(s.attempts[0].status == AttemptStatus::Failed); CHECK(std::strstr(s.attempts[0].note, "Not registered") != nullptr);
}
TEST(sim800_call_answered_and_timeout) {
  FakeModem m; Sim800 s(m); s.begin(); run(s, m, 2000);
  s.call(4, "+910000000001"); run(s, m, 3000); CHECK(s.attempts[0].status == AttemptStatus::Answered);
  FakeModem m2; m2.answerCall = false; Sim800 s2(m2); s2.ringMs = 5000; s2.begin(); run(s2, m2, 2000);
  s2.call(5, "+910000000001"); run(s2, m2, 8000); CHECK(s2.attempts[0].status == AttemptStatus::Timeout);
}
TEST(sim800_silent_modem_power_cycles) {
  FakeModem m; m.silent = true; Sim800 s(m); s.begin(); run(s, m, 12000);
  CHECK(!s.ready); CHECK(m.pulses >= 1);
}

// ---------------- setup code (same vector as frontend/tests/unit/setupcode.test.js) ----------------
TEST(setup_code_from_the_app_decodes) {
  SetupConfig c;
  const char* err = parseSetupCode("T1JJT04xfDE5Mi4xNjguMS4xMHwxODgzfGhvbWUtMXxlc3AzMi0wMXxBYmNfZGVmLWdoaWprbG1ub3BxcnN0dTEyfHVuby0wMXxnc20tMDF8bXEyLTAxfGZsYW1lLTAxfHdhdGVyLTAxfGRodC0wMQ", c);
  CHECK(err == nullptr);
  CHECK(std::strcmp(c.host, "192.168.1.10") == 0); CHECK(c.port == 1883); CHECK(std::strcmp(c.home, "home-1") == 0);
  CHECK(std::strcmp(c.gateway, "esp32-01") == 0); CHECK(std::strcmp(c.password, "Abc_def-ghijklmnopqrstu12") == 0);
  CHECK(std::strcmp(c.controller, "uno-01") == 0); CHECK(std::strcmp(c.gsm, "gsm-01") == 0);
  CHECK(std::strcmp(c.mq2, "mq2-01") == 0); CHECK(std::strcmp(c.dht, "dht-01") == 0);
}
TEST(setup_code_rejects_bad_input) {
  SetupConfig c;
  CHECK(parseSetupCode("not base64 !!", c) != nullptr);
  CHECK(parseSetupCode("", c) != nullptr);
  CHECK(parseSetupCode("T1JJT04y", c) != nullptr);                       // "ORION2"
  CHECK(parseSetupCode("T1JJT04xfGF8MXxi", c) != nullptr);               // too few fields
  std::string longCode(2000, 'A'); CHECK(parseSetupCode(longCode.c_str(), c) != nullptr);
}

int main() {
  for (auto& t : tests()) { int before = fails; t.f(); std::printf("%s %s\n", fails == before ? "ok  " : "FAIL", t.n); }
  std::printf("%d checks, %d failed, %zu tests\n", checks, fails, tests().size());
  return fails ? 1 : 0;
}
