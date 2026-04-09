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
    pinLat: null, pinLon: null,
    myMac: randomMac(),
    deviceName: 'My Phone',
    cfg: {
      host: 'broker.hivemq.com',
      port: '8884',
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

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map);

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
    state.mqttClient = mqtt.connect(url, {
      clientId: 'lodestone_app_' + Math.random().toString(36).slice(2),
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    state.mqttClient.on('connect', () => {
      state.mqttConnected = true;
      setBrokerState('connected', host + ':' + port, 'Connected');
      // Subscribe to announce and pair request topics
      state.mqttClient.subscribe('lodestone/announce');
      state.mqttClient.subscribe(`lodestone/request/${state.myMac}`);
      state.mqttClient.subscribe(`lodestone/accept/${state.myMac}`);
      // Subscribe to paired device topics
      state.pairedDevices.forEach(mac => {
        state.mqttClient.subscribe(`lodestone/pair/${pairTopic(state.myMac, mac)}`);
      });
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
    if (topic === 'lodestone/announce') {
      if (data.mac === state.myMac) return;
      // Show in devices list even before pairing
      if (!state.devices[data.mac]) {
        state.devices[data.mac] = { name: data.name, lat: null, lon: null, heading: 0, lastSeen: Date.now() };
      } else {
        state.devices[data.mac].lastSeen = Date.now();
        state.devices[data.mac].name = data.name;
      }
      renderDevices();
    }

    if (topic === `lodestone/request/${state.myMac}`) {
      // Incoming pair request — show modal
      state.pendingPairFrom = { name: data.name, mac: data.mac };
      document.getElementById('pair-title').textContent = `"${data.name}" wants to connect`;
      document.getElementById('pair-sub').textContent = 'Accept to share live location with this Lodestone device.';
      document.getElementById('pair-modal').classList.add('visible');
    }

    if (topic === `lodestone/accept/${state.myMac}`) {
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

    // Position update from paired device
    state.pairedDevices.forEach(mac => {
      if (topic === `lodestone/pair/${pairTopic(state.myMac, mac)}`) {
        if (data.mac === state.myMac) return;
        state.devices[mac] = {
          ...(state.devices[mac] || {}),
          name: data.name || state.devices[mac]?.name || 'Lodestone',
          lat: data.lat, lon: data.lon, heading: data.heading,
          lastSeen: Date.now(),
        };
        updateDeviceMarker(mac);
        renderDevices();
      }
    });
  }

  function announcePresence() {
    if (!state.mqttConnected) return;
    state.mqttClient.publish('lodestone/announce', JSON.stringify({
      name: state.deviceName,
      mac: state.myMac,
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

  function sendPairRequest(mac) {
    if (!state.mqttConnected) { toast('Connect to broker first'); return; }
    state.mqttClient.publish(`lodestone/request/${mac}`, JSON.stringify({
      name: state.deviceName,
      mac: state.myMac,
    }));
    toast('Pair request sent — waiting for acceptance');
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
    const macs = Object.keys(state.devices);
    if (macs.length === 0) {
      el.innerHTML = `<div class="empty">
        <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        <p>No devices discovered</p>
        <small>Connect to MQTT broker to see other Lodestones</small>
      </div>`;
      return;
    }

    // Prune stale (>20s)
    const now = Date.now();
    macs.forEach(mac => { if (now - state.devices[mac].lastSeen > 20000) delete state.devices[mac]; });

    el.innerHTML = '<div class="section-label">Discovered</div>' +
      Object.entries(state.devices).map(([mac, d]) => {
        const paired = state.pairedDevices.includes(mac);
        const age = Math.round((Date.now() - d.lastSeen) / 1000);
        const distStr = (d.lat != null && state.myLat != null)
          ? formatDist(haversine(state.myLat, state.myLon, d.lat, d.lon))
          : 'distance unknown';
        return `
          <div class="list-item" onclick="App.sendPairRequest('${mac}')">
            <div class="list-icon ${paired ? 'green' : 'blue'}">
              <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            </div>
            <div class="item-info">
              <div class="item-name">${d.name}</div>
              <div class="item-sub">${distStr} · ${age}s ago</div>
            </div>
            <span class="item-badge ${paired ? 'badge-live' : 'badge-off'}">${paired ? 'PAIRED' : 'TAP TO PAIR'}</span>
          </div>`;
      }).join('');
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
  function savePaired() {
    try { localStorage.setItem('lode_paired', JSON.stringify(state.pairedDevices)); } catch(e) {}
  }
  function loadPaired() {
    try {
      const d = JSON.parse(localStorage.getItem('lode_paired') || '[]');
      if (Array.isArray(d)) state.pairedDevices = d;
    } catch(e) {}
  }
  function loadConfig() {
    try {
      const c = JSON.parse(localStorage.getItem('lode_cfg') || '{}');
      if (c.host) document.getElementById('cfg-host').value = c.host;
      if (c.port) document.getElementById('cfg-port').value = c.port;
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

  // ── Init ────────────────────────────────────────────────────────
  function init() {
    loadLocationsLocal();
    loadPaired();
    loadConfig();
    initMap();
    updateSavedMarkers();
    startAnnounceLoop();

    // Config auto-save
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

  // Public API
  return {
    setTab, toggleGps, toggleMqtt, connectMqtt, disconnectMqtt,
    showAddForm, hideAddForm, saveLocation, deleteLocation,
    addPinnedLocation, dismissPin,
    acceptPair, declinePair,
    sendPairRequest,
  };

})();
