// ORION setup code: everything the ESP32 gateway needs to reach the server, created by the app on registration.
// Format: base64url( "ORION1|host|port|home|gateway|password|controller|gsm|mq2|flame|water|dht" )
// Wi-Fi name/password are typed on the gateway's setup page and are not part of the code.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace orion {

struct SetupConfig {
  char host[64] = {0};
  uint16_t port = 1883;
  char home[32] = {0};
  char gateway[64] = {0};
  char password[64] = {0};
  char controller[64] = {0};
  char gsm[64] = {0};
  char mq2[64] = {0}, flame[64] = {0}, water[64] = {0}, dht[64] = {0};
};

// Decodes base64 or base64url (padding optional). Returns decoded length, or -1 on bad input / too long.
int base64Decode(const char* in, uint8_t* out, size_t cap);
// Parses a setup code. Returns nullptr on success or a short reason on failure.
const char* parseSetupCode(const char* code, SetupConfig& cfg);

}  // namespace orion
