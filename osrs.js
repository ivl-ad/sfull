/* ---- OSRS 2007 MODELS -------------------------------------------------------------------------------------
   The 2007 client's own player kit — and its monsters and world objects — worn when "2007 models" is on in
   SETUP. This layer reads the osrs-r2 transcode of the game cache LIVE and ON DEMAND: it resolves any item,
   monster or scenery by its seedworld display name against the FULL catalogs and fetches only the per-entity
   definitions and model atoms actually used. There is no prebuilt bridge (no index07.json, no models bundle):
   every URL derives from one base, OUT — point it at an R2 bucket to serve the same tree from the edge.

   load() fetches the three display-name -> [cache ids] resolve maps (resolve/{item,npc,loc}.json), the kit and
   texture config shards, builds the palette, resolves the two default player bodies and PRELOADS just the kit
   model atoms (so a naked player renders the instant load() resolves) and warms the fixed set of scenery names
   the world asks for (LOC_WARM: trees, ore veins, town fixtures) so the loc calls below stay synchronous with
   no change to their callers. Everything else is lazy:
     - fetchAtom(id)/fetchAtoms(ids): a model atom is out/<rev>/m/<id>.bin, one modl record readModel() slices in
       place; cached in the `models` Map, deduped in flight.
     - cfgEntry(type,id): config lives in cfg/<type>/<floor(id/256)>.json ({entries:{id:{...}}}, cache2 field
       names); the shard is fetched once and cached.
     - resolveItem/resolveNpc/resolveLoc: the curation heuristics, keyed by an
       arbitrary display name against the full catalog. Items resolve synchronously once cfg is in (idFor returns
       the cache id); dress() builds from the atoms already resident and rebuilds when the rest land. Monsters and
       scenery resolve lazily too, so npcMesh()/locMesh()/locBatch() return null until the fetch completes and the
       per-frame callers (20b) simply ask again next frame — the box rig / proc look stands in the meantime.

   The client composes a player by merging up to twelve models into one mesh and baking the light into the face
   colours; everything below is that pass, ported. What a still viewer never needed is the skeleton: every vertex
   in the cache carries the client's own bone label, so the merged mesh is skinned to five joints — body, two
   arms, two legs — laid out like buildAvatar's boxes. That is the point of doing it this way: section 34's
   poses drive this rig with no changes at all. Monsters have no cache vertex groups, so their limb split is
   geometric (boneMap), guided by the box rig's own plan; scenery is plain unskinned mesh at the cache's tile
   scale, lit as the client lights the world.

   Nothing here runs until the setting is switched on; load() and the item sprites (icon(), section "inventory icons",
   which fetch only the defs, atoms and textures of what is drawn) are the only entries that touch the network. ---- */
const OSRSK = (() => {
'use strict';

/* The one place the asset tree is named: the osrs-r2 transcode (revision v1788780794) at the root of R2 bucket `test1`,
   public on its own domain (CORS for vla.dev + localhost, cache rule in front), so no Worker runs per file and the
   local out/ folder is never read. */
const OUT = 'https://assets.vla.dev';

/* JagexColor's brightness exponent. The client offers 0.6-0.9 and the wiki's equipped renders use 0.6, which is
   also the only value at which every sampled wiki pixel resolves to an exact palette entry. */
const BRIGHT = 0.6;
/* cache units -> tiles. A naked player is 196 units tall and the box rig is 1.90, so the toggle changes how the
   character looks without changing its size against the world or anything standing next to it. */
const S = 1 / 103;

/* ---- packed HSL -> RGB (net.runelite.cache.models.JagexColor) ---- */
const HUE_OFF = 0.5 / 64, SAT_OFF = 0.5 / 8;
function adjustRGB(rgb, b) {
  return (Math.trunc(Math.pow((rgb >> 16 & 255) / 256, b) * 256) << 16)
    | (Math.trunc(Math.pow((rgb >> 8 & 255) / 256, b) * 256) << 8)
    | Math.trunc(Math.pow((rgb & 255) / 256, b) * 256);
}
function palRGB(i, b) {
  const hue = (i >> 10 & 63) / 64 + HUE_OFF, sat = (i >> 7 & 7) / 8 + SAT_OFF, lum = (i & 127) / 128;
  const c = (1 - Math.abs(2 * lum - 1)) * sat, x = c * (1 - Math.abs((hue * 6) % 2 - 1)), m = lum - c / 2;
  let r = m, g = m, bl = m;
  switch (Math.trunc(hue * 6)) {
    case 0: r += c; g += x; break; case 1: g += c; r += x; break; case 2: g += c; bl += x; break;
    case 3: bl += c; g += x; break; case 4: bl += c; r += x; break; default: r += c; bl += x;
  }
  const v = adjustRGB((Math.trunc(r * 256) << 16) | (Math.trunc(g * 256) << 8) | Math.trunc(bl * 256), b);
  return v === 0 ? 1 : v;
}
function buildPalette(b) {
  const pal = new Int32Array(65536);
  for (let i = 0; i < 65536; i++) pal[i] = palRGB(i, b);
  return pal;
}

/* ---- model atoms: views into the fetched buffer, never copies (record layout: osrs-r2 CONTRACT, m/<id>.bin).
   A standalone atom file starts at offset 0, so every multi-byte view (verts, faces, colours, textures) lands on
   an even offset the same way the old 4-byte-aligned bundle records did. ---- */
const F_TEX = 8, F_TYPES = 1, F_ALPHA = 2, F_PRIOS = 4, F_TCOORD = 16, F_VGROUP = 32;
function readModel(buf, at) {
  const dv = new DataView(buf, at);
  const vc = dv.getUint16(0, true), fc = dv.getUint16(2, true), ttc = dv.getUint16(4, true), fl = dv.getUint8(6);
  let o = at + 8;
  const verts = new Int16Array(buf, o, vc * 3); o += vc * 6;
  const indices = new Uint16Array(buf, o, fc * 3); o += fc * 6;
  const colors = new Uint16Array(buf, o, fc); o += fc * 2;
  let textures = null;
  if (fl & F_TEX) { textures = new Uint16Array(buf, o, fc); o += fc * 2; }
  const ttri = ttc ? new Uint16Array(buf, o, ttc * 3) : null;      /* texture triangles (P, M, N): the world paints averages, an item sprite maps them */
  o += ttc * 6;
  let types = null, alphas = null, prios = null, tcoords = null;
  if (fl & F_TYPES) { types = new Int8Array(buf, o, fc); o += fc; }
  if (fl & F_ALPHA) { alphas = new Int8Array(buf, o, fc); o += fc; }
  if (fl & F_PRIOS) { prios = new Uint8Array(buf, o, fc); o += fc; }   /* draw order: the depth buffer handles it in the world, a sprite sorts by it */
  if (fl & F_TCOORD) { tcoords = new Int8Array(buf, o, fc); o += fc; }
  const ttypes = ttc ? new Uint8Array(buf, o, ttc) : null;         /* texture triangle types: only 0 (planar) maps */
  o += ttc;
  const vg = (fl & F_VGROUP) ? new Uint8Array(buf, o, vc) : null;
  return { vc, fc, verts, indices, colors, textures, types, alphas, vg, prios, ttri, tcoords, ttypes };
}

/* ---- the skeleton ------------------------------------------------------------------------------------------
   The labels are the client's own, read off all 1304 models in the set: 1-3 head and jaw, 4-16 torso, waist and
   cape, 17-21 the -x arm, 22-26 the +x arm, 27/28 the hands, 29-30 + 39-42 the waist ring, 31-34 the -x leg,
   35-38 the +x leg, 43/44 the robed or armoured thigh, 45-48 the feet, 50-88 whatever the hand holds, 161 the
   shield arm. Everything unlisted stays on the body, which is where a vertex that never moves belongs. ---- */
const B_BODY = 0, B_ARML = 1, B_ARMR = 2, B_LEGL = 3, B_LEGR = 4;
const G2B = new Uint8Array(256);
const label = (b, gs) => { for (const g of gs) G2B[g] = b; };
label(B_ARMR, [17, 18, 19, 20, 21, 27, 60, 67, 92, 50, 51, 52, 53, 54, 55, 56, 61, 62, 63, 64, 65, 66, 70, 87, 88]);
label(B_ARML, [22, 23, 24, 25, 26, 28, 58, 59, 68, 91, 133, 161]);
label(B_LEGR, [31, 32, 33, 34, 44, 45, 48, 77, 80, 83, 166]);
label(B_LEGL, [35, 36, 37, 38, 43, 46, 47, 76, 78, 81, 82, 167]);
const isArm = b => b === B_ARML || b === B_ARMR;

/* Joints, in tiles, taken off the naked kit: the shoulder at the top of the upper arm, the hip at the waist
   ring, and the body's twist at the belt so a swing turns the chest and leaves the legs planted. */
const PB = 105 * S, PA = [19 * S, 159 * S], PL = [9 * S, 95 * S];

/* ---- appearance --------------------------------------------------------------------------------------------
   Slots 0..11: head cape amulet weapon torso shield arms legs hair hands feet jaw. An item writes itself into
   its own slot and blanks the body parts it covers — a full helm takes hair and jaw, a platebody the arms. ---- */
const EMPTY = 0, KIT = 256, ITEM = 512;
function appearance(body, ids) {
  const arr = new Array(12).fill(EMPTY), bod = bodies[body];
  for (const s in bod) arr[s] = KIT + bod[s];
  for (const id of ids) { const it = itemById.get(id); if (it && it[body]) arr[it.slot] = ITEM + id; }
  for (const id of ids) {
    const it = itemById.get(id);
    if (it && it[body]) for (const s of it.hide) if (arr[s] < ITEM) arr[s] = EMPTY;
  }
  return arr;
}

/* One entry per model, recolours resolved and the vertical offset folded in, carrying the bone its arm-labelled
   vertices are pinned to. Whatever the hand holds goes on one arm however the cache labelled it: this rig swings
   its arms in opposition, so a two-hander split across both hands would stretch between them. */
function parts(arr, body) {
  const out = [];
  const push = (ids, off, rc, pin) => {
    for (const id of ids) { const m = models.get(id); if (m) out.push(makePart(m, off, rc, pin)); }
  };
  for (const e of arr) {
    if (e === EMPTY) continue;
    if (e < ITEM) { const k = kits.get(e - KIT); if (k) push(k.m, 0, k.rc, 0); }
    else {
      const it = itemById.get(e - ITEM), b = it && it[body];
      if (b) push(b.m, b.off, it.rc, it.slot === 3 ? B_ARMR : it.slot === 5 ? B_ARML : 0);
    }
  }
  return out;
}
function makePart(m, off, rc, pin) {
  let verts = m.verts, colors = m.colors;
  if (off) { verts = Int16Array.from(m.verts); for (let i = 1; i < verts.length; i += 3) verts[i] += off; }
  if (rc && rc.length) {
    colors = Uint16Array.from(m.colors);
    for (let i = 0; i < colors.length; i++) for (const p of rc) if (colors[i] === p[0]) { colors[i] = p[1]; break; }
  }
  return { m, verts, colors, pin };
}

/* ---- merge (ModelData(ModelData[], int)) --------------------------------------------------------------------
   Concatenate the faces but fold vertices that land on the same coordinate, which is what lets the normals smooth
   across the seam between, say, the torso kit and the arms kit. The first vertex to claim a coordinate settles
   its bone too, exactly as the client keeps the first skin. ---- */
function merge(list) {
  let vcMax = 0, fc = 0, anyT = false, anyA = false, anyX = false;
  for (const p of list) {
    vcMax += p.m.vc; fc += p.m.fc;
    if (p.m.types) anyT = true;
    if (p.m.alphas) anyA = true;
    if (p.m.textures || p.tex) anyX = true;
  }
  const vx = new Int32Array(vcMax), vy = new Int32Array(vcMax), vz = new Int32Array(vcMax), vb = new Uint8Array(vcMax);
  const idx = new Int32Array(fc * 3), colors = new Uint16Array(fc);
  const types = anyT ? new Int8Array(fc) : null, alphas = anyA ? new Int8Array(fc) : null;
  const textures = anyX ? new Uint16Array(fc) : null;
  const seen = new Map();
  let vc = 0, f = 0;
  for (const p of list) {
    const m = p.m, pin = p.pin;
    const vertex = i => {
      const x = p.verts[i * 3], y = p.verts[i * 3 + 1], z = p.verts[i * 3 + 2];
      const key = (x + 32768) * 4294967296 + (y + 32768) * 65536 + (z + 32768);   /* an int16 triple, exact in one double */
      const hit = seen.get(key);
      if (hit !== undefined) return hit;
      let b = m.vg ? G2B[m.vg[i]] : B_BODY;
      if (pin && isArm(b)) b = pin;
      vx[vc] = x; vy[vc] = y; vz[vc] = z; vb[vc] = b;
      seen.set(key, vc);
      return vc++;
    };
    const mt = p.tex || m.textures;   /* a loc's retexture list swaps texture ids per part */
    for (let i = 0; i < m.fc; i++, f++) {
      if (types) types[f] = m.types ? m.types[i] : 0;
      if (alphas) alphas[f] = m.alphas ? m.alphas[i] : 0;
      if (textures) textures[f] = mt ? mt[i] : 0;
      colors[f] = p.colors[i];
      idx[f * 3] = vertex(m.indices[i * 3]);
      idx[f * 3 + 1] = vertex(m.indices[i * 3 + 1]);
      idx[f * 3 + 2] = vertex(m.indices[i * 3 + 2]);
    }
  }
  return { vc, fc, vx, vy, vz, vb, idx, colors, types, alphas, textures };
}

/* ---- lighting (ModelDefinition.computeNormals + toModel) ----------------------------------------------------
   Baked after the merge, never per part, or the folded seams at neck, shoulder and waist light up as edges. ---- */
function computeNormals(g) {
  const nx = new Int32Array(g.vc), ny = new Int32Array(g.vc), nz = new Int32Array(g.vc), mag = new Int32Array(g.vc);
  const faceN = new Int32Array(g.fc * 3);
  for (let f = 0; f < g.fc; f++) {
    const a = g.idx[f * 3], b = g.idx[f * 3 + 1], c = g.idx[f * 3 + 2];
    const ax = g.vx[b] - g.vx[a], ay = g.vy[b] - g.vy[a], az = g.vz[b] - g.vz[a];
    const bx = g.vx[c] - g.vx[a], by = g.vy[c] - g.vy[a], bz = g.vz[c] - g.vz[a];
    let cx = ay * bz - by * az, cy = az * bx - bz * ax, cz = ax * by - bx * ay;
    while (cx > 8192 || cy > 8192 || cz > 8192 || cx < -8192 || cy < -8192 || cz < -8192) { cx >>= 1; cy >>= 1; cz >>= 1; }
    let len = Math.trunc(Math.sqrt(cx * cx + cy * cy + cz * cz)); if (len <= 0) len = 1;
    cx = Math.trunc(cx * 256 / len); cy = Math.trunc(cy * 256 / len); cz = Math.trunc(cz * 256 / len);
    const type = g.types ? g.types[f] : 0;
    if (type === 0) {
      nx[a] += cx; ny[a] += cy; nz[a] += cz; mag[a]++;
      nx[b] += cx; ny[b] += cy; nz[b] += cz; mag[b]++;
      nx[c] += cx; ny[c] += cy; nz[c] += cz; mag[c]++;
    } else if (type === 1) { faceN[f * 3] = cx; faceN[f * 3 + 1] = cy; faceN[f * 3 + 2] = cz; }
  }
  return { nx, ny, nz, mag, faceN };
}
const clampL = v => v < 2 ? 2 : v > 126 ? 126 : v;
const shadeHsl = (hsl, l) => (hsl & 65408) + clampL(((hsl & 127) * l) >> 7);
const LIT = { ambient: 64, contrast: 850, x: -30, y: -50, z: -30 };   /* the client's player light: toModel(64,850,-30,-50,-30) */
const LOC_LIT = { ambient: 64, contrast: 768, x: -50, y: -10, z: -50 };   /* scenery is static world geometry: ObjectComposition.getEntity */
/* a monster adds its own ambient/contrast on top (NPCComposition.getModel), same direction; a loc does the same over LOC_LIT */
function light(g, amb, con, base) {
  const L = base || LIT;
  const ambient = L.ambient + (amb || 0), x = L.x, y = L.y, z = L.z, n = computeNormals(g);
  const att = (Math.trunc(Math.sqrt(x * x + y * y + z * z)) * (L.contrast + (con || 0))) >> 8, flatDiv = Math.trunc(att / 2) + att;
  const c1 = new Int32Array(g.fc), c2 = new Int32Array(g.fc), c3 = new Int32Array(g.fc);
  for (let f = 0; f < g.fc; f++) {
    let type = g.types ? g.types[f] : 0;
    const alpha = g.alphas ? g.alphas[f] : 0, tex = g.textures ? g.textures[f] - 1 : -1;
    if (alpha === -2) type = 3; else if (alpha === -1) type = 2;
    const vl = v => Math.trunc((y * n.ny[v] + z * n.nz[v] + x * n.nx[v]) / (att * n.mag[v])) + ambient;
    const fl = () => Math.trunc((y * n.faceN[f * 3 + 1] + z * n.faceN[f * 3 + 2] + x * n.faceN[f * 3]) / flatDiv) + ambient;
    if (tex === -1) {
      if (type === 0) { const h = g.colors[f]; c1[f] = shadeHsl(h, vl(g.idx[f * 3])); c2[f] = shadeHsl(h, vl(g.idx[f * 3 + 1])); c3[f] = shadeHsl(h, vl(g.idx[f * 3 + 2])); }
      else if (type === 1) { c1[f] = shadeHsl(g.colors[f], fl()); c3[f] = -1; }
      else if (type === 3) { c1[f] = 128; c3[f] = -1; }
      else c3[f] = -2;                                             /* -2: the face is not drawn at all */
    } else if (type === 0) { c1[f] = clampL(vl(g.idx[f * 3])); c2[f] = clampL(vl(g.idx[f * 3 + 1])); c3[f] = clampL(vl(g.idx[f * 3 + 2])); }
    else if (type === 1) { c1[f] = clampL(fl()); c3[f] = -1; }
    else c3[f] = -2;
  }
  return { c1, c2, c3 };
}

/* ---- geometry ----------------------------------------------------------------------------------------------
   Cache space is +Y down and +Z away from the viewer, so negating both stands the model up facing +Z, the way the
   box rig faces. That is a half turn about X, not a mirror, so the winding is unchanged.
   Opaque faces come first so the mesh can draw as two groups: writing depth for the whole thing when a handful of
   faces are see-through sorts the solid body wrongly. ---- */
function toGeometry(g, lit, o) {
  const sX = o ? o.sx : S, sY = o ? o.sy : S, sZ = o ? o.sz : S;   /* o: a monster — its own scale, its own bone map in g.vb */
  const solid = [], clear = [];
  for (let f = 0; f < g.fc; f++) {
    if (lit.c3[f] === -2) continue;
    ((g.alphas && (g.alphas[f] & 255)) ? clear : solid).push(f);
  }
  const draw = solid.concat(clear), n = draw.length;
  const position = new Float32Array(n * 9), color = new Float32Array(n * 12);
  const si = new Uint16Array(n * 12), sw = new Float32Array(n * 12);
  let lo = 1e9, hi = -1e9, rad = 0;
  for (let i = 0; i < n; i++) {
    const f = draw[i], flat = lit.c3[f] === -1;
    const textured = g.textures ? g.textures[f] > 0 : false, t = textured ? texAvg(g.textures[f] - 1) : 0;
    const opacity = g.alphas ? 1 - (g.alphas[f] & 255) / 256 : 1;
    for (let k = 0; k < 3; k++) {
      const v = g.idx[f * 3 + k], p = i * 9 + k * 3;
      const px = g.vx[v] * sX, py = -g.vy[v] * sY, pz = -g.vz[v] * sZ;
      position[p] = px; position[p + 1] = py; position[p + 2] = pz;
      if (py < lo) lo = py;
      if (py > hi) hi = py;
      const r2 = px * px + pz * pz; if (r2 > rad) rad = r2;
      const c = i * 12 + k * 4;
      si[c] = g.vb[v]; sw[c] = 1;                                  /* one bone a vertex: the cache labels them singly */
      const l = flat || k === 0 ? lit.c1[f] : k === 1 ? lit.c2[f] : lit.c3[f];
      let rgb;
      if (textured) {                                              /* v1: the texture's average, modulated by the baked light */
        const s = l / 128;
        rgb = ((Math.min(255, (t >> 16 & 255) * s) | 0) << 16) | ((Math.min(255, (t >> 8 & 255) * s) | 0) << 8) | (Math.min(255, (t & 255) * s) | 0);
      } else rgb = PAL[l & 0xffff];
      color[c] = (rgb >> 16 & 255) / 255; color[c + 1] = (rgb >> 8 & 255) / 255; color[c + 2] = (rgb & 255) / 255; color[c + 3] = opacity;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 4));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.addGroup(0, solid.length * 3, 0);
  if (clear.length) geo.addGroup(solid.length * 3, clear.length * 3, 1);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (lo + hi) / 2, 0), Math.hypot(Math.sqrt(rad), (hi - lo) / 2) + 0.6);
  return geo;
}

/* ---- catalog readers + the on-demand fetch layer -----------------------------------------------------------
   All URLs derive from OUT. A config shard is fetched once and cached; a model atom is fetched once, parsed by
   readModel and kept in `models`; both dedupe in flight. resolve/{item,npc,loc}.json are display-name-lower ->
   [cache ids asc]; loaded once at load() so name lookup is synchronous thereafter. */
let PAL = null, loading = null, loaded = false;
const models = new Map();                                         /* cache model id -> parsed atom (never evicted) */
const bodies = {};                                                /* {A,B}: default player kit, slot -> kit id */
const kits = new Map();                                           /* kit id -> {m, rc, rt} */
const texMap = {};                                                /* texture id -> avgRgbRaw */
const itemIndex = new Map(), npcIndex = new Map(), locIndex = new Map();   /* display-name-lower -> [ids] */
const itemDefs = new Map();                                       /* seedworld-name-lower -> def | null (resolved) */
const itemById = new Map();                                       /* cache item id -> def */
const nByName = new Map();                                        /* monster-name-lower -> variant list (resolved; [] = none) */
const lByName = new Map();                                        /* scenery-name-lower -> variant list (resolved; [] = none) */
const locByName = new Map();                                      /* cache loc name-lower -> [def objects] (fetched for selection) */
const shardCache = new Map();                                     /* type/shard -> Promise<entries> */
const atomInflight = new Map();

function fetchJSON(path) { return fetch(OUT + '/' + path).then(r => r.ok ? r.json() : Promise.reject(new Error(path + ' ' + r.status))); }
function cfgShard(type, shard) {
  const key = type + '/' + shard;
  let p = shardCache.get(key);
  if (!p) { p = fetchJSON('cfg/' + type + '/' + shard + '.json').then(j => j.entries || {}); shardCache.set(key, p); }
  return p;
}
function cfgEntry(type, id) { return cfgShard(type, Math.floor(id / 256)).then(e => e[id]); }
function fetchAtom(id) {
  if (models.has(id)) return Promise.resolve();
  let p = atomInflight.get(id);
  if (p) return p;
  p = fetch(OUT + '/m/' + id + '.bin')
    .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error('atom ' + id + ' ' + r.status)))
    .then(buf => { models.set(id, readModel(buf, 0)); atomInflight.delete(id); })
    .catch(e => { atomInflight.delete(id); throw e; });
  atomInflight.set(id, p);
  return p;
}
/* ~48 lanes; a single atom that 404s is swallowed so the variant that names it is simply filtered as broken,
   exactly as the build-time tool treated a missing atom. */
function fetchAtoms(ids) {
  const uniq = [...new Set(ids)].filter(id => !models.has(id));
  if (!uniq.length) return Promise.resolve();
  let i = 0;
  const next = () => i >= uniq.length ? Promise.resolve() : fetchAtom(uniq[i++]).catch(() => {}).then(next);
  const lanes = [];
  for (let l = 0; l < Math.min(48, uniq.length); l++) lanes.push(next());
  return Promise.all(lanes);
}
const texCache = new Map();
function texAvg(id) {
  let v = texCache.get(id);
  if (v === undefined) texCache.set(id, v = adjustRGB(texMap[id] || 0, BRIGHT));
  return v;
}

/* ---- curation helpers (resolve a display name to the right cache look) ---- */
const g = (e, f, d) => (e && e[f] != null ? e[f] : d);            /* absent catalog field = default */
const u16 = v => v & 0xffff;
const pairs = (from, to) => (from || []).map((f, i) => [u16(f), u16(to[i])]);
const eff = (from, to) => pairs(from, to).filter(([f, t]) => f !== t).sort();
const cleanName = s => (s == null ? '' : s).replace(/<\/?col[^>]*>/gi, '').replace(/<br>/gi, ' ').trim();
const vcOf = id => { const m = models.get(id); return m ? m.vc : 0; };
const weigh = arr => arr.reduce((a, id) => a + vcOf(id), 0);

/* ---- kits + default player bodies (port of osrs-prebuild) ---- */
const KIT_PART_SLOT = [8, 11, 4, 6, 9, 7, 10];                    /* KitDefinition.bodyPartId -> appearance slot */
function defaultBody(allKits, offset) {
  const out = {};
  for (let part = 0; part < 7; part++) {
    const want = offset + part;
    const kit = [...allKits].filter(([, k]) => k.bodyPartId === want && !k.nonSelectable).sort((a, b) => a[0] - b[0])[0];
    if (kit) out[KIT_PART_SLOT[part]] = kit[0];
  }
  return out;
}

/* ---- load ---------------------------------------------------------------------------------------------------
   Fetch the resolve maps + kit/texture config, build the palette and the default bodies, preload the kit atoms
   (naked player renders at once) and warm the fixed scenery names the world plants (LOC_WARM) so the loc calls
   stay synchronous. Items and monsters resolve lazily, on first use. On any failure reject — game.js turns the
   setting off. A file:// page has an opaque origin and every fetch fails as a bare NetworkError; name the fix. */
function load() {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return Promise.reject(new Error('the game must be served over http — double-click play-local.cmd (or node tools/server.js) and use the localhost tab'));
  if (loading) return loading;
  return loading = Promise.all([
    fetchJSON('resolve/item.json'), fetchJSON('resolve/npc.json'), fetchJSON('resolve/loc.json'),
    cfgShard('kit', 0), cfgShard('kit', 1), cfgShard('texture', 0),
  ]).then(([ri, rn, rl, k0, k1, tex]) => {
    for (const k in ri) itemIndex.set(k, ri[k]);
    for (const k in rn) npcIndex.set(k, rn[k]);
    for (const k in rl) locIndex.set(k, rl[k]);
    PAL = buildPalette(BRIGHT);
    const allKits = new Map();
    for (const s of [k0, k1]) for (const id in s) allKits.set(+id, s[id]);
    bodies.A = defaultBody(allKits, 0); bodies.B = defaultBody(allKits, 7);
    const kitAtoms = new Set();
    for (const body of [bodies.A, bodies.B]) for (const s in body) {
      const k = allKits.get(body[s]);
      kits.set(body[s], { m: k.models || [], rc: pairs(k.recolorFrom, k.recolorTo), rt: pairs(k.retextureFrom, k.retextureTo) });
      for (const m of k.models || []) kitAtoms.add(m);
    }
    for (const id in tex) texMap[id] = tex[id].avgRgbRaw != null ? tex[id].avgRgbRaw : (tex[id].averageRGB || 0);
    return Promise.all([fetchAtoms([...kitAtoms]), ...LOC_WARM.map(n => resolveLoc(n.toLowerCase()).catch(() => {}))]);
  }).then(() => { loaded = true; return true; }).catch(e => { loading = null; throw e; });
}

/* ---- items --------------------------------------------------------------------------------------------------
   resolveItem maps a seedworld display name to the cache item, porting osrs-prebuild's selection: the item index
   gives the candidate ids (or the ALIASES-rewritten name after an exact miss); among them keep the wearable ones
   and pick the LOWEST id, then build the worn def. idFor() returns the cache id synchronously once resolved (0
   while a fetch is in flight or for a name with no worn item), so a rig re-dresses when the item lands. ---- */
const ALIASES = [                                                 /* seedworld/wiki title -> cache name, tried only after exact fails */
  [/^(.+) hatchet$/i, '$1 axe'], [/^(.+) gauntlets$/i, '$1 gloves'],
  [/^battlestaff of (.+)$/i, '$1 battlestaff'], [/^mystic staff of (.+)$/i, 'mystic $1 staff'],
  [/^(.+) \((p\+*)\)$/i, '$1($2)'], [/^leather coif$/i, 'coif'],
  [/^green h'ween mask$/i, 'green halloween mask'], [/^construction cape$/i, 'construct. cape'],
  [/^ranged cape$/i, 'ranging cape'], [/^team cape$/i, 'team-1 cape'],
  [/^monk's robe bottom$/i, "monk's robe"],
  [/^wizard robe top$/i, 'blue wizard robe'], [/^wizard robe bottom$/i, 'blue skirt'],
  [/^black robe top$/i, 'black robe'], [/^black robe bottom$/i, 'black skirt'],
];
const isWearable = it => (g(it, 'maleModel', -1) !== -1 || g(it, 'femaleModel', -1) !== -1)
  && g(it, 'noteTemplate', -1) === -1 && g(it, 'placeholderTemplate', -1) === -1 && g(it, 'wearpos1', -1) >= 0;
function buildItemDef(id, it, src) {
  const forBody = (m0, m1, m2, off) => m0 === -1 ? null : { m: [m0, m1, m2].filter(v => v !== -1), off };
  const A = forBody(g(it, 'maleModel', -1), g(it, 'maleModel1', -1), g(it, 'maleModel2', -1), g(it, 'maleOffset', 0));
  const B = forBody(g(it, 'femaleModel', -1), g(it, 'femaleModel1', -1), g(it, 'femaleModel2', -1), g(it, 'femaleOffset', 0));
  if (!A && !B) return null;
  return {
    name: it.name, src, id, slot: it.wearpos1,
    hide: [g(it, 'wearpos2', -1), g(it, 'wearpos3', -1)].filter(v => v >= 0),
    A, B, rc: pairs(it.recolorFrom, it.recolorTo), rt: pairs(it.retextureFrom, it.retextureTo),
  };
}
const itemInflight = new Set();
async function resolveItem(k) {
  let ids = itemIndex.get(k);
  if (!ids) for (const [re, to] of ALIASES) { if (!re.test(k)) continue; const alt = itemIndex.get(k.replace(re, to).toLowerCase()); if (alt) { ids = alt; break; } }
  let def = null;
  if (ids) {
    const cands = await Promise.all(ids.map(id => cfgEntry('item', id).then(e => [id, e])));
    let best = null;
    for (const [id, e] of cands) if (e && isWearable(e) && (best === null || id < best[0])) best = [id, e];
    if (best) def = buildItemDef(best[0], best[1], k);
  }
  itemDefs.set(k, def);
  if (def) itemById.set(def.id, def);
  onItemResolved();
}
function kickResolveItem(k) {
  if (itemDefs.has(k) || itemInflight.has(k)) return;
  itemInflight.add(k);
  resolveItem(k).catch(() => { if (!itemDefs.has(k)) itemDefs.set(k, null); }).then(() => itemInflight.delete(k));
}
/* Rings and every kind of ammunition have no worn model in the cache, so a miss here is usually the right answer
   rather than a gap. Cached per item id once resolved (never 0 before then, or it would stick). */
const resolvedIds = new Map();
function idFor(it) {
  if (!it) return 0;
  const cached = resolvedIds.get(it.id);
  if (cached !== undefined) return cached;
  const k = it.name.toLowerCase();
  if (itemDefs.has(k)) { const def = itemDefs.get(k), id = def ? def.id : 0; resolvedIds.set(it.id, id); return id; }
  kickResolveItem(k);
  return 0;
}

/* ---- geometry cache: a loadout is worth building once, however many people are wearing it.
   A build with atoms still missing is NOT cached (its parts would be incomplete); once every worn atom is
   resident the full build is cached and LRU'd. ---- */
const geoCache = new Map(), GEO_MAX = 40, live = [];   // live: every rig's mesh, so eviction can see what is worn
const geoInCache = geo => { for (const v of geoCache.values()) if (v === geo) return true; return false; };
function itemAtoms(ids, body) { const a = []; for (const id of ids) { const d = itemById.get(id), b = d && d[body]; if (b) for (const m of b.m) a.push(m); } return a; }
function geometryFor(ids, body) {
  const key = body + '|' + ids.join(',');
  let geo = geoCache.get(key);
  if (geo) { geoCache.delete(key); geoCache.set(key, geo); return geo; }   /* re-inserted: Map keeps insertion order, so this is an LRU */
  const complete = itemAtoms(ids, body).every(id => models.has(id));
  const g2 = merge(parts(appearance(body, ids), body));
  geo = toGeometry(g2, light(g2));
  if (!complete) return geo;                                               /* transient: rebuilt when the rest of the atoms land */
  geoCache.set(key, geo);
  if (geoCache.size > GEO_MAX) {
    // oldest first, but never one a rig is still wearing: dispose frees the buffers out from under it
    for (const [k, g3] of geoCache) {
      if (k === key || live.some(m => m.geometry === g3)) continue;
      g3.dispose(); geoCache.delete(k); break;
    }
  }
  return geo;
}

/* ---- the rig -----------------------------------------------------------------------------------------------
   Five bones laid out like buildAvatar's boxes, so section 34 drives this rig and that one with the same code.
   The arms hang off the body, which the boxes do not — on one continuous mesh a twist that left the arms behind
   would pull them out of their sockets. ---- */
let matOpaque = null, matClear = null;
const brightness = v => {
  if (matOpaque) { matOpaque.color.setScalar(v); matClear.color.setScalar(v); }
  if (nMatO) { nMatO.color.setScalar(v); nMatC.color.setScalar(v); }
  if (lMatO) { lMatO.color.setScalar(v); lMatC.color.setScalar(v); }
};
function materials() {
  if (!matOpaque) {
    matOpaque = basicMat({ skinning: true });
    matClear = basicMat({ skinning: true, transparent: true, depthWrite: false });
    brightness(OPT.brightness);
  }
  return [matOpaque, matClear];
}

/* animate() and the POSES read p.wep to decide how a weapon is carried. There is no separate weapon mesh here —
   the weapon is part of the skin — so a stand-in carries the one fact the poses need, whether both hands are on
   it, and swallows the rotations meant for a mesh that does not exist. */
const wepStub = () => ({ userData: { two: 0 }, rotation: { x: 0, y: 0, z: 0, set() {} } });

/* animate() hides the legs when you climb into a boat. There is no separate leg mesh to hide, so the bone
   collapses instead and takes its vertices into the hip, under the hull. The lift animate() applies with them
   is tuned to the box rig, whose lowest seated piece is the bottom of the torso; the waist sits higher than
   that, so the mesh drops by the difference and the figure sits in the hull rather than over it. */
const SEAT = 0.35;
function collapsible(bone, mesh) {
  Object.defineProperty(bone, 'visible', {
    get() { return bone.scale.x > 0.5; },
    set(v) { bone.scale.setScalar(v ? 1 : 1e-4); mesh.position.y = v ? 0 : -SEAT; }
  });
  return bone;
}
function rig() {
  const g = new THREE.Group();
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), materials());
  const body = new THREE.Bone(), armL = new THREE.Bone(), armR = new THREE.Bone();
  const legL = collapsible(new THREE.Bone(), mesh), legR = collapsible(new THREE.Bone(), mesh);
  body.position.y = PB;
  armL.position.set(PA[0], PA[1] - PB, 0); armR.position.set(-PA[0], PA[1] - PB, 0);
  legL.position.set(PL[0], PL[1], 0); legR.position.set(-PL[0], PL[1], 0);
  body.add(armL, armR);
  mesh.add(body, legL, legR);
  mesh.frustumCulled = false;                                      /* the bones move vertices past any resting bound */
  mesh.updateMatrixWorld(true);                                    /* bound at the origin, so bindMatrix is the identity */
  mesh.bind(new THREE.Skeleton([body, armL, armR, legL, legR]));
  live.push(mesh);
  g.add(mesh);
  g.parts = { torso: body, armL, armR, legL, legR, head: body, mesh, wep: wepStub(), legHid: 0, osrs: 1 };
  return g;
}

/* Rebuild a rig's mesh for what it is wearing. `it(slot)` is the same reader dressRig takes, so both dressers are
   fed identically; ammo and rings are skipped because the cache has no worn model for either. An item whose def
   is not resolved yet, or whose atoms are still fetching, is built in as soon as it lands: the naked kit (always
   resident) renders immediately and the item follows within a frame or a fetch. */
const WORN = ['head', 'cape', 'neck', 'body', 'legs', 'weapon', 'shield', 'hands', 'feet'];
const dressPending = new Set();
function dress(parts, it, body) {
  parts._it = it; parts._body = body || 'A';
  redress(parts);
}
function redress(parts) {
  const it = parts._it, body = parts._body;
  const ids = []; let waiting = 0;
  for (const s of WORN) {
    const w = it(s); if (!w) continue;
    const m = idFor(w);
    if (m) ids.push(m);
    else if (!itemDefs.has(w.name.toLowerCase())) waiting = 1;    // still resolving: re-dress when it lands
  }
  ids.sort((a, b) => a - b);
  const key = body + '|' + ids.join(',');
  parts._dressKey = key;
  if (waiting) dressPending.add(parts);
  const need = itemAtoms(ids, body).filter(id => !models.has(id));
  parts.mesh.geometry = geometryFor(ids, body);
  if (need.length) fetchAtoms(need).then(() => {
    if (parts._dressKey !== key) return;
    const old = parts.mesh.geometry;
    parts.mesh.geometry = geometryFor(ids, body);
    if (old !== parts.mesh.geometry && !geoInCache(old)) old.dispose();
  });
  const w = it('weapon');
  parts.wep.userData.two = w && w.two ? 1 : 0;   // a two-hander is carried in both hands, idle and mid-swing alike
}
function onItemResolved() {
  if (!dressPending.size) return;
  const ps = [...dressPending]; dressPending.clear();
  for (const p of ps) redress(p);
}

/* ---- 2007 monsters -----------------------------------------------------------------------------------------
   resolveNpc maps a monster display name to its variant list: the npc index gives the
   candidate ids; group them by look (models + effective recolours/retextures + width/height scale), take the
   lowest id a group, order by summed vertex count (desc) then id, drop the placeholder stubs (< NPC_MIN_VERTS)
   and the broken ones (a missing atom), and dedupe by compact variant. Resolution fetches the candidates' config
   and their atoms, so it is async: npcMesh returns null until the name's list is in, and the per-frame caller
   asks again next frame — the box rig stands until then. One skinned mesh per (name, variant): the box rig walks
   underneath and this mesh rides its transform, so lunge/rear/bob carry over; its bones come from the box rig's
   own limb plan, so 34's animateNpc drives both rigs unchanged. Materials are the kit's pair, so brightness
   covers both. ---- */
const NPC_MIN_VERTS = 32;
let nMatO = null, nMatC = null;
function nMats() {
  if (!nMatO) {
    nMatO = basicMat({ skinning: true });
    nMatC = basicMat({ skinning: true, transparent: true, depthWrite: false });
    nMatO.color.setScalar(OPT.brightness); nMatC.color.setScalar(OPT.brightness);
  }
  return [nMatO, nMatC];
}
const npcLookSig = n => JSON.stringify([[...n.models].sort((a, b) => a - b),
  eff(n.recolorFrom, n.recolorTo), eff(n.retextureFrom, n.retextureTo), g(n, 'widthScale', 128), g(n, 'heightScale', 128)]);
const npcInflight = new Set();
async function resolveNpc(k) {
  const ids = npcIndex.get(k) || [];
  const defs = [];
  const rows = await Promise.all(ids.map(id => cfgEntry('npc', id).then(e => [id, e])));
  for (const [id, e] of rows) if (e && e.name && e.name !== 'null' && e.models && e.models.length) defs.push({ id, ...e });
  const groups = new Map();
  for (const n of defs) { const s = npcLookSig(n); (groups.get(s) || groups.set(s, []).get(s)).push(n); }
  const reps = [...groups.values()].map(gr => gr.sort((a, b) => a.id - b.id)[0]);
  const atomIds = new Set();
  for (const n of reps) for (const m of n.models) atomIds.add(m);
  await fetchAtoms([...atomIds]);
  reps.sort((a, b) => weigh(b.models) - weigh(a.models) || a.id - b.id);   // most detailed first, dormant stubs last
  const out = [], sigs = new Set();
  for (const n of reps) {
    if (!n.models.every(m => models.has(m))) continue;                     // a missing atom = broken look
    if (weigh(n.models) < NPC_MIN_VERTS) continue;                         // 8-vert placeholder box
    const v = { m: n.models };
    const rc = pairs(n.recolorFrom, n.recolorTo);
    if (rc.length) v.rc = rc;
    if (g(n, 'widthScale', 128) !== 128) v.ws = n.widthScale;
    if (g(n, 'heightScale', 128) !== 128) v.hs = n.heightScale;
    if (g(n, 'ambient', 0)) v.amb = n.ambient;
    if (g(n, 'contrast', 0)) v.con = n.contrast;
    const sig = JSON.stringify(v);
    if (sigs.has(sig)) continue;
    sigs.add(sig); out.push(v);
  }
  nByName.set(k, out);
}
function kickResolveNpc(k) {
  if (nByName.has(k) || npcInflight.has(k)) return;
  npcInflight.add(k);
  resolveNpc(k).catch(() => { if (!nByName.has(k)) nByName.set(k, []); }).then(() => npcInflight.delete(k));
}
function resolvedNpc(name) {
  const k = name.toLowerCase();
  const list = nByName.get(k);
  if (list) return list;
  kickResolveNpc(k);
  return null;
}
/* The cache carries no vertex groups for monsters, so the limb split is geometric, guided by the plan (limb
   kinds and hip heights as fractions of the rig's height): legs are the connected components under the hip
   cut, wings the lateral spans above it, spider legs radial sectors round the body. Arms stay on the body —
   without the cache's labels a hand is not reliably told from a thigh, and a still arm beats a torn one. */
function boneMap(g, plan, h, sxz, sy) {
  const vc = g.vc, wx = new Float32Array(vc), wy = new Float32Array(vc), wz = new Float32Array(vc);
  for (let i = 0; i < vc; i++) { wx[i] = g.vx[i] * sxz; wy[i] = -g.vy[i] * sy; wz[i] = -g.vz[i] * sxz; }
  const vb = new Uint8Array(vc), piv = plan.map(() => null), acc = plan.map(() => [0, 0, 0, 0]);
  const take = (i, b) => { vb[i] = b + 1; const s = acc[b]; s[0] += wx[i]; s[1] += wy[i]; s[2] += wz[i]; s[3]++; };
  const slegs = [], legs = [], wings = [];
  let hasArm = 0;
  plan.forEach((p, i) => {
    if (p.kind === 'sleg') slegs.push(i);
    else if (p.kind === 'leg' || p.kind === 'qleg') legs.push(i);
    else if (p.kind === 'wing') wings.push(i);
    else if (p.kind !== 'tail') hasArm = 1;   // a tail is not an arm: it must not put the wings on the armed path
  });
  let zc = 0;
  for (let i = 0; i < vc; i++) zc += wz[i];
  zc /= vc || 1;

  if (slegs.length) {   /* sectors round the body, front to back, one rank of hips a side */
    let maxR = 0;
    const rr = new Float32Array(vc);
    for (let i = 0; i < vc; i++) { rr[i] = Math.hypot(wx[i], wz[i] - zc); if (rr[i] > maxR) maxR = rr[i]; }
    const core = maxR * 0.45;
    const sl = [slegs.filter(i => plan[i].s > 0), slegs.filter(i => plan[i].s < 0)];
    for (let i = 0; i < vc; i++) {
      if (rr[i] <= core) continue;
      const list = wx[i] >= 0 ? sl[0] : sl[1];
      if (!list.length) continue;
      const a = Math.atan2(Math.abs(wx[i]), wz[i] - zc);   /* 0 straight ahead .. PI behind */
      take(i, list[Math.min(list.length - 1, Math.floor(a / Math.PI * list.length))]);
    }
    for (const i of slegs) {
      const s = acc[i];
      if (!s[3]) continue;
      const dx = s[0] / s[3], dz = s[2] / s[3] - zc, dl = Math.hypot(dx, dz) || 1;
      piv[i] = [dx / dl * core, plan[i].y * h, zc + dz / dl * core];   /* the hip: on the body's edge, under the leg */
    }
  } else if (legs.length) {
    /* The plan's hip height is a first guess: a belly or a tunic that dips below it welds the legs into one
       lump, so the cut steps down until the ground-standing pieces come apart. A piece only counts as a leg
       when it actually reaches the floor and spans most of the cut — a drooping wing tip does neither. */
    const parent = new Int32Array(vc);
    const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const slice = cut => {
      for (let i = 0; i < vc; i++) parent[i] = i;
      for (let f = 0; f < g.fc; f++) {
        const a = g.idx[f * 3], b = g.idx[f * 3 + 1], c = g.idx[f * 3 + 2];
        if (wy[a] < cut && wy[b] < cut && wy[c] < cut) { parent[find(a)] = find(b); parent[find(c)] = find(b); }
      }
      const comps = new Map();   /* root -> [n, sx, sz, loY, hiY] */
      for (let i = 0; i < vc; i++) {
        if (wy[i] >= cut) continue;
        const r = find(i);
        let s = comps.get(r);
        if (!s) comps.set(r, s = [0, 0, 0, 1e9, -1e9]);
        s[0]++; s[1] += wx[i]; s[2] += wz[i];
        if (wy[i] < s[3]) s[3] = wy[i];
        if (wy[i] > s[4]) s[4] = wy[i];
      }
      let maxAX = 0;
      const stand = new Map();
      for (const [r, s] of comps) {
        if (s[3] > cut * 0.4 || s[4] - s[3] < cut * 0.5) continue;   /* floating, or a shallow sliver */
        stand.set(r, s);
        maxAX = Math.max(maxAX, Math.abs(s[1] / s[0]));
      }
      for (const [r, s] of stand) if (Math.abs(s[1] / s[0]) < maxAX * 0.3) stand.delete(r);   /* the midline is a tail */
      return stand;
    };
    const cut0 = Math.max.apply(null, legs.map(i => plan[i].y)) * h, want = Math.min(legs.length, 4);
    let cut = cut0, kept = slice(cut0);
    for (let c2 = cut0 * 0.78; kept.size < want && c2 > cut0 * 0.1; c2 *= 0.78) {
      const k2 = slice(c2);
      if (k2.size > kept.size && k2.size <= 4) { kept = k2; cut = c2; }   /* <= 4: past that it is toes, not legs */
    }
    slice(cut);   /* deterministic, so re-running the winning cut makes find() agree with kept's roots */
    const biped = plan[legs[0]].kind === 'leg';
    if (kept.size === 1) {   /* legs that never come apart (a plump hen): split the lump down the midline */
      const r0 = kept.keys().next().value;
      const half = sgn => biped ? legs.find(i => (plan[i].s > 0) === sgn) : legs.find(i => (plan[i].x >= 0) === sgn);
      for (let i = 0; i < vc; i++) if (wy[i] < cut && find(i) === r0) take(i, half(wx[i] >= 0));
    } else {
      let zs = 0, zn = 0;
      for (const s of kept.values()) { zs += s[2]; zn += s[0]; }
      zs /= zn || 1;
      const two = kept.size <= 2, pick = new Map();
      let xs = 0;   /* a leaning model can put both feet past the midline: sides are relative to the pair, not to x 0 */
      for (const s of kept.values()) xs += s[1] / s[0];
      xs /= kept.size;
      for (const [r, s] of kept) {
        const right = s[1] / s[0] >= (two ? xs : 0), czq = s[2] / s[0] >= zs ? 1 : -1;
        const b = biped ? legs.find(i => (plan[i].s > 0) === right)
          : legs.find(i => (plan[i].x >= 0) === right && (two || (plan[i].z >= 0) === (czq > 0)));
        if (b !== undefined) pick.set(r, b);
      }
      for (let i = 0; i < vc; i++) {
        if (wy[i] >= cut) continue;
        const b = pick.get(find(i));
        if (b !== undefined) take(i, b);
      }
    }
    for (const i of legs) { const s = acc[i]; if (s[3]) piv[i] = [s[0] / s[3], cut, s[2] / s[3]]; }
  }
  if (wings.length) {   /* whatever spreads past the body's own width, behind the middle when there are arms.
       No arms means a dragon: its wing is an upright fan rising from the spine with the head carried low and
       forward, so everything well above the barrel is wing too — gated off the neck by x (the fan starts past
       the spine's width) and off a raised head (Vorkath) by z. The pivot then sits at the fan's root, not the
       flank, so the beat sweeps the whole fan instead of shearing its outer half. */
    const hip = legs.length ? Math.max.apply(null, legs.map(i => plan[i].y)) * h : h * 0.3;
    let edge = 0;
    for (let i = 0; i < vc; i++) if (vb[i]) edge = Math.max(edge, Math.abs(wx[i]));
    edge = edge ? edge * 1.1 : h * 0.22;
    const inX = hasArm ? edge : edge * 0.45;
    for (let i = 0; i < vc; i++) {
      if (vb[i] || wy[i] <= hip) continue;
      const ax = Math.abs(wx[i]);
      if (ax > edge ? (hasArm && wz[i] >= zc) : (hasArm || ax <= inX || wy[i] <= hip * 1.4 || wz[i] >= zc + h * 0.3)) continue;
      const b = wings.find(j => (plan[j].s > 0) === (wx[i] >= 0));
      if (b !== undefined) take(i, b);
    }
    for (const i of wings) {
      const s = acc[i];
      if (s[3]) piv[i] = [(plan[i].s > 0 ? 1 : -1) * inX, s[1] / s[3], s[2] / s[3]];
    }
  }
  const ti = plan.findIndex(p => p.kind === 'tail');
  if (ti >= 0) {   /* the tail: whatever is left behind the plan's own hinge — on a dragon a thin midline run */
    const tz = plan[ti].z * h;
    for (let i = 0; i < vc; i++) if (!vb[i] && wz[i] < tz) take(i, ti);
    if (acc[ti][3]) piv[ti] = [0, plan[ti].y * h, tz];
  }
  return { vb, piv };
}
const nGeoCache = new Map(), NGEO_MAX = 48, nLive = [];   /* same LRU discipline as the loadouts */
function npcVariants(name) {
  const k = name.toLowerCase();
  const list = nByName.get(k);
  if (list) return list.length;
  if (npcIndex.has(k)) { kickResolveNpc(k); return npcIndex.get(k).length; }   // provisional positive: the caller retries via npcMesh's null until the real list lands
  return 0;                                                                     // not in the catalog: the box rig stays for good
}
function npcReady(v) { return v.m.every(id => models.has(id)) ? 1 : 0; }
function npcGeometry(v, key, h, plan) {
  let e = nGeoCache.get(key);
  if (e) { nGeoCache.delete(key); nGeoCache.set(key, e); return e; }
  const list = [];
  for (const id of v.m) { const m = models.get(id); if (m) list.push(makePart(m, 0, v.rc, 0)); }
  const g = merge(list);
  let top = 1;
  for (let i = 0; i < g.vc; i++) if (-g.vy[i] > top) top = -g.vy[i];   /* cache +Y is down: the head is the most negative y */
  const sy = h / top, sxz = sy * (v.ws || 128) / (v.hs || 128);        /* the fit sets the height; ws/hs only keeps the aspect */
  let piv = plan.map(() => null);
  if (plan.length) { const r = boneMap(g, plan, h, sxz, sy); g.vb = r.vb; piv = r.piv; }
  e = { geo: toGeometry(g, light(g, v.amb, v.con), { sx: sxz, sy, sz: sxz }), piv };
  nGeoCache.set(key, e);
  if (nGeoCache.size > NGEO_MAX) for (const [k2, e2] of nGeoCache) {
    if (k2 === key || nLive.some(m => m.geometry === e2.geo)) continue;
    e2.geo.dispose(); nGeoCache.delete(k2); break;
  }
  return e;
}
/* The rig: one body bone that never moves, one bone per plan limb, flat under the mesh. Spider hips bind at
   their resting yaw, because animateNpc steers slegs to base + sweep where every other kind swings from 0.
   Returns null until the name has resolved and its atoms are resident — the per-frame caller retries. */
function npcMesh(name, vi, h, plan) {
  const list = resolvedNpc(name);
  if (!list || !list.length) return null;
  const v = list[((vi % list.length) + list.length) % list.length];
  if (!npcReady(v)) return null;
  plan = plan || [];
  const key = name.toLowerCase() + '|' + list.indexOf(v) + '|' + h.toFixed(2);
  const e = npcGeometry(v, key, h, plan);
  const mesh = new THREE.SkinnedMesh(e.geo, nMats());
  const bones = [new THREE.Bone()];
  mesh.limbs = [];
  plan.forEach((p, i) => {
    const b = new THREE.Bone(), pv = e.piv[i];
    if (pv) b.position.set(pv[0], pv[1], pv[2]);
    if (p.kind === 'sleg') b.rotation.y = p.base || 0;
    bones.push(b);
    mesh.limbs.push({ m: b, kind: p.kind, s: p.s, ph: p.ph || 0, base: p.base || 0, a: p.a });
  });
  for (const b of bones) mesh.add(b);
  mesh.updateMatrixWorld(true);   /* bound at the origin, so bindMatrix is the identity */
  mesh.bind(new THREE.Skeleton(bones));
  nLive.push(mesh);
  return mesh;
}
function npcFree(mesh) { const i = nLive.indexOf(mesh); if (i >= 0) nLive.splice(i, 1); }

/* ---- 2007 world objects ------------------------------------------------------------------------------------
   resolveLoc maps a scenery display name to its variant list, porting osrs-locs.mjs' curation: the loc index
   gives the candidate ids for the name (or a simple plural/singular/alias form after a miss), grouped by look;
   a harvestable node (a menu op /^(chop|mine|cut)/) is chosen by fewest ops then lowest id, otherwise the most
   detailed rep leads; curated bare/dying looks (DEAD_LOCS) are tagged dd; the depleted (stump/cleared) state is
   inferred and rides along as sp; SKIP_LOCS drop; the list is capped at LOC_CAP and ordered by cache id. The
   old fixed-24 curation's WANT sizes, LOC_ORDER and the cross-name claimed-set are gone: each name resolves
   independently against the full catalog. Resolution fetches config and atoms, so it is async — but load()
   warms the fixed set the world plants (LOC_WARM), so locPools/locVariants/locMesh/locBatch answer synchronously
   in game exactly as before; any other name resolves on first use, locMesh/locBatch returning null until it does.
   A loc model is on the tile grid (128 units = 1 tile), so 1/128 stands it at the cache's own size; the def's
   resize/offset (s, o) folds into the vertices before lighting (ObjectComposition), lit by the scenery light. */
const DEAD_LOCS = new Set([26835, 8466, 8436, 8437, 8503, 30412, 30413, 30414]);   // bare/dying looks
const SKIP_LOCS = new Set([55913, 36682]);                                          // snow-capped oak, felled maple lump
const LOC_ALIASES = { 'decorative broadleaf tree': 'tree', 'rune essence rock': 'rune essence' };
const LOC_CAP = 8;
const LOC_WARM = ['Tree', 'Oak tree', 'Willow tree', 'Maple tree', 'Yew tree', 'Magic tree', 'Mahogany tree',
  'Copper rock', 'Tin rock', 'Iron rock', 'Coal rock', 'Mithril rock', 'Adamantite rocks', 'Runite rock',
  'Silver rock', 'Gold rock', 'Rune essence rock', 'Decorative broadleaf tree',
  'Cooking range', 'Furnace', 'Anvil', 'Market stall', 'Well', 'Fountain'];   // the trees/veins/fixtures game.js asks for; warmed so the loc calls stay synchronous
const modelsOf = o => {                      // shape 10/11 = free-standing centrepiece
  const shapes = new Set(o.models.map(m => m.shape));
  const shape = shapes.has(10) ? 10 : shapes.has(11) ? 11 : o.models[0].shape;
  return o.models.filter(m => m.shape === shape).map(m => m.model);
};
const HARVEST = /^(chop|mine|cut)\b/i;
const harvestable = o => o.ops.some(t => HARVEST.test(t));
const locLookSig = o => JSON.stringify([modelsOf(o).slice().sort((a, b) => a - b),
  eff(o.recolorFrom, o.recolorTo), eff(o.retextureFrom, o.retextureTo), o.s]);
const sameModels = (a, b) => modelsOf(a).slice().sort((x, y) => x - y).join() === modelsOf(b).slice().sort((x, y) => x - y).join();
function locDefOf(id, e) {
  return {
    id, name: cleanName(e.name), models: e.models,
    recolorFrom: e.recolorFrom || [], recolorTo: e.recolorTo || [],
    retextureFrom: e.retextureFrom || [], retextureTo: e.retextureTo || [],
    s: [g(e, 'modelSizeX', 128), g(e, 'modelSizeHeight', 128), g(e, 'modelSizeY', 128)],
    o: [g(e, 'offsetX', 0), g(e, 'offsetHeight', 0), g(e, 'offsetY', 0)],
    amb: g(e, 'ambient', 0), con: g(e, 'contrast', 0),
    width: g(e, 'width', 1), length: g(e, 'length', 1),
    ops: Object.values(e.ops || {}).map(v => v && v.text).filter(Boolean),
  };
}
async function ensureLocName(f) {           // cache loc name (lower) -> def list, fetched once
  if (locByName.has(f)) return locByName.get(f);
  const ids = locIndex.get(f);
  const defs = [];
  if (ids) {
    const rows = await Promise.all(ids.map(id => cfgEntry('loc', id).then(e => [id, e])));
    for (const [id, e] of rows) { if (!e || !e.models || !e.models.length) continue; const d = locDefOf(id, e); if (d.name && d.name !== 'null') defs.push(d); }
  }
  locByName.set(f, defs);
  return defs;
}
const locRowOf = st => {                     // one look -> compact runtime row (broken/empty models dropped)
  const m = modelsOf(st).filter(id => { const a = models.get(id); return a && a.fc; });
  if (!m.length) return null;
  const v = { m };
  const rc = pairs(st.recolorFrom, st.recolorTo), rt = pairs(st.retextureFrom, st.retextureTo);
  if (rc.length) v.rc = rc;
  if (rt.length) v.rt = rt;
  if (st.s.some(x => x !== 128)) v.s = st.s;
  if (st.o.some(x => x)) v.o = st.o;
  if (st.amb) v.amb = st.amb;
  if (st.con) v.con = st.con;
  return v;
};
const locInflight = new Set();
async function resolveLoc(k) {
  const alias = LOC_ALIASES[k];
  const forms = [k, k + 's', k.replace(/s$/, ''), k.replace(/\s*\(.*\)$/, '').trim(), alias].filter(Boolean);
  let defs = null;
  for (const f of forms) { const d = await ensureLocName(f); if (d && d.length) { defs = d; break; } }
  if (!defs) { lByName.set(k, []); return; }
  const base = defs[0].name;   // the cache name of this group; depleted-name inference keys off it
  const tree = base.match(/^(.*?)\s*tree$/i), rock = /^(.+?)\s+rocks?$/i.test(base);
  const candNames = tree ? [base + ' stump', (tree[1] + ' tree stump').trim(), 'tree stump'] : rock ? ['rocks', 'rock'] : [];
  for (const c of candNames) await ensureLocName(c.toLowerCase());
  const groups = new Map();
  for (const o of defs) { const s = locLookSig(o); (groups.get(s) || groups.set(s, []).get(s)).push(o); }
  const reps = [...groups.values()].map(gr => gr.sort((a, b) => a.id - b.id)[0]);
  const depAll = () => {                      // stump-name inference, ported (reads the ensured candidate names)
    const all = kk => locByName.get(kk.toLowerCase()) || [];
    if (tree) return [...all(base + ' stump'), ...all((tree[1] + ' tree stump').trim()), ...all('tree stump')].filter(o => !harvestable(o));
    if (rock) return [...all('rocks'), ...all('rock')];
    return [];
  };
  const depCands = depAll();
  const atomIds = new Set();
  for (const o of [...reps, ...depCands]) for (const m of modelsOf(o)) atomIds.add(m);
  await fetchAtoms([...atomIds]);
  const bestDepleted = full => {              // most shared models, then nearest id
    const fm = new Set(modelsOf(full));
    let best = null;
    const cands = tree ? depCands : rock ? depCands.filter(o => sameModels(o, full) && !o.recolorFrom.length) : [];
    for (const cand of cands) {
      const shared = modelsOf(cand).filter(m => fm.has(m)).length, near = -Math.abs(full.id - cand.id);
      if (!best || shared > best.shared || (shared === best.shared && near > best.near)) best = { obj: cand, shared, near };
    }
    return best ? best.obj : null;
  };
  const pool = reps.filter(harvestable);      // resource node by menu; else rank scenery by detail
  const primary = pool.length
    ? pool.slice().sort((a, b) => a.ops.length - b.ops.length || a.id - b.id)[0]
    : reps.slice().sort((a, b) => weigh(modelsOf(b)) - weigh(modelsOf(a)) || a.id - b.id)[0];
  const rest = reps.filter(o => o !== primary).sort((a, b) => weigh(modelsOf(b)) - weigh(modelsOf(a)) || a.id - b.id);
  const dead = alias ? [] : rest.filter(o => DEAD_LOCS.has(o.id)).sort((a, b) => a.id - b.id);
  const picked = [];
  for (const o of [primary, ...dead, ...rest.filter(o => !DEAD_LOCS.has(o.id))]) {
    if (picked.length >= LOC_CAP) break;
    if (alias && DEAD_LOCS.has(o.id)) continue;
    if (!picked.includes(o)) picked.push(o);
  }
  const out = [], sigs = new Set();
  for (const o of picked.sort((a, b) => a.id - b.id)) {
    if (SKIP_LOCS.has(o.id)) continue;
    const v = locRowOf(o);
    if (!v) continue;
    if (DEAD_LOCS.has(o.id)) v.dd = 1;
    if (o.width !== 1) v.w = o.width;
    if (o.length !== 1) v.d = o.length;
    const dep = bestDepleted(o);
    if (dep) { const sp = locRowOf(dep); if (sp) v.sp = sp; }
    const sig = JSON.stringify(v);
    if (sigs.has(sig)) continue;
    sigs.add(sig); out.push(v);
  }
  lByName.set(k, out);
}
function kickResolveLoc(k) {
  if (lByName.has(k) || locInflight.has(k)) return;
  locInflight.add(k);
  resolveLoc(k).catch(() => { if (!lByName.has(k)) lByName.set(k, []); }).then(() => locInflight.delete(k));
}
function locResolved(name) {
  const k = name.toLowerCase();
  const v = lByName.get(k);
  if (v) return v;
  kickResolveLoc(k);
  return null;
}
const S128 = 1 / 128;
function locPart(m, st) {
  let verts = m.verts;
  const s = st.s, o = st.o;
  if (s || o) {
    const sx = s ? s[0] : 128, sy = s ? s[1] : 128, sz = s ? s[2] : 128;
    const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
    verts = Int16Array.from(m.verts);
    for (let i = 0; i < verts.length; i += 3) {
      verts[i] = Math.trunc(verts[i] * sx / 128) + ox;
      verts[i + 1] = Math.trunc(verts[i + 1] * sy / 128) + oy;
      verts[i + 2] = Math.trunc(verts[i + 2] * sz / 128) + oz;
    }
  }
  let colors = m.colors;
  if (st.rc && st.rc.length) {
    colors = Uint16Array.from(m.colors);
    for (let i = 0; i < colors.length; i++) for (const p of st.rc) if (colors[i] === p[0]) { colors[i] = p[1]; break; }
  }
  let tex = null;
  if (st.rt && st.rt.length && m.textures) {   /* stored +1 so 0 means untextured */
    tex = Uint16Array.from(m.textures);
    for (let i = 0; i < tex.length; i++) for (const p of st.rt) if (tex[i] === p[0] + 1) { tex[i] = p[1] + 1; break; }
  }
  return { m, verts, colors, pin: 0, tex };
}
let lMatO = null, lMatC = null;
function lMats() {
  if (!lMatO) {
    lMatO = basicMat({});
    lMatC = basicMat({ transparent: true, depthWrite: false });
    lMatO.color.setScalar(OPT.brightness); lMatC.color.setScalar(OPT.brightness);
  }
  return [lMatO, lMatC];
}
const lGeoCache = new Map(), LGEO_MAX = 96, lLive = [];   /* same LRU discipline again */
function locVariants(name) { const v = locResolved(name); return v ? v.length : 0; }
/* variant indices split by the dd flag (bare/dying looks tagged by cache id): a is the living pool, d the dead
   one. Names with no dead looks return d empty and the caller falls back. */
function locPools(name) {
  const v = locResolved(name);
  if (!v) return null;
  if (!v.pools) { const a = [], d = []; v.forEach((st, i) => (st.dd ? d : a).push(i)); v.pools = { a, d }; }
  return v.pools;
}
function locState(name, vi, spent) {
  const list = locResolved(name);
  if (!list || !list.length) return null;
  const v = list[vi % list.length];
  return spent ? v.sp || null : v;   /* no spent look in the cache: the caller keeps its own */
}
function locGeometry(name, vi, spent) {
  const st = locState(name, vi, spent);
  if (!st) return null;
  const key = name.toLowerCase() + '|' + vi + '|' + (spent ? 1 : 0);
  let e = lGeoCache.get(key);
  if (e) { lGeoCache.delete(key); lGeoCache.set(key, e); return e; }
  const list = [];
  for (const id of st.m) { const m = models.get(id); if (m) list.push(locPart(m, st)); }
  if (!list.length) return null;
  const g = merge(list);
  e = { geo: toGeometry(g, light(g, st.amb, st.con, LOC_LIT), { sx: S128, sy: S128, sz: S128 }) };
  lGeoCache.set(key, e);
  if (lGeoCache.size > LGEO_MAX) for (const [k2, e2] of lGeoCache) {
    if (k2 === key || lLive.some(m => m.geometry === e2.geo)) continue;
    e2.geo.dispose(); lGeoCache.delete(k2); break;
  }
  return e;
}
function locMesh(name, vi, spent) {
  const e = locGeometry(name, vi, spent);
  if (!e) return null;
  const mesh = new THREE.Mesh(e.geo, lMats());
  lLive.push(mesh);
  return mesh;
}
function locFree(mesh) { const i = lLive.indexOf(mesh); if (i >= 0) lLive.splice(i, 1); }
/* the batcher's view: positions and 3-component colours, copied out synchronously by Batch.add07, so the
   arrays may be LRU'd along with their geometry without ceremony */
function locBatch(name, vi) {
  const e = locGeometry(name, vi, 0);
  if (!e) return null;
  if (!e.bt) {
    const c4 = e.geo.attributes.color.array, n = c4.length / 4, c3 = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c3[i * 3] = c4[i * 4]; c3[i * 3 + 1] = c4[i * 4 + 1]; c3[i * 3 + 2] = c4[i * 4 + 2]; }
    e.bt = { pos: e.geo.attributes.position.array, col: c3 };
  }
  return e.bt;
}

/* ---- inventory icons ---------------------------------------------------------------------------------------------
   Every item sprite is drawn here from its cache model, the way the client draws it (ItemSpriteFactory and the software
   renderer behind it), so the game ships no item pictures. The def's inventoryModel is resized, recoloured and
   retextured, lit with the item light (toModel(64 + ambient, 768 + contrast, -50, -10, -50)), turned by zan2d then
   yan2d, carried out along xan2d by zoom2d with offsetX2d/offsetY2d and projected at focal 512 about (16, 16) onto a
   36 x 32 sprite (Model.projectAndDraw). Faces are culled, bucketed by depth and merged by render priority as the
   client orders them, then filled by Rasterizer3D's own scan rules: rows sampled at their top, spans [left >> 14,
   right >> 14), gouraud colour planes anchored at the triangle's top vertex and looked up in the palette per pixel,
   translucency blended over what is already painted. A textured face maps the texture's own pixels (out/tx) through
   its P/M/N triangle, lit by the face's lightness. Then drawBorder(1), and no shadow: the sprites the game has always
   shown had none. A quantity above one draws the def's stack variant (the coin piles, the five arrows) by the client's
   rule.
   Checked against the 1183 wiki sprites the game used to ship: 957 pixel-identical, the rest a shade apart on a
   gradient. It is all CPU into a 36 x 32 buffer (no WebGL context, no GPU readback), about 0.3 ms a sprite on a
   desktop CPU, drained at most 4 ms a slice. A finished sprite is cropped to its outline (the look the old files
   had), encoded once as a PNG and kept in IndexedDB under the cache revision, so a device draws an item once, ever:
   the next session paints from the store before its first frame asks.
     icon(cid, n)    -> Promise<object URL | null>   null: nothing to draw (the caller keeps its glyph)
     iconNow(cid, n) -> URL | null | undefined       synchronous; undefined = not drawn yet, ask icon() */
const SIN = new Int32Array(2048), COS = new Int32Array(2048);
for (let i = 0; i < 2048; i++) { SIN[i] = Math.trunc(65536 * Math.sin(i * Math.PI / 1024)); COS[i] = Math.trunc(65536 * Math.cos(i * Math.PI / 1024)); }
const ITEM_LIT = { ambient: 64, contrast: 768, x: -50, y: -10, z: -50 };
const sh16 = v => Math.floor(v / 65536);   /* Java's >> 16 on an int that never overflows here, without JS's 32-bit wrap */
const PAL_ICON = new Int32Array(65536);    /* the palette at BRIGHT, an entry filled the first time a sprite needs it: icons never wait for load() */
const palAt = i => PAL_ICON[i] || (PAL_ICON[i] = palRGB(i, BRIGHT));
const IW = 36, IH = 32;

/* one triangle by Rasterizer3D's scan: the top vertex (the first of any tie, in face order), the two others in cyclic
   order, 14-bit edge slopes, rows [top, bottom) and spans [left >> 14, right >> 14) clipped to the sprite. shade(T, row,
   x0, x1) paints a span; T is the top vertex, the anchor of the colour planes. */
function scanTri(x0, y0, x1, y1, x2, y2, shade) {
  let T, A, B;
  if (y0 <= y1 && y0 <= y2) { T = 0; A = 1; B = 2; } else if (y1 <= y2) { T = 1; A = 2; B = 0; } else { T = 2; A = 0; B = 1; }
  const X = [x0, x1, x2], Y = [y0, y1, y2];
  const xT = X[T], yT = Y[T], xA = X[A], yA = Y[A], xB = X[B], yB = Y[B];
  if (yT >= IH) return;
  const slope = (xa, ya, xb, yb) => ya !== yb ? Math.trunc(((xb - xa) * 16384) / (yb - ya)) : 0;
  const sTA = slope(xT, yT, xA, yA), sTB = slope(xT, yT, xB, yB), sAB = slope(xA, yA, xB, yB);
  const span = (r, e1x, e1y, s1, e2x, e2y, s2, firstLeft) => {
    const a = e1x * 16384 + s1 * (r - e1y), b = e2x * 16384 + s2 * (r - e2y);
    let l = (firstLeft ? a : b) >> 14, rr = (firstLeft ? b : a) >> 14;
    if (l < 0) l = 0;
    if (rr > IW) rr = IW;
    if (l < rr) shade(T, r, l, rr);
  };
  if (yA < yB) {                                                   /* A is the middle vertex */
    const aLeft = (yT === yA || sTB >= sTA) && (yT !== yA || sTB <= sAB);
    const yMid = Math.min(yA, IH), yBot = Math.min(yB, IH);
    for (let r = Math.max(yT, 0); r < yMid; r++) span(r, xT, yT, sTA, xT, yT, sTB, aLeft);
    for (let r = Math.max(yA, 0); r < yBot; r++) span(r, xA, yA, sAB, xT, yT, sTB, aLeft);
  } else {                                                         /* B is (or A and B share the bottom row) */
    const bLeft = yT !== yB ? sTB < sTA : sAB > sTA;
    const yMid = Math.min(yB, IH), yBot = Math.min(yA, IH);
    for (let r = Math.max(yT, 0); r < yMid; r++) span(r, xT, yT, sTB, xT, yT, sTA, bLeft);
    for (let r = Math.max(yB, 0); r < yBot; r++) span(r, xB, yB, sAB, xT, yT, sTA, bLeft);
  }
}

/* the sprite itself: def (cache item fields), m (a readModel atom), texHsl(t) (a texture's average HSL, for a face whose
   image is missing), texPx(t) ({w, h, px} RGBA, or null). Returns the outline-cropped RGBA {w, h, px}, or null. */
function iconPixels(def, m, texHsl, texPx) {
  if (!m || !m.fc) return null;
  const vc = m.vc, fc = m.fc, idx = m.indices;
  const rsx = g(def, 'resizeX', 128), rsy = g(def, 'resizeY', 128), rsz = g(def, 'resizeZ', 128), rs = rsx !== 128 || rsy !== 128 || rsz !== 128;
  const vx = new Int32Array(vc), vy = new Int32Array(vc), vz = new Int32Array(vc);
  for (let i = 0; i < vc; i++) {
    const x = m.verts[i * 3], y = m.verts[i * 3 + 1], z = m.verts[i * 3 + 2];
    vx[i] = rs ? Math.trunc(x * rsx / 128) : x; vy[i] = rs ? Math.trunc(rsy * y / 128) : y; vz[i] = rs ? Math.trunc(rsz * z / 128) : z;
  }
  const colors = Uint16Array.from(m.colors);                       /* recolour pair by pair over every face, as ModelData.recolor does */
  const rf = def.recolorFrom || [], rt = def.recolorTo || [];
  for (let k = 0; k < rf.length; k++) { const a = u16(rf[k]), b = u16(rt[k]); for (let f = 0; f < fc; f++) if (colors[f] === a) colors[f] = b; }
  let textures = m.textures;
  if (textures && def.retextureFrom) {                             /* stored +1: 0 is untextured */
    textures = Uint16Array.from(textures);
    for (let k = 0; k < def.retextureFrom.length; k++) { const a = u16(def.retextureFrom[k]) + 1, b = u16(def.retextureTo[k]) + 1; for (let f = 0; f < fc; f++) if (textures[f] === a) textures[f] = b; }
  }
  const lit = light({ vc, fc, vx, vy, vz, idx, colors, types: m.types, alphas: m.alphas, textures }, g(def, 'ambient', 0), g(def, 'contrast', 0), ITEM_LIT);
  let height = 0, bottom = 0, xz = 0;                              /* Model.calculateBoundsCylinder */
  for (let i = 0; i < vc; i++) { const y = vy[i]; if (-y > height) height = -y; if (y > bottom) bottom = y; const r = vx[i] * vx[i] + vz[i] * vz[i]; if (r > xz) xz = r; }
  xz = Math.trunc(Math.sqrt(xz) + 0.99);
  const radius = Math.trunc(Math.sqrt(xz * xz + height * height) + 0.99), diameter = radius + Math.trunc(Math.sqrt(xz * xz + bottom * bottom) + 0.99);
  if (diameter >= 6000) return null;
  const zoom = g(def, 'zoom2d', 2000), xan = g(def, 'xan2d', 0) & 2047, yan = g(def, 'yan2d', 0) & 2047, zan = g(def, 'zan2d', 0) & 2047;
  const offX = g(def, 'offsetX2d', 0), offY = g(def, 'offsetY2d', 0);
  const yOff = (height >> 1) + sh16(zoom * SIN[xan]) + offY, zOff = sh16(zoom * COS[xan]) + offY;   /* offsetY2d rides both, as the client adds it */
  const sinX = SIN[xan], cosX = COS[xan], d0 = sh16(sinX * yOff + cosX * zOff);
  const sx = new Int32Array(vc), sy = new Int32Array(vc), dep = new Int32Array(vc), cx = new Int32Array(vc), cy = new Int32Array(vc), cz = new Int32Array(vc);
  for (let i = 0; i < vc; i++) {
    let x = vx[i], y = vy[i], z = vz[i], t;
    if (zan) { t = sh16(y * SIN[zan] + x * COS[zan]); y = sh16(y * COS[zan] - x * SIN[zan]); x = t; }
    if (yan) { t = sh16(z * SIN[yan] + x * COS[yan]); z = sh16(z * COS[yan] - x * SIN[yan]); x = t; }
    x += offX; y += yOff; z += zOff;
    t = sh16(y * cosX - z * sinX); z = sh16(y * sinX + z * cosX); y = t;
    cx[i] = x; cy[i] = y; cz[i] = z; dep[i] = z - d0;
    sx[i] = z ? Math.trunc(x * 512 / z) + 16 : 16; sy[i] = z ? Math.trunc(y * 512 / z) + 16 : 16;
  }
  const bucket = new Array(diameter);                              /* front faces by average depth, far bucket first */
  for (let f = 0; f < fc; f++) {
    if (lit.c3[f] === -2) continue;
    const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
    if ((sx[a] - sx[b]) * (sy[c] - sy[b]) - (sx[c] - sx[b]) * (sy[a] - sy[b]) <= 0) continue;
    const k = Math.trunc((dep[a] + dep[b] + dep[c]) / 3) + radius;
    if (k < 0 || k >= diameter) return null;
    (bucket[k] || (bucket[k] = [])).push(f);
  }
  const px = new Int32Array(IW * IH);                              /* 0 is clear, as in SpritePixels; the palette never yields 0 */
  const draw = f => {
    const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
    const alpha = m.alphas ? m.alphas[f] & 255 : 0, t = textures ? textures[f] - 1 : -1;
    let h1 = lit.c1[f], h2 = lit.c2[f], h3 = lit.c3[f];
    const put = alpha === 0 ? (i, col) => { px[i] = col; } : (i, col) => {
      const ia = 256 - alpha, bg = px[i];
      px[i] = ((bg & 0xff00ff) * alpha >> 8 & 0xff00ff) + (((col & 0xff00) * ia >> 8 & 0xff00) + ((col & 0xff00ff) * ia >> 8 & 0xff00ff)) + ((bg & 0xff00) * alpha >> 8 & 0xff00);
    };
    const tex = t >= 0 && texPx ? texPx(t) : null;
    if (t >= 0 && !tex) { const avg = texHsl(t); h1 = shadeHsl(avg, h1); if (h3 !== -1) { h2 = shadeHsl(avg, h2); h3 = shadeHsl(avg, h3); } }   /* no image: the texture's average, as the client's low-detail path paints it */
    if (h3 === -1 && !tex) {
      const col = palAt(h1);
      scanTri(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c], (T, r, l, rr) => { for (let x = l; x < rr; x++) put(r * IW + x, col); });
      return;
    }
    if (h3 === -1) h2 = h3 = h1;
    const x1 = sx[a], y1 = sy[a], dx2 = sx[b] - x1, dy2 = sy[b] - y1, dx3 = sx[c] - x1, dy3 = sy[c] - y1, dh2 = h2 - h1, dh3 = h3 - h1;
    const det = dx2 * dy3 - dx3 * dy2;
    if (det === 0) return;
    const gx = Math.trunc(((dh2 * dy3 - dh3 * dy2) * 256) / det), gy = Math.trunc(((dh3 * dx2 - dh2 * dx3) * 256) / det);
    const VX = [x1, sx[b], sx[c]], VY = [y1, sy[b], sy[c]], VH = [h1, h2, h3];
    if (!tex) {
      scanTri(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c], (T, r, l, rr) => {
        let v = VH[T] * 256 - VX[T] * gx + gx + gy * (r - VY[T]) + gx * l;
        for (let x = l; x < rr; x++, v += gx) { let i8 = v >> 8; if (i8 < 0) i8 = 0; else if (i8 > 65535) i8 = 65535; put(r * IW + x, palAt(i8)); }
      });
      return;
    }
    /* the texture plane: P + u(M - P) + v(N - P) met by the view ray through the pixel */
    const tc = m.tcoords ? m.tcoords[f] : -1;
    let P = a, M = b, N = c;
    if (tc >= 0 && m.ttri && tc * 3 + 2 < m.ttri.length && (!m.ttypes || m.ttypes[tc] === 0)) { P = m.ttri[tc * 3]; M = m.ttri[tc * 3 + 1]; N = m.ttri[tc * 3 + 2]; }
    const Ax = cx[P], Ay = cy[P], Az = cz[P], Ux = cx[M] - Ax, Uy = cy[M] - Ay, Uz = cz[M] - Az, Wx = cx[N] - Ax, Wy = cy[N] - Ay, Wz = cz[N] - Az;
    const nx = Uy * Wz - Uz * Wy, ny = Uz * Wx - Ux * Wz, nz = Ux * Wy - Uy * Wx;
    const px1 = Ay * Wz - Az * Wy, py1 = Az * Wx - Ax * Wz, pz1 = Ax * Wy - Ay * Wx;
    const px2 = Uy * Az - Uz * Ay, py2 = Uz * Ax - Ux * Az, pz2 = Ux * Ay - Uy * Ax;
    const tw = tex.w, th = tex.h, tp = tex.px;
    scanTri(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c], (T, r, l, rr) => {
      let lv = VH[T] * 256 - VX[T] * gx + gx + gy * (r - VY[T]) + gx * l;
      const dy = r - 16;
      for (let x = l; x < rr; x++, lv += gx) {
        const dx = x - 16, den = nx * dx + ny * dy + nz * 512;
        if (!den) continue;
        const u = -(px1 * dx + py1 * dy + pz1 * 512) / den, v = -(px2 * dx + py2 * dy + pz2 * 512) / den;
        const tx = ((Math.floor(u * tw) % tw) + tw) % tw, ty = ((Math.floor(v * th) % th) + th) % th, ti = (ty * tw + tx) * 4;
        if (!tp[ti + 3]) continue;
        let L = lv >> 8; if (L < 0) L = 0; else if (L > 127) L = 127;
        const k = L / 127;
        put(r * IW + x, ((Math.min(255, Math.trunc(tp[ti] * k)) << 16) | (Math.min(255, Math.trunc(tp[ti + 1] * k)) << 8) | Math.min(255, Math.trunc(tp[ti + 2] * k))) || 1);
      }
    });
  };
  if (!m.prios) {
    for (let k = diameter - 1; k >= 0; k--) { const l = bucket[k]; if (l) for (const f of l) draw(f); }
  } else {                                                         /* priorities 10 and 11 interleave by depth with the groups 0, 3 and 5 */
    const cnt = new Int32Array(12), sum = new Int32Array(12), lists = Array.from({ length: 12 }, () => []), d10 = [], d11 = [];
    for (let k = diameter - 1; k >= 0; k--) {
      const l = bucket[k]; if (!l) continue;
      for (const f of l) {
        const p = m.prios[f];
        if (p > 11) return null;
        const n = cnt[p]++; lists[p].push(f);
        if (p < 10) sum[p] += k; else if (p === 10) d10[n] = k; else d11[n] = k;
      }
    }
    const avg = (p, q) => (cnt[p] > 0 || cnt[q] > 0) ? Math.trunc((sum[p] + sum[q]) / (cnt[p] + cnt[q])) : 0;
    const a12 = avg(1, 2), a34 = avg(3, 4), a68 = avg(6, 8);
    let li = 0, ln = cnt[10], lst = lists[10], dl = d10, on11 = false;
    if (li === ln) { ln = cnt[11]; lst = lists[11]; dl = d11; on11 = true; }
    let dcur = li < ln ? dl[li] : -1000;
    const step = () => {
      draw(lst[li++]);
      if (li === ln && !on11) { li = 0; ln = cnt[11]; lst = lists[11]; dl = d11; on11 = true; }
      dcur = li < ln ? dl[li] : -1000;
    };
    for (let p = 0; p < 10; p++) {
      while (p === 0 && dcur > a12) step();
      while (p === 3 && dcur > a34) step();
      while (p === 5 && dcur > a68) step();
      for (const f of lists[p]) draw(f);
    }
    while (dcur !== -1000) step();
  }
  let x0 = IW, y0 = IH, x1 = -1, y1 = -1;                          /* drawBorder(1), then the crop to the outline */
  const out = new Int32Array(IW * IH);
  for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) {
    const i = y * IW + x;
    let v = px[i];
    if (v === 0 && ((x > 0 && px[i - 1]) || (y > 0 && px[i - IW]) || (x < IW - 1 && px[i + 1]) || (y < IH - 1 && px[i + IW]))) v = 1;
    if (!v) continue;
    out[i] = v;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = out[(y + y0) * IW + x + x0], o = (y * w + x) * 4;
    if (!v) continue;
    rgba[o] = v >> 16 & 255; rgba[o + 1] = v >> 8 & 255; rgba[o + 2] = v & 255; rgba[o + 3] = 255;
  }
  return { w, h, px: rgba, x: x0, y: y0 };
}

/* ---- the sprite store and the draw queue ---- */
const ICON_REV = OUT + '/2/';                                      /* bump the /2/ whenever iconPixels draws differently: older sprites are then dropped */
const iconUrl = new Map();                                         /* cache id -> object URL, or null: nothing to draw */
const iconXY = new Map();                                          /* cache id -> [x, y]: where the cropped sprite sat on its 36 x 32 canvas */
const iconSv = new Map();                                          /* cache id -> [variant ids, quantities] | 0, once its def is known */
const iconWait = new Map(), iconMiss = new Map(), iconDefs = new Map();
const texPng = new Map();                                          /* texture id -> {w, h, px} | null */
let icQ = [], icTimer = 0, icCanvas = null, texCfg = null, texCfgV = null;
const svPick = (sv, n) => { let k = -1; if (sv && n > 1) for (let i = 0; i < sv[0].length && i < 10; i++) if (n >= sv[1][i] && sv[1][i] !== 0) k = sv[0][i]; return k; };

/* IndexedDB: one record a sprite ('<rev>/<v>/<cid>' -> PNG Blob, or null for nothing to draw), its crop ('xy<cid>' -> [x, y])
   and a stack table ('<rev>/<v>/sv<cid>'). Read whole at the first ask; a private window or a blocked store simply runs without it. */
let storeP = null, storeDb = null, storePend = [], storeT = 0;
function storeReady() {
  if (storeP) return storeP;
  return storeP = new Promise(done => {
    let settled = 0;
    const finish = () => { if (!settled) { settled = 1; done(); } };
    setTimeout(finish, 1500);                                      /* a store that never answers must not hold the sprites back */
    try {
      const rq = indexedDB.open('seedworld-icons', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('icons');
      rq.onerror = finish;
      rq.onsuccess = () => {
        storeDb = rq.result;
        try {
          const os = storeDb.transaction('icons', 'readonly').objectStore('icons'), range = IDBKeyRange.bound(ICON_REV, ICON_REV + String.fromCharCode(65535));
          const kq = os.getAllKeys(range), vq = os.getAll(range);
          vq.onsuccess = () => {
            const keys = kq.result || [], vals = vq.result || [];
            for (let i = 0; i < keys.length; i++) {
              const k = keys[i].slice(ICON_REV.length), v = vals[i];
              if (k[0] === 's') { if (!iconSv.has(+k.slice(2))) iconSv.set(+k.slice(2), v || 0); }
              else if (k[0] === 'x') { if (v) iconXY.set(+k.slice(2), v); }
              else if (!iconUrl.has(+k)) iconUrl.set(+k, v ? URL.createObjectURL(v) : null);
            }
            finish();
            const cq = os.count();
            cq.onsuccess = () => { if (cq.result > keys.length) storeSweep(); };
          };
          vq.onerror = finish;
        } catch (e) { finish(); }
      };
    } catch (e) { finish(); }
  });
}
function storeSweep() {                                            /* sprites of an older cache or renderer go, a cursor at a time, once */
  try {
    const os = storeDb.transaction('icons', 'readwrite').objectStore('icons'), cur = os.openCursor();
    cur.onsuccess = () => { const c = cur.result; if (!c) return; if (String(c.key).indexOf(ICON_REV) !== 0) c.delete(); c.continue(); };
  } catch (e) { /* the next session tries again */ }
}
function storePut(key, val) {
  if (!storeDb) return;
  storePend.push([ICON_REV + key, val]);
  if (!storeT) storeT = setTimeout(() => {
    storeT = 0;
    const rows = storePend; storePend = [];
    try { const os = storeDb.transaction('icons', 'readwrite').objectStore('icons'); for (const [k, v] of rows) os.put(v, k); } catch (e) { /* unsaved: drawn again next session */ }
  }, 800);
}

function iconDef(cid) {
  let p = iconDefs.get(cid);
  if (!p) {
    p = cfgEntry('item', cid).then(d => {
      if (d && !iconSv.has(cid)) {
        const sv = d.stackVariantItems ? [d.stackVariantItems, d.stackVariantQuantities || []] : 0;
        iconSv.set(cid, sv); storePut('sv' + cid, sv);
      }
      return d || null;
    });
    iconDefs.set(cid, p);
    p.catch(() => iconDefs.delete(cid));
  }
  return p;
}
function iconNow(cid, n) {
  if (!(cid >= 0)) return null;
  let k = cid;
  if (n > 1) { const sv = iconSv.get(cid); if (sv === undefined) return iconMissed(cid); const v = svPick(sv, n); if (v > 0) k = v; }
  const u = iconUrl.get(k);
  return u === undefined ? iconMissed(k) : u;
}
/* where a drawn sprite's crop sits on the client's 36 x 32 canvas (null until it is drawn): the 2007 frame lays items on their slots with it */
function iconXYNow(cid, n) {
  let k = cid;
  if (n > 1) { const v = svPick(iconSv.get(cid), n); if (v > 0) k = v; }
  return iconXY.get(k) || null;
}
const iconMissed = k => { const t = iconMiss.get(k); return t && performance.now() - t < 30000 ? null : undefined; };   /* a failed fetch rests half a minute before it is asked again */
function icon(cid, n) {
  const now = iconNow(cid, n);
  if (now !== undefined) return Promise.resolve(now);
  return storeReady().then(() => {
    const again = iconNow(cid, n);
    if (again !== undefined) return again;
    if (!(n > 1)) return drawSprite(cid);
    return iconDef(cid).then(d => { const v = d ? svPick(iconSv.get(cid), n) : -1; return drawSprite(v > 0 ? v : cid); });
  }).catch(() => null);
}
function drawSprite(cid) {
  if (iconUrl.has(cid)) return Promise.resolve(iconUrl.get(cid));
  let p = iconWait.get(cid);
  if (p) return p;
  p = iconDef(cid).then(d => {
    if (!d || !(d.inventoryModel >= 0)) return keepSprite(cid, null);
    return fetchAtom(d.inventoryModel).then(() => texturesFor(models.get(d.inventoryModel), d)).then(() => new Promise(res => {
      icQ.push([cid, d, res]);
      if (!icTimer) icTimer = setTimeout(drainIcons, 0);
    }));
  }).catch(() => { iconWait.delete(cid); iconMiss.set(cid, performance.now()); return null; });
  iconWait.set(cid, p);
  return p;
}
function keepSprite(cid, blob, xy) {
  const url = blob ? URL.createObjectURL(blob) : null;
  iconUrl.set(cid, url); iconWait.delete(cid);
  storePut(String(cid), blob);
  if (xy) { iconXY.set(cid, xy); storePut('xy' + cid, xy); }
  return url;
}
/* a textured model's texture config and images, before it is queued (the rest never fetch them) */
function texturesFor(m, d) {
  if (!m || !m.textures) return null;
  const ids = new Set();
  const rf = d.retextureFrom || [], rt = d.retextureTo || [];
  for (let f = 0; f < m.fc; f++) { let t = m.textures[f] - 1; if (t < 0) continue; for (let k = 0; k < rf.length; k++) if (t === u16(rf[k])) { t = u16(rt[k]); break; } ids.add(t); }
  if (!ids.size) return null;
  if (!texCfg) texCfg = cfgShard('texture', 0).then(c => (texCfgV = c || {}), () => (texCfgV = {}));
  return Promise.all([texCfg, ...[...ids].map(texImage)]);
}
function texImage(t) {
  if (texPng.has(t)) return Promise.resolve();
  return fetch(OUT + '/tx/' + t + '.png').then(r => r.ok ? r.blob() : Promise.reject(new Error('tx ' + t)))
    .then(b => typeof createImageBitmap === 'function' ? createImageBitmap(b) : new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(b); })).then(bm => {
      const cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height;
      const cx2 = cv.getContext('2d'); cx2.drawImage(bm, 0, 0);
      texPng.set(t, { w: bm.width, h: bm.height, px: cx2.getImageData(0, 0, bm.width, bm.height).data });
    }).catch(() => { texPng.set(t, null); });
}
function drainIcons() {
  icTimer = 0;
  const t0 = performance.now();
  while (icQ.length && performance.now() - t0 < 4) {
    const [cid, d, res] = icQ.shift();
    let s = null;
    try {
      const tc = texCfgV;
      s = iconPixels(d, models.get(d.inventoryModel), t => tc && tc[t] ? tc[t].averageRGB || 0 : 0, t => texPng.get(t) || null);
    } catch (e) { s = null; }
    if (!s) { res(keepSprite(cid, null)); continue; }
    if (!icCanvas) icCanvas = document.createElement('canvas');
    icCanvas.width = s.w; icCanvas.height = s.h;
    const c2 = icCanvas.getContext('2d');
    c2.putImageData(new ImageData(s.px, s.w, s.h), 0, 0);
    const xy = [s.x, s.y];
    if (icCanvas.toBlob) icCanvas.toBlob(b => { if (b) res(keepSprite(cid, b, xy)); else { iconWait.delete(cid); iconMiss.set(cid, performance.now()); res(null); } }, 'image/png');
    else fetch(icCanvas.toDataURL()).then(r => r.blob()).then(b => res(keepSprite(cid, b, xy)), () => res(keepSprite(cid, null)));
  }
  if (icQ.length) icTimer = setTimeout(drainIcons, 16);
}
const itemDef = cid => cfgEntry('item', cid);   /* the cache's own row (examine text and all), fetched with its shard */
const aliasName = k => { for (const [re, to] of ALIASES) if (re.test(k)) return k.replace(re, to).toLowerCase(); return null; };   /* a seedworld name's cache spelling, where it has one */

const api = { OUT, load, rig, dress, brightness, idFor, npcVariants, npcMesh, npcFree, locVariants, locPools, locMesh, locFree, locBatch, icon, iconNow, iconXY: iconXYNow, iconStore: storeReady, itemDef, aliasName, ready: () => loaded };   /* OUT: map07.js reads the tree from the same base */
/* dead in the game (the flag is never set there); the parity self-test sets globalThis.OSRS_TEST to reach the resolvers */
if (typeof globalThis !== 'undefined' && globalThis.OSRS_TEST) api._t = { nByName, lByName, itemDefs, itemById, resolveItem, resolveNpc, resolveLoc, fetchAtoms, models, npcIndex, locIndex, itemIndex, iconPixels, readModel };
return api;
})();
