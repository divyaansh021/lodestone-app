# Lodestone

A handheld GPS navigation and device-tracking system built on the ESP32. The Lodestone device pairs wirelessly with other Lodestone units and with a companion Progressive Web App (PWA) — all communication runs over MQTT via a cloud broker, so no Bluetooth or local network pairing is needed.

---

## Features

**On the device**
- Direction Finder — point-and-navigate to any saved waypoint with an animated arrow
- Digital Compass — tilt-compensated heading with smoothing
- Speedometer — live GPS speed, max speed, and trip distance
- Device Tracker — track the real-time position of any paired Lodestone
- Pair Lodestone — send and accept pairing requests from nearby hardware devices
- Messaging — send and receive text messages with paired devices and app users
- WiFi Setup — scan and connect to networks including WPA2 Enterprise
- Save Locations — store up to 10 named waypoints in EEPROM
- Boot animation, sleep timeout, display brightness, configurable device name
- All settings and data persist across reboots via EEPROM

**Companion PWA**
- Installable on Android and iOS (add to home screen)
- Live map showing paired device positions (Leaflet / OpenStreetMap)
- Saved locations viewer and manager
- Messaging inbox and composer
- Pair / unpair devices from the browser
- Works fully offline after first load (service worker cached)

---

## Hardware

| Component | Part |
|---|---|
| Microcontroller | ESP32 (30-pin DevKit) |
| Display | SH1106G 1.3″ 128×64 OLED (I2C) |
| IMU | LSM303 (accelerometer + magnetometer, I2C) |
| GPS | Any UART NMEA module (tested at 9600 baud) |
| Input | 5-way rocker / joystick (UP, DOWN, LEFT, RIGHT, PRESS) |
| Power | LiPo battery + USB charging module |

### Pin Connections

| Signal | ESP32 GPIO |
|---|---|
| I2C SDA (OLED + LSM303) | GPIO 21 |
| I2C SCL (OLED + LSM303) | GPIO 22 |
| GPS UART RX | GPIO 16 |
| GPS UART TX | GPIO 17 |
| Button UP | GPIO 32 |
| Button DOWN | GPIO 33 |
| Button LEFT | GPIO 25 |
| Button RIGHT | GPIO 26 |
| Button PRESS (select) | GPIO 27 |

OLED I2C address: `0x3C`. LSM303 accelerometer: `0x19`, magnetometer: `0x1E`.

---

## Software Dependencies

Install these libraries via the Arduino Library Manager before compiling:

| Library | Purpose |
|---|---|
| `Adafruit GFX Library` | Graphics primitives |
| `Adafruit SH110X` | SH1106G OLED driver |
| `TinyGPS++` | NMEA GPS parsing |
| `PubSubClient` | MQTT client |
| `ArduinoJson` | JSON serialisation |
| `EEPROM` | Built-in (ESP32 Arduino core) |
| `Wire` | Built-in I2C |
| `esp_eap_client` | WPA2 Enterprise WiFi (built-in ESP-IDF) |

**Board:** ESP32 Dev Module. Install the ESP32 Arduino core via the Boards Manager (`https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`).

---

## MQTT Broker Setup

Lodestone uses **HiveMQ Cloud** (free tier) as the broker. All traffic is TLS-encrypted on port 8883.

1. Create a free account at [hivemq.com/mqtt-cloud-broker](https://www.hivemq.com/mqtt-cloud-broker/)
2. Create a cluster and note the hostname
3. Create a credential (username + password)
4. Update these defines at the top of the firmware:

```cpp
#define MQTT_HOST   "your-cluster-id.s1.eu.hivemq.cloud"
#define MQTT_PORT   8883
#define MQTT_USER   "your-username"
#define MQTT_PASS   "your-password"
```

5. Update the same credentials in `js/app.js` in the PWA (`mqttHost`, `mqttUser`, `mqttPass`).

> **Security note:** The broker credentials are hardcoded in the firmware and app source. Do not commit real credentials to a public repository — use a `.env` file or build-time substitution for the PWA, and consider using `#include "secrets.h"` (gitignored) for the firmware.

---

## Flashing the Firmware

1. Clone this repository
2. Open `Lodestone_Final_vXX_app.ino` in the Arduino IDE (2.x recommended)
3. Install all libraries listed above
4. Select board: **ESP32 Dev Module**
5. Set upload speed to **921600**
6. Select the correct COM port
7. Click Upload

On first boot the device will show the boot animation, then prompt you to set up WiFi from the Settings menu.

---

## Deploying the PWA

The `LodestoneApp/` folder is a self-contained PWA. Host it on any static web server — GitHub Pages, Netlify, Vercel, or your own server. HTTPS is required for the service worker and for PWA install prompts to work.

**GitHub Pages (quickest):**
1. Push the `LodestoneApp/` folder contents to a `gh-pages` branch (or configure Pages to serve from `/docs`)
2. Visit `https://<your-username>.github.io/<repo-name>/`
3. On mobile: tap the browser menu → "Add to Home Screen"

**Local testing:**
```bash
cd LodestoneApp
npx serve .
# or
python3 -m http.server 8080
```

---

## How It Works

All communication goes through the MQTT broker. Neither the device nor the app talk directly to each other.

```
Lodestone A ──┐
Lodestone B ──┼──► HiveMQ Cloud (MQTT) ◄── PWA App
Lodestone C ──┘
```

### Topic Overview

| Topic | Direction | Purpose |
|---|---|---|
| `lodestone/announce` | Everyone → Everyone | Presence beacon (name, MAC, type) |
| `lodestone/locations` | Device → App | Share saved waypoints on connect |
| `lodestone/request/<mac>` | Any → Device | Initiate pairing handshake |
| `lodestone/accept/<mac>` | Device → Requester | Accept pair request |
| `lodestone/pair/<receiver>_<sender>` | Device → Paired device | Live GPS position for tracking |
| `lodestone/devices/<mac>` | Device → App | Live GPS position for map |
| `lodestone/msg/<mac>` | Any → Device/App | Targeted message delivery |
| `lodestone/unpair/<mac>` | Any → Target | Tear down pairing on both sides |
| `lodestone/loc/request/<mac>` | App → Device | Request saved locations |
| `lodestone/loc/response/<mac>` | Device → App | Deliver saved locations |

### Pairing Handshake

```
Device A                         Device B
   │                                │
   │── request/<B_mac> ────────────►│  Shows "PAIR?" dialog
   │                                │  User presses PRESS
   │◄── accept/<A_mac> ─────────────│  Saves A to EEPROM
   │  Saves B to EEPROM             │
   │  Both subscribe to pair topics │
```

Pairing is stored in EEPROM and survives reboots. Once paired, devices automatically resubscribe to each other's pair topics on reconnect.

### Position Updates

Each Lodestone publishes its GPS position every 5 seconds (when a fix is valid) to two topics simultaneously — `lodestone/devices/<mac>` for the app's map, and `lodestone/pair/<peerMac>_<myMac>` for each paired hardware device's tracking screen. Unpaired devices never receive position data.

### Messaging

Every device subscribes to `lodestone/msg/<myMac>` on connect. "Send to all" iterates the paired MAC list and delivers to each peer individually — there is no global broadcast topic. Messages from senders not in the paired list are silently dropped on receipt.

---

## Navigation

### Main Menu

```
DIRECTION FINDER  →  Navigate to a saved waypoint
COMPASS           →  Digital compass with heading
SPEEDOMETER       →  Speed, max speed, trip distance
DEVICE TRACKER    →  Track / pair / message other Lodestones
SETTINGS          →  WiFi, name, display, sleep timeout
```

### Buttons

| Button | Short press |
|---|---|
| UP / DOWN | Scroll menu |
| LEFT | Back |
| RIGHT | Context action (e.g. unpair in tracker list) |
| PRESS | Select / confirm |

### Device Tracker Sub-menu

```
TRACK LODESTONE   →  Navigate toward a paired Lodestone
PAIR LODESTONE    →  Send pair request to nearby unpaired devices
CONNECT APP       →  Pair with the PWA companion app
MESSAGES (N)      →  Inbox and composer
```

---

## EEPROM Layout

| Address | Size | Contents |
|---|---|---|
| 0 | 340 bytes | Saved locations (10 × 34 bytes) |
| 340 | 760 bytes | Saved WiFi networks (5 × 152 bytes) |
| 1100 | 100 bytes | Settings (device name, sleep timeout, etc.) |
| 1200 | 200 bytes | Paired MACs (10 × 20 bytes) |

Total EEPROM used: 1400 bytes of a 2048-byte allocation.

---

## Calibration

The LSM303 magnetometer requires hard-iron calibration for accurate compass readings. From the Settings menu select **Calibrate Compass**, then slowly rotate the device through all orientations for ~30 seconds. The min/max values are saved to EEPROM and applied automatically on boot.

---

## Repository Structure

```
├── Lodestone_Final_vXX_app.ino   # ESP32 firmware (Arduino sketch)
├── LodestoneApp/
│   ├── index.html                # PWA shell and all CSS
│   ├── js/
│   │   └── app.js                # All PWA logic (MQTT, map, UI)
│   ├── sw.js                     # Service worker (offline caching)
│   ├── manifest.json             # PWA manifest
│   └── icons/
│       ├── icon-192.png
│       └── icon-512.png
└── README.md
```

---

## License

MIT — do whatever you want with it, no warranty implied.

---

## Credits

Built with [TinyGPS++](http://arduiniana.org/libraries/tinygpsplus/), [PubSubClient](https://github.com/knolleary/pubsubclient), [ArduinoJson](https://arduinojson.org/), [Adafruit GFX](https://github.com/adafruit/Adafruit-GFX-Library), [Leaflet](https://leafletjs.com/), and [MQTT.js](https://github.com/mqttjs/MQTT.js).
