"use strict";
/* ---- content07.js: GIELINOR, BUILT OUT --------------------------------------------------------------------------------
   What the 2007 map carries in its own cache beyond the ground itself, wired to this game. Loaded after game.js and sharing
   its globals; every call from game.js checks M7 (and that this file is up) first, so the seeded worlds never see it.
   The tables come from tools/bake07 as small JSON in assets/map07 (this site, one request each, fetched the first time a
   feature asks), the models, frames, sprites and configs from the R2 tree through OSRSK/MAP07/OSUI as everything else.
     49a  loaders and the saved state (quest stages, music unlocks, the cache slayer task and clue trail)
     49b  dialogue: the chatbox conversation with the npc's own chat head
     49c  the player's own 2007 animations, and the emotes
     49d  monsters: attack, flinch and death from the cache; spell and arrow graphics
     49e  the maps: function icons, scene sprites, dungeon pictures; the animated scenery's clock
   content07b.js carries the quests, slayer, clues, travel, music and skill guides. ---- */

/* ---- 49a. loaders and state ---- */
const C7J = new Map(), C7T = Object.create(null);
function c7Json(name) {
  let p = C7J.get(name);
  if (!p) {
    p = fetch(OSRSK.SITE + 'assets/map07/' + name).then(r => r.ok ? r.json() : Promise.reject(new Error(name + ' ' + r.status))).then(j => (C7T[name] = j));
    C7J.set(name, p); p.catch(() => C7J.delete(name));
  }
  return p;
}
const c7Get = name => C7T[name] || (c7Json(name), null);   /* the table if it is in, else null (and it is on its way) */
const C7_ITEM = new Map();
function c7Item(name) {   /* this game's item id for a cache item name, or null */
  if (!C7_ITEM.size) for (const id in ITEMS) { const k = ITEMS[id].name.toLowerCase(); if (!C7_ITEM.has(k)) C7_ITEM.set(k, id); }
  return C7_ITEM.get(String(name).toLowerCase()) || null;
}
/* Gielinor progress rides the save as one small field: quest stages as id,stage pairs, the music unlocks as a bitset over
   music.json's order, the cache slayer task and the clue trail. The 8 KB blob holds a whole bank, so every byte counts. */
const G7 = { q: Object.create(null), mu: new Set(), sl: null, clue: null };
function c7Pack() {
  const q = [];
  for (const k in G7.q) q.push(+k, G7.q[k]);
  let mu = '';
  if (G7.mu.size) { const n = Math.max(...G7.mu) + 1, b = new Uint8Array((n + 7) >> 3); for (const i of G7.mu) b[i >> 3] |= 1 << (i & 7); mu = btoa(String.fromCharCode(...b)); }
  return { q, mu, sl: G7.sl || 0, cl: G7.clue || 0 };
}
function c7Unpack(g) {
  G7.q = Object.create(null); G7.mu = new Set(); G7.sl = null; G7.clue = null;
  if (!g || typeof g !== 'object') return;
  const q = Array.isArray(g.q) ? g.q : [];
  for (let i = 0; i + 1 < q.length; i += 2) if ((q[i + 1] | 0) > 0) G7.q[q[i] | 0] = q[i + 1] | 0;
  if (typeof g.mu === 'string' && g.mu) { try { const s = atob(g.mu); for (let i = 0; i < s.length; i++) for (let k = 0; k < 8; k++) if (s.charCodeAt(i) >> k & 1) G7.mu.add(i * 8 + k); } catch {} }
  if (Array.isArray(g.sl) && g.sl.length === 3) G7.sl = g.sl.map(v => v | 0);
  if (Array.isArray(g.cl) && g.cl.length >= 5) G7.clue = g.cl.map(v => v | 0);
}

/* ---- 49b. dialogue ----
   The 2007 chatbox conversation: the speaker's chat head on its side, the name, the words centred, "Click here to continue";
   an option list under "Select an Option". In the 2007 frame it is drawn with the client's own fonts over the chatbox; with
   the game's own panels it is an html box over the chat log. Space continues, 1-5 pick. An npc's head is its def's chathead
   models rendered once into a small picture (one draw into an offscreen target) and kept. */
const C7D = { box: null, done: null, keys: null };
const C7_HEADS = new Map();
function c7Head(def) {   /* -> Promise<data url | null> */
  if (!def || !def.chatheadModels) return Promise.resolve(null);
  const key = def.chatheadModels.join(',') + '|' + (def.recolorFrom || []).join(',') + (def.recolorTo || []).join(',');
  if (C7_HEADS.has(key)) return C7_HEADS.get(key);
  const p = MAP07.headFigure(def).then(ent => {
    if (!ent) return null;
    const S = 128, sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(22, 1, 0.05, 40), rt = new THREE.WebGLRenderTarget(S, S);
    sc.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55); sun.position.set(-0.4, 0.6, 1); sc.add(sun);
    ent.mesh.geometry.computeBoundingBox();
    const bb = ent.mesh.geometry.boundingBox, c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3()), r = Math.max(size.x, size.y) * 0.54;
    ent.mesh.position.set(-c.x, -c.y, -c.z);   // a chat head faces +z in this world's axes: the camera stands there
    sc.add(ent.mesh);
    cam.position.set(0, 0, r / Math.tan(11 * Math.PI / 180)); cam.lookAt(0, 0, 0);
    const oldC = renderer.getClearColor(new THREE.Color()), oldA = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0); renderer.setRenderTarget(rt); renderer.clear(); renderer.render(sc, cam);
    const buf = new Uint8Array(S * S * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf);
    renderer.setRenderTarget(null); renderer.setClearColor(oldC, oldA);
    rt.dispose(); ent.dispose();
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'), im = g.createImageData(S, S);
    for (let y = 0; y < S; y++) im.data.set(buf.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4);
    g.putImageData(im, 0, 0);
    return cv.toDataURL();
  }).catch(() => null);
  C7_HEADS.set(key, p);
  return p;
}
function c7DlgClose() {
  if (C7D.box) { C7D.box.remove(); C7D.box = null; }
  if (C7D.keys) { window.removeEventListener('keydown', C7D.keys, true); C7D.keys = null; }
}
function c7DlgFrame(build) {   /* a fresh box over the chat; build(host, osui) lays the content */
  c7DlgClose();
  const osBody = OS.on && document.querySelector('.osChatBody');
  const box = document.createElement('div');
  if (osBody) {
    box.className = 'osc osHit c7dlg';
    box.style.cssText = 'left:0;top:0;width:519px;height:142px;z-index:3';
    OSUI.at(box, OSUI.graphic(1017, 519, 142), 0, 0);
    osBody.appendChild(box);
  } else {
    box.className = 'c7dlg c7html panel';
    (el('chatwrap') || document.body).appendChild(box);
  }
  C7D.box = box;
  build(box, !!osBody);
  return box;
}
/* one line of talk: who 'npc' (head on the left) or 'player' (on the right); resolves on continue */
function c7Say(who, name, text, def) {
  return new Promise(res => {
    const go = () => { c7DlgClose(); res(); };
    c7DlgFrame((box, os) => {
      const left = who !== 'player';
      if (os) {
        const head = document.createElement('img'); head.className = 'osc'; head.style.cssText = 'width:64px;height:64px;left:' + (left ? 26 : 429) + 'px;top:34px;image-rendering:pixelated';
        box.appendChild(head);
        if (def) c7Head(def).then(u => { if (u) head.src = u; else head.remove(); }); else head.remove();
        const x0 = left ? 104 : 16;
        OSUI.at(box, OSUI.text(400, 20, name, { font: 496, colour: 0x800000, xa: 1, ya: 1 }), x0, 12);
        OSUI.at(box, OSUI.text(400, 70, text, { font: 495, colour: 0, xa: 1, ya: 1, lh: 16 }), x0, 32);
        const cont = OSUI.at(box, OSUI.text(400, 18, 'Click here to continue', { font: 496, colour: 0x0000ff, xa: 1, ya: 1 }), x0, 104);
        cont.classList.add('osHit');
        on(cont, 'pointerenter', () => cont.osSet('Click here to continue', 0xffffff)); on(cont, 'pointerleave', () => cont.osSet('Click here to continue', 0x0000ff));
        on(cont, 'click', go);
      } else {
        box.innerHTML = '<div class="c7row' + (left ? '' : ' r') + '"><img class="c7head" alt=""><div class="c7txt"><b></b><p></p><a class="c7go">Click here to continue</a></div></div>';
        box.querySelector('b').textContent = name; box.querySelector('p').textContent = text;
        const img = box.querySelector('img');
        if (def) c7Head(def).then(u => { if (u) img.src = u; else img.remove(); }); else img.remove();
        on(box.querySelector('.c7go'), 'click', go);
      }
    });
    C7D.keys = e => { if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); e.stopPropagation(); go(); } };
    window.addEventListener('keydown', C7D.keys, true);
  });
}
/* an option list; resolves with the chosen index */
function c7Choose(opts, title) {
  return new Promise(res => {
    const pick = i => { c7DlgClose(); res(i); };
    c7DlgFrame((box, os) => {
      if (os) {
        const top = Math.max(8, 62 - opts.length * 10);
        OSUI.at(box, OSUI.text(519, 18, title || 'Select an Option', { font: 496, colour: 0x800000, xa: 1, ya: 1 }), 0, top - 4);
        opts.forEach((o, i) => {
          const t = OSUI.at(box, OSUI.text(519, 18, o, { font: 495, colour: 0, xa: 1, ya: 1 }), 0, top + 18 + i * 19);
          t.classList.add('osHit');
          on(t, 'pointerenter', () => t.osSet(o, 0xffffff)); on(t, 'pointerleave', () => t.osSet(o, 0));
          on(t, 'click', () => pick(i));
        });
      } else {
        box.innerHTML = '<div class="c7opts"><b></b></div>';
        box.querySelector('b').textContent = title || 'Select an Option';
        const host = box.firstChild;
        opts.forEach((o, i) => { const a = document.createElement('a'); a.textContent = (i + 1) + '. ' + o; on(a, 'click', () => pick(i)); host.appendChild(a); });
      }
    });
    C7D.keys = e => { const n = +e.key; if (n >= 1 && n <= opts.length && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); e.stopPropagation(); pick(n - 1); } };
    window.addEventListener('keydown', C7D.keys, true);
  });
}
/* a conversation: rows of [who, text] ('n' the npc, 'p' you, 'm' a plain message), awaited in turn */
async function c7Talk(n, rows) {
  const def = n && n.c7 !== undefined ? MAP07.npcDefOf(n.c7) : null, nm = n ? n.name : '';
  for (const [who, text] of rows) {
    if (who === 'n') await c7Say('npc', nm, text, def);
    else if (who === 'p') await c7Say('player', NAME || 'You', text, null);
    else await c7Say('npc', '', text, null);
  }
}

/* ---- 49c. the player's own 2007 animations ----
   With the 2007 kit on in Gielinor the rig plays the cache's seqs instead of the box rig's swings: stand, walk and run, the
   swing of the weapon in hand (restarted with every blow), the cast of the spell readied, each gathering skill's own motion
   with the tool tier you carry, the emotes. A seq still fetching shows the stand; nothing loaded yet, the old poses. */
const C7_TIER = ['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune', 'dragon'];
const C7_AXE = { bronze: 879, iron: 877, steel: 875, black: 873, mithril: 871, adamant: 869, rune: 867, dragon: 2846 };
const C7_PICK = { bronze: 625, iron: 626, steel: 627, black: 3873, mithril: 629, adamant: 628, rune: 624, dragon: 7139 };
function c7ToolSeq(word, table) {
  const names = [eq.weapon && ITEMS[eq.weapon] && ITEMS[eq.weapon].name].concat(inv.map(s => s && ITEMS[s.id] && ITEMS[s.id].name)).filter(Boolean).map(s => s.toLowerCase()).filter(s => s.includes(word));
  let best = null;
  for (const n of names) for (let i = C7_TIER.length - 1; i >= 0; i--) if (n.startsWith(C7_TIER[i]) && (!best || C7_TIER.indexOf(best) < i)) best = C7_TIER[i];
  return table[best || 'bronze'];
}
function c7WeaponSeq() {
  const w = eq.weapon && ITEMS[eq.weapon], n = w ? w.name.toLowerCase() : '';
  if (!w) return 422;
  if (/whip/.test(n)) return 1658;
  if (/crossbow|ballista/.test(n)) return 4230;
  if (w.bow || /\bbow\b|longbow|shortbow/.test(n)) return 426;
  if (w.thrown || /dart|knife|javelin|thrownaxe|chinchompa/.test(n)) return 385;
  if (/godsword|2h|two-handed|greatsword/.test(n)) return 407;
  if (/halberd|scythe/.test(n)) return 440;
  if (/spear|hasta/.test(n)) return 428;
  if (/maul|warhammer|hammer|mace|flail|club/.test(n)) return 401;
  if (/battleaxe|axe/.test(n)) return 395;
  if (/staff|wand|sceptre|trident|crozier/.test(n)) return 419;
  if (/dagger|rapier|sword stab/.test(n) || w.stab) return 386;
  return 390;
}
const C7_MAKE = { smithing: 898, crafting: 885, fletching: 1248, cooking: 896, herblore: 363, construction: 898, magic: 713 };
function c7PlayerSeq(E, moving) {   /* [seq, once, restart mark] */
  if (E.dead) return [836, 1, 0];
  if (moving) { E.emote7 = null; return [stepsThisTick(E) > 1 ? 824 : 819, 0, 0]; }
  if (E.emote7) return [E.emote7.seq, 1, E.emote7.mark];
  if (!E.acting) return [808, 0, 0];
  const t = P.task, A = c7Get('anims.json');
  if (E.pose === 2) {   // a cast
    const sp = P.spell !== null ? SPELLS[P.spell] : null, row = sp && A && A.spell[sp.k], staff = eq.weapon && /staff|wand|sceptre|trident/.test(ITEMS[eq.weapon].name.toLowerCase());
    return [row ? row[staff ? 1 : 0] || row[0] : 711, 1, P.atkT];
  }
  if (t && t.k === 'attack') return [c7WeaponSeq(), 1, P.atkT];
  if (E.pose === 3) return [t && t.k === 'pray' && t.o && t.o.t === 8 ? 645 : 827, 1, P.actT];
  if (t) {
    if (t.k === 'chop') return [c7ToolSeq('axe', C7_AXE), 0, 0];
    if (t.k === 'mine') return [c7ToolSeq('pickaxe', C7_PICK), 0, 0];
    if (t.k === 'fish') return [t.o && t.o.k ? 618 : 621, 0, 0];
    if (t.k === 'cook') return [t.o && t.o.fire ? 897 : 896, 0, 0];
    if (t.k === 'steal') return [t.o && t.o.npc ? 881 : 832, 1, P.actT];
    if (t.k === 'pick') return [881, 1, P.actT];
    if (t.k === 'make' && t.r) return [t.r.at === 3 ? 899 : C7_MAKE[t.r.sk] || 898, 0, 0];
  }
  return [E.pose === 1 ? 426 : E.pose === 4 ? 386 : c7WeaponSeq(), 1, P.atkT];
}
const C7P = { seq: -1, mark: 0, t: 0, idx: -1, total: 1, once: 0 };
function c7Pose(E, p, dt, moving) {   /* true when the cache posed the rig this frame */
  if (E !== P || !p.osrs || E.afloat || !OSRSK.pose07) return false;
  const [want, once, mark] = c7PlayerSeq(E, moving);
  let seq = want, fr = MAP07.seqFrames(seq);
  if (!fr) { seq = 808; fr = MAP07.seqFrames(808); }
  if (!fr) return false;
  if (seq !== C7P.seq || mark !== C7P.mark) { C7P.seq = seq; C7P.mark = mark; C7P.t = 0; C7P.idx = -1; C7P.once = once; C7P.total = 0; for (const f of fr) C7P.total += f.ms; if (!C7P.total) C7P.total = 1; }
  C7P.t += dt * 1000;
  if (E.emote7 && seq === E.emote7.seq && C7P.t >= C7P.total) E.emote7 = null;
  const t = C7P.once ? Math.min(C7P.t, C7P.total - 1) : C7P.t % C7P.total, idx = MAP07.frameAt(fr, t);
  if (idx !== C7P.idx || p.mesh.geometry !== p.a07own) {
    if (!OSRSK.pose07(p, fr[idx])) return false;
    C7P.idx = idx;
  }
  if (E.rig) { E.rig.position.y = 0; E.rig.scale.setScalar(1); }
  if (E.boat) E.boat.visible = false;
  return true;
}
/* the emotes, by the names enum 1000 gives them */
const C7_EMOTE = { yes: 855, no: 856, bow: 858, angry: 859, think: 857, wave: 863, shrug: 2113, cheer: 862, beckon: 864, laugh: 861, 'jump for joy': 2109, yawn: 2111,
  dance: 866, jig: 2106, spin: 2107, headbang: 2108, cry: 860, 'blow kiss': 1374, panic: 2105, raspberry: 2110, clap: 865, salute: 2112, 'goblin bow': 2127, 'goblin salute': 2128,
  'glass box': 1131, 'climb rope': 1130, lean: 1129, 'glass wall': 1128, idea: 4276, stamp: 4278, flap: 4280, 'slap head': 4275, 'zombie walk': 3544, 'zombie dance': 3543,
  scared: 2836, 'rabbit hop': 6111, 'air guitar': 4751 };
let c7EmoteMark = 0;
function c7Emote(key, name) {
  const seq = C7_EMOTE[String(name).toLowerCase()];
  if (!seq) return say('That emote is not in this world yet.');
  if (!M7 || !osrsSelf) return say('Emotes play on the 2007 models, in Gielinor.');
  P.path.length = 0; P.task = null; P.acting = 0;
  P.emote7 = { seq, mark: ++c7EmoteMark, key: +key };
  MAP07.seqFrames(seq);
  if (typeof c7ClueEmote === 'function') c7ClueEmote(Object.keys(C7_EMOTE).indexOf(String(name).toLowerCase()));
}

/* ---- 49d. monsters and missiles ---- */
function c7NpcSeqs(n) {
  const A = c7Get('anims.json'), d = n && n.c7 !== undefined ? MAP07.npcDefOf(n.c7) : null;
  if (!A || !d) return null;
  return A.npc[d.standingAnimation] || A.npc[d.walkingAnimation] || null;
}
function c7Act(n, kind) {   /* 0 attack, 1 flinch */
  if (!M7 || !n || !n.fig) return;
  const s = c7NpcSeqs(n);
  if (s && s[kind]) MAP07.figureAct(n.fig, s[kind], false);
}
const C7_CORPSES = [];
function c7Corpse(n) {   /* the figure plays its death where it fell, then goes; the monster itself is already gone */
  const s = c7NpcSeqs(n);
  if (!s || !s[2] || !n.fig || !MAP07.seqFrames(s[2])) return;
  const g = new THREE.Group();
  g.position.copy(n.mesh.position); g.rotation.copy(n.mesh.rotation);
  g.add(n.fig.mesh); scene.add(g);
  MAP07.figureAct(n.fig, s[2], true);
  C7_CORPSES.push({ g, fig: n.fig, t: 0 });
  if (C7_CORPSES.length > 12) c7CorpseGone(0);
  n.fig = null;
}
function c7CorpseGone(i) { const c = C7_CORPSES.splice(i, 1)[0]; scene.remove(c.g); c.fig.ent.dispose(); }
/* a spell's cast, flight and splash and an arrow's flight, drawn with the cache's own spot animations: the bolt keeps flying
   the game's arc and timing, the graphic rides it, and the old octahedron stands in only until the graphic has loaded */
const C7_FX = [];
function c7Gfx(id, o, lift) {
  if (!id) return;
  MAP07.spotanim(id).then(s => {
    if (!s) return;
    if (C7_FX.length > 24) { const old = C7_FX.shift(); scene.remove(old.s.mesh); old.s.ent.dispose(); }
    scene.add(s.mesh);
    C7_FX.push({ s, o, lift: lift || 0, t: 0 });
  });
}
function c7AmmoStem() { const a = eq.ammo && ITEMS[eq.ammo]; return a ? a.name.toLowerCase().replace(/\(p\+*\)|\(p\)/g, '').trim().replace(/s$/, '').replace(/ /g, '_') : ''; }
function c7FxBolt(b) {
  if (!M7) return;
  const A = c7Get('anims.json');
  if (!A) return;
  let cast = 0, travel = 0, impact = 0;
  if (b.sp && b.sp.k && A.spell[b.sp.k]) [, , cast, travel, impact] = A.spell[b.sp.k];
  else if (b.arw) { const r = A.ammo[c7AmmoStem()]; if (r) [cast, travel] = r; }
  if (!travel && !impact) return;
  b.fx7 = { impact };
  if (cast) c7Gfx(cast, P, 0);
  if (travel) MAP07.spotanim(travel).then(s => {
    if (!s) return;
    if (bolts.indexOf(b) < 0) return s.ent.dispose();
    s.ent.play(s.ent.frames, false);   // a flight loops for as long as it flies
    b.g7 = s; scene.add(s.mesh);
  });
}
function c7FxBoltFrame(b, dt, tx, tz) {
  if (!b.g7) return;
  b.m.visible = false;
  b.g7.mesh.position.copy(b.m.position); b.g7.mesh.position.y -= 0.4;
  b.g7.mesh.rotation.set(0, Math.atan2(tx - b.sx, tz - b.sz) + Math.PI, 0);
  b.g7.ent.update(dt * 1000, 0);
}
function c7FxBoltEnd(b, o) {
  if (b.g7) { scene.remove(b.g7.mesh); b.g7.ent.dispose(); b.g7 = null; }
  if (b.fx7 && b.fx7.impact && o) { c7Gfx(b.fx7.impact, o, 0); return true; }
  return false;
}

/* ---- 49e. the maps ----
   The minimap and the world map wear the cache's own pictures: each map-function icon (cfg/area's sprite) on the loc that
   carries it, upright however the map turns, and the 8-pixel scene sprites (group 317: trees, rocks, fences) laid on the
   tile picture under the 2007 minimap. The icon list is the whole map's (mapicons.json), so the world map shows them far
   past the loaded squares; the dungeons' own pictures (wm/img/5.<area>) sit where their squares lie. */
const C7_AREA = new Map(), C7_SPR = new Map();
let c7AreaLoading = 0, c7Sheet = null, c7SheetP = null;
function c7IconImg(area) {
  let im = C7_SPR.get(area);
  if (im !== undefined) return im;
  C7_SPR.set(area, null);
  if (!c7AreaLoading) {
    c7AreaLoading = 1;
    OSUI.getJson('cfg/area/index.json').then(ix => Promise.all(ix.shards.map(s => OSRSK.cfgShard('area', s))))
      .then(sh => { for (const e of sh) for (const k in e) C7_AREA.set(+k, e[k]); C7_SPR.clear(); osMapDirty = 1; wmDirty = 1; }, () => { c7AreaLoading = 0; });
  }
  const a = C7_AREA.get(area);
  if (a && a.spriteId >= 0) OSUI.image(a.spriteId).then(i => C7_SPR.set(area, i), () => {});
  else if (C7_AREA.size) C7_SPR.set(area, 0);
  return null;
}
function c7SceneSheet() {
  if (c7Sheet || c7SheetP) return c7Sheet;
  c7SheetP = OSUI.image(317).then(i => { c7Sheet = i; osMapDirty = 1; }, () => { c7SheetP = null; });
  return null;
}
/* the scene sprites into the 2007 minimap's tile picture: x0 its west tile, yTop its north row, 4 px a tile */
function c7MapScenes(g, x0, yTop, N) {
  const sheet = c7SceneSheet();
  if (!sheet) return;
  for (const R of MAP07.regions.values()) {
    const s = R.scenes;
    if (!s || !s.length || R.sqX * 64 + 64 < x0 || R.sqX * 64 > x0 + N || R.sqY * 64 > yTop + 1 || R.sqY * 64 + 64 < yTop - N) continue;
    for (let i = 0; i < s.length; i += 6) {
      if (s[i + 2] !== P.plane) continue;
      const gx = s[i], gy = s[i + 1], w = s[i + 4], l = s[i + 5], dx = (gx - x0) * 4 + ((w * 4 - 8) >> 1), dy = (yTop - (gy + l - 1)) * 4 + ((l * 4 - 8) >> 1);
      if (dx < -8 || dy < -8 || dx > N * 4 || dy > N * 4) continue;
      g.drawImage(sheet, 0, s[i + 3] * 8, 8, 8, dx, dy, 8, 8);
    }
  }
}
/* the icons near (x, y) within r tiles on the current floor: the whole map's list, sorted by y then x */
function c7IconsNear(x, y, r, fn) {
  const M = c7Get('mapicons.json');
  if (!M) return;
  const I = M.i;
  let lo = 0, hi = I.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (I[m][1] < y - r) lo = m + 1; else hi = m; }
  for (let i = lo; i < I.length && I[i][1] <= y + r; i++) { const e = I[i]; if (Math.abs(e[0] - x) <= r && e[2] === P.plane) fn(e); }
}
/* upright icons on the 2007 minimap (cs, sn: the camera's turn); drawn before the round mask cuts it */
function c7MapIcons(g, cs, sn) {
  c7IconsNear(P.tx, -P.tz, 20, e => {
    const im = c7IconImg(e[3]);
    if (!im) return;
    const dx = (e[0] - P.rx) * 4, dz = (-e[1] - P.rz) * 4;
    if (dx * dx + dz * dz > 5000) return;
    g.drawImage(im, Math.round(72 + dx * cs - dz * sn - im.width / 2), Math.round(75 + dx * sn + dz * cs - im.height / 2));
  });
}
/* the same on the game's own minimap, inside its turned context (k px a tile) */
function c7MiniIcons(ctx, k, C, turn) {
  const r = Math.ceil(C / k);
  c7IconsNear(P.tx, -P.tz, r, e => {
    const im = c7IconImg(e[3]);
    if (!im) return;
    const px = (e[0] - P.rx) * k, pz = (-e[1] - P.rz) * k;
    if (px * px + pz * pz > (C - 6) * (C - 6)) return;
    const s = Math.max(7, Math.min(13, k * 4));
    ctx.save(); ctx.translate(px, pz); ctx.rotate(-turn); ctx.drawImage(im, -s / 2, -s / 2, s, s); ctx.restore();
  });
}
const C7_WMIMG = new Map();
function c7WmExtras(px, pz, s, W, H, phase) {   /* the world map: dungeon pictures under the squares (phase 0), icons over them (1); px/pz map world x/z to the canvas */
  const A = phase ? null : c7Get('wmareas.json');
  if (A) for (const [id, , x0, y0, x1, y1, surf] of A.a) {
    if (surf) continue;
    const L = px(x0 * 64 - 0.5), T = pz(-(y1 + 1) * 64 + 0.5), Wd = (x1 - x0 + 1) * 64 * s, Hd = (y1 - y0 + 1) * 64 * s;
    if (L > W || T > H || L + Wd < 0 || T + Hd < 0) continue;
    let im = C7_WMIMG.get(id);
    if (!im) { im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => { wmDirty = 1; }; im.src = OSRSK.OUT + '/wm/img/5.' + id + '.png'; C7_WMIMG.set(id, im); }
    if (im.complete && im.naturalWidth) wmCtx.drawImage(im, L, T, Wd, Hd);
  }
  if (!phase || wmZoom < 3) return;
  const M = c7Get('mapicons.json');
  if (!M) { wmDirty = 1; return; }
  for (const e of M.i) {
    if (e[2] !== 0 && e[2] !== P.plane) continue;
    const x = px(e[0]), y = pz(-e[1]);
    if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
    const im = c7IconImg(e[3]);
    if (im) wmCtx.drawImage(im, Math.round(x - im.width / 2), Math.round(y - im.height / 2)); else wmDirty = 1;
  }
}

/* ---- a Gielinor frame: the scenery's clock, the corpses and the graphics, the other systems' ticks ---- */
function c7Frame(dt) {
  MAP07.animateScenery(P.tx, -P.tz, dt * 1000);
  for (let i = C7_CORPSES.length - 1; i >= 0; i--) {
    const c = C7_CORPSES[i];
    c.t += dt;
    MAP07.animate(c.fig, 0, dt * 1000, 0);
    if ((c.fig.ent.done && c.t > c.fig.ent.total / 1000 + 0.8) || c.t > 6) c7CorpseGone(i);
  }
  for (let i = C7_FX.length - 1; i >= 0; i--) {
    const f = C7_FX[i], o = f.o;
    f.t += dt;
    f.s.mesh.position.set(o.rx !== undefined ? o.rx : o.x, (o.ry !== undefined ? o.ry : o.y || 0) + f.lift, o.rz !== undefined ? o.rz : o.z);
    f.s.ent.update(dt * 1000, 0);
    if (f.s.ent.done || f.t > 5 || o.dead) { scene.remove(f.s.mesh); f.s.ent.dispose(); C7_FX.splice(i, 1); }
  }
  if (typeof c7FrameB === 'function') c7FrameB(dt);
}
/* entering Gielinor warms the small tables the first frames will ask for */
function c7Warm() { for (const n of ['anims.json', 'mapicons.json', 'wmareas.json']) c7Json(n).catch(() => {}); if (typeof c7WarmB === 'function') c7WarmB(); }
function c7WarmNpc(n) { const s = c7NpcSeqs(n); if (s) for (const q of s) if (q) MAP07.seqFrames(q); }
