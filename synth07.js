/* ---- 50. THE WORLD PAST THE MAP: Gielinor's rectangle, continued in its own pieces ----
   With the 2007 models on, every map square outside the 2007 map's rectangle is written here in the cache's own format — tile
   heights, underlays, overlays, shapes, flags, loc placements, npc spawns — and map07.js loads it exactly as it loads a real
   square: the same blended ground and textures, the same models, walls, doors, minimap colours, picking, collision, and the
   same Gielinor systems work it (m7Classify's trees and rocks, banks, shops by their keepers' names, monsters by their cache
   stats, fishing spots, sailing on its water). What goes where is still the seed world's ('lumbridge'): its coasts, rivers,
   mountains, kingdoms, roads, towns, mines, groves, shoals and wilderness rings. What it is made of is the real map's, measured
   by tools/bake07/synth.mjs into assets/map07/synth.json: each kingdom kind wears the palette of the region it is named for
   (the meadows Misthalin's, the desert the Kharidian's, the mire Morytania's...), and every town is built of whole buildings cut
   from the main map — houses, shops with their keepers, banks, churches, smithies, keeps. With the models off the seed world
   answers past the rectangle as before (seedAt, section 46). Squares are made on demand as they stream in, a row at a time
   inside map07's frame budget, and the last few are kept. ---- */
const SY_BIO = ['meadows', 'highlands', 'greenwood', 'mire', 'desert', 'jungle', 'reach', 'wilds'], SY_WILD = 7;
const SY = { data: null, loading: null, tpl: {}, tplP: {}, cache: new Map(), towns: new Map(), rgb: new Map() };
let syT0 = 0;
const syBreath = () => performance.now() - syT0 < 6 ? null : new Promise(r => setTimeout(() => { syT0 = performance.now(); r(); }, 0));   // a long job hands the thread back every few milliseconds
const syU = (x, y, s) => ((hash2(x, y, S + s) >>> 0) & 65535) / 65536;   // a per-tile uniform
const syY = m => m <= 0 ? 0 : 16 * (1 - Math.exp(-m / 40)) + m * 0.02;   // the seed's heights (tens of tiles) as the map's (a hill a few tiles, a peak fifteen)
const syH = m => -Math.round(syY(m) * 128);
/* a weighted list [[id, weight, ...], ...] as a cumulative table */
function syCum(list) {
  const out = [], c = [];
  let s = 0;
  for (const e of list || []) { s += e[1]; out.push(e); c.push(s); }
  return out.length ? { e: out, c, s } : null;
}
function syPick(T, u) {
  if (!T) return null;
  const v = u * T.s;
  let lo = 0, hi = T.c.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (T.c[mid] > v) hi = mid; else lo = mid + 1; }
  return T.e[lo];
}
function syLoad() {
  if (SY.data) return Promise.resolve(SY.data);
  if (!SY.loading) SY.loading = fetch(OSRSK.SITE + 'assets/map07/synth.json').then(r => r.ok ? r.json() : Promise.reject(new Error('synth.json ' + r.status))).then(j => {
    const bio = SY_BIO.map(k => {
      const b = j.bio[k] || j.bio.meadows;
      const ul = b.ul.slice().sort((a, c) => c[1] - a[1]), tot = ul.reduce((s, e) => s + e[1], 0);
      const scen = (b.tree || []).map(e => [e[0], e[1], e[2] || 1, e[3] || 1]).concat((b.obj || []).map(e => [e[0], e[1], e[2] || 1, e[3] || 1]));   // trees and scenery together, in the proportions the real country has them
      return { k, ul0: ul[0] ? ul[0][0] : 48, ulShare: ul[0] ? ul[0][1] / tot : 1, ulRest: syCum(ul.slice(1)), hi: syCum(b.hi), path: (b.path[0] || [14])[0], paths: b.path.map(e => e[0]),
        shore: syCum(b.shore && b.shore.length ? b.shore : [[62, 1]]), decor: syCum(b.decor), obj: syCum(b.obj), tree: syCum(b.tree), scen: syCum(scen), dens: b.dens || [0.08, 0.5],
        npc: (b.npc || []).slice().sort((a, c) => a[1] - c[1]), folk: syCum(b.folk && b.folk.length ? b.folk : j.bio.meadows.folk), td: (REG.find(r => r.k === k) || REG[0]).td,
        street: syCum(b.street), guard: syCum(b.guard), byName: new Map() };
    });
    for (const P of bio) for (const e of P.npc) { const n = e[3] || String(e[0]); (P.byName.get(n) || P.byName.set(n, []).get(n)).push(e); }   // a monster's level variants, lowest first
    SY.data = { bio, ores: j.ores, trees: j.trees, fish: j.fish || [], lava: j.lava || 19, swamp: j.swamp || 7, stack: j.stack || {}, tplKinds: j.tpl, map: j.map || null, icons: j.icons || {} };
    return SY.data;
  }, e => { SY.loading = null; throw e; });
  return SY.loading;
}
/* a biome's buildings, decoded once: tiles as a DataView over their records */
function syTpl(b) {
  if (SY.tpl[b]) return Promise.resolve(SY.tpl[b]);
  if (!SY.tplP[b]) SY.tplP[b] = fetch(OSRSK.SITE + 'assets/map07/synth-' + b + '.json').then(r => r.ok ? r.json() : Promise.reject(new Error('synth-' + b + ' ' + r.status))).then(async j => {
    const byKind = {}, cells = {};
    for (const t of j.tpl) {
      const w8 = syBreath(); if (w8) await w8;
      const bin = atob(t.g), g = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) g[i] = bin.charCodeAt(i);
      const T = { k: t.k, w: t.w, l: t.l, p: t.p, g, dv: new DataView(g.buffer), L: t.L, N: t.N, I: t.I || [] }, cx = Math.floor(t.o[0] / 384), cy = Math.floor(t.o[1] / 384), ck = cx + ':' + cy;
      (byKind[t.k] = byKind[t.k] || []).push(T);
      const C = cells[ck] = cells[ck] || { n: 0, cx, cy };   // where it was cut from: one town is built in one place's own style
      (C[t.k] = C[t.k] || []).push(T); C.n++;
    }
    byKind.cells = Object.values(cells).filter(C => C.n >= 3 && C.house);
    byKind.all = Object.values(cells);
    return SY.tpl[b] = byKind;
  }, e => { SY.tplP[b] = null; throw e; });
  return SY.tplP[b];
}
/* the ground under a tile: the seed's field, levelled where a made city stands, flattened onto its town's table as the seed does */
function syField(gx, gy) {
  const z = -gy;
  let m = macroHeight(gx, z);
  const cl = cityList(gx, z);
  if (cl.length) m = syCityLevel(gx, gy, m, cl);
  const n = nearVillage(gx, z);
  if (n) { const flat = 1 - smoothstep(0.98, 1.4, n.d / n.v.r); m += (n.v.y - m) * flat; }
  return m;
}
/* a city levels its ground toward the country smoothed over 32 tiles — its hills roll on under it, its dunes and hummocks go —
   easing back to the country's own over its edge, so its plots and streets lie near flat */
const SYC_FLAT = new Map();
function syFlatAt(gx, gy) {
  const fx = gx / 32, fy = gy / 32, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (a, b) => { const k = a * 65536 + b; let h = SYC_FLAT.get(k); if (h === undefined) { if (SYC_FLAT.size > 60000) SYC_FLAT.clear(); SYC_FLAT.set(k, h = macroHeight(a * 32, -b * 32)); } return h; };
  const a0 = at(x0, y0), p = a0 + (at(x0 + 1, y0) - a0) * tx, c0 = at(x0, y0 + 1), q = c0 + (at(x0 + 1, y0 + 1) - c0) * tx;
  return p + (q - p) * ty;
}
function syCityLevel(gx, gy, m, list) {
  for (const v of list) {
    const r = villageDist(v, gx, -gy) / v.sprawl;
    if (r < 1.2) return m + (syFlatAt(gx, gy) - m) * 0.9 * (1 - smoothstep(0.9, 1.2, r));
  }
  return m;
}
const syBioAt = (gx, gy) => wildD(gx, -gy) > 0 ? SY_WILD : Math.max(0, SY_BIO.indexOf(regionAt(gx, -gy).a.k));
/* one tile's ground: [underlay, overlay, flags] into o (heights and scenery come with the square) */
function syGround(gx, gy, m, b, o) {
  const D = SY.data, P = D.bio[b], z = -gy;
  if (m < SEA) {
    const road = b !== SY_WILD && m > -3.5 && highwayAt(gx, z) > 0.42;
    if (!road) {
      const deep = -m;
      o[0] = P.ul0; o[2] = 1;
      o[1] = b === SY_WILD && deep < 4 ? D.lava : P.k === 'mire' && deep < 2.5 ? D.swamp : deep < 1.2 ? 6 : deep < 4.5 ? 442 : deep < 8 ? 445 : 448;
      return 0;
    }
    m = 0.6;   // the road fords the shallows on a causeway
  }
  o[2] = 0; o[1] = 0;
  /* the ground: the country's own underlay, broken by patches of its others in whole clumps (never a per-tile speckle, which the
     client's blend would smear into one muddy tone); rock over the heights, the shore's own at the water's edge */
  const yT = syY(m), patch = noise2(gx * 0.11, gy * 0.11, S + 920) + (syU(gx, gy, 921) - 0.5) * 0.08, kind = 0.5 + noise2(gx * 0.023, gy * 0.023, S + 923) * 0.9;
  if (P.hi && yT > 8 && syU(gx, gy, 922) < smoothstep(8, 12.5, yT)) o[0] = syPick(P.hi, clamp(kind, 0, 0.999))[0];
  else if (m < 1.1) o[0] = syPick(P.shore, clamp(kind, 0, 0.999))[0];
  else if (patch < 0.34 + (P.ulShare - 0.5) * 0.6 || !P.ulRest) o[0] = P.ul0;
  else o[0] = syPick(P.ulRest, clamp(kind, 0, 0.999))[0];
  if (b !== SY_WILD && m > 0.7 && highwayAt(gx, z) > 0.42) o[1] = P.path;
  return m;
}
/* ---- towns: the seed's settlements, built of the main map's buildings round an open square ---- */
const SY_ORE = ['copper', 'tin', 'iron', 'coal', 'mithril', 'adamant', 'runite', 'silver', 'gold'];
const SY_FALL = { meadows: ['highlands'], highlands: ['meadows'], greenwood: ['meadows'], mire: ['meadows'], desert: ['meadows'], jungle: ['desert', 'greenwood'], reach: ['highlands', 'meadows'], wilds: ['highlands', 'meadows'] };   // where a country without a kind of building borrows it
function syTown(v) {
  const key = Math.round(v.x) + ':' + Math.round(v.z);
  if (SY.towns.has(key)) return SY.towns.get(key);
  const p = (async () => {
    const gx0 = Math.round(v.x), gy0 = Math.round(-v.z), b = syBioAt(gx0, gy0), bn = SY_BIO[b];
    const T = await syTpl(bn), FB = await Promise.all((SY_FALL[bn] || ['meadows']).map(syTpl));
    const rank = v.rank, hh = hash2(gx0, gy0, S + 700) >>> 0;
    const want = [];
    if (rank >= 3) want.push('big');
    if (rank >= 2) want.push('bank', 'church');
    if (rank >= 1) want.push('shop');
    if (rank >= 2) want.push('shop', 'smithy');
    if (rank >= 3) want.push('shop', 'bank', 'shop');
    for (let i = 0, n = 2 + rank * 3 + (hh % 3); i < n; i++) want.push('house');
    const R = Math.max(16, v.r * 0.92), heart = 1 + rank, rects = [[gx0 - heart, gy0 - heart, gx0 + heart, gy0 + heart]];
    const P = SY.data.bio[b], style = T.cells && T.cells.length ? T.cells[hh % T.cells.length] : null;   // the place its buildings come from
    const town = { gx: gx0, gy: gy0, r: R, heart, base: syH(v.y), b, rank, stamps: [],
      lane: rank >= 2 && P.paths.includes(10) ? 10 : P.path };   // a town of any size lays grey cobbles, a hamlet trodden earth
    const land = (x, y) => syField(x, y) > 0.9;
    const listFor = k => {   // the style's own; else the nearest place of the same country that has one; else the next country along
      if (style && style[k] && style[k].length) return style[k];
      let best = null, bd = 1e9;
      for (const C of T.all || []) { if (!C[k] || !C[k].length) continue; const d = style ? Math.hypot(C.cx - style.cx, C.cy - style.cy) : 0; if (d < bd) { bd = d; best = C[k]; } }
      if (best) return best;
      for (const F of FB) if (F[k] && F[k].length) return F[k];
      return [];
    };
    for (let wi = 0; wi < want.length; wi++) {
      const k = want[wi], w8 = syBreath();
      if (w8) await w8;
      const L = listFor(k);
      if (!L.length) continue;
      const t = L[(hash2(gx0 + wi * 7, gy0 - wi * 13, S + 701) >>> 0) % L.length];
      for (let a = 0; a < 220; a++) {   // out from the heart on a golden spiral: the first place it fits, on dry ground, clear of the rest by a street
        const ang = a * 2.39996 + (hh & 63), rr = heart + 3 + a * 0.45;
        if (rr + Math.max(t.w, t.l) * 0.5 > R) break;
        const x0 = gx0 + Math.round(Math.cos(ang) * rr) - (t.w >> 1), y0 = gy0 + Math.round(Math.sin(ang) * rr) - (t.l >> 1), x1 = x0 + t.w - 1, y1 = y0 + t.l - 1;
        if (rects.some(r => x0 <= r[2] + 2 && x1 >= r[0] - 2 && y0 <= r[3] + 2 && y1 >= r[1] - 2)) continue;
        if (!land(x0, y0) || !land(x1, y0) || !land(x0, y1) || !land(x1, y1) || !land((x0 + x1) >> 1, (y0 + y1) >> 1)) continue;
        rects.push([x0, y0, x1, y1]);
        town.stamps.push({ t, x0, y0, x1, y1, base: syH(syField((x0 + x1) >> 1, (y0 + y1) >> 1)) });   // it stands on the ground at its own middle, not on one height for the whole town
        break;
      }
    }
    return town;
  })();
  SY.towns.set(key, p);
  if (SY.towns.size > 200) for (const k of [...SY.towns.keys()].slice(0, 60)) SY.towns.delete(k);
  return p;
}
/* ---- cities: every settlement of rank 2 or more (game.js villageAt — a metro city's whole sprawl, or another's core) ----
   A made city is planned the way a grown one reads. Avenues run AV tiles apart through its heart, north-south and east-west,
   crossing at an open square; each super-block between them is cut by side streets into blocks, and each block is packed in
   rows with whole buildings of the city's country — its civic heart (keeps, banks, churches, shops), its market ring, its streets
   of houses, its thinning suburbs, a park here and there — each district styled from one real place, the next country's buildings
   standing in for what its own lacks, and one far country's thrown in now and then. Every plot is checked against the ground
   before it is built on: dry, not too steep, clear of the highways, inside the city's outline. A block is a pure function of its
   city and its index, planned the first time a square or a map piece needs it, so a city of thousands of buildings costs what the
   squares round you do. Its people come with it — townsfolk on the side streets and avenues, the watch, a crowd in the square —
   standing only on the paving. */
const SYC = { blocks: new Map() };
const syMod = (a, n) => ((a % n) + n) % n;
const SYC_KIND = [   // the districts, by distance from the heart in sprawls: [reach, what their plots hold ('' a garden)]
  [0.16, [['big', 3], ['bank', 3], ['church', 2], ['shop', 4], ['smithy', 1], ['house', 1]]],
  [0.42, [['shop', 5], ['house', 5], ['smithy', 1.2], ['bank', 0.7], ['church', 0.4], ['big', 0.3]]],
  [0.8, [['house', 9], ['shop', 1.4], ['smithy', 0.6], ['church', 0.25], ['', 0.8]]],
  [1e9, [['house', 6], ['smithy', 0.4], ['shop', 0.4], ['', 4]]],
].map(([d, l]) => [d, syCum(l)]);
function syCity(v) {
  if (v.syc) return v.syc;
  const gx = Math.round(v.x), gy = Math.round(-v.z), b = syBioAt(gx, gy), bn = SY_BIO[b], h = hash2(gx, gy, S + 1700) >>> 0, q = synReach(v.x, v.z);
  const fall = SY_FALL[bn] || ['meadows'], far = SY_BIO.filter(k => k !== bn && k !== 'wilds' && !fall.includes(k)), P = SY.data.bio[b];
  const AV = v.sprawl < 110 ? [30, 32, 34, 36][h & 3] : v.sprawl < 320 ? [36, 40, 44, 44][h & 3] : [40, 44, 48, 52][h & 3];   // a town's blocks are a town's size
  return v.syc = { v, key: gx + ':' + gy, gx, gy, b, bn, q, h, R: v.sprawl, AV, AW: v.sprawl >= 320 ? 4 : 3,
    plaza: Math.max(2, Math.min(Math.floor(v.sprawl * 0.22), 3 + v.rank + Math.round(q * 9))), lane: P.paths.includes(10) ? 10 : P.path,
    dens: 0.6 + 1.4 * q, sets: [bn].concat(fall, [far[(h >>> 8) % far.length]]), T: null, ready: null, crowd: null };
}
function syCityReady(C) {   // its country's buildings, its neighbours', and its far country's
  if (C.T) return Promise.resolve(C);
  return C.ready || (C.ready = Promise.all(C.sets.map(syTpl)).then(T => { C.T = T; return C; }));
}
const syCityOK = C => !!(C.T || (C.sets.every(k => SY.tpl[k]) && (C.T = C.sets.map(k => SY.tpl[k]))));
function syCityList(C, k, i, j, u) {   // the buildings a plot of kind k draws from
  const own = C.T[0], vary = C.T[C.T.length - 1];
  if (u < 0.07 && vary[k] && vary[k].length) return vary[k];   // one far country's, for variety
  const cells = own.cells || [];
  if (cells.length && u < 0.8) { const st = cells[(hash2(C.gx + (i >> 2) * 131, C.gy + (j >> 2) * 71, S + 1703) >>> 0) % cells.length]; if (st[k] && st[k].length) return st[k]; }   // a district's style: one real place's
  if (own[k] && own[k].length) return own[k];
  for (let n = 1; n < C.T.length - 1; n++) if (C.T[n][k] && C.T[n][k].length) return C.T[n][k];
  return own.house || [];
}
const syInPlaza = (C, x, y, m) => x >= C.gx - C.plaza - m && x <= C.gx + C.AW - 1 + C.plaza + m && y >= C.gy - C.plaza - m && y <= C.gy + C.AW - 1 + C.plaza + m;
function syCityPlot(C, p) {   // may this plot be built on: in the city, not in the square, dry, not too steep, off the highways
  if (p.x1 >= C.gx - C.plaza - 1 && p.x0 <= C.gx + C.AW + C.plaza && p.y1 >= C.gy - C.plaza - 1 && p.y0 <= C.gy + C.AW + C.plaza) return false;
  const cx = (p.x0 + p.x1) >> 1, cy = (p.y0 + p.y1) >> 1;
  let lo = 1e9, hi = -1e9;
  if (!cityHolds(C.v, cx, -cy)) return false;   // its middle in the city; its edges may stand a little past the outline, into the eased ground
  for (const [x, y] of [[p.x0, p.y0], [p.x1, p.y0], [p.x0, p.y1], [p.x1, p.y1], [cx, cy], [cx, p.y0], [cx, p.y1], [p.x0, cy], [p.x1, cy]]) {
    if (villageDist(C.v, x, -y) > C.R * 1.18 || wildD(x, -y) > -30 || highwayAt(x, -y) > 0.02) return false;
    const m = syField(x, y);
    if (m < SEA + 0.1) return false;   // water
    const yy = syY(m);
    if (yy < lo) lo = yy; if (yy > hi) hi = yy;
  }
  if (hi - lo > 2.4) return false;   // a hillside plot is left to the country
  p.base = syH(syField(cx, cy));
  return true;
}
function syCityBlock(C, i, j) {   // needs C.T (syCityOK)
  const key = C.key + ':' + i + ':' + j;
  let B = SYC.blocks.get(key);
  if (B) return B;
  const AV = C.AV, AW = C.AW, x0 = C.gx + i * AV + AW, y0 = C.gy + j * AV + AW, x1 = C.gx + (i + 1) * AV - 1, y1 = C.gy + (j + 1) * AV - 1;
  const hs = hash2(C.gx + i * 977, C.gy + j * 613, S + 1702) >>> 0, dq = Math.hypot((x0 + x1) / 2 - C.gx, (y0 + y1) / 2 - C.gy) / C.R;
  const heart = i >= -1 && i <= 0 && j >= -1 && j <= 0;
  B = { i, j, x0, y0, x1, y1, streets: [], parcels: [], folk: [], park: 0 };
  SYC.blocks.set(key, B);
  if (SYC.blocks.size > 6000) for (const k of [...SYC.blocks.keys()].slice(0, 1500)) SYC.blocks.delete(k);
  if (dq > EXT_MAX + 0.25) return B;   // wholly past any outline
  if (!heart && dq > 0.2 && hs % 100 < 5 + dq * 6) B.park = 1;   // a park: the country's own ground, its trees and flowers
  else {
    const kinds = SYC_KIND.find(e => (heart ? 0 : dq) <= e[0])[1], deep = heart || dq < 0.16 ? 0 : dq < 0.42 ? 1 : 3, leaves = [];
    const cut = (a, b, c, d, depth, hh) => {   // side streets two tiles wide, each block split along its longer side
      const w = c - a + 1, l = d - b + 1;
      if (depth >= deep || (w <= 18 + (hh & 15) && l <= 18 + (hh & 15)) || Math.max(w, l) < 22) { leaves.push([a, b, c, d]); return; }
      const along = w > l || (w === l && (hh & 16)), at = Math.round((along ? w : l) * (0.36 + ((hh >>> 5) & 31) / 110));
      const h1 = hash2(hh & 0xffffff, depth, S + 1704) >>> 0, h2 = hash2(hh & 0xffffff, depth + 7, S + 1705) >>> 0;
      if (along) { B.streets.push([a + at, b, a + at + 1, d]); cut(a, b, a + at - 1, d, depth + 1, h1); cut(a + at + 2, b, c, d, depth + 1, h2); }
      else { B.streets.push([a, b + at, c, b + at + 1]); cut(a, b, c, b + at - 1, depth + 1, h1); cut(a, b + at + 2, c, d, depth + 1, h2); }
    };
    cut(x0, y0, x1, y1, 0, hs);
    for (const [a, b, c, d] of leaves) {   // packed on a skyline: each building drops onto the lowest free edge along the block, a yard's tile from the next
      const W = c - a + 1, top = new Int32Array(W).fill(b);
      for (let guard = 0; guard < 64; guard++) {
        let x = 0;
        for (let k = 1; k < W; k++) if (top[k] < top[x]) x = k;
        const y = top[x];
        if (y > d - 5) break;
        let run = 0;
        while (x + run < W && top[x + run] <= y) run++;
        const kind = syPick(kinds, syU(a + x, y, 1706))[0], u2 = syU(a + x + 3, y - 5, 1707), u3 = syU(a + x - 7, y + 2, 1708);
        const fitsIn = t => t.w <= run && t.l <= d - y + 1;
        let L = kind ? syCityList(C, kind, i, j, u2).filter(fitsIn) : [];
        if (!L.length && kind !== '') L = syCityList(C, 'house', i, j, u2).filter(fitsIn);
        let w = run, l;
        if (!L.length) {   // nothing fits the gap (or a garden was drawn): it stays a yard up to its neighbours' line
          let next = d + 1;
          if (x > 0) next = Math.min(next, top[x - 1]);
          if (x + run < W) next = Math.min(next, top[x + run]);
          l = Math.max(kind === '' ? 8 : 1, next - y);
          if (kind === '') w = Math.min(run, 9);
        } else {
          L.sort((p, q) => q.w * q.l - p.w * p.l);
          const t = L[Math.floor(u3 * Math.min(L.length, 4))], p = { t, x0: a + x, y0: y, x1: a + x + t.w - 1, y1: y + t.l - 1, base: 0 };   // among the biggest few that fit, so the block fills
          if (syCityPlot(C, p)) B.parcels.push(p);
          w = Math.min(run, t.w + 1); l = t.l + 1;
        }
        for (let k = x; k < x + w; k++) top[k] = y + l;
      }
    }
  }
  /* its people: townsfolk along its side streets and the two avenues it owns (west and south), and now and then the watch */
  for (const [a, b, c, d] of B.streets) for (let k = 0, n = Math.round((c - a + 1) * (d - b + 1) * C.dens / 30); k < n; k++) {
    const hh = hash2(a * 7 + k, b * 13 - k, S + 1723) >>> 0;
    B.folk.push([a + hh % (c - a + 1), b + (hh >>> 10) % (d - b + 1), 0]);
  }
  const wx = C.gx + i * AV, sy = C.gy + j * AV;
  for (let k = 0, n = Math.round(AV * 2 * AW * C.dens / 44); k < n; k++) {
    const hh = hash2(wx * 3 + k, sy * 5 - k, S + 1724) >>> 0;
    B.folk.push(k & 1 ? [wx + hh % AW, sy + (hh >>> 8) % AV, 0] : [wx + AW + (hh >>> 8) % (AV - AW), sy + hh % AW, 0]);
  }
  if ((hs >>> 20) % 100 < 25 + 50 * C.q) B.folk.push([wx + (hs >>> 3) % AW, sy + (hs >>> 9) % AV, 1]);
  return B;
}
function syCrowd(C) {   // the heart square's crowd, and the watch at its corners
  if (C.crowd) return C.crowd;
  const pl = C.plaza, side = pl * 2 + C.AW, out = [];
  for (let k = 0, n = Math.round(side * side * C.dens / 18); k < n; k++) { const hh = hash2(C.gx + k * 31, C.gy - k * 17, S + 1722) >>> 0; out.push([C.gx - pl + hh % side, C.gy - pl + (hh >>> 12) % side, 0]); }
  for (const [dx, dy] of [[-pl, -pl], [pl + C.AW - 1, -pl], [-pl, pl + C.AW - 1], [pl + C.AW - 1, pl + C.AW - 1]]) out.push([C.gx + dx, C.gy + dy, 1]);
  return C.crowd = out;
}
/* a city into a square: its paving, its buildings on their feathered footings, its people */
function syCityInto(C, bx, by, D, sq) {
  const { H, UL, OL, SR, FL, locs, spawns, occ, inTown } = sq, P = D.bio[C.b], v = C.v, AV = C.AV, AW = C.AW;
  const i0 = Math.floor((bx - 4 - C.gx) / AV), i1 = Math.floor((bx + 67 - C.gx) / AV), j0 = Math.floor((by - 4 - C.gy) / AV), j1 = Math.floor((by + 67 - C.gy) / AV), nj = j1 - j0 + 1;
  const blocks = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) blocks.push(syCityBlock(C, i, j));
  const plot = new Uint8Array(4096);
  for (const B of blocks) for (const p of B.parcels) {
    for (let x = Math.max(p.x0, bx); x <= Math.min(p.x1, bx + 63); x++) for (let y = Math.max(p.y0, by); y <= Math.min(p.y1, by + 63); y++) plot[(x - bx) * 64 + y - by] = 1;
  }
  for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) {
    const gx = bx + x, gy = by + y, k = x * 64 + y;
    if (!cityHolds(v, gx, -gy)) continue;
    const B = blocks[(Math.floor((gx - C.gx) / AV) - i0) * nj + Math.floor((gy - C.gy) / AV) - j0];
    inTown[k] = B.park ? 2 : 1;   // 2: a park keeps the country's trees; neither has monsters
    if (plot[k] || FL[k] & 1) continue;
    let paved = syMod(gx - C.gx, AV) < AW || syMod(gy - C.gy, AV) < AW || syInPlaza(C, gx, gy, 0);
    if (!paved) for (const r of B.streets) if (gx >= r[0] && gx <= r[2] && gy >= r[1] && gy <= r[3]) { paved = true; break; }
    if (paved) { OL[k] = C.lane; inTown[k] = 1; }
  }
  for (const B of blocks) for (const s of B.parcels) {   // in one order every square agrees on, so a footing shared across a border eases the same
    if (s.x1 + 4 < bx || s.x0 - 4 >= bx + 64 || s.y1 + 4 < by || s.y0 - 4 >= by + 64) continue;
    for (let gx = Math.max(s.x0 - 3, bx); gx <= Math.min(s.x1 + 3, bx + 63); gx++) for (let gy = Math.max(s.y0 - 3, by); gy <= Math.min(s.y1 + 3, by + 63); gy++) {
      const i = (gx - bx) * 64 + (gy - by);
      if (plot[i] || FL[i] & 1) continue;
      const k = 1 - Math.max(s.x0 - gx, gx - s.x1, s.y0 - gy, gy - s.y1) / 4;
      H[i] = Math.round(H[i] + (s.base - H[i]) * k);
      H[4096 + i] = H[i] - 240; H[8192 + i] = H[i] - 480; H[12288 + i] = H[i] - 720;
    }
    syStamp(s, s, bx, by, H, UL, OL, SR, FL, locs, spawns, occ);
  }
  const taken = new Set();
  const person = ([x, y, role]) => {
    if (x < bx || x >= bx + 64 || y < by || y >= by + 64) return;
    const k = (x - bx) * 64 + (y - by);
    if (plot[k] || occ[k] || FL[k] & 1 || OL[k] !== C.lane || taken.has(k)) return;   // on the paving, one to a tile
    taken.add(k);
    const pal = role === 1 ? P.guard || P.folk : syU(x, y, 1720) < 0.6 && P.street ? P.street : P.folk, e = syPick(pal, syU(x, y, 1721));
    if (e) spawns.push({ id: e[0], x, y, plane: 0 });
  };
  for (const B of blocks) B.folk.forEach(person);
  if (syInPlaza(C, bx, by, 64) && syInPlaza(C, bx + 63, by + 63, 64)) syCrowd(C).forEach(person);
}
/* the settlements a square must lay: the made cities whose outlines may reach it, and the hamlets and villages whose tables do */
async function sySettleNear(bx, by) {
  const towns = [], cities = [], seen = new Set();
  for (const v of citiesIn(bx - 8, -(by + 72), bx + 72, -(by - 8))) cities.push(await syCityReady(syCity(v)));
  for (const gx of [bx - 180, bx + 32, bx + 244]) for (const gy of [by - 180, by + 32, by + 244]) {
    const cx = Math.floor(gx * INV_CELL), cz = Math.floor(-gy * INV_CELL), k = cx + ':' + cz;
    if (seen.has(k)) continue;
    seen.add(k);
    const v = villageAt(cx, cz);
    if (!v || v.sprawl || g7Out(v.x, v.z) < 200) continue;
    const t = await syTown(v);
    if (t.gx + t.r + 40 < bx || t.gx - t.r - 40 > bx + 64 || t.gy + t.r + 40 < by || t.gy - t.r - 40 > by + 64) continue;
    towns.push(t);
  }
  return { towns, cities };
}
/* the level a made square's monsters are drawn toward: a few near Gielinor, the country's toughest far out, higher in the
   wilderness, and wandering a little either way from place to place */
const syMonLv = (gx, gy, q) => clamp(4 + 236 * Math.pow(q, 1.1) + wildLvAt(gx, -gy) * 1.2 + noise2(gx * 0.0021, gy * 0.0021, S + 1710) * (5 + 25 * q), 1, 400);
/* ---- a square ---- */
function syRememb(rid, sq) { SY.cache.set(rid, sq); if (SY.cache.size > 24) SY.cache.delete(SY.cache.keys().next().value); return sq; }
async function sySquare(rid, yieldFn) {
  if (SY.cache.has(rid)) return SY.cache.get(rid);
  const D = await syLoad();
  const sqX = rid >> 8, sqY = rid & 255, bx = sqX * 64, by = sqY * 64;
  const H = new Int16Array(16384), UL = new Uint16Array(16384), OL = new Uint16Array(16384), SR = new Uint8Array(16384), FL = new Uint8Array(16384);
  const locs = [], spawns = [], occ = new Uint8Array(4096), M = new Float32Array(4096), BI = new Uint8Array(4096), inTown = new Uint8Array(4096);
  let seg = performance.now(), cpu = 0;
  const pause = async () => { if (yieldFn) { const w = yieldFn(); if (w) { const d = performance.now() - seg; cpu += d; SY.block = Math.max(SY.block || 0, d); await w; seg = performance.now(); } } };
  /* the field on the global four-tile lattice, bilinear between: the one costly sample */
  const G = new Float32Array(17 * 17);
  for (let j = 0; j <= 16; j++) { for (let i = 0; i <= 16; i++) G[j * 17 + i] = macroHeight(bx + i * 4, -(by + j * 4)); await pause(); }
  const o = [0, 0, 0], sqCities = citiesIn(bx - 8, -(by + 72), bx + 72, -(by - 8));
  for (let x = 0; x < 64; x++) {
    for (let y = 0; y < 64; y++) {
      const gx = bx + x, gy = by + y, i = x * 64 + y, fx = x / 4, fy = y / 4, i0 = Math.min(15, fx | 0), j0 = Math.min(15, fy | 0), tx = fx - i0, ty = fy - j0;
      const a = G[j0 * 17 + i0] + (G[j0 * 17 + i0 + 1] - G[j0 * 17 + i0]) * tx, c = G[(j0 + 1) * 17 + i0] + (G[(j0 + 1) * 17 + i0 + 1] - G[(j0 + 1) * 17 + i0]) * tx;
      let m = a + (c - a) * ty;
      if (sqCities.length) m = syCityLevel(gx, gy, m, sqCities);   // a city's levelled ground (syField's)
      if (m > 0.3) m += noise2(gx * 0.19, gy * 0.19, S + 910) * 0.45;   // a little relief under the lattice; the sea stays flat
      const n = nearVillage(gx, -gy);
      if (n) { const flat = 1 - smoothstep(0.98, 1.4, n.d / n.v.r); m += (n.v.y - m) * flat; }
      const b = syBioAt(gx, gy);
      BI[i] = b;
      M[i] = m = syGround(gx, gy, m, b, o);
      UL[i] = o[0]; OL[i] = o[1]; FL[i] = o[2];
      H[i] = o[2] & 1 ? 0 : syH(m);
      H[4096 + i] = H[i] - 240; H[8192 + i] = H[i] - 480; H[12288 + i] = H[i] - 720;   // the storeys above stand 240 apart, as the cache's own do: a tall piece's upper parts ride on them
    }
    await pause();
  }
  /* towns: streets, the open square, then the buildings over them; cities: their plan (syCityInto) */
  const { towns, cities } = await sySettleNear(bx, by);
  await pause();
  for (const C of cities) { syCityInto(C, bx, by, D, { H, UL, OL, SR, FL, locs, spawns, occ, inTown }); await pause(); }
  for (const t of towns) {
    const P = D.bio[t.b];
    for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) {
      const gx = bx + x, gy = by + y, dx = gx - t.gx, dy = gy - t.gy, i = x * 64 + y;
      if (dx * dx + dy * dy > t.r * t.r) continue;
      inTown[i] = 1;
      if (FL[i] & 1) continue;
      const heart = Math.abs(dx) <= t.heart && Math.abs(dy) <= t.heart, lane = ((dx === 0 || dx === 1) || (dy === 0 || dy === 1)) && dx * dx + dy * dy < t.r * t.r * 0.8;   // a small square and two lanes crossing at it, as the 2007 towns lay them
      if (heart || lane) OL[i] = t.lane;
    }
    for (const s of t.stamps) {
      if (s.x1 + 4 < bx || s.x0 - 4 >= bx + 64 || s.y1 + 4 < by || s.y0 - 4 >= by + 64) continue;
      for (let gx = s.x0 - 3; gx <= s.x1 + 3; gx++) for (let gy = s.y0 - 3; gy <= s.y1 + 3; gy++) {   // the ground eases to the building's footing over three tiles
        if (gx < bx || gx >= bx + 64 || gy < by || gy >= by + 64 || (gx >= s.x0 && gx <= s.x1 && gy >= s.y0 && gy <= s.y1)) continue;
        const i = (gx - bx) * 64 + (gy - by), d = Math.max(s.x0 - gx, gx - s.x1, s.y0 - gy, gy - s.y1), k = 1 - d / 4;
        if (FL[i] & 1) continue;
        H[i] = Math.round(H[i] + (s.base - H[i]) * k);
        H[4096 + i] = H[i] - 240; H[8192 + i] = H[i] - 480; H[12288 + i] = H[i] - 720;
      }
      syStamp(s, s, bx, by, H, UL, OL, SR, FL, locs, spawns, occ);
    }
    for (let q = 0, n = 2 + t.rank; q < n; q++) {   // folk about the square
      const hh = hash2(t.gx + q * 5, t.gy - q * 3, S + 950) >>> 0, gx = t.gx - t.heart + hh % (t.heart * 2 + 1), gy = t.gy - t.heart + (hh >>> 10) % (t.heart * 2 + 1);
      if (gx < bx || gx >= bx + 64 || gy < by || gy >= by + 64) continue;
      const f = syPick(P.folk, syU(gx, gy, 951));
      if (f) spawns.push({ id: f[0], x: gx, y: gy, plane: 0 });
    }
  }
  await pause();
  /* what grows and lies about: trees, scenery, ground cover; mines and groves where the seed sites them */
  const fits = (x, y, w, l, park) => { if (x + w > 64 || y + l > 64) return false; for (let a = 0; a < w; a++) for (let c = 0; c < l; c++) { const j = (x + a) * 64 + y + c; if (occ[j] || OL[j] || FL[j] & 1 || (inTown[j] && !(park && inTown[j] === 2))) return false; } return true; };
  const claim = (x, y, w, l) => { for (let a = 0; a < w; a++) for (let c = 0; c < l; c++) occ[(x + a) * 64 + y + c] = 1; };
  for (const [cx, cz] of syCells(bx, by, SITE_CELL, 24)) {
    const st = siteAt(cx, cz);
    if (!st || !st.res) continue;
    for (const [key, val] of st.res) {
      const x0 = Math.floor((key + 2097152) / 4194304), z0 = key - x0 * 4194304, x = x0 - bx, y = -z0 - by;
      if (x < 0 || y < 0 || x > 62 || y > 62) continue;
      if (val > 0) {
        const ids = D.ores[SY_ORE[val - 1]];
        if (!ids || !ids.length || !fits(x, y, 1, 1)) continue;
        locs.push({ id: ids[(hash2(x0, z0, S + 960) >>> 0) % ids.length], type: 10, rot: (hash2(x0, z0, S + 961) >>> 0) & 3, plane: 0, x, y }); claim(x, y, 1, 1);
      } else {
        const kind = -(val + 1), nm = ['', 'oak', 'willow', 'maple', 'yew', 'magic'][kind], skill = nm && D.trees[nm] && D.trees[nm][0];
        const tr = skill || syPick(D.bio[BI[x * 64 + y]].tree, 0.3);   // a skill tree is [id, w, l]; a palette tree [id, count, w, l]
        if (!tr) continue;
        const w = (skill ? tr[1] : tr[2]) || 2, l = (skill ? tr[2] : tr[3]) || 2;
        if (!fits(x, y, w, l)) continue;
        locs.push({ id: tr[0], type: 10, rot: (hash2(x0, z0, S + 962) >>> 0) & 3, plane: 0, x, y }); claim(x, y, w, l);
      }
    }
  }
  const qs = synReach(bx + 32, -(by + 32));   // how far out this square lies: the country grows thicker with it
  for (let x = 0; x < 64; x++) {
    for (let y = 0; y < 64; y++) {
      const i = x * 64 + y, town = inTown[i];
      if (occ[i] || OL[i] || FL[i] & 1) continue;
      const gx = bx + x, gy = by + y, P = D.bio[BI[i]], m = M[i];
      if (m < 0.9) continue;
      if (town === 1) {   // a city's yards and gardens: flowers and grass, no woods
        if (P.decor && syU(gx, gy, 938) < P.dens[1] * 0.5) locs.push({ id: syPick(P.decor, syU(gx, gy, 939))[0], type: 22, rot: (hash2(gx, gy, S + 940) >>> 0) & 3, plane: 0, x, y });
        continue;
      }
      /* woods and clearings: the real country's own density of trees and scenery a tile, gathered by a slow field into stands
         and glades (its mean stays the measured one), and its ground cover a little thinner where the trees stand thick */
      const grove = clamp(0.9 + noise2(gx * 0.021, gy * 0.021, S + 931) * 1.5 + biomeAt(gx, -gy) * 0.3, 0, 2.4) * (1 + 0.35 * qs);
      const slope = Math.abs(H[i] - H[Math.min(4095, i + 65)]);
      if (P.scen && slope < 160 && syU(gx, gy, 932) < P.dens[0] * grove) {
        const e = syPick(P.scen, syU(gx, gy, 933));
        if (e && fits(x, y, e[2], e[3], 1)) {
          const rot = (hash2(gx, gy, S + 935) >>> 0) & 3, st = D.stack[e[0]];
          locs.push({ id: e[0], type: 10, rot, plane: 0, x, y });
          if (st) { if (st[0]) locs.push({ id: st[0], type: 10, rot, plane: 1, x, y }); if (st[1]) locs.push({ id: st[1], type: 10, rot, plane: 2, x, y }); }   // its storeys above: the palm's middle and crown
          claim(x, y, e[2], e[3]); continue;
        }
      }
      if (P.decor && syU(gx, gy, 938) < P.dens[1] * (1.1 - 0.25 * Math.min(1, grove))) locs.push({ id: syPick(P.decor, syU(gx, gy, 939))[0], type: 22, rot: (hash2(gx, gy, S + 940) >>> 0) & 3, plane: 0, x, y });
    }
    if ((x & 15) === 15) await pause();
  }
  /* shoals at the bank, and the country's monsters */
  if (D.fish.length) for (const [cx, cz] of syCells(bx, by, FISH_CELL, 8)) {
    const c = fishCellAt(cx, cz);
    if (!c) continue;
    for (const key of c.set) {
      const x0 = Math.floor((key + 2097152) / 4194304), z0 = key - x0 * 4194304, x = x0 - bx, y = -z0 - by;
      if (x < 0 || y < 0 || x > 63 || y > 63 || !(FL[x * 64 + y] & 1) || OL[x * 64 + y] === D.lava) continue;
      spawns.push({ id: D.fish[(hash2(cx, cz, S + 970) >>> 0) % D.fish.length][0], x: x0, y: -z0, plane: 0 });
    }
  }
  /* the country's monsters: more of them the further out, in bigger packs, drawn toward a level that climbs with the reach —
     and of a kind with several levels, the stronger ones the likelier out there */
  const wildSq = BI[32 * 64 + 32] === SY_WILD, hm = hash2(sqX, sqY, S + 980) >>> 0;
  const nMon = Math.round((2 + hm % 4) * (1 + 2.2 * qs)) + (wildSq ? Math.round(3 + 3 * qs) : 0), packMax = Math.round(3 + 3 * qs);
  for (let k = 0; k < nMon; k++) {
    const hh = hash2(sqX * 31 + k, sqY * 17 - k, S + 981) >>> 0, x = 4 + hh % 56, y = 4 + (hh >>> 8) % 56, i = x * 64 + y;
    if (occ[i] || FL[i] & 1 || OL[i] || inTown[i] || M[i] < 0.9) continue;
    const gx = bx + x, gy = by + y, P = D.bio[BI[i]];
    if (!P.npc.length) continue;
    const L = Math.min(syMonLv(gx, gy, qs), P.npc[P.npc.length - 1][1] * 1.05);   // past its country's toughest, its toughest come
    let best = null, bw = 0;
    for (const e of P.npc) { const f = e[1] / L, w = f < 0.45 || f > 1.7 ? 0 : e[2] * (1 - Math.abs(Math.log(f)) * 0.8); if (w > 0 && syU(gx + e[0], gy, 982) * w > bw) { bw = syU(gx + e[0], gy, 982) * w; best = e; } }
    if (!best) best = P.npc.reduce((q, e) => Math.abs(e[1] - L) < Math.abs(q[1] - L) ? e : q, P.npc[0]);
    const vars = (P.byName.get(best[3] || String(best[0])) || []).filter(e => e[1] >= best[1] * 0.5);
    for (let q = 0, n = 1 + (hh >>> 16) % packMax; q < n; q++) {
      const hq = hash2(gx + q * 7, gy - q * 11, S + 984) >>> 0, e = vars.length > 1 ? vars[Math.min(vars.length - 1, Math.floor((1 - Math.pow(1 - (hq & 1023) / 1024, 1 + 4 * qs)) * vars.length))] : best;
      const sx = gx + ((hq >>> 10) % 5) - 2, sy = gy + ((hq >>> 14) % 5) - 2, j = (sx - bx) * 64 + (sy - by);
      if (sx < bx || sy < by || sx >= bx + 64 || sy >= by + 64 || occ[j] || FL[j] & 1 || inTown[j]) continue;
      spawns.push({ id: e[0], x: sx, y: sy, plane: 0 });
    }
  }
  cpu += performance.now() - seg;
  SY.made = (SY.made || 0) + 1; SY.cpu = (SY.cpu || 0) + cpu; SY.worst = Math.max(SY.worst || 0, cpu);   // what a made square costs, for the dev console
  return syRememb(rid, { H, UL, OL, SR, FL, locs, spawns });
}
function syCells(bx, by, cell, pad) {   // lattice cells (seed x, z) whose members can land in the square
  const out = [];
  for (let cx = Math.floor((bx - pad) / cell); cx <= Math.floor((bx + 64 + pad) / cell); cx++)
    for (let cz = Math.floor((-(by + 64) - pad) / cell); cz <= Math.floor((-by + pad) / cell); cz++) out.push([cx, cz]);
  return out;
}
function syStamp(s, town, bx, by, H, UL, OL, SR, FL, locs, spawns, occ) {
  const t = s.t, W = t.w, L = t.l, dv = t.dv, g = t.g;
  for (let x = 0; x < W; x++) {
    const gx = s.x0 + x;
    if (gx < bx || gx >= bx + 64) continue;
    for (let y = 0; y < L; y++) {
      const gy = s.y0 + y;
      if (gy < by || gy >= by + 64) continue;
      const i = (gx - bx) * 64 + (gy - by);
      occ[i] = 1;
      for (let p = t.p; p < 4; p++) H[p * 4096 + i] = town.base + dv.getInt16(((0 * W + x) * L + y) * 8 + 6, true) - 240 * p;   // storeys the building has none of stand on its ground
      for (let p = 0; p < t.p; p++) {
        const r = ((p * W + x) * L + y) * 8, u = dv.getUint16(r, true), ol = dv.getUint16(r + 2, true), j = p * 4096 + i;
        if (!u && !ol) { H[j] = town.base + dv.getInt16(r + 6, true); continue; }   // no floor here, but the storey's height carries its roof and walls
        UL[j] = u; OL[j] = ol; SR[j] = g[r + 4]; FL[j] = g[r + 5]; H[j] = town.base + dv.getInt16(r + 6, true);
      }
    }
  }
  const Ls = t.L;
  for (let q = 0; q < Ls.length; q += 6) {
    const lx = s.x0 + Ls[q + 3], ly = s.y0 + Ls[q + 4];
    if (lx < bx || lx >= bx + 64 || ly < by || ly >= by + 64) continue;
    locs.push({ id: Ls[q], type: Ls[q + 1], rot: Ls[q + 2], plane: Ls[q + 5], x: lx - bx, y: ly - by });
  }
  const Ns = t.N;
  for (let q = 0; q < Ns.length; q += 4) {
    const nx = s.x0 + Ns[q + 1], ny = s.y0 + Ns[q + 2];
    if (nx < bx || nx >= bx + 64 || ny < by || ny >= by + 64) continue;
    spawns.push({ id: Ns[q], x: nx, y: ny, plane: Ns[q + 3] });
  }
}
/* the colour of a tile on the minimaps and the world map, without its scenery; town: a town's middle as one patch of its paving
   (the minimap's stand-in until the square is up; the world map lays the town's real plan over it instead) */
const _syo = [0, 0, 0];
function syGroundRGB(gx, gy, town) {
  const m = syField(gx, gy), b = syBioAt(gx, gy), mm = syGround(gx, gy, m, b, _syo);
  let ol = _syo[1];
  if (town && !(_syo[2] & 1)) { const n = nearVillage(gx, -gy); if (n && n.d < Math.max(4, n.v.r * 0.25)) ol = SY.data.bio[b].path; }
  let c = MAP07.tileColor(ol, _syo[0]);
  if (c < 0) return 0x0c1016;
  if (!(_syo[2] & 1)) { const k = 0.9 + Math.min(0.25, syY(mm) * 0.02); c = ((Math.min(255, (c >> 16 & 255) * k)) << 16) | ((Math.min(255, (c >> 8 & 255) * k)) << 8) | Math.min(255, (c & 255) * k); }
  return c;
}
function syTileRGB(gx, gy) {   // memoised by tile: as you walk the minimap asks the same tiles row after row
  if (!SY.data) return 0x0c1016;
  const key = tk(gx, -gy);
  let c = SY.rgb.get(key);
  if (c === undefined) { c = syGroundRGB(gx, gy, 1); capMap(SY.rgb, 80000); SY.rgb.set(key, c); }
  return c;
}

/* ---- the world map past the rectangle (section 31's seed layer hands over here while the made world is on) ----
   Far out it is drawn the way the 2007 world map draws Gielinor: each country in the colours world.png paints the region it is
   named for (synth.json map: its land, shores, high ground, roads and towns), in clumps as the picture lays them, on the
   picture's own sea, with the roads and towns outlined. From the zoom Gielinor shows its squares at, every tile wears its own
   ground colour. Closer than a country's width, each town lays its plan over that — lanes, floors, walls and map icons cut from
   its buildings, whose files load only then. Pieces are 64-pixel tiles made a few milliseconds a frame, nearest first; one not
   made yet shows the coarser piece round it, and those are made first, so a drag never meets a hole. ---- */
const SYM = { pal: null, towns: new Map(), jobs: 0, prov: new Set() };
const SYM_TILES = 1600, SYM_M = new Float32Array(66 * 66), SYM_G = new Float32Array(67 * 67), SYM_B = new Uint8Array(4096), SYM_L = new Uint8Array(17 * 17);
const syCss = c => '#' + ((c & 0xffffff) | 0x1000000).toString(16).slice(1);
const syDist = (a, b) => Math.abs((a >> 16 & 255) - (b >> 16 & 255)) + Math.abs((a >> 8 & 255) - (b >> 8 & 255)) + Math.abs((a & 255) - (b & 255));
/* the map's colours: a country's own ground (its underlays, paths and high ground, in the shares its squares lay them) in the shade
   the 2007 picture paints the nearest of them (synth.json map, read off world.png over the region the country is named for), so
   far out it looks like Gielinor's picture and close in it is the same ground; the sea, the lava and the towns the picture's own */
function syMapPal() {
  const D = SY.data;
  if (SYM.pal || !D || !MAP07.ready()) return SYM.pal;
  const M = D.map || { bio: {} }, lava = (M.lava || []).map(e => e[0]).sort((a, b) => syDist(b, 0) - syDist(a, 0));
  const dim = (c, k) => ((c >> 16 & 255) * k << 16) | ((c >> 8 & 255) * k << 8) | (c & 255) * k;
  SYM.pal = { sea: M.sea || 0x4f628e, lavaRim: lava[0] || 0xd57808, lavaIn: dim(lava[lava.length - 1] || 0x663d0c, 0.5),   // lava the picture's way: near black, its edge in fire
    bio: SY_BIO.map((k, b) => {
      const P = D.bio[b], B = M.bio[k] || {}, pic = [].concat(B.land || [], B.shore || [], B.hi || [], B.road || []).map(e => e[0]);
      const snap = c => { let best = c, bd = 40; for (const q of pic) { const d = syDist(c, q); if (d < bd) { bd = d; best = q; } } return best; };
      const ul = id => snap(Math.max(0, MAP07.tileColor(0, id)));
      const f0 = P.ulRest ? clamp(0.84 + (P.ulShare - 0.5) * 0.6, 0.3, 0.97) : 1;   // how much of the country syGround leaves in its main underlay
      const land = syCum([[ul(P.ul0), f0]].concat(P.ulRest ? P.ulRest.e.map(e => [ul(e[0]), e[1] / P.ulRest.s * (1 - f0)]) : []));
      return { land, shore: P.shore ? syCum(P.shore.e.map(e => [ul(e[0]), e[1]])) : land, hi: P.hi ? syCum(P.hi.e.map(e => [ul(e[0]), e[1]])) : null,
        road: snap(Math.max(0, MAP07.tileColor(P.path, 0))), town: B.town && B.town.length ? B.town[0][0] : snap(Math.max(0, MAP07.tileColor(P.path, 0))) };
    }) };
  return SYM.pal;
}
/* one piece: 64 pixels square, tpp tiles a pixel, its pixel (i, j) the tiles from (tx*64 + i) tpp east and (tz*64 + j) tpp south.
   fine: a tile a pixel in the tiles' own colours; else the map picture's colours */
function syMapTile(tx, tz, tpp, fine) {
  const K = fine ? 2 : 1, N = 64 * K, cv = document.createElement('canvas'); cv.width = cv.height = N;   // a fine piece is two pixels a tile, room for the walls
  const g = cv.getContext('2d'), im = g.createImageData(N, N), d = im.data, ox = tx * 64 * tpp, oz = tz * 64 * tpp, span = 64 * tpp;
  const put = (p, c, k) => { d[p] = (c >> 16 & 255) * k; d[p + 1] = (c >> 8 & 255) * k; d[p + 2] = (c & 255) * k; d[p + 3] = 255; };
  const cities = tpp <= 32 ? citiesIn(ox - 0.5, oz - 0.5, ox + span, oz + span).map(syCity) : [];
  cv.prov = 0;
  if (fine) {
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) { const c = syGroundRGB(ox + i, -(oz + j), 0); SYM_B[j * 64 + i] = _syo[2] & 1; for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) put(((j * 2 + b) * N + i * 2 + a) * 4, c, 1); }
    for (const C of cities) if (!syMapCity(C, ox, oz, 1, 2, d, N, (px, py) => SYM_B[py * 64 + px])) cv.prov = 1;
    g.putImageData(im, 0, 0);
    for (const C of cities) if (C.T) syMapCityWalls(C, ox, oz, g);
    return cv;
  }
  const pal = SYM.pal, half = (tpp - 1) / 2, Mh = SYM_M, B = SYM_B;
  const CB = tpp >= 4 ? cities.map(C => { const e = C.R * EXT_MAX; return [C, C.gx - e, C.gx + e, C.gy - e, C.gy + e]; }) : [];
  /* the field with a pixel's ring round it (coasts, shading): at every pixel while a river is a pixel or two wide, else on a
     lattice of 2 or 4 pixels with bilinear between, which also draws the coast as a smooth line instead of a speckle */
  const st = tpp <= 2 ? 1 : tpp <= 8 ? 2 : 4, n = 64 / st + 3, G = SYM_G;
  for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) G[b * n + a] = macroHeight(ox + (a - 1) * st * tpp + half, oz + (b - 1) * st * tpp + half);
  for (let j = -1; j <= 64; j++) {
    const fj = (j + st) / st, b0 = Math.floor(fj), vj = fj - b0;
    for (let i = -1; i <= 64; i++) {
      const fi = (i + st) / st, a0 = Math.floor(fi), vi = fi - a0, r0 = b0 * n + a0, r1 = r0 + n;
      const p = G[r0] + (G[r0 + 1] - G[r0]) * vi, q = vj ? G[r1] + (G[r1 + 1] - G[r1]) * vi : p;
      Mh[(j + 1) * 66 + i + 1] = p + (q - p) * vj;
    }
  }
  /* the countries on a 4-pixel lattice, asked again pixel by pixel only where its corners disagree (a border) */
  const L = SYM_L, bioAt = (i, j) => syBioAt(ox + i * tpp + half, -(oz + j * tpp + half));
  for (let b = 0; b < 17; b++) for (let a = 0; a < 17; a++) L[b * 17 + a] = bioAt(a * 4, b * 4);
  for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
    const a = i >> 2, b = j >> 2, c0 = L[b * 17 + a];
    B[j * 64 + i] = c0 === L[b * 17 + a + 1] && c0 === L[(b + 1) * 17 + a] && c0 === L[(b + 1) * 17 + a + 1] ? c0 : tpp <= 16 ? bioAt(i, j) : L[((j + 2) >> 2) * 17 + ((i + 2) >> 2)];
  }
  const fq = 1 / Math.max(28, tpp * 4), isSea = (m, b) => m < SEA && !(b === SY_WILD && m > -4) && !(b === 3 && m > -2.5);   // clumps of a few dozen tiles, never under four pixels (a speckle is no map)
  for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
    const p = (j * 64 + i) * 4, c = (j + 1) * 66 + i + 1, m = Mh[c], b = B[j * 64 + i], P = pal.bio[b];
    const wx = ox + i * tpp + half, wz = oz + j * tpp + half;
    if (m < SEA) {
      if (b === SY_WILD && m > -4) put(p, tpp <= 8 && (Mh[c - 1] >= SEA || Mh[c + 1] >= SEA || Mh[c - 66] >= SEA || Mh[c + 66] >= SEA) ? pal.lavaRim : pal.lavaIn, 1);   // the wilds' shallows are lava: dark, rimmed in fire as the picture draws it (not on a coarse piece, which shows magnified)
      else if (b === 3 && m > -2.5) put(p, syPick(P.shore, 0.5)[0], 0.85);   // the mire's swamp
      else put(p, pal.sea, 1);
      continue;
    }
    const u = clamp(0.5 + noise2(wx * fq, wz * fq, S + 990) * 0.9, 0, 0.999), yT = syY(m);
    const coast = isSea(Mh[c - 1], b) || isSea(Mh[c + 1], b) || isSea(Mh[c - 66], b) || isSea(Mh[c + 66], b);
    const T = P.hi && yT > 8 && 0.5 + noise2(wx * fq * 1.7, wz * fq * 1.7, S + 993) * 0.9 < smoothstep(8, 12.5, yT) ? P.hi : coast || m < 1.1 ? P.shore : P.land;   // the rock line in clumps too
    const sl = (syY(Mh[c - 1]) - syY(Mh[c + 1]) + syY(Mh[c - 66]) - syY(Mh[c + 66])) / (2 * tpp);   // the light from the north-west, as the picture's relief
    let col = syPick(T, u)[0];
    for (const [C, xa, xb, ya, yb] of CB) {   // a city far out: the picture's town colour over its outline, its avenues ruled across it
      const gx = Math.floor(wx), gy = -Math.floor(wz);
      if (gx < xa || gx > xb || gy < ya || gy > yb || !cityHolds(C.v, wx, wz)) continue;
      const w = Math.max(C.AW, tpp);
      col = tpp <= 8 && (syMod(gx - C.gx, C.AV) < w || syMod(gy - C.gy, C.AV) < w) ? pal.bio[C.b].road : pal.bio[C.b].town;
      break;
    }
    put(p, col, clamp(1 + sl * 0.9, 0.82, 1.18));
  }
  for (const C of cities) if (tpp <= 2 && !syMapCity(C, ox, oz, tpp, 1, d, N, (px, py) => Mh[(py + 1) * 66 + px + 1] < SEA)) cv.prov = 1;   // closer in, its streets and its buildings' floors
  g.putImageData(im, 0, 0);
  const X0 = ox - 0.5, Z0 = oz - 0.5;   // world to pixel: (x - X0) / tpp
  if (tpp <= 16) {   // the highways, a line each, in the paving the country's roads wear on the picture
    g.lineCap = 'round';
    for (let cx = Math.floor((ox - 8) * INV_CELL); cx <= Math.floor((ox + span + 8) * INV_CELL); cx++)
      for (let cz = Math.floor((oz - 8) * INV_CELL); cz <= Math.floor((oz + span + 8) * INV_CELL); cz++)
        for (const r of cellRoads(cx, cz)) {
          if (r.hi < ox - 4 || r.lo > ox + span + 4 || r.zh < oz - 4 || r.zl > oz + span + 4) continue;
          const mx = (r.x0 + r.x1) / 2, mz = (r.z0 + r.z1) / 2;
          if (g7In(mx, mz) || macroHeight(mx, mz) < -3.5) continue;   // no causeway crosses deep water
          g.strokeStyle = syCss(pal.bio[syBioAt(mx, -mz)].road); g.lineWidth = Math.max(1, r.w * 1.4 / tpp);
          g.beginPath(); g.moveTo((r.x0 - X0) / tpp, (r.z0 - Z0) / tpp); g.lineTo((r.x1 - X0) / tpp, (r.z1 - Z0) / tpp); g.stroke();
        }
  }
  if (tpp >= 4 && tpp <= 32) {   // the towns as the picture's grey-brown blocks (under a pixel further out); closer in their own plans are laid over instead (syMapTown)
    for (let cx = Math.floor((ox - 100) * INV_CELL); cx <= Math.floor((ox + span + 100) * INV_CELL); cx++)
      for (let cz = Math.floor((oz - 100) * INV_CELL); cz <= Math.floor((oz + span + 100) * INV_CELL); cz++) {
        const v = villageAt(cx, cz);
        if (!v || v.sprawl || g7Out(v.x, v.z) < 200) continue;   // a city is drawn with the ground above
        g.fillStyle = syCss(pal.bio[syBioAt(v.x, -v.z)].town);
        g.beginPath(); g.arc((v.x - X0) / tpp, (v.z - Z0) / tpp, Math.max(1.2, Math.max(16, v.r * 0.92) * 0.7 / tpp), 0, TAU); g.fill();
      }
  }
  return cv;
}
/* a city into a piece's pixels (K a tile, tpp tiles a pixel): its paving and its buildings' floors, as its squares lay them.
   false while its buildings are still on their way (the piece is painted again when they come) */
function syMapCity(C, ox, oz, tpp, K, d, N, wet) {   // wet(px, py): the piece's own water, already known from its ground
  if (!syCityOK(C)) { syCityReady(C).then(syMapFresh, () => {}); return false; }
  const v = C.v, AV = C.AV, AW = C.AW, e = C.R * EXT_MAX + 2, span = 64 * tpp, lane = MAP07.tileColor(C.lane, 0);
  const pa = Math.max(0, Math.floor((C.gx - e - ox) / tpp)), pb = Math.min(63, Math.ceil((C.gx + e - ox) / tpp));
  const ra = Math.max(0, Math.floor((-(C.gy + e) - oz) / tpp)), rb = Math.min(63, Math.ceil((-(C.gy - e) - oz) / tpp));
  let bi = 1e9, bj = 1e9, B = null;
  for (let py = ra; py <= rb; py++) for (let px = pa; px <= pb; px++) {
    const gx = ox + px * tpp, gy = -(oz + py * tpp);
    if (!cityHolds(v, gx, -gy)) continue;
    const i = Math.floor((gx - C.gx) / AV), j = Math.floor((gy - C.gy) / AV);
    if (i !== bi || j !== bj) { bi = i; bj = j; B = syCityBlock(C, i, j); }
    let c = -1;
    for (const p of B.parcels) {
      if (gx < p.x0 || gx > p.x1 || gy < p.y0 || gy > p.y1) continue;
      const T = p.t, x = gx - p.x0, y = gy - p.y0;
      for (let pl = 0; pl < Math.min(2, T.p) && c < 0; pl++) { const r = ((pl * T.w + x) * T.l + y) * 8; c = MAP07.tileColor(T.dv.getUint16(r + 2, true), T.dv.getUint16(r, true)); }
      if (c < 0) c = -2;
      break;
    }
    if (c === -1 && lane >= 0) {
      let paved = syMod(gx - C.gx, AV) < AW || syMod(gy - C.gy, AV) < AW || syInPlaza(C, gx, gy, 0);
      if (!paved) for (const r of B.streets) if (gx >= r[0] && gx <= r[2] && gy >= r[1] && gy <= r[3]) { paved = true; break; }
      if (paved && !wet(px, py)) c = lane;
    }
    if (c < 0) continue;
    for (let b = 0; b < K; b++) for (let a = 0; a < K; a++) { const o = ((py * K + b) * N + px * K + a) * 4; d[o] = c >> 16 & 255; d[o + 1] = c >> 8 & 255; d[o + 2] = c & 255; d[o + 3] = 255; }
  }
  return true;
}
function syMapCityWalls(C, ox, oz, g) {   // a fine piece's walls in white, two pixels a tile
  const AV = C.AV, i0 = Math.floor((ox - 1 - C.gx) / AV), i1 = Math.floor((ox + 64 - C.gx) / AV), j0 = Math.floor((-(oz + 64) - C.gy) / AV), j1 = Math.floor((-oz + 1 - C.gy) / AV), e = Math.ceil(C.R * EXT_MAX / AV) + 1;
  g.fillStyle = 'rgba(238,238,238,0.9)';
  for (let i = Math.max(i0, -e); i <= Math.min(i1, e); i++) for (let j = Math.max(j0, -e); j <= Math.min(j1, e); j++) {
    for (const p of syCityBlock(C, i, j).parcels) {
      if (p.x1 < ox || p.x0 >= ox + 64 || p.y1 < -(oz + 63) || p.y0 > -oz) continue;
      const Ls = p.t.L;
      for (let q = 0; q < Ls.length; q += 6) {
        const type = Ls[q + 1];
        if (Ls[q + 5] !== 0 || (type !== 0 && type !== 2)) continue;
        const X = (p.x0 + Ls[q + 3] - ox) * 2, Y = (-(p.y0 + Ls[q + 4]) - oz) * 2;
        if (X < -2 || Y < -2 || X > 128 || Y > 128) continue;
        const edge = r => r === 0 ? g.fillRect(X, Y, 1, 2) : r === 1 ? g.fillRect(X, Y, 2, 1) : r === 2 ? g.fillRect(X + 1, Y, 1, 2) : g.fillRect(X, Y + 1, 2, 1);
        edge(Ls[q + 2]); if (type === 2) edge((Ls[q + 2] + 1) & 3);
      }
    }
  }
}
function syMapFresh() { for (const k of SYM.prov) wmTiles.delete(k); SYM.prov.clear(); wmDirty = 1; }   // a city's buildings came: its pieces painted without them go again
/* a town's plan for the world map, built once its buildings are laid out (syTown): { cv, x0, y1, W, L, icons } or null */
function syMapTown(v) {
  const key = Math.round(v.x) + ':' + Math.round(v.z);
  let e = SYM.towns.get(key);
  if (e) { SYM.towns.delete(key); SYM.towns.set(key, e); return e.cv ? e : null; }
  if (SYM.jobs >= 2) return null;   // two towns a time: a new country's buildings arrive with its first
  e = { cv: null };
  SYM.towns.set(key, e); SYM.jobs++;
  if (SYM.towns.size > 72) SYM.towns.delete(SYM.towns.keys().next().value);
  syTown(v).then(t => {
    const sv = SEAM; SEAM = 1;
    try { Object.assign(e, syTownCanvas(t)); } finally { SEAM = sv; }
    wmDirty = 1;
  }, () => { SYM.towns.delete(key); }).then(() => { SYM.jobs--; });
  return null;
}
function syTownCanvas(t) {   // two pixels a tile, as map07's squareCanvas draws a real square: floors, then walls in white
  const R = Math.ceil(t.r) + 1;
  let x0 = t.gx - R, x1 = t.gx + R, y0 = t.gy - R, y1 = t.gy + R;
  for (const s of t.stamps) { x0 = Math.min(x0, s.x0); x1 = Math.max(x1, s.x1); y0 = Math.min(y0, s.y0); y1 = Math.max(y1, s.y1); }
  const W = x1 - x0 + 1, L = y1 - y0 + 1, cv = document.createElement('canvas');
  cv.width = W * 2; cv.height = L * 2;
  const g = cv.getContext('2d'), im = g.createImageData(cv.width, cv.height), d = im.data;
  const put = (gx, gy, c) => { const X = (gx - x0) * 2, Y = (y1 - gy) * 2; for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) { const o = ((Y + b) * cv.width + X + a) * 4; d[o] = c >> 16 & 255; d[o + 1] = c >> 8 & 255; d[o + 2] = c & 255; d[o + 3] = 255; } };
  const lane = MAP07.tileColor(t.lane, 0);
  if (lane >= 0) for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {   // the square and its two lanes, as sySquare paves them
    const d2 = dx * dx + dy * dy;
    if (d2 > t.r * t.r || !((Math.abs(dx) <= t.heart && Math.abs(dy) <= t.heart) || ((dx === 0 || dx === 1 || dy === 0 || dy === 1) && d2 < t.r * t.r * 0.8))) continue;
    if (syField(t.gx + dx, t.gy + dy) >= SEA) put(t.gx + dx, t.gy + dy, lane);
  }
  const icons = [];
  for (const s of t.stamps) {
    const T = s.t;
    for (let x = 0; x < T.w; x++) for (let y = 0; y < T.l; y++) {
      let c = -1;
      for (let p = 0; p < Math.min(2, T.p) && c < 0; p++) { const r = ((p * T.w + x) * T.l + y) * 8; c = MAP07.tileColor(T.dv.getUint16(r + 2, true), T.dv.getUint16(r, true)); }
      if (c >= 0) put(s.x0 + x, s.y0 + y, c);
    }
    for (let q = 0; q < T.I.length; q += 3) {   // one of a kind to a few tiles: a town's two anvils are one smithing mark
      const e = [T.I[q], s.x0 + T.I[q + 1], s.y0 + T.I[q + 2]];
      if (!icons.some(o => o[0] === e[0] && Math.abs(o[1] - e[1]) + Math.abs(o[2] - e[2]) < 10)) icons.push(e);
    }
  }
  g.putImageData(im, 0, 0);
  g.fillStyle = 'rgba(238,238,238,0.9)';
  for (const s of t.stamps) {
    const Ls = s.t.L;
    for (let q = 0; q < Ls.length; q += 6) {
      const type = Ls[q + 1];
      if (Ls[q + 5] !== 0 || (type !== 0 && type !== 2)) continue;
      const X = (s.x0 + Ls[q + 3] - x0) * 2, Y = (y1 - (s.y0 + Ls[q + 4])) * 2;
      const edge = r => r === 0 ? g.fillRect(X, Y, 1, 2) : r === 1 ? g.fillRect(X, Y, 2, 1) : r === 2 ? g.fillRect(X + 1, Y, 1, 2) : g.fillRect(X, Y + 1, 2, 1);
      edge(Ls[q + 2]); if (type === 2) edge((Ls[q + 2] + 1) & 3);
    }
  }
  return { cv, x0, y1, W, L, icons };
}
/* the layer: pieces, town plans, icons, names. px/pz map world x/z to the canvas, s its pixels a tile */
function syMapLayer(W, H, s, px, pz) {
  const pal = syMapPal();
  wmCtx.fillStyle = syCss(pal ? pal.sea : 0x4f628e); wmCtx.fillRect(0, 0, W, H);   // the picture's sea under all of it
  if (!pal) { wmDirty = 1; return; }
  const t0 = performance.now(), fine = wmZoom >= 12, tpp = fine ? 1 : clamp(2 ** Math.round(Math.log2(1 / s)), 1, 64), span = 64 * tpp, size = span * s;
  const hx = W / 2 / s, hz = H / 2 / s, key = (f, t, x, z) => 'y' + f + t + ':' + x + ':' + z;
  const need = [], anc = new Map();
  for (let tz = Math.floor((wmCz - hz + 0.5) / span); tz <= Math.floor((wmCz + hz + 0.5) / span); tz++)
    for (let tx = Math.floor((wmCx - hx + 0.5) / span); tx <= Math.floor((wmCx + hx + 0.5) / span); tx++) {
      if (g7In(tx * span, tz * span) && g7In((tx + 1) * span - 1, (tz + 1) * span - 1)) continue;   // wholly under Gielinor's own map
      const L = px(tx * span - 0.5), T = pz(tz * span - 0.5), k = key(fine ? 'f' : 'c', tpp, tx, tz), c = wmTiles.get(k);
      if (c) { wmTiles.delete(k); wmTiles.set(k, c); wmCtx.drawImage(c, Math.floor(L), Math.floor(T), Math.ceil(size) + 1, Math.ceil(size) + 1); continue; }
      const dist = Math.hypot((tx + 0.5) * span - wmCx, (tz + 0.5) * span - wmCz);
      need.push([fine ? 'f' : 'c', tpp, tx, tz, dist]);
      let shown = 0;
      for (let lv = fine ? 0 : 1; lv <= 9 && !shown; lv++) {   // the nearest coarser piece that is made, its part under this one
        const q = 1 << lv, ax = Math.floor(tx / q), az = Math.floor(tz / q), pc = wmTiles.get(key('c', tpp * q, ax, az));
        if (!pc) continue;
        const sub = 64 / q;
        wmCtx.drawImage(pc, (tx - ax * q) * sub, (tz - az * q) * sub, sub, sub, Math.floor(L), Math.floor(T), Math.ceil(size) + 1, Math.ceil(size) + 1);
        shown = 1;
      }
      if (!shown) { const ax = Math.floor(tx / 8), az = Math.floor(tz / 8), ak = key('c', tpp * 8, ax, az); if (!anc.has(ak)) anc.set(ak, ['c', tpp * 8, ax, az, dist]); }
    }
  const jobs = [...anc.values()].sort((a, b) => a[4] - b[4]).concat(need.sort((a, b) => a[4] - b[4]));
  for (let i = 0; i < jobs.length && (i === 0 || performance.now() - t0 < 6); i++) {   // a hole's ancestor first (one covers 64 of them), then the view nearest first
    const [f, T2, tx, tz] = jobs[i], k = key(f, T2, tx, tz), c = syMapTile(tx, tz, T2, f === 'f');
    wmTiles.set(k, c);
    if (c.prov) SYM.prov.add(k);   // painted before a city's buildings came: again when they do
  }
  if (jobs.length) wmDirty = 1;
  if (wmTiles.size > SYM_TILES) { let n = wmTiles.size - SYM_TILES + 200; for (const k of wmTiles.keys()) { if (k[0] !== 'y') continue; wmTiles.delete(k); if (--n <= 0) break; } }   // the least lately seen go
  /* the towns' own plans, close enough to read a street */
  const cells = (cell, pad, f) => { for (let a = Math.floor((wmCx - hx - pad) / cell); a <= Math.floor((wmCx + hx + pad) / cell); a++) for (let b = Math.floor((wmCz - hz - pad) / cell); b <= Math.floor((wmCz + hz + pad) / cell); b++) f(a, b); };
  const plans = [];
  if (tpp <= 2) cells(SETTLE_CELL, 120, (a, b) => {
    const v = villageAt(a, b);
    if (!v || v.sprawl || g7Out(v.x, v.z) < 200) return;   // a city's plan is in the pieces themselves
    const R = Math.max(16, v.r * 0.92) + 12;
    if (px(v.x + R) < 0 || px(v.x - R) > W || pz(v.z + R) < 0 || pz(v.z - R) > H) return;
    const e = syMapTown(v);
    if (!e) { wmDirty = 1; return; }
    wmCtx.drawImage(e.cv, px(e.x0 - 0.5), pz(-e.y1 - 0.5), e.W * s, e.L * s);
    plans.push(e);
  });
  /* the map-function icons: the towns' buildings' own, then the mines, rare trees and shoals at the icons the real map gives them */
  const icon = (area, x, y) => {
    if (x < -12 || y < -12 || x > W + 12 || y > H + 12 || typeof c7IconImg !== 'function' || area < 0) return;
    const im = c7IconImg(area);
    if (im) wmCtx.drawImage(im, Math.round(x - im.width / 2), Math.round(y - im.height / 2)); else if (im === null) wmDirty = 1;
  };
  if (wmZoom >= 3) {
    for (const e of plans) for (const [area, gx, gy] of e.icons) icon(area, px(gx), pz(-gy));
    if (wmZoom >= 8) {   // a city's banks, shops, altars and anvils: the icons its buildings carry, one of a kind a block (each building's own closer in), a few blocks planned a frame
      let cb = 24;
      const each = wmZoom >= 24;
      for (const v of citiesIn(wmCx - hx, wmCz - hz, wmCx + hx, wmCz + hz)) {
        const C = syCity(v);
        if (!syCityOK(C)) { syCityReady(C).then(() => { wmDirty = 1; }, () => {}); continue; }
        const e = Math.ceil(C.R * EXT_MAX / C.AV) + 1;
        for (let i = Math.max(-e, Math.floor((wmCx - hx - C.gx) / C.AV)); i <= Math.min(e, Math.floor((wmCx + hx - C.gx) / C.AV)); i++)
          for (let j = Math.max(-e, Math.floor((-(wmCz + hz) - C.gy) / C.AV)); j <= Math.min(e, Math.floor((-(wmCz - hz) - C.gy) / C.AV)); j++) {
            if (!SYC.blocks.has(C.key + ':' + i + ':' + j) && --cb < 0) { wmDirty = 1; continue; }
            let seen = [];
            for (const p of syCityBlock(C, i, j).parcels) {
              if (p.t.k === 'house') continue;
              if (each) seen = [];
              const I = p.t.I;
              for (let q = 0; q < I.length; q += 3) if (!seen.includes(I[q])) { seen.push(I[q]); icon(I[q], px(p.x0 + I[q + 1]), pz(-(p.y0 + I[q + 2]))); }
            }
          }
      }
    }
    const IC = SY.data.icons || {};
    let bud = 60;
    if (wmZoom >= 5) cells(SITE_CELL, 0, (a, b) => {
      if (!siteCache.has(a * 8191 + b) && --bud < 0) { wmDirty = 1; return; }   // an unsurveyed cell costs a survey: sixty a frame
      const st = siteAt(a, b);
      if (st && st.t === 1) icon(IC.mine, px(st.x), pz(st.z));
      else if (st && st.t === 2 && st.gk >= 4) icon(IC.tree, px(st.x), pz(st.z));
    });
    if (wmZoom >= 8) cells(FISH_CELL, 0, (a, b) => {
      if (!fishCache.has(a * 8191 + b) && --bud < 0) { wmDirty = 1; return; }
      const f = fishCellAt(a, b);
      if (f && g7Out(f.x, f.z) > 64) icon(IC.fish, px(f.x), pz(f.z));
    });
  }
  /* names, none over another: the kingdoms far out, the cities, then every town */
  const used = [], label = (txt, x, y, font, fill, room) => {   // room: the clear space a name keeps round it, a share of its size
    wmCtx.font = font;
    const w = (wmCtx.measureText(txt).width + 6) * (room || 1), h = (parseInt(font.match(/(\d+)px/)[1], 10) + 4) * (room || 1);
    if (x + w / 2 < 0 || x - w / 2 > W || y + h < 0 || y - h > H) return;
    for (const r of used) if (x - w / 2 < r[2] && x + w / 2 > r[0] && y - h / 2 < r[3] && y + h / 2 > r[1]) return;
    used.push([x - w / 2, y - h / 2, x + w / 2, y + h / 2]);
    wmCtx.strokeText(txt, x, y); wmCtx.fillStyle = fill; wmCtx.fillText(txt, x, y);
  };
  wmCtx.textAlign = 'center'; wmCtx.textBaseline = 'middle'; wmCtx.lineJoin = 'round';
  if (wmZoom >= 1.2) {
    const fs = Math.round(clamp(9 + wmZoom * 0.4, 10, 16)), all = wmZoom >= 2.5, list = [];
    wmCtx.lineWidth = 3; wmCtx.strokeStyle = 'rgba(0,0,0,.85)';
    cells(SETTLE_CELL, 40, (a, b) => { const v = villageAt(a, b); if (v && (all || v.rank >= 2) && g7Out(v.x, v.z) >= 200) list.push(v); });
    list.sort((p, q) => q.rank - p.rank);   // a city keeps its name where a hamlet's would overlap it
    for (const v of list) label(villageName(v), px(v.x), pz(v.z), 'bold ' + fs + 'px system-ui, sans-serif', v.rank >= 3 ? '#ffd34a' : '#f4ead0');
  }
  if (wmZoom < 2.2) {
    const fs = Math.round(clamp(13 + wmZoom * 4, 14, 22));
    wmCtx.lineWidth = 4; wmCtx.strokeStyle = 'rgba(8,12,16,0.5)';
    cells(REG_CELL, 400, (a, b) => {
      if (b * REG_CELL > 499000) return;
      const r = regSite(a, b);
      if (g7Out(r.x, r.z) < 200) return;   // no kingdom of the seed's is named over Gielinor
      label(regionName(r), px(r.x), pz(r.z), '600 ' + fs + 'px system-ui, sans-serif', 'rgba(240,232,206,0.8)', 1.8);
    });
  }
}
/* map07's source for the squares past the rectangle */
const syProvider = { has: rid => !!SY.data, square: sySquare };
