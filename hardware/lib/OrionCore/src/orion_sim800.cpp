#include "orion_sim800.h"
#include <string.h>
#include <stdio.h>

namespace orion {

static const char* INIT[] = {"AT", "ATE0", "AT+CMEE=2", "AT+CMGF=1", "AT+COLP=1", "AT+CPIN?"};
static const uint8_t INIT_N = 6;
static const char* STATUS[] = {"AT+CREG?", "AT+CSQ"};

void Sim800::begin() { st_ = St::Init; initStep_ = 0; send(INIT[0], St::Init, cmdTimeoutMs); }

void Sim800::send(const char* cmd, St next, uint32_t to) {
  io_.write(cmd); io_.write("\r");
  st_ = next; gotOk_ = false; deadline_ = io_.millis() + to;
}

bool Sim800::sms(uint32_t id, const char* number, const char* text, uint8_t tag) {
  if (count >= MAX) {  // drop the oldest finished attempt
    uint8_t k = 0;
    for (; k < count; k++) if (attempts[k].status != AttemptStatus::Queued && attempts[k].status != AttemptStatus::Sending) break;
    if (k == count) return false;
    for (uint8_t j = k; j + 1 < count; j++) attempts[j] = attempts[j + 1];
    count--;
  }
  Attempt& a = attempts[count++];
  a = Attempt();
  a.id = id; a.type = AttemptType::Sms; a.tag = tag;
  strncpy(a.number, number, sizeof(a.number) - 1);
  strncpy(a.text, text, sizeof(a.text) - 1);
  a.nextAt = io_.millis();
  return true;
}

bool Sim800::call(uint32_t id, const char* number, uint8_t tag) {
  if (!sms(id, number, "", tag)) return false;
  attempts[count - 1].type = AttemptType::Call;
  return true;
}

void Sim800::finish(Attempt* a, AttemptStatus s, const char* note) {
  if (!a) return;
  bool retryable = (s == AttemptStatus::Failed) && a->tries < maxTries;
  if (retryable) { a->status = AttemptStatus::Queued; a->note = note; a->nextAt = io_.millis() + retryDelayMs; }
  else { a->status = s; a->note = note; }
  a->changed = true;
  if (cur_ == a) cur_ = nullptr;
}

Attempt* Sim800::nextJob() {
  uint32_t now = io_.millis();
  for (uint8_t i = 0; i < count; i++) {
    Attempt& a = attempts[i];
    if (a.status == AttemptStatus::Queued && (int32_t)(now - a.nextAt) >= 0) return &a;
  }
  return nullptr;
}

void Sim800::poll() {
  int c;
  while ((c = io_.read()) >= 0) {
    if (c == '>' && st_ == St::SmsPrompt) { line(">"); continue; }
    if (c == '\r') continue;
    if (c == '\n') { lb_[ll_] = 0; if (ll_) line(lb_); ll_ = 0; continue; }
    if (ll_ < sizeof(lb_) - 1) lb_[ll_++] = (char)c;
  }
  uint32_t now = io_.millis();
  if (st_ != St::Idle && st_ != St::Off && (int32_t)(now - deadline_) >= 0) timeout();
  if (st_ == St::Idle) {
    Attempt* a;
    if (ready && registered && (a = nextJob()) != nullptr) {
      cur_ = a; a->tries++; a->status = AttemptStatus::Sending; a->changed = true;
      char cmd[40];
      if (a->type == AttemptType::Sms) { snprintf(cmd, sizeof(cmd), "AT+CMGS=\"%s\"", a->number); a->note = "AT+CMGS issued"; send(cmd, St::SmsPrompt, cmdTimeoutMs * 2); }
      else { snprintf(cmd, sizeof(cmd), "ATD%s;", a->number); a->note = "Dialling"; send(cmd, St::CallDial, cmdTimeoutMs * 3); }
    } else if (ready && !registered) {
      // Can't send while unregistered: fail queued work honestly instead of pretending.
      for (uint8_t i = 0; i < count; i++) if (attempts[i].status == AttemptStatus::Queued && attempts[i].tries == 0 && (int32_t)(now - attempts[i].nextAt) >= (int32_t)smsTimeoutMs) {
        attempts[i].status = AttemptStatus::Failed; attempts[i].note = "Not registered on the network"; attempts[i].changed = true;
      }
    }
    if (st_ == St::Idle && (int32_t)(now - lastStatus_) >= (int32_t)statusEveryMs) { lastStatus_ = now; statusStep_ = 0; send(STATUS[0], St::Status, cmdTimeoutMs); }
  }
}

void Sim800::timeout() {
  switch (st_) {
    case St::Init:
      if (++initFails_ >= 3) { io_.powerPulse(); powerCycles++; initFails_ = 0; ready = false; }
      begin(); break;
    case St::Status: ready = false; begin(); break;  // modem stopped answering
    case St::SmsPrompt: case St::SmsBody: finish(cur_, AttemptStatus::Failed, "No response from modem"); io_.write("\x1b"); st_ = St::Idle; break;
    case St::CallDial: finish(cur_, AttemptStatus::Failed, "Dial not accepted"); send("ATH", St::Hangup, cmdTimeoutMs); break;
    case St::CallRing: finish(cur_, AttemptStatus::Timeout, "No answer within the ring time"); send("ATH", St::Hangup, cmdTimeoutMs); break;
    case St::Hangup: st_ = St::Idle; break;
    default: st_ = St::Idle;
  }
}

void Sim800::line(const char* l) {
  bool ok = strcmp(l, "OK") == 0;
  bool err = strncmp(l, "ERROR", 5) == 0 || strncmp(l, "+CMS ERROR", 10) == 0 || strncmp(l, "+CME ERROR", 10) == 0;
  if (strncmp(l, "+CPIN:", 6) == 0) simReady = strstr(l, "READY") != nullptr;
  if (strncmp(l, "+CREG:", 6) == 0) { const char* p = strchr(l, ','); int s = p ? p[1] - '0' : 0; registered = (s == 1 || s == 5); }
  if (strncmp(l, "+CSQ:", 5) == 0) { int v = 99; sscanf(l + 5, "%d", &v); csq = v; }
  switch (st_) {
    case St::Init:
      if (ok) {
        if (++initStep_ < INIT_N) send(INIT[initStep_], St::Init, cmdTimeoutMs);
        else { ready = true; initFails_ = 0; lastStatus_ = io_.millis() - statusEveryMs; st_ = St::Idle; }
      } else if (err) {
        if (initStep_ == INIT_N - 1) { simReady = false; ready = true; st_ = St::Idle; }  // +CPIN error: no SIM
      }
      break;
    case St::Status:
      if (ok) { if (++statusStep_ < 2) send(STATUS[statusStep_], St::Status, cmdTimeoutMs); else st_ = St::Idle; }
      else if (err) st_ = St::Idle;
      break;
    case St::SmsPrompt:
      if (l[0] == '>') { io_.write(cur_->text); io_.write("\x1a"); st_ = St::SmsBody; deadline_ = io_.millis() + smsTimeoutMs; }
      else if (err) { finish(cur_, AttemptStatus::Failed, "Modem refused the SMS command"); st_ = St::Idle; }
      break;
    case St::SmsBody:
      if (strncmp(l, "+CMGS:", 6) == 0) gotOk_ = true;
      else if (ok && gotOk_) { finish(cur_, AttemptStatus::Sent, "Modem accepted (+CMGS). Delivery not confirmed."); st_ = St::Idle; }
      else if (err) { finish(cur_, AttemptStatus::Failed, "Modem reported an SMS error"); st_ = St::Idle; }
      break;
    case St::CallDial:
      if (ok) { st_ = St::CallRing; deadline_ = io_.millis() + ringMs; cur_->note = "Ringing"; cur_->changed = true; }
      else if (err || strcmp(l, "NO CARRIER") == 0 || strcmp(l, "BUSY") == 0 || strcmp(l, "NO DIALTONE") == 0) { finish(cur_, AttemptStatus::Failed, "Call could not be placed"); st_ = St::Idle; }
      break;
    case St::CallRing:
      if (strncmp(l, "+COLP:", 6) == 0) { finish(cur_, AttemptStatus::Answered, "Answered"); send("ATH", St::Hangup, cmdTimeoutMs); }
      else if (strcmp(l, "BUSY") == 0) { finish(cur_, AttemptStatus::Failed, "Busy"); st_ = St::Idle; }
      else if (strcmp(l, "NO ANSWER") == 0 || strcmp(l, "NO CARRIER") == 0) { finish(cur_, AttemptStatus::Timeout, "No answer"); st_ = St::Idle; }
      break;
    case St::Hangup:
      if (ok || err) st_ = St::Idle;
      break;
    default: break;
  }
}

}  // namespace orion
