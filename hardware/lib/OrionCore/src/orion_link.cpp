#include "orion_link.h"

namespace orion {

uint8_t crc8(const char* d, size_t len) {
  uint8_t c = 0;
  for (size_t i = 0; i < len; i++) {
    c ^= (uint8_t)d[i];
    for (uint8_t b = 0; b < 8; b++) c = (c & 0x80) ? (uint8_t)((c << 1) ^ 0x07) : (uint8_t)(c << 1);
  }
  return c;
}

static size_t putLong(char* p, size_t cap, long v) {
  char tmp[12];
  size_t n = 0;
  bool neg = v < 0;
  unsigned long u = neg ? (unsigned long)(-(v + 1)) + 1 : (unsigned long)v;
  do { tmp[n++] = (char)('0' + u % 10); u /= 10; } while (u && n < sizeof(tmp));
  if (neg) tmp[n++] = '-';
  if (n > cap) return 0;
  for (size_t i = 0; i < n; i++) p[i] = tmp[n - 1 - i];
  return n;
}

size_t buildFrame(char* buf, size_t cap, char type, const long* fields, uint8_t n) {
  if (cap < 8) return 0;
  size_t i = 0;
  buf[i++] = '$';
  buf[i++] = type;
  for (uint8_t k = 0; k < n; k++) {
    if (i + 2 >= cap) return 0;
    buf[i++] = ',';
    size_t w = putLong(buf + i, cap - i - 5, fields[k]);
    if (!w) return 0;
    i += w;
  }
  if (i + 5 > cap || i + 4 > kLinkMax) return 0;
  uint8_t c = crc8(buf + 1, i - 1);
  const char* hx = "0123456789ABCDEF";
  buf[i++] = '*';
  buf[i++] = hx[c >> 4];
  buf[i++] = hx[c & 15];
  buf[i++] = '\n';
  if (i < cap) buf[i] = 0;
  return i;
}

bool LinkParser::feed(char c, Frame& frame) {
  if (c == '$') { in_ = true; len_ = 0; return false; }
  if (!in_) return false;
  if (c == '\r') return false;
  if (c == '\n') { in_ = false; return parse(frame); }
  if (len_ >= kLinkMax) { in_ = false; overflows++; return false; }
  buf_[len_++] = c;
  return false;
}

static int hexv(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'A' && c <= 'F' ? c - 'A' + 10 : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; }

bool LinkParser::parse(Frame& frame) {
  // buf_ holds: T,f1,...*CC
  size_t star = len_;
  for (size_t i = 0; i < len_; i++) if (buf_[i] == '*') { star = i; break; }
  if (star == len_ || star + 3 != len_ || star < 1) { malformed++; return false; }
  int h = hexv(buf_[star + 1]), l = hexv(buf_[star + 2]);
  if (h < 0 || l < 0 || crc8(buf_, star) != (uint8_t)(h * 16 + l)) { crcErrors++; return false; }
  frame.type = buf_[0];
  frame.n = 0;
  size_t i = 1;
  while (i < star) {
    if (buf_[i] != ',') { malformed++; return false; }
    i++;
    bool neg = false;
    if (i < star && buf_[i] == '-') { neg = true; i++; }
    if (i >= star || buf_[i] < '0' || buf_[i] > '9') { malformed++; return false; }
    long v = 0;
    while (i < star && buf_[i] >= '0' && buf_[i] <= '9') { v = v * 10 + (buf_[i] - '0'); i++; }
    if (frame.n >= kLinkMaxFields) { malformed++; return false; }
    frame.f[frame.n++] = neg ? -v : v;
  }
  return true;
}

}  // namespace orion
