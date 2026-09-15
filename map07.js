/* ---- GIELINOR (map07.js) ------------------------------------------------------------------------------------
   The curated 2007 map, played instead of a seed. Terrain, scenery, doors, stairs, spawns and ground items stream
   out of the osrs-r2 transcode tree (OSRSK.OUT — the one place its base is named) exactly the way
   ../osrs-r2/viewer/viewer.js draws them, rebuilt for this renderer: three r128, one tile = one unit, north = -z,
   a tile's centre on the integer (OSRS tile gx,gy is seedworld tile x = gx, z = -gy). Nothing Jagex-format is
   decoded here; this file reads the atoms (../osrs-r2/GUIDE.md) plus the four tables the viewer's build scripts derive
   (assets/map07/, rebuilt by tools/map07/): which squares exist, the NPC + item spawns, door pairs, transports — plus
   roofs.json, this game's own: the blank roof kits and the models they borrow.

   What the viewer never needed and a game does: collision. Walls block their tile EDGE, objects their footprint,
   floor flags their tile, per render plane (a bridge deck collides one plane down), exactly the client's
   CollisionMap — with the viewer's own exception that an openable wall (a door, a gate, a curtain) never blocks, so
   no client can disagree with another about whether a door is shut. Everything else a game needs of the map —
   heights, line of sight, picking, transports, the minimap's colours — is a query on the regions loaded.

   Where the viewer drew the map wrong, this file draws it the client's way instead: roof kits this cache ships as blank
   black quads borrow their sibling kit's models (roofs.json); translucent faces blend instead of standing solid; tiles
   are cut by their overlay shape and underlays blend over their neighbours; textured overlays wear their texture; locs
   whose def asks for it follow the ground under every vertex (contouredGround) from the height at their middle; faces are
   one-sided, and a face the client paints over a coplanar one is lifted clear of it (layerFaces), so detail laid flat on
   a banner, a board or a wall never flickers; wall decorations stand off the wall they hang on (decorDisplacement), a
   corner wall's first leg is mirrored so its mitres meet, and nothing under a bridge deck collides with the deck above.

   Behind one global, MAP07; nothing runs until load(). game.js section 46 is the whole of the wiring: it classifies
   the scenery into its own object kinds (a tree is a tree to woodcutting), turns spawns into monsters and draws the
   maps; this file only knows the map. Lights: the viewer's Lambert pair (ambient 0.65 + a 0.9 sun), added to the
   scene and switched on only while the map is up — every seedworld material is unlit, so nothing else sees them. ---- */
const MAP07 = (() => {
'use strict';

const OUT = OSRSK.OUT, DATA = OSRSK.SITE + 'assets/map07';
const BRIGHT = 0.7;                  /* the viewer's palette exponent for model faces */
const U = 1 / 128;                   /* cache units -> tiles */
const MODEL_MAX = 7000;              /* parsed model records kept before trimming the oldest (a trimmed one just refetches) */
const PLAYER_STAND = 808, PLAYER_WALK = 819;   /* the client's default player pose sequences; bipeds with none borrow them */

/* collision flags (the client's CollisionMap bits); projectile twins are the movement bits << 9 */
const F_NW = 1, F_N = 2, F_NE = 4, F_E = 8, F_SE = 16, F_S = 32, F_SW = 64, F_W = 128, F_OBJ = 256;
const P_OBJ = F_OBJ << 9, F_DECO = 0x40000, F_FLOOR = 0x200000, F_FULL = F_OBJ | F_DECO | F_FLOOR;

let scene = null, fogCenter = null, H = {};
let root = null, planeG = null, amb = null, sun = null, bright = 1;
let loading = null, loaded = false, active = false;
let underlays = {}, overlays = {}, textures = {};
const manifest = new Set(), doorPairs = new Map(), spawnsByRegion = new Map();
let transByLoc = {}, itemSpawns = [], resolveItem = {}, resolveLoc = {}, worldImg = null;
let roofFix = {};   /* loc id -> { as, m: { shape: model } }: roof kits this cache ships blank borrow a sibling's models (roofs.json) */

const getJson = url => fetch(url).then(r => r.ok ? r.json() : Promise.reject(new Error(url + ' -> HTTP ' + r.status)));
const getBin = url => fetch(url).then(r => r.ok ? r.arrayBuffer() : Promise.reject(Object.assign(new Error(url + ' -> HTTP ' + r.status), { status: r.status })));
/* an answer (a missing or broken file) vs a blip (no connection, a server error): only answers are remembered */
const transient = e => e instanceof TypeError || (e && e.status >= 500);
/* a frame's breath between region builds; the timer backs the frame up, since an occluded window can starve rAF without ever reporting itself hidden */
const nextFrame = () => new Promise(r => { let done = 0; const go = () => { if (!done) { done = 1; r(); } }; if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(go); setTimeout(go, 50); });
const clean = s => (typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim() : '');
const opsOf = def => Object.entries((def && def.ops) || {}).filter(([, o]) => o && o.text).sort(([a], [b]) => a - b).map(([, o]) => clean(o.text));

/* ---- assets: config shards come through OSRSK's cache (one download, one parsed copy for the whole game); atoms, frames
   and textures load here. Nothing that failed for a passing reason is remembered: the next build asks again. ---- */
const shardP = new Map(), shardE = new Map(), modelM = new Map(), fmP = new Map(), faP = new Map(), texMats = new Map(), texMatsT = new Map(), texMatsG = new Map(), texMaps = new Map();
const WHITE = [1, 1, 1];
const mended = new WeakSet();
function shard(type, s) {
  const key = type + '/' + s;
  let p = shardP.get(key);
  if (!p) {
    p = OSRSK.cfgShard(type, s).then(e => {
      if (type === 'loc' && !mended.has(e)) {   /* the shared entries are mended once: the blank roof kits borrow their sibling's models */
        mended.add(e);
        for (const id in e) { const f = roofFix[id], d = e[id]; if (f && d.models) d.models = d.models.map(q => f.m[q.shape] !== undefined ? { model: f.m[q.shape], shape: q.shape } : q); }
      }
      shardE.set(key, e);
      return e;
    });
    shardP.set(key, p); p.catch(() => shardP.delete(key));
  }
  return p;
}
async function defs(type, ids) {   /* sharded on-demand defs; shard = floor(id/256) */
  const out = {}, shards = [...new Set([...ids].filter(i => i >= 0).map(i => (i / 256) | 0))];
  await Promise.all(shards.map(async s => Object.assign(out, await shard(type, s))));
  return out;
}
const defSync = (type, id) => { const e = shardE.get(type + '/' + ((id / 256) | 0)); return e ? e[id] : undefined; };
async function catalog(type) {      /* the small whole catalogs: underlay, overlay, texture */
  const idx = await getJson(OUT + '/cfg/' + type + '/index.json'), out = {};
  for (const e of await Promise.all(idx.shards.map(s => OSRSK.cfgShard(type, s)))) Object.assign(out, e);
  return out;
}
const modelP = new Map();
/* atoms share 32 lanes, first asked first served: a dozen squares filling in at once never stack hundreds of requests and parses into one moment */
const ATOM_LANES = 32, atomWait = [];
let atomBusy = 0;
const atomSlot = () => atomBusy < ATOM_LANES ? (atomBusy++, Promise.resolve()) : new Promise(r => atomWait.push(r));
const atomFree = () => { const next = atomWait.shift(); if (next) next(); else atomBusy--; };
function models(ids) {
  const ps = [];
  for (const id of ids) {
    if (!(id >= 0)) continue;
    if (modelM.has(id)) { const m = modelM.get(id); modelM.delete(id); modelM.set(id, m); continue; }   /* a hit moves to the back: the trim drops the least recently used */
    let p = modelP.get(id);
    if (!p) {
      p = atomSlot().then(() => getBin(OUT + '/m/' + id + '.bin')).then(parseModel).then(m => { modelM.set(id, m); }, e => { if (!transient(e)) modelM.set(id, null); })   /* a missing or broken atom is an answer (null); a blip is asked again */
        .then(() => { atomFree(); modelP.delete(id); });
      modelP.set(id, p);
    }
    ps.push(p);
  }
  return Promise.all(ps);
}
const modelsMissing = ids => { for (const id of ids) if (id >= 0 && !modelM.has(id)) return true; return false; };
const pinned = new Set(), pinN = new Map();   /* pinned: the stumps, for good; pinN: models a live square or a figure mid-build still needs */
const pin = ids => { for (const id of ids) pinN.set(id, (pinN.get(id) || 0) + 1); };
const unpin = ids => { for (const id of ids) { const n = (pinN.get(id) || 0) - 1; if (n > 0) pinN.set(id, n); else pinN.delete(id); } };
function trimModels() {   /* only between builds: a model a build is about to read must never vanish under it */
  if (modelM.size <= MODEL_MAX) return;
  let drop = modelM.size - ((MODEL_MAX * 0.8) | 0);
  for (const key of modelM.keys()) { if (drop <= 0) break; if (!pinned.has(key) && !pinN.has(key)) { modelM.delete(key); drop--; } }
}
const model = id => modelM.get(id);
const framemap = id => { let p = fmP.get(id); if (!p) { p = getBin(OUT + '/fm/' + id + '.bin').then(parseFramemap); fmP.set(id, p); p.catch(() => fmP.delete(id)); } return p; };
const frameArchive = id => {
  let p = faP.get(id);
  if (!p) { p = getBin(OUT + '/a/' + id + '.bin').then(async b => { const fa = parseFrames(b); fa.fm = await framemap(fa.framemapId); return fa; }); faP.set(id, p); p.catch(() => faP.delete(id)); }
  return p;
};
/* a texture's image, and the materials waiting on it: until it lands a material wears the texture's average colour, never the
   black of an empty map; a failed image keeps that colour and the next material to ask tries again */
function texMap(id) {
  let t = texMaps.get(id);
  if (!t) {
    t = { tex: null, mats: [] };
    texMaps.set(id, t);
    new THREE.TextureLoader().load(OUT + '/tx/' + id + '.png', tex => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      t.tex = tex;
      for (const m of t.mats) { m.map = tex; m.color.setRGB(1, 1, 1); m.needsUpdate = true; }
      t.mats.length = 0;
    }, undefined, () => { if (texMaps.get(id) === t) texMaps.delete(id); });
  }
  return t;
}
function texMat(cache, id, make) {
  let m = cache.get(id);
  if (!m) {
    const t = texMap(id);
    m = make(t.tex);
    if (!t.tex) { const c = textures[id] ? rgbI(textures[id].avgRgbAdjusted) : WHITE; m.color.setRGB(c[0], c[1], c[2]); t.mats.push(m); }
    cache.set(id, m);
  }
  return m;
}
/* every model face is one-sided, as the client draws it: it culls a face turned away, and modellers double a face that must
   show from both sides — drawn two-sided, that back-to-back pair fights itself, and the hidden half costs a fill for nothing */
const texMaterial = id => texMat(texMats, id, map => new THREE.MeshLambertMaterial({ map, side: THREE.FrontSide, alphaTest: 0.4 }));
/* a translucent textured face: the texture times its vertex alpha, drawn after the solid world without writing depth,
   pulled a hair toward the eye so a wash laid flat on the floor never fights the floor */
const texMaterialT = id => texMat(texMatsT, id, map => new THREE.MeshLambertMaterial({ map, side: THREE.FrontSide, vertexColors: true, transparent: true, depthWrite: false, alphaTest: 0.01, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));

/* ---- atoms (little-endian; ../osrs-r2/GUIDE.md) ---- */
const magic = dv => String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
function parseTerrain(buf) {   /* OSTR v1 */
  const dv = new DataView(buf);
  if (magic(dv) !== 'OSTR' || dv.getUint8(4) !== 1) throw new Error('bad OSTR atom');
  let o = 9;
  const cut = n => buf.slice(o, (o += n));
  const r = { sqX: dv.getUint16(5, true), sqY: dv.getUint16(7, true),
    H: new Int16Array(cut(32768)), UL: new Uint16Array(cut(32768)), OL: new Uint16Array(cut(32768)), SR: new Uint8Array(cut(16384)), FL: new Uint8Array(cut(16384)) };
  r.bridge = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) r.bridge[i] = r.FL[4096 + i] & 2 ? 1 : 0;
  return r;
}
function parseLocs(buf) {      /* OSLC v1 */
  const dv = new DataView(buf);
  if (magic(dv) !== 'OSLC' || dv.getUint8(4) !== 1) throw new Error('bad OSLC atom');
  const n = dv.getUint32(5, true), out = new Array(n);
  for (let i = 0, o = 9; i < n; i++, o += 9) out[i] = { id: dv.getUint32(o, true), plane: dv.getUint8(o + 4), x: dv.getUint8(o + 5), y: dv.getUint8(o + 6), type: dv.getUint8(o + 7), rot: dv.getUint8(o + 8) };
  return out;
}
const M_TYPES = 1, M_ALPHA = 2, M_PRIOS = 4, M_TEX = 8, M_TCOORD = 16, M_VGROUP = 32;
function parseModel(buf) {     /* m/<id>.bin record */
  const dv = new DataView(buf);
  const vc = dv.getUint16(0, true), fc = dv.getUint16(2, true), ttc = dv.getUint16(4, true), flags = dv.getUint8(6);
  let o = 8;
  const at = n => (o += n) - n;   /* views into the fetched buffer, not copies: every field lands on an even offset */
  const verts = new Int16Array(buf, at(vc * 6), vc * 3), idx = new Uint16Array(buf, at(fc * 6), fc * 3), colors = new Uint16Array(buf, at(fc * 2), fc);
  const texs = flags & M_TEX ? new Uint16Array(buf, at(fc * 2), fc) : null;
  const ttri = ttc ? new Uint16Array(buf, at(ttc * 6), ttc * 3) : null;   /* texture triangles (P, M, N): the plane a textured face's texture lies in */
  const types = flags & M_TYPES ? new Int8Array(buf, at(fc), fc) : null;
  const alphas = flags & M_ALPHA ? new Uint8Array(buf, at(fc), fc) : null;
  const prios = flags & M_PRIOS ? new Uint8Array(buf, at(fc), fc) : null;
  const tcoords = flags & M_TCOORD ? new Int8Array(buf, at(fc), fc) : null;   /* each face's texture triangle, -1 for its own corners */
  const ttypes = ttc ? new Uint8Array(buf, at(ttc), ttc) : null;   /* 0 planar; the cylinder and cube kinds map as the face's own */
  const vgroups = flags & M_VGROUP ? new Uint8Array(buf, at(vc), vc) : null;
  return layerFaces({ vc, fc, verts, idx, colors, texs, types, alphas, prios, vgroups, ttri, tcoords, ttypes });
}
/* a textured face's texture coordinates as the client maps them, into uv[o..o+5] for its corners in drawn order (i0, 1, i2): each
   corner projected onto the plane of its texture triangle, u along M - P and v along N - P, the texture's top row at v 0 — the
   triangle the model names (a fountain's spray, a banner's cloth, a window's pane laid across many faces), else the face's own
   corners. Model space: a turn or a mirror moves the corners and their triangle together */
function faceUV(m, f, i0, i2, uv, o) {
  const V = m.verts, I = m.idx, tc = m.tcoords ? m.tcoords[f] : -1;
  let p = I[f * 3] * 3, q = I[f * 3 + 1] * 3, r = I[f * 3 + 2] * 3;
  if (tc >= 0 && m.ttri && tc * 3 + 2 < m.ttri.length && (!m.ttypes || m.ttypes[tc] === 0)) { p = m.ttri[tc * 3] * 3; q = m.ttri[tc * 3 + 1] * 3; r = m.ttri[tc * 3 + 2] * 3; }
  else if (i0) { const s = p; p = r; r = s; }   /* the client's mirror starts a face's own triangle from its swapped corner */
  const Px = V[p], Py = V[p + 1], Pz = V[p + 2], Ux = V[q] - Px, Uy = V[q + 1] - Py, Uz = V[q + 2] - Pz, Wx = V[r] - Px, Wy = V[r + 1] - Py, Wz = V[r + 2] - Pz;
  const nx = Uy * Wz - Uz * Wy, ny = Uz * Wx - Ux * Wz, nz = Ux * Wy - Uy * Wx;
  const ax = Wy * nz - Wz * ny, ay = Wz * nx - Wx * nz, az = Wx * ny - Wy * nx, bx = ny * Uz - nz * Uy, by = nz * Ux - nx * Uz, bz = nx * Uy - ny * Ux;
  const du = Ux * ax + Uy * ay + Uz * az, dv = Wx * bx + Wy * by + Wz * bz;
  for (const k of [i0, 1, 2 - i0]) {
    const s = I[f * 3 + k] * 3, dx = V[s] - Px, dy = V[s + 1] - Py, dz = V[s + 2] - Pz;
    uv[o++] = du ? (dx * ax + dy * ay + dz * az) / du : k === 1 ? 1 : 0;
    uv[o++] = 1 - (dv ? (dx * bx + dy * by + dz * bz) / dv : k === i0 ? 0 : k === 1 ? 0 : 1);
  }
}
const uvTmp = new Float32Array(6);
const texAvgs = new Map();
const texAvg = tid => { let c = texAvgs.get(tid); if (!c) texAvgs.set(tid, c = textures[tid] ? rgbI(textures[tid].avgRgbAdjusted) : WHITE); return c; };   // a texture seen from afar
/* the client never draws render-type-2 faces nor alpha-255 ones: modellers use them for hidden helper geometry */
const faceHidden = (m, f) => (m.types !== null && m.types[f] === 2) || (m.alphas !== null && m.alphas[f] > 250);

/* ---- the painter's order, kept in a depth buffer ----
   OSRSK.faceLifts (osrs.js says why) names each face the client paints over a coplanar face it overlaps, and how far along
   its normal it must rise to stay on top; here that face gets vertices of its own, once, as the model is parsed, so every
   placement, figure and ground item built from it keeps the order. The map's faces are flat-lit, so nothing else notices. */
function layerFaces(m) {
  const offs = m.fc > 1 ? OSRSK.faceLifts(m.verts, m.idx, m.fc, m.prios, f => faceHidden(m, f)) : null;
  if (!offs) return m;
  const V = m.verts, I = m.idx;
  const vc = m.vc + offs.size * 3, verts = new Int16Array(vc * 3), idx = vc > 65536 ? new Uint32Array(I) : new Uint16Array(I);
  const vgroups = m.vgroups ? new Uint8Array(vc) : null;
  verts.set(V);
  if (vgroups) vgroups.set(m.vgroups);
  let nv = m.vc;
  for (const [f, [dx, dy, dz]] of offs) {
    for (let k = 0; k < 3; k++) {
      const s = I[f * 3 + k];
      verts[nv * 3] = V[s * 3] + dx; verts[nv * 3 + 1] = V[s * 3 + 1] + dy; verts[nv * 3 + 2] = V[s * 3 + 2] + dz;
      if (vgroups) vgroups[nv] = m.vgroups[s];
      idx[f * 3 + k] = nv++;
    }
  }
  return Object.assign(m, { vc, verts, idx, vgroups });
}
function parseFramemap(buf) {  /* OSFM v1 */
  const dv = new DataView(buf);
  if (magic(dv) !== 'OSFM') throw new Error('bad OSFM');
  const n = dv.getUint16(5, true), types = new Uint8Array(n), labels = [];
  let o = 7;
  for (let g = 0; g < n; g++) {
    types[g] = dv.getUint8(o);
    const lc = dv.getUint16(o + 1, true), ls = new Uint16Array(lc);
    for (let i = 0; i < lc; i++) ls[i] = dv.getUint16(o + 3 + i * 2, true);
    labels.push(ls); o += 3 + lc * 2;
  }
  return { types, labels };
}
function parseFrames(buf) {    /* OSFA v1 */
  const dv = new DataView(buf);
  if (magic(dv) !== 'OSFA') throw new Error('bad OSFA');
  const framemapId = dv.getUint16(5, true), frameCount = dv.getUint16(7, true), byFile = new Map();
  let o = 9;
  for (let f = 0; f < frameCount; f++) {
    const fileId = dv.getUint16(o, true), n = dv.getUint16(o + 2, true);
    o += 4;
    const bases = new Uint16Array(n), ds = new Int16Array(n * 3);
    for (let i = 0; i < n; i++, o += 8) { bases[i] = dv.getUint16(o, true); ds[i * 3] = dv.getInt16(o + 2, true); ds[i * 3 + 1] = dv.getInt16(o + 4, true); ds[i * 3 + 2] = dv.getInt16(o + 6, true); }
    byFile.set(fileId, { bases, ds });
  }
  return { framemapId, byFile };
}

/* ---- sequences: cfg/seq frameIDs ([archive, file] pairs) -> playable frame lists ---- */
const seqs = new Map();   /* seq id -> [{tr, fm, ms}] | null (missing, or skeletal-only) */
async function loadSeqs(ids) {
  const want = [...new Set([...ids].filter(i => i !== undefined && i >= 0 && !seqs.has(i)))];
  if (!want.length) return;
  const d = await defs('seq', want);
  await Promise.all(want.map(async id => {
    const s = d[id];
    if (!s || !s.frameIDs || !s.frameIDs.length) { seqs.set(id, null); return; }
    try {
      const archs = {};
      await Promise.all([...new Set(s.frameIDs.map(f => f[0]))].map(async a => { archs[a] = await frameArchive(a); }));
      const frames = [];
      s.frameIDs.forEach(([a, f], i) => { const tr = archs[a] && archs[a].byFile.get(f); if (tr) frames.push({ tr, fm: archs[a].fm, ms: ((s.frameLengths && s.frameLengths[i]) || 2) * 20 }); });
      seqs.set(id, frames.length ? frames : null);
    } catch (e) { if (!transient(e)) seqs.set(id, null); }   /* a blip leaves it unasked: the next figure asks again */
  }));
}

/* ---- colour: Jagex 16-bit HSL -> RGB (RuneLite JagexColor), the viewer's exponent ---- */
const palC = new Map();
function hsl(v) {
  let c = palC.get(v);
  if (c !== undefined) return c;
  const hue = (v >> 10 & 63) / 64 + 0.0078125, sat = (v >> 7 & 7) / 8 + 0.0625, lum = (v & 127) / 128;
  const ch = (1 - Math.abs(2 * lum - 1)) * sat, x = ch * (1 - Math.abs((hue * 6) % 2 - 1)), l = lum - ch / 2;
  let r = l, g = l, b = l;
  switch ((hue * 6) | 0) { case 0: r += ch; g += x; break; case 1: g += ch; r += x; break; case 2: g += ch; b += x; break; case 3: b += ch; g += x; break; case 4: b += ch; r += x; break; default: r += ch; b += x; }
  const adj = q => Math.min(Math.pow(Math.min((q * 256) | 0, 255) / 256, BRIGHT), 0.999);
  palC.set(v, c = [adj(r), adj(g), adj(b)]);
  return c;
}
const rgbI = v => [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
const texC = new Map();   /* a texture's average colour, made once: a region asks for it on thousands of faces */
const texRGB = tid => { let c = texC.get(tid); if (!c) texC.set(tid, c = rgbI(textures[tid].avgRgbAdjusted)); return c; };
function faceColor(m, f, recol, retex) {
  let tid = m.texs ? m.texs[f] - 1 : -1;
  if (tid >= 0 && retex && retex.has(tid)) tid = retex.get(tid);
  if (tid >= 0 && textures[tid]) return texRGB(tid);
  let c = m.colors[f];
  if (recol && recol.has(c)) c = recol.get(c);
  return hsl(c);
}
function tileColor(ol, ul) {   /* a tile's colour on the maps: an overlay's own map colour first, as the client's minimap takes it */
  if (ol) {
    const d = overlays[ol - 1] || {};
    if (d.secondaryRgbColor !== undefined) return d.secondaryRgbColor;
    if (d.texture !== undefined && textures[d.texture]) return textures[d.texture].avgRgbAdjusted;
    if (d.rgbColor !== 0xff00ff) return d.rgbColor || 0;   /* magenta: transparent, the underlay shows */
  }
  if (ul) { const d = underlays[ul - 1]; if (d) return d.rgb; }
  return -1;
}
function colorMaps(def, bare) {
  let recol = null, retex = null;
  if (!bare && def.recolorFrom) { recol = new Map(); for (let i = 0; i < def.recolorFrom.length; i++) recol.set(def.recolorFrom[i] & 0xffff, def.recolorTo[i] & 0xffff); }
  if (!bare && def.retextureFrom) { retex = new Map(); for (let i = 0; i < def.retextureFrom.length; i++) retex.set(def.retextureFrom[i], def.retextureTo[i]); }
  return { recol, retex };
}

/* ---- the loaded world ---- */
const regions = new Map();   /* rid -> R: terrain grids, collision, meshes, owners, objects */
let lastR = null;
/* a square's id: the cache's own (x << 8 | y) while its y fits the byte — every real square's files are named so — and past that
   range (the made world north of tile 16383 and south of 0) a number of its own, far clear of those. Read back with sqXOf/sqYOf,
   never with shifts, which these ids outgrow */
const RID_FAR = 2 ** 40, RID_B = 2 ** 20, RID_H = 2 ** 19;
const ridSq = (sx, sy) => sy >= 0 && sy <= 255 ? (sx << 8) | sy : RID_FAR + (sx + RID_H) * RID_B + sy + RID_H;
const sqXOf = rid => rid >= RID_FAR ? Math.floor((rid - RID_FAR) / RID_B) - RID_H : rid >> 8;
const sqYOf = rid => rid >= RID_FAR ? (rid - RID_FAR) % RID_B - RID_H : rid & 255;
const ridOf = (gx, gy) => ridSq(gx >> 6, gy >> 6);
function regionAt(gx, gy) {
  if (lastR && gx >> 6 === lastR.sqX && gy >> 6 === lastR.sqY) return lastR;
  const r = regions.get(ridOf(gx, gy));
  if (r && r.ready) lastR = r;
  return r && r.ready ? r : null;
}
const regionRaw = (gx, gy) => regions.get(ridOf(gx, gy)) || null;   /* loading included: collision writes land as soon as a region is parsed */
function cornerH(p, gx, gy, fb) {   /* raw cache height at a tile's SW corner; a missing neighbour clamps into fb */
  const r = regionRaw(gx, gy), b = p * 4096;
  if (r && r.H) return r.H[b + (gx & 63) * 64 + (gy & 63)];
  return fb.H[b + Math.min(Math.max(gx - fb.sqX * 64, 0), 63) * 64 + Math.min(Math.max(gy - fb.sqY * 64, 0), 63)];
}
const bridgeAt = (gx, gy) => { const r = regionRaw(gx, gy); return r && r.bridge ? r.bridge[(gx & 63) * 64 + (gy & 63)] : 0; };
const renderPlane = (plane, gx, gy) => (plane >= 1 && bridgeAt(gx, gy) ? plane - 1 : plane);
/* the plane a placement collides on: a bridge tile moves everything down one, and what stands on the ground beneath a deck
   (the piers, the river's own scenery) drops to -1 and collides nowhere — the client's loadLocs. Colliding on 0 instead, it
   walled off the deck walked above it: Lumbridge's bridge to Al Kharid could not be crossed. */
const clipPlane = (plane, gx, gy) => (bridgeAt(gx, gy) ? plane - 1 : plane);
/* the ground's height in tiles (up) at continuous OSRS tile coords; ground level on a bridge walks the deck above */
function heightAt(plane, fx, fy) {
  const gx = Math.floor(fx), gy = Math.floor(fy), r = regionRaw(gx, gy);
  if (!r || !r.H) return 0;
  if (plane === 0 && bridgeAt(gx, gy)) plane = 1;
  const h00 = cornerH(plane, gx, gy, r), h10 = cornerH(plane, gx + 1, gy, r), h01 = cornerH(plane, gx, gy + 1, r), h11 = cornerH(plane, gx + 1, gy + 1, r);
  const tx = fx - gx, ty = fy - gy;
  return -((h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty) * U;
}
/* seedworld coordinates: x = gx, z = -gy, a tile's centre on the integer */
const yAt = (plane, x, z) => heightAt(plane, x + 0.5, -z + 0.5);

/* ---- collision (the client's CollisionMap, per render plane) ---- */
/* an upper floor's empty air stays walkable, as in the client: its walls fence it, and rooftop courses, platforms and
   spawns stand on tiles that carry no floor of their own */
function flagAt(rp, gx, gy) {
  const r = regionAt(gx, gy);
  if (!r) return F_FULL;
  const f = r.clip[rp * 4096 + (gx & 63) * 64 + (gy & 63)];
  return doorClip.size ? f | doorClip.get((rp * 8192 + gx) * 16384 + gy) : f;   // undefined ors as 0
}
function orFlag(R, rp, gx, gy, f) {   /* a write past R's edge is kept on R and replayed into the neighbour whenever both are up */
  if (rp < 0 || rp > 3 || !f) return;
  const t = regionRaw(gx, gy);
  if (t === R || (t && t.clip)) { t.clip[rp * 4096 + (gx & 63) * 64 + (gy & 63)] |= f; if (t === R) return; }
  if (t !== R) R.ext.push(ridOf(gx, gy), rp * 4096 + (gx & 63) * 64 + (gy & 63), f);
}
function addWall(R, rp, x, y, type, rot, bp) { wallEdges((gx, gy, b) => orFlag(R, rp, gx, gy, bp ? b | (b << 9) : b), x, y, type, rot); }
function wallEdges(f, x, y, type, rot) {   /* f(gx, gy, edge bits) for each tile a wall piece fences */
  if (type === 0) {
    if (rot === 0) { f(x, y, F_W); f(x - 1, y, F_E); } else if (rot === 1) { f(x, y, F_N); f(x, y + 1, F_S); }
    else if (rot === 2) { f(x, y, F_E); f(x + 1, y, F_W); } else { f(x, y, F_S); f(x, y - 1, F_N); }
  } else if (type === 1 || type === 3) {
    if (rot === 0) { f(x, y, F_NW); f(x - 1, y + 1, F_SE); } else if (rot === 1) { f(x, y, F_NE); f(x + 1, y + 1, F_SW); }
    else if (rot === 2) { f(x, y, F_SE); f(x + 1, y - 1, F_NW); } else { f(x, y, F_SW); f(x - 1, y - 1, F_NE); }
  } else if (type === 2) {
    if (rot === 0) { f(x, y, F_W | F_N); f(x - 1, y, F_E); f(x, y + 1, F_S); } else if (rot === 1) { f(x, y, F_N | F_E); f(x, y + 1, F_S); f(x + 1, y, F_W); }
    else if (rot === 2) { f(x, y, F_E | F_S); f(x + 1, y, F_W); f(x, y - 1, F_N); } else { f(x, y, F_S | F_W); f(x, y - 1, F_N); f(x - 1, y, F_E); }
  }
}
/* a closed leaf with a second state fences its edge in an overlay of its own (global tile key -> bits), so opening it takes back
   exactly what it laid: the region's clip is never unpicked, and a square reloading lays its doors again in their current state.
   An "Open" loc with no second state stays passable, so nothing can shut a player in. */
const doorClip = new Map(), doorEdges = new Map(), tileDoors = new Map();
function doorWall(key, pl, def) {
  const old = doorEdges.get(key);
  if (old) {
    doorEdges.delete(key);
    for (let i = 0; i < old.length; i += 2) {
      const t = old[i], s = tileDoors.get(t);
      s.delete(key);
      let b = 0;
      for (const k of s) { const e = doorEdges.get(k); for (let j = 0; j < e.length; j += 2) if (e[j] === t) b |= e[j + 1]; }
      if (b) doorClip.set(t, b); else { doorClip.delete(t); tileDoors.delete(t); }
    }
  }
  const pair = pl && doorPairs.get(pl.id);
  if (!pair || !pair.closed || (pl.type > 3 && pl.type !== 9) || !def || def.clipType === 0) return;
  const rp = clipPlane(pl.plane, pl.gx, pl.gy);
  if (rp < 0) return;
  const bp = def.blocksProjectile !== false, e = [];
  if (pl.type === 9) e.push((rp * 8192 + pl.gx) * 16384 + pl.gy, F_OBJ | (bp ? P_OBJ : 0));   // a diagonal leaf holds its tile, as the client's does
  else wallEdges((gx, gy, b) => e.push((rp * 8192 + gx) * 16384 + gy, bp ? b | (b << 9) : b), pl.gx, pl.gy, pl.type, pl.rot);
  doorEdges.set(key, e);
  for (let i = 0; i < e.length; i += 2) {
    const t = e[i];
    doorClip.set(t, (doorClip.get(t) | 0) | e[i + 1]);
    let s = tileDoors.get(t);
    if (!s) tileDoors.set(t, s = new Set());
    s.add(key);
  }
}
const OPENABLE = /^(open|close|shut)$/i;
const openable = (def, id) => doorPairs.has(id) || opsOf(def).some(o => OPENABLE.test(o));
function clipLoc(R, def, id, pl, w, l) {
  const rp = clipPlane(pl.plane, pl.gx, pl.gy), ct = def.clipType === undefined ? 2 : def.clipType, bp = def.blocksProjectile !== false, t = pl.type;
  if (rp < 0) return;
  if (t === 22) { if (ct === 1) orFlag(R, rp, pl.gx, pl.gy, F_DECO); return; }
  if (t <= 3) { if (ct !== 0 && !openable(def, id)) addWall(R, rp, pl.gx, pl.gy, t, pl.rot, bp); return; }
  if ((t >= 9 && t <= 21) && ct !== 0 && !(t === 9 && doorPairs.has(id))) for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < l; dy++) orFlag(R, rp, pl.gx + dx, pl.gy + dy, F_OBJ | (bp ? P_OBJ : 0));
}
/* one step, |dx|,|dy| <= 1, OSRS north = +dy; the client's own masks, diagonals needing both orthogonals */
function canMove(rp, x, y, dx, dy, proj, last, base) {   /* base: what fills a tile (a boat ignores the floor flag water carries) */
  const B = proj ? (last ? 0 : P_OBJ) : base === undefined ? F_FULL : base, s = proj ? 9 : 0, f = (a, b) => flagAt(rp, a, b);
  const m = bits => B | (bits << s);
  const N = !(f(x, y + 1) & m(F_S)), S = !(f(x, y - 1) & m(F_N)), E = !(f(x + 1, y) & m(F_W)), W = !(f(x - 1, y) & m(F_E));
  if (!dx) return dy > 0 ? N : dy < 0 ? S : true;
  if (!dy) return dx > 0 ? E : W;
  if (dx > 0 && dy > 0) return N && E && !(f(x + 1, y + 1) & m(F_S | F_SW | F_W));
  if (dx < 0 && dy > 0) return N && W && !(f(x - 1, y + 1) & m(F_S | F_SE | F_E));
  if (dx > 0) return S && E && !(f(x + 1, y - 1) & m(F_N | F_NW | F_W));
  return S && W && !(f(x - 1, y - 1) & m(F_N | F_NE | F_E));
}
/* line of sight: the tile walk seedworld's hasLos makes, each hop judged by the projectile flags */
function los(rp, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, n = Math.max(Math.abs(dx), Math.abs(dy));
  let px = ax, py = ay;
  for (let i = 1; i <= n; i++) {
    const x = Math.round(ax + dx * i / n), y = Math.round(ay + dy * i / n);
    if (!canMove(rp, px, py, x - px, y - py, 1, i === n)) return false;
    px = x; py = y;
  }
  return true;
}
const openTile = (rp, gx, gy) => !(flagAt(rp, gx, gy) & F_FULL);
/* a tile of the map's own water on the ground floor, not under a deck: its overlay wears a water texture (1, or the open
   sea's 130..189). A boat's tile: game.js rows it, walls and rocks still stand (canSail) */
let waterOL = null;
function waterAt(plane, gx, gy) {
  if (plane !== 0) return false;
  const r = regionAt(gx, gy);
  if (!r) return false;
  if (!waterOL) {
    waterOL = new Uint8Array(1024);
    for (const k in overlays) { const t = overlays[k] && overlays[k].texture; if (t === 1 || (t >= 130 && t <= 189)) waterOL[(+k + 1) & 1023] = 1; }
  }
  const i = (gx & 63) * 64 + (gy & 63);
  return !r.bridge[i] && waterOL[r.OL[i] & 1023] === 1;
}
function snapWalkable(rp, gx, gy, maxR) {
  if (openTile(rp, gx, gy)) return [gx, gy];
  for (let r = 1; r <= (maxR || 3); r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++)
    if (Math.max(Math.abs(dx), Math.abs(dy)) === r && openTile(rp, gx + dx, gy + dy)) return [gx + dx, gy + dy];
  return [gx, gy];
}

/* ---- geometry sinks: flat-coloured faces, plus textured faces bucketed per texture with the client's implicit
   per-face UVs (the face's own vertices are its texture triangle). owners[] names the pick target per triangle.
   Translucent faces (glass, water, a tile kit's wash; faceTransparency 1-250) keep buckets of their own, carrying
   their opacity as vertex alpha — drawn solid they were green slabs for windows and black ones over dungeon floors. ---- */
const makeSink = () => ({ pos: [], col: [], owners: [], tex: new Map(), tpos: [], tcol: [], towners: [], ttex: new Map(), ud: null });
function grow(ud, x, y, z) {
  if (!ud) return;
  const b = ud.box;
  if (x < b.min.x) b.min.x = x; if (y < b.min.y) b.min.y = y; if (z < b.min.z) b.min.z = z;
  if (x > b.max.x) b.max.x = x; if (y > b.max.y) b.max.y = y; if (z > b.max.z) b.max.z = z;
}
/* t: {cx, cz, gy (tiles, up), rot, extra45, mirror, sx, sh, sy, ox, oh, oy, recol, retex}
   + for a placed loc {r, plane, base (raw height), px, py (its middle, cache units), contour (the def's contouredGround)} */
let vX = new Float64Array(4096), vY = new Float64Array(4096), vZ = new Float64Array(4096);
/* a model's vertices (src: its own, or an animated pose of them) turned, scaled and contoured into place: world tiles in vB */
function placeVerts(m, t, v) {
  const sx = t.sx || 1, sh = t.sh || 1, sy = t.sy || 1, rot = t.rot || 0, S = Math.SQRT1_2;
  const n = m.vc;
  if (vX.length < n) { vX = new Float64Array(n); vY = new Float64Array(n); vZ = new Float64Array(n); }
  let minY = 0, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < n; i++) {
    let x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
    if (t.mirror) z = -z;
    for (let r = 0; r < rot; r++) { const q = x; x = z; z = -q; }   /* client rotateY90 */
    if (t.extra45) { const q = x; x = (q + z) * S; z = (z - q) * S; }
    if (t.decor) { x += t.decor[0]; z += t.decor[1]; }   /* a diagonal wall decoration: the client's (45, 0, -45) after its 45-degree turn, turned with the placement */
    x = x * sx + (t.ox || 0); y = y * sh + (t.oh || 0); z = z * sy + (t.oy || 0);
    vX[i] = x; vY[i] = y; vZ[i] = z;
    if (y < minY) minY = y;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (t.contour >= 0 && t.px !== undefined && n) contourGround(t, n, minY, minX, maxX, minZ, maxZ);
  if (vB.length < n * 3) vB = new Float32Array(n * 3);
  const out = vB;
  for (let i = 0; i < n; i++) { out[i * 3] = t.cx + vX[i] * U; out[i * 3 + 1] = t.gy - vY[i] * U; out[i * 3 + 2] = t.cz - vZ[i] * U; }
  return out;
}
function appendModel(sink, m, t, flat) {
  if (sink.rec) { sink.rec.push(m, t); return; }   /* an animated placement: its pieces are kept to be posed (animFlush) */
  const out = placeVerts(m, t, m.verts);
  /* the client's mirror flips z and swaps each face's first and third vertex, so a mirrored face keeps its facing and its
     texture triangle starts from the swapped corner */
  const idx = m.idx, ud = sink.ud, i0 = t.mirror ? 2 : 0, i2 = 2 - i0;
  for (let f = 0; f < m.fc; f++) {
    if (faceHidden(m, f)) continue;
    let tid = m.texs ? m.texs[f] - 1 : -1;
    if (tid >= 0 && t.retex && t.retex.has(tid)) tid = t.retex.get(tid);
    const a = idx[f * 3 + i0] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + i2] * 3, al = flat || !m.alphas ? 0 : m.alphas[f], op = 1 - al / 255;
    const ax = out[a], ay = out[a + 1], az = out[a + 2], bx = out[b], by = out[b + 1], bz = out[b + 2], cx = out[c], cy = out[c + 1], cz = out[c + 2];
    if (ud) { grow(ud, ax, ay, az); grow(ud, bx, by, bz); grow(ud, cx, cy, cz); }
    if (sink.avg && al) continue;   // a far level draws nothing see-through
    if (!flat && tid >= 0 && textures[tid] !== undefined) {
      if (sink.avg) {   // a far level: the texture's own average colour, one flat mesh
        const c = texAvg(tid);
        sink.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz); sink.col.push(c[0], c[1], c[2], c[0], c[1], c[2], c[0], c[1], c[2]); sink.owners.push(null);
        continue;
      }
      const T = al ? sink.ttex : sink.tex;
      let bk = T.get(tid);
      if (!bk) T.set(tid, bk = { pos: [], uv: [], owners: [], col: al ? [] : null });
      bk.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      faceUV(m, f, i0, i2, uvTmp, 0);
      bk.uv.push(uvTmp[0], uvTmp[1], uvTmp[2], uvTmp[3], uvTmp[4], uvTmp[5]); bk.owners.push(ud);
      if (al) bk.col.push(1, 1, 1, op, 1, 1, 1, op, 1, 1, 1, op);
      continue;
    }
    const rgb = faceColor(m, f, t.recol, t.retex), r = rgb[0], g = rgb[1], bl = rgb[2];
    if (al) {
      sink.tpos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      sink.tcol.push(r, g, bl, op, r, g, bl, op, r, g, bl, op);
      sink.towners.push(ud);
      continue;
    }
    sink.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    sink.col.push(r, g, bl, r, g, bl, r, g, bl);
    sink.owners.push(ud);
  }
}
let vB = new Float32Array(12288);
let matFlat = null, matFlatT = null;
function flatMats() {
  if (!matFlat) {
    matFlat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide });
    matFlatT = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  }
}
function bake(pos, col) {
  flatMats();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, matFlat);
}
function bakeT(pos, col) {   /* rgba vertex colours: three r128 blends by vertex alpha when the colour attribute has four components */
  flatMats();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.computeVertexNormals();
  return new THREE.Mesh(g, matFlatT);
}
/* bake a sink into meshes (one flat + one per texture) under group g; every owner learns its triangle ranges */
function ownTris(mesh, owners) {   /* each owner learns the triangle runs it holds in a mesh, for picking */
  mesh.userData.owners = owners;
  for (let i = 0; i < owners.length;) {
    const ud = owners[i]; let j = i + 1;
    while (j < owners.length && owners[j] === ud) j++;
    if (ud) ud.tris.push(mesh, i, j);
    i = j;
  }
}
function flushSink(s, g) {
  const made = [], own = ownTris;
  if (s.pos.length) { const m = bake(s.pos, s.col); own(m, s.owners); made.push(m); }
  const textured = (b, mat) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    if (b.col) geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 4));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    own(m, b.owners); made.push(m);
  };
  for (const [tid, b] of s.tex) textured(b, texMaterial(tid));
  if (s.tpos.length) { const m = bakeT(s.tpos, s.tcol); own(m, s.towners); made.push(m); }
  for (const [tid, b] of s.ttex) textured(b, texMaterialT(tid));
  for (const m of made) g.add(m);
  return made;
}
/* ---- animated scenery: a placement whose def animates (a fire, a torch's flame, a flag, a water wheel) is laid in its square's
   animated batch — one opaque and one see-through mesh a plane, rest pose first. Within ANIM_R tiles of the player its seq
   plays: a piece is re-posed only when its frame changes, written back into the batch in place, and the batch uploads once
   that frame. Everything farther holds its pose, so a square full of flames costs nothing until you walk up to it. ---- */
const ANIM_R = 26;
function animFlush(list, g) {
  flatMats();
  /* its faces by how they are drawn, as a still placement's are (appendModel): flat or textured (a texture each), solid or see-through.
     A fountain's spray, a torch's flame and a flag's cloth are textured faces; flat, they were slabs of the face's plain colour */
  const pieces = [], counts = new Map();
  for (const it of list) for (let k = 0; k < it.rec.length; k += 2) {
    const m = it.rec[k], t = it.rec[k + 1], lists = new Map();
    for (let f = 0; f < m.fc; f++) {
      if (faceHidden(m, f)) continue;
      let tid = m.texs ? m.texs[f] - 1 : -1;
      if (tid >= 0 && t.retex && t.retex.has(tid)) tid = t.retex.get(tid);
      const q = (tid >= 0 && textures[tid] !== undefined ? tid : -1) + (m.alphas && m.alphas[f] ? ':a' : ':o');
      (lists.get(q) || lists.set(q, []).get(q)).push(f);
    }
    const pc = { m, t, ud: it.ud, seq: it.seq, ph: it.ph, parts: [], idx: -2, total: 0, work: null, groups: m.vgroups ? labelGroups(m.vgroups, m.vc) : null, x: t.cx, y: -t.cz };
    for (const [q, fl] of lists) { const n = counts.get(q) || 0; pc.parts.push([q, fl, n]); counts.set(q, n + fl.length); }
    pieces.push(pc);
  }
  const batches = new Map();
  for (const [q, n] of counts) {
    const tid = parseInt(q, 10), al = q.endsWith(':a'), tex = tid >= 0, stride = al ? 4 : 3;
    batches.set(q, { pos: new Float32Array(n * 9), nrm: new Float32Array(n * 9), col: tex && !al ? null : new Float32Array(n * 3 * stride), uv: tex ? new Float32Array(n * 6) : null,
      owners: new Array(n), mesh: null, stride, dirty: 0, mat: tex ? (al ? texMaterialT(tid) : texMaterial(tid)) : al ? matFlatT : matFlat });
  }
  for (const pc of pieces) {
    const { m, t } = pc, i0 = t.mirror ? 2 : 0;
    pc.parts = pc.parts.map(([q, fl, base]) => [batches.get(q), fl, base]);
    for (const [B, fl, base] of pc.parts) {
      for (let i = 0; i < fl.length; i++) {
        const f = fl[i];
        if (B.uv) faceUV(m, f, i0, 2 - i0, B.uv, (base + i) * 6);
        if (B.col) {
          const c = B.uv ? WHITE : faceColor(m, f, t.recol, t.retex), o = (base + i) * 3 * B.stride;
          for (let k = 0; k < 3; k++) { const q = o + k * B.stride; B.col[q] = c[0]; B.col[q + 1] = c[1]; B.col[q + 2] = c[2]; if (B.stride === 4) B.col[q + 3] = 1 - m.alphas[f] / 255; }
        }
        B.owners[base + i] = pc.ud;
      }
    }
    writeAnim(pc, m.verts, true);
  }
  for (const B of batches.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(B.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(B.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    if (B.col) geo.setAttribute('color', new THREE.BufferAttribute(B.col, B.stride));
    if (B.uv) geo.setAttribute('uv', new THREE.BufferAttribute(B.uv, 2));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 3;   // a flame or a flag moves a little past its rest pose
    B.mesh = new THREE.Mesh(geo, B.mat);
    ownTris(B.mesh, B.owners);
    g.add(B.mesh);
  }
  return { pieces, batches: [...batches.values()] };
}
function writeAnim(pc, src, rest) {
  const out = placeVerts(pc.m, pc.t, src), idx = pc.m.idx, i0 = pc.t.mirror ? 2 : 0, i2 = 2 - i0, ud = rest ? pc.ud : null;
  for (const [B, list, base] of pc.parts) {
    if (!list.length) continue;
    B.dirty = 1;
    const P = B.pos, N = B.nrm;
    for (let i = 0; i < list.length; i++) {
      const f = list[i], a = idx[f * 3 + i0] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + i2] * 3, o = (base + i) * 9;
      const ax = out[a], ay = out[a + 1], az = out[a + 2], bx = out[b], by = out[b + 1], bz = out[b + 2], cx = out[c], cy = out[c + 1], cz = out[c + 2];
      P[o] = ax; P[o + 1] = ay; P[o + 2] = az; P[o + 3] = bx; P[o + 4] = by; P[o + 5] = bz; P[o + 6] = cx; P[o + 7] = cy; P[o + 8] = cz;
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const L = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= L; ny /= L; nz /= L;
      for (let k = 0; k < 9; k += 3) { N[o + k] = nx; N[o + k + 1] = ny; N[o + k + 2] = nz; }
      if (ud) { grow(ud, ax, ay, az); grow(ud, bx, by, bz); grow(ud, cx, cy, cz); }
    }
  }
}
/* a frame's fade: its alpha transforms (type 5) add dx * 8 to the faces their labels name. The tree's model records carry no face
   labels, so the fade lands on every see-through face of the piece at the frame's mean — a fountain's spray, a portal's shimmer, a
   ghost's sheen flicker and thin as they do, where held at their rest alpha they stood as solid slabs */
function frameFade(fr) {
  if (fr.a5 !== undefined) return fr.a5;
  const { bases, ds } = fr.tr, types = fr.fm.types;
  let s = 0, n = 0;
  for (let i = 0; i < bases.length; i++) if (types[bases[i]] === 5) { s += ds[i * 3]; n++; }
  return (fr.a5 = n ? (s / n) * 8 : 0);
}
function animAlpha(pc, fr) {
  const a5 = frameFade(fr);
  if (a5 === (pc.a5 || 0)) return;
  pc.a5 = a5;
  const m = pc.m;
  for (const [B, list, base] of pc.parts) {
    if (B.stride !== 4) continue;
    for (let i = 0; i < list.length; i++) {
      const op = 1 - Math.max(0, Math.min(255, m.alphas[list[i]] + a5)) / 255, o = (base + i) * 12;
      B.col[o + 3] = B.col[o + 7] = B.col[o + 11] = op;
    }
    B.cdirty = 1;
  }
}
let animClock = 0;
function animateScenery(gx, gy, dtMs) {   /* the player's OSRS tile; call once a frame */
  animClock += dtMs;
  for (const R of regions.values()) {
    const A = R.anim;
    if (!A || (R.lodV && !R.lodV.d) || gx < R.sqX * 64 - ANIM_R || gx > R.sqX * 64 + 63 + ANIM_R || gy < R.sqY * 64 - ANIM_R || gy > R.sqY * 64 + 63 + ANIM_R) continue;
    for (let p = 0; p < 4; p++) {
      const B = A[p];
      if (!B || !planeG[p].visible) continue;
      for (const pc of B.pieces) {
        if (!pc.groups || Math.abs(pc.x - gx) > ANIM_R || Math.abs(pc.y - gy) > ANIM_R) continue;
        const fr = seqFrames(pc.seq);
        if (!fr || !fr.length) continue;
        if (!pc.total) { for (const f of fr) pc.total += f.ms; if (!pc.total) pc.total = 1; }
        const idx = frameAt(fr, (animClock + pc.ph) % pc.total);
        if (idx === pc.idx) continue;
        pc.idx = idx;
        if (!pc.work) pc.work = new Int32Array(pc.m.vc * 3);
        pc.work.set(pc.m.verts);
        transformVerts(pc.work, pc.groups, fr[idx]);
        writeAnim(pc, pc.work, false);
        animAlpha(pc, fr[idx]);
      }
      for (const X of B.batches) {
        if (X.dirty) { X.dirty = 0; X.mesh.geometry.attributes.position.needsUpdate = true; X.mesh.geometry.attributes.normal.needsUpdate = true; }
        if (X.cdirty) { X.cdirty = 0; X.mesh.geometry.attributes.color.needsUpdate = true; }
      }
    }
  }
}
function disposeMesh(m) {
  if (m.parent) m.parent.remove(m);
  if (m.geometry) m.geometry.dispose();
  for (const c of [...m.children]) disposeMesh(c);
}

/* the client's Model.contourGround, on the transformed vertices in vX/vY/vZ: a loc whose def says contouredGround
   follows the ground under each vertex instead of standing level at its middle's height — 0 moves every vertex by
   the ground's rise there, n > 0 only the lowest n/65536 of the model, fading out upward. Most of the modern map
   asks for it (walls, fences, rugs, floor kits); level on a slope, those float at one end and sink at the other. */
function contourGround(t, n, minY, minX, maxX, minZ, maxZ) {
  const base = t.base, ct = t.contour, p = t.plane, r = t.r;
  const sx = (t.px + minX) >> 7, ex = (t.px + maxX + 127) >> 7, sz = (t.py + minZ) >> 7, ez = (t.py + maxZ + 127) >> 7;
  if (cornerH(p, sx, sz, r) === base && cornerH(p, ex, sz, r) === base && cornerH(p, sx, ez, r) === base && cornerH(p, ex, ez, r) === base) return;   /* level ground: as placed */
  if (ct > 0 && minY >= 0) return;
  let lx = 1e9, lz = 1e9, h00 = 0, h10 = 0, h01 = 0, h11 = 0;
  for (let i = 0; i < n; i++) {
    const X = t.px + vX[i], Z = t.py + vZ[i], tx = Math.floor(X / 128), tz = Math.floor(Z / 128), rx = X - tx * 128, rz = Z - tz * 128;
    if (tx !== lx || tz !== lz) { lx = tx; lz = tz; h00 = cornerH(p, tx, tz, r); h10 = cornerH(p, tx + 1, tz, r); h01 = cornerH(p, tx, tz + 1, r); h11 = cornerH(p, tx + 1, tz + 1, r); }
    const h = ((h00 * (128 - rx) + h10 * rx) * (128 - rz) + (h01 * (128 - rx) + h11 * rx) * rz) / 16384;
    if (ct === 0) vY[i] += h - base;
    else { const q = vY[i] * 65536 / minY; if (q < ct) vY[i] += (h - base) * (ct - q) / ct; }
  }
}

/* ---- terrain: the client's tile models, one mesh per render plane (bridge-flagged tiles above ground drop one level
   and keep their heights). An overlay's shape (shapeRot >> 2, turned by its low bits) cuts the tile into overlay and
   underlay triangles, so a diagonal floor stops at its diagonal wall instead of filling the square (rs-map-viewer's
   SceneTileModel tables). Underlay colours are the client's blend: hue weighted by its multiplier, saturation and
   lightness averaged, over the eleven-by-eleven tiles round each one (neighbouring squares when they are up), packed
   to HSL16 like the client, each corner taking its own tile's blend — the ground shades between swatches instead of
   reading as a checkerboard. A magenta overlay is the client's hole: that part is not drawn. ---- */
const SHAPE_V = [[1, 3, 5, 7], [1, 3, 5, 7], [1, 3, 5, 7], [1, 3, 5, 7, 6], [1, 3, 5, 7, 6], [1, 3, 5, 7, 6], [1, 3, 5, 7, 6], [1, 3, 5, 7, 2, 6],
  [1, 3, 5, 7, 2, 8], [1, 3, 5, 7, 2, 8], [1, 3, 5, 7, 11, 12], [1, 3, 5, 7, 11, 12], [1, 3, 5, 7, 13, 14]];
const SHAPE_F = [[0, 1, 2, 3, 0, 0, 1, 3], [1, 1, 2, 3, 1, 0, 1, 3], [0, 1, 2, 3, 1, 0, 1, 3], [0, 0, 1, 2, 0, 0, 2, 4, 1, 0, 4, 3], [0, 0, 1, 4, 0, 0, 4, 3, 1, 1, 2, 4],
  [0, 0, 4, 3, 1, 0, 1, 2, 1, 0, 2, 4], [0, 1, 2, 4, 1, 0, 1, 4, 1, 0, 4, 3], [0, 4, 1, 2, 0, 4, 2, 5, 1, 0, 4, 5, 1, 0, 5, 3],
  [0, 4, 1, 2, 0, 4, 2, 3, 0, 4, 3, 5, 1, 0, 4, 5], [0, 0, 4, 5, 1, 4, 1, 2, 1, 4, 2, 3, 1, 4, 3, 5],
  [0, 0, 1, 5, 0, 1, 4, 5, 0, 1, 2, 4, 1, 0, 5, 3, 1, 5, 4, 3, 1, 4, 2, 3], [1, 0, 1, 5, 1, 1, 4, 5, 1, 1, 2, 4, 0, 0, 5, 3, 0, 5, 4, 3, 0, 4, 2, 3],
  [1, 0, 5, 4, 1, 0, 1, 5, 0, 0, 4, 3, 0, 4, 5, 3, 0, 5, 2, 3, 0, 1, 2, 5]];
/* a shape vertex -> [x, z] in cache units within the tile, and which corners its height and colour average */
const SHAPE_P = [null, [0, 0, 0, 0], [64, 0, 1, 0], [128, 0, 1, 1], [128, 64, 1, 2], [128, 128, 2, 2], [64, 128, 3, 2], [0, 128, 3, 3], [0, 64, 3, 0],
  [64, 32, 1, 0], [96, 64, 1, 2], [64, 96, 3, 2], [32, 64, 3, 0], [32, 32, 0, 0], [96, 32, 1, 1], [96, 96, 2, 2], [32, 96, 3, 3]];   /* corners: 0 SW, 1 SE, 2 NE, 3 NW */
const packHsl = (h, s, l) => { if (l > 179) s >>= 1; if (l > 192) s >>= 1; if (l > 217) s >>= 1; if (l > 243) s >>= 1; return ((s >> 5) << 7) + ((h >> 2) << 10) + (l >> 1); };
const groundC = new Map();
function groundRGB(v) {   /* HSL16 -> rgb for the ground: the client's palette without the model exponent, the tone the flat swatches had */
  let c = groundC.get(v);
  if (c !== undefined) return c;
  const hue = (v >> 10 & 63) / 64 + 0.0078125, sat = (v >> 7 & 7) / 8 + 0.0625, lum = (v & 127) / 128;
  const ch = (1 - Math.abs(2 * lum - 1)) * sat, x = ch * (1 - Math.abs((hue * 6) % 2 - 1)), l = lum - ch / 2;
  let r = l, g = l, b = l;
  switch ((hue * 6) | 0) { case 0: r += ch; g += x; break; case 1: g += ch; r += x; break; case 2: g += ch; b += x; break; case 3: b += ch; g += x; break; case 4: b += ch; r += x; break; default: r += ch; b += x; }
  groundC.set(v, c = [Math.min(r, 1), Math.min(g, 1), Math.min(b, 1)]);
  return c;
}
const BW = 75, BO = 5, BP = 76;   /* the blend window's grid: the square and five tiles round it; prefix sums one wider */
const blendUL = new Uint16Array(BW * BW), blendS = [0, 1, 2, 3, 4].map(() => new Int32Array(BP * BP));
function blendPlane(R, p) {   /* prefix sums of hue x multiplier, saturation, lightness, multiplier, count over the window grid */
  const bx = R.sqX * 64 - BO, by = R.sqY * 64 - BO, [sH, sS, sL, sM, sN] = blendS;
  let lr = null, lrid = -1;
  for (let x = 0; x < BW; x++) for (let y = 0; y < BW; y++) {
    const gx = bx + x, gy = by + y, rid = ridOf(gx, gy);
    if (rid !== lrid) { lrid = rid; lr = rid === R.rid ? R : regions.get(rid) || null; }
    const u = lr && lr.UL ? lr.UL[p * 4096 + (gx & 63) * 64 + (gy & 63)] : 0, d = u ? underlays[u - 1] : null, hs = d && d.hsl;
    blendUL[x * BW + y] = hs ? u : 0;
    const k = (x + 1) * BP + y + 1, a = x * BP + y + 1, b = (x + 1) * BP + y, c = x * BP + y;
    sH[k] = (hs ? hs.hue : 0) + sH[a] + sH[b] - sH[c];
    sS[k] = (hs ? hs.sat : 0) + sS[a] + sS[b] - sS[c];
    sL[k] = (hs ? hs.lum : 0) + sL[a] + sL[b] - sL[c];
    sM[k] = (hs ? hs.hueMultiplier : 0) + sM[a] + sM[b] - sM[c];
    sN[k] = (hs ? 1 : 0) + sN[a] + sN[b] - sN[c];
  }
}
function blendAt(x, y) {   /* square-local tile (0..64): its blended HSL16, or -1 where it has no underlay */
  if (!blendUL[(x + BO) * BW + y + BO]) return -1;
  const X0 = x, X1 = x + 11, Y0 = y, Y1 = y + 11, q = s => s[X1 * BP + Y1] - s[X0 * BP + Y1] - s[X1 * BP + Y0] + s[X0 * BP + Y0];
  const [sH, sS, sL, sM, sN] = blendS, nn = q(sN), mm = q(sM);
  return nn && mm ? packHsl((q(sH) * 256 / mm) | 0, (q(sS) / nn) | 0, (q(sL) / nn) | 0) : -1;
}
/* a textured overlay (water, lava, cobbles) wears its texture, one repeat a tile, lit like the ground */
const groundTex = id => texMat(texMatsG, id, map => new THREE.MeshLambertMaterial({ map, side: THREE.FrontSide }));
function buildTerrain(R) {
  const lv = [0, 1, 2, 3].map(() => ({ pos: [], col: [], tex: new Map() }));
  const vx = new Float32Array(6), vz = new Float32Array(6), vh = new Float32Array(6), vu = new Float32Array(6), vv = new Float32Array(6), vc = new Array(6);
  for (let p = 0; p < 4; p++) {
    let any = false;
    for (let i = p * 4096; i < (p + 1) * 4096 && !any; i++) if (R.UL[i] || R.OL[i]) any = true;
    if (!any) continue;
    blendPlane(R, p);
    const blend = new Int32Array(65 * 65);
    for (let x = 0; x <= 64; x++) for (let y = 0; y <= 64; y++) blend[x * 65 + y] = blendAt(x, y);
    for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) {
      const i = p * 4096 + x * 64 + y, u = R.UL[i], o = R.OL[i];
      if (!u && !o) continue;
      const b = lv[p >= 1 && R.bridge[x * 64 + y] ? p - 1 : p], gx = R.sqX * 64 + x, gy = R.sqY * 64 + y;
      const hc = [cornerH(p, gx, gy, R), cornerH(p, gx + 1, gy, R), cornerH(p, gx + 1, gy + 1, R), cornerH(p, gx, gy + 1, R)];
      let uc = null;
      const sw = u ? blend[x * 65 + y] : -1;
      if (sw >= 0) {
        const at = (bx2, by2) => { const q = blend[bx2 * 65 + by2]; return groundRGB(q >= 0 ? q : sw); };
        uc = [groundRGB(sw), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1)];
      } else if (u && !o) { const d = underlays[u - 1]; if (d) { const c = rgbI(d.rgb); uc = [c, c, c, c]; } }   /* no blend data: the swatch as it was */
      let shape = 0, rot = 0, oc = null, ot = -1;
      if (o) {
        const d = overlays[o - 1] || {};
        shape = (R.SR[i] >> 2) + 1; rot = R.SR[i] & 3;
        if (shape >= SHAPE_F.length) shape = 1;
        if (d.texture !== undefined && textures[d.texture]) { ot = d.texture; oc = WHITE; }
        else if (d.rgbColor !== 0xff00ff) oc = rgbI(d.rgbColor || 0);
        else if (d.secondaryRgbColor !== undefined && p === 0) oc = rgbI(d.secondaryRgbColor);   /* drawn by the client's own water and scenery passes: its map colour stands in. An upper floor's magenta tile is nothing the scene draws — the floor a fountain's jets or a balcony's railing is placed on, not a floor: its map colour there hung sheets of blue-grey in the air */
      }
      const V = SHAPE_V[shape], F = SHAPE_F[shape];
      for (let k = 0; k < V.length; k++) {
        let q = V[k];
        if ((q & 1) === 0 && q <= 8) q = ((q - rot - rot - 1) & 7) + 1;
        if (q > 8 && q <= 12) q = ((q - 9 - rot) & 3) + 9;
        if (q > 12 && q <= 16) q = ((q - 13 - rot) & 3) + 13;
        const P = SHAPE_P[q];
        vx[k] = gx - 0.5 + P[0] / 128; vz[k] = -gy + 0.5 - P[1] / 128; vu[k] = P[0] / 128; vv[k] = P[1] / 128;
        vh[k] = -((hc[P[2]] + hc[P[3]]) >> 1) * U;
        if (uc) { const c0 = uc[P[2]], c1 = uc[P[3]]; vc[k] = c0 === c1 ? c0 : [(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2, (c0[2] + c1[2]) / 2]; }
      }
      for (let f = 0; f < F.length; f += 4) {
        const over = F[f] === 1;
        if (over ? !oc : !uc) continue;
        let A = F[f + 1], B = F[f + 2], C = F[f + 3];
        if (A < 4) A = (A - rot) & 3; if (B < 4) B = (B - rot) & 3; if (C < 4) C = (C - rot) & 3;
        if ((vz[B] - vz[A]) * (vx[C] - vx[A]) - (vx[B] - vx[A]) * (vz[C] - vz[A]) < 0) { const s = B; B = C; C = s; }   /* face up */
        if (over && ot >= 0) {
          let bk = b.tex.get(ot);
          if (!bk) b.tex.set(ot, bk = { pos: [], uv: [] });
          for (const k of [A, B, C]) { bk.pos.push(vx[k], vh[k], vz[k]); bk.uv.push(vu[k], vv[k]); }
          continue;
        }
        for (const k of [A, B, C]) { b.pos.push(vx[k], vh[k], vz[k]); const c = over ? oc : vc[k]; b.col.push(c[0], c[1], c[2]); }
      }
    }
  }
  for (let p = 0; p < 4; p++) {
    if (R.terr[p]) { disposeMesh(R.terr[p]); R.terr[p] = null; }
    const L = lv[p];
    if (!L.pos.length && !L.tex.size) continue;
    const g = new THREE.Group();
    g.userData.terrain = 1;
    if (L.pos.length) g.add(bake(L.pos, L.col));
    for (const [tid, bk] of L.tex) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, groundTex(tid)));
    }
    planeG[p].add(g); R.terr[p] = g;
  }
}

/* ---- scenery ---- */
function defaultChild(d) {   /* a varbit/varp-driven loc or npc renders as children[state]; a fresh account's state is 0 */
  const kids = d.multiChildren || [];
  if (kids.length) return kids[0];
  return d.oobChild === undefined ? -1 : d.oobChild;
}
function resolveDef(dd, id) { let d = dd[id]; if (d && !d.models) { const c = defaultChild(d); if (c >= 0 && dd[c] && dd[c].models) d = dd[c]; } return d; }
const footprint = (def, rot) => { const w = def.width || 1, l = def.length || 1; return rot & 1 ? [l, w] : [w, l]; };
function groundCenter(plane, gx, gy, w, l) {   /* the modern client's rule: the height round the footprint's middle, not its outer corners */
  const r = regionRaw(gx, gy);
  if (!r || !r.H) return null;
  const sx = gx + (w >> 1), ex = gx + ((w + 1) >> 1), sy = gy + (l >> 1), ey = gy + ((l + 1) >> 1);
  const h = (cornerH(plane, ex, ey, r) + cornerH(plane, sx, ey, r) + cornerH(plane, sx, sy, r) + cornerH(plane, ex, sy, r)) >> 2;
  return { cx: gx + w / 2 - 0.5, cz: -(gy + l / 2) + 0.5, gy: -h * U, r, plane, base: h, px: gx * 128 + w * 64, py: gy * 128 + l * 64 };
}
/* the client's (45, 0, -45) for a diagonal wall decoration, in cache x/z, turned by the placement's quarter turns (rotateY90 each) */
const DECOR45 = [[45, -45], [-45, -45], [-45, 45], [45, 45]];
/* wall decorations, the client's addLoc: 4 hangs on its own tile's edge; 5 is the same piece hung on a wall standing on its
   tile, pushed out by that wall's decorDisplacement (its thickness: 16 unless the def says) — left where 4 hangs it, the piece
   is buried in the masonry or pokes through it. 6-8 turn the piece onto a diagonal wall: 6 faces the placement's way, pushed
   half a displacement; 7 faces the other way, unpushed; 8 is both. */
const DISP_X = [1, 0, -1, 0], DISP_Y = [0, -1, 0, 1], DIAG_X = [1, -1, -1, 1], DIAG_Y = [-1, -1, 1, 1];
/* the client paints a decoration after the wall behind it and a floor decoration after its tile, and modellers lean on that:
   a tapestry's cloth, a torch's plate and a rug lie exactly in the wall's or the ground's own plane. Stood a hair off it
   instead (cache units, along the way the piece faces), neither can fight the surface it hangs on. */
const DECOR_GAP = 2, FLOOR_LIFT = U;
/* draws one placement {id, plane, gx, gy, type, rot, disp} into a sink under owner ud (null: not pickable) */
function drawLoc(sink, def, pl, ud, bare) {
  const [w, l] = footprint(def, pl.rot), type = pl.type, rot0 = pl.rot;
  /* diagonal shapes (1, 3, 9) are authored in diagonal position and only turn in quarters; the extra 45 degrees is for a
     straight model reused diagonally: wall decor 5-8 always build from shape 4, type 11 from shape 10 */
  const shape = type >= 5 && type <= 8 ? 4 : type === 11 ? 10 : type, entries = def.models.filter(m => m.shape === shape);
  if (!entries.length) return false;
  sink.ud = ud;
  const cm = colorMaps(def, bare), disp = pl.disp || 0;
  /* m4: the client builds this half at orientation + 4, which also flips the def's mirror (ObjectComposition: isRotated ^ orientation > 3) */
  const draw = (rot, e45, m4, dx, dy) => {
    const t = groundCenter(pl.plane, pl.gx, pl.gy, w, l);   /* heights from the CACHE plane: a deck stays raised */
    if (!t) return;
    if (type === 22) t.gy += FLOOR_LIFT;
    const decor = m4 && type >= 6 ? [DECOR45[rot][0] + dx, DECOR45[rot][1] + dy] : dx || dy ? [dx, dy] : null;
    Object.assign(t, cm, { rot, extra45: e45, decor, mirror: !!def.isRotated !== m4,
      sx: (def.modelSizeX || 128) / 128, sh: (def.modelSizeHeight || 128) / 128, sy: (def.modelSizeY || 128) / 128,
      ox: def.offsetX || 0, oh: def.offsetHeight || 0, oy: def.offsetY || 0, contour: def.contouredGround === undefined ? -1 : def.contouredGround });
    for (const e of entries) { const mod = model(e.model); if (mod) appendModel(sink, mod, t); }
  };
  const out = disp + DECOR_GAP, diag = DECOR_GAP * Math.SQRT1_2, back = (rot0 + 2) & 3;
  if (type === 2) { draw(rot0, false, true, 0, 0); draw((rot0 + 1) & 3, false, false, 0, 0); }   /* the corner's first leg is the mirrored one: the two mitres meet */
  else if (type === 4 || type === 5) draw(rot0, false, false, (type === 5 ? out : DECOR_GAP) * DISP_X[rot0], (type === 5 ? out : DECOR_GAP) * DISP_Y[rot0]);
  else if (type >= 6 && type <= 8) {
    if (type !== 7) draw(rot0, true, true, disp * DIAG_X[rot0] + diag * DIAG_X[rot0], disp * DIAG_Y[rot0] + diag * DIAG_Y[rot0]);
    if (type !== 6) draw(back, true, true, diag * DIAG_X[back], diag * DIAG_Y[back]);
  } else draw(rot0, type === 11, false, 0, 0);
  sink.ud = null;
  return true;
}
/* a wall decoration's push off the wall on its tile (types 5, 6 and 8): the wall's decorDisplacement, halved on the diagonal */
function decorDisp(type, wallDef) {
  const d = wallDef && wallDef.decorDisplacement !== undefined ? wallDef.decorDisplacement : 16;
  return type === 5 ? d : type === 6 || type === 8 ? d >> 1 : 0;
}
/* a placement's menu: the def's own verbs, plus a recorded link's verb when the menu offers no way to move (a spirit tree's Travel,
   carried on a child state the map never shows) */
function newOwner(R, pl, def, id, w, l) {
  let ops = opsOf(def);
  const links = transByLoc[id];
  if (links && !ops.some(o => MOVE_OP.test(o))) for (const t of links) if (t.lx === pl.gx && t.ly === pl.gy && t.lp === pl.plane && t.o && !ops.some(o => opKey(o) === opKey(t.o))) ops = ops.concat(String(t.o).replace(/^./, c => c.toUpperCase()));
  return { kind: 'loc', R, locId: id, def, name: clean(def.name) || 'loc ' + id, ops, plane: renderPlane(pl.plane, pl.gx, pl.gy),
    cachePlane: pl.plane, gx: pl.gx, gy: pl.gy, w, l, type: pl.type, rot: pl.rot, tris: [], box: new THREE.Box3(new THREE.Vector3(1e9, 1e9, 1e9), new THREE.Vector3(-1e9, -1e9, -1e9)) };
}

/* ---- openable locs: pairs from doors.json; a toggled placement survives a region reload ---- */
const locOverrides = new Map();
/* a leaf with no second state in the cache (doors.json "self") swings its own model: its other state is this id plus SELF_DOOR,
   the same def with the verb turned */
const SELF_DOOR = 1 << 22;
function mirrorDoor(dd, id) {
  const base = dd[id - SELF_DOOR];
  if (!base || dd[id]) return;
  const ops = {};
  for (const [k, o] of Object.entries(base.ops || {})) {
    const t = o && o.text ? clean(o.text).toLowerCase() : '';
    ops[k] = t === 'open' ? Object.assign({}, o, { text: 'Close' }) : t === 'close' || t === 'shut' ? Object.assign({}, o, { text: 'Open' }) : o;
  }
  dd[id] = Object.assign({}, base, { ops });
}
const DOOR_DIR = [[-1, 0], [0, 1], [1, 0], [0, -1]];   /* wall rot 0 west edge, 1 north, 2 east, 3 south */
function toggledPlacement(pl) {
  const pair = doorPairs.get(pl.id);
  if (pl.type > 3) return Object.assign({}, pl, { id: pair.other });   /* objects and trapdoors swap in place */
  const dr = (pair.conv[1] === '+' ? 1 : -1) * (pl.flip ? -1 : 1), adj = pair.conv[0] === 'a';
  if (pair.closed) { const d = adj ? DOOR_DIR[pl.rot] : [0, 0]; return Object.assign({}, pl, { id: pair.other, gx: pl.gx + d[0], gy: pl.gy + d[1], rot: (pl.rot + dr + 4) & 3 }); }
  const rr = (pl.rot - dr + 4) & 3, d = adj ? DOOR_DIR[rr] : [0, 0];
  return Object.assign({}, pl, { id: pair.other, gx: pl.gx - d[0], gy: pl.gy - d[1], rot: rr });
}

/* a scenery piece with its own meshes (a door, a tree that falls, a vein that empties): state 0 whole, 1 spent.
   The spent look is laid at build time, hidden, so a model trimmed from the cache later can never leave a hole. */
function dynamic(R, def, pl, ud, spec) {
  const g = new THREE.Group();
  lodBox(R, 'd', ud.plane).add(g);   // with the square's near level: shown and hidden with it
  const s = makeSink();
  drawLoc(s, def, pl, ud, false);
  const whole = flushSink(s, g), spent = spentLook(def, pl, spec, g);
  for (const m of spent) m.visible = false;
  let state = 0;
  ud.dyn = g;
  ud.setVis = st => {
    st = st ? 1 : 0;
    if (st === state) return;
    state = st;
    for (const m of whole) m.visible = !st;
    for (const m of spent) m.visible = !!st;
  };
  if (!ud.vis) ud.vis = st => { ud.st = st ? 1 : 0; ud.setVis(ud.st); };
  if (ud.st) ud.setVis(1);   /* felled or emptied before its meshes existed: the state waited in ud.st */
  return g;
}
let stumps = null;   /* tree stump defs, resolved once at load; matched to the tree's footprint */
function spentLook(def, pl, spec, g) {
  if (!spec) return [];
  const s = makeSink();
  if (spec.t === 1) drawLoc(s, def, pl, null, true);   /* an emptied vein: the same rock with the ore's recolours stripped */
  else if (spec.t === 0 && stumps && stumps.length) {
    const [w, l] = footprint(def, pl.rot), st = stumps.find(q => (q.width || 1) === w && (q.length || 1) === l) || stumps[0];
    drawLoc(s, st, Object.assign({}, pl, { type: 10, rot: 0 }), null, false);
  }
  return flushSink(s, g);
}

/* ---- regions: parse, collide, draw ----
   A square comes up in three steps, so the ground under a player never waits on its scenery: the terrain draws the moment t/ and
   l/ are in; the loc and npc defs follow, and with them the walls, the menus and the monsters, so the square walks true (until
   then it collides solid: regionAt answers only a ready square); its models come last, laid a few milliseconds a frame, one square
   at a time. A square that fails for a passing reason is dropped and asked for again after a growing rest. */
function newRegion(rid) {
  return { rid, sqX: sqXOf(rid), sqY: sqYOf(rid), ready: 0, terr: [null, null, null, null], groups: [], owners: [], objs: [], ext: [], icons: [], scenes: [], anim: null, solid: new Uint8Array(16384),
    clip: new Int32Array(16384), walls: new Uint8Array(16384), box: new THREE.Box3(), pins: null };
}
const retryAt = new Map(), tries = new Map();
function failed(rid, e) {
  const n = (tries.get(rid) || 0) + 1;
  tries.set(rid, n); retryAt.set(rid, performance.now() + Math.min(30000, 1000 * 2 ** n));
  console.warn('[map07] region ' + rid + ' will be asked for again', e && e.message);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let sliceT = 0;
const overBudget = () => performance.now() - sliceT > 6;   /* a build hands the frame back once it has held it this long */
const breathe = () => nextFrame().then(() => { sliceT = performance.now(); });
/* a neighbour's terrain is rebuilt on a later frame, once however many squares land beside it: its seams and its edge blends */
const terrDirty = new Set();
let terrBusy = 0;
function markTerrain(R) {
  terrDirty.add(R.rid);
  if (terrBusy) return;
  terrBusy = 1;
  (async () => {
    while (terrDirty.size) {
      await nextFrame();
      const rid = terrDirty.values().next().value;
      terrDirty.delete(rid);
      const n = regions.get(rid);
      if (n && n.H) buildTerrain(n);
    }
    terrBusy = 0;
  })();
}
async function loadRegion(rid) {
  if (regions.has(rid) || !streams(rid)) return;
  const R = newRegion(rid), gone = () => regions.get(rid) !== R;
  R.syn = !inMain(rid) && !scopeAll;   // a made square (synth07.js)
  regions.set(rid, R);
  R.groundP = new Promise(res => { R.groundDone = res; });
  try {
    if (!(await groundStage(R)) || gone() || !(await defsStage(R)) || gone()) return;
  } catch (e) {
    if (!gone()) { unloadRegion(rid); failed(rid, e); }
    return;
  } finally { R.groundDone(); }
  tries.delete(rid);
  sceneryStage(R).catch(e => console.warn('[map07] scenery ' + rid, e));   /* the lane frees now: the square stands and walks while its models fill in */
}
async function groundStage(R) {
  const rid = R.rid;
  if (R.syn) {   // made, not fetched: the maker hands the frame back every few milliseconds of its own
    let t0 = performance.now();
    const sq = await synth.square(rid, () => performance.now() - t0 > 5 ? nextFrame().then(() => { t0 = performance.now(); }) : null);
    if (regions.get(rid) !== R || !sq) return false;
    Object.assign(R, { H: sq.H, UL: sq.UL, OL: sq.OL, SR: sq.SR, FL: sq.FL, bridge: new Uint8Array(4096), synSpawns: sq.spawns });
    for (let i = 0; i < 4096; i++) R.bridge[i] = sq.FL[4096 + i] & 2 ? 1 : 0;
    R.placed = sq.locs.slice();
  } else {
    const [tb, lb] = await Promise.all([getBin(OUT + '/t/' + rid + '.bin'), getBin(OUT + '/l/' + rid + '.bin').catch(e => { if (e.status === 404) return null; throw e; })]);
    if (regions.get(rid) !== R) return false;
    Object.assign(R, parseTerrain(tb));
    R.placed = lb ? parseLocs(lb) : [];
  }
  const bx = R.sqX * 64, by = R.sqY * 64;
  R.box.set(new THREE.Vector3(bx - 0.5, -60, -(by + 64) + 0.5), new THREE.Vector3(bx + 63.5, 200, -by + 0.5));
  /* floor tiles: roof hiding reads solid; a blocked tile setting collides on its render plane */
  for (let p = 0; p < 4; p++) for (let i = 0; i < 4096; i++) {
    const rp = p >= 1 && R.bridge[i] ? p - 1 : p;
    if (R.UL[p * 4096 + i] || R.OL[p * 4096 + i]) R.solid[rp * 4096 + i] = 1;
    if (R.FL[p * 4096 + i] & 1 && !(p === 0 && R.bridge[i])) R.clip[rp * 4096 + i] |= F_FLOOR;
  }
  buildTerrain(R);
  R.groundDone();
  /* the neighbours close their seams on our heights, and their edge blends reach five tiles into us */
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const n = (dx || dy) && regions.get(ridSq(R.sqX + dx, R.sqY + dy)); if (n && n.H) markTerrain(n); }
  return true;
}
async function defsStage(R) {
  const rid = R.rid, placed = R.placed, bx = R.sqX * 64, by = R.sqY * 64;
  /* defs: every placed id, both states of every door, varbit children; the spawns' too, so game.js can name and type a monster the
     moment the square is up (their models and frames are fetched per figure, when one stands near enough to be drawn) */
  const ids = new Set(placed.map(p => p.id));
  for (const p of placed) { const pr = doorPairs.get(p.id); if (pr && pr.other < SELF_DOOR) ids.add(pr.other); }
  const spawnList = R.synSpawns || (R.syn ? [] : spawnsByRegion.get(rid)) || [], npcIds = new Set();
  for (const s of spawnList) { npcIds.add(s.id); if (s.as !== undefined) npcIds.add(s.as); }
  const [dd, nd] = await Promise.all([defs('loc', ids), npcIds.size ? defs('npc', npcIds) : {}]);
  const kids = new Set(), nkids = new Set();
  for (const i of ids) { const d = dd[i]; if (d && !d.models) { const c = defaultChild(d); if (c >= 0) kids.add(c); } }
  for (const s of spawnList) { const d = nd[s.id]; if (d && !d.models) { const c = defaultChild(d); if (c >= 0) nkids.add(c); } }
  await Promise.all([kids.size ? defs('loc', kids).then(k => { Object.assign(dd, k); }) : 0, nkids.size ? defs('npc', nkids) : 0]);
  const more = [];   /* a multiloc's door child brings its other state; a self-swinging leaf, its mirror */
  for (const i of kids) { const pr = doorPairs.get(i); if (pr && pr.other < SELF_DOOR && !dd[pr.other]) more.push(pr.other); }
  if (more.length) Object.assign(dd, await defs('loc', more));
  for (const i of [...ids, ...kids]) { const pr = doorPairs.get(i); if (pr && pr.other >= SELF_DOOR) mirrorDoor(dd, pr.other); }
  if (regions.get(rid) !== R) return false;
  R.locDefs = dd; R.mids = new Set(); R.work = [];
  for (const i of [...ids, ...kids]) for (const m of ((dd[i] && dd[i].models) || [])) R.mids.add(m.model);
  /* the wall standing on each tile (the scene's boundary object), for the decorations hung on it */
  let wallOn = null;
  for (const p of placed) if (p.type <= 3) (wallOn || (wallOn = new Map())).set(p.plane * 4096 + p.x * 64 + p.y, p.id);
  /* collision, roofs, the minimap's walls and the menus; the drawing waits for the models */
  for (const p of placed) {
    const def = resolveDef(dd, p.id);
    if (!def || !def.models) continue;
    const gx = bx + p.x, gy = by + p.y, [w, l] = footprint(def, p.rot), rp = renderPlane(p.plane, gx, gy);
    const pl = { id: p.id, plane: p.plane, gx, gy, type: p.type, rot: p.rot };
    if (p.type === 5 || p.type === 6 || p.type === 8) pl.disp = decorDisp(p.type, wallOn && dd[wallOn.get(p.plane * 4096 + p.x * 64 + p.y)]);
    if (p.type >= 12 && p.type <= 21) for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < l; dy++) {
      const r2 = regionRaw(gx + dx, gy + dy);
      if (r2 && r2.solid) r2.solid[rp * 4096 + ((gx + dx) & 63) * 64 + ((gy + dy) & 63)] = 1;
    }
    if (!p.nc) clipLoc(R, def, p.id, pl, w, l);   // a made square's soft growth (nc) is walked through
    /* the minimap's pictures: a map-function icon (bank, shop, altar) and the small scene sprite (a tree, a rock) */
    const base = dd[p.id] || def, icon = base.mapIconId !== undefined ? base.mapIconId : def.mapIconId, scene = base.mapSceneId !== undefined ? base.mapSceneId : def.mapSceneId;
    if (icon !== undefined) R.icons.push(gx, gy, rp, icon);
    if (scene !== undefined) R.scenes.push(gx, gy, rp, scene, w, l);
    if ((p.type === 0 || p.type === 2) && clipPlane(p.plane, gx, gy) >= 0) {   /* minimap walls: bit per edge (W N E S), doors marked; none for what stands under a deck */
      const e = p.type === 2 ? (1 << p.rot) | (1 << ((p.rot + 1) & 3)) : 1 << p.rot, i = rp * 4096 + p.x * 64 + p.y;
      R.walls[i] |= e | (openable(def, p.id) ? 16 : 0);
    }
    const kid = dd[p.id] && !dd[p.id].models ? defaultChild(dd[p.id]) : -1;
    if (kid >= 0 && doorPairs.has(kid)) { pl.src = p.id; pl.id = kid; }   // a toll gate or a quest's trapdoor: the child it shows is the door
    if (doorPairs.has(pl.id)) {
      const key = pl.plane + ',' + pl.gx + ',' + pl.gy + ',' + pl.type, cur = locOverrides.get(key) || pl;
      doorWall(key, cur, resolveDef(dd, cur.id));   // walled from the first moment the square stands, before its models come
      R.work.push({ pl, door: 1 }); continue;
    }
    /* only a piece with a menu is pickable, and every kind game.js can put to work has one (Chop down, Mine, Bank...); a recorded
       link lends a menu to a piece the map shows without one */
    const linked = !def.ops && transByLoc[p.id] && transByLoc[p.id].some(t => t.lx === gx && t.ly === gy && t.lp === p.plane);
    const ud = def.ops || linked ? newOwner(R, pl, def, p.id, w, l) : null;
    if (ud && !ud.ops.length) { R.work.push({ pl, def, ud: null, rp }); continue; }
    const spec = ud && H.classify ? H.classify(ud) : null;
    if (spec) ud.spec = spec;
    if (spec && spec.dyn) {
      ud.vis = st => { ud.st = st ? 1 : 0; if (ud.setVis) ud.setVis(ud.st); };   /* the object answers now; its meshes take the state when they exist */
      R.work.push({ pl, def, ud, spec, dyn: 1 }); R.owners.push(ud); R.objs.push(ud);
      continue;
    }
    const anim = def.animationId >= 0 ? def.animationId : base.animationId >= 0 ? base.animationId : -1;
    R.work.push(anim >= 0 ? { pl, def, ud, rp, seq: anim, ph: def.randomizeAnimationStart || base.randomizeAnimationStart ? (gx * 7919 + gy * 104729) % 100000 : 0 } : { pl, def, ud, rp });
    if (ud) { R.owners.push(ud); if (spec) R.objs.push(ud); }
  }
  R.placed = null;
  /* writes past the edges: ours into loaded neighbours, theirs into us */
  applyExt(R, R);
  for (const n of regions.values()) if (n !== R && n.clip && n.ext.length) applyExt(n, R);
  R.spawns = spawnList;
  R.ready = 1; lastR = null;
  if (H.onRegion) H.onRegion(R);
  return true;
}
let buildLane = Promise.resolve(), scenic = 0;
async function sceneryStage(R) {
  const rid = R.rid, gone = () => regions.get(rid) !== R;
  scenic++; pin(R.mids);   /* a trim leaves what a waiting build will read */
  try {
    const doorMods = [];   /* both states of every door stay for the square's life: a toggle redraws the other from the cache */
    for (const q of R.work) if (q.door) for (const id of [q.pl.id, doorPairs.get(q.pl.id).other]) { const d = resolveDef(R.locDefs, id); if (d && d.models) for (const m of d.models) doorMods.push(m.model); }
    pin(doorMods); R.pins = doorMods;
    for (let a = 0; ; a++) {   /* a blip leaves holes: ask again a few times before building with what came */
      await models(R.mids);
      if (gone()) return;
      if (!modelsMissing(R.mids) || a === 3) break;
      await sleep(1500 * (a + 1));
      if (gone()) return;
    }
    /* the seams: the east, north and north-east neighbours lend the heights our edge pieces stand on */
    const nb = [[1, 0], [0, 1], [1, 1]].map(([dx, dy]) => regions.get(ridSq(R.sqX + dx, R.sqY + dy))).filter(n => n && !n.H);
    if (nb.length) { await Promise.race([Promise.all(nb.map(n => n.groundP)), sleep(2500)]); if (gone()) return; }
    R.lodS = { d: 0, f: 0 }; R.lodV = { d: 0, c: 0, f: 0, g: 0 };   // lodTick builds and shows its levels from here
    lodRegion(R);
  } finally { scenic--; unpin(R.mids); }
}
/* ---- levels of detail, by how far the camera stands from a square — not the player: a camera backed far off sees every square from
   afar, the one underfoot too.
   near (the camera within LOD_IN tiles): the square as the client draws it — every piece in its textures, its doors that swing, its
        flames and flags in motion — and its clutter (flowers, grass tufts, pebbles, ground dressing: a tile across with no menu)
        only within CLUTTER_IN, where anything so small can be seen at all;
   far  (past LOD_OUT): one mesh a floor of what shapes the view — walls, roofs, trees, rocks, every piece more than a tile across — in
        each texture's own average colour; never a room's furniture, a wall's trinkets, see-through glass or clutter.
   Each level is built the first time it is wanted (the near one too when the player stands close enough to click the square's
   pieces), one square at a time in the build lane, and a square keeps showing the level it has until the one wanted stands: from
   far off the world is all there in outline, and it sharpens as the camera comes in; nothing pops into being ---- */
const LOD_IN = 72, LOD_OUT = 84, CLUTTER_IN = 40, CLUTTER_OUT = 48, GRAIN_IN = 300, GRAIN_OUT = 320, LOD_TOUCH = 48;   // grain: a far level's lone trees and rocks, which the very farthest squares leave out
const lodCam = { x: 0, y: 1e4, z: 0, gx: 0, gy: 0 };
const isClutter = q => !q.ud && !q.door && !q.dyn && q.seq === undefined && (q.pl.type === 22 || ((q.pl.type === 10 || q.pl.type === 11) && (q.def.width || 1) <= 1 && (q.def.length || 1) <= 1));
function lodBox(R, k, p) {   // a square's container for one level (d near, c clutter, f far) on one floor, made on first use
  const K = R.lodG || (R.lodG = { d: [], c: [], f: [], g: [] });
  let g = K[k][p];
  if (!g) { g = K[k][p] = new THREE.Group(); g.visible = !!(R.lodV && R.lodV[k]); planeG[p].add(g); R.groups.push(g); }
  return g;
}
function lodQueue(R, k) {   // a square's near ('d') or far ('f') level, built once, in the build lane
  if (R.lodS[k]) return;
  R.lodS[k] = 1;
  const rid = R.rid, run = buildLane.then(async () => {
    if (regions.get(rid) !== R) return;
    scenic++; pin(R.mids);
    try {
      await models(R.mids);   // what a trim let go since the square first came in
      if (regions.get(rid) !== R) return;
      if (k === 'd') await buildNear(R); else await buildFar(R);
      if (regions.get(rid) !== R) return;
      R.lodS[k] = 2; R.built = 1; lodRegion(R);
    } finally { scenic--; unpin(R.mids); }
  });
  buildLane = run.catch(e => console.warn('[map07] scenery ' + rid, e));
}
function lodRegion(R) {   // one square: what it wants, what it builds, what it shows
  if (!R.lodS) return;
  const C = lodCam, bx = R.sqX * 64, by = R.sqY * 64, V = R.lodV;
  const dx = Math.max(bx - 0.5 - C.x, 0, C.x - bx - 63.5), dz = Math.max(-(by + 63.5) - C.z, 0, C.z + by - 0.5), dy = Math.max(0, C.y - 4);   // C.y: the camera's height over the player
  const cd = Math.sqrt(dx * dx + dz * dz + dy * dy), pd = Math.max(bx - C.gx, 0, C.gx - bx - 63, by - C.gy, C.gy - by - 63);
  const wantNear = V.d ? cd < LOD_OUT : cd < LOD_IN;
  if (wantNear || pd < LOD_TOUCH) lodQueue(R, 'd');
  if (!wantNear) lodQueue(R, 'f');
  const d = R.lodS.d === 2 && (wantNear || R.lodS.f !== 2), f = !d && R.lodS.f === 2, c = d && (V.c ? cd < CLUTTER_OUT : cd < CLUTTER_IN), g = f && (V.g ? cd < GRAIN_OUT : cd < GRAIN_IN);
  const set = (k, on) => { if (V[k] === on) return; V[k] = on; if (R.lodG) for (const x of R.lodG[k]) if (x) x.visible = on; };
  set('d', d); set('c', c); set('f', f); set('g', g);
}
function lodTick(cx, cy, cz, gx, gy) {   // once a frame from game.js: the camera's world x and z, its height over the player, and the player's tile
  lodCam.x = cx; lodCam.y = cy; lodCam.z = cz; lodCam.gx = gx; lodCam.gy = gy;
  for (const R of regions.values()) lodRegion(R);
}
async function buildNear(R) {
  const rid = R.rid, gone = () => regions.get(rid) !== R, sinks = [0, 1, 2, 3].map(() => makeSink()), fine = [0, 1, 2, 3].map(() => makeSink()), later = [], anims = [[], [], [], []];
  await breathe();
  if (gone()) return;
  for (const q of R.work) {
    if (q.door || q.dyn) { later.push(q); continue; }
    if (q.seq !== undefined) {   /* an animated piece keeps its models and transforms, to be posed later */
      const rec = { rec: [], ud: null };
      drawLoc(rec, q.def, q.pl, q.ud, false);
      if (rec.rec.length) anims[q.rp].push({ rec: rec.rec, ud: q.ud, seq: q.seq, ph: q.ph });
      continue;
    }
    drawLoc((isClutter(q) ? fine : sinks)[q.rp], q.def, q.pl, q.ud, false);
    if (overBudget()) { await breathe(); if (gone()) return; }
  }
  for (let p = 0; p < 4; p++) {
    const g = lodBox(R, 'd', p);
    flushSink(sinks[p], g);
    if (anims[p].length) { R.anim = R.anim || []; R.anim[p] = animFlush(anims[p], g); }
    if (fine[p].pos.length || fine[p].tex.size || fine[p].tpos.length || fine[p].ttex.size) flushSink(fine[p], lodBox(R, 'c', p));
    if (overBudget()) { await breathe(); if (gone()) return; }
  }
  for (const q of later) {
    if (q.door) {
      const key = q.pl.plane + ',' + q.pl.gx + ',' + q.pl.gy + ',' + q.pl.type;
      spawnDoor(R, key, q.pl, locOverrides.get(key) || q.pl);
    } else dynamic(R, q.def, q.pl, q.ud, q.spec);
    if (overBudget()) { await breathe(); if (gone()) return; }
  }
}
async function buildFar(R) {
  const rid = R.rid, gone = () => regions.get(rid) !== R, bx = R.sqX * 64, by = R.sqY * 64;
  const sinks = [0, 1, 2, 3].map(() => Object.assign(makeSink(), { avg: 1 })), grain = [0, 1, 2, 3].map(() => Object.assign(makeSink(), { avg: 1 }));
  await breathe();
  if (gone()) return;
  for (const q of R.work) {
    if (q.door || !q.def || isClutter(q)) continue;
    const t = q.pl.type, small = (q.def.width || 1) <= 1 && (q.def.length || 1) <= 1;
    if (t === 22 || (t >= 4 && t <= 8)) continue;   // ground dressing, and what hangs on a wall
    if ((t === 10 || t === 11) && small && R.FL[q.pl.plane * 4096 + (q.pl.gx - bx) * 64 + (q.pl.gy - by)] & 4) continue;   // a room's furniture, under its roof
    if (q.ud && q.ud.st) continue;   // a felled tree, an emptied vein
    const rp = q.rp !== undefined ? q.rp : renderPlane(q.pl.plane, q.pl.gx, q.pl.gy);
    drawLoc(((t === 10 || t === 11) && small ? grain : sinks)[rp], q.def, q.pl, null, false);   // a lone tree, rock or post out of doors is the landscape's grain: kept apart, to go first
    if (overBudget()) { await breathe(); if (gone()) return; }
  }
  for (let p = 0; p < 4; p++) {
    if (sinks[p].pos.length) lodBox(R, 'f', p).add(bake(sinks[p].pos, sinks[p].col));
    if (grain[p].pos.length) lodBox(R, 'g', p).add(bake(grain[p].pos, grain[p].col));
  }
}
function applyExt(src, only) {
  const e = src.ext;
  for (let i = 0; i < e.length; i += 3) {
    const t = regions.get(e[i]);
    if (t && t.clip && (only === src ? t !== src : t === only)) t.clip[e[i + 1]] |= e[i + 2];
  }
}
function spawnDoor(R, key, orig, pl) {
  const def = resolveDef(R.locDefs, pl.id);
  if (!def || !def.models) return;
  const lid = orig.src !== undefined ? orig.src : pl.id >= SELF_DOOR ? pl.id - SELF_DOOR : pl.id;   // the id its links are recorded under (a multiloc's, in either state)
  const [w, l] = footprint(def, pl.rot), ud = newOwner(R, pl, def, lid, w, l);
  ud.door = { key, orig, pl };
  dynamic(R, def, pl, ud, null);
  R.owners.push(ud);
}
function toggleDoor(ud, mate) {
  const R = ud.R, { key, orig } = ud.door;
  let pl = ud.door.pl;
  if (ud.dead) return;
  ud.dead = 1;
  const oi = R.owners.indexOf(ud); if (oi >= 0) R.owners.splice(oi, 1);
  const gi = R.groups.indexOf(ud.dyn); if (gi >= 0) R.groups.splice(gi, 1);
  disposeMesh(ud.dyn);
  const pair = doorPairs.get(pl.id);
  if (mate && pair.closed && pair.other >= SELF_DOOR) {   /* a double door of one model: each leaf swings away from the other, not into the gap */
    const d = DOOR_DIR[(pl.rot + 1) & 3], m = mate.door.pl;
    pl = Object.assign({}, pl, { flip: m.gx === pl.gx + d[0] && m.gy === pl.gy + d[1] ? 1 : 0 });
  }
  const next = toggledPlacement(pl), home = next.id === orig.id && next.gx === orig.gx && next.gy === orig.gy && next.rot === orig.rot;
  if (home) locOverrides.delete(key); else locOverrides.set(key, next);
  doorWall(key, next, resolveDef(R.locDefs, next.id));
  spawnDoor(R, key, orig, next);
}
function doorPartner(ud) {   /* the other leaf of a double door: along the same wall line, in the same state */
  const o = ud.door.orig, closed = doorPairs.get(ud.door.pl.id).closed, along = o.rot & 1 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
  for (const R of regions.values()) for (const d of R.owners) {
    if (!d.door || d === ud) continue;
    const q = d.door.orig;
    if (q.plane !== o.plane || q.rot !== o.rot || q.type !== o.type) continue;
    if (along.some(([ax, ay]) => q.gx === o.gx + ax && q.gy === o.gy + ay) && doorPairs.get(d.door.pl.id).closed === closed) return d;
  }
  return null;
}
function unloadRegion(rid) {
  const R = regions.get(rid);
  if (!R) return;
  regions.delete(rid); lastR = null; terrDirty.delete(rid);
  if (R.ready && H.onUnload) H.onUnload(R);
  if (R.pins) { unpin(R.pins); R.pins = null; }
  for (const m of R.terr) if (m) disposeMesh(m);
  for (const g of R.groups) disposeMesh(g);
}

/* ---- streaming: every square within reach of the player, nearest first, four fetching at once; far ones go ---- */
const LANES = 4;
let queue = [], busy = 0;
/* scope: while game.js lays the seed's world round the main map, only the squares of the main map's rectangle stream (the
   others are Gielinor's own places past it: dungeons, the essence mine, reached by their own ladders and spells) */
let scopeAll = 1, synth = null;
const inMain = rid => { const x = sqXOf(rid), y = sqYOf(rid); return x >= 18 && x <= 60 && y >= 39 && y <= 64; };
const dropOutside = () => { for (const rid of [...regions.keys()]) if (!inMain(rid)) unloadRegion(rid); queue = queue.filter(inMain); };
function setScope(all) {
  all = all ? 1 : 0;
  if (all === scopeAll) return;
  scopeAll = all;
  dropOutside();   // the squares past the rectangle were the other scope's: the map's own places, or the made ones
}
/* a maker of squares for the world past the rectangle (synth07.js): { has(rid), square(rid, yieldFn) -> Promise<{ H, UL, OL, SR,
   FL, locs, spawns }> } in the cache's own layout. While set, and the scope is the main map's, every square outside it comes from
   here instead of the tree; null gives the map back its own squares there */
function setSynth(p) {
  if (p === synth) return;
  synth = p;
  if (!scopeAll) dropOutside();
}
/* a square this scope streams: the main map's own inside the rectangle; past it Gielinor's own places, or the made squares */
const streams = rid => inMain(rid) ? manifest.has(rid) : scopeAll ? manifest.has(rid) : !!(synth && synth.has(rid));
function update(gx, gy, reach) {
  if (!loaded) return;
  const dist = rid => { const x0 = sqXOf(rid) * 64, y0 = sqYOf(rid) * 64; return Math.max(x0 - gx, 0, gx - x0 - 63, y0 - gy, gy - y0 - 63); };
  for (const rid of [...regions.keys()]) if (dist(rid) > reach + 48 || (!inMain(rid) && (regions.get(rid).syn ? scopeAll || !synth : !scopeAll))) unloadRegion(rid);
  const rx = gx >> 6, ry = gy >> 6, n = Math.ceil(reach / 64) + 1, list = [], now = performance.now();
  for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) {
    if (!synth && (ry + dy < 0 || ry + dy > 255 || rx + dx < 0)) continue;   // the tree's squares keep to the byte; the made world runs every way
    const rid = ridSq(rx + dx, ry + dy);
    if (streams(rid) && !regions.has(rid) && dist(rid) <= reach && !(retryAt.get(rid) > now)) list.push(rid);   // a square resting after a failure waits out its rest
  }
  queue = list.sort((a, b) => dist(a) - dist(b));
  pump();
}
function pump() {
  if (!busy && !queue.length && !scenic) trimModels();   /* only while no square is laying its scenery */
  while (busy < LANES && queue.length) {
    const rid = queue.shift();
    if (regions.has(rid)) continue;
    busy++;
    loadRegion(rid).catch(e => console.warn('[map07] region', rid, e)).then(() => { busy--; pump(); });
  }
}
function clear() {
  for (const rid of [...regions.keys()]) unloadRegion(rid);
  queue = []; locOverrides.clear(); retryAt.clear(); tries.clear(); doorClip.clear(); doorEdges.clear(); tileDoors.clear();
}
const pending = () => busy + queue.length;

/* ---- picking: the owners' boxes first, then their own triangles, nearest hit wins ---- */
const _hit = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
function pick(ray, maxPlane, maxDist) {
  let best = null, bestD = maxDist || 1e9;
  for (const R of regions.values()) {
    if (!R.ready || !ray.intersectBox(R.box, _hit)) continue;
    for (const ud of R.owners) {
      if (ud.plane > maxPlane || ud.dead) continue;
      if (ud.dyn && !ud.dyn.visible) continue;
      if (!ray.intersectBox(ud.box, _hit) || ray.origin.distanceTo(_hit) >= bestD) continue;
      const tr = ud.tris;
      for (let k = 0; k < tr.length; k += 3) {
        const mesh = tr[k];
        if (!mesh.visible) continue;
        const p = mesh.geometry.attributes.position.array;
        for (let f = tr[k + 1]; f < tr[k + 2]; f++) {
          const o = f * 9;
          _a.set(p[o], p[o + 1], p[o + 2]); _b.set(p[o + 3], p[o + 4], p[o + 5]); _c.set(p[o + 6], p[o + 7], p[o + 8]);
          if (!ray.intersectTriangle(_a, _b, _c, false, _hit)) continue;
          const d = ray.origin.distanceTo(_hit);
          if (d < bestD) { bestD = d; best = ud; }
        }
      }
    }
  }
  return best ? { ud: best, d: bestD } : null;
}

/* ---- transports (stairs, trapdoors, dungeon doors): keyed by loc id + option, matched to the exact placement ---- */
const opKey = s => String(s).toLowerCase().replace(/[^a-z]/g, '');
/* verbs that move you: only these may take a recorded link whose own verb the cache's menu no longer offers */
const MOVE_OP = /climb|walk|enter|exit|jump|go-?(up|down|through)|squeeze|crawl|cross|pass|travel|descend|ascend|board|dive|swim|leave|step/i;
const linksAt = ud => (transByLoc[ud.locId] || []).filter(t => t.lx === ud.gx && t.ly === ud.gy && t.lp === ud.cachePlane);
function transport(ud, op, px, py) {
  const here = linksAt(ud), k = opKey(op);
  let list = here.filter(t => opKey(t.o) === k);
  /* the dump kept some links under a verb the menu no longer has (walk-down for Climb-down, enter for Jump-down): a moving verb
     with no link of its own takes those orphans */
  if (!list.length && MOVE_OP.test(op)) { const own = new Set(ud.ops.map(opKey)); list = here.filter(t => !own.has(opKey(t.o))); }
  if (!list.length) return null;
  const cost = t => (t.bad ? 1e6 : 0) + Math.abs(t.x - px) + Math.abs(t.y - py);
  const t = list.sort((a, b) => cost(a) - cost(b))[0];
  return { x: t.d[0], y: t.d[1], p: Math.min(Math.max(t.d[2], 0), 3) };
}
function solidAt(p, gx, gy) { const r = regionAt(gx, gy); return r ? r.solid[p * 4096 + (gx & 63) * 64 + (gy & 63)] : 0; }
function coveredAt(p, gx, gy) { for (let q = p + 1; q < 4; q++) if (solidAt(q, gx, gy)) return true; return false; }
function climbTarget(ud, op, plane) {   /* a ladder or staircase the transport table does not know: a floor up or down in place */
  const t = op.toLowerCase();
  let to = null;
  if (t.includes('up')) to = plane + 1;
  else if (t.includes('down')) to = plane - 1;
  else if (t.includes('top')) { to = plane; for (let p = plane + 1; p < 4; p++) if (solidAt(p, ud.gx, ud.gy)) to = p; }
  else if (t.includes('bottom')) to = 0;
  else to = plane < 3 && coveredAt(plane, ud.gx, ud.gy) ? plane + 1 : plane - 1;
  return to === null || to < 0 || to > 3 || to === plane ? null : to;
}

/* ---- animated figures (npcs): the part models merged, classic frame archives applied, translucent faces apart ---- */
const SINE = new Int32Array(2048), COSINE = new Int32Array(2048);
for (let i = 0; i < 2048; i++) { SINE[i] = (65536 * Math.sin(i * Math.PI / 1024)) | 0; COSINE[i] = (65536 * Math.cos(i * Math.PI / 1024)) | 0; }
const frameAt = (frames, t) => { let acc = 0; for (let i = 0; i < frames.length; i++) { acc += frames[i].ms; if (t < acc) return i; } return frames.length - 1; };
/* the client's Model.transform group operations on x, y, z triples in cache units: groups maps a vertex label to its vertex
   indices. Shared by the figures, the animated scenery, the spot animations and the player's own 2007 kit (osrs.js). */
function transformVerts(w, groups, frame) {
  const { bases, ds } = frame.tr, fm = frame.fm;
  let ox = 0, oy = 0, oz = 0;
  for (let ti = 0; ti < bases.length; ti++) {
    const base = bases[ti];
    if (base >= fm.types.length) continue;
    const type = fm.types[base], labels = fm.labels[base], dx = ds[ti * 3], dy = ds[ti * 3 + 1], dz = ds[ti * 3 + 2];
    if (type === 0) {
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const lb of labels) { const g = groups.get(lb); if (g) for (const vi of g) { sx += w[vi * 3]; sy += w[vi * 3 + 1]; sz += w[vi * 3 + 2]; n++; } }
      if (n) { ox = ((sx / n) | 0) + dx; oy = ((sy / n) | 0) + dy; oz = ((sz / n) | 0) + dz; } else { ox = dx; oy = dy; oz = dz; }
    } else if (type === 1) {
      for (const lb of labels) { const g = groups.get(lb); if (g) for (const vi of g) { w[vi * 3] += dx; w[vi * 3 + 1] += dy; w[vi * 3 + 2] += dz; } }
    } else if (type === 2) {
      const ax = (dx << 3) & 2047, ay = (dy << 3) & 2047, az = (dz << 3) & 2047;
      for (const lb of labels) {
        const g = groups.get(lb);
        if (!g) continue;
        for (const vi of g) {
          let x = w[vi * 3] - ox, y = w[vi * 3 + 1] - oy, z = w[vi * 3 + 2] - oz;
          if (az) { const s = SINE[az], c = COSINE[az], q = (y * s + x * c) >> 16; y = (y * c - x * s) >> 16; x = q; }
          if (ax) { const s = SINE[ax], c = COSINE[ax], q = (y * c - z * s) >> 16; z = (y * s + z * c) >> 16; y = q; }
          if (ay) { const s = SINE[ay], c = COSINE[ay], q = (z * s + x * c) >> 16; z = (z * c - x * s) >> 16; x = q; }
          w[vi * 3] = x + ox; w[vi * 3 + 1] = y + oy; w[vi * 3 + 2] = z + oz;
        }
      }
    } else if (type === 3) {
      for (const lb of labels) {
        const g = groups.get(lb);
        if (g) for (const vi of g) { w[vi * 3] = ox + (((w[vi * 3] - ox) * dx) >> 7); w[vi * 3 + 1] = oy + (((w[vi * 3 + 1] - oy) * dy) >> 7); w[vi * 3 + 2] = oz + (((w[vi * 3 + 2] - oz) * dz) >> 7); }
      }
    }   /* type 5 = alpha, ignored */
  }
}
/* a vertex label -> its vertex indices, for transformVerts (255 marks a vertex no label moves) */
function labelGroups(labels, n) {
  const groups = new Map();
  for (let i = 0; i < n; i++) { const l = labels[i]; if (l === 255) continue; let a = groups.get(l); if (!a) groups.set(l, a = []); a.push(i); }
  return groups;
}
/* a seq's playable frames, loading them on first ask: the frames, or null while loading (and for a seq with none) */
function seqFrames(id) {
  if (!(id >= 0)) return null;
  if (seqs.has(id)) return seqs.get(id);
  if (!seqWant.has(id)) { seqWant.add(id); loadSeqs([id]).catch(() => {}).then(() => seqWant.delete(id)); }
  return null;
}
const seqWant = new Set();
function mergeAnim(parts) {
  let vc = 0;
  for (const p of parts) vc += p.model.vc;
  const verts = new Int16Array(vc * 3), vg = new Uint8Array(vc).fill(255), tris = [], colors = [], trisT = [], colorsT = [];
  let vo = 0;
  for (const p of parts) {
    const m = p.model;
    verts.set(m.verts, vo * 3);
    if (m.vgroups) vg.set(m.vgroups, vo);
    for (let f = 0; f < m.fc; f++) {
      if (faceHidden(m, f)) continue;
      const alpha = m.alphas ? m.alphas[f] : 0, [r, g, b] = faceColor(m, f, p.recol, p.retex);
      if (alpha > 0) { trisT.push(m.idx[f * 3] + vo, m.idx[f * 3 + 1] + vo, m.idx[f * 3 + 2] + vo); colorsT.push(r, g, b, (255 - alpha) / 255); }
      else { tris.push(m.idx[f * 3] + vo, m.idx[f * 3 + 1] + vo, m.idx[f * 3 + 2] + vo); colors.push(r, g, b); }
    }
    vo += m.vc;
  }
  const groups = new Map();
  for (let i = 0; i < vc; i++) { if (vg[i] === 255) continue; let a = groups.get(vg[i]); if (!a) groups.set(vg[i], a = []); a.push(i); }
  return { vc, verts, tris: Uint32Array.from(tris), colors, trisT: Uint32Array.from(trisT), colorsT, groups };
}
let matNpc = null, matNpcT = null;
class Entity {
  constructor(mg, scale) {
    if (!matNpc) {
      matNpc = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide });
      matNpcT = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    }
    this.mg = mg; this.scale = scale; this.work = new Int32Array(mg.vc * 3);
    const geom = (tris, colors, stride) => {
      const n = tris.length / 3, pos = new Float32Array(n * 9), col = new Float32Array(n * 3 * stride);
      for (let f = 0; f < n; f++) for (let k = 0; k < 3; k++) for (let c = 0; c < stride; c++) col[(f * 3 + k) * stride + c] = colors[f * stride + c];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, stride));
      return g;
    };
    this.mesh = new THREE.Mesh(geom(mg.tris, mg.colors, 3), matNpc);
    this.mesh.frustumCulled = false;
    this.meshT = null;
    if (mg.trisT.length) { this.meshT = new THREE.Mesh(geom(mg.trisT, mg.colorsT, 4), matNpcT); this.meshT.frustumCulled = false; this.mesh.add(this.meshT); }
    this.frames = null; this.idx = -1; this.t = 0; this.total = 0;
    this.writePose(mg.verts);
    this.mesh.geometry.computeBoundingBox();
    this.height = Math.max(0.5, this.mesh.geometry.boundingBox.max.y);
  }
  play(frames, once) {   /* once: run the seq a single time and hold its last frame (an attack, a death), done when it ends */
    if (frames === this.frames && !once) return;
    this.frames = frames; this.t = 0; this.idx = -1; this.total = 0; this.once = !!once; this.done = false;
    if (frames) for (const f of frames) this.total += f.ms; else this.writePose(this.mg.verts);
  }
  update(dtMs, lod) {   /* lod 0: pose and relight; 1: pose on the old normals (the eye cannot tell at range); 2: hold the pose */
    if (!this.frames || !this.total) return;
    if (this.once) { this.t += dtMs; if (this.t >= this.total) { this.t = this.total - 1; this.done = true; } }
    else this.t = (this.t + dtMs) % this.total;
    if (lod === 2) return;
    const idx = frameAt(this.frames, this.t);
    if (idx === this.idx) return;
    this.idx = idx;
    this.lite = lod === 1;
    this.apply(this.frames[idx]);
  }
  apply(frame) {   /* the client's Model.transform group operations */
    this.work.set(this.mg.verts);
    transformVerts(this.work, this.mg.groups, frame);
    this.writePose(this.work);
  }
  writePose(src) {   /* cache space -> this world's (x, -y, -z), in tiles */
    const [sx, sh, sy] = this.scale;
    const write = (tris, mesh) => {
      const pos = mesh.geometry.attributes.position.array;
      for (let i = 0; i < tris.length; i++) { const vi = tris[i]; pos[i * 3] = src[vi * 3] * sx * U; pos[i * 3 + 1] = -src[vi * 3 + 1] * sh * U; pos[i * 3 + 2] = -src[vi * 3 + 2] * sy * U; }
      mesh.geometry.attributes.position.needsUpdate = true;
      if (!this.lite || !mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
    };
    write(this.mg.tris, this.mesh);
    if (this.meshT) write(this.mg.trisT, this.meshT);
  }
  dispose() { disposeMesh(this.mesh); }
}
/* the look of a spawn: the def (or the child the observing account saw), merged, with its stand and walk frames */
function npcDefOf(id, as) {
  const d = defSync('npc', id);
  if (!d || d.models) return d;
  const c = defSync('npc', defaultChild(d));
  if (c && c.models) return c;
  return as !== undefined ? defSync('npc', as) : null;
}
async function npcFigure(def) {
  if (!def || !def.models) return null;
  pin(def.models);   /* a trim between the fetch and the build must not take a part away */
  try { await Promise.all([models(def.models), loadSeqs([def.standingAnimation, def.walkingAnimation])]); } finally { unpin(def.models); }
  if (modelsMissing(def.models)) throw Object.assign(new Error('figure parts did not load'), { status: 503 });   /* a blip: the caller asks again */
  const { recol, retex } = colorMaps(def);
  const parts = def.models.map(m => ({ model: model(m), recol, retex })).filter(p => p.model);
  if (!parts.length) return null;
  const ws = (def.widthScale || 128) / 128, ent = new Entity(mergeAnim(parts), [ws, (def.heightScale || 128) / 128, ws]);
  /* walkingAnimation === standingAnimation marks a figure that never walks (a merchant at a post); a def sharing the
     player's skeleton, or a dressed biped with no usable frames, borrows the player's stand and walk */
  let standF = seqs.get(def.standingAnimation) || null, walkF = seqs.get(def.walkingAnimation) || null;
  const still = def.walkingAnimation !== undefined && def.walkingAnimation === def.standingAnimation;
  if (still) walkF = null;
  if (!standF || (!walkF && !still)) {
    const pW = seqs.get(PLAYER_WALK), pS = seqs.get(PLAYER_STAND);
    const biped = (def.size || 1) === 1 && parts.length >= 4, fmMatch = standF && pW && standF[0].fm === pW[0].fm;
    if (pW && (fmMatch || biped)) { standF = standF || pS; if (!still) walkF = walkF || pW; }
  }
  ent.play(standF);
  return { ent, mesh: ent.mesh, standF, walkF, still: still || !walkF, height: ent.height, size: def.size || 1 };   // writePose already scaled the mesh by heightScale
}
/* an npc's chat head (its def's chatheadModels, recoloured as the body is), for the dialogue box */
async function headFigure(def) {
  const ids = def && def.chatheadModels;
  if (!ids || !ids.length) return null;
  await models(ids);
  const { recol, retex } = colorMaps(def), parts = ids.map(m => ({ model: model(m), recol, retex })).filter(p => p.model);
  return parts.length ? new Entity(mergeAnim(parts), [1, 1, 1]) : null;
}
function animate(fig, moving, dtMs, lod) {
  if (fig.act) {   /* an attack, a flinch or a death plays through once; a death holds its last frame */
    if (fig.ent.frames !== fig.act.f) fig.ent.play(fig.act.f, true);
    fig.ent.update(dtMs, lod === 2 ? 1 : lod || 0);
    if (fig.ent.done && !fig.act.hold) fig.act = null;
    return;
  }
  fig.ent.play(moving ? (fig.walkF || fig.standF) : fig.standF);
  fig.ent.update(dtMs, lod || 0);
}
/* start a one-off seq on a figure (its frames load on first use: a seq still fetching is skipped, as a blink the eye misses) */
function figureAct(fig, seq, hold) {
  const f = seqFrames(seq);
  if (!fig || !f) return false;
  if (fig.act && fig.act.hold) return false;   // nothing interrupts a death
  fig.act = { f, hold: !!hold };
  fig.ent.play(f, true);
  return true;
}

/* ---- spot animations (cfg/spotanim): a spell's cast, flight and splash, an arrow in the air — the model merged once a def,
   each showing its own small figure that plays the seq through and says when it is done ---- */
const spotMG = new Map();
function spotanim(id) {   /* -> Promise<{ent, mesh, total} | null> */
  let p = spotMG.get(id);
  if (!p) {
    p = (async () => {
      const d = (await defs('spotanim', [id]))[id];
      if (!d || !(d.modelId >= 0)) return null;
      await Promise.all([models([d.modelId]), d.animationId >= 0 ? loadSeqs([d.animationId]) : 0]);
      const m = model(d.modelId);
      if (!m) return null;
      const recol = new Map();
      (d.recolorToFind || []).forEach((c, i) => recol.set(c & 0xffff, d.recolorToReplace[i] & 0xffff));
      const retex = new Map();
      (d.textureToFind || []).forEach((c, i) => retex.set(c, d.textureToReplace[i]));
      return { mg: mergeAnim([{ model: m, recol, retex }]), frames: d.animationId >= 0 ? seqs.get(d.animationId) : null, s: [(d.resizeX || 128) / 128, (d.resizeY || 128) / 128, (d.resizeX || 128) / 128], rot: d.rotation | 0 };
    })().catch(() => null);
    spotMG.set(id, p);
  }
  return p.then(b => {
    if (!b) return null;
    const ent = new Entity(b.mg, b.s);
    if (b.frames) ent.play(b.frames, true);
    if (b.rot) ent.mesh.rotation.y = -b.rot * Math.PI / 1024;
    return { ent, mesh: ent.mesh, total: ent.total || 600 };
  });
}

/* ---- ground items: the inventory model lying on its tile, one geometry an item ---- */
const itemGeoP = new Map();
function itemGeo(cacheId) {
  let p = itemGeoP.get(cacheId);
  if (p) return p;
  p = (async () => {
    const d = (await defs('item', [cacheId]))[cacheId];
    if (!d || d.inventoryModel === undefined) return null;
    await models([d.inventoryModel]);
    const m = model(d.inventoryModel);
    if (!m) return null;
    const s = makeSink();
    appendModel(s, m, Object.assign({ cx: 0, cz: 0, gy: 0, sx: (d.resizeX || 128) / 128, sh: (d.resizeY || 128) / 128, sy: (d.resizeZ || 128) / 128 }, colorMaps(d)), true);
    if (!s.pos.length) return null;
    flatMats();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(s.col, 3));
    g.computeVertexNormals(); g.computeBoundingSphere();
    return g;
  })().catch(() => null);
  itemGeoP.set(cacheId, p);
  return p;
}
const itemNameIds = name => resolveItem[String(name).toLowerCase()] || null;
/* the lowest id carrying an inventory model and no note template: the item itself, not its bank note */
const itemPick = new Map();
function itemFor(name) {
  const k = String(name).toLowerCase();
  if (itemPick.has(k)) return itemPick.get(k);
  itemPick.set(k, null);
  const ids = resolveItem[k];
  if (ids) defs('item', ids).then(dd => {
    for (const id of ids) { const d = dd[id]; if (d && d.inventoryModel !== undefined && d.noteTemplate === undefined) { itemPick.set(k, id); return; } }
  });
  return null;
}
function itemMesh(geo) { flatMats(); return new THREE.Mesh(geo, matFlat); }

/* ---- maps ---- */
function tileRGB(plane, gx, gy) {   /* the colour the minimap paints for a tile on the viewer's plane; lower floors show through dim */
  const r = regionAt(gx, gy);
  if (!r) return -1;
  const i = (gx & 63) * 64 + (gy & 63);
  for (let p = plane, dim = 1; p >= 0; p--, dim *= 0.55) {
    for (let cp = p; cp <= Math.min(3, p + 1); cp++) {   /* a bridge deck's tiles are stored a plane up */
      if (cp !== p && !r.bridge[i]) continue;
      const c = tileColor(r.OL[cp * 4096 + i], r.UL[cp * 4096 + i]);
      if (c >= 0) return dim === 1 ? c : (((c >> 16 & 255) * dim) << 16) | (((c >> 8 & 255) * dim) << 8) | ((c & 255) * dim);
    }
  }
  return -1;
}
function wallBits(plane, gx, gy) { const r = regionAt(gx, gy); return r ? r.walls[plane * 4096 + (gx & 63) * 64 + (gy & 63)] : 0; }
/* the 2007 world map composite (wm/img/5.0.png, its missing squares painted in: tools/bake07/worldmap.console.js): mapsquares
   x 18..60, y 39..64, sixteen pixels a square. x0..x1, y0..y1 (tiles, the far edges exclusive) is the main map's rectangle:
   the world map shows only this, and past it just the place the player stands in */
const WORLD_IMG = { src: DATA + '/world.png', gx0: 18 * 64, gy1: 65 * 64, tpp: 4, x0: 18 * 64, x1: 61 * 64, y0: 39 * 64, y1: 65 * 64 };
let worldImgT = 0;
function worldImage() {   /* fetched as a blob, so the pixel read below never meets a copy cached without CORS; a failure rests ten seconds */
  if (!worldImg && performance.now() >= worldImgT) {
    const im = worldImg = new Image(), get = cache => fetch(WORLD_IMG.src, { cache }).then(r => r.ok ? r.blob() : Promise.reject(new Error('world map ' + r.status)));
    get('default').catch(() => get('reload')).then(b => { im.src = URL.createObjectURL(b); }, () => { if (worldImg === im) { worldImg = null; worldImgT = performance.now() + 10000; } });
  }
  return worldImg && worldImg.complete && worldImg.naturalWidth ? worldImg : null;
}
let landPx = null, landW = 0, landH = 0;
function worldRGB(gx, gy) {   /* the composite's pixel under a tile, or -1 off it (the minimap's backdrop past the loaded squares) */
  const im = worldImage();
  if (!im) return -1;
  if (!landPx) {
    const c = document.createElement('canvas'); c.width = landW = im.naturalWidth; c.height = landH = im.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    try { landPx = g.getImageData(0, 0, landW, landH).data; } catch (e) { landPx = new Uint8ClampedArray(0); landW = landH = 0; }   /* an unreadable picture is no backdrop, not an error every frame */
  }
  const px = Math.floor((gx - WORLD_IMG.gx0) / WORLD_IMG.tpp), py = Math.floor((WORLD_IMG.gy1 - gy) / WORLD_IMG.tpp);
  if (px < 0 || py < 0 || px >= landW || py >= landH) return -1;
  const o = (py * landW + px) * 4;
  return (landPx[o] << 16) | (landPx[o + 1] << 8) | landPx[o + 2];
}
function isLand(gx, gy) {   /* for placing a clue: the composite's own colour says water or void */
  const c = worldRGB(gx, gy);
  if (c < 0) return false;
  const r = c >> 16 & 255, g = c >> 8 & 255, b = c & 255;
  return !(r < 12 && g < 12 && b < 12) && !(b > r + 30 && b > g + 20);
}
/* an edge flag between two orthogonal neighbours: can a hand reach across, whatever stands on the far tile */
function wallBetween(rp, x, y, dx, dy) {
  if (dy > 0) return !!(flagAt(rp, x, y + 1) & F_S);
  if (dy < 0) return !!(flagAt(rp, x, y - 1) & F_N);
  if (dx > 0) return !!(flagAt(rp, x + 1, y) & F_W);
  if (dx < 0) return !!(flagAt(rp, x - 1, y) & F_E);
  return false;
}
/* a real square's own data, lent to the made world (synth07's districts and features): its terrain, its placements and its
   spawns, fetched from the tree exactly as the square itself streams; the last few kept */
const srcP = new Map(), spawnN = new Map();   /* spawnN: npc id -> how many times the main map spawns it (one is somebody; many are anybody) */
function sourceSquare(rid) {
  let p = srcP.get(rid);
  if (p) return p;
  p = Promise.all([getBin(OUT + '/t/' + rid + '.bin'), getBin(OUT + '/l/' + rid + '.bin').catch(e => { if (e.status === 404) return null; throw e; })])
    .then(([tb, lb]) => ({ t: parseTerrain(tb), locs: lb ? parseLocs(lb) : [], spawns: spawnsByRegion.get(rid) || [] }), e => { srcP.delete(rid); throw e; });
  srcP.set(rid, p);
  if (srcP.size > 64) srcP.delete(srcP.keys().next().value);
  return p;
}
const squareP = new Map();   /* rid -> canvas (128x128, two pixels a tile, walls on the edges) | null while fetching or absent */
let squareBusy = 0;
function squareCanvas(rid) {
  if (squareP.has(rid)) return squareP.get(rid);
  if (!manifest.has(rid) || squareBusy >= 12) return null;
  if (squareP.size > 900) for (const k of [...squareP.keys()].slice(0, 300)) squareP.delete(k);
  squareP.set(rid, null); squareBusy++;
  Promise.all([getBin(OUT + '/t/' + rid + '.bin'), getBin(OUT + '/l/' + rid + '.bin').catch(() => null)]).then(([tb, lb]) => {
    const t = parseTerrain(tb), c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), im = g.createImageData(128, 128);
    for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) {
      let col = -1;
      for (let p = 0; p < 2 && col < 0; p++) col = tileColor(t.OL[p * 4096 + x * 64 + y], t.UL[p * 4096 + x * 64 + y]);
      if (col < 0) col = 0x101418;
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) { const o = ((63 - y) * 2 + b) * 128 * 4 + (x * 2 + a) * 4; im.data[o] = col >> 16 & 255; im.data[o + 1] = col >> 8 & 255; im.data[o + 2] = col & 255; im.data[o + 3] = 255; }
    }
    g.putImageData(im, 0, 0);
    if (lb) {
      g.fillStyle = 'rgba(238,238,238,0.9)';
      for (const p of parseLocs(lb)) {
        if (p.plane !== 0 || (p.type !== 0 && p.type !== 2)) continue;
        const X = p.x * 2, Y = (63 - p.y) * 2, edge = r => r === 0 ? g.fillRect(X, Y, 1, 2) : r === 1 ? g.fillRect(X, Y, 2, 1) : r === 2 ? g.fillRect(X + 1, Y, 1, 2) : g.fillRect(X, Y + 1, 2, 1);
        edge(p.rot); if (p.type === 2) edge((p.rot + 1) & 3);
      }
    }
    squareP.set(rid, c); squareBusy--;
    if (H.onSquare) H.onSquare(rid);
  }, () => { squareBusy--; });
  return null;
}

/* ---- load: the catalogs, the four tables, the lights ---- */
function load() {
  if (loading) return loading;
  return loading = Promise.all([
    catalog('underlay'), catalog('overlay'), catalog('texture'),
    getJson(DATA + '/regions.json'), getJson(DATA + '/spawns.json'), getJson(DATA + '/transports.json'), getJson(DATA + '/doors.json'),
    getJson(OUT + '/resolve/item.json'), getJson(OUT + '/resolve/loc.json'), getJson(DATA + '/roofs.json').catch(() => ({})),
  ]).then(async ([ul, ol, tx, man, sp, tr, dr, ri, rl, rf]) => {
    underlays = ul; overlays = ol; textures = tx;
    roofFix = rf.fix || {};   /* before the first loc shard: every def arrives already mended */
    for (const r of man.regions) manifest.add(r);
    sp.npcs.forEach((s, i) => {
      const rid = ridOf(s.x, s.y);
      let a = spawnsByRegion.get(rid);
      if (!a) spawnsByRegion.set(rid, a = []);
      a.push(Object.assign({ i }, s));
      spawnN.set(s.id, (spawnN.get(s.id) || 0) + 1);
    });
    itemSpawns = (sp.items || []).map((s, i) => Object.assign({ i }, s));
    transByLoc = tr.byLoc || {};
    for (const [cid, [oid, conv]] of Object.entries(dr.pairs)) {
      doorPairs.set(+cid, { other: oid, conv, closed: true });
      if (!doorPairs.has(oid)) doorPairs.set(oid, { other: +cid, conv, closed: false });
    }
    for (const [id, closed] of dr.self || []) if (!doorPairs.has(id)) {
      doorPairs.set(id, { other: id + SELF_DOOR, conv: 'a+1', closed: !!closed });
      doorPairs.set(id + SELF_DOOR, { other: id, conv: 'a+1', closed: !closed });
    }
    resolveItem = ri; resolveLoc = rl;
    const stumpIds = (rl['tree stump'] || []).slice(0, 24), sd = await defs('loc', stumpIds);
    stumps = stumpIds.map(id => sd[id]).filter(d => d && d.models && d.models.some(m => m.shape === 10));
    for (const d of stumps) for (const m of d.models) pinned.add(m.model);
    await models(pinned);
    if (itemSpawns.length) await defs('item', itemSpawns.map(s => s.id));
    await loadSeqs([PLAYER_STAND, PLAYER_WALK]);
    worldImage();
    loaded = true;
    return true;
  }).catch(e => { loading = null; throw e; });
}
function init(o) {
  scene = o.scene; fogCenter = o.fogCenter; H = o.hooks || {};
  THREE.MeshLambertMaterial.prototype.onBeforeCompile = function (shader) { shader.uniforms.fogCenter = fogCenter; };   /* the fog is measured from the player, as every seedworld material's is */
  root = new THREE.Group(); root.visible = false;
  planeG = [0, 1, 2, 3].map(() => { const g = new THREE.Group(); root.add(g); return g; });
  amb = new THREE.AmbientLight(0xffffff, 0.65); sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(-0.6, 1, 0.4);
  root.add(amb, sun);
  scene.add(root);
}
function setActive(on) {
  active = !!on;
  if (root) root.visible = active;
  if (!active) clear();
}
function setBrightness(v) { bright = v; if (amb) { amb.intensity = 0.65 * v; sun.intensity = 0.9 * v; } }
function setViewPlane(maxPlane) { if (planeG) for (let p = 0; p < 4; p++) planeG[p].visible = p <= maxPlane; }

return {
  OUT, init, load, setActive, setBrightness, setViewPlane, ready: () => loaded, active: () => active,
  update, regions, clear, regionAt, pending, manifest: () => manifest,
  yAt, heightAt, bridgeAt, renderPlane, coveredAt, solidAt,
  roofedAt: (p, gx, gy) => { const r = regionAt(gx, gy); if (!r) return false; const i = (gx & 63) * 64 + (gy & 63); return !!(r.FL[p * 4096 + i] & 4 || (p < 3 && r.bridge[i] && r.FL[(p + 1) * 4096 + i] & 4)); },   /* the client's under-a-roof tile flag (settings bit 4), not "anything above": an eave or a balcony lifts nothing */
  canMove: (rp, x, y, dx, dy) => canMove(rp, x, y, dx, dy, 0, 0), canSail: (rp, x, y, dx, dy) => canMove(rp, x, y, dx, dy, 0, 0, F_OBJ | F_DECO),
  los, openTile, flagAt, snapWalkable, wallBetween, F_FULL, waterAt, setScope, setSynth, tileColor,
  pick, transport, climbTarget, toggleDoor, doorPartner, doorPairs,
  npcDefOf, npcFigure, headFigure, animate, figureAct, seqFrames, frameAt, transformVerts, labelGroups, spotanim, animateScenery, lodTick, defs,
  defSync, itemGeo, itemMesh, itemFor, itemNameIds, itemSpawns: () => itemSpawns,
  tileRGB, wallBits, worldImage, worldRGB, WORLD_IMG, isLand, squareCanvas, clean, opsOf, ridSq, sqXOf, sqYOf, sourceSquare, spawnCount: id => spawnN.get(id) || 0,
};
})();
