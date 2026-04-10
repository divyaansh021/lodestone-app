'use strict';

// ═══════════════════════════════════════════════════════════════
//  LODESTONE COMPANION APP
//  PWA — works in Safari (iPhone) and as installed app (Android)
// ═══════════════════════════════════════════════════════════════

const App = (() => {

  // ── State ──────────────────────────────────────────────────────
  const state = {
    tab: 'map',
    mqttClient: null,
    mqttConnected: false,
    myLat: null, myLon: null, myHeading: 0,
    gpsActive: false, gpsWatchId: null,
    locations: [],           // [{name,lat,lon}]
    devices: {},             // mac → {name,lat,lon,heading,lastSeen}
    pairedDevices: [],       // [mac]
    pendingPairFrom: null,   // {name, mac, topic}
    msgRecipient: 'broadcast', // 'broadcast' or a device mac
    pinLat: null, pinLon: null,
    myMac: randomMac(),
    deviceName: 'My Phone',
    cfg: {
      host: 'f2e56e6599344b86aa506ab8bc78ce52.s1.eu.hivemq.cloud',
      port: '8884',
      user: 'lodestone',
      pass: 'Lode$tone2026',
    }
  };

  // ── Map ────────────────────────────────────────────────────────
  let map, myMarker, pinMarker;
  const deviceMarkers = {};
  const savedMarkers  = {};

  function initMap() {
    map = L.map('leaflet-map', {
      center: [20.5937, 78.9629],   // India default
      zoom: 5,
      zoomControl: false,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map);

    // Hide search results on map click
    map.on('click', () => {
      document.getElementById('map-search-results').style.display = 'none';
    });

    // Tap to pin
    map.on('click', e => {
      const { lat, lng } = e.latlng;
      state.pinLat = lat; state.pinLon = lng;
      if (pinMarker) pinMarker.remove();
      pinMarker = L.marker([lat, lng], { icon: makeIcon('amber') }).addTo(map);
      document.getElementById('pin-coord').textContent =
        `${lat.toFixed(5)}° N,  ${lng.toFixed(5)}° E`;
      document.getElementById('pin-popup').classList.add('visible');
    });
  }

  function makeIcon(color) {
    const colors = { blue:'#58a6ff', green:'#3fb950', amber:'#f0a500' };
    const c = colors[color] || colors.amber;
    return L.divIcon({
      className: '',
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 0 6px ${c}88"></div>`,
      iconAnchor: [7,7],
    });
  }

  function updateMyMarker() {
    if (state.myLat == null) return;
    const pos = [state.myLat, state.myLon];
    if (!myMarker) {
      myMarker = L.marker(pos, { icon: makeIcon('blue'), zIndexOffset: 1000 }).addTo(map);
      myMarker.bindPopup('<b>You</b>');
      map.setView(pos, 14);
    } else {
      myMarker.setLatLng(pos);
    }
  }

  function updateDeviceMarker(mac) {
    const d = state.devices[mac];
    if (!d) return;
    const pos = [d.lat, d.lon];
    if (!deviceMarkers[mac]) {
      deviceMarkers[mac] = L.marker(pos, { icon: makeIcon('green') }).addTo(map);
      deviceMarkers[mac].bindPopup(`<b>${d.name}</b>`);
    } else {
      deviceMarkers[mac].setLatLng(pos);
      deviceMarkers[mac].getPopup().setContent(`<b>${d.name}</b>`);
    }
  }

  function updateSavedMarkers() {
    // Remove old
    Object.values(savedMarkers).forEach(m => m.remove());
    Object.keys(savedMarkers).forEach(k => delete savedMarkers[k]);
    state.locations.forEach((loc, i) => {
      const m = L.marker([loc.lat, loc.lon], { icon: makeIcon('amber') }).addTo(map);
      m.bindPopup(`<b>${loc.name}</b>`);
      savedMarkers[i] = m;
    });
  }

  // ── GPS ────────────────────────────────────────────────────────
  function toggleGps() {
    if (state.gpsActive) stopGps();
    else startGps();
  }

  function startGps() {
    if (!navigator.geolocation) { toast('GPS not supported on this browser'); return; }
    state.gpsWatchId = navigator.geolocation.watchPosition(
      pos => {
        state.myLat = pos.coords.latitude;
        state.myLon = pos.coords.longitude;
        updateMyMarker();
        renderConnectScreen();
        document.getElementById('gps-badge').textContent =
          `${state.myLat.toFixed(4)}, ${state.myLon.toFixed(4)}`;
        document.getElementById('gps-badge').classList.add('fix');
        if (state.mqttConnected) broadcastPosition();
      },
      err => { toast('GPS error: ' + err.message); },
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
    state.gpsActive = true;
    document.getElementById('gps-toggle').classList.add('on');
    document.getElementById('gps-status-sub').textContent = 'Active — sharing position';
  }

  function stopGps() {
    if (state.gpsWatchId != null) navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsActive = false;
    state.gpsWatchId = null;
    document.getElementById('gps-toggle').classList.remove('on');
    document.getElementById('gps-status-sub').textContent = 'Paused';
  }

  // ── MQTT ───────────────────────────────────────────────────────
  function toggleMqtt() {
    if (state.mqttConnected) disconnectMqtt();
    else connectMqtt();
  }

  function connectMqtt() {
    const host = document.getElementById('cfg-host').value.trim() || state.cfg.host;
    const port = parseInt(document.getElementById('cfg-port').value) || 8884;
    state.deviceName = document.getElementById('cfg-name').value.trim() || 'My Phone';

    setBrokerState('connecting', `wss://${host}:${port}/mqtt`, 'Connecting...');

    const url = `wss://${host}:${port}/mqtt`;
    const user = document.getElementById('cfg-user').value.trim() || state.cfg.user;
    const pass = document.getElementById('cfg-pass').value.trim() || state.cfg.pass;
    state.mqttClient = mqtt.connect(url, {
      clientId: 'lodestone_app_' + Math.random().toString(36).slice(2),
      username: user,
      password: pass,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    state.mqttClient.on('connect', () => {
      state.mqttConnected = true;
      setBrokerState('connected', host + ':' + port, 'Connected');
      // Subscribe to announce and pair request topics
      state.mqttClient.subscribe('lodestone/announce');
      state.mqttClient.subscribe('lodestone/devices/#');
      state.mqttClient.subscribe('lodestone/msg/broadcast');
      const myCleanMacForMsg = state.myMac.replace(/:/g,'');
      state.mqttClient.subscribe(`lodestone/msg/${myCleanMacForMsg}`);
      // Subscribe to incoming pair requests (colons stripped to match firmware)
      const myCleanMac = state.myMac.replace(/:/g, '');
      state.mqttClient.subscribe(`lodestone/request/${myCleanMac}`);
      state.mqttClient.subscribe(`lodestone/accept/${myCleanMac}`);
      // Re-subscribe to all saved paired topics
      const myClean = state.myMac.replace(/:/g,'');
      state.pairedDevices.forEach(mac => {
        const cleanMac = mac.replace(/:/g,'');
        // Try both orderings since firmware sorts differently
        state.mqttClient.subscribe(`lodestone/pair/${myClean}_${cleanMac}`);
        state.mqttClient.subscribe(`lodestone/pair/${cleanMac}_${myClean}`);
      });
      state.mqttClient.subscribe('lodestone/msg/broadcast');
      const myCleanMacForMsg = state.myMac.replace(/:/g,'');
      state.mqttClient.subscribe(`lodestone/msg/${myCleanMacForMsg}`);
      announcePresence();
      toast('Connected to broker');
    });

    state.mqttClient.on('message', (topic, payload) => {
      try {
        const data = JSON.parse(payload.toString());
        handleMessage(topic, data);
      } catch(e) {}
    });

    state.mqttClient.on('error', err => {
      setBrokerState('disconnected', '', 'Error: ' + err.message);
    });

    state.mqttClient.on('close', () => {
      state.mqttConnected = false;
      setBrokerState('disconnected', '', 'Disconnected');
      document.getElementById('broker-btn').textContent = 'Connect';
    });
  }

  function disconnectMqtt() {
    if (state.mqttClient) state.mqttClient.end();
    state.mqttConnected = false;
    setBrokerState('disconnected', '', 'Disconnected');
  }

  function setBrokerState(status, host, label) {
    const dot = document.getElementById('broker-dot');
    const lbl = document.getElementById('broker-label');
    const sub = document.getElementById('broker-sub');
    const btn = document.getElementById('broker-btn');
    const hdot = document.getElementById('mqtt-dot');
    const hlbl = document.getElementById('mqtt-label');
    dot.className = 'broker-dot' + (status === 'connected' ? ' connected' : status === 'connecting' ? ' connecting' : '');
    lbl.textContent = status === 'connected' ? 'MQTT Broker' : status === 'connecting' ? 'Connecting...' : 'MQTT Broker';
    sub.textContent = host || label;
    btn.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
    hdot.className = 'status-dot' + (status === 'connected' ? ' on' : '');
    hlbl.textContent = status === 'connected' ? 'Online' : status === 'connecting' ? 'Connecting' : 'Disconnected';
  }

  function handleMessage(topic, data) {
    // Incoming message — from broadcast or personal topic
    const myCleanForMsg = state.myMac.replace(/:/g,"");
    if (topic === 'lodestone/msg/broadcast' || topic === `lodestone/msg/${myCleanForMsg}`) {
      const from = data.from || 'Unknown';
      const msg  = data.msg  || '';
      if (!state.messages) state.messages = [];
      state.messages.unshift({ from, msg, time: Date.now() });
      if (state.messages.length > 50) state.messages.pop();
      showMessageNotification(from, msg);
      if (state.tab === 'messages') renderMessages();
      return;
    }

    // Position update from Lodestone hardware firmware
    if (topic.startsWith('lodestone/devices/')) {
      const mac = data.mac || topic.split('/')[2];
      if (!mac || mac === state.myMac) return;
      // Update device record regardless (so devices tab shows it)
      state.devices[mac] = {
        ...(state.devices[mac] || {}),
        name: data.name || 'Lodestone',
        lat: data.lat, lon: data.lon,
        heading: data.heading || 0,
        speed: data.speed || 0,
        lastSeen: Date.now(),
        isHardware: true,
      };
      // Only show on MAP if this device is paired
      const cleanMac = mac.replace(/:/g,'');
      const isPairedDevice = state.pairedDevices.some(p => p.replace(/:/g,'') === cleanMac);
      if (isPairedDevice) {
        updateDeviceMarker(mac);
        savePairedPositions();
      }
      renderDevices();
    }

    if (topic === 'lodestone/announce') {
      if (data.mac === state.myMac) return;
      const isHw = (data.type === 'hardware');
      if (!state.devices[data.mac]) {
        state.devices[data.mac] = {
          name: data.name, lat: null, lon: null, heading: 0,
          lastSeen: Date.now(), isHardware: isHw,
        };
      } else {
        state.devices[data.mac].lastSeen   = Date.now();
        state.devices[data.mac].name       = data.name;
        state.devices[data.mac].isHardware = isHw;
      }
      renderDevices();
    }

    // Pair request arrives on clean-MAC topic (no colons) — firmware strips them
    const myCleanForReq = state.myMac.replace(/:/g,"");
    if (topic === `lodestone/request/${myCleanForReq}` ||
        topic === `lodestone/request/${state.myMac}`) {
      const reqName = data.name || 'Unknown';
      const reqMac  = (data.mac || '').replace(/:/g,"");
      state.pendingPairFrom = { name: reqName, mac: reqMac };
      document.getElementById('pair-title').textContent = `"${reqName}" wants to connect`;
      document.getElementById('pair-sub').textContent = 'Accept to share live location with this device.';
      document.getElementById('pair-modal').classList.add('visible');
    }

    const myCleanForAccept = state.myMac.replace(/:/g,"");
    if (topic === `lodestone/accept/${myCleanForAccept}`) {
      // Our pair request was accepted
      const mac = data.mac;
      if (!state.pairedDevices.includes(mac)) {
        state.pairedDevices.push(mac);
        savePaired();
      }
      state.mqttClient.subscribe(`lodestone/pair/${pairTopic(state.myMac, mac)}`);
      toast(`${data.name || 'Device'} accepted your request`);
      renderDevices();
    }

    // Position update from paired device (check both topic orderings)
    const myCleanMac2 = state.myMac.replace(/:/g,'');
    state.pairedDevices.forEach(mac => {
      const cleanMac = mac.replace(/:/g,'');
      const t1 = `lodestone/pair/${myCleanMac2}_${cleanMac}`;
      const t2 = `lodestone/pair/${cleanMac}_${myCleanMac2}`;
      if (topic === t1 || topic === t2) {
        if (data.mac === state.myMac || data.mac === myCleanMac2) return;
        state.devices[mac] = {
          ...(state.devices[mac] || {}),
          name: data.name || state.devices[mac]?.name || 'Lodestone',
          lat: data.lat, lon: data.lon, heading: data.heading,
          lastSeen: Date.now(), isHardware: true,
        };
        updateDeviceMarker(mac);
        renderDevices();
        savePairedPositions();
      }
    });
  }

  function announcePresence() {
    if (!state.mqttConnected) return;
    state.mqttClient.publish('lodestone/announce', JSON.stringify({
      name: state.deviceName,
      mac: state.myMac,
      type: 'app',   // identifies this as a phone/browser client, not hardware
    }));
  }

  function broadcastPosition() {
    if (!state.mqttConnected || state.myLat == null) return;
    state.pairedDevices.forEach(mac => {
      state.mqttClient.publish(
        `lodestone/pair/${pairTopic(state.myMac, mac)}`,
        JSON.stringify({
          name: state.deviceName,
          mac: state.myMac,
          lat: state.myLat,
          lon: state.myLon,
          heading: state.myHeading,
        })
      );
    });
  }

  function unpairDevice(mac) {
    const cleanMac = mac.replace(/:/g,'');
    state.pairedDevices = state.pairedDevices.filter(m => m !== mac && m !== cleanMac);
    savePaired();
    // Unsubscribe from pair topic
    if (state.mqttClient) {
      state.mqttClient.unsubscribe(`lodestone/pair/${pairTopic(state.myMac, cleanMac)}`);
    }
    toast('Unpaired');
    renderDevices();
  }

  function sendPairRequest(mac) {
    if (!state.mqttConnected) { toast('Connect to broker first'); return; }
    // Strip colons to match firmware subscription topic format
    const cleanMac = mac.replace(/:/g, '');
    const myCleanMac = state.myMac.replace(/:/g, '');
    state.mqttClient.publish(`lodestone/request/${cleanMac}`, JSON.stringify({
      name: state.deviceName,
      mac: myCleanMac,
      type: 'app',
    }));
    toast('Pair request sent — waiting for acceptance on device');
  }

  function acceptPair() {
    const req = state.pendingPairFrom;
    if (!req) return;
    document.getElementById('pair-modal').classList.remove('visible');
    if (!state.pairedDevices.includes(req.mac)) {
      state.pairedDevices.push(req.mac);
      savePaired();
    }
    state.mqttClient.subscribe(`lodestone/pair/${pairTopic(state.myMac, req.mac)}`);
    // Notify requester
    state.mqttClient.publish(`lodestone/accept/${req.mac}`, JSON.stringify({
      name: state.deviceName, mac: state.myMac,
    }));
    toast(`Paired with ${req.name}`);
    state.pendingPairFrom = null;
    renderDevices();
  }

  function declinePair() {
    document.getElementById('pair-modal').classList.remove('visible');
    state.pendingPairFrom = null;
  }

  // ── Locations ──────────────────────────────────────────────────
  function showAddForm() {
    document.getElementById('add-form').style.display = 'block';
    document.getElementById('loc-name').focus();
  }

  function hideAddForm() {
    document.getElementById('add-form').style.display = 'none';
    ['loc-name','loc-lat','loc-lon'].forEach(id => document.getElementById(id).value = '');
  }

  function saveLocation() {
    const name = document.getElementById('loc-name').value.trim();
    const lat  = parseFloat(document.getElementById('loc-lat').value);
    const lon  = parseFloat(document.getElementById('loc-lon').value);
    if (!name) { toast('Enter a name'); return; }
    if (isNaN(lat) || isNaN(lon)) { toast('Enter valid coordinates'); return; }
    if (state.locations.length >= 10) { toast('Maximum 10 locations'); return; }
    state.locations.push({ name: name.slice(0,15).toUpperCase(), lat, lon });
    saveLocationsLocal();
    updateSavedMarkers();
    syncLocationsToDevice();
    hideAddForm();
    renderLocations();
    toast(`"${name}" saved`);
  }

  function addPinnedLocation() {
    if (state.pinLat == null) return;
    document.getElementById('pin-popup').classList.remove('visible');
    document.getElementById('loc-lat').value = state.pinLat.toFixed(6);
    document.getElementById('loc-lon').value = state.pinLon.toFixed(6);
    setTab('locations', document.querySelector('.tab:nth-child(2)'));
    showAddForm();
    document.getElementById('loc-name').focus();
  }

  function dismissPin() {
    document.getElementById('pin-popup').classList.remove('visible');
    if (pinMarker) { pinMarker.remove(); pinMarker = null; }
    state.pinLat = null; state.pinLon = null;
  }

  function deleteLocation(i) {
    const name = state.locations[i].name;
    state.locations.splice(i, 1);
    saveLocationsLocal();
    updateSavedMarkers();
    syncLocationsToDevice();
    renderLocations();
    toast(`"${name}" deleted`);
  }

  // Publish locations to Lodestone device via MQTT
  function syncLocationsToDevice() {
    if (!state.mqttConnected) return;
    state.mqttClient.publish('lodestone/locations', JSON.stringify({
      mac: state.myMac,
      locations: state.locations,
    }));
  }

  function renderLocations() {
    const el = document.getElementById('loc-list');
    if (state.locations.length === 0) {
      el.innerHTML = `<div class="empty">
        <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
        <p>No locations saved</p>
        <small>Tap + Add or tap anywhere on the map</small>
      </div>`;
      return;
    }
    el.innerHTML = `<div class="section-label">${state.locations.length} / 10 locations</div>` +
      state.locations.map((loc, i) => `
        <div class="list-item">
          <div class="list-icon amber">
            <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
          </div>
          <div class="item-info">
            <div class="item-name">${loc.name}</div>
            <div class="item-sub">${loc.lat.toFixed(5)}°, ${loc.lon.toFixed(5)}°</div>
          </div>
          <button onclick="App.deleteLocation(${i})" style="background:none;border:none;color:var(--red);padding:8px;cursor:pointer;font-size:18px;line-height:1">×</button>
        </div>`).join('');
  }

  function renderDevices() {
    const el = document.getElementById('device-list');
    // Prune stale (>30s)
    const now = Date.now();
    Object.keys(state.devices).forEach(mac => {
      if (now - state.devices[mac].lastSeen > 30000) delete state.devices[mac];
    });

    const hw  = Object.entries(state.devices).filter(([,d]) => d.isHardware);
    const app = Object.entries(state.devices).filter(([,d]) => !d.isHardware);

    if (hw.length === 0 && app.length === 0) {
      el.innerHTML = `<div class="empty">
        <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        <p>No devices discovered</p>
        <small>Connect to MQTT broker to see other Lodestones</small>
      </div>`;
      return;
    }

    const deviceRow = ([mac, d]) => {
      const cleanMacKey = mac.replace(/:/g,"");
      const paired = state.pairedDevices.some(p => p.replace(/:/g,"") === cleanMacKey);
      const age = Math.round((Date.now() - d.lastSeen) / 1000);
      const distStr = (d.lat != null && state.myLat != null)
        ? formatDist(haversine(state.myLat, state.myLon, d.lat, d.lon))
        : 'tap to pair';
      const icon = d.isHardware
        ? `<svg viewBox="0 0 24 24" style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.6"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>`
        : `<svg viewBox="0 0 24 24" style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.6"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>`;
      return `
        <div class="list-item">
          <div class="list-icon ${paired ? 'green' : d.isHardware ? 'amber' : 'blue'}" onclick="App.sendPairRequest('${mac}')">${icon}</div>
          <div class="item-info" onclick="App.sendPairRequest('${mac}')">
            <div class="item-name">${d.name}</div>
            <div class="item-sub">${distStr} · ${age}s ago</div>
          </div>
          ${paired
            ? `<button onclick="App.unpairDevice('${mac}')" style="background:none;border:1px solid var(--red);border-radius:6px;color:var(--red);padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap">Unpair</button>`
            : `<span class="item-badge badge-off" onclick="App.sendPairRequest('${mac}')">TAP TO PAIR</span>`
          }
        </div>`;
    };

    let html = '';
    if (hw.length > 0) {
      html += `<div class="section-label">Lodestone Devices (${hw.length})</div>`;
      html += hw.map(deviceRow).join('');
    }
    if (app.length > 0) {
      html += `<div class="section-label">App Users (${app.length})</div>`;
      html += app.map(deviceRow).join('');
    }
    el.innerHTML = html;
  }

  function renderConnectScreen() {
    const lat = state.myLat, lon = state.myLon;
    document.getElementById('my-coords').textContent =
      lat != null ? `${lat.toFixed(5)}°N  ${lon.toFixed(5)}°E` : '—';
  }

  // ── Tabs ────────────────────────────────────────────────────────
  function setTab(name, btn) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
    if (btn) btn.classList.add('active');
    state.tab = name;
    if (name === 'map') { setTimeout(() => map && map.invalidateSize(), 50); }
    if (name === 'locations') renderLocations();
    if (name === 'devices') renderDevices();
    if (name === 'connect') renderConnectScreen();
  }

  // ── Persistence ─────────────────────────────────────────────────
  function saveLocationsLocal() {
    try { localStorage.setItem('lode_locations', JSON.stringify(state.locations)); } catch(e) {}
  }
  function loadLocationsLocal() {
    try {
      const d = JSON.parse(localStorage.getItem('lode_locations') || '[]');
      if (Array.isArray(d)) state.locations = d.slice(0,10);
    } catch(e) {}
  }
  function pairedKey() {
    // Per-username key so each device/user has their own pairings
    const user = localStorage.getItem('lode_username') || 'default';
    return 'lode_paired_' + user.toLowerCase().replace(/[^a-z0-9]/g,'_');
  }
  function savePaired() {
    try { localStorage.setItem(pairedKey(), JSON.stringify(state.pairedDevices)); } catch(e) {}
  }
  function loadPaired() {
    try {
      const d = JSON.parse(localStorage.getItem(pairedKey()) || '[]');
      if (Array.isArray(d)) state.pairedDevices = d;
      // Also load last known positions
      const pos = JSON.parse(localStorage.getItem(pairedKey()+'_pos') || '{}');
      Object.entries(pos).forEach(([mac,d]) => {
        if (!state.devices[mac]) state.devices[mac] = { ...d, isHardware:true, lastSeen:0 };
      });
    } catch(e) {}
  }
  function savePairedPositions() {
    try {
      const pos = {};
      state.pairedDevices.forEach(mac => {
        if (state.devices[mac]?.lat) pos[mac] = { name:state.devices[mac].name, lat:state.devices[mac].lat, lon:state.devices[mac].lon };
      });
      localStorage.setItem(pairedKey()+'_pos', JSON.stringify(pos));
    } catch(e) {}
  }
  function loadConfig() {
    try {
      const c = JSON.parse(localStorage.getItem('lode_cfg') || '{}');
      if (c.host) document.getElementById('cfg-host').value = c.host;
      if (c.port) document.getElementById('cfg-port').value = c.port;
      if (c.user) document.getElementById('cfg-user').value = c.user;
      if (c.pass) document.getElementById('cfg-pass').value = c.pass;
      if (c.name) { document.getElementById('cfg-name').value = c.name; state.deviceName = c.name; }
    } catch(e) {}
  }

  // ── Announce loop ───────────────────────────────────────────────
  function startAnnounceLoop() {
    setInterval(() => {
      if (state.mqttConnected) {
        announcePresence();
        broadcastPosition();
      }
      renderDevices();
    }, 5000);
  }

  // ── Utils ───────────────────────────────────────────────────────
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }

  function randomMac() {
    const stored = localStorage.getItem('lode_mac');
    if (stored) return stored;
    const mac = Array.from({length:6}, () => Math.floor(Math.random()*256).toString(16).padStart(2,'0')).join(':');
    localStorage.setItem('lode_mac', mac);
    return mac;
  }

  function pairTopic(macA, macB) {
    return [macA, macB].sort().join('_').replace(/:/g,'');
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI/180;
    const dLat = (lat2-lat1)*r, dLon = (lon2-lon1)*r;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function formatDist(m) {
    return m >= 1000 ? (m/1000).toFixed(1)+'km' : Math.round(m)+'m';
  }


  function showUsernamePrompt() {
    const overlay = document.createElement('div');
    overlay.id = 'username-overlay';
    overlay.style.cssText = [
      'position:fixed','inset:0','background:var(--bg0)','z-index:9999',
      'display:flex','flex-direction:column','align-items:center',
      'justify-content:center','padding:32px','gap:20px'
    ].join(';');
    overlay.innerHTML = `
      <div style="font-size:28px;font-weight:700;color:var(--amber);font-family:var(--font-mono);letter-spacing:.1em">LODESTONE</div>
      <div style="font-size:14px;color:var(--text2);text-align:center;line-height:1.7;max-width:280px">
        Enter your name.<br>This identifies you to other Lodestone users.
      </div>
      <input id="un-input" type="text" maxlength="15" placeholder="e.g. Ravi"
        style="width:100%;max-width:280px;background:var(--bg2);border:2px solid var(--amber);
               border-radius:10px;padding:13px 16px;font-size:16px;color:var(--text);
               outline:none;text-align:center;font-family:var(--font-ui);"
        autocomplete="off" autocorrect="off" spellcheck="false">
      <button id="un-btn" style="width:100%;max-width:280px;padding:13px;border-radius:10px;
        border:none;background:var(--amber);color:#000;font-size:15px;font-weight:700;
        cursor:pointer;">Continue</button>
      <div style="font-size:11px;color:var(--text3)">You can change this later in the Connect tab</div>
    `;
    document.body.appendChild(overlay);

    function confirm() {
      const val = (document.getElementById('un-input').value || '').trim();
      if (!val) { toast('Please enter your name'); return; }
      const name = val.slice(0, 15);
      state.deviceName = name;
      localStorage.setItem('lode_username', name);
      try { document.getElementById('cfg-name').value = name; } catch(e) {}
      loadPaired();
      overlay.remove();
      if (state.mqttConnected) announcePresence();
      toast('Welcome, ' + name + '!');
    }

    setTimeout(() => {
      document.getElementById('un-btn').onclick = confirm;
      document.getElementById('un-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') confirm();
      });
      document.getElementById('un-input').focus();
    }, 50);
  }

  // ── Init ────────────────────────────────────────────────────────
  function init() {
    loadLocationsLocal();
    loadConfig();
    initMap();
    updateSavedMarkers();
    startAnnounceLoop();

    // ── Username prompt — must happen before loadPaired() ──────────────
    const storedName = localStorage.getItem('lode_username');
    if (!storedName) {
      showUsernamePrompt();
    } else {
      state.deviceName = storedName;
      try { document.getElementById('cfg-name').value = storedName; } catch(e) {}
      loadPaired();
    }

    // Pre-fill defaults if inputs are empty
  if (!document.getElementById('cfg-host').value)
    document.getElementById('cfg-host').value = state.cfg.host;
  if (!document.getElementById('cfg-port').value)
    document.getElementById('cfg-port').value = state.cfg.port;
  if (!document.getElementById('cfg-user').value)
    document.getElementById('cfg-user').value = state.cfg.user;
  if (!document.getElementById('cfg-pass').value)
    document.getElementById('cfg-pass').value = state.cfg.pass;

  // Config auto-save
    document.getElementById('cfg-name').addEventListener('change', e => {
    const v = e.target.value.trim();
    if (v) {
      state.deviceName = v;
      localStorage.setItem('lode_username', v);
      loadPaired();  // reload pairings for this username
      renderDevices();
    }
  });
  ['cfg-host','cfg-port','cfg-name'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => {
        try {
          localStorage.setItem('lode_cfg', JSON.stringify({
            host: document.getElementById('cfg-host').value,
            port: document.getElementById('cfg-port').value,
            name: document.getElementById('cfg-name').value,
          }));
        } catch(e) {}
      });
    });

    // Service worker registration
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    renderLocations();
    renderDevices();
  }

  document.addEventListener('DOMContentLoaded', init);


  // ── Messages ─────────────────────────────────────────────────────────────────
  function showMessageNotification(from, msg) {
    const n = document.createElement('div');
    n.style.cssText = `
      position:fixed;top:60px;left:50%;transform:translateX(-50%);
      background:var(--bg2);border:1px solid var(--amber);border-radius:10px;
      padding:10px 16px;z-index:800;max-width:300px;width:90%;
      display:flex;flex-direction:column;gap:4px;cursor:pointer;
    `;
    n.innerHTML = `
      <div style="font-size:11px;color:var(--amber);font-weight:600">${from}</div>
      <div style="font-size:13px;color:var(--text)">${msg}</div>
    `;
    n.onclick = () => { n.remove(); setTab('messages', document.querySelector('.tab:nth-child(5)')); };
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 4000);
  }

  function renderMessages() {
    renderMsgRecipientBar();
    const el = document.getElementById('msg-list');
    if (!el) return;
    if (!state.messages || !state.messages.length) {
      el.innerHTML = `<div class="empty">
        <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <p>No messages yet</p><small>Messages from Lodestone devices appear here</small>
      </div>`;
      return;
    }
    el.innerHTML = state.messages.map(m => {
      const t = new Date(m.time);
      const timeStr = t.getHours().toString().padStart(2,'0')+':'+t.getMinutes().toString().padStart(2,'0');
      const toLabel = m.to && m.to !== 'Everyone' ? ` → ${m.to}` : '';
      return `<div class="list-item" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;width:100%;justify-content:space-between">
          <span style="font-size:12px;font-weight:600;color:var(--amber)">${m.from}${toLabel}</span>
          <span style="font-size:11px;color:var(--text3)">${timeStr}</span>
        </div>
        <div style="font-size:14px;color:var(--text)">${m.msg}</div>
      </div>`;
    }).join('');
  }

  function setMsgRecipient(mac) {
    state.msgRecipient = mac;
    renderMsgRecipientBar();
  }

  function renderMsgRecipientBar() {
    const bar = document.getElementById('msg-recipient-bar');
    if (!bar) return;
    const allDevices = [
      { mac: 'broadcast', name: 'Everyone (broadcast)' },
      ...state.pairedDevices.map(mac => {
        const d = state.devices[mac] || state.devices[mac.replace(/:/g,'')] || {};
        return { mac, name: d.name || mac };
      }),
      ...Object.entries(state.devices)
        .filter(([,d]) => !d.isHardware)
        .map(([mac,d]) => ({ mac, name: d.name || mac }))
    ];
    // Deduplicate by mac
    const seen = new Set();
    const unique = allDevices.filter(d => {
      const k = d.mac.replace(/:/g,'');
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    bar.innerHTML = unique.map(d => {
      const cleanKey = d.mac.replace(/:/g,'');
      const selectedKey = state.msgRecipient.replace(/:/g,'');
      const active = cleanKey === selectedKey;
      return `<button onclick="App.setMsgRecipient('${d.mac}')" style="
        padding:5px 12px;border-radius:20px;border:1px solid ${active ? 'var(--amber)' : 'var(--border)'};
        background:${active ? 'var(--amber-dim)' : 'none'};color:${active ? 'var(--amber)' : 'var(--text2)'};
        font-size:11px;cursor:pointer;white-space:nowrap;font-family:var(--font-ui);
      ">${d.name}</button>`;
    }).join('');
  }

  function sendMessage() {
    const input = document.getElementById('msg-input');
    const msg = (input.value || '').trim();
    if (!msg) return;
    if (!state.mqttConnected) { toast('Connect to broker first'); return; }
    const payload = JSON.stringify({ from: state.deviceName, mac: state.myMac.replace(/:/g,''), msg });
    const recipient = state.msgRecipient || 'broadcast';

    if (recipient === 'broadcast') {
      // Send to all paired hardware devices + broadcast topic
      state.mqttClient.publish('lodestone/msg/broadcast', payload);
      state.pairedDevices.forEach(mac => {
        state.mqttClient.publish(`lodestone/msg/${mac.replace(/:/g,'')}`, payload);
      });
    } else {
      // Send to specific device only
      const cleanMac = recipient.replace(/:/g,'');
      const d = state.devices[recipient] || state.devices[cleanMac];
      if (d && d.isHardware) {
        state.mqttClient.publish(`lodestone/msg/${cleanMac}`, payload);
      } else {
        // App user — use their individual msg topic
        state.mqttClient.publish(`lodestone/msg/${cleanMac}`, payload);
      }
    }

    if (!state.messages) state.messages = [];
    const recipientName = recipient === 'broadcast' ? 'Everyone'
      : (state.devices[recipient] || state.devices[recipient.replace(/:/g,'')] || {}).name || recipient;
    state.messages.unshift({ from: 'Me', msg, to: recipientName, time: Date.now() });
    input.value = '';
    renderMessages();
    toast('Sent to ' + recipientName);
  }

  // ── Map search (Nominatim — free, no API key) ────────────────────────────
  let searchMarker = null;
  async function searchMap() {
    const q = document.getElementById('map-search-input').value.trim();
    if (!q) return;
    const resultsEl = document.getElementById('map-search-results');
    resultsEl.innerHTML = '<div class="map-search-result">Searching...</div>';
    resultsEl.style.display = 'block';
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=4`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const data = await res.json();
      if (!data.length) {
        resultsEl.innerHTML = '<div class="map-search-result">No results found</div>';
        return;
      }
      resultsEl.innerHTML = data.map((r,i) =>
        `<div class="map-search-result" onclick="App.selectSearchResult(${r.lat},${r.lon},'${r.display_name.replace(/'/g,"\'")}')">
          ${r.display_name.split(',').slice(0,2).join(',')}
          <small>${r.display_name.split(',').slice(2,4).join(',')}</small>
        </div>`
      ).join('');
    } catch(e) {
      resultsEl.innerHTML = '<div class="map-search-result">Search failed — check connection</div>';
    }
  }

  function selectSearchResult(lat, lon, name) {
    document.getElementById('map-search-results').style.display = 'none';
    document.getElementById('map-search-input').value = name.split(',').slice(0,2).join(',');
    const pos = [parseFloat(lat), parseFloat(lon)];
    map.setView(pos, 15);
    if (searchMarker) searchMarker.remove();
    searchMarker = L.marker(pos, { icon: makeIcon('blue') })
      .bindPopup(name.split(',').slice(0,2).join(','))
      .addTo(map)
      .openPopup();
    // Pre-fill the add-location form with this position
    state.pinLat = parseFloat(lat);
    state.pinLon = parseFloat(lon);
    document.getElementById('pin-coord').textContent =
      `${parseFloat(lat).toFixed(5)}° N,  ${parseFloat(lon).toFixed(5)}° E`;
    document.getElementById('pin-popup').classList.add('visible');
  }

  // Public API
  return {
    setTab, toggleGps, toggleMqtt, connectMqtt, disconnectMqtt,
    showAddForm, hideAddForm, saveLocation, deleteLocation,
    addPinnedLocation, dismissPin,
    acceptPair, declinePair,
    sendPairRequest, unpairDevice,
    searchMap, selectSearchResult,
    renderMessages, sendMessage, setMsgRecipient, renderMsgRecipientBar,
  };

})();
