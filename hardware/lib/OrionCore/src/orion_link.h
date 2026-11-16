// UNO <-> ESP32 serial link: ASCII frames "$<type>,<f1>,<f2>,...*<crc8 hex>\n".
// CRC-8 (poly 0x07) over the bytes between '$' and '*'. Frames longer than kLinkMax are dropped.
//
// UNO -> ESP32                                   ESP32 -> UNO
//  H,seq,uptime_s,boot_reason          heartbeat  H,seq,uptime_s           heartbeat
//  T,seq,<telemetry fields, see below>  readings   C,seq,cmd_idx,actuator,action,ttl_s   command
//  A,seq,fan,buzzer,door,red,green,white,warm,cooldown_s,fault   outputs (commanded)
//  E,seq,hazard,event_code             firmware event
//  G,seq,hazard                        request SMS + call
//  K,seq,cmd_idx,result                command result (orion::CmdResult)
// T fields: mq2_raw,mq2_q,mq2_level,warmup_s, flame_det,flame_q, water_raw,water_q,water_wet, temp_x10,hum_x10,dht_q
#pragma once
#include <stdint.h>
#include <stddef.h>

namespace orion {

constexpr size_t kLinkMax = 120;
constexpr uint8_t kLinkMaxFields = 16;

uint8_t crc8(const char* data, size_t len);

// Build a frame into buf. Returns length (0 if it would not fit).
size_t buildFrame(char* buf, size_t cap, char type, const long* fields, uint8_t n);

struct Frame {
  char type = 0;
  uint8_t n = 0;
  long f[kLinkMaxFields];
};

// Incremental parser: feed bytes; returns true when a complete, CRC-valid frame is in `frame`.
class LinkParser {
 public:
  bool feed(char c, Frame& frame);
  uint16_t crcErrors = 0, overflows = 0, malformed = 0;
 private:
  char buf_[kLinkMax + 1];
  size_t len_ = 0;
  bool in_ = false;
  bool parse(Frame& frame);
};

}  // namespace orion
