# Lodestone PWA — File Plan

## Files
- index.html         — shell, nav, PWA meta
- manifest.json      — PWA manifest (installable)
- sw.js              — service worker (offline cache)
- css/app.css        — all styles
- js/mqtt.js         — MQTT connection + broker logic
- js/map.js          — Leaflet map, markers, tap-to-pin
- js/locations.js    — location list CRUD, sync to device
- js/devices.js      — nearby devices, pairing
- js/app.js          — main app controller, tab routing
- icons/             — PWA icons (generated as SVG→PNG via canvas)

## Aesthetic
Dark tactical/military aesthetic — dark slate backgrounds,
amber/orange accents (matches Lodestone hardware orange LED vibe),
monospace font for coordinates and data, clean sans for UI.
Think: field gear meets modern app.

## Libraries (CDN, no install)
- Leaflet 1.9 (maps, no API key)
- MQTT.js 5.x (MQTT over WebSocket to HiveMQ)
- OpenStreetMap tiles (free, no key)
