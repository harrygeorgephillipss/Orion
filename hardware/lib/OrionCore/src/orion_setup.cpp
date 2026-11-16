#include "orion_setup.h"
#include <string.h>
#include <stdlib.h>

namespace orion {

static int b64v(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+' || c == '-') return 62;
  if (c == '/' || c == '_') return 63;
  return -1;
}

int base64Decode(const char* in, uint8_t* out, size_t cap) {
  uint32_t acc = 0; int bits = 0; size_t n = 0;
  for (const char* p = in; *p; p++) {
    char c = *p;
    if (c == '=' || c == ' ' || c == '\n' || c == '\r' || c == '\t') continue;
    int v = b64v(c);
    if (v < 0) return -1;
    acc = (acc << 6) | (uint32_t)v; bits += 6;
    if (bits >= 8) { bits -= 8; if (n >= cap) return -1; out[n++] = (uint8_t)((acc >> bits) & 0xFF); }
  }
  return (int)n;
}

static bool idOk(const char* s) {  // matches the server's id rule: lowercase letters, digits, '.', '_' or '-'
  size_t n = strlen(s);
  if (n < 2 || n > 63) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return false;
  }
  return true;
}

const char* parseSetupCode(const char* code, SetupConfig& cfg) {
  uint8_t buf[512];
  int n = base64Decode(code, buf, sizeof(buf) - 1);
  if (n <= 0) return "not a valid setup code";
  buf[n] = 0;
  char* fields[12]; int k = 0;
  char* p = (char*)buf;
  fields[k++] = p;
  for (; *p && k < 12; p++) if (*p == '|') { *p = 0; fields[k++] = p + 1; }
  if (k != 12 || strchr(fields[11], '|')) return "wrong number of fields";
  if (strcmp(fields[0], "ORION1") != 0) return "unknown setup code version";
  const struct { char* dst; size_t cap; int idx; } map[] = {
    {cfg.host, sizeof(cfg.host), 1}, {cfg.home, sizeof(cfg.home), 3}, {cfg.gateway, sizeof(cfg.gateway), 4},
    {cfg.password, sizeof(cfg.password), 5}, {cfg.controller, sizeof(cfg.controller), 6}, {cfg.gsm, sizeof(cfg.gsm), 7},
    {cfg.mq2, sizeof(cfg.mq2), 8}, {cfg.flame, sizeof(cfg.flame), 9}, {cfg.water, sizeof(cfg.water), 10}, {cfg.dht, sizeof(cfg.dht), 11},
  };
  for (auto& m : map) {
    if (strlen(fields[m.idx]) >= m.cap) return "a field is too long";
    strcpy(m.dst, fields[m.idx]);
  }
  long port = strtol(fields[2], nullptr, 10);
  if (port < 1 || port > 65535) return "bad port";
  cfg.port = (uint16_t)port;
  if (!cfg.host[0] || strchr(cfg.host, ' ') || strchr(cfg.host, '/')) return "bad server address";
  if (strlen(cfg.password) < 16) return "bad password";
  if (!idOk(cfg.gateway) || !idOk(cfg.controller) || !idOk(cfg.mq2) || !idOk(cfg.flame) || !idOk(cfg.water) || !idOk(cfg.dht)) return "bad device id";
  if (cfg.gsm[0] && !idOk(cfg.gsm)) return "bad GSM module id";
  if (!cfg.home[0]) return "bad home id";
  return nullptr;
}

}  // namespace orion
