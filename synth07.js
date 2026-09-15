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
        npc: (b.npc || []).slice().sort((a, c) => a[1] - c[1]), folk: syCum(b.folk && b.folk.length ? b.folk : j.bio.meadows.folk), td: (REG.find(r => r.k === k) || REG[0]).td };
    });
    SY.data = { bio, ores: j.ores, trees: j.trees, fish: j.fish || [], lava: j.lava || 19, swamp: j.swamp || 7, stack: j.stack || {}, tplKinds: j.tpl };
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
      const T = { k: t.k, w: t.w, l: t.l, p: t.p, g, dv: new DataView(g.buffer), L: t.L, N: t.N }, cx = Math.floor(t.o[0] / 384), cy = Math.floor(t.o[1] / 384), ck = cx + ':' + cy;
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
/* the ground under a tile: the seed's field, flattened onto its town's table as the seed does */
function syField(gx, gy) {
  const z = -gy;
  let m = macroHeight(gx, z);
  const n = nearVillage(gx, z);
  if (n) { const flat = 1 - smoothstep(0.98, 1.4, n.d / n.v.r); m += (n.v.y - m) * flat; }
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
async function syTownsNear(bx, by) {   // the towns whose tables reach this square
  const out = [], seen = new Set();
  for (const gx of [bx - 180, bx + 32, bx + 244]) for (const gy of [by - 180, by + 32, by + 244]) {
    const cx = Math.floor(gx * INV_CELL), cz = Math.floor(-gy * INV_CELL), k = cx + ':' + cz;
    if (seen.has(k)) continue;
    seen.add(k);
    const v = villageAt(cx, cz);
    if (!v || g7Out(v.x, v.z) < 200) continue;
    const t = await syTown(v);
    if (t.gx + t.r + 40 < bx || t.gx - t.r - 40 > bx + 64 || t.gy + t.r + 40 < by || t.gy - t.r - 40 > by + 64) continue;
    out.push(t);
  }
  return out;
}
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
  const o = [0, 0, 0];
  for (let x = 0; x < 64; x++) {
    for (let y = 0; y < 64; y++) {
      const gx = bx + x, gy = by + y, i = x * 64 + y, fx = x / 4, fy = y / 4, i0 = Math.min(15, fx | 0), j0 = Math.min(15, fy | 0), tx = fx - i0, ty = fy - j0;
      const a = G[j0 * 17 + i0] + (G[j0 * 17 + i0 + 1] - G[j0 * 17 + i0]) * tx, c = G[(j0 + 1) * 17 + i0] + (G[(j0 + 1) * 17 + i0 + 1] - G[(j0 + 1) * 17 + i0]) * tx;
      let m = a + (c - a) * ty;
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
  /* towns: streets, the open square, then the buildings over them */
  const towns = await syTownsNear(bx, by);
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
  const fits = (x, y, w, l) => { if (x + w > 64 || y + l > 64) return false; for (let a = 0; a < w; a++) for (let c = 0; c < l; c++) { const j = (x + a) * 64 + y + c; if (occ[j] || OL[j] || FL[j] & 1 || inTown[j]) return false; } return true; };
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
  for (let x = 0; x < 64; x++) {
    for (let y = 0; y < 64; y++) {
      const i = x * 64 + y;
      if (occ[i] || OL[i] || FL[i] & 1 || inTown[i]) continue;
      const gx = bx + x, gy = by + y, P = D.bio[BI[i]], m = M[i];
      if (m < 0.9) continue;
      /* woods and clearings: the real country's own density of trees and scenery a tile, gathered by a slow field into stands
         and glades (its mean stays the measured one), and its ground cover a little thinner where the trees stand thick */
      const grove = clamp(0.9 + noise2(gx * 0.021, gy * 0.021, S + 931) * 1.5 + biomeAt(gx, -gy) * 0.3, 0, 2.4);
      const slope = Math.abs(H[i] - H[Math.min(4095, i + 65)]);
      if (P.scen && slope < 160 && syU(gx, gy, 932) < P.dens[0] * grove) {
        const e = syPick(P.scen, syU(gx, gy, 933));
        if (e && fits(x, y, e[2], e[3])) {
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
  const wildSq = BI[32 * 64 + 32] === SY_WILD, nMon = 2 + ((hash2(sqX, sqY, S + 980) >>> 0) % 4) + (wildSq ? 3 : 0);
  for (let k = 0; k < nMon; k++) {
    const hh = hash2(sqX * 31 + k, sqY * 17 - k, S + 981) >>> 0, x = 4 + hh % 56, y = 4 + (hh >>> 8) % 56, i = x * 64 + y;
    if (occ[i] || FL[i] & 1 || OL[i] || inTown[i] || M[i] < 0.9) continue;
    const gx = bx + x, gy = by + y, P = D.bio[BI[i]], pw = Math.max(0, powerAt(gx, -gy)), L = clamp(3 + pw * 18, 1, 150);
    if (!P.npc.length) continue;
    let best = null, bw = 0;
    for (const e of P.npc) { const f = e[1] / L, w = f < 0.45 || f > 1.7 ? 0 : e[2] * (1 - Math.abs(Math.log(f)) * 0.8); if (w > 0 && syU(gx + e[0], gy, 982) * w > bw) { bw = syU(gx + e[0], gy, 982) * w; best = e; } }
    if (!best) best = P.npc.reduce((q, e) => Math.abs(e[1] - L) < Math.abs(q[1] - L) ? e : q, P.npc[0]);
    for (let q = 0, n = 1 + ((hh >>> 16) % 3); q < n; q++) spawns.push({ id: best[0], x: gx + (((hh >>> (20 + q * 2)) & 3) - 1), y: gy + (((hh >>> (26 + q * 2)) & 3) - 1), plane: 0 });
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
/* the colour of a tile on the minimaps and the world map, without its scenery (memoised by tile) */
const _syo = [0, 0, 0];
function syTileRGB(gx, gy) {
  if (!SY.data) return 0x0c1016;
  const key = tk(gx, -gy);
  let c = SY.rgb.get(key);
  if (c !== undefined) return c;
  const m = syField(gx, gy), b = syBioAt(gx, gy), mm = syGround(gx, gy, m, b, _syo);
  let ol = _syo[1];
  if (!(_syo[2] & 1)) { const n = nearVillage(gx, -gy); if (n && n.d < Math.max(4, n.v.r * 0.25)) ol = SY.data.bio[b].path; }
  c = MAP07.tileColor(ol, _syo[0]);
  if (c < 0) c = 0x0c1016;
  else if (!(_syo[2] & 1)) { const k = 0.9 + Math.min(0.25, syY(mm) * 0.02); c = ((Math.min(255, (c >> 16 & 255) * k)) << 16) | ((Math.min(255, (c >> 8 & 255) * k)) << 8) | Math.min(255, (c & 255) * k); }
  capMap(SY.rgb, 80000); SY.rgb.set(key, c);
  return c;
}
/* map07's source for the squares past the rectangle */
const syProvider = { has: rid => !!SY.data, square: sySquare };
