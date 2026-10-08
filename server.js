// Musikerkennung – lokaler Server
// Nimmt Audio (16 kHz, mono, s16le) vom Browser entgegen, erkennt den Song via Shazam
// und ermittelt das Erstveröffentlichungsdatum über iTunes + MusicBrainz.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Shazam, s16LEToSamplesArray } = require('shazam-api');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 16000 * 2 * 15; // max. 15 s Audio
const USER_AGENT = 'musicrecognition/1.0 (interne Anwendung)';

const shazam = new Shazam('Europe/Berlin');
const releaseCache = new Map(); // shazamKey -> { date, precision }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// ---------- Hilfsfunktionen ----------

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
}

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Vergleichbare Form: Kleinbuchstaben, ohne Klammerzusätze (Remastered, Live, feat. ...), ohne Sonderzeichen
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$/i, '')
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Hauptkünstler (vor "feat.", "&", ",", "x")
function mainArtist(s) {
  return String(s || '').split(/\s+(?:feat\.?|ft\.?|featuring|&|x|und|and)\s+|,/i)[0].trim();
}

function artistMatches(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function titleMatches(a, b) {
  const na = norm(a), nb = norm(b);
  return !!na && na === nb;
}

// Datum-Kandidat: { date: 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY', precision: 'day'|'month'|'year', source }
function candidate(str, source) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(str || ''));
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1900 || y > new Date().getFullYear() + 1) return null;
  if (m[3]) return { date: `${m[1]}-${m[2]}-${m[3]}`, precision: 'day', source };
  if (m[2]) return { date: `${m[1]}-${m[2]}`, precision: 'month', source };
  return { date: m[1], precision: 'year', source };
}

async function itunesDates(artist, title) {
  const term = `${mainArtist(artist)} ${String(title).replace(/\s*[\(\[].*?[\)\]]/g, '')}`;
  const url = `https://itunes.apple.com/search?entity=song&limit=50&country=de&term=${encodeURIComponent(term)}`;
  const j = await fetchJson(url);
  return (j.results || [])
    .filter(r => artistMatches(r.artistName, mainArtist(artist)) && titleMatches(r.trackName, title))
    .map(r => candidate(r.releaseDate, 'iTunes'))
    .filter(Boolean);
}

async function musicbrainzDates(artist, title) {
  const cleanTitle = String(title).replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/"/g, '');
  const q = `recording:"${cleanTitle}" AND artist:"${mainArtist(artist).replace(/"/g, '')}"`;
  const url = `https://musicbrainz.org/ws/2/recording?fmt=json&limit=25&query=${encodeURIComponent(q)}`;
  const j = await fetchJson(url);
  return (j.recordings || [])
    .filter(r => r.score >= 85 && titleMatches(r.title, title))
    .filter(r => (r['artist-credit'] || []).some(c => artistMatches(c.name || c.artist?.name, mainArtist(artist))))
    .map(r => candidate(r['first-release-date'], 'MusicBrainz'))
    .filter(Boolean);
}

// Frühestes plausibles Datum wählen. Genauere Angaben gewinnen, wenn sie im selben Jahr liegen.
function pickEarliest(cands) {
  if (!cands.length) return null;
  const minYear = Math.min(...cands.map(c => Number(c.date.slice(0, 4))));
  const sameYear = cands.filter(c => Number(c.date.slice(0, 4)) === minYear);
  const rank = { day: 3, month: 2, year: 1 };
  const bestPrecision = Math.max(...sameYear.map(c => rank[c.precision]));
  return sameYear
    .filter(c => rank[c.precision] === bestPrecision)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
}

async function findReleaseDate(key, artist, title, shazamYear) {
  if (key && releaseCache.has(key)) return releaseCache.get(key);
  const results = await Promise.allSettled([itunesDates(artist, title), musicbrainzDates(artist, title)]);
  const cands = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  results.forEach((r, i) => r.status === 'rejected' && console.warn(`[release] ${i ? 'MusicBrainz' : 'iTunes'}: ${r.reason?.message}`));
  const sy = candidate(shazamYear, 'Shazam');
  if (sy) cands.push(sy);
  const best = pickEarliest(cands);
  if (key && best && results.every(r => r.status === 'fulfilled')) releaseCache.set(key, best);
  return best;
}

// ---------- Erkennung ----------

async function recognize(buf) {
  const samples = s16LEToSamplesArray(buf);
  const r = await shazam.fullRecognizeSong(samples);
  if (!r || !r.track) return { match: false };

  const t = r.track;
  const songSection = (t.sections || []).find(s => s.type === 'SONG');
  const meta = k => songSection?.metadata?.find(m => m.title === k)?.text;
  const artist = t.subtitle || '';
  const title = t.title || '';

  const release = await findReleaseDate(t.key, artist, title, meta('Released'));
  return {
    match: true,
    key: t.key || null,
    artist,
    title,
    album: meta('Album') || null,
    release, // { date, precision, source } | null
  };
}

// ---------- HTTP ----------

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/recognize') {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { sendJson(res, 413, { error: 'Audio zu lang' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      const buf = Buffer.concat(chunks);
      if (buf.length < 16000 * 2 * 3) return sendJson(res, 400, { error: 'Audio zu kurz (min. 3 s)' });
      try {
        const result = await recognize(buf);
        if (result.match) console.log(`[match] ${result.artist} – ${result.title} (${result.release?.date || '?'} via ${result.release?.source || '-'})`);
        sendJson(res, 200, result);
      } catch (e) {
        console.error('[recognize]', e.message);
        sendJson(res, 502, { error: 'Erkennungsdienst nicht erreichbar' });
      }
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  sendJson(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, HOST, () => {
  console.log(`Musikerkennung läuft: http://localhost:${PORT}/`);
});
