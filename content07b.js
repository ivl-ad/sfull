"use strict";
/* ---- content07b.js: Gielinor's quests, slayer, clues, travel, music and skill guides (the second half of content07.js) ----
     49f  quests: the list (every quest the cache names, with its points), the journal, and the free-to-play stories this world
          tells in its own words: Cook's Assistant, Sheep Shearer, Rune Mysteries, Imp Catcher, Witch's Potion, The Restless
          Ghost, Romeo & Juliet, Vampire Slayer, Doric's Quest — with the verbs they need (milk, wheat, the mill, shears...)
     49g  talk: the npcs' own chat heads, and what they say when no story needs them
     49h  slayer: the masters' own task lists (weights, amounts, requirements) and kills counted by the monster's slayer category
     49i  treasure trails: the cache's clue steps on their real tiles — dig, talk, search, emote
     49j  travel: the fairy rings' codes and the charter ships' ports
     49k  music: tracks unlock where their hint says; skill guides: every line of the client's own
   A quest's stage is saved in G7.q under the quest's cache id; 100 is done. ---- */

/* ---- 49f. quests ---- */
const QDONE = 100;
const Q7 = {
  cook: { n: "Cook's Assistant" }, sheep: { n: 'Sheep Shearer' }, rune: { n: 'Rune Mysteries' }, imp: { n: 'Imp Catcher' }, witch: { n: "Witch's Potion" },
  ghost: { n: 'The Restless Ghost' }, romeo: { n: 'Romeo & Juliet' }, vamp: { n: 'Vampire Slayer' }, doric: { n: "Doric's Quest" },
};
let q7Rows = null;
function q7Load() {
  if (q7Rows) return Promise.resolve(q7Rows);
  return c7Json('quests.json').then(j => {
    q7Rows = j.q.filter(r => /\w/.test(r[1]));   // the table keeps a few unnamed placeholder rows
    for (const k in Q7) { const r = q7Rows.find(q => q[1] === Q7[k].n); if (r) { Q7[k].id = r[0]; Q7[k].pts = r[10]; } }
    return q7Rows;
  });
}
const qSt = k => (Q7[k].id !== undefined ? G7.q[Q7[k].id] | 0 : 0);
function qSet(k, st) { if (Q7[k].id === undefined) return; G7.q[Q7[k].id] = st; markDirty(1); if (typeof q7Draw === 'function') q7Draw(); }
const qPoints = () => q7Rows ? q7Rows.reduce((a, r) => a + ((G7.q[r[0]] | 0) >= QDONE ? r[10] : 0), 0) : 0;
const has = (name, n) => { const id = c7Item(name); return !!id && invCount(id) >= (n || 1); };
const take = (name, n) => { const id = c7Item(name); if (id) invRemove(id, n || 1); };
function give(name, n) { const id = c7Item(name); if (!id) return; if (!invAdd(id, n || 1)) { dropItem(id, n || 1, P.tx, P.tz, 0, 0, P.plane); say('Your pack is full: it falls at your feet.', 'bad'); } }
function qComplete(k, lines) {
  qSet(k, QDONE);
  sfx(2393);
  const pts = Q7[k].pts || 1;
  showModal('Quest complete!', '<p class="smsg">Congratulations! You have completed <b>' + Q7[k].n + '</b>!</p>' + stRow('Quest points', '+' + pts + ' (total ' + qPoints() + ')') +
    lines.map(l => stRow('Reward', l)).join(''), 'Your journal records it. Well done, adventurer.', 1);
  say('Congratulations, you have completed a quest: ' + Q7[k].n + '!', 'lv');
}
/* each quest: its journal by stage, and the npcs and locs that move it on */
const QJ = {
  cook: ['Speak to the Cook in Lumbridge Castle\'s kitchen.', 'The Cook needs an egg, a bucket of milk and a pot of flour for the Duke\'s cake.'],
  sheep: ['Speak to Fred the Farmer, north-west of Lumbridge.', 'Fred wants 20 balls of wool. Shear his sheep and spin the wool on a spinning wheel.'],
  rune: ['Speak to Duke Horacio on the first floor of Lumbridge Castle.', 'Take the strange talisman to Archmage Sedridor, beneath the Wizards\' Tower.',
    'Deliver the research package to Aubury in his Varrock rune shop.', 'Bring Aubury\'s notes back to Archmage Sedridor.'],
  imp: ['Speak to Wizard Mizgog at the top of the Wizards\' Tower.', 'Mizgog wants his black, red, white and yellow beads back. Imps carry them.'],
  witch: ['Speak to Hetty in Rimmington.', 'Hetty needs a rat\'s tail, an eye of newt, burnt meat and an onion.', 'Drink from Hetty\'s cauldron.'],
  ghost: ['Speak to Father Aereck in Lumbridge church.', 'Find Father Urhney in his shack in Lumbridge Swamp.', 'Wear the amulet of ghostspeak and speak to the ghost by the coffin in the graveyard.',
    'Find the ghost\'s skull: the altar beneath the Wizards\' Tower hides it.', 'Return the skull to the ghost\'s coffin.'],
  romeo: ['Speak to Romeo in Varrock Square.', 'Find Juliet in her house west of Varrock Square.', 'Take Juliet\'s message back to Romeo.', 'Speak to Father Lawrence at the church in north-east Varrock.',
    'Take cadava berries to the Apothecary in south-west Varrock.', 'Take the cadava potion to Juliet.', 'Tell Romeo what has happened.'],
  vamp: ['Speak to Morgan in Draynor Village.', 'Find Dr Harlow at the Blue Moon Inn in Varrock; he likes a beer.', 'Kill Count Draynor in the basement of Draynor Manor — with a stake and a hammer in your pack.'],
  doric: ['Speak to Doric, north of Falador.', 'Doric needs 6 clay, 4 copper ore and 2 iron ore.'],
};
function q7Journal(k) {
  const st = qSt(k), lines = QJ[k] || [];
  if (st >= QDONE) return lines.map(l => '<s>' + l + '</s>').join('<br>') + '<br><br><b style="color:#3fd05a">QUEST COMPLETE!</b>';
  if (!st) return lines[0] || '';
  return lines.slice(0, st).map(l => '<s>' + l + '</s>').join('<br>') + (st ? '<br>' : '') + (lines[st] || lines[lines.length - 1]);
}
/* the stories, as dialogue: each npc handler returns true when it spoke */
const QN = Object.create(null);
QN['cook'] = async n => {
  const st = qSt('cook');
  if (st >= QDONE) return c7Talk(n, [['n', 'Thank you again! The Duke\'s cake was the finest this castle has seen.']]), true;
  if (!st) {
    await c7Talk(n, [['n', 'Oh dear, oh dear, the Duke\'s birthday cake! I have no eggs, no milk and no flour, and the feast is tonight.']]);
    if (await c7Choose(['I\'ll find them for you.', 'Sorry, I\'m busy.']) === 0) { qSet('cook', 1); await c7Talk(n, [['n', 'Bless you! An egg, a bucket of milk and a pot of flour. The farms north of here have all three.']]); }
    return true;
  }
  const need = [['egg', 'an egg'], ['bucket of milk', 'a bucket of milk'], ['pot of flour', 'a pot of flour']].filter(([i]) => !has(i));
  if (need.length) return c7Talk(n, [['n', 'I still need ' + need.map(r => r[1]).join(', ') + '. Hurry, please!']]), true;
  for (const i of ['egg', 'bucket of milk', 'pot of flour']) take(i);
  await c7Talk(n, [['p', 'Here you are: an egg, milk and flour.'], ['n', 'Wonderful! The cake is saved. Take this for your trouble.']]);
  gainXp('cooking', 300); give('coins', 250);
  qComplete('cook', ['300 Cooking xp', '250 coins']);
  return true;
};
QN['fred the farmer'] = async n => {
  const st = qSt('sheep');
  if (st >= QDONE) return c7Talk(n, [['n', 'The sheep are cooler for it, and I\'ve wool to sell. Good work.']]), true;
  if (!st) {
    await c7Talk(n, [['n', 'My sheep are sweltering in their fleeces. Shear them and spin me twenty balls of wool, and I\'ll pay.']]);
    if (await c7Choose(['I\'ll do it.', 'No thanks.']) === 0) { qSet('sheep', 1); await c7Talk(n, [['n', 'Take shears to them, then spin the wool on a spinning wheel. Lumbridge Castle has one upstairs.']]); if (!has('shears')) give('shears'); }
    return true;
  }
  const w = invCount(c7Item('ball of wool') || '');
  if (w < 20) return c7Talk(n, [['n', 'That\'s ' + w + ' ball' + (w === 1 ? '' : 's') + ' of wool. I need twenty.']]), true;
  take('ball of wool', 20);
  await c7Talk(n, [['n', 'Twenty balls of good wool. Here\'s your pay, as promised.']]);
  gainXp('crafting', 150); give('coins', 60);
  qComplete('sheep', ['150 Crafting xp', '60 coins']);
  return true;
};
QN['duke horacio'] = async n => {
  const st = qSt('rune');
  if (st >= QDONE || st > 1) return c7Talk(n, [['n', 'Lumbridge welcomes you, adventurer.']]), true;
  if (!st) {
    await c7Talk(n, [['n', 'This talisman was found on the old ruins. It hums. The wizards at the tower south of Draynor should see it.']]);
    if (await c7Choose(['I\'ll take it to them.', 'Not now.']) === 0) { qSet('rune', 1); give('air talisman'); await c7Talk(n, [['n', 'Seek Archmage Sedridor, beneath the Wizards\' Tower.']]); }
    return true;
  }
  if (!has('air talisman')) { give('air talisman'); return c7Talk(n, [['n', 'You lost it? Here, I found another.']]), true; }
  return c7Talk(n, [['n', 'Archmage Sedridor, beneath the Wizards\' Tower. Please hurry.']]), true;
};
const sedridor = async n => {
  const st = qSt('rune');
  if (st === 1 && has('air talisman')) {
    take('air talisman');
    await c7Talk(n, [['p', 'The Duke sent this talisman.'], ['n', 'An air talisman! Then the old altars can be found again. Take this package to Aubury in Varrock at once.']]);
    give('research package'); qSet('rune', 2); return true;
  }
  if (st === 2) { if (!has('research package')) give('research package'); return c7Talk(n, [['n', 'Aubury, in Varrock. He sells runes by the square.']]), true; }
  if (st === 3 && has('notes')) {
    take('notes');
    await c7Talk(n, [['n', 'Aubury\'s notes confirm it: the essence can be reached. Keep the talisman, and my thanks.']]);
    give('air talisman'); qComplete('rune', ['An air talisman', 'Aubury will teleport you to the rune essence']);
    return true;
  }
  return false;
};
QN['archmage sedridor'] = QN['sedridor'] = sedridor;
QN['aubury'] = async n => {
  const st = qSt('rune');
  if (st === 2 && has('research package')) {
    take('research package');
    await c7Talk(n, [['n', 'From Sedridor? Let me look... yes. Take these notes back to him.']]);
    give('notes'); qSet('rune', 3); return true;
  }
  if (st === 3 && !has('notes')) { give('notes'); return c7Talk(n, [['n', 'You dropped the notes? Here are more.']]), true; }
  return false;
};
QN['wizard mizgog'] = async n => {
  const st = qSt('imp'), beads = ['black bead', 'red bead', 'white bead', 'yellow bead'];
  if (st >= QDONE) return c7Talk(n, [['n', 'My beads are back where they belong. Thank you.']]), true;
  if (!st) {
    await c7Talk(n, [['n', 'Imps stole my magic beads! Black, red, white and yellow. Would you get them back?']]);
    if (await c7Choose(['Of course.', 'I\'d rather not.']) === 0) { qSet('imp', 1); await c7Talk(n, [['n', 'Imps teleport about, but they carry what they steal. Hunt them.']]); }
    return true;
  }
  const miss = beads.filter(b => !has(b));
  if (miss.length) return c7Talk(n, [['n', 'I still need the ' + miss.join(', ') + '.']]), true;
  for (const b of beads) take(b);
  await c7Talk(n, [['n', 'All four! Take this amulet; it steadies the hand.']]);
  gainXp('magic', 875); give('amulet of accuracy');
  qComplete('imp', ['875 Magic xp', 'Amulet of accuracy']);
  return true;
};
QN['hetty'] = async n => {
  const st = qSt('witch'), need = [["rat's tail", 'a rat\'s tail'], ['eye of newt', 'an eye of newt'], ['burnt meat', 'burnt meat'], ['onion', 'an onion']];
  if (st >= QDONE) return c7Talk(n, [['n', 'Feeling the power, dearie?']]), true;
  if (!st) {
    await c7Talk(n, [['n', 'Want to learn a little magic, dearie? Bring me the makings of a potion.']]);
    if (await c7Choose(['Yes please.', 'No thanks.']) === 0) { qSet('witch', 1); await c7Talk(n, [['n', 'A rat\'s tail, an eye of newt, some burnt meat and an onion. Off you go.']]); }
    return true;
  }
  if (st === 1) {
    const miss = need.filter(([i]) => !has(i));
    if (miss.length) return c7Talk(n, [['n', 'I still need ' + miss.map(r => r[1]).join(', ') + '.']]), true;
    for (const [i] of need) take(i);
    await c7Talk(n, [['n', 'Into the cauldron... there. Now drink from it, dearie.']]);
    qSet('witch', 2); return true;
  }
  return c7Talk(n, [['n', 'The cauldron, dearie. Drink!']]), true;
};
QN['father aereck'] = async n => {
  const st = qSt('ghost');
  if (st >= QDONE) return c7Talk(n, [['n', 'The graveyard is quiet at last. Bless you.']]), true;
  if (!st) {
    await c7Talk(n, [['n', 'A ghost haunts our graveyard and frightens the congregation. Father Urhney in the swamp may know what to do.']]);
    if (await c7Choose(['I\'ll help.', 'Ghosts? No thank you.']) === 0) qSet('ghost', 1);
    return true;
  }
  return c7Talk(n, [['n', 'Any news of our ghost?']]), true;
};
QN['father urhney'] = async n => {
  const st = qSt('ghost');
  if (st === 1 || (st > 1 && st < QDONE && !has('ghostspeak amulet') && !(eq.neck && ITEMS[eq.neck].name.toLowerCase() === 'ghostspeak amulet'))) {
    await c7Talk(n, [['n', 'Aereck sent you? Hmph. Wear this amulet and you\'ll hear what the ghost wants.']]);
    give('ghostspeak amulet'); if (st === 1) qSet('ghost', 2); return true;
  }
  return c7Talk(n, [['n', 'Leave an old man in peace.']]), true;
};
QN['restless ghost'] = async n => {
  const st = qSt('ghost'), worn = eq.neck && ITEMS[eq.neck].name.toLowerCase() === 'ghostspeak amulet';
  if (!worn) return c7Talk(n, [['n', 'Wooo wooo wooooo!']]), true;
  if (st === 2) { await c7Talk(n, [['n', 'You can hear me! A warlock took my skull. I cannot rest without it.'], ['p', 'I\'ll find it.']]); qSet('ghost', 3); return true; }
  if (st === 4 && has("ghost's skull")) return c7Talk(n, [['n', 'My skull! Put it in my coffin, please.']]), true;
  return c7Talk(n, [['n', 'My skull... find my skull...']]), true;
};
QN['romeo'] = async n => {
  const st = qSt('romeo');
  if (st >= QDONE) return c7Talk(n, [['n', 'Juliet and I are together at last. Thank you, friend.']]), true;
  if (!st) {
    await c7Talk(n, [['n', 'Juliet! I cannot find my Juliet. Would you carry a message to her?']]);
    if (await c7Choose(['I\'ll find her.', 'Not my business.']) === 0) qSet('romeo', 1);
    return true;
  }
  if (st === 2) { await c7Talk(n, [['p', 'Juliet\'s father keeps her locked away.'], ['n', 'Then Father Lawrence must help us!']]); qSet('romeo', 3); return true; }
  if (st === 6) { await c7Talk(n, [['p', 'Juliet only seems dead. She will wake.'], ['n', 'A trick to fool her father? I shall be waiting.']]); qComplete('romeo', ['5 quest points', 'A happy ending']); return true; }
  return c7Talk(n, [['n', 'Any word from my Juliet?']]), true;
};
QN['juliet'] = async n => {
  const st = qSt('romeo');
  if (st === 1) { await c7Talk(n, [['n', 'Romeo sent you? Tell him my father will not let me leave!']]); qSet('romeo', 2); return true; }
  if (st === 5 && has('cadava potion')) { take('cadava potion'); await c7Talk(n, [['n', 'This will make me seem asleep as the dead? Then tell Romeo!']]); qSet('romeo', 6); return true; }
  return c7Talk(n, [['n', 'Romeo, oh Romeo...']]), true;
};
QN['father lawrence'] = async n => {
  if (qSt('romeo') === 3) { await c7Talk(n, [['n', 'A potion to feign death would free her. The Apothecary can brew one, from cadava berries.']]); qSet('romeo', 4); return true; }
  return false;
};
QN['apothecary'] = async n => {
  const st = qSt('romeo');
  if (st === 4) {
    if (!has('cadava berries')) return c7Talk(n, [['n', 'Cadava berries, from the bushes by the mine south-east of Varrock. Then I can brew it.']]), true;
    take('cadava berries'); give('cadava potion');
    await c7Talk(n, [['n', 'There: sleep so deep it looks like death. Carefully now.']]); qSet('romeo', 5); return true;
  }
  return false;
};
QN['morgan'] = async n => {
  const st = qSt('vamp');
  if (st >= QDONE) return c7Talk(n, [['n', 'We sleep safely now. Thank you!']]), true;
  if (!st) {
    await c7Talk(n, [['n', 'A vampire in the manor preys on our village! Dr Harlow once hunted such things. Please, help us.']]);
    if (await c7Choose(['I\'ll deal with the vampire.', 'Too dangerous.']) === 0) qSet('vamp', 1);
    return true;
  }
  return c7Talk(n, [['n', 'Find Dr Harlow at the Blue Moon Inn in Varrock.']]), true;
};
QN['dr harlow'] = async n => {
  const st = qSt('vamp');
  if (st !== 1) return c7Talk(n, [['n', 'Buy me a drink, would you?']]), true;
  if (!has('beer')) return c7Talk(n, [['n', 'Vampires? Talk is thirsty work. Buy me a beer first.']]), true;
  take('beer');
  await c7Talk(n, [['n', 'Ahh. Here: a stake. Hammer it through the Count\'s heart. Garlic helps.']]);
  give('stake'); if (!has('hammer')) give('hammer'); qSet('vamp', 2); return true;
};
QN['doric'] = async n => {
  const st = qSt('doric'), need = [['clay', 6], ['copper ore', 4], ['iron ore', 2]];
  if (st >= QDONE) return c7Talk(n, [['n', 'Use my anvils any time.']]), true;
  if (!st) {
    await c7Talk(n, [['n', 'I\'m short of materials. Bring me 6 clay, 4 copper ore and 2 iron ore and I\'ll pay you well.']]);
    if (await c7Choose(['I\'ll fetch them.', 'No.']) === 0) qSet('doric', 1);
    return true;
  }
  const miss = need.filter(([i, c]) => !has(i, c));
  if (miss.length) return c7Talk(n, [['n', 'Still need ' + miss.map(([i, c]) => c + ' ' + i).join(', ') + '.']]), true;
  for (const [i, c] of need) take(i, c);
  await c7Talk(n, [['n', 'Perfect. Here\'s your pay.']]);
  gainXp('mining', 1300); give('coins', 180);
  qComplete('doric', ['1300 Mining xp', '180 coins']);
  return true;
};
/* the drops a story needs, while it needs them */
onKill.push((n, drop) => {
  if (!M7 || !n.name) return;
  const nm = n.name.toLowerCase();
  if (nm === 'imp' && qSt('imp') === 1 && Math.random() < 0.35) { const miss = ['black bead', 'red bead', 'white bead', 'yellow bead'].filter(b => !has(b)); if (miss.length) { const id = c7Item(miss[randInt(0, miss.length - 1)]); if (id) drop(id, 1); } }
  if (/^(giant )?rat$/.test(nm) && qSt('witch') === 1 && !has("rat's tail")) { const id = c7Item("rat's tail"); if (id) drop(id, 1); }
  if (nm === 'count draynor' && qSt('vamp') === 2) {
    if (has('stake') && has('hammer')) { take('stake'); qComplete('vamp', ['4825 Attack xp']); gainXp('attack', 4825); }
    else say('The vampire\'s wounds close before your eyes. You need a stake and a hammer!', 'bad');
  }
  if (G7.sl) c7SlayKill(n);
});
/* the npcs a story needs where the spawn table has none: [name, x, y, plane] at their 2007 posts */
const Q7_NPCS = [['Cook', 3209, 3215, 0], ['Archmage Sedridor', 3104, 9571, 0], ['Aubury', 3253, 3401, 0], ['Wizard Mizgog', 3103, 3163, 2], ['Juliet', 3158, 3425, 1],
  ['Morgan', 3098, 3268, 0], ['Dr Harlow', 3222, 3398, 0], ['Count Draynor', 3078, 9775, 0], ['Restless ghost', 3250, 3193, 0]];
let q7NpcIds = null;
const q7NpcAll = Object.create(null), q7Asked = new Set();
function q7Npcs() {   /* resolve the names once; raise a missing one near you */
  if (!q7NpcIds) {
    q7NpcIds = {};
    OSRSK.resolveJSON('npc').then(async rv => {
      for (const [nm] of Q7_NPCS) {
        q7NpcAll[nm] = new Set(rv[nm.toLowerCase()] || []);
        const ids = (rv[nm.toLowerCase()] || []).slice(0, 12), dd = await MAP07.defs('npc', ids);
        const id = ids.find(i => dd[i] && dd[i].models && (MAP07.opsOf(dd[i]).includes('Talk-to') || MAP07.opsOf(dd[i]).includes('Attack')));
        if (id !== undefined) q7NpcIds[nm] = id;
      }
    }, () => { q7NpcIds = null; });
    return;
  }
  Q7_NPCS.forEach(([nm, x, y, pl], i) => {
    const id = q7NpcIds[nm], key = 'q' + i;
    if (id === undefined || m7Live.has(key) || npcDead.has(key) || Math.abs(x - P.tx) > 30 || Math.abs(-y - P.tz) > 30 || !MAP07.regionAt(x, y)) return;
    const all = q7NpcAll[nm];   // the spawn table has one here already? asked of the table, since its figure may not have risen yet
    for (const R of MAP07.regions.values()) {
      if (Math.abs(R.sqX * 64 + 32 - x) > 64 || Math.abs(R.sqY * 64 + 32 - y) > 64) continue;   // the post's square and its neighbours
      if (!R.ready) return;
      const near = R.spawns ? R.spawns.filter(s => Math.abs(s.x - x) < 16 && Math.abs(s.y - y) < 16) : [];
      const unread = near.filter(s => !all.has(s.id) && !q7Asked.has(s.id) && !MAP07.npcDefOf(s.id)).map(s => s.id);
      if (unread.length) { const done = () => unread.forEach(i => q7Asked.add(i)); MAP07.defs('npc', unread).then(done, done); return; }   // an older id may wear the name: read them, ask again next pass
      if (near.some(s => { const d = all.has(s.id) || MAP07.npcDefOf(s.id); return d === true || (d && d.name && MAP07.clean(d.name).toLowerCase() === nm.toLowerCase()); })) return;
    }
    if (MAP07.npcDefOf(id)) m7Spawn({ id, x, y, plane: pl }, key); else MAP07.defs('npc', [id]);
  });
}
/* the quest list: the 2007 quest tab (red not started, yellow started, green done) in the frame's quest stone, or a modal */
function q7ListHtml() {
  if (!q7Rows) { q7Load().then(() => q7Draw()); return 'Reading the quest list…'; }
  const told = new Set(Object.values(Q7).map(q => q.id)), col = r => { const s = G7.q[r[0]] | 0; return s >= QDONE ? 2 : s ? 1 : 0; };
  const group = (title, rows) => '<div class="qh">' + title + '</div>' + rows.map(r => '<a class="q' + col(r) + '" data-q7="' + r[0] + '"' + (told.has(r[0]) ? '' : ' style="opacity:.55"') + '>' + r[1] + '</a>').join('');
  const byName = (a, b) => a[1].localeCompare(b[1]);
  return '<div class="qlist"><div class="qh">Quest Points: ' + qPoints() + '</div>' + group('Free Quests', q7Rows.filter(r => !r[2] && !r[3]).sort(byName)) +
    group('Members\' Quests', q7Rows.filter(r => !r[2] && r[3]).sort(byName)) + group('Miniquests', q7Rows.filter(r => r[2]).sort(byName)) + '</div>';
}
const Q7_DIFF = ['Novice', 'Intermediate', 'Experienced', 'Master', 'Grandmaster', 'Special'], Q7_LEN = ['Very short', 'Short', 'Medium', 'Long', 'Very long'];
function q7Open(id) {
  const r = q7Rows && q7Rows.find(q => q[0] === id);
  if (!r) return;
  const k = Object.keys(Q7).find(q => Q7[q].id === id);
  const stats = []; for (let i = 0; i + 1 < r[11].length; i += 2) stats.push(r[11][i + 1] + ' ' + (C7_STAT[r[11][i]] || 'skill'));
  const body = (k ? '<p class="smsg">' + q7Journal(k) + '</p>' : '<p class="smsg">This story has not been told in this world yet. Its start is marked on the map where the 2007 journal began it.</p>') +
    stRow('Difficulty', Q7_DIFF[r[4]] || '—') + stRow('Length', Q7_LEN[r[5]] || '—') + stRow('Members', r[3] ? 'Yes' : 'No') + stRow('Quest points', r[10]) +
    (stats.length ? stRow('Skills needed', stats.join(', ')) : '') + (r[6] ? stRow('Start', r[6] + ', ' + r[7] + (r[8] ? ' (floor ' + r[8] + ')' : '')) : '');
  showModal(r[1], body, 'Quest points: ' + qPoints());
}
const C7_STAT = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Slayer', 'Farming', 'Runecraft', 'Hunter', 'Construction', 'Sailing'];
let q7Pane = null;
function q7Draw() {
  const html = q7ListHtml();
  if (q7Pane) q7Pane.innerHTML = html;
  const m = el('modalBody');
  if (m && m.querySelector('.qlist') && el('modal').classList.contains('on')) m.innerHTML = html;
}
function q7Show() { showModal('Quest List', q7ListHtml(), 'Red: not started · yellow: under way · green: complete', 1); }
on(document, 'click', e => { const a = e.target.closest('[data-q7]'); if (a) q7Open(+a.dataset.q7); });

/* the verbs the stories need, on the map's own scenery */
const Q7_MILL = { grain: 0 };
function c7LocOp(ud, op, o, out) {
  if (!M7) return false;
  const nm = ud.name.toLowerCase(), low = op.toLowerCase(), push = f => { out.push({ t: op, o: ud.name, f: act(o, f) }); return true; };
  if (/^dairy cow$/.test(nm) && low === 'milk') return push(() => { if (!has('bucket')) return say('You need a bucket to milk the cow.'); take('bucket'); give('bucket of milk'); sfx(2663); say('You milk the cow.'); });
  if (nm === 'wheat' && low === 'pick') return push(() => { give('grain'); say('You pick some wheat.'); });
  if (nm === 'hopper' && /fill|put/.test(low)) return push(() => { if (!has('grain')) return say('You have no grain to put in the hopper.'); take('grain'); Q7_MILL.grain++; say('You put the grain in the hopper.'); });
  if (/hopper controls/.test(nm) && /operate|pull/.test(low)) return push(() => { if (!Q7_MILL.grain) return say('The hopper is empty.'); Q7_MILL.flour = (Q7_MILL.flour || 0) + Q7_MILL.grain; Q7_MILL.grain = 0; sfx(2398); say('You operate the hopper. Flour falls into the bin below.'); });
  if (nm === 'flour bin' && low === 'empty') return push(() => { if (!Q7_MILL.flour) return say('The flour bin is empty.'); if (!has('pot')) return say('You need a pot to hold the flour.'); take('pot'); give('pot of flour'); Q7_MILL.flour--; say('You fill a pot with flour.'); });
  if (/^(onion|cabbage)$/.test(nm) && low === 'pick') return push(() => { give(nm); say('You pick ' + aOrAn(nm) + '.'); });
  if (/cadava bush/.test(nm) && /pick/.test(low)) return push(() => { give('cadava berries'); say('You pick some cadava berries.'); });
  if (/spinning wheel/.test(nm) && low === 'spin') return push(() => { const w = invCount(c7Item('wool') || ''); if (!w) return say('You have no wool to spin.'); take('wool', w); give('ball of wool', w); gainXp('crafting', 2.5 * w); say('You spin the wool into ' + w + ' ball' + (w > 1 ? 's' : '') + ' of wool.'); });
  if (/^clay rocks?$/.test(nm) && low === 'mine') return push(() => { if (!inv.some(s => s && /pickaxe/.test(ITEMS[s.id].name.toLowerCase())) && !(eq.weapon && /pickaxe/.test(ITEMS[eq.weapon].name.toLowerCase()))) return say('You need a pickaxe to mine this rock.'); give('clay'); gainXp('mining', 5); say('You mine some clay.'); });
  if (nm === 'altar' && low === 'search' && Math.abs(ud.gx - 3120) < 12 && Math.abs(ud.gy - 9567) < 12) return push(() => { if (qSt('ghost') === 3) { give("ghost's skull"); qSet('ghost', 4); say('You find a skull hidden in the altar!', 'lv'); } else say('You find nothing of interest.'); });
  if (nm === 'coffin' && /open|search|close/.test(low) && Math.abs(ud.gx - 3250) < 8 && Math.abs(ud.gy - 3193) < 8) return push(() => {
    if (qSt('ghost') === 4 && has("ghost's skull")) { take("ghost's skull"); gainXp('prayer', 1125); qComplete('ghost', ['1125 Prayer xp']); }
    else say(qSt('ghost') >= QDONE ? 'The coffin holds the ghost\'s bones, at rest.' : 'You see the headless remains of a body.');
  });
  if (nm === 'cauldron' && /drink/.test(low) && Math.abs(ud.gx - 2967) < 8 && Math.abs(ud.gy - 3205) < 8) return push(() => { if (qSt('witch') === 2) { gainXp('magic', 325); qComplete('witch', ['325 Magic xp']); } else say('You\'d better not.'); });
  if (/^pay-toll/.test(low) && ud.door) return push(() => {   // the Al Kharid gate: ten coins swing it open (a door never blocks, so the toll is a courtesy)
    if (!ud.ops.includes('Open')) return say('The gate is already open.');
    if (invCount('coins') < 10) return say('You need 10 coins to pay the toll.', 'bad');
    invRemove('coins', 10); gpSunk += 10; m7Door(ud, 'Open'); say('You pay the guard 10 coins and pass through the gate.');
  });
  if (typeof c7ClueLoc === 'function' && c7ClueLoc(ud, op, o, out)) return true;
  if (/fairy ring/.test(nm)) return push(() => c7FairyRing());
  return false;
}
/* an npc's op the game has no verb for */
function c7NpcOp(n, op) {
  const low = op.toLowerCase(), nm = n.name.toLowerCase();
  if (nm === 'sheep' && low === 'shear') { if (!has('shears')) { say('You need shears to shear the sheep.'); return true; } give('wool'); sfx(761); say('You get some wool.'); return true; }
  if (low === 'charter' || (/trader/.test(nm) && /charter|travel/.test(low))) { c7Charter(); return true; }
  return false;
}

/* ---- 49g. talk: a story first, then a clue step, then an ordinary word with the npc's own chat head ---- */
const C7_SMALL = ['Hello there, adventurer.', 'Lovely weather, isn\'t it?', 'I\'m rather busy just now.', 'Have you been to Varrock lately?', 'Mind how you go.', 'Good day to you.',
  'They say the Grand Exchange is the place to trade these days.', 'Watch out for goblins on the roads.'];
async function c7TalkTo(n) {
  const nm = n.name.toLowerCase(), lumbridgeCook = Math.abs(n.tx - 3209) < 20 && Math.abs(n.tz + 3215) < 20, h = nm === 'cook' && !lumbridgeCook ? null : QN[nm];
  await q7Load().catch(() => {});
  if (h && await h(n)) return;
  if (typeof c7ClueNpc === 'function' && await c7ClueNpc(n)) return;
  if (M7_SLAYER[nm] !== undefined) return c7Talk(n, [['n', 'Need a task? Ask me for an assignment.']]);
  await c7Talk(n, [['p', 'Hello.'], ['n', C7_SMALL[(n.kh >>> 0) % C7_SMALL.length]]]);
}

/* ---- 49h. slayer: the master's own list ---- */
const C7_MASTER = { turael: 'turael', spria: 'spria', mazchna: 'mazchna', achtryn: 'mazchna', vannaka: 'vannaka', chaeldar: 'chaeldar', nieve: 'nieve', steve: 'nieve', duradel: 'duradel', kuradal: 'duradel', krystilia: 'krystillia', konar: 'konar', 'konar quo maten': 'konar' };
const C7_MASTER_CB = { turael: 0, spria: 0, mazchna: 20, vannaka: 40, chaeldar: 70, nieve: 85, duradel: 100, krystillia: 0, konar: 75 };
async function c7Slayer(n) {
  const S = await c7Json('slayer.json').catch(() => null), key = C7_MASTER[n.name.toLowerCase()];
  if (!S || !key || !S.masters[key]) return say(n.name + ' has no tasks to give in this world.');
  const cur = G7.sl, task = cur && S.tasks[cur[1]];
  if (cur && task) {
    await c7Talk(n, [['n', 'You\'re still hunting ' + task[0].toLowerCase() + '. ' + cur[2] + ' to go.']]);
    if (await c7Choose(['Keep going.', 'Cancel the task.']) === 1) { G7.sl = null; markDirty(2); say('You cancel your Slayer task.'); }
    return;
  }
  if (combatLevel() < (C7_MASTER_CB[key] || 0)) return c7Talk(n, [['n', 'Come back when you\'re combat level ' + C7_MASTER_CB[key] + '.']]);
  const pool = S.masters[key].filter(([tid]) => { const t = S.tasks[tid]; if (!t || t[1] > combatLevel() || (t[3] && t[3].length)) return false; for (let i = 0; i + 1 < t[2].length; i += 2) if ((lvl[SK[C7_STAT[t[2][i]].toLowerCase()]] || 0) < t[2][i + 1]) return false; return true; });
  if (!pool.length) return c7Talk(n, [['n', 'I have nothing you can handle yet.']]);
  let w = 0; for (const r of pool) w += r[1];
  let roll = Math.random() * w, pick = pool[0];
  for (const r of pool) { roll -= r[1]; if (roll <= 0) { pick = r; break; } }
  const amt = randInt(pick[2], pick[3]);
  G7.sl = [Object.keys(C7_MASTER_CB).indexOf(key), pick[0], amt]; markDirty(2);
  await c7Talk(n, [['n', 'Your new task is to kill ' + amt + ' ' + S.tasks[pick[0]][0].toLowerCase() + '.' + (S.tasks[pick[0]][4] ? ' ' + String(S.tasks[pick[0]][4]).replace(/<[^>]*>/g, '') : '')]]);
}
function c7SlayKill(n) {   /* the monster's slayer category (npc params[50]) is the task's id */
  const d = n.c7 !== undefined ? MAP07.npcDefOf(n.c7) : null, cat = d && d.params ? d.params[50] : undefined;
  if (cat === undefined || cat !== G7.sl[1]) return;
  gainXp('slayer', n.maxhp || n.t.hp || 1);
  if (--G7.sl[2] > 0) return markDirty();
  G7.sl = null; markDirty(2);
  say('You\'ve completed your Slayer task. Return to a Slayer Master for another.', 'lv');
}

/* ---- 49i. treasure trails on the real map: the tier's own steps (the game's easy/medium/hard are the cache's 1/2/3) ---- */
const C7_CLUE_STEPS = [2, 3, 4];
function c7ClueSpot(i) {   /* -> [x, z, tier] for game.js, and the trail in G7.clue: [tier, step, left, x, y] */
  const C = c7Get('clues.json');
  if (!C) return null;
  const nEm = Object.keys(C7_EMOTE).length;   // an emote step names its emote by the tab's order
  const rows = C.c.map((r, k) => [r, k]).filter(([r]) => r[0] === i + 1 && MAP07.manifest().has(((r[3] >> 6) << 8) | (r[4] >> 6)) && r[5] === 0 && (r[1] !== 'emote' || (r[7] >= 0 && r[7] < nEm)));
  if (!rows.length) return null;
  const [r, k] = rows[randInt(0, rows.length - 1)], left = G7.clue && G7.clue[0] === i ? G7.clue[2] : C7_CLUE_STEPS[i];
  G7.clue = [i, k, left, r[3], r[4]];
  return [r[3], -r[4], i];
}
function c7ClueStep() { const C = c7Get('clues.json'); return C && G7.clue ? C.c[G7.clue[1]] : null; }
function c7ReadClue(i) {
  const s = c7ClueStep();
  if (!s || G7.clue[0] !== i) { if (!(P.clue = c7ClueSpot(i))) return say('The ink has run; you cannot make the scroll out here.'); return c7ReadClue(i); }
  const dx = s[3] - P.tx, dz = -s[4] - P.tz, far = Math.round(Math.hypot(dx, dz)), dir = COMPASS[Math.round(Math.atan2(dx, -dz) / (PI / 4)) & 7].split(' ')[0];
  const how = s[1] === 'dig' ? 'Dig here with a spade.' : s[1] === 'npc' ? 'Speak to them.' : s[1] === 'loc' ? 'Search it.' : 'Perform the emote there.';
  showModal('Clue scroll', '<p class="smsg" style="font-family:serif;font-size:15px;text-align:center">' + String(s[2]).replace(/</g, '&lt;').replace(/&lt;br>/gi, '<br>') + '</p>' +
    stRow('Kind', s[9]) + stRow('Steps left', G7.clue[2]) + stRow('Distance', far + ' tiles ' + dir) + (far < 40 ? stRow('Hint', s[8] || how) : ''), how);
}
function c7ClueAdvance() {
  const i = G7.clue[0];
  if (--G7.clue[2] > 0) { P.clue = c7ClueSpot(i); say('You find another clue scroll.', 'lv'); markDirty(2); return; }
  invRemove('clue_' + i, 1); invAdd('casket_' + i, 1); P.clue = null; G7.clue = null; markDirty(2);
  say('You find a casket!', 'lv');
}
function c7ClueDig() {   /* true when a Gielinor dig step took the spade */
  const s = c7ClueStep();
  if (!s || s[1] !== 'dig' || !invCount('clue_' + G7.clue[0]) || chebDist(P.tx, -P.tz, s[3], s[4]) > 1) return false;
  kneel(); sfx(1470); c7ClueAdvance(); return true;
}
async function c7ClueNpc(n) {
  const s = c7ClueStep();
  if (!s || s[1] !== 'npc' || !invCount('clue_' + G7.clue[0]) || chebDist(n.tx, -n.tz, s[3], s[4]) > 12) return false;
  const want = MAP07.npcDefOf(s[6]);   // the step names one npc id; any id wearing that npc's name at the spot will do
  if (n.c7 !== s[6] && !(want && MAP07.clean(want.name) === n.name)) { if (!want) MAP07.defs('npc', [s[6]]); return false; }
  await c7Talk(n, [['n', 'Ah, a clue scroll. Here, this is for you.']]);
  c7ClueAdvance();
  return true;
}
function c7ClueLoc(ud, op, o, out) {
  const s = c7ClueStep();
  if (!s || s[1] !== 'loc' || !G7.clue || !/search|open/i.test(op) || chebDist(ud.gx, ud.gy, s[3], s[4]) > 2) return false;
  out.push({ t: op, o: ud.name, f: act(o, () => { if (invCount('clue_' + G7.clue[0])) c7ClueAdvance(); else say('You find nothing.'); }) });
  return true;
}
function c7ClueEmote(key) {
  const s = c7ClueStep();
  if (!s || s[1] !== 'emote' || s[7] !== key || !invCount('clue_' + G7.clue[0]) || chebDist(P.tx, -P.tz, s[3], s[4]) > 3) return;
  setTimeout(c7ClueAdvance, 1800);
}

/* ---- 49j. travel ---- */
async function c7FairyRing() {
  const T = await c7Json('travel.json').catch(() => null);
  if (!T) return;
  const rows = T.fairy.filter(f => MAP07.manifest().has(((f[1] >> 6) << 8) | (f[2] >> 6))).sort((a, b) => a[0].localeCompare(b[0]));
  showModal('Fairy ring', '<p class="smsg">Turn the dials to a code.</p>' + rows.map((f, i) => '<div class="li" data-fr="' + i + '"><span>' + f[0] + '</span><u>' + (f[4] || (f[1] + ', ' + f[2])) + '</u></div>').join(''), 'The ring carries you to the ring the code names.');
  el('modalBody').onclick = e => { const d = e.target.closest('[data-fr]'); if (!d) return; const f = rows[+d.dataset.fr]; el('modalBody').onclick = null; tpTo(f[1], -f[2], 'through the fairy ring (' + f[0] + ')', 30, f[3]); };
}
async function c7Charter() {
  const T = await c7Json('travel.json').catch(() => null);
  if (!T) return;
  const rows = T.charter.filter(c => MAP07.manifest().has(((c[1] >> 6) << 8) | (c[2] >> 6))).map(c => [...c, Math.max(100, Math.round(Math.hypot(c[1] - P.tx, c[2] + P.tz) / 4) * 10)]).sort((a, b) => a[4] - b[4]);
  showModal('Charter a ship', rows.map((c, i) => '<div class="li" data-ch="' + i + '"><span>' + c[0] + '</span><u>' + c[4] + ' coins</u></div>').join(''), 'The fare is by distance.');
  el('modalBody').onclick = e => {
    const d = e.target.closest('[data-ch]'); if (!d) return;
    const c = rows[+d.dataset.ch]; el('modalBody').onclick = null;
    if (invCount('coins') < c[4]) return say('You need ' + c[4] + ' coins for that voyage.', 'bad');
    invRemove('coins', c[4]); gpSunk += c[4]; closeOverlays(); teleport(c[1], -c[2], 300, c[3]); say('You sail to ' + c[0] + '.', 'lv');
  };
}

/* ---- 49k. music and skill guides ---- */
let c7MuT = 0, c7MuIdx = null;
function c7MusicIndex() {   /* place-name words in each hint that match a town or area this world names */
  const M = c7Get('music.json');
  if (!M || c7MuIdx) return c7MuIdx;
  const places = M7_TOWNS.map(t => t[0]).concat(M7_AREAS.map(a => a[0].replace(/^the /, ''))).map(s => s.toLowerCase());
  c7MuIdx = new Map();
  const where = /^(?:in the area around|in|at|on|near|around|outside)\s+(?:the\s+)?(.+?)\.?$/;   // "in Varrock.", not "in the Varrock Museum" or "during a quest"
  M.t.forEach((t, i) => { const w = where.exec(t[1].toLowerCase()); if (!w || t[4]) return; const p = w[1]; if (places.includes(p)) { if (!c7MuIdx.has(p)) c7MuIdx.set(p, []); c7MuIdx.get(p).push(i); } });
  return c7MuIdx;
}
function c7MusicTick() {
  const idx = c7MusicIndex();
  if (!idx) return;
  const here = m7Place(P.tx, P.tz).toLowerCase().replace(/^the /, '').replace(/, floor \d$/, '');
  const M = c7Get('music.json');
  for (const i of idx.get(here) || []) if (!G7.mu.has(i)) { G7.mu.add(i); markDirty(); say('You have unlocked a new music track: ' + M.t[i][0] + '.', 'lv'); }
}
function c7MusicOpen(name, auto) {   /* for the 2007 music tab */
  const M = c7Get('music.json');
  if (!M) return auto;
  const i = M.t.findIndex(t => t[0] === name);
  return auto || (i >= 0 && G7.mu.has(i));
}
async function c7Guide(i) {
  const G = await c7Json('guide.json').catch(() => null), k = SKILLS[i].k, key = k === 'runecraft' ? 'runecraft' : k;
  if (!G || !G.sec[key]) return false;
  const secs = G.sec[key], lines = G.f.filter(f => f[0] === key);
  let sel = secs[0][0];
  const draw = () => {
    const tabs = secs.map(s => '<a class="chip' + (s[0] === sel ? ' on' : '') + '" data-gs="' + s[0] + '">' + s[1] + '</a>').join(' ');
    const rows = lines.filter(f => f[2] === sel).map(f => '<div class="stRow g' + (lvl[i] < f[1] ? ' no' : '') + '"><i>' + (f[1] > 0 ? f[1] : '') + '</i><b>' + f[3].replace(/<[^>]*>/g, '') + (f[5] ? ' <span style="color:#ffb347">★</span>' : '') + '</b></div>').join('');
    showModal(SKILLS[i].f + ' guide', '<div class="chips">' + tabs + '</div>' + (rows || '<p class="smsg">Nothing listed.</p>'), 'Level ' + lvl[i] + ' · ★ members', 1);
    el('modalBody').onclick = e => { const a = e.target.closest('[data-gs]'); if (a) { sel = +a.dataset.gs; draw(); } };
  };
  draw();
  return true;
}

/* ---- the second half's clock and warm-up ---- */
function c7FrameB(dt) {
  c7MuT += dt;
  if (c7MuT < 2) return;
  c7MuT = 0;
  c7MusicTick();
  q7Npcs();
}
function c7WarmB() { for (const n of ['quests.json', 'music.json', 'clues.json']) c7Json(n).catch(() => {}); q7Load().catch(() => {}); }
/* the quest stone of the 2007 frame opens the quest list (its link below hands the pane back to the world panel); with the
   game's own panels a Quests button joins the world tab's row */
PANE_DRAW.wd = () => { if (OS.on && M7) q7OsPane(); };
function q7OsPane() {
  const p = el('pane-wd');
  if (!q7Pane) {
    const host = osPane('wd');
    host.classList.add('osHit', 'q7os');
    q7Pane = div(host, 'q7body');
    const w = div(host, 'q7world', 'World panel');
    on(w, 'click', () => p.classList.remove('osLive'));
  }
  p.classList.add('osLive');
  q7Draw();
}
{
  const row = el('clogBtn') && el('clogBtn').parentNode;
  if (row) { const b = document.createElement('button'); b.textContent = 'Quests'; b.title = 'The quest list (Gielinor)'; row.appendChild(b); on(b, 'click', () => M7 ? q7Show() : say('The quests are told in Gielinor.')); }
}
