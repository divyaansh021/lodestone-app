'use strict';

const App = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    tab: 'map',
    mqttClient: null,
    mqttConnected: false,
    myLat: null, myLon: null, myHeading: 0,
    gpsActive: false, gpsWatchId: null,
    locations: [],
    devices: {},
    pairedDevices: [],
    pendingPairFrom: null,
    pinLat: null, pinLon: null,
    myMac: getOrCreateMac(),
    deviceName: 'My Device',
    messages: [],
    msgRecipient: 'broadcast',
    deviceLocations: {},
    selectedLocDevice: null,
    pendingAddDeviceKey: null,
    cfg: {
      host: 'f2e56e6599344b86aa506ab8bc78ce52.s1.eu.hivemq.cloud',
      port: '8884',
      user: 'lodestone',
      pass: 'Lode$tone2026',
    }
  };

  function getOrCreateMac() {
    let m = localStorage.getItem('lode_mac');
    if (!m) {
      m = Array.from({length:6}, () => Math.floor(Math.random()*256).toString(16).padStart(2,'0')).join(':');
      localStorage.setItem('lode_mac', m);
    }
    return m;
  }

  function cleanMac(mac) { return (mac||'').replace(/:/g,''); }
  function isPaired(mac) {
    const c = cleanMac(mac);
    return state.pairedDevices.some(p => cleanMac(p) === c);
  }
  function pairKey() {
    const u = localStorage.getItem('lode_username') || 'default';
    return 'lode_paired_' + u.toLowerCase().replace(/[^a-z0-9]/g,'_');
  }
  function savePaired() {
    try { localStorage.setItem(pairKey(), JSON.stringify(state.pairedDevices)); } catch(e) {}
  }
  function loadPaired() {
    try {
      const d = JSON.parse(localStorage.getItem(pairKey()) || '[]');
      if (Array.isArray(d)) state.pairedDevices = d;
      // Restore last known positions
      const pos = JSON.parse(localStorage.getItem(pairKey()+'_pos') || '{}');
      Object.entries(pos).forEach(([mac,d]) => {
        if (!state.devices[mac]) state.devices[mac] = {...d, isHardware:true, lastSeen:0};
      });
    } catch(e) {}
  }
  function savePairedPositions() {
    try {
      const pos = {};
      state.pairedDevices.forEach(mac => {
        const d = state.devices[mac] || state.devices[cleanMac(mac)];
        if (d && d.lat) pos[mac] = {name:d.name, lat:d.lat, lon:d.lon};
      });
      localStorage.setItem(pairKey()+'_pos', JSON.stringify(pos));
    } catch(e) {}
  }
  function saveLocationsLocal() {
    try { localStorage.setItem('lode_locations', JSON.stringify(state.locations)); } catch(e) {}
  }
  function loadLocationsLocal() {
    try {
      const d = JSON.parse(localStorage.getItem('lode_locations') || '[]');
      if (Array.isArray(d)) state.locations = d.slice(0,10);
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
    // Pre-fill defaults
    const els = {
      'cfg-host': state.cfg.host, 'cfg-port': state.cfg.port,
      'cfg-user': state.cfg.user, 'cfg-pass': state.cfg.pass,
    };
    Object.entries(els).forEach(([id,val]) => {
      const el = document.getElementById(id);
      if (el && !el.value) el.value = val;
    });
  }

  // ── Map ────────────────────────────────────────────────────────────────────
  let map, myMarker, pinMarker, searchMarker;
  const deviceMarkers = {};
  const savedMarkers = {};

  function initMap() {
    map = L.map('leaflet-map', { center:[20.5937,78.9629], zoom:5, zoomControl:false, attributionControl:false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom:19 }).addTo(map);
    map.on('click', e => {
      document.getElementById('map-search-results').style.display = 'none';
      const {lat, lng} = e.latlng;
      state.pinLat = lat; state.pinLon = lng;
      if (pinMarker) pinMarker.remove();
      pinMarker = L.marker([lat,lng], {icon:makeIcon('amber')}).addTo(map);
      document.getElementById('pin-coord').textContent = `${lat.toFixed(5)}° N,  ${lng.toFixed(5)}° E`;
      document.getElementById('pin-popup').classList.add('visible');
    });
  }

  function makeIcon(color) {
    const c = {blue:'#58a6ff', green:'#3fb950', amber:'#f0a500'}[color] || '#f0a500';
    return L.divIcon({
      className:'',
      html:`<div style="width:14px;height:14px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 0 6px ${c}88"></div>`,
      iconAnchor:[7,7],
    });
  }

  function updateMyMarker() {
    if (state.myLat == null) return;
    const pos = [state.myLat, state.myLon];
    if (!myMarker) { myMarker = L.marker(pos,{icon:makeIcon('blue'),zIndexOffset:1000}).addTo(map).bindPopup('<b>You</b>'); map.setView(pos,14); }
    else myMarker.setLatLng(pos);
  }

  function updateDeviceMarker(mac) {
    const d = state.devices[mac];
    if (!d || !d.lat) return;
    if (!isPaired(mac)) return; // only show paired devices on map
    const pos = [d.lat, d.lon];
    if (!deviceMarkers[mac]) {
      deviceMarkers[mac] = L.marker(pos,{icon:makeIcon('green')}).addTo(map).bindPopup(`<b>${d.name}</b>`);
    } else {
      deviceMarkers[mac].setLatLng(pos);
      deviceMarkers[mac].getPopup().setContent(`<b>${d.name}</b>`);
    }
  }

  function updateSavedMarkers() {
    Object.values(savedMarkers).forEach(m => m.remove());
    Object.keys(savedMarkers).forEach(k => delete savedMarkers[k]);
    state.locations.forEach((loc,i) => {
      savedMarkers[i] = L.marker([loc.lat,loc.lon],{icon:makeIcon('amber')}).addTo(map).bindPopup(`<b>${loc.name}</b>`);
    });
  }

  // ── GPS ────────────────────────────────────────────────────────────────────
  function toggleGps() { state.gpsActive ? stopGps() : startGps(); }
  function startGps() {
    if (!navigator.geolocation) { toast('GPS not supported'); return; }
    state.gpsWatchId = navigator.geolocation.watchPosition(pos => {
      state.myLat = pos.coords.latitude; state.myLon = pos.coords.longitude;
      updateMyMarker(); renderConnectScreen();
      document.getElementById('gps-badge').textContent = `${state.myLat.toFixed(4)}, ${state.myLon.toFixed(4)}`;
      document.getElementById('gps-badge').classList.add('fix');
      if (state.mqttConnected) broadcastPosition();
    }, err => toast('GPS: '+err.message), {enableHighAccuracy:true, maximumAge:2000});
    state.gpsActive = true;
    document.getElementById('gps-toggle').classList.add('on');
    document.getElementById('gps-status-sub').textContent = 'Active — sharing position';
  }
  function stopGps() {
    if (state.gpsWatchId != null) navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsActive = false; state.gpsWatchId = null;
    document.getElementById('gps-toggle').classList.remove('on');
    document.getElementById('gps-status-sub').textContent = 'Paused';
  }

  // ── MQTT ───────────────────────────────────────────────────────────────────
  function toggleMqtt() { state.mqttConnected ? disconnectMqtt() : connectMqtt(); }

  function connectMqtt() {
    const host = document.getElementById('cfg-host').value.trim() || state.cfg.host;
    const port = parseInt(document.getElementById('cfg-port').value) || 8884;
    const user = document.getElementById('cfg-user').value.trim() || state.cfg.user;
    const pass = document.getElementById('cfg-pass').value.trim() || state.cfg.pass;
    state.deviceName = document.getElementById('cfg-name').value.trim() || state.deviceName;
    setBrokerState('connecting', `${host}:${port}`, 'Connecting...');
    state.mqttClient = mqtt.connect(`wss://${host}:${port}/mqtt`, {
      clientId: 'lodestone_app_' + Math.random().toString(36).slice(2),
      username: user, password: pass,
      reconnectPeriod: 5000, connectTimeout: 10000,
    });
    state.mqttClient.on('connect', onMqttConnect);
    state.mqttClient.on('message', (topic, payload) => {
      try { handleMessage(topic, JSON.parse(payload.toString())); } catch(e) {}
    });
    state.mqttClient.on('error', err => setBrokerState('disconnected','','Error: '+err.message));
    state.mqttClient.on('close', () => { state.mqttConnected=false; setBrokerState('disconnected','','Disconnected'); });
  }

  function onMqttConnect() {
    state.mqttConnected = true;
    const host = document.getElementById('cfg-host').value || state.cfg.host;
    setBrokerState('connected', host, 'Connected');
    const myClean = cleanMac(state.myMac);
    // Subscribe to all needed topics
    const topics = [
      'lodestone/announce',
      'lodestone/devices/#',
      'lodestone/msg/broadcast',
      'lodestone/loc/response/#',
      `lodestone/msg/${myClean}`,
      `lodestone/request/${myClean}`,
      `lodestone/accept/${myClean}`,
    ];
    topics.forEach(t => state.mqttClient.subscribe(t));
    // Re-subscribe to paired pair topics
    state.pairedDevices.forEach(mac => {
      const c = cleanMac(mac);
      state.mqttClient.subscribe(`lodestone/pair/${myClean}_${c}`);
      state.mqttClient.subscribe(`lodestone/pair/${c}_${myClean}`);
    });
    announcePresence();
    // Request locations from paired hardware devices
    state.pairedDevices.forEach(mac => {
      state.mqttClient.publish(`lodestone/loc/request/${cleanMac(mac)}`, '1');
    });
    toast('Connected to broker');
  }

  function disconnectMqtt() {
    if (state.mqttClient) state.mqttClient.end();
    state.mqttConnected = false;
    setBrokerState('disconnected','','Disconnected');
  }

  function setBrokerState(status, host, label) {
    const dot = document.getElementById('broker-dot');
    const lbl = document.getElementById('broker-label');
    const sub = document.getElementById('broker-sub');
    const btn = document.getElementById('broker-btn');
    const hdot = document.getElementById('mqtt-dot');
    const hlbl = document.getElementById('mqtt-label');
    dot.className = 'broker-dot' + (status==='connected'?' connected':status==='connecting'?' connecting':'');
    lbl.textContent = status==='connecting' ? 'Connecting...' : 'MQTT Broker';
    sub.textContent = host || label;
    btn.textContent = status==='connected' ? 'Disconnect' : 'Connect';
    hdot.className = 'status-dot' + (status==='connected'?' on':'');
    hlbl.textContent = status==='connected' ? 'Online' : status==='connecting' ? 'Connecting' : 'Disconnected';
  }

  function announcePresence() {
    if (!state.mqttConnected) return;
    state.mqttClient.publish('lodestone/announce', JSON.stringify({
      name: state.deviceName, mac: state.myMac, type: 'app',
    }));
  }

  function broadcastPosition() {
    if (!state.mqttConnected || state.myLat == null) return;
    const myClean = cleanMac(state.myMac);
    state.pairedDevices.forEach(mac => {
      const c = cleanMac(mac);
      state.mqttClient.publish(`lodestone/pair/${myClean}_${c}`, JSON.stringify({
        name: state.deviceName, mac: myClean, lat: state.myLat, lon: state.myLon, heading: state.myHeading,
      }));
    });
  }

  // ── Message handler ────────────────────────────────────────────────────────
  function handleMessage(topic, data) {
    const myClean = cleanMac(state.myMac);

    // Incoming message
    if (topic === 'lodestone/msg/broadcast' || topic === `lodestone/msg/${myClean}`) {
      if (!state.messages) state.messages = [];
      state.messages.unshift({ from: data.from||'Unknown', msg: data.msg||'', time: Date.now() });
      if (state.messages.length > 50) state.messages.pop();
      showMessageNotification(data.from||'Unknown', data.msg||'');
      if (state.tab === 'messages') renderMessages();
      return;
    }

    // Location response from hardware device
    if (topic.startsWith('lodestone/loc/response/')) {
      const devMac = topic.split('/')[3];
      const devEntry = Object.entries(state.devices).find(([mac]) => cleanMac(mac) === devMac || mac === devMac);
      const devName = devEntry ? devEntry[1].name : 'Lodestone';
      try {
        const locs = Array.isArray(data) ? data : JSON.parse(data);
        state.deviceLocations[devMac] = { name: devName, locations: locs };
        if (state.tab === 'locations') renderLocations();
      } catch(e) {}
      return;
    }

    // Position from hardware firmware
    if (topic.startsWith('lodestone/devices/')) {
      const mac = data.mac || topic.split('/')[2];
      if (!mac || mac === myClean || mac === state.myMac) return;
      state.devices[mac] = { ...(state.devices[mac]||{}), name:data.name||'Lodestone', lat:data.lat, lon:data.lon, heading:data.heading||0, speed:data.speed||0, lastSeen:Date.now(), isHardware:true };
      if (isPaired(mac)) { updateDeviceMarker(mac); savePairedPositions(); }
      renderDevices();
      return;
    }

    // Announce
    if (topic === 'lodestone/announce') {
      if (data.mac === state.myMac || cleanMac(data.mac) === myClean) return;
      const isHw = data.type === 'hardware';
      const mac = data.mac;
      state.devices[mac] = { ...(state.devices[mac]||{}), name:data.name||'Device', lastSeen:Date.now(), isHardware:isHw, lat:state.devices[mac]?.lat||null, lon:state.devices[mac]?.lon||null };
      renderDevices();
      return;
    }

    // Pair request (arrives on clean MAC topic)
    if (topic === `lodestone/request/${myClean}`) {
      state.pendingPairFrom = { name: data.name||'Unknown', mac: cleanMac(data.mac||'') };
      document.getElementById('pair-title').textContent = `"${data.name}" wants to connect`;
      document.getElementById('pair-sub').textContent = 'Accept to share live GPS location.';
      document.getElementById('pair-modal').classList.add('visible');
      return;
    }

    // Pair accepted
    if (topic === `lodestone/accept/${myClean}`) {
      const incomingClean = cleanMac(data.mac||'');
      if (incomingClean && !state.pairedDevices.some(p => cleanMac(p) === incomingClean)) {
        state.pairedDevices.push(incomingClean);
        savePaired();
      }
      state.mqttClient.subscribe(`lodestone/pair/${myClean}_${incomingClean}`);
      state.mqttClient.subscribe(`lodestone/pair/${incomingClean}_${myClean}`);
      // Request their locations
      state.mqttClient.publish(`lodestone/loc/request/${incomingClean}`, '1');
      toast(`${data.name||'Device'} accepted your request!`);
      renderDevices();
      return;
    }

    // Position from paired device (pair topic)
    if (topic.startsWith('lodestone/pair/')) {
      const senderClean = cleanMac(data.mac||'');
      if (senderClean === myClean) return;
      // Find which paired device this is
      state.pairedDevices.forEach(mac => {
        if (cleanMac(mac) === senderClean) {
          state.devices[mac] = { ...(state.devices[mac]||{}), name:data.name||'Device', lat:data.lat, lon:data.lon, heading:data.heading||0, lastSeen:Date.now(), isHardware:false };
          updateDeviceMarker(mac);
          renderDevices();
          savePairedPositions();
        }
      });
    }
  }

  // ── Pairing ────────────────────────────────────────────────────────────────
  function sendPairRequest(mac) {
    if (!state.mqttConnected) { toast('Connect to broker first'); return; }
    const c = cleanMac(mac);
    state.mqttClient.publish(`lodestone/request/${c}`, JSON.stringify({
      name: state.deviceName, mac: cleanMac(state.myMac), type: 'app',
    }));
    toast('Pair request sent — waiting for acceptance');
  }

  function acceptPair() {
    const req = state.pendingPairFrom;
    if (!req) return;
    document.getElementById('pair-modal').classList.remove('visible');
    const myClean = cleanMac(state.myMac);
    const theirClean = cleanMac(req.mac);
    if (!state.pairedDevices.some(p => cleanMac(p) === theirClean)) {
      state.pairedDevices.push(theirClean);
      savePaired();
    }
    state.mqttClient.subscribe(`lodestone/pair/${myClean}_${theirClean}`);
    state.mqttClient.subscribe(`lodestone/pair/${theirClean}_${myClean}`);
    state.mqttClient.publish(`lodestone/accept/${theirClean}`, JSON.stringify({
      name: state.deviceName, mac: myClean,
    }));
    state.mqttClient.publish(`lodestone/loc/request/${theirClean}`, '1');
    toast(`Paired with ${req.name}`);
    state.pendingPairFrom = null;
    renderDevices();
  }

  function declinePair() {
    document.getElementById('pair-modal').classList.remove('visible');
    state.pendingPairFrom = null;
  }

  function unpairDevice(mac) {
    const c = cleanMac(mac);
    state.pairedDevices = state.pairedDevices.filter(p => cleanMac(p) !== c);
    savePaired();
    if (state.mqttClient) {
      const myClean = cleanMac(state.myMac);
      state.mqttClient.unsubscribe(`lodestone/pair/${myClean}_${c}`);
      state.mqttClient.unsubscribe(`lodestone/pair/${c}_${myClean}`);
    }
    if (deviceMarkers[mac]) { deviceMarkers[mac].remove(); delete deviceMarkers[mac]; }
    toast('Unpaired');
    renderDevices();
  }

  // ── Locations ──────────────────────────────────────────────────────────────
  function showAddForm() {
    document.getElementById('add-form').style.display = 'block';
    document.getElementById('loc-name').focus();
  }
  function hideAddForm() {
    document.getElementById('add-form').style.display = 'none';
    ['loc-name','loc-lat','loc-lon'].forEach(id => document.getElementById(id).value = '');
    state.pendingAddDeviceKey = null;
  }

  function saveLocation() {
    const name = document.getElementById('loc-name').value.trim();
    const lat = parseFloat(document.getElementById('loc-lat').value);
    const lon = parseFloat(document.getElementById('loc-lon').value);
    if (!name) { toast('Enter a name'); return; }
    if (isNaN(lat)||isNaN(lon)) { toast('Enter valid coordinates'); return; }
    const entry = { name: name.slice(0,15).toUpperCase(), lat, lon };
    const devKey = state.pendingAddDeviceKey || '__app__';
    state.pendingAddDeviceKey = null;

    if (devKey === '__app__') {
      if (state.locations.length >= 10) { toast('Max 10 locations'); return; }
      state.locations.push(entry);
      saveLocationsLocal(); updateSavedMarkers();
      hideAddForm(); renderLocations();
      toast(`"${name}" saved`);
    } else if (devKey === '__all__') {
      if (state.locations.length < 10) { state.locations.push(entry); saveLocationsLocal(); updateSavedMarkers(); }
      syncLocationsToDevice();
      hideAddForm(); renderLocations();
      toast(`"${name}" sent to all devices`);
    } else {
      // Specific device
      const c = cleanMac(devKey);
      const existing = (state.deviceLocations[c] || state.deviceLocations[devKey] || {locations:[]}).locations || [];
      const updated = [...existing, entry].slice(0,10);
      if (state.mqttConnected) {
        state.mqttClient.publish('lodestone/locations', JSON.stringify({ mac: c, locations: updated }));
        if (state.deviceLocations[c]) state.deviceLocations[c].locations = updated;
      }
      hideAddForm(); renderLocations();
      const d = state.devices[devKey] || state.devices[c] || {};
      toast(`"${name}" sent to ${d.name || 'device'}`);
    }
  }

  function deleteLocation(i) {
    const name = state.locations[i].name;
    state.locations.splice(i,1);
    saveLocationsLocal(); updateSavedMarkers(); syncLocationsToDevice();
    renderLocations(); toast(`"${name}" deleted`);
  }

  function syncLocationsToDevice() {
    if (!state.mqttConnected) return;
    state.mqttClient.publish('lodestone/locations', JSON.stringify({ mac: state.myMac, locations: state.locations }));
  }

  function selectLocDevice(key) {
    state.selectedLocDevice = key;
    if (key !== '__app__' && state.mqttConnected) {
      state.mqttClient.publish(`lodestone/loc/request/${key}`, '1');
    }
    renderLocations();
  }

  function showOnMap(lat, lon, name) {
    setTab('map', document.querySelector('.tab'));
    setTimeout(() => {
      map.setView([parseFloat(lat), parseFloat(lon)], 16);
      if (searchMarker) searchMarker.remove();
      searchMarker = L.marker([parseFloat(lat), parseFloat(lon)], {icon:makeIcon('amber')})
        .bindPopup(name).addTo(map).openPopup();
    }, 100);
  }

  // ── Map pin — multi-device selector ───────────────────────────────────────
  function addPinnedLocation() {
    if (state.pinLat == null) return;
    showDeviceAddSelector(state.pinLat, state.pinLon);
  }

  function dismissPin() {
    document.getElementById('pin-popup').classList.remove('visible');
    if (pinMarker) { pinMarker.remove(); pinMarker = null; }
    state.pinLat = null; state.pinLon = null;
  }

  function showDeviceAddSelector(lat, lon) {
    const existing = document.getElementById('dev-add-selector');
    if (existing) existing.remove();
    const hwDevices = Object.entries(state.devices).filter(([,d]) => d.isHardware);
    const options = [
      {key:'__app__', label:'Save to app only'},
      ...hwDevices.map(([mac,d]) => ({key:mac, label:d.name||mac})),
      ...(hwDevices.length > 1 ? [{key:'__all__', label:'Add to ALL devices'}] : []),
    ];
    const sel = document.createElement('div');
    sel.id = 'dev-add-selector';
    sel.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1500;display:flex;align-items:flex-end;';
    sel.innerHTML = `
      <div style="width:100%;background:var(--bg1);border-radius:20px 20px 0 0;border-top:1px solid var(--border);padding:16px 16px 28px;">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">Add location to:</div>
        <div style="font-size:11px;color:var(--text2);font-family:var(--font-mono);margin-bottom:14px">${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E</div>
        ${options.map(o => `<button onclick="App.confirmAddToDevice('${o.key}',${lat},${lon})" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:14px;text-align:left;cursor:pointer;font-family:var(--font-ui);margin-bottom:8px;">${o.label}</button>`).join('')}
        <button onclick="document.getElementById('dev-add-selector').remove()" style="width:100%;padding:10px;border-radius:10px;border:none;background:var(--bg3);color:var(--text2);font-size:14px;cursor:pointer;">Cancel</button>
      </div>`;
    document.body.appendChild(sel);
    sel.onclick = e => { if (e.target === sel) sel.remove(); };
  }

  function confirmAddToDevice(deviceKey, lat, lon) {
    document.getElementById('dev-add-selector')?.remove();
    document.getElementById('pin-popup').classList.remove('visible');
    document.getElementById('loc-lat').value = parseFloat(lat).toFixed(6);
    document.getElementById('loc-lon').value = parseFloat(lon).toFixed(6);
    state.pendingAddDeviceKey = deviceKey;
    setTab('locations', document.querySelector('.tab:nth-child(2)'));
    showAddForm();
    document.getElementById('loc-name').focus();
  }

  // ── Render functions ───────────────────────────────────────────────────────
  function renderLocations() {
    const el = document.getElementById('loc-list');
    const devMacs = Object.keys(state.deviceLocations);
    const tabBar = document.getElementById('loc-device-tabs');
    if (tabBar) {
      const tabs = [{key:'__app__', label:'My Notes'}, ...devMacs.map(mac => ({key:mac, label:state.deviceLocations[mac].name||mac.slice(-4)}))];
      tabBar.innerHTML = tabs.map(t => {
        const active = (state.selectedLocDevice||'__app__') === t.key;
        return `<button onclick="App.selectLocDevice('${t.key}')" style="padding:6px 14px;border-radius:20px;border:1px solid ${active?'var(--amber)':'var(--border)'};background:${active?'var(--amber-dim)':'none'};color:${active?'var(--amber)':'var(--text2)'};font-size:11px;cursor:pointer;white-space:nowrap;font-family:var(--font-ui);">${t.label}</button>`;
      }).join('');
    }
    const sel = state.selectedLocDevice;
    if (sel && sel !== '__app__' && state.deviceLocations[sel]) {
      const locs = state.deviceLocations[sel].locations || [];
      el.innerHTML = locs.length === 0
        ? `<div class="empty"><p>No locations on ${state.deviceLocations[sel].name}</p></div>`
        : `<div class="section-label">${state.deviceLocations[sel].name} — ${locs.length} locations</div>`
          + locs.map(loc => `<div class="list-item"><div class="list-icon amber"><svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg></div><div class="item-info"><div class="item-name">${loc.name}</div><div class="item-sub">${parseFloat(loc.lat).toFixed(5)}°, ${parseFloat(loc.lon).toFixed(5)}°</div></div><button onclick="App.showOnMap(${loc.lat},${loc.lon},'${loc.name}')" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text2);padding:5px 8px;cursor:pointer;font-size:11px;">Map</button></div>`).join('');
      return;
    }
    if (state.locations.length === 0) {
      el.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg><p>No locations saved</p><small>Tap + Add or tap anywhere on the map</small></div>`;
      return;
    }
    el.innerHTML = `<div class="section-label">${state.locations.length} / 10 locations</div>`
      + state.locations.map((loc,i) => `<div class="list-item"><div class="list-icon amber"><svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg></div><div class="item-info"><div class="item-name">${loc.name}</div><div class="item-sub">${loc.lat.toFixed(5)}°, ${loc.lon.toFixed(5)}°</div></div><button onclick="App.deleteLocation(${i})" style="background:none;border:none;color:var(--red);padding:8px;cursor:pointer;font-size:18px;line-height:1">×</button></div>`).join('');
  }

  function renderDevices() {
    const el = document.getElementById('device-list');
    const now = Date.now();
    Object.keys(state.devices).forEach(mac => { if (now - state.devices[mac].lastSeen > 30000 && state.devices[mac].lastSeen > 0) delete state.devices[mac]; });
    const hw = Object.entries(state.devices).filter(([,d]) => d.isHardware);
    const app = Object.entries(state.devices).filter(([,d]) => !d.isHardware);
    if (!hw.length && !app.length) {
      el.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg><p>No devices discovered</p><small>Connect to MQTT broker to see other Lodestones</small></div>`;
      return;
    }
    const row = ([mac, d]) => {
      const paired = isPaired(mac);
      const age = Math.round((Date.now()-d.lastSeen)/1000);
      const dist = (d.lat && state.myLat) ? formatDist(haversine(state.myLat,state.myLon,d.lat,d.lon)) : 'tap to pair';
      const icon = d.isHardware
        ? `<svg viewBox="0 0 24 24" style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>`
        : `<svg viewBox="0 0 24 24" style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round"><rect x="5" y="2" width="14" height="20" rx="2"/></svg>`;
      return `<div class="list-item">
        <div class="list-icon ${paired?'green':d.isHardware?'amber':'blue'}" onclick="App.sendPairRequest('${mac}')">${icon}</div>
        <div class="item-info" onclick="App.sendPairRequest('${mac}')">
          <div class="item-name">${d.name}</div>
          <div class="item-sub">${dist}${d.lastSeen>0?' · '+age+'s ago':''}</div>
        </div>
        ${paired
          ? `<button onclick="App.unpairDevice('${mac}')" style="background:none;border:1px solid var(--red);border-radius:6px;color:var(--red);padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap">Unpair</button>`
          : `<span class="item-badge badge-off" onclick="App.sendPairRequest('${mac}')">TAP TO PAIR</span>`}
      </div>`;
    };
    let html = '';
    if (hw.length) { html += `<div class="section-label">Lodestone Devices (${hw.length})</div>`; html += hw.map(row).join(''); }
    if (app.length) { html += `<div class="section-label">App Users (${app.length})</div>`; html += app.map(row).join(''); }
    el.innerHTML = html;
  }

  function renderConnectScreen() {
    const el = document.getElementById('my-coords');
    if (el) el.textContent = state.myLat!=null ? `${state.myLat.toFixed(5)}°N  ${state.myLon.toFixed(5)}°E` : '—';
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  function showMessageNotification(from, msg) {
    const n = document.createElement('div');
    n.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:var(--bg2);border:1px solid var(--amber);border-radius:10px;padding:10px 16px;z-index:800;max-width:300px;width:90%;cursor:pointer;';
    n.innerHTML = `<div style="font-size:11px;color:var(--amber);font-weight:600">${from}</div><div style="font-size:13px;color:var(--text)">${msg}</div>`;
    n.onclick = () => { n.remove(); setTab('messages', document.querySelector('.tab:nth-child(5)')); };
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 4000);
  }

  function renderMessages() {
    renderMsgRecipientBar();
    const el = document.getElementById('msg-list');
    if (!el) return;
    if (!state.messages || !state.messages.length) {
      el.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><p>No messages yet</p><small>Messages from Lodestone devices appear here</small></div>`;
      return;
    }
    el.innerHTML = state.messages.map(m => {
      const t = new Date(m.time);
      const timeStr = t.getHours().toString().padStart(2,'0')+':'+t.getMinutes().toString().padStart(2,'0');
      const toLabel = m.to && m.to!=='Everyone' ? ` → ${m.to}` : '';
      return `<div class="list-item" style="flex-direction:column;align-items:flex-start;gap:4px"><div style="display:flex;width:100%;justify-content:space-between"><span style="font-size:12px;font-weight:600;color:var(--amber)">${m.from}${toLabel}</span><span style="font-size:11px;color:var(--text3)">${timeStr}</span></div><div style="font-size:14px;color:var(--text)">${m.msg}</div></div>`;
    }).join('');
  }

  function renderMsgRecipientBar() {
    const bar = document.getElementById('msg-recipient-bar');
    if (!bar) return;
    const options = [
      {mac:'broadcast', label:'Everyone'},
      ...state.pairedDevices.map(mac => {
        const d = state.devices[mac] || state.devices[cleanMac(mac)] || {};
        return {mac, label: d.name || mac.slice(-4)};
      }),
      ...Object.entries(state.devices).filter(([,d])=>!d.isHardware && isPaired(_=>false)).map(([mac,d])=>({mac,label:d.name||mac.slice(-4)})),
    ];
    const selClean = cleanMac(state.msgRecipient);
    bar.innerHTML = options.map(o => {
      const active = o.mac==='broadcast' ? state.msgRecipient==='broadcast' : cleanMac(o.mac)===selClean;
      return `<button onclick="App.setMsgRecipient('${o.mac}')" style="padding:5px 12px;border-radius:20px;border:1px solid ${active?'var(--amber)':'var(--border)'};background:${active?'var(--amber-dim)':'none'};color:${active?'var(--amber)':'var(--text2)'};font-size:11px;cursor:pointer;white-space:nowrap;font-family:var(--font-ui);">${o.label}</button>`;
    }).join('');
  }

  function setMsgRecipient(mac) { state.msgRecipient = mac; renderMsgRecipientBar(); }

  function sendMessage() {
    const input = document.getElementById('msg-input');
    const msg = (input.value||'').trim();
    if (!msg) return;
    if (!state.mqttConnected) { toast('Connect to broker first'); return; }
    const myClean = cleanMac(state.myMac);
    const payload = JSON.stringify({ from: state.deviceName, mac: myClean, msg });
    const recipient = state.msgRecipient || 'broadcast';
    let toName = 'Everyone';
    if (recipient === 'broadcast') {
      state.mqttClient.publish('lodestone/msg/broadcast', payload);
      state.pairedDevices.forEach(mac => state.mqttClient.publish(`lodestone/msg/${cleanMac(mac)}`, payload));
    } else {
      const c = cleanMac(recipient);
      state.mqttClient.publish(`lodestone/msg/${c}`, payload);
      const d = state.devices[recipient] || state.devices[c] || {};
      toName = d.name || c.slice(-4);
    }
    if (!state.messages) state.messages = [];
    state.messages.unshift({ from:'Me', msg, to:toName, time:Date.now() });
    input.value = '';
    renderMessages();
    toast('Sent to ' + toName);
  }

  // ── Map search ─────────────────────────────────────────────────────────────
  async function searchMap() {
    const q = document.getElementById('map-search-input').value.trim();
    if (!q) return;
    const resultsEl = document.getElementById('map-search-results');
    resultsEl.innerHTML = '<div class="map-search-result">Searching...</div>';
    resultsEl.style.display = 'block';
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=4`, {headers:{'Accept-Language':'en'}});
      const data = await res.json();
      if (!data.length) { resultsEl.innerHTML = '<div class="map-search-result">No results found</div>'; return; }
      resultsEl.innerHTML = data.map(r => `<div class="map-search-result" onclick="App.selectSearchResult(${r.lat},${r.lon},'${r.display_name.replace(/'/g,"\\'")}')"><b>${r.display_name.split(',').slice(0,2).join(',')}</b><small>${r.display_name.split(',').slice(2,4).join(',')}</small></div>`).join('');
    } catch(e) { resultsEl.innerHTML = '<div class="map-search-result">Search failed</div>'; }
  }

  function selectSearchResult(lat, lon, name) {
    document.getElementById('map-search-results').style.display = 'none';
    document.getElementById('map-search-input').value = name.split(',').slice(0,2).join(',');
    const pos = [parseFloat(lat), parseFloat(lon)];
    map.setView(pos, 15);
    if (searchMarker) searchMarker.remove();
    searchMarker = L.marker(pos, {icon:makeIcon('blue')}).bindPopup(name.split(',').slice(0,2).join(',')).addTo(map).openPopup();
    state.pinLat = parseFloat(lat); state.pinLon = parseFloat(lon);
    document.getElementById('pin-coord').textContent = `${parseFloat(lat).toFixed(5)}° N,  ${parseFloat(lon).toFixed(5)}° E`;
    document.getElementById('pin-popup').classList.add('visible');
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  function setTab(name, btn) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('screen-'+name).classList.add('active');
    if (btn) btn.classList.add('active');
    state.tab = name;
    if (name==='map') setTimeout(() => map && map.invalidateSize(), 50);
    if (name==='locations') renderLocations();
    if (name==='devices') renderDevices();
    if (name==='connect') renderConnectScreen();
    if (name==='messages') renderMessages();
  }

  // ── Utils ──────────────────────────────────────────────────────────────────
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }
  function haversine(lat1,lon1,lat2,lon2) {
    const R=6371000,r=Math.PI/180,dLat=(lat2-lat1)*r,dLon=(lon2-lon1)*r;
    const a=Math.sin(dLat/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLon/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  function formatDist(m) { return m>=1000?(m/1000).toFixed(1)+'km':Math.round(m)+'m'; }

  function startAnnounceLoop() {
    setInterval(() => { if (state.mqttConnected) { announcePresence(); broadcastPosition(); } renderDevices(); }, 5000);
  }

  // ── Username prompt ────────────────────────────────────────────────────────
  function showUsernamePrompt() {
    const overlay = document.createElement('div');
    overlay.id = 'username-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg0);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;gap:20px;';
    overlay.innerHTML = `
      <div style="font-size:28px;font-weight:700;color:var(--amber);font-family:var(--font-mono);letter-spacing:.1em">LODESTONE</div>
      <div style="font-size:14px;color:var(--text2);text-align:center;line-height:1.7;max-width:280px">Enter your name.<br>This identifies you to other Lodestone users.</div>
      <input id="un-input" type="text" maxlength="15" placeholder="e.g. Ravi" autocomplete="off" autocorrect="off" spellcheck="false"
        style="width:100%;max-width:280px;background:var(--bg2);border:2px solid var(--amber);border-radius:10px;padding:13px 16px;font-size:16px;color:var(--text);outline:none;text-align:center;font-family:var(--font-ui);">
      <button id="un-btn" style="width:100%;max-width:280px;padding:13px;border-radius:10px;border:none;background:var(--amber);color:#000;font-size:15px;font-weight:700;cursor:pointer;">Continue</button>
      <div style="font-size:11px;color:var(--text3)">You can change this later in the Connect tab</div>
    `;
    document.body.appendChild(overlay);
    function submitName() {
      const val = (document.getElementById('un-input').value||'').trim();
      if (!val) { toast('Please enter your name'); return; }
      const name = val.slice(0,15);
      state.deviceName = name;
      localStorage.setItem('lode_username', name);
      try { document.getElementById('cfg-name').value = name; } catch(e) {}
      loadPaired();
      overlay.remove();
      if (state.mqttConnected) announcePresence();
      toast('Welcome, ' + name + '!');
    }
    setTimeout(() => {
      document.getElementById('un-btn').onclick = submitName;
      document.getElementById('un-input').addEventListener('keydown', e => { if(e.key==='Enter') submitName(); });
      document.getElementById('un-input').focus();
    }, 50);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    loadLocationsLocal();
    loadConfig();
    initMap();
    updateSavedMarkers();
    startAnnounceLoop();

    const storedName = localStorage.getItem('lode_username');
    if (!storedName) {
      showUsernamePrompt();
    } else {
      state.deviceName = storedName;
      try { document.getElementById('cfg-name').value = storedName; } catch(e) {}
      loadPaired();
    }

    // Config auto-save
    ['cfg-host','cfg-port','cfg-user','cfg-pass','cfg-name'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => {
        try {
          localStorage.setItem('lode_cfg', JSON.stringify({
            host: document.getElementById('cfg-host').value,
            port: document.getElementById('cfg-port').value,
            user: document.getElementById('cfg-user').value,
            pass: document.getElementById('cfg-pass').value,
            name: document.getElementById('cfg-name').value,
          }));
        } catch(e) {}
        if (id === 'cfg-name') {
          const v = document.getElementById('cfg-name').value.trim();
          if (v) { state.deviceName = v; localStorage.setItem('lode_username', v); loadPaired(); }
        }
      });
    });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
    renderLocations();
    renderDevices();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    setTab, toggleGps, toggleMqtt, connectMqtt, disconnectMqtt,
    showAddForm, hideAddForm, saveLocation, deleteLocation,
    addPinnedLocation, dismissPin, showDeviceAddSelector, confirmAddToDevice,
    acceptPair, declinePair, sendPairRequest, unpairDevice,
    searchMap, selectSearchResult,
    renderMessages, sendMessage, setMsgRecipient, renderMsgRecipientBar,
    selectLocDevice, showOnMap,
  };

})();
