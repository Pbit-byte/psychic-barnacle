const fs = require('fs');
const path = require('path');
const magma = require('./magma');

// ==========================================
// Catálogos MAGMA: canales de la lista (src/data/magma.m3u) agrupados por tema (Discovery, History...).
// Se definen en src/data/magma_catalogs.json -- sin tocar código:
//   { "id": "discovery", "name": "MAGMA - Discovery", "match": ["^discovery"], "poster": "" }
//   "match"  = expresiones regulares (sin distinguir mayúsculas) que se prueban contra el NOMBRE del canal.
//   "poster" = (opcional) URL de una imagen para todos los canales de ese catálogo.
// Un canal con varias fuentes en la lista (mismo nombre) aparece UNA vez y reúne todas sus opciones.
// Los .m3u8 son directos: no pasan por el proxy (salvo MAGMA_PROXY=1), igual que MAGMA en los eventos.
// Imágenes por canal: src/data/magma_posters.json  { "Discovery Turbo": "https://.../logo.png", ... }
//   (se busca por el nombre del canal; si falta, se usa el "poster" del catálogo; si tampoco hay, sin imagen).
//   Las imágenes se ajustan a un cuadrado con images.weserv.nl, igual que los canales de LA18HD (MAGMA_POSTER_FIT=0 lo desactiva).
// DISABLE_MAGMA=1 los oculta. MAGMA_CATALOGS_FILE=ruta usa otro archivo de definición.
// ==========================================

const PREFIX = 'magma';
const FILE = process.env.MAGMA_CATALOGS_FILE || path.join(__dirname, '..', 'data', 'magma_catalogs.json');

function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}
// clave de canal: "Discovery Theater HD" y "Discovery Theater" son el mismo canal
function channelKey(name) {
  return fold(name).replace(/\bhd\b/g, ' ').replace(/[^a-z0-9]+/g, '');
}

const POSTERS_FILE = process.env.MAGMA_POSTERS_FILE || path.join(__dirname, '..', 'data', 'magma_posters.json');
let _posters = null;
function posters() {
  if (_posters) return _posters;
  _posters = {};
  try {
    const o = JSON.parse(fs.readFileSync(POSTERS_FILE, 'utf8'));
    for (const [name, url] of Object.entries(o || {})) {
      if (typeof url === 'string' && /^https:\/\/\S+$/.test(url)) _posters[channelKey(name)] = url; // solo https; vacío = sin imagen
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(`[magma-catalog] magma_posters.json inválido: ${e.message}`);
  }
  return _posters;
}
// cuadrado con fondo oscuro (los logos suelen ser apaisados); ya hecho si la URL es de weserv
function fitSquare(url) {
  if (process.env.MAGMA_POSTER_FIT === '0' || /^https:\/\/images\.weserv\.nl\//.test(url)) return url;
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=300&h=300&fit=contain&bg=1a1a2eff`;
}

let _cats = null;
function catalogs() {
  if (_cats) return _cats;
  _cats = [];
  if (magma.DISABLED) return _cats;
  let defs = [];
  try {
    defs = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.log(`[magma-catalog] no se pudo leer ${FILE}: ${e.message}`);
    return _cats;
  }
  const entries = magma.load();
  for (const d of Array.isArray(defs) ? defs : []) {
    if (!d || !/^[a-z0-9_-]{1,30}$/.test(String(d.id || '')) || typeof d.name !== 'string') continue;
    const rxs = [];
    for (const m of Array.isArray(d.match) ? d.match : []) {
      try { rxs.push(new RegExp(String(m).slice(0, 80), 'i')); } catch (e) { console.log(`[magma-catalog] regex inválida en "${d.id}": ${m}`); }
    }
    if (!rxs.length) continue;
    const byKey = new Map();
    for (const e of entries) {
      const f = fold(e.name);
      if (!rxs.some((r) => r.test(f))) continue;
      const k = channelKey(e.name);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, { name: e.name.replace(/\s*\|.*$/, '').trim(), entries: [] });
      byKey.get(k).entries.push(e);
    }
    const channels = [...byKey.values()];
    if (!channels.length) { console.log(`[magma-catalog] "${d.id}" no tiene canales en la lista; no se publica`); continue; }
    _cats.push({ id: d.id, manifestId: `magma-${d.id}`, title: d.name.slice(0, 60), poster: typeof d.poster === 'string' && /^https:\/\//.test(d.poster) ? d.poster : '', channels });
  }
  console.log(`[magma-catalog] ${_cats.length} catálogo(s): ${_cats.map((c) => `${c.id}=${c.channels.length}`).join(', ')}`);
  return _cats;
}

function toId(catId, name) {
  return `${PREFIX}:${Buffer.from(JSON.stringify({ c: catId, n: name })).toString('base64url')}`;
}
function fromId(id) {
  try {
    const o = JSON.parse(Buffer.from(String(id).slice(PREFIX.length + 1), 'base64url').toString('utf8'));
    return typeof o.c === 'string' && typeof o.n === 'string' ? o : null;
  } catch (e) { return null; }
}
function metaOf(cat, ch) {
  const m = { id: toId(cat.id, ch.name), type: 'tv', name: ch.name, posterShape: 'square' };
  const raw = posters()[channelKey(ch.name)] || cat.poster; // imagen del canal; si no hay, la del catálogo
  if (raw) { const img = fitSquare(raw); m.poster = img; m.background = img; m.logo = img; }
  return m;
}
function find(id) {
  const o = fromId(id);
  if (!o) return null;
  const cat = catalogs().find((c) => c.id === o.c);
  const ch = cat && cat.channels.find((x) => x.name === o.n);
  return ch ? { cat, ch } : null;
}

// Proveedor para el catálogo `cat` (lo que index.js espera: getCatalog() y search(q)).
function providerFor(cat) {
  return {
    getCatalog: async () => cat.channels.map((ch) => metaOf(cat, ch)),
    search: async (q) => {
      const t = fold(q);
      return cat.channels.filter((ch) => fold(ch.name).includes(t)).map((ch) => metaOf(cat, ch));
    },
  };
}

async function getMeta(id) {
  const f = find(id);
  return f ? metaOf(f.cat, f.ch) : null;
}

async function getStreams(id) {
  const f = find(id);
  if (!f) return [];
  const list = f.ch.entries.slice(0, magma.PER_SOURCE).map(magma.toStream);
  return magma.numberDuplicates(list);
}

module.exports = { PREFIX, catalogs, providerFor, getMeta, getStreams, _channelKey: channelKey };
