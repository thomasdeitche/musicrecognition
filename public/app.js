'use strict';

// ---------- Einstellungen ----------
const TARGET_RATE = 16000;
const WINDOW_SEC = 10;          // so viele Sekunden werden je Versuch gesendet
const RETRY_SEARCH_SEC = 5;     // Abstand zwischen Versuchen, solange nichts erkannt ist
const RECHECK_MATCH_SEC = 20;   // Abstand nach einem Treffer (Songwechsel erkennen)
const STALE_AFTER_MISSES = 3;   // so viele Fehlversuche nach einem Treffer -> Karte abblenden
const SILENCE_RMS = 0.004;      // darunter gilt das Fenster als Stille
const HISTORY_MAX = 15;

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const els = {
  card: $('card'), artist: $('artist'), title: $('title'), released: $('released'),
  dot: $('dot'), status: $('statusText'), meter: $('meterFill'),
  device: $('device'), start: $('startBtn'), system: $('systemBtn'),
  historyBox: $('historyBox'), history: $('history'),
};

// ---------- Zustand ----------
let ctx = null, stream = null, source = null, worklet = null;
let running = false, timer = null, inFlight = false;
let ring = new Int16Array(TARGET_RATE * (WINDOW_SEC + 2));
let ringPos = 0, ringFilled = 0;
let resampleCarry = { pos: 0 };
let current = null;   // { key, artist, title, release }
let misses = 0;
let levelPeak = 0;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } },
};

// ---------- Anzeige ----------
function setStatus(text, mode) {
  els.status.textContent = text;
  els.dot.className = 'dot' + (mode ? ' ' + mode : '');
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

// Alter (Jahre + Monate) ab Veröffentlichung bis heute
function ageText(release) {
  if (!release) return null;
  const [y, m = 1, d = 1] = release.date.split('-').map(Number);
  const now = new Date();
  if (release.precision === 'year') {
    const years = now.getFullYear() - y;
    return years <= 0 ? 'DIESES JAHR' : `CA. ${plural(years, 'JAHR', 'JAHRE')}`;
  }
  let months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  if (release.precision === 'day' && now.getDate() < d) months--;
  if (months < 0) months = 0;
  const years = Math.floor(months / 12), rest = months % 12;
  if (years === 0) return plural(rest, 'MONAT', 'MONATE');
  return `${plural(years, 'JAHR', 'JAHRE')}, ${plural(rest, 'MONAT', 'MONATE')}`;
}

function formatDate(release) {
  const [y, m, d] = release.date.split('-');
  if (release.precision === 'day') return `${d}.${m}.${y}`;
  if (release.precision === 'month') return `${m}/${y}`;
  return y;
}

function showSong(r) {
  els.artist.textContent = r.artist;
  els.title.textContent = r.title;
  els.artist.title = r.artist;
  els.title.title = r.title;
  if (r.release) {
    els.released.textContent = `RELEASED: ${r.release.date.slice(0, 4)} (${ageText(r.release)})`;
    els.released.title = `Erstveröffentlichung: ${formatDate(r.release)} (Quelle: ${r.release.source})`;
  } else {
    els.released.textContent = 'RELEASED: UNBEKANNT';
    els.released.title = '';
  }
  els.card.classList.remove('stale', 'flash');
  void els.card.offsetWidth;
  els.card.classList.add('flash');
  document.title = `${r.artist} - ${r.title}`;
}

function addHistory(r) {
  const li = document.createElement('li');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const what = document.createElement('span');
  what.className = 'what';
  what.textContent = `${r.artist} – ${r.title}`;
  const year = document.createElement('span');
  year.className = 'year';
  year.textContent = r.release ? r.release.date.slice(0, 4) : '';
  li.append(time, what, year);
  els.history.prepend(li);
  while (els.history.children.length > HISTORY_MAX) els.history.lastChild.remove();
  els.historyBox.hidden = false;
}

// ---------- Audio ----------

// Einfaches Downsampling mit Mittelwertbildung (wirkt zugleich als Tiefpass)
function pushSamples(input, inRate) {
  const ratio = inRate / TARGET_RATE;
  let pos = resampleCarry.pos; // fraktionale Startposition im aktuellen Block
  let peak = 0;
  while (pos + ratio <= input.length) {
    const a = Math.floor(pos), b = Math.floor(pos + ratio);
    let sum = 0;
    for (let i = a; i < b; i++) sum += input[i];
    let v = sum / Math.max(1, b - a);
    if (v > 1) v = 1; else if (v < -1) v = -1;
    const av = v < 0 ? -v : v;
    if (av > peak) peak = av;
    ring[ringPos] = v * 32767;
    ringPos = (ringPos + 1) % ring.length;
    if (ringFilled < ring.length) ringFilled++;
    pos += ratio;
  }
  resampleCarry.pos = pos - input.length;
  if (resampleCarry.pos < 0) resampleCarry.pos = 0;
  levelPeak = Math.max(levelPeak * 0.85, peak);
}

// Letzte n Sekunden aus dem Ringpuffer holen
function lastSeconds(sec) {
  const n = Math.min(ringFilled, TARGET_RATE * sec);
  const out = new Int16Array(n);
  let start = (ringPos - n + ring.length) % ring.length;
  for (let i = 0; i < n; i++) out[i] = ring[(start + i) % ring.length];
  return out;
}

function rms(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i] / 32768; s += v * v; }
  return Math.sqrt(s / (samples.length || 1));
}

function meterLoop() {
  if (!running) { els.meter.style.width = '0'; return; }
  els.meter.style.width = Math.min(100, Math.round(Math.sqrt(levelPeak) * 100)) + '%';
  requestAnimationFrame(meterLoop);
}

async function startWith(getStream) {
  await stop();
  try {
    stream = await getStream();
    if (!stream.getAudioTracks().length) throw new Error('Die gewählte Quelle liefert keinen Ton.');
    stream.getVideoTracks().forEach(t => t.stop());
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule('capture-worklet.js');
    source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    worklet = new AudioWorkletNode(ctx, 'capture-processor');
    worklet.port.onmessage = e => pushSamples(e.data, ctx.sampleRate);
    source.connect(worklet);
    // Worklet muss am Graph hängen, damit process() läuft – stumm schalten
    const mute = ctx.createGain(); mute.gain.value = 0;
    worklet.connect(mute).connect(ctx.destination);
    stream.getAudioTracks()[0].addEventListener('ended', () => { stop(); setStatus('Audioquelle wurde beendet', 'error'); });

    running = true;
    ringPos = 0; ringFilled = 0; resampleCarry.pos = 0; misses = 0;
    els.start.textContent = 'Stopp';
    els.start.classList.add('stop');
    setStatus('Hört zu …', 'listening');
    meterLoop();
    schedule(RETRY_SEARCH_SEC + 1);
    await fillDevices();
  } catch (e) {
    await stop();
    setStatus(errorText(e), 'error');
  }
}

function errorText(e) {
  if (e && e.name === 'NotAllowedError') return 'Zugriff auf Audio verweigert – bitte im Browser erlauben';
  if (e && e.name === 'NotFoundError') return 'Keine Audioquelle gefunden';
  if (e && e.name === 'NotSupportedError') return 'Dieser Browser unterstützt die Quelle nicht';
  return (e && e.message) || 'Unbekannter Fehler';
}

async function stop() {
  running = false;
  clearTimeout(timer);
  if (worklet) { worklet.port.onmessage = null; worklet.disconnect(); worklet = null; }
  if (source) { source.disconnect(); source = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (ctx) { try { await ctx.close(); } catch { /* egal */ } ctx = null; }
  els.start.textContent = 'Start';
  els.start.classList.remove('stop');
  setStatus('Gestoppt', '');
}

function micStream() {
  const id = els.device.value;
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: id ? { exact: id } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    },
  });
}

function systemStream() {
  if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Systemaudio wird von diesem Browser nicht unterstützt');
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
}

async function fillDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const saved = store.get('deviceId') || '';
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  const keep = els.device.value || saved;
  els.device.replaceChildren();
  const def = new Option('Standard-Mikrofon', '');
  els.device.add(def);
  devices.forEach((d, i) => {
    if (d.deviceId === 'default' || d.deviceId === '') return;
    els.device.add(new Option(d.label || `Eingang ${i + 1}`, d.deviceId));
  });
  if ([...els.device.options].some(o => o.value === keep)) els.device.value = keep;
}

// ---------- Erkennung ----------

function schedule(sec) {
  clearTimeout(timer);
  if (running) timer = setTimeout(attempt, sec * 1000);
}

async function attempt() {
  if (!running || inFlight) return;
  const samples = lastSeconds(WINDOW_SEC);
  if (samples.length < TARGET_RATE * 4) return schedule(2);
  if (rms(samples) < SILENCE_RMS) {
    setStatus('Stille – warte auf Musik …', 'listening');
    return schedule(RETRY_SEARCH_SEC);
  }

  inFlight = true;
  setStatus('Erkenne …', 'busy');
  let next = RETRY_SEARCH_SEC;
  try {
    const res = await fetch('api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: samples.buffer,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
    if (!running) return;

    if (data.match) {
      misses = 0;
      const changed = !current || current.key !== data.key;
      current = data;
      showSong(data);
      if (changed) addHistory(data);
      setStatus('Erkannt – hört weiter zu …', 'listening');
      next = RECHECK_MATCH_SEC;
    } else {
      misses++;
      if (current && misses >= STALE_AFTER_MISSES) els.card.classList.add('stale');
      setStatus(current ? 'Kein neuer Song erkannt – hört weiter zu …' : 'Noch kein Treffer – hört weiter zu …', 'listening');
    }
  } catch (e) {
    if (running) setStatus(errorText(e), 'error');
    next = RETRY_SEARCH_SEC * 2;
  } finally {
    inFlight = false;
    schedule(next);
  }
}

// ---------- Bedienung ----------

els.start.addEventListener('click', () => (running ? stop() : startWith(micStream)));
els.system.addEventListener('click', () => startWith(systemStream));
els.device.addEventListener('change', () => {
  store.set('deviceId', els.device.value);
  if (running) startWith(micStream);
});

// Alter jede Stunde aktualisieren, falls die Seite lange offen ist
setInterval(() => { if (current) els.released.textContent = current.release ? `RELEASED: ${current.release.date.slice(0, 4)} (${ageText(current.release)})` : 'RELEASED: UNBEKANNT'; }, 3600 * 1000);

if (!window.isSecureContext || !navigator.mediaDevices) {
  setStatus('Audiozugriff nur über http://localhost oder https möglich', 'error');
  els.start.disabled = els.system.disabled = true;
} else {
  if (!navigator.mediaDevices.getDisplayMedia || /firefox/i.test(navigator.userAgent)) els.system.hidden = true;
  fillDevices().catch(() => {});
}
