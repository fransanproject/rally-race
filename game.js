/* ============================================================
 * Rally Race — carreras vista cenital, online hasta 6 jugadores.
 *
 * Online: SIN Supabase. La sala la lleva el ANFITRION en su propio
 * movil (WebRTC con PeerJS): mantiene la lista, reparte el inicio
 * y retransmite los eventos. Cada cliente simula su propio coche; las
 * posiciones se emiten a ~10 Hz y los rivales se interpolan.
 * Los obstáculos son DETERMINISTAS: se generan con una semilla
 * (código de sala + nº de carrera) idéntica en todos los móviles,
 * así todos ven lo mismo sin sincronizar nada.
 * ============================================================ */
(function () {
'use strict';

var PROTO_V = 8;
var MAX_PLAYERS = 6;
var LAPS = 3;

/* ---------------- utilidades ---------------- */
function $(id) { return document.getElementById(id); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function randId() { return 'p' + Math.random().toString(36).slice(2, 10); }
function normAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function el(tag, text, cls) {
  var d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined && text !== null) d.textContent = text;
  return d;
}
/* RNG determinista (mulberry32) para obstáculos/árboles idénticos en todos los clientes */
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function fmtTime(ms) {
  if (ms == null) return '';
  var t = Math.max(0, ms);
  var m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), d = Math.floor((t % 1000) / 100);
  return m + ':' + (s < 10 ? '0' : '') + s + '.' + d;
}
function toast(msg, ms) {
  var t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._tm);
  t._tm = setTimeout(function () { t.classList.add('hidden'); }, ms || 2500);
}

var PALETTE = ['#e63946', '#2a9d8f', '#e9c46a', '#4361ee', '#f3722c', '#9d4edd'];
var TRACK_NAMES = ['El Revirado', 'Curvas del Infierno', 'La Herradura'];

/* ---------------- estado ---------------- */
var S = {
  screen: 'home',
  name: '', color: PALETTE[0], playerId: randId(), joinedAt: Date.now(),
  roomCode: '', local: false, raceNoSeen: 0,
  isHost: false, players: [],           // presence
  race: null,          // datos de la carrera en curso
  me: null,            // mi coche
  remotes: {},         // id -> estado rival
  finishes: {},        // id -> tiempo ms
  firstFinishAt: 0,
  resultsShown: false,
  input: { steer: 0, brake: false },
  demo: false
};

function showScreen(name) {
  S.screen = name;
  ['home', 'lobby', 'waiting', 'game'].forEach(function (s) {
    $('screen-' + s).classList.toggle('hidden', s !== name);
  });
}

/* ---------------- red: salas PeerJS gestionadas por el ANFITRION ----------------
 * Sin Supabase: no hay proyecto, ni clave, ni canal que se pueda pausar.
 * Quien crea la sala es el servidor de la partida en su propio movil:
 * mantiene la lista de jugadores (roster), reparte el inicio y
 * retransmite los eventos. Los demas moviles se conectan DIRECTAMENTE
 * al suyo por WebRTC (PeerJS). El unico servicio externo es el punto
 * de encuentro publico y gratuito de PeerJS (0.peerjs.com), que solo
 * pone en contacto a los moviles al entrar: no guarda partidas, no
 * necesita cuenta ni proyecto, y durante la partida los datos van de
 * movil a movil sin pasar por ningun servidor.
 * Codigo de sala: 4 cifras. El id del anfitrion en PeerJS es
 * 'rally-race-XXXX' (el codigo); el invitado usa un id aleatorio.
 * ------------------------------------------------------------------ */
var NET = {
  peer: null, conns: {}, hostConn: null, myPeerId: null,
  amHost: false, connected: false, joining: false, leaving: false,
  retries: 0, retryTimer: null, watchdog: null,
  raceAcks: {}, lastError: ''
};
var MAX_RETRIES = 5;
function hostPeerId(code) { return 'rally-race-' + String(code); }
function makeRoomCode() {
  var c = '';
  for (var i = 0; i < 4; i++) c += Math.floor(Math.random() * 10);
  return c;
}
var peerFallbackTried = false;
function ensurePeer(cb) {
  var done = false;
  function finish(ok) { if (done) return; done = true; cb(ok); }
  if (window.Peer) { finish(true); return; }
  if (!peerFallbackTried) {
    peerFallbackTried = true;
    try {
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/peerjs@1/dist/peerjs.min.js';
      s.onload = function () { ensurePeer(finish); };
      s.onerror = function () { ensurePeer(finish); };
      document.head.appendChild(s);
    } catch (e) {}
  }
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (window.Peer) { clearInterval(iv); finish(true); }
    else if (tries >= 40) { clearInterval(iv); finish(false); }
  }, 200);
}
function lobbyError(msg) {
  var e = $('lobby-error');
  if (e) e.textContent = msg || '';
  var b = $('btn-retry-conn');
  if (b) b.classList.toggle('hidden', !msg);
}
function send(type, payload) {
  if (S.local) return;
  var msg = { type: type, payload: payload || {} };
  if (NET.amHost) { netBroadcast(msg, null); }
  else if (NET.hostConn && NET.hostConn.open) { try { NET.hostConn.send(msg); } catch (e) {} }
}
function netBroadcast(msg, exceptPeerId) {
  Object.keys(NET.conns).forEach(function (pid) {
    if (pid === exceptPeerId) return;
    var c = NET.conns[pid];
    if (c && c.open) { try { c.send(msg); } catch (e) {} }
  });
}
function netSendTo(peerId, msg) {
  var c = NET.conns[peerId];
  if (c && c.open) { try { c.send(msg); } catch (e) {} }
}
function teardownPeer() {
  Object.keys(NET.conns).forEach(function (pid) { try { NET.conns[pid].close(); } catch (e) {} });
  NET.conns = {};
  if (NET.hostConn) { try { NET.hostConn.close(); } catch (e) {} NET.hostConn = null; }
  if (NET.peer) { try { NET.peer.destroy(); } catch (e) {} NET.peer = null; }
  NET.connected = false;
}
function rosterEntry(p) {
  return { id: p.id, name: p.name, color: p.color, joinedAt: p.joinedAt || 0, v: p.v || 0, st: p.st || 'lobby' };
}
function hostBroadcastRoster() {
  if (!NET.amHost) return;
  netBroadcast({ type: 'roster', payload: { players: S.players.map(rosterEntry) } }, null);
}
function sendStatus(st) {
  if (S.local) return;
  if (NET.amHost) {
    S.players.forEach(function (p) { if (p.id === NET.myPeerId) p.st = st; });
    hostBroadcastRoster();
    if (S.screen === 'lobby') renderLobby();
  } else {
    send('status', { st: st });
  }
}
function applyRoster(list) {
  if (!list || !list.length) return;
  S.players = list.slice(0, MAX_PLAYERS).map(rosterEntry);
  S.isHost = S.players.length > 0 && S.players[0].id === NET.myPeerId;
  var racing = S.players.some(function (p) { return p.st === 'racing' && p.id !== NET.myPeerId; });
  if (S.screen === 'lobby' && racing && !S.race) {
    showScreen('waiting');
  } else if (S.screen === 'waiting' && !racing && !S.race) {
    showScreen('lobby'); renderLobby();
  }
  if (S.screen === 'lobby') renderLobby();
  if (S.screen === 'game' && S.race) {
    var ids = {};
    S.players.forEach(function (p) { ids[p.id] = true; });
    Object.keys(S.remotes).forEach(function (id) { if (!ids[id]) delete S.remotes[id]; });
  }
}
function renderSelfOnly() {
  S.players = [{ id: NET.myPeerId || S.playerId, name: S.name, color: S.color, joinedAt: S.joinedAt, v: PROTO_V, st: 'lobby' }];
  S.isHost = NET.amHost;
  showScreen('lobby');
  renderLobby();
  var note = $('lobby-note');
  if (note) note.textContent = NET.amHost ? 'Creando tu sala...' : 'Conectando con la sala...';
}
function scheduleRetry() {
  if (NET.leaving || !S.roomCode || NET.retryTimer) return;
  NET.retries++;
  if (NET.retries > MAX_RETRIES) {
    NET.joining = false;
    lobbyError('No se ha podido conectar con la sala tras ' + MAX_RETRIES + ' intentos (ultimo aviso: ' + (NET.lastError || 'sin respuesta') + '). Revisa tu conexion. Si abriste el juego desde dentro de WhatsApp, abrelo en Safari/Chrome.');
    return;
  }
  var note = $('lobby-note');
  if (note) note.textContent = 'Conectando... intento ' + (NET.retries + 1) + ' de ' + (MAX_RETRIES + 1) + '.';
  var code = S.roomCode, host = NET.amHost;
  NET.retryTimer = setTimeout(function () {
    NET.retryTimer = null;
    joinRoom(code, host, true);
  }, Math.min(1500 * NET.retries, 6000));
}
function joinRoom(code, asHost, isRetry) {
  if (NET.joining) return;
  NET.joining = true; NET.leaving = false;
  if (!isRetry) { NET.retries = 0; $('home-error').textContent = ''; }
  if (NET.retryTimer) { clearTimeout(NET.retryTimer); NET.retryTimer = null; }
  if (NET.watchdog) { clearTimeout(NET.watchdog); NET.watchdog = null; }
  lobbyError('');
  $('lobby-code').textContent = code;
  showScreen('lobby');
  renderSelfOnly();
  ensurePeer(function (ok) {
    if (!ok) {
      NET.joining = false;
      $('home-error').textContent = 'No se pudo cargar la libreria de red. Revisa tu conexion.';
      showScreen('home');
      return;
    }
    if (NET.leaving) { NET.joining = false; return; }
    teardownPeer();
    S.roomCode = code; NET.amHost = asHost; NET.connected = false;
    if (!isRetry) { S.raceNoSeen = 0; }
    NET.raceAcks = {};
    S.players = [];
    lobbyError('');
    showScreen('lobby');
    renderSelfOnly();
    if (asHost) createHostPeer(code);
    else createGuestPeer(code);
  });
}
function createHostPeer(code) {
  var peer;
  try { peer = new window.Peer(hostPeerId(code)); }
  catch (e) { NET.joining = false; scheduleRetry(); return; }
  NET.peer = peer;
  peer.on('open', function (id) {
    if (peer !== NET.peer) return;
    NET.myPeerId = id; S.playerId = id;
    NET.connected = true; NET.joining = false; NET.retries = 0;
    S.players = [{ id: id, name: S.name, color: S.color, joinedAt: S.joinedAt, v: PROTO_V, st: 'lobby' }];
    S.isHost = true;
    applyRoster(S.players);
    var note = $('lobby-host-note');
    if (note) note.textContent = 'Tu movil hace de servidor de esta sala: dejalo con el juego abierto mientras jugais.';
  });
  peer.on('connection', function (conn) {
    if (peer !== NET.peer) return;
    if (conn.open) hostOnConnection(conn);
    else conn.on('open', function () { if (peer === NET.peer) hostOnConnection(conn); });
  });
  peer.on('error', function (err) {
    if (peer !== NET.peer) return;
    var type = (err && err.type) || '';
    NET.lastError = type || 'error de red';
    if (type === 'unavailable-id') {
      var newCode = makeRoomCode();
      S.roomCode = newCode;
      $('lobby-code').textContent = newCode;
      teardownPeer();
      createHostPeer(newCode);
      return;
    }
    NET.joining = false; NET.connected = false;
    scheduleRetry();
  });
  peer.on('disconnected', function () {
    if (peer !== NET.peer) return;
    try { peer.reconnect(); } catch (e) {}
  });
}
function hostAddGuest(peerId, info) {
  if (S.players.some(function (e) { return e.id === peerId; })) return true;
  if (S.players.length >= MAX_PLAYERS) return false;
  S.players.push({ id: peerId, name: (info && info.name) || '¿?', color: (info && info.color) || '#888', joinedAt: (info && info.joinedAt) || Date.now(), v: (info && info.v) || 0, st: 'lobby' });
  return true;
}
function hostRemoveGuest(peerId) {
  if (!NET.amHost) return;
  delete NET.conns[peerId];
  var before = S.players.length;
  S.players = S.players.filter(function (e) { return e.id !== peerId; });
  if (S.players.length !== before) {
    applyRoster(S.players);
    hostBroadcastRoster();
  }
}
function hostOnConnection(conn) {
  NET.conns[conn.peer] = conn;
  conn.on('data', function (msg) {
    if (!msg || !msg.type) return;
    var p = msg.payload || {};
    if (msg.type === 'join') {
      if (!hostAddGuest(conn.peer, p)) {
        try { conn.send({ type: 'full', payload: {} }); } catch (e) {}
        setTimeout(function () { try { conn.close(); } catch (e) {} }, 600);
        return;
      }
      try { conn.send({ type: 'welcome', payload: { you: conn.peer } }); } catch (e) {}
      applyRoster(S.players);
      hostBroadcastRoster();
      netSendTo(conn.peer, { type: 'roster', payload: { players: S.players.map(rosterEntry) } });
      if (S.race) netSendTo(conn.peer, { type: 'race_state', payload: { cfg: S.race.cfg } });
    } else if (msg.type === 'status') {
      S.players.forEach(function (e) { if (e.id === conn.peer) e.st = p.st || 'lobby'; });
      hostBroadcastRoster();
    } else if (msg.type === 'player_state') {
      applyPlayerState(p);
      netBroadcast({ type: 'player_state', payload: p }, conn.peer);
    } else if (msg.type === 'player_finished') {
      applyPlayerFinished(p);
      netBroadcast({ type: 'player_finished', payload: p }, conn.peer);
    } else if (msg.type === 'race_ack') {
      NET.raceAcks[conn.peer] = p.raceNo;
    }
  });
  conn.on('close', function () { hostRemoveGuest(conn.peer); });
  if (conn.on) conn.on('error', function () { hostRemoveGuest(conn.peer); });
}
function createGuestPeer(code) {
  var peer;
  try { peer = new window.Peer(); }
  catch (e) { NET.joining = false; scheduleRetry(); return; }
  NET.peer = peer;
  peer.on('open', function (id) {
    if (peer !== NET.peer) return;
    NET.myPeerId = id; S.playerId = id;
    var conn;
    try { conn = peer.connect(hostPeerId(code), { reliable: true }); }
    catch (e) { NET.joining = false; scheduleRetry(); return; }
    NET.hostConn = conn;
    if (NET.watchdog) clearTimeout(NET.watchdog);
    NET.watchdog = setTimeout(function () {
      NET.watchdog = null;
      if (!S.roomCode || NET.amHost || NET.connected) return;
      NET.joining = false;
      lobbyError('No se encuentra ninguna sala con el codigo ' + S.roomCode + '. Comprueba que el anfitrion la ha creado ya (su movil hace de servidor: tiene que tener el juego abierto en la sala) y que el codigo coincide.');
    }, 10000);
    conn.on('open', function () {
      if (peer !== NET.peer) return;
      NET.connected = true; NET.joining = false; NET.retries = 0;
      lobbyError('');
      try { conn.send({ type: 'join', payload: { name: S.name, color: S.color, joinedAt: S.joinedAt, v: PROTO_V } }); } catch (e) {}
      var note = $('lobby-note');
      if (note) note.textContent = 'Conectado con el anfitrion. Esperando la lista de jugadores...';
    });
    conn.on('data', function (msg) { if (peer === NET.peer) guestOnData(msg); });
    conn.on('close', function () {
      if (peer !== NET.peer || NET.leaving) return;
      NET.connected = false;
      lobbyError('Se ha cortado la conexion con el anfitrion (si cierra el juego, la sala se cierra). Reintentando...');
      scheduleRetry();
    });
    if (conn.on) conn.on('error', function () {
      if (peer !== NET.peer || NET.leaving) return;
      NET.connected = false; scheduleRetry();
    });
  });
  peer.on('error', function (err) {
    if (peer !== NET.peer) return;
    var type = (err && err.type) || '';
    NET.lastError = type || 'error de red';
    if (type === 'peer-unavailable') {
      if (NET.watchdog) { clearTimeout(NET.watchdog); NET.watchdog = null; }
      NET.joining = false;
      lobbyError('No se encuentra ninguna sala con el codigo ' + S.roomCode + '. Comprueba que el anfitrion la ha creado ya (su movil hace de servidor: tiene que tener el juego abierto en la sala) y que el codigo coincide.');
      return;
    }
    NET.joining = false; NET.connected = false;
    scheduleRetry();
  });
  peer.on('disconnected', function () {
    if (peer !== NET.peer) return;
    try { peer.reconnect(); } catch (e) {}
  });
}
function guestOnData(msg) {
  if (!msg || !msg.type) return;
  var p = msg.payload || {};
  if (msg.type === 'roster') {
    if (NET.watchdog) { clearTimeout(NET.watchdog); NET.watchdog = null; }
    applyRoster(p.players || []);
  } else if (msg.type === 'race_start') {
    onRaceStart(p);
  } else if (msg.type === 'race_state') {
    if (p.cfg && !S.race) onRaceStart(p.cfg);
  } else if (msg.type === 'player_state') {
    applyPlayerState(p);
  } else if (msg.type === 'player_finished') {
    applyPlayerFinished(p);
  } else if (msg.type === 'full') {
    NET.leaving = true;
    lobbyError('Esta sala ya esta llena: hay ' + MAX_PLAYERS + ' jugadores dentro. Que el anfitrion cree otra sala con otro codigo.');
    teardownPeer(); NET.connected = false;
  }
}
function leaveRoom(silent) {
  if (NET.retryTimer) { clearTimeout(NET.retryTimer); NET.retryTimer = null; }
  if (NET.watchdog) { clearTimeout(NET.watchdog); NET.watchdog = null; }
  teardownPeer();
  NET.amHost = false; NET.connected = false; NET.joining = false; NET.leaving = false;
  S.race = null; S.me = null; S.remotes = {};
  S.finishes = {}; S.firstFinishAt = 0; S.resultsShown = false;
  S.isHost = false; S.local = false; S.players = []; S.roomCode = '';
  S.raceNoSeen = 0;
  stopRaceLoop();
  if (!silent) { showScreen('home'); }
}
function hostStart() {
  if (!NET.amHost || !NET.connected) return;
  if (S.players.length < 2) { toast('Hacen falta al menos 2 jugadores en la sala para empezar.'); return; }
  var roster = S.players.slice(0, MAX_PLAYERS).map(function (p) {
    return { id: p.id, name: p.name, color: p.color };
  });
  var cfg = {
    seed: (Math.random() * 1e9) | 0,
    track: (Math.random() * TRACK_NAMES.length) | 0,
    laps: LAPS,
    raceNo: (S.race ? S.race.raceNo : 0) + 1,
    startAt: Date.now() + 3500,
    roster: roster,
    by: NET.myPeerId
  };
  NET.raceAcks = {};
  send('race_start', cfg);
  startRace(cfg);
  setTimeout(function () { send('race_start', cfg); }, 1200);
  setTimeout(function () { send('race_start', cfg); }, 3000);
  setTimeout(function () {
    if (!S.race || S.race.raceNo !== cfg.raceNo) return;
    roster.forEach(function (r) {
      if (r.id === NET.myPeerId) return;
      if (NET.raceAcks[r.id] !== cfg.raceNo) netSendTo(r.id, { type: 'race_start', payload: cfg });
    });
  }, 2500);
}
function onRaceStart(payload) {
  if (!payload || !payload.raceNo) return;
  if (S.race && S.race.raceNo === payload.raceNo) return;
  if (S.raceNoSeen && payload.raceNo <= S.raceNoSeen && S.screen === 'game') return;
  S.raceNoSeen = payload.raceNo;
  if (!NET.amHost) send('race_ack', { raceNo: payload.raceNo });
  startRace(payload);
}

/* ---------------- portada ---------------- */
function initHome() {
  try {
    S.name = localStorage.getItem('rally_name') || '';
    S.color = localStorage.getItem('rally_color') || PALETTE[0];
  } catch (e) {}
  $('input-name').value = S.name;
  var row = $('color-row'); row.innerHTML = '';
  PALETTE.forEach(function (c) {
    var d = el('div', null, 'swatch' + (c === S.color ? ' sel' : ''));
    d.style.background = c;
    d.addEventListener('click', function () {
      S.color = c;
      try { localStorage.setItem('rally_color', c); } catch (e) {}
      Array.prototype.forEach.call(row.children, function (x) { x.classList.remove('sel'); });
      d.classList.add('sel');
    });
    row.appendChild(d);
  });
  $('input-name').addEventListener('change', function () {
    S.name = $('input-name').value.trim().slice(0, 12);
    try { localStorage.setItem('rally_name', S.name); } catch (e) {}
  });
  $('btn-create').addEventListener('click', function () {
    if (!readName()) return;
    S.local = false;
    joinRoom(makeRoomCode(), true);
  });
  $('btn-join').addEventListener('click', function () {
    if (!readName()) return;
    var code = $('input-code').value.replace(/[^0-9]/g, '').slice(0, 4);
    if (code.length !== 4) { $('home-error').textContent = 'Escribe el código de 4 cifras.'; return; }
    S.local = false;
    joinRoom(code, false);
  });
  $('btn-solo').addEventListener('click', function () {
    if (!readName()) return;
    startSolo();
  });
  // ?demo=1 -> arranque automático con piloto automático (verificación)
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('demo') === '1') {
      S.demo = true; S.name = 'Demo'; S.local = true;
      startSolo();
    }
  } catch (e) {}
}
function readName() {
  S.name = $('input-name').value.trim().slice(0, 12);
  if (!S.name) { $('home-error').textContent = 'Escribe tu nombre primero.'; return false; }
  try { localStorage.setItem('rally_name', S.name); } catch (e) {}
  $('home-error').textContent = '';
  return true;
}

/* ---------------- sala de espera ---------------- */
function renderLobby() {
  $('lobby-code').textContent = S.roomCode || '····';
  var ul = $('lobby-players'); ul.innerHTML = '';
  S.players.forEach(function (p) {
    var li = el('li');
    var dot = el('span', null, 'dot'); dot.style.background = p.color;
    li.appendChild(dot);
    li.appendChild(el('span', (p.id === S.playerId ? p.name + ' (tú)' : p.name) + (S.players.length && p.id === S.players[0].id ? ' 👑' : '')));
    if (p.v !== PROTO_V && p.v !== 0) li.appendChild(el('span', '⚠️ versión antigua', 'old'));
    ul.appendChild(li);
  });
  $('lobby-count').textContent = S.players.length + '/' + MAX_PLAYERS + ' jugadores';
  if (S.players.length < 2) $('lobby-note').textContent = 'Comparte el código: hacen falta al menos 2 jugadores para empezar';
  else if (S.players.length >= MAX_PLAYERS) $('lobby-note').textContent = 'Sala llena';
  else $('lobby-note').textContent = S.isHost ? '¡Listos! Pulsa EMPEZAR CARRERA' : 'Esperando a que el anfitrión empiece…';
  $('btn-start').classList.toggle('hidden', !S.isHost);
  var hn = $('lobby-host-note');
  if (hn) hn.textContent = S.isHost ? 'Tu movil hace de servidor de esta sala: dejalo con el juego abierto mientras jugais.' : '';
}
function initLobby() {
  $('btn-copy').addEventListener('click', function () {
    var code = $('lobby-code').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(function () { toast('Código copiado: ' + code); });
    else toast('Código: ' + code, 4000);
  });
  $('btn-leave-lobby').addEventListener('click', function () { leaveRoom(); });
  $('btn-leave-waiting').addEventListener('click', function () { leaveRoom(); });
  $('btn-start').addEventListener('click', function () { hostStart(); });
  $('btn-retry-conn').addEventListener('click', function () {
    if (!S.roomCode) return;
    lobbyError('');
    NET.retries = 0;
    joinRoom(S.roomCode, NET.amHost, true);
  });
}
/* solo local */
function startSolo() {
  S.local = true; S.roomCode = '';
  startRace({
    seed: (Math.random() * 1e9) | 0,
    track: (Math.random() * TRACK_NAMES.length) | 0,
    laps: LAPS,
    raceNo: 1,
    startAt: Date.now() + 3000,
    roster: [{ id: S.playerId, name: S.name, color: S.color }],
    by: S.playerId
  });
}

/* ============================================================
 * PARTE 2 — pistas, generación determinista y física
 * ============================================================ */

/* Pistas: puntos de control (circuito cerrado). Se suavizan con
 * Catmull-Rom y se remuestrean a paso constante. */
var TRACK_DEFS = [
  {
    name: 'El Revirado', roadHalf: 72,
    pts: [[500,400],[950,280],[1450,300],[1800,500],[1850,850],[1650,1150],[1250,1080],[1050,1300],[650,1350],[350,1150],[280,750]]
  },
  {
    name: 'Curvas del Infierno', roadHalf: 68,
    pts: [[400,500],[700,300],[1100,320],[1300,550],[1600,500],[1850,700],[1700,1000],[1350,950],[1150,1200],[750,1250],[500,1000],[300,800]]
  },
  {
    name: 'La Herradura', roadHalf: 76,
    pts: [[600,350],[1200,280],[1700,400],[1750,750],[1400,800],[1450,1100],[1000,1150],[950,850],[600,900],[400,700]]
  }
];

function catmullClosed(pts, per) {
  var out = [], n = pts.length, i, j, t, t2, t3;
  for (i = 0; i < n; i++) {
    var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (j = 0; j < per; j++) {
      t = j / per; t2 = t * t; t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
      ]);
    }
  }
  return out;
}
/* Remuestrea la polilínea a paso ~constante (progreso uniforme por índice) */
function resample(pts, step) {
  var out = [pts[0].slice()], acc = 0, i;
  for (i = 1; i <= pts.length; i++) {
    var a = pts[i - 1], b = pts[i % pts.length];
    var dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
    acc += d;
    while (acc >= step) {
      var t = 1 - (acc - step) / d;
      out.push([a[0] + dx * t, a[1] + dy * t]);
      acc -= step;
    }
  }
  return out;
}
var TRACK_SCALE = 1.35; // pista más grande
function buildTrack(def) {
  var pts = def.pts.map(function (p) { return [p[0] * TRACK_SCALE, p[1] * TRACK_SCALE]; });
  var samples = resample(catmullClosed(pts, 24), 9);
  var n = samples.length, i;
  var tangents = [];
  for (i = 0; i < n; i++) {
    var a = samples[(i - 1 + n) % n], b = samples[(i + 1) % n];
    tangents.push(Math.atan2(b[1] - a[1], b[0] - a[0]));
  }
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  samples.forEach(function (p) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  });
  return { def: def, samples: samples, n: n, tangents: tangents, roadHalf: def.roadHalf * TRACK_SCALE,
           minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}
function samplePoint(tr, prog) {
  var f = ((prog % 1) + 1) % 1 * tr.n;
  var i0 = Math.floor(f) % tr.n, i1 = (i0 + 1) % tr.n, t = f - Math.floor(f);
  var a = tr.samples[i0], b = tr.samples[i1];
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}
function sampleTangent(tr, prog) {
  var i = Math.floor((((prog % 1) + 1) % 1) * tr.n) % tr.n;
  return tr.tangents[i];
}
/* Índice de muestra más cercano; busca en ventana local y, si está lejos, en todo */
function nearestIdx(tr, x, y, lastIdx) {
  var best = lastIdx, bestD = 1e18, i, k;
  function consider(idx) {
    var p = tr.samples[idx];
    var dx = p[0] - x, dy = p[1] - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = idx; }
  }
  for (k = -140; k <= 140; k++) consider((lastIdx + k + tr.n) % tr.n);
  if (bestD > 220 * 220) { for (i = 0; i < tr.n; i += 3) consider(i); }
  return best;
}

/* Obstáculos: tipos con efecto. Se colocan con la semilla de la carrera. */
var OBSTACLES = {
  oil:    { r: 26, w: 0.23 },  // mancha de aceite -> trompo
  barrel: { r: 15, w: 0.21 },  // barril -> frenazo y rebote
  mud:    { r: 44, w: 0.18 },  // barro -> te hunde (zona)
  rock:   { r: 21, w: 0.13 },  // roca -> frenazo fuerte
  boost:  { r: 30, w: 0.13 },  // flechas -> turbo
  tire:   { r: 16, w: 0.12 }   // neumático rodando -> se mueve cruzando la pista
};
function genObstacles(tr, seed, count) {
  var rnd = mulberry32(seed), obs = [], placed = [], tries = 0;
  function pickType() {
    var r = rnd(), acc = 0;
    for (var k in OBSTACLES) { acc += OBSTACLES[k].w; if (r <= acc) return k; }
    return 'oil';
  }
  while (obs.length < count && tries < count * 40) {
    tries++;
    var prog = 0.055 + rnd() * 0.89;
    var ok = true, i;
    for (i = 0; i < placed.length; i++) {
      var d = Math.abs(placed[i] - prog);
      d = Math.min(d, 1 - d);
      if (d < 0.028) { ok = false; break; }
    }
    if (!ok) continue;
    var type = pickType();
    var lat = (rnd() * 2 - 1) * (tr.roadHalf - 26);
    var p = samplePoint(tr, prog), tang = sampleTangent(tr, prog);
    var nx = -Math.sin(tang), ny = Math.cos(tang);
    var ob = { id: obs.length, type: type, x: p[0] + nx * lat, y: p[1] + ny * lat,
               r: OBSTACLES[type].r, a: tang, nx: nx, ny: ny, hit: 0 };
    if (type === 'tire') {
      ob.bx = ob.x; ob.by = ob.y;
      ob.amp = (tr.roadHalf - 30) * (0.5 + rnd() * 0.35);
      ob.period = 2.5 + rnd() * 2.5;
      ob.phase = rnd() * 6.28318;
    }
    obs.push(ob);
    placed.push(prog);
  }
  // garantizar entre 2 y 4 neumáticos rodando por carrera
  var tires = obs.filter(function (o) { return o.type === 'tire'; });
  var ci = 0;
  while (tires.length < 3 && ci < obs.length) {
    var co = obs[ci++];
    if (co.type === 'barrel' || co.type === 'oil') {
      co.type = 'tire'; co.r = OBSTACLES.tire.r;
      co.bx = co.x; co.by = co.y;
      co.amp = (tr.roadHalf - 30) * (0.5 + rnd() * 0.35);
      co.period = 2.5 + rnd() * 2.5;
      co.phase = rnd() * 6.28318;
      tires.push(co);
    }
  }
  while (tires.length > 4) {
    var xo = tires.pop();
    xo.type = 'oil'; xo.r = OBSTACLES.oil.r;
  }
  return obs;
}
function genTrees(tr, seed, count) {
  var rnd = mulberry32(seed ^ 0x9e3779b9), trees = [], tries = 0;
  var padX = tr.maxX - tr.minX, padY = tr.maxY - tr.minY;
  while (trees.length < count && tries < count * 30) {
    tries++;
    var x = tr.minX - 60 + rnd() * (padX + 120);
    var y = tr.minY - 60 + rnd() * (padY + 120);
    var ok = true;
    for (var i = 0; i < tr.n; i += 6) {
      var p = tr.samples[i];
      var dx = p[0] - x, dy = p[1] - y;
      if (dx * dx + dy * dy < Math.pow(tr.roadHalf + 95, 2)) { ok = false; break; }
    }
    if (!ok) continue;
    trees.push({ x: x, y: y, r: 20 + rnd() * 26, v: rnd() });
  }
  return trees;
}

/* ---------------- crear la carrera ---------------- */
function startRace(cfg) {
  stopRaceLoop();
  var tr = buildTrack(TRACK_DEFS[cfg.track % TRACK_DEFS.length]);
  var seed = cfg.seed >>> 0;
  var race = {
    cfg: cfg, track: tr, trackIdx: cfg.track % TRACK_DEFS.length,
    seed: seed, raceNo: cfg.raceNo || 1, laps: cfg.laps || LAPS,
    startAt: cfg.startAt, roster: cfg.roster,
    obstacles: genObstacles(tr, seed, 15),
    trees: genTrees(tr, seed, 120),
    running: false, goAt: 0,
    skids: [], parts: []
  };
  S.race = race; S.me = null; S.remotes = {}; S.finishes = {};
  S.firstFinishAt = 0; S.resultsShown = false; S.lastPos = 0;

  // Mi coche en la parrilla (orden del roster)
  var myIdx = 0;
  cfg.roster.forEach(function (r, i) { if (r.id === S.playerId) myIdx = i; });
  S.me = makeCar(tr, myIdx);
  S.me.name = S.name; S.me.color = S.color;

  // Rivales (posiciones iniciales; se actualizarán por red)
  cfg.roster.forEach(function (r, i) {
    if (r.id === S.playerId) return;
    var c = makeCar(tr, i);
    c.name = r.name; c.color = r.color; c.remote = true;
    S.remotes[r.id] = { car: c, x: c.x, y: c.y, a: c.a, speed: 0, lap: 0, prog: 0,
                        finished: false, ft: 0, rx: c.x, ry: c.y, ra: c.a, t: 0, name: r.name, color: r.color };
  });

  buildStaticLayer(race);
  buildMinimap(race);
  sendStatus('racing');
  showScreen('game');
  $('hud').classList.remove('hidden');
  $('results').classList.add('hidden');
  $('finish-wait').classList.add('hidden');
  $('hint').classList.remove('hidden');
  setTimeout(function () { $('hint').classList.add('hidden'); }, 6000);
  sizeCanvas();
  startRaceLoop();
}
function makeCar(tr, slot) {
  var row = Math.floor(slot / 2), col = slot % 2;
  var prog = 0.972 - row * 0.011;
  var lat = col === 0 ? -36 : 36;
  var p = samplePoint(tr, prog), tang = sampleTangent(tr, prog);
  var nx = -Math.sin(tang), ny = Math.cos(tang);
  var idx = Math.floor(prog * tr.n) % tr.n;
  return { x: p[0] + nx * lat, y: p[1] + ny * lat, a: tang, speed: 0, steer: 0,
           idx: idx, prevProg: prog, uProg: prog - 1, // uProg arranca en -1+prog (<0): cruzar la línea = vuelta 0 válida
           lap: 0, finished: false, ft: 0, offroad: false, inMud: false,
           spinT: 0, spinDir: 1, lastSkid: null, driftT: 0, wrongT: 0, wrongAcc: 0, wrongWarn: false,
           boostT: 0, boostMul: 1,
           wallOut: false, prevLap: -1, lapStartT: 0, bestLap: 0,
           hitCd: {} };
}

/* ---------------- física (mi coche) ---------------- */
var P = { maxSpeed: 365, accel: 310, brake: 720, reverseMax: 130, turn: 3.1 };
function stepCar(me, tr, dt, input, race) {
  var now = performance.now() / 1000;
  if (me.finished) { me.speed = Math.max(0, me.speed - 500 * dt); }
  else if (me.spinT > 0) {
    me.spinT -= dt;
    if (me.spinT > 0.35) {
      me.a += 10.5 * dt * me.spinDir; // vueltas del trompo
    } else {
      // enderezar: al terminar queda mirando al sentido de la carrera
      me.a += normAngle(tr.tangents[me.idx] - me.a) * Math.min(1, 10 * dt);
    }
    me.speed = Math.max(0, me.speed - 420 * dt);
    if (me.spinT <= 0) { me.spinT = 0; me.a = tr.tangents[me.idx]; }
  } else {
    // dirección suavizada
    var steerT = input.steer;
    me.steer += clamp(steerT - me.steer, -8 * dt, 8 * dt);
    var spd = me.speed;
    var grip = clamp(spd / 150, 0, 1) * (1 - 0.28 * clamp(spd / P.maxSpeed, 0, 1));
    me.a += me.steer * P.turn * grip * dt * (spd < -5 ? -1 : 1);
    // velocidad
    if (me.boostT > 0) me.boostT -= dt;
    var maxS = P.maxSpeed;
    if (me.offroad) maxS *= 0.55;
    if (me.inMud) maxS *= 0.5;
    if (me.boostT > 0) maxS = P.maxSpeed * me.boostMul; // turbo activo
    if (input.brake) {
      if (spd > 8) me.speed = Math.max(0, spd - P.brake * dt);
      else me.speed = Math.max(-P.reverseMax, spd - P.accel * 0.7 * dt); // marcha atrás
    } else {
      if (spd > maxS) me.speed = Math.max(maxS, spd - 260 * dt); // el turbo se acaba poco a poco
      else me.speed = Math.min(maxS, spd + P.accel * dt * (me.offroad ? 0.6 : 1));
      if (me.speed < 0) me.speed = Math.min(0, me.speed + P.brake * 0.5 * dt);
    }
  }
  me.x += Math.cos(me.a) * me.speed * dt;
  me.y += Math.sin(me.a) * me.speed * dt;

  // progreso en pista / fuera de pista
  me.idx = nearestIdx(tr, me.x, me.y, me.idx);
  var sp = tr.samples[me.idx];
  var distC = Math.hypot(me.x - sp[0], me.y - sp[1]);
  me.offroad = distC > tr.roadHalf;
  // muros en los bordes: hay un arcén de hierba antes de llegar a ellos
  var wallD = tr.roadHalf + 60;
  if (distC > wallD) {
    var wnx = (me.x - sp[0]) / distC, wny = (me.y - sp[1]) / distC;
    me.x = sp[0] + wnx * wallD;
    me.y = sp[1] + wny * wallD;
    if (!me.wallOut) { // penalización solo al impactar, no mientras rozas
      me.speed *= 0.85;
      burst(race, me.x, me.y, '#ffd166', 8);
    }
  }
  me.wallOut = distC > wallD;
  var prog = me.idx / tr.n;
  var du = prog - me.prevProg;
  if (du < -0.5) du += 1; else if (du > 0.5) du -= 1;
  me.prevProg = prog;
  if (!me.finished) {
    me.uProg += du;
    me.lap = Math.floor(me.uProg);
    // tiempos por vuelta
    if (me.lap !== me.prevLap) {
      var raceT = (Date.now() - race.goAt) / 1000;
      if (me.prevLap >= 0 && raceT - me.lapStartT > 3) {
        var lt = raceT - me.lapStartT;
        if (!me.bestLap || lt < me.bestLap) me.bestLap = lt;
      }
      me.prevLap = me.lap;
      me.lapStartT = raceT;
    }
    // dirección contraria
    me.wrongAcc += du; me.wrongT += dt;
    if (me.wrongT > 1.4) {
      me.wrongWarn = (me.wrongAcc < -0.012 && me.speed > 70);
      me.wrongAcc = 0; me.wrongT = 0;
    }
  }

  // obstáculos (solo mi coche; los rivales ya traen su movimiento por red)
  me.inMud = false;
  if (!me.finished) {
    for (var i = 0; i < race.obstacles.length; i++) {
      var o = race.obstacles[i];
      var dx = me.x - o.x, dy = me.y - o.y;
      var rr = o.r + 16; // radio del coche más grande
      if (dx * dx + dy * dy > rr * rr) continue;
      if (o.type === 'mud') { me.inMud = true; continue; }
      if (now - (me.hitCd[o.id] || -9) < 2) continue;
      me.hitCd[o.id] = now;
      if (o.type === 'oil') {
        me.spinT = 0.95; me.spinDir = Math.random() < 0.5 ? -1 : 1;
        me.speed *= 0.45;
        burst(race, me.x, me.y, '#222', 10);
      } else if (o.type === 'barrel') {
        me.speed *= 0.4;
        me.x -= Math.cos(me.a) * 22; me.y -= Math.sin(me.a) * 22;
        burst(race, o.x, o.y, '#c96a2c', 8);
      } else if (o.type === 'rock') {
        me.speed *= 0.22;
        me.x -= Math.cos(me.a) * 38; me.y -= Math.sin(me.a) * 38;
        burst(race, o.x, o.y, '#999', 10);
      } else if (o.type === 'tire') {
        me.speed *= 0.5;
        me.x -= Math.cos(me.a) * 18; me.y -= Math.sin(me.a) * 18;
        burst(race, o.x, o.y, '#333', 8);
      } else if (o.type === 'boost') {
        me.boostT = 1.4; me.boostMul = 1.7;
        me.speed = Math.min(P.maxSpeed * 1.7, me.speed + 380);
        burst(race, me.x, me.y, '#39d353', 14);
      }
    }
  }

  // derrapes y polvo
  if (!me.finished && Math.abs(me.steer) > 0.55 && me.speed > 235 && !me.offroad) {
    var bx = me.x - Math.cos(me.a) * 15, by = me.y - Math.sin(me.a) * 15;
    if (me.lastSkid) {
      race.skids.push({ x1: me.lastSkid[0], y1: me.lastSkid[1], x2: bx, y2: by, a: 0.5 });
      if (race.skids.length > 420) race.skids.splice(0, race.skids.length - 420);
    }
    me.lastSkid = [bx, by];
    me.driftT += dt;
  } else {
    // sin mini-turbo al soltar el derrape (eliminado en v8: incontrolable)
    me.driftT = 0;
    me.lastSkid = null;
  }
  if (me.offroad && me.speed > 150 && Math.random() < 0.5) {
    race.parts.push({ x: me.x, y: me.y, vx: (Math.random() - .5) * 60, vy: (Math.random() - .5) * 60,
                      life: 0.7, t: 0, c: '#c9b18a', r: 5 });
  }
  // partículas
  for (var j = race.parts.length - 1; j >= 0; j--) {
    var pt = race.parts[j];
    pt.t += dt;
    if (pt.t > pt.life) { race.parts.splice(j, 1); continue; }
    pt.x += pt.vx * dt; pt.y += pt.vy * dt;
  }
  for (var s = race.skids.length - 1; s >= 0; s--) {
    race.skids[s].a -= dt * 0.06;
    if (race.skids[s].a <= 0) race.skids.splice(s, 1);
  }

  // fin de carrera
  if (!me.finished && me.uProg >= race.laps) {
    me.finished = true;
    me.ft = Date.now() - race.goAt;
    onLocalFinished();
  }
}
function burst(race, x, y, c, n) {
  for (var i = 0; i < n; i++) {
    var a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 160;
    race.parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                      life: 0.6, t: 0, c: c, r: 4 + Math.random() * 4 });
  }
}

/* piloto automático (modo ?demo=1, para verificar sin tocar nada) */
function autopilot(me, tr) {
  var look = tr.samples[(me.idx + 55) % tr.n];
  var want = Math.atan2(look[1] - me.y, look[0] - me.x);
  var d = normAngle(want - me.a);
  S.input.steer = clamp(d * 2.2, -1, 1);
  S.input.brake = Math.abs(d) > 1.15 && me.speed > 200;
}

/* ============================================================
 * PARTE 3 — render, bucle, red de carrera, resultados
 * ============================================================ */
var canvas, ctx, DPR = 1, cssW = 0, cssH = 0;
var rafId = 0, sendTimer = 0, hudTimer = 0;
var cam = { x: 0, y: 0 };

function sizeCanvas() {
  canvas = $('game-canvas');
  DPR = Math.min(2, window.devicePixelRatio || 1);
  cssW = window.innerWidth; cssH = window.innerHeight;
  canvas.width = Math.round(cssW * DPR);
  canvas.height = Math.round(cssH * DPR);
}
window.addEventListener('resize', function () { if (S.screen === 'game') sizeCanvas(); });

/* ---- capa estática: hierba + carretera + obstáculos + árboles (una vez por carrera) ---- */
function buildStaticLayer(race) {
  var tr = race.track, pad = 120, LS = 0.5;
  var W = Math.ceil((tr.maxX - tr.minX + pad * 2) * LS);
  var H = Math.ceil((tr.maxY - tr.minY + pad * 2) * LS);
  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var g = cv.getContext('2d');
  g.scale(LS, LS);
  g.translate(-tr.minX + pad, -tr.minY + pad);
  var rnd = mulberry32(race.seed ^ 0x51ab);

  // hierba
  g.fillStyle = '#5a8f46'; g.fillRect(tr.minX - pad, tr.minY - pad, (tr.maxX - tr.minX) + pad * 2, (tr.maxY - tr.minY) + pad * 2);
  var i;
  for (i = 0; i < 700; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(70,120,55,0.5)' : 'rgba(110,170,85,0.45)';
    var bx = tr.minX - pad + rnd() * (tr.maxX - tr.minX + pad * 2);
    var by = tr.minY - pad + rnd() * (tr.maxY - tr.minY + pad * 2);
    var br = 20 + rnd() * 70;
    g.beginPath(); g.arc(bx, by, br, 0, 7); g.fill();
  }
  // carretera: borde oscuro + tierra + línea central
  function strokeRoad(width, style, dash) {
    g.strokeStyle = style; g.lineWidth = width;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.setLineDash(dash || []);
    g.beginPath();
    g.moveTo(tr.samples[0][0], tr.samples[0][1]);
    for (var k = 1; k <= tr.n; k++) { var p = tr.samples[k % tr.n]; g.lineTo(p[0], p[1]); }
    g.closePath(); g.stroke(); g.setLineDash([]);
  }
  strokeRoad(tr.roadHalf * 2 + 16, '#5e4226');
  strokeRoad(tr.roadHalf * 2, '#a87f4e');
  strokeRoad(5, 'rgba(230,205,150,0.65)', [30, 34]);

  // muros: postes rojos/blancos en ambos bordes (impiden atajar por la hierba)
  var wi, wside;
  for (wi = 0; wi < tr.n; wi += 6) {
    var wp = tr.samples[wi], wtang = tr.tangents[wi];
    var wnx = -Math.sin(wtang), wny = Math.cos(wtang);
    for (wside = -1; wside <= 1; wside += 2) {
      var wx = wp[0] + wnx * wside * (tr.roadHalf + 60);
      var wy = wp[1] + wny * wside * (tr.roadHalf + 60);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.arc(wx + 2, wy + 3, 7, 0, 7); g.fill();
      g.fillStyle = (((wi / 6) | 0) % 2) ? '#d62828' : '#f1faee';
      g.beginPath(); g.arc(wx, wy, 7, 0, 7); g.fill();
    }
  }

  // línea de salida (ajedrez)
  (function () {
    var p = tr.samples[0], tang = tr.tangents[0];
    var nx = -Math.sin(tang), ny = Math.cos(tang);
    var cols = 10, sq = (tr.roadHalf * 2) / cols;
    g.save(); g.translate(p[0], p[1]); g.rotate(tang);
    for (var r = 0; r < 2; r++) for (var c = 0; c < cols; c++) {
      g.fillStyle = (r + c) % 2 ? '#111' : '#f5f5f5';
      g.fillRect(-9 + r * 9, -tr.roadHalf + c * sq, 9, sq);
    }
    g.restore();
  })();

  // obstáculos (los neumáticos rodando se dibujan en cada frame, no aquí)
  race.obstacles.forEach(function (o) {
    if (o.type === 'tire') return;
    if (o.type === 'oil') {
      g.fillStyle = 'rgba(20,20,25,0.85)';
      g.beginPath(); g.ellipse(o.x, o.y, o.r, o.r * 0.7, o.a || 0, 0, 7); g.fill();
      g.fillStyle = 'rgba(80,80,120,0.5)';
      g.beginPath(); g.ellipse(o.x - 6, o.y - 4, o.r * 0.4, o.r * 0.28, 0, 0, 7); g.fill();
    } else if (o.type === 'mud') {
      g.fillStyle = 'rgba(110,72,40,0.9)';
      g.beginPath(); g.ellipse(o.x, o.y, o.r, o.r * 0.75, (o.a || 0) + 0.4, 0, 7); g.fill();
      g.fillStyle = 'rgba(85,55,30,0.9)';
      g.beginPath(); g.ellipse(o.x + 8, o.y + 5, o.r * 0.55, o.r * 0.4, 0, 0, 7); g.fill();
    } else if (o.type === 'barrel') {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.arc(o.x + 3, o.y + 4, o.r, 0, 7); g.fill();
      g.fillStyle = '#d2691e';
      g.beginPath(); g.arc(o.x, o.y, o.r, 0, 7); g.fill();
      g.fillStyle = '#f4f4f4'; g.fillRect(o.x - o.r, o.y - 4, o.r * 2, 8);
      g.fillStyle = '#8a4a12';
      g.beginPath(); g.arc(o.x, o.y, o.r * 0.35, 0, 7); g.fill();
    } else if (o.type === 'rock') {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.arc(o.x + 3, o.y + 5, o.r, 0, 7); g.fill();
      g.fillStyle = '#8d8d94';
      g.beginPath();
      var rr = mulberry32(o.id * 7919 + 13);
      for (var k = 0; k < 7; k++) {
        var aa = k / 7 * Math.PI * 2, rad = o.r * (0.8 + rr() * 0.4);
        var px = o.x + Math.cos(aa) * rad, py = o.y + Math.sin(aa) * rad;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath(); g.fill();
      g.fillStyle = '#b5b5bc';
      g.beginPath(); g.arc(o.x - 4, o.y - 5, o.r * 0.4, 0, 7); g.fill();
    } else if (o.type === 'boost') {
      var tang = o.a || 0;
      g.save(); g.translate(o.x, o.y); g.rotate(tang);
      g.fillStyle = 'rgba(20,120,50,0.35)';
      g.beginPath(); g.arc(0, 0, o.r, 0, 7); g.fill();
      g.fillStyle = '#39d353';
      for (var c = -1; c <= 1; c++) {
        g.beginPath();
        g.moveTo(c * 22 - 6, -16); g.lineTo(c * 22 + 10, 0); g.lineTo(c * 22 - 6, 16);
        g.lineTo(c * 22 - 1, 0); g.closePath(); g.fill();
      }
      g.restore();
    }
  });

  // árboles
  race.trees.forEach(function (t) {
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.arc(t.x + 4, t.y + 6, t.r, 0, 7); g.fill();
    g.fillStyle = t.v < 0.5 ? '#2d5a27' : '#356b2f';
    g.beginPath(); g.arc(t.x, t.y, t.r, 0, 7); g.fill();
    g.fillStyle = '#3f7d38';
    g.beginPath(); g.arc(t.x - t.r * 0.25, t.y - t.r * 0.25, t.r * 0.55, 0, 7); g.fill();
  });

  race.layer = cv; race.layerPad = pad; race.layerLS = LS;
}

/* ---- minimapa ---- */
function buildMinimap(race) {
  var mm = $('minimap'), g = mm.getContext('2d');
  var tr = race.track;
  var sx = (mm.width - 16) / (tr.maxX - tr.minX), sy = (mm.height - 16) / (tr.maxY - tr.minY);
  var s = Math.min(sx, sy);
  var ox = (mm.width - (tr.maxX - tr.minX) * s) / 2 - tr.minX * s;
  var oy = (mm.height - (tr.maxY - tr.minY) * s) / 2 - tr.minY * s;
  race.mm = { s: s, ox: ox, oy: oy };
  g.clearRect(0, 0, mm.width, mm.height);
  g.strokeStyle = '#c9a06a'; g.lineWidth = 5; g.lineJoin = 'round';
  g.beginPath();
  for (var i = 0; i <= tr.n; i += 4) {
    var p = tr.samples[i % tr.n];
    var x = p[0] * s + ox, y = p[1] * s + oy;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath(); g.stroke();
}
function drawMinimapDots() {
  var race = S.race; if (!race || !race.mm) return;
  var mm = $('minimap'), g = mm.getContext('2d');
  var m = race.mm;
  function dot(x, y, color, big) {
    g.fillStyle = color;
    g.beginPath(); g.arc(x * m.s + m.ox, y * m.s + m.oy, big ? 5 : 3.5, 0, 7); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1; g.stroke();
  }
  var now = Date.now();
  Object.keys(S.remotes).forEach(function (id) {
    var r = S.remotes[id];
    if (now - r.t < 3000) dot(r.rx, r.ry, r.color, false);
  });
  if (S.me) dot(S.me.x, S.me.y, '#fff', true);
}

/* ---- coche ---- */
var CAR_SCALE = 1.28; // coches un poco más grandes
function drawCar(g, x, y, a, color, name, isMe, ghost) {
  g.save();
  g.translate(x, y); g.rotate(a); g.scale(CAR_SCALE, CAR_SCALE);
  if (ghost) g.globalAlpha = 0.45;
  // sombra
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath(); g.ellipse(2, 3, 22, 13, 0, 0, 7); g.fill();
  // ruedas
  g.fillStyle = '#1a1a1a';
  [[-11, -11], [-11, 11], [11, -11], [11, 11]].forEach(function (w) {
    g.fillRect(w[0] - 5, w[1] - 3.5, 10, 7);
  });
  // carrocería
  g.fillStyle = color;
  roundRect(g, -20, -10, 40, 20, 7); g.fill();
  // franja rally
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(-20, -3, 40, 6);
  // cabina
  g.fillStyle = '#20242c';
  roundRect(g, -4, -7, 12, 14, 4); g.fill();
  // alerón trasero
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(-23, -12, 5, 24);
  // morro
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(14, -8, 6, 16);
  g.restore();
  if (name) {
    g.save();
    g.globalAlpha = ghost ? 0.5 : 1;
    g.font = '700 24px sans-serif'; g.textAlign = 'center';
    g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.7)';
    var label = (isMe ? '▶ ' : '') + name;
    g.strokeText(label, x, y - 36);
    g.fillStyle = isMe ? '#ffd166' : '#fff';
    g.fillText(label, x, y - 36);
    g.restore();
  }
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* ---- bucle principal ---- */
function startRaceLoop() {
  stopRaceLoop();
  ctx = $('game-canvas').getContext('2d');
  cam.x = S.me.x; cam.y = S.me.y;
  var last = performance.now();
  if (!S.local) {
    sendTimer = setInterval(function () {
      if (S.race && S.me && S.screen === 'game') {
        send('player_state', {
          id: S.playerId, x: Math.round(S.me.x), y: Math.round(S.me.y),
          a: Math.round(S.me.a * 100) / 100, s: Math.round(S.me.speed),
          lap: S.me.lap, pr: Math.round(((S.me.uProg % 1) + 1) % 1 * 1000) / 1000,
          f: S.me.finished ? 1 : 0, ft: S.me.ft || 0
        });
      }
    }, 100);
  }
  hudTimer = setInterval(updateHUD, 300);
  function frame(now) {
    rafId = requestAnimationFrame(frame);
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(dt);
  }
  rafId = requestAnimationFrame(frame);
}
function stopRaceLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (sendTimer) clearInterval(sendTimer);
  sendTimer = 0;
  if (hudTimer) clearInterval(hudTimer);
  hudTimer = 0;
}

function tick(dt) {
  var race = S.race, me = S.me;
  if (!race || !me) return;
  var nowMs = Date.now();

  // cuenta atrás
  var cd = $('countdown');
  if (!race.running) {
    var left = race.startAt - nowMs;
    if (left > 0) {
      cd.classList.remove('hidden');
      cd.textContent = Math.ceil(left / 1000);
    } else {
      race.running = true; race.goAt = race.startAt;
      cd.textContent = '¡YA!';
      setTimeout(function () { cd.classList.add('hidden'); }, 900);
    }
  }

  if (race.running) {
    // neumáticos rodando: posición determinista según el reloj de carrera
    var tSec = (Date.now() - race.goAt) / 1000, ti, to, toff;
    for (ti = 0; ti < race.obstacles.length; ti++) {
      to = race.obstacles[ti];
      if (to.type !== 'tire') continue;
      toff = to.amp * Math.sin(6.28318 * tSec / to.period + to.phase);
      to.x = to.bx + to.nx * toff;
      to.y = to.by + to.ny * toff;
    }
    if (S.demo) autopilot(me, race.track);
    stepCar(me, race.track, dt, S.input, race);
    // interpolar rivales
    var k = Math.min(1, 11 * dt);
    Object.keys(S.remotes).forEach(function (id) {
      var r = S.remotes[id];
      r.rx = lerp(r.rx, r.x, k); r.ry = lerp(r.ry, r.y, k);
      r.ra += normAngle(r.a - r.ra) * k;
    });
    // comprobar resultados (por si el temporizador de 45 s venció)
    checkResults();
  }

  // cámara
  cam.x = lerp(cam.x, me.x, Math.min(1, 5 * dt));
  cam.y = lerp(cam.y, me.y, Math.min(1, 5 * dt));

  render();
  $('wrongway').classList.toggle('hidden', !me.wrongWarn);
}

function render() {
  var race = S.race, me = S.me;
  if (!race || !me) return;
  var tr = race.track;
  var s = cssW / 1000; // 1000 px de mundo visibles de ancho
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#3d6b34';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.setTransform(DPR * s, 0, 0, DPR * s, DPR * (cssW / 2 - cam.x * s), DPR * (cssH / 2 - cam.y * s));

  // capa estática
  var pad = race.layerPad;
  ctx.drawImage(race.layer, tr.minX - pad, tr.minY - pad,
    (tr.maxX - tr.minX) + pad * 2, (tr.maxY - tr.minY) + pad * 2);

  // neumáticos rodando (dinámicos)
  race.obstacles.forEach(function (o) {
    if (o.type !== 'tire') return;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.arc(o.x + 3, o.y + 4, o.r, 0, 7); ctx.fill();
    ctx.fillStyle = '#1e1e1e';
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 7); ctx.fill();
    ctx.fillStyle = '#4d4d4d';
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.45, 0, 7); ctx.fill();
  });

  // derrapes
  ctx.lineCap = 'round';
  race.skids.forEach(function (sk) {
    ctx.strokeStyle = 'rgba(30,25,20,' + sk.a.toFixed(3) + ')';
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(sk.x1, sk.y1); ctx.lineTo(sk.x2, sk.y2); ctx.stroke();
  });
  // partículas
  race.parts.forEach(function (pt) {
    ctx.globalAlpha = 1 - pt.t / pt.life;
    ctx.fillStyle = pt.c;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r, 0, 7); ctx.fill();
  });
  ctx.globalAlpha = 1;

  // rivales y yo
  var now = Date.now();
  Object.keys(S.remotes).forEach(function (id) {
    var r = S.remotes[id];
    var ghost = now - r.t > 2500;
    drawCar(ctx, r.rx, r.ry, r.ra, r.color, r.name, false, ghost);
  });
  drawCar(ctx, me.x, me.y, me.a, me.color, me.name, true, false);

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawMinimapDots();
}

/* ---- HUD ---- */
function fmtRaceTime(ms) {
  var t = Math.max(0, ms);
  var m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), d = Math.floor((t % 1000) / 100);
  return m + ':' + (s < 10 ? '0' : '') + s + '.' + d;
}
function scoreOf(p) {
  // p: {finished, ft, lap, prog}
  if (p.finished) return 1e15 - p.ft;
  return p.lap * 1e6 + p.prog * 1e3;
}
function myPosition() {
  var race = S.race; if (!race || !S.me) return 1;
  var arr = [];
  var meProg = ((S.me.uProg % 1) + 1) % 1;
  arr.push({ id: S.playerId, finished: S.me.finished, ft: S.me.ft, lap: S.me.lap, prog: meProg });
  Object.keys(S.remotes).forEach(function (id) {
    var r = S.remotes[id];
    var f = S.finishes[id];
    arr.push({ id: id, finished: !!f, ft: f || 0, lap: r.lap, prog: r.prog });
  });
  arr.sort(function (a, b) { return scoreOf(b) - scoreOf(a); });
  for (var i = 0; i < arr.length; i++) if (arr[i].id === S.playerId) return i + 1;
  return 1;
}
function updateHUD() {
  var race = S.race, me = S.me;
  if (!race || !me || S.screen !== 'game') return;
  var total = race.roster.length;
  var pos = myPosition();
  $('hud-pos').textContent = pos + 'º/' + total;
  if (S.lastPos && pos < S.lastPos && race.running && !me.finished) toast('⬆️ ¡Vas ' + pos + 'º!');
  S.lastPos = pos;
  var lapShow = me.finished ? race.laps : clamp(me.lap + 1, 1, race.laps);
  $('hud-lap').textContent = 'Vuelta ' + lapShow + '/' + race.laps;
  var t = race.running ? (me.finished ? me.ft : Date.now() - race.goAt) : 0;
  $('hud-time').textContent = fmtRaceTime(t);
}

/* ---- red de carrera ---- */
function applyPlayerState(p) {
  if (!S.race || S.local) return;
  if (p.id === S.playerId) return;
  var r = S.remotes[p.id];
  if (!r) return;
  if (!r.t) { r.rx = p.x; r.ry = p.y; r.ra = p.a; }
  r.x = p.x; r.y = p.y; r.a = p.a; r.speed = p.s;
  r.lap = p.lap; r.prog = p.pr; r.t = Date.now();
  if (p.f && !S.finishes[p.id]) applyPlayerFinished({ id: p.id, ft: p.ft });
}
function applyPlayerFinished(p) {
  if (!S.race) return;
  if (!S.finishes[p.id]) {
    S.finishes[p.id] = p.ft;
    if (!S.firstFinishAt) S.firstFinishAt = Date.now();
  }
  if (p.id === S.playerId) {
    var fw = $('finish-wait');
    fw.classList.remove('hidden');
    fw.innerHTML = '🏁 ¡Has terminado <b>' + myPosition() + 'º</b>!<br><span style="font-size:15px;color:#b9c4a8">Esperando al resto…</span>';
  }
  checkResults();
}
function onLocalFinished() {
  S.finishes[S.playerId] = S.me.ft;
  if (!S.firstFinishAt) S.firstFinishAt = Date.now();
  if (!S.local) send('player_finished', { id: S.playerId, ft: S.me.ft });
  applyPlayerFinished({ id: S.playerId, ft: S.me.ft });
  // mejor tiempo en solitario
  if (S.local) {
    try {
      var key = 'rally_best_' + S.race.trackIdx;
      var prev = parseInt(localStorage.getItem(key) || '0', 10);
      if (!prev || S.me.ft < prev) {
        localStorage.setItem(key, String(S.me.ft));
        toast('🏆 ¡Récord personal en ' + TRACK_NAMES[S.race.trackIdx] + ': ' + fmtTime(S.me.ft) + '!');
      }
    } catch (e) {}
  }
}
function checkResults() {
  if (S.resultsShown || !S.race || !S.me || !S.me.finished) return;
  var roster = S.race.roster;
  var allIn = roster.every(function (r) { return S.finishes[r.id]; });
  var timeout = S.firstFinishAt && (Date.now() - S.firstFinishAt > 45000);
  if (allIn || timeout) showResults();
}
function showResults() {
  S.resultsShown = true;
  var race = S.race, roster = race.roster;
  var rows = roster.map(function (r) {
    var ft = S.finishes[r.id];
    var rem = S.remotes[r.id];
    var prog = 0, lap = 0;
    if (r.id === S.playerId) { lap = S.me.lap; prog = ((S.me.uProg % 1) + 1) % 1; }
    else if (rem) { lap = rem.lap; prog = rem.prog || 0; }
    return { id: r.id, name: r.name, color: r.color, ft: ft || null, lap: lap, prog: prog };
  });
  rows.sort(function (a, b) {
    if (a.ft && b.ft) return a.ft - b.ft;
    if (a.ft) return -1;
    if (b.ft) return 1;
    return (b.lap * 1e6 + b.prog * 1e3) - (a.lap * 1e6 + a.prog * 1e3);
  });
  var box = $('results');
  box.classList.remove('hidden');
  $('finish-wait').classList.add('hidden');
  box.innerHTML = '';
  var medals = ['🥇', '🥈', '🥉'];
  box.appendChild(el('h2', '🏆 Resultados'));
  box.appendChild(el('p', TRACK_NAMES[race.trackIdx] + ' · ' + race.laps + ' vueltas', 'sub'));
  var ul = el('ul'); ul.id = 'results-list';
  rows.forEach(function (r, i) {
    var li = el('li', null, r.id === S.playerId ? 'me' : null);
    li.appendChild(el('span', medals[i] || (i + 1) + 'º'));
    var dot = el('span', null, 'dot'); dot.style.background = r.color;
    li.appendChild(dot);
    li.appendChild(el('span', r.name + (r.id === S.playerId ? ' (tú)' : '')));
    li.appendChild(el('span', r.ft ? fmtTime(r.ft) : 'abandonó', r.ft ? 'time' : 'dnf'));
    ul.appendChild(li);
  });
  box.appendChild(ul);
  if (S.me.bestLap) box.appendChild(el('p', '⚡ Tu mejor vuelta: ' + fmtTime(S.me.bestLap * 1000), 'sub'));
  var row = el('div', null, 'row');
  if (!S.local && S.isHost) {
    var rb = el('button', '🔄 REVANCHA (pista y obstáculos nuevos)', 'btn btn-big');
    rb.addEventListener('click', function () {
      var rosterNow = S.players.slice(0, MAX_PLAYERS).map(function (p) {
        return { id: p.id, name: p.name, color: p.color };
      });
      if (!rosterNow.length) rosterNow = race.roster;
      var cfg = {
        seed: (Math.random() * 1e9) | 0,
        track: (Math.random() * TRACK_NAMES.length) | 0,
        laps: race.laps, raceNo: race.raceNo + 1,
        startAt: Date.now() + 3500,
        roster: rosterNow, by: S.playerId
      };
      send('race_start', cfg);
      startRace(cfg); // el anfitrión también arranca en local
      setTimeout(function () { send('race_start', cfg); }, 1200);
      setTimeout(function () { send('race_start', cfg); }, 3000);
    });
    row.appendChild(rb);
  } else if (!S.local) {
    row.appendChild(el('p', 'Esperando a que el anfitrión pida la revancha…', 'muted'));
  }
  if (S.local) {
    var rb2 = el('button', '🔄 OTRA CARRERA', 'btn btn-big');
    rb2.addEventListener('click', function () { startSolo(); });
    row.appendChild(rb2);
  }
  var lb = el('button', 'Salir al menú', 'btn-secondary');
  lb.addEventListener('click', function () { leaveRoom(); });
  row.appendChild(lb);
  box.appendChild(row);
  // volver a "lobby" para que quien se unió a mitad pueda entrar
  sendStatus('lobby');
}

/* ---- controles táctiles + teclado ---- */
function initInput() {
  var left = false, right = false;
  function upd() { S.input.steer = (right ? 1 : 0) - (left ? 1 : 0); }

  /* Giro simple: dos botones grandes, mantener pulsado */
  function bindSteer(elm, set) {
    var on = function (e) { e.preventDefault(); set(true); elm.classList.add('on'); };
    var off = function (e) { if (e.cancelable) e.preventDefault(); set(false); elm.classList.remove('on'); };
    elm.addEventListener('touchstart', on, { passive: false });
    elm.addEventListener('touchend', off);
    elm.addEventListener('touchcancel', off);
    elm.addEventListener('mousedown', on);
    elm.addEventListener('mouseup', off);
    elm.addEventListener('mouseleave', function () { set(false); elm.classList.remove('on'); });
  }
  bindSteer($('btn-left'), function (v) { left = v; upd(); });
  bindSteer($('btn-right'), function (v) { right = v; upd(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { left = true; upd(); }
    else if (e.key === 'ArrowRight') { right = true; upd(); }
    else if (e.key === 'ArrowDown') S.input.brake = true;
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft') { left = false; upd(); }
    else if (e.key === 'ArrowRight') { right = false; upd(); }
    else if (e.key === 'ArrowDown') S.input.brake = false;
  });
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });
  $('btn-leave-game').addEventListener('click', function () { leaveRoom(); });
}

/* ---- actualización automática (anti-caché, como el chinchimoni) ---- */
function checkForUpdate(auto) {
  if (!window.fetch) return;
  fetch('version.txt?v=' + Date.now(), { cache: 'no-store' }).then(function (r) {
    return r.ok ? r.text() : null;
  }).then(function (txt) {
    var v = txt ? parseInt(txt.trim(), 10) : 0;
    if (!v || v === PROTO_V) return;
    showUpdateBanner(v);
    if (auto && S.screen === 'home') {
      var key = 'rally_redirected_' + v, done = false;
      try { done = !!sessionStorage.getItem(key); } catch (e) {}
      if (!done) {
        try { sessionStorage.setItem(key, '1'); } catch (e) {}
        setTimeout(function () {
          var url = new URL(location.href);
          url.searchParams.set('v', String(v));
          location.href = url.toString();
        }, 1500);
      }
    }
  }).catch(function () {});
}
function showUpdateBanner(v) {
  var b = $('update-banner');
  if (!b) return;
  if (b.getAttribute('data-v') === String(v)) return;
  b.setAttribute('data-v', String(v));
  b.innerHTML = '';
  b.appendChild(el('span', 'Tienes la version ' + PROTO_V + '; la actual es la ' + v + '. '));
  var btn = el('button', 'Actualizar ahora');
  btn.onclick = function () {
    var url = new URL(location.href);
    url.searchParams.set('v', String(v));
    location.href = url.toString();
  };
  b.appendChild(btn);
  b.classList.remove('hidden');
}

/* Al volver a la app (p. ej. tras compartir el codigo por WhatsApp),
 * iOS/Android pueden haber cortado la conexion: si estamos en una sala
 * y la conexion cayo, se vuelve a entrar solo a la misma sala. */
document.addEventListener('visibilitychange', function () {
  if (document.hidden) return;
  if (S.roomCode && !NET.connected && !NET.joining && !NET.leaving && !S.local) {
    NET.retries = 0;
    joinRoom(S.roomCode, NET.amHost, true);
  }
});
window.addEventListener('pageshow', function (e) { if (e.persisted) checkForUpdate(true); });

/* ---- arranque ---- */
initHome();
initLobby();
initInput();
checkForUpdate(true);
setInterval(function () { checkForUpdate(false); }, 60000);
if (!S.demo) showScreen('home');

})();
