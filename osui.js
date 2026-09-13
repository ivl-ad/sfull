/* ---- OSRS INTERFACE ENGINE ----------------------------------------------------------------------------------------
   The 2007 client's own interface parts, read live from the cache transcode (OSRSK.OUT, the same tree the models come
   from): sprites (s/<id>.png, geometry in cfg/sprite), bitmap fonts (f/<name>.json and their glyph sheets) and interface
   definitions (if/<id>.json). This file only draws. game.js (section OSRS INTERFACE) decides what each panel shows and
   wires it to the game; nothing here runs until it is asked.

   What it reproduces, and from where:
     - a component's box: the client's size modes (0 absolute, 1 parent minus, 2 proportional /16384) and position modes
       (0 from the left/top, 1 centred, 2 from the right/bottom, 3-5 their proportional forms), Widget.alignWidgetSize /
       alignWidgetPosition;
     - a graphic: the sprite's whole canvas drawn into the box (stretched when the box differs, repeated when tiled),
       flips, and the item-sprite drop shadow;
     - a rectangle: its colour, fill and transparency (0 opaque .. 255 clear);
     - text: the font's own glyphs, advances, ascent and extents, drawn the way AbstractFont.drawLines lays them out
       (x and y alignment, line height, word wrap to the box), with <col=rrggbb>, </col> and <br> tags and the one-pixel
       shadow. Models and lines are left to the caller.
   Every mount returns its components by index so the caller can fill in what the client's scripts would. ---- */
const OSUI = (() => {
'use strict';

const OUT = OSRSK.OUT;
const getJson = p => fetch(OUT + '/' + p).then(r => r.ok ? r.json() : Promise.reject(new Error(p + ' ' + r.status)));
const shardP = new Map();
function cfg(type, id) {
  const k = type + '/' + Math.floor(id / 256);
  let p = shardP.get(k);
  if (!p) { p = getJson('cfg/' + k + '.json').then(j => j.entries || {}); shardP.set(k, p); p.catch(() => shardP.delete(k)); }
  return p.then(e => e[id]);
}
const ifP = new Map();
function iface(id) {
  let p = ifP.get(id);
  if (!p) { p = getJson('if/' + id + '.json'); ifP.set(id, p); p.catch(() => ifP.delete(id)); }
  return p;
}
const enumOf = id => cfg('enum', id).then(e => (e && e.map) || {});

/* ---- sprites ---- */
const spriteURL = id => OUT + '/s/' + id + '.png';
const imgP = new Map();
function image(id) {
  let p = imgP.get(id);
  if (!p) {
    p = new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('sprite ' + id)); im.src = spriteURL(id); });   /* read back by the masks and the alpha audit: an R2 base must send CORS */
    imgP.set(id, p); p.catch(() => imgP.delete(id));
  }
  return p;
}
const spriteMeta = id => cfg('sprite', id).then(e => e ? { cw: e.canvasW, ch: e.canvasH, frames: e.frames || [] } : null);
/* A few exports (the lit tab stones 1027-1030, the adviser filler 4547, a settings tab icon, ...) carry their colour under an
   all-zero alpha plane. The client never reads that plane — a sprite pixel is clear only when its RGB is 0 — so each sprite is
   checked once, and one found clear everywhere is rebuilt by that rule. The browser has already dropped the colour of a clear
   pixel by the time it decodes the file, so the PNG is inflated here (zlib and the five scanline filters: RGBA8 is all the
   exporter writes). */
const fixedURL = new Map(), auditP = new Map();
function audit(id) {
  let p = auditP.get(id);
  if (!p) {
    p = image(id).then(im => {
      const w = im.width, h = im.height;
      if (!w || !h) return null;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0);
      const a = g.getImageData(0, 0, w, h).data;
      for (let i = 3; i < a.length; i += 4) if (a[i]) return null;
      return fetch(spriteURL(id)).then(r => r.arrayBuffer()).then(inflatePNG).then(px => {
        if (!px || px.length !== w * h * 4) return null;
        let any = 0;
        for (let i = 0; i < px.length; i += 4) { const on = px[i] | px[i + 1] | px[i + 2]; px[i + 3] = on ? 255 : 0; any |= on; }
        if (!any) return null;
        g.putImageData(new ImageData(px, w, h), 0, 0);
        const u = cv.toDataURL();
        fixedURL.set(id, u);
        return u;
      });
    }).catch(() => null);
    auditP.set(id, p);
  }
  return p;
}
async function inflatePNG(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), parts = [];
  let p = 8, w = 0, h = 0, depth = 0, ct = 0, lace = 0;
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = u8[p + 16]; ct = u8[p + 17]; lace = u8[p + 20]; }
    else if (type === 'IDAT') parts.push(u8.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (ct !== 6 || depth !== 8 || lace || typeof DecompressionStream === 'undefined') return null;
  const raw = new Uint8Array(await new Response(new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = w * 4, out = new Uint8ClampedArray(stride * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride), q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    for (let x = 0; x < stride; x++) {
      const r = raw[q++], a = x >= 4 ? cur[x - 4] : 0, b = prev[x], c = x >= 4 ? prev[x - 4] : 0;
      let v = r;
      if (f === 1) v = r + a;
      else if (f === 2) v = r + b;
      else if (f === 3) v = r + ((a + b) >> 1);
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
    out.set(cur, y * stride);
    const t = prev; prev = cur; cur = t;
  }
  return out;
}
/* point an element at a sprite: an <img> gets its src, anything else a background; a sprite that needed rebuilding follows */
function setSprite(el, id) {
  const put = u => { if (el.tagName === 'IMG') el.src = u; else el.style.backgroundImage = 'url("' + u + '")'; };
  el.osSprite = id;
  put(fixedURL.get(id) || spriteURL(id));
  if (!fixedURL.has(id)) audit(id).then(u => { if (u && el.osSprite === id) put(u); });
  return el;
}
/* a graphic element: an <img> for a plain sprite, a div with a repeating background for a tiled one */
function graphic(id, w, h, o) {
  o = o || {};
  let el;
  if (o.tile) {
    el = document.createElement('div');
    el.style.backgroundRepeat = 'repeat';
  } else {
    el = document.createElement('img');
    el.alt = ''; el.draggable = false;
  }
  setSprite(el, id);
  el.className = 'osg';
  el.style.width = w + 'px'; el.style.height = h + 'px';
  const tf = [];
  if (o.flipH) tf.push('scaleX(-1)');
  if (o.flipV) tf.push('scaleY(-1)');
  if (tf.length) el.style.transform = tf.join(' ');
  if (o.shadow) el.style.filter = 'drop-shadow(1px 1px 0 ' + hex(o.shadow) + ')';
  return el;
}

/* Widget.getSprite's effects on a whole-canvas sprite, as a data URL: outline 1 rings the opaque pixels in 0x000001 and
   2 adds a white ring round that (SpritePixels.outline: a clear pixel with an opaque 4-neighbour, clipped to the canvas);
   a shadow colour fills each clear pixel whose up-left neighbour is opaque (SpritePixels.shadow) */
const fxP = new Map();
function spriteFx(id, outline, shadow) {
  const k = id + ':' + (outline | 0) + ':' + (shadow | 0);
  let p = fxP.get(k);
  if (!p) {
    p = audit(id).then(u => u ? new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = u; }) : image(id)).then(im => {
      const w = im.width, h = im.height, cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d');
      g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, w, h);
      pixelFx(d.data, w, h, outline, shadow);
      g.putImageData(d, 0, 0);
      return cv.toDataURL();
    });
    fxP.set(k, p); p.catch(() => fxP.delete(k));
  }
  return p;
}
function pixelFx(px, w, h, outline, shadow) {
  if (outline >= 1) ring(px, w, h, 1);
  if (outline >= 2) ring(px, w, h, 0xffffff);
  if (shadow) for (let y = h - 1; y > 0; y--) for (let x = w - 1; x > 0; x--) {
    const i = (y * w + x) * 4, j = ((y - 1) * w + x - 1) * 4;
    if (!px[i + 3] && px[j + 3]) { px[i] = shadow >> 16 & 255; px[i + 1] = shadow >> 8 & 255; px[i + 2] = shadow & 255; px[i + 3] = 255; }
  }
}
function ring(px, w, h, rgb) {
  const a = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = px[i * 4 + 3] ? 1 : 0;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    if (a[i] || !((x > 0 && a[i - 1]) || (y > 0 && a[i - w]) || (x < w - 1 && a[i + 1]) || (y < h - 1 && a[i + w]))) continue;
    px[i * 4] = rgb >> 16 & 255; px[i * 4 + 1] = rgb >> 8 & 255; px[i * 4 + 2] = rgb & 255; px[i * 4 + 3] = 255;
  }
}

/* ---- fonts ---- */
const hex = rgb => '#' + ((rgb >>> 0) & 0xffffff).toString(16).padStart(6, '0');
let fontIndex = null;
const fontP = new Map(), fontNow = new Map();
function font(id) {
  let p = fontP.get(id);
  if (p) return p;
  if (!fontIndex) fontIndex = getJson('f/index.json');
  p = fontIndex.then(ix => {
    const row = (ix.fonts || []).find(f => f.id === id);
    if (!row) throw new Error('font ' + id);
    return Promise.all([getJson('f/' + row.file), spriteMeta(row.spriteGroupId), image(row.spriteGroupId)]);
  }).then(([fj, meta, img]) => {
    let top = 1e9, bottom = -1e9;
    meta.frames.forEach(fr => { if (fr.h && fr.offsetY < top) top = fr.offsetY; if (fr.offsetY + fr.h > bottom) bottom = fr.offsetY + fr.h; });
    const f = { id, ascent: fj.ascent, adv: fj.advances, cw: meta.cw, ch: meta.ch, img, maxAscent: fj.ascent - top, maxDescent: bottom - fj.ascent, tint: new Map() };
    fontNow.set(id, f);
    return f;
  });
  fontP.set(id, p); p.catch(() => fontP.delete(id));
  return p;
}
/* the client's charset: Latin-1 as is, and the Windows-1252 punctuation folded into 128-159 */
const CP1252 = { 8364: 128, 8218: 130, 402: 131, 8222: 132, 8230: 133, 8224: 134, 8225: 135, 710: 136, 8240: 137, 352: 138, 8249: 139, 338: 140, 381: 142,
  8216: 145, 8217: 146, 8220: 147, 8221: 148, 8226: 149, 8211: 150, 8212: 151, 732: 152, 8482: 153, 353: 154, 8250: 155, 339: 156, 382: 158, 376: 159 };
const code = ch => { const c = ch.charCodeAt(0); return c < 256 ? c : CP1252[c] || 63; };
function tinted(f, rgb) {
  let c = f.tint.get(rgb);
  if (!c) {
    c = document.createElement('canvas'); c.width = f.img.width; c.height = f.img.height;
    const g = c.getContext('2d');
    g.drawImage(f.img, 0, 0);
    g.globalCompositeOperation = 'source-in'; g.fillStyle = hex(rgb); g.fillRect(0, 0, c.width, c.height);
    if (f.tint.size > 24) f.tint.delete(f.tint.keys().next().value);
    f.tint.set(rgb, c);
  }
  return c;
}
/* a string as [{t, col}] runs: <col=rrggbb> sets the colour until </col>; <lt>/<gt> are the escaped brackets */
function runs(s, base) {
  const out = [];
  let col = base, i = 0;
  while (i < s.length) {
    if (s[i] === '<') {
      const j = s.indexOf('>', i);
      if (j > i) {
        const tag = s.slice(i + 1, j);
        if (/^col=[0-9a-f]{1,6}$/i.test(tag)) { col = parseInt(tag.slice(4), 16); i = j + 1; continue; }
        if (tag === '/col') { col = base; i = j + 1; continue; }
        if (tag === 'lt' || tag === 'gt') { out.push({ t: tag === 'lt' ? '<' : '>', col }); i = j + 1; continue; }
        if (/^\/?(u|str|shad|trans|img)(=.*)?$/.test(tag)) { i = j + 1; continue; }
      }
    }
    const k = s.indexOf('<', i + 1);
    const t = s.slice(i, k < 0 ? s.length : k);
    out.push({ t, col });
    i += t.length;
  }
  return out;
}
const plain = s => s.replace(/<lt>/g, '<').replace(/<gt>/g, '>').replace(/<[^>]*>/g, '');
function width(f, s) { let w = 0; for (const ch of plain(s)) w += f.adv[code(ch)] || 0; return w; }
/* AbstractFont.draw: y is the baseline; the shadow is the whole string one pixel down and right, drawn first */
function drawString(g, f, s, x, y, rgb, shadow) {
  const top = y - f.ascent;
  const pass = (dx, dy, fixed) => {
    let px = x + dx;
    for (const r of runs(s, rgb)) {
      const sheet = tinted(f, fixed !== undefined ? fixed : r.col);
      for (const ch of r.t) {
        const c = code(ch);
        g.drawImage(sheet, 0, c * f.ch, f.cw, f.ch, px, top + dy, f.cw, f.ch);
        px += f.adv[c] || 0;
      }
    }
  };
  if (shadow !== undefined && shadow !== null && shadow !== false) pass(1, 1, shadow === true ? 0 : shadow);
  pass(0, 0);
}
/* AbstractFont.breakLines: <br> always breaks; with a width, words wrap at spaces */
function lines(f, s, w) {
  const out = [];
  for (const para of s.split(/<br>/i)) {
    if (!w) { out.push(para); continue; }
    let line = '', lw = 0;
    for (const word of para.split(' ')) {
      const ww = width(f, word), sp = line ? f.adv[32] || 0 : 0;
      if (line && lw + sp + ww > w) { out.push(line); line = word; lw = ww; }
      else { line = line ? line + ' ' + word : word; lw += sp + ww; }
    }
    out.push(line);
  }
  return out;
}
/* AbstractFont.drawLines: lays text into a box the client's way */
function drawLines(g, f, s, x, y, w, h, rgb, shadow, xa, ya, lh) {
  if (!lh) lh = f.ascent;
  const wrap = !(h < f.maxAscent + f.maxDescent + lh && h < lh + lh);
  const ls = lines(f, s, wrap ? w : 0);
  if (ya === 3 && ls.length === 1) ya = 1;
  let by = ya === 0 ? y + f.maxAscent : ya === 1 ? y + Math.trunc((h - f.maxAscent - f.maxDescent - lh * (ls.length - 1)) / 2) + f.maxAscent
    : ya === 2 ? y + h - f.maxDescent - lh * (ls.length - 1) : y + f.maxAscent;
  for (const l of ls) {
    const lx = xa === 1 ? x + Math.trunc((w - width(f, l)) / 2) : xa === 2 ? x + w - width(f, l) : x;
    drawString(g, f, l, lx, by, rgb, shadow);
    by += lh;
  }
  return ls.length;
}
/* a text component: a canvas the size of its box, redrawn in place when the string changes */
function text(w, h, s, o) {
  o = o || {};
  const cv = document.createElement('canvas');
  cv.className = 'ost';
  cv.width = Math.max(1, w); cv.height = Math.max(1, h);
  cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px';
  cv.osSet = (str, colour) => setText(cv, str, Object.assign({}, o, colour !== undefined ? { colour } : {}));
  if (s) cv.osSet(s);
  return cv;
}
function setText(cv, s, o) {
  const key = s + '|' + o.colour + '|' + o.font;
  if (cv.osKey === key) return;
  cv.osKey = key;
  const paint = f => {
    if (cv.osKey !== key) return;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    if (s) drawLines(g, f, String(s), 0, 0, cv.width, cv.height, o.colour | 0, o.shadow ? (o.shadowColour !== undefined ? o.shadowColour : 0) : null, o.xa | 0, o.ya | 0, o.lh | 0);
  };
  const f = fontNow.get(o.font);
  if (f) paint(f); else font(o.font).then(paint, () => {});
}

/* ---- interfaces ---- */
const size = (mode, raw, parent) => mode === 1 ? parent - raw : mode === 2 ? raw * parent >> 14 : raw;
const place = (mode, raw, parent, own) => mode === 1 ? raw + Math.trunc((parent - own) / 2) : mode === 2 ? parent - own - raw : mode === 3 ? raw * parent >> 14
  : mode === 4 ? (raw * parent >> 14) + Math.trunc((parent - own) / 2) : mode === 5 ? parent - own - (raw * parent >> 14) : raw;
/* mount an interface's static tree into host (a positioned element w x h): {comps: index -> {el, c, x, y, w, h, kids}} */
async function mount(ifId, host, w, h, o) {
  o = o || {};
  const j = await iface(ifId);
  const comps = j.components || {}, kids = {};
  for (const k in comps) {
    const c = comps[k], p = c.parentId !== undefined && c.parentId !== -1 && (c.parentId >> 16) === ifId ? c.parentId & 0xffff : -1;
    (kids[p] = kids[p] || []).push(+k);
  }
  for (const k in kids) kids[k].sort((a, b) => a - b);
  const out = {};
  const build = (idx, parentEl, pw, ph) => {
    const c = comps[idx], t = c.type | 0;
    const cw = size(c.widthMode | 0, c.originalWidth | 0, pw), chh = size(c.heightMode | 0, c.originalHeight | 0, ph);
    const cx = place(c.xPositionMode | 0, c.originalX | 0, pw, cw), cy = place(c.yPositionMode | 0, c.originalY | 0, ph, chh);
    let el;
    if (t === 5 && c.spriteId !== undefined && c.spriteId >= 0) {
      el = graphic(c.spriteId, cw, chh, { tile: c.spriteTiling, flipH: c.flippedHorizontally, flipV: c.flippedVertically, shadow: c.shadowColor });
    } else if (t === 4 && c.fontId !== undefined && c.fontId >= 0) {   /* an empty one too: a script fills it in */
      el = text(cw, chh, c.text, { font: c.fontId, colour: c.textColor | 0, shadow: c.textShadowed, xa: c.xTextAlignment | 0, ya: c.yTextAlignment | 0, lh: c.lineHeight | 0 });
    } else {
      el = document.createElement('div');
      if (t === 3) {
        const a = 1 - (c.opacity | 0) / 255, col = hex(c.textColor | 0);
        const rgba = 'rgba(' + ((c.textColor >> 16) & 255) + ',' + ((c.textColor >> 8) & 255) + ',' + (c.textColor & 255) + ',' + a.toFixed(3) + ')';
        if (c.filled) el.style.background = a < 1 ? rgba : col; else el.style.boxShadow = 'inset 0 0 0 1px ' + (a < 1 ? rgba : col);
      }
    }
    el.classList.add('osc');
    if (t === 5 && c.opacity) el.style.opacity = ((256 - c.opacity) / 256).toFixed(3);   /* a graphic's transparency blends it (src * (256 - t) >> 8) */
    el.style.left = cx + 'px'; el.style.top = cy + 'px'; el.style.width = cw + 'px'; el.style.height = chh + 'px';
    if (t === 0) el.style.overflow = 'hidden';   /* the client clips every child to its layer */
    if (c.isHidden) el.hidden = true;
    parentEl.appendChild(el);
    const rec = { el, c, x: cx, y: cy, w: cw, h: chh, kids: kids[idx] || [] };
    out[idx] = rec;
    if (t === 0) for (const k of rec.kids) build(k, el, cw, chh);
  };
  for (const r of kids[-1] || []) build(r, host, w, h);
  if (o.names) {   /* component names (gameval14), for callers that address pieces by name */
    try {
      const gv = await getJson('gv/gameval14.json'), cols = gv.byId && gv.byId[ifId] ? gv.byId[ifId].columns : [];
      for (const col of cols) { const i = col.charCodeAt(0); if (out[i] && col.length > 1) out[i].name = col.slice(1); }
    } catch (e) { /* names are a convenience */ }
  }
  return out;
}
/* a nine-slice button face (the client's buttontile sprites, nw n ne w c e sw s se): corners drawn, edges and centre tiled */
function nine(ids, w, h, corner) {
  const box = document.createElement('div');
  box.className = 'osc';
  box.style.width = w + 'px'; box.style.height = h + 'px';
  const k = corner, m = w - 2 * k, n = h - 2 * k;
  const put = (id, x, y, pw, ph, tile) => { if (pw > 0 && ph > 0) at(box, graphic(id, pw, ph, { tile }), x, y); };
  put(ids[0], 0, 0, k, k); put(ids[1], k, 0, m, k, 1); put(ids[2], w - k, 0, k, k);
  put(ids[3], 0, k, k, n, 1); put(ids[4], k, k, m, n, 1); put(ids[5], w - k, k, k, n, 1);
  put(ids[6], 0, h - k, k, k); put(ids[7], k, h - k, m, k, 1); put(ids[8], w - k, h - k, k, k);
  return box;
}
/* a positioned child element at (x, y) w x h inside parent */
function at(parent, el, x, y, w, h) {
  el.classList.add('osc');
  el.style.left = x + 'px'; el.style.top = y + 'px';
  if (w !== undefined) el.style.width = w + 'px';
  if (h !== undefined) el.style.height = h + 'px';
  parent.appendChild(el);
  return el;
}

return { OUT, cfg, iface, enumOf, spriteURL, setSprite, image, spriteMeta, spriteFx, pixelFx, ring, graphic, nine, font, fontNow: id => fontNow.get(id), width, drawString, drawLines, lines, text, mount, at, hex, getJson };
})();
