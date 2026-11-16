// SIM800C driver: non-blocking AT-command state machine (call poll() often).
// "Sent" means the modem accepted the SMS (+CMGS); ORION never reports "delivered" without a delivery report.
// The modem I/O is abstract so the driver is unit-tested on a PC against a scripted fake modem.
#pragma once
#include <stdint.h>
#include <stddef.h>

namespace orion {

struct ModemIO {
  virtual void write(const char* s) = 0;
  virtual int read() = 0;              // next byte or -1
  virtual uint32_t millis() = 0;
  virtual void powerPulse() = 0;       // toggle PWRKEY (recover a hung modem)
  virtual ~ModemIO() {}
};

enum class AttemptStatus : uint8_t { Queued, Sending, Sent, Failed, Timeout, Answered };
enum class AttemptType : uint8_t { Sms, Call };

struct Attempt {
  uint32_t id = 0;
  AttemptType type = AttemptType::Sms;
  AttemptStatus status = AttemptStatus::Queued;
  char number[20] = {0};
  char text[161] = {0};
  uint8_t tries = 0;
  uint8_t tag = 0;       // caller's label (ORION: the hazard that triggered it)
  uint32_t nextAt = 0;
  const char* note = "Queued";
  bool changed = true;   // set when status/note changed; the owner clears it after reporting
};

class Sim800 {
 public:
  explicit Sim800(ModemIO& io) : io_(io) {}
  void begin();
  void poll();
  bool sms(uint32_t id, const char* number, const char* text, uint8_t tag = 0);
  bool call(uint32_t id, const char* number, uint8_t tag = 0);
  // status
  bool ready = false;        // modem answered AT and was configured
  bool simReady = false;
  bool registered = false;   // home or roaming
  int csq = 99;              // 0..31, 99 = unknown
  uint8_t powerCycles = 0;
  static constexpr uint8_t MAX = 6;
  Attempt attempts[MAX];
  uint8_t count = 0;
  // timings (ms)
  uint32_t cmdTimeoutMs = 3000, smsTimeoutMs = 60000, ringMs = 30000, statusEveryMs = 15000, retryDelayMs = 30000;
  uint8_t maxTries = 3;
 private:
  enum class St : uint8_t { Off, Init, Idle, Status, SmsPrompt, SmsBody, CallDial, CallRing, Hangup };
  void send(const char* cmd, St next, uint32_t timeout);
  void line(const char* l);
  void timeout();
  Attempt* nextJob();
  void finish(Attempt* a, AttemptStatus s, const char* note);
  ModemIO& io_;
  St st_ = St::Off;
  uint8_t initStep_ = 0, statusStep_ = 0, initFails_ = 0;
  uint32_t deadline_ = 0, lastStatus_ = 0;
  Attempt* cur_ = nullptr;
  char lb_[64];
  size_t ll_ = 0;
  bool gotOk_ = false;
};

}  // namespace orion
