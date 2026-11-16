// Copy to secrets.h and fill in. secrets.h is git-ignored: never commit Wi-Fi passwords, broker passwords or phone numbers.
#pragma once
#define WIFI_SSID "your-wifi"
#define WIFI_PASSWORD "your-wifi-password"
#define MQTT_HOST "192.168.1.10"         // the ORION server on your LAN
#define MQTT_PORT 1883                   // 8883 with MQTT_TLS 1
#define MQTT_TLS 0
#define MQTT_CA_CERT ""                  // PEM of your CA when MQTT_TLS is 1
#define HOME_ID "home-1"
#define GATEWAY_ID "esp32-01"            // = MQTT username, as registered with POST /api/v1/devices/gateways
#define MQTT_PASSWORD "from-registration"
#define CONTROLLER_ID "uno-01"
#define GSM_MODULE_ID "gsm-01"
#define SENSOR_MQ2 "mq2-01"
#define SENSOR_FLAME "flame-01"
#define SENSOR_WATER "water-01"
#define SENSOR_DHT "dht-01"
// Emergency numbers for local SMS/call alerts (work without internet). International format.
#define EMERGENCY_NUMBERS {"+910000000000"}
