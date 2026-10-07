import * as db from './db.js';
import * as gps from './gps.js';
import { COURSES, TEE_SETS, loadCourse, getHole, teeBox, detectLie, distancesFrom, holeBook, zoneAt, pointAlongHoleLine } from './course.js';
import { ANDREW_BAG, ANDREW_PLAYER, STARTER_BAG, clubForCarry, buildProfiles, suggestClub, inferShotType, clubDistance } from './clubs.js';
import { parseNote, speechAvailable, listen } from './voice.js';
import { recordHoleWeather, backfillPending, currentConditions } from './weather.js';
import { renderHoleMap, mapEventToLonLat } from './holemap.js';
import { bearing, distYd } from './geo.js';
import * as R from './rounds.js';
import { analyzeAll, CATEGORIES, GREENS, TURF } from './analysis.js';
import { BASELINE, setBaselineGoal } from './baseline.js';
import { pickDrills } from './drills.js';

const APP_VERSION = '0.14.0';

const S = {
  view: 'home',
  bag: STARTER_BAG,
  player: null,
  profiles: {},
  rounds: [],
  // active round
  round: null, course: null, shots: [], holeResults: {},
  hole: null,
  showClubsOnGreen: false,
  showPuttsOffGreen: false,
  showMap: false,
  editShotId: null,
  noteShotId: null, // the quick note card
  setup: { courseId: 'balboa-park-18', teeIdx: 0, mode: 'all' },
  summaryRoundId: null,
};

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LIE_LABEL = { tee: 'Tee', fairway: 'Fairway', rough: 'Rough', sand: 'Sand', green: 'Green', recovery: 'Recovery', penalty: 'Penalty', holed: 'Holed' };
const MISS_LABEL = { on_target: 'On target', left: 'Left', right: 'Right', short: 'Short', long: 'Long' };
const clubById = (id) => S.bag.find((c) => c.id === id);

// ---------- boot ----------

async function boot() {
  S.player = await db.getMeta('player', null);
  S.bag = await db.getMeta('bag', null);
  if (!S.player) {
    if ((await db.all('rounds')).length) {
      // Andrew's phone from before the welcome setup existed: keep his profile and bag
      S.player = { ...ANDREW_PLAYER };
      S.bag = S.bag || ANDREW_BAG.map((c) => ({ ...c }));
      await db.setMeta('player', S.player);
      await db.setMeta('bag', S.bag);
    } else {
      // A new player: first-open setup
      S.player = { name: '', handicap: '', goal: '', hand: 'right' };
      S.bag = S.bag || STARTER_BAG.map((c) => ({ ...c }));
      S.view = 'welcome';
    }
  }
  S.bag = S.bag || ANDREW_BAG.map((c) => ({ ...c }));
  S.showMap = await db.getMeta('showMap', false);
  S.practice = await db.getMeta('practice', []);
  S.indexHistory = await db.getMeta('indexHistory', []);
  const simulate = await db.getMeta('simulateGps', false);
  await refreshRounds();
  const active = S.rounds.find((r) => r.status === 'active');
  if (active) await openRound(active.id);
  gps.onChange(() => (S.view === 'hole' ? renderLive() : null));
  if (simulate) gps.setSimulate(true);
  render();
  db.requestPersistence();
  backfillPending();
  window.addEventListener('online', backfillPending);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
}

async function refreshRounds() {
  S.rounds = (await db.all('rounds')).sort((a, b) => b.date.localeCompare(a.date));
  const shots = await db.all('shots');
  S.profiles = buildProfiles(shots);
  setBaselineGoal(S.player?.goal);
  const courses = {};
  for (const id of new Set(S.rounds.map((r) => r.courseId))) courses[id] = await loadCourse(id);
  S.analysis = analyzeAll(S.rounds, shots, await db.all('holeResults'), courses);
}

async function openRound(id) {
  const { round, shots, holeResults } = await R.loadRound(id);
  S.round = round;
  S.shots = shots;
  S.holeResults = holeResults;
  S.course = await loadCourse(round.courseId);
  // Re-derive distances/scores so logic fixes apply to shots already logged
  for (const h of new Set(shots.map((s) => s.hole))) await recompute(h);
  S.hole = round.currentHole;
  S.view = 'hole';
  if (!gps.state.simulate) gps.start();
}

// ---------- derived state for the hole screen ----------

function holeCtx() {
  const hole = getHole(S.course, S.hole);
  const hr = S.holeResults[S.hole];
  const pin = hr?.pin ? [hr.pin.lon, hr.pin.lat] : null;
  const shots = R.shotsForHole(S.shots, S.hole);
  const strokes = shots.filter((s) => s.kind === 'stroke');
  const last = strokes[strokes.length - 1];
  const live = gps.current();
  const liveLie = strokes.length === 0 ? { lie: 'tee', trusted: true } : detectLie(S.course, S.hole, live);
  const dist = distancesFrom(hole, live, pin);
  const holed = !!hr?.holed;
  const puttMode = !holed && !S.showClubsOnGreen && (last?.shotType === 'putt' || liveLie.lie === 'green' || S.showPuttsOffGreen);
  // Tee shots use the card-line yardage (follows doglegs); after that, straight-line to the pin.
  const toGreen = strokes.length === 0 ? teeBox(hole, S.round.teeIndex).yards_to_center : dist?.pin;
  // On the tee, Andrew's own plan from the book wins over a pure distance match (e.g. hybrid on No. 5)
  const planned = strokes.length === 0 ? bookTeeClub(holeBook(S.course, S.hole).caddy) : null;
  let suggestion = planned || suggestClub(toGreen, S.bag, S.profiles);
  // A club he tapped (but hasn't hit yet) is the yellow one; tapping yellow logs the shot
  const selected = S.selected?.hole === S.hole && S.selected.n === strokes.length ? S.selected.club : null;
  if (selected) suggestion = selected;

  // Target dot. Anchor = you (or the tee box before GPS has a fix). On a par 4/5 tee it starts where the
  // planned club carries along the hole line; a target he drags or taps wins, and the club follows it.
  const anchor = live || (strokes.length === 0 ? teeBox(hole, S.round.teeIndex).point : null);
  let aim = null;
  const manual = S.target?.hole === S.hole ? S.target.pt : null;
  let targetPt = manual;
  const carry = clubById(suggestion)?.yds;
  if (!targetPt && anchor && carry && !holed) {
    if (strokes.length === 0 && (hole.par >= 4 || selected)) {
      // tee: along the playing line; the default plan stops short of the green, a picked club goes its full carry
      targetPt = pointAlongHoleLine(hole, selected ? carry : Math.min(carry, toGreen - 20));
    } else if (selected) {
      // later shots: along the straight line from the ball toward the pin
      const end = pin || hole.green.center, f = carry / distYd(anchor, end);
      targetPt = [anchor[0] + (end[0] - anchor[0]) * f, anchor[1] + (end[1] - anchor[1]) * f];
    }
  }
  if (anchor && targetPt && !puttMode) {
    const toTarget = Math.round(distYd(anchor, targetPt));
    const center = hole.green.center;
    aim = { anchor, target: targetPt, manual: !!manual, toTarget,
      toCenter: Math.round(distYd(targetPt, center)),
      past: distYd(anchor, targetPt) > distYd(anchor, center) + 2, // flies beyond the middle of the green
      zone: zoneAt(S.course, S.hole, targetPt) };
    if (manual) suggestion = suggestClub(toTarget, S.bag, S.profiles);
  }
  return { hole, hr, pin, shots, strokes, last, live, liveLie, dist, holed, puttMode, suggestion, aim };
}

// The book stores the SHOT (a carry, maybe a three-quarter swing); each player's own bag decides the club
// Chipping from just off the green without leaving the putting screen: wedges + putter (fringe putt).
// Same rule as the club grid: first tap selects (yellow), second tap logs.
function chipRow(c) {
  const sel = S.selected?.hole === S.hole && S.selected.n === c.strokes.length ? S.selected.club : null;
  const clubs = S.bag.filter((b) => b.active && (b.type === 'wedge' || b.type === 'putter'))
    .sort((a, b) => (a.type === 'putter') - (b.type === 'putter') || b.loft - a.loft);
  return `<div class="lbl">${sel ? `<b class="sel-tag">${esc(sel)}</b> selected · tap it again to log the shot` : 'Off the green? Chip with'}</div>
    <div class="chips chip-row">${clubs.map((b) => `<button class="chip ${sel === b.id ? 'on-yellow' : ''} ${flashing(`club:${b.id}`) ? 'flash' : ''}" data-action="club" data-club="${b.id}" data-offgreen="1">${b.type === 'putter' ? 'Putter' : esc(b.id)}</button>`).join('')}</div>`;
}

function bookTeeClub(caddy) {
  if (!caddy) return null;
  if (caddy.plan?.carry) return clubForCarry(S.bag, caddy.plan.carry, caddy.plan.swing, caddy.plan.exclude);
  const inBag = (id) => (S.bag.some((b) => b.id === id && b.active) ? id : null);
  if (caddy.tee_club) return inBag(caddy.tee_club); // older book format
  const opt = caddy.options?.find((o) => o.name === caddy.preferred);
  return inBag(opt?.club) || inBag(caddy.preferred);
}

// "{plan}" in a book note becomes this player's planned club, e.g. "3 Hybrid off the tee, not driver"
function bookNote(text, caddy) {
  if (!text.includes('{plan}')) return text;
  const club = clubById(bookTeeClub(caddy));
  return text.replace(/\{plan\}/g, club ? club.label : 'Your layup club');
}

// ---------- rendering ----------

function render() {
  const views = { home: viewHome, setup: viewSetup, hole: viewHole, summary: viewSummary, settings: viewSettings, welcome: viewWelcome, workshop: viewWorkshop };
  $app.innerHTML = views[S.view]() + (S.confirm ? confirmSheet() : '');
  if (S.view === 'hole') { renderLive(); refreshWind(); }
}

const courseMeta = (id) => COURSES.find((c) => c.id === id) || {};
const fmtDate = (iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => new Date(iso).toLocaleDateString(undefined, opts);

// Branded confirmation sheet: S.confirm = { title, body, ok, danger, run }
function confirmSheet() {
  const c = S.confirm;
  return `<div class="sheet-bg" data-action="confirm-cancel"></div>
  <div class="sheet confirm">
    <h3 class="display">${esc(c.title)}</h3>
    <p class="muted">${esc(c.body)}</p>
    <button class="btn ${c.danger ? 'danger-fill' : 'primary'} xl" data-action="confirm-ok">${esc(c.ok)}</button>
    <button class="btn ghost" data-action="confirm-cancel">Cancel</button>
  </div>`;
}

function askConfirm(opts) {
  S.confirm = opts;
  render();
}

async function leaveRound(roundId, remove) {
  if (remove) await db.deleteRound(roundId);
  if (S.round?.id === roundId) { S.round = null; gps.stop(); }
  await refreshRounds();
  S.view = 'home';
  render();
  window.scrollTo(0, 0);
}

function viewHome() {
  const active = S.rounds.find((r) => r.status === 'active');
  const done = S.rounds.filter((r) => r.status !== 'active');
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = (S.player.name || '').split(' ')[0];
  const activeSum = active && S.round?.id === active.id ? R.scoreSummary(S.round, S.holeResults) : null;
  return `
  <header class="bar"><span></span><span class="wordmark">Dialed<i class="dot"></i></span><button class="link" data-action="go" data-view="settings">Settings</button></header>
  <main class="pad">
    <section class="hero">
      <div class="eyebrow">${fmtDate(new Date().toISOString(), { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <h1 class="display">${greeting}${first ? `, <em>${esc(first)}</em>` : ''}.</h1>
      ${gapLine()}
    </section>
    ${active ? `<button class="card in-play" data-action="resume" data-id="${active.id}">
        <div class="eyebrow">In play</div>
        <div class="c-title">${esc(courseMeta(active.courseId).name)} · ${esc(courseMeta(active.courseId).sub)}</div>
        <div class="c-meta">Hole ${active.currentHole}${activeSum?.holesDone ? ` · ${R.fmtToPar(activeSum.toPar)} through ${activeSum.holesDone}` : ''}</div>
        <div class="c-cta">Return to the course &nbsp;→</div></button>`
      : `<button class="btn primary xl" data-action="go" data-view="setup">Tee it up</button>`}
    <button class="card workshop-card" data-action="go" data-view="workshop">
      <div class="eyebrow">The Workshop</div>
      <div class="c-title">${S.analysis?.rounds.length ? `${esc(S.analysis.leak.label)} is the biggest leak` : 'Where your strokes go'}</div>
      <div class="c-meta">${S.analysis?.rounds.length ? 'Strokes gained, trends, patterns and practice' : 'Play a round and your analysis starts here'}</div>
      <div class="c-cta">Open the Workshop &nbsp;→</div></button>
    <h2>Recent rounds</h2>
    ${done.length ? `<ul class="list">${done.map((r) => `
      <li><button class="row" data-action="open-summary" data-id="${r.id}">
        <span class="r-course">${esc(courseMeta(r.courseId).sub)}</span>
        <span class="r-score">${r.totalStrokes ?? '–'}<small>${r.toPar != null ? R.fmtToPar(r.toPar) : ''}</small></span>
        <span class="r-date">${fmtDate(r.date)} · ${r.holesCompleted ?? r.holesPlayed} holes · ${esc(r.teeLabel)} tees</span>
      </button></li>`).join('')}</ul>` : '<p class="muted serif" style="font-size:18px;font-style:italic">Your first card is yet to be written.</p>'}
    <p class="footer-note">Balboa Park · San Diego</p>
  </main>`;
}

// First open on a new phone: who's playing, and what they carry
// Home headline: distance from the goal in strokes per 18, not the (slow, noisy) index
const goalName = () => (S.player?.goal !== '' && S.player?.goal != null ? `a ${S.player.goal}` : 'your goal');
const signed = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
function gapLine() {
  const a = S.analysis;
  if (!a?.rounds.length) {
    return S.player.handicap !== '' && S.player.handicap != null
      ? `<div class="goal">Index ${esc(S.player.handicap)}${S.player.goal !== '' && S.player.goal != null ? ` &nbsp;·&nbsp; the goal is <span class="hl">${esc(S.player.goal)}</span>` : ''}.</div>` : '';
  }
  const gap = -a.totalPer18;
  return gap > 0
    ? `<div class="goal"><span class="hl">${gap.toFixed(1)}</span> strokes from ${esc(goalName())}, per 18.</div>`
    : `<div class="goal">Playing <span class="hl">${(-gap).toFixed(1)}</span> better than ${esc(goalName())}, per 18.</div>`;
}

function viewWorkshop() {
  const a = S.analysis;
  const has = a?.rounds.length;
  const max = Math.max(1, ...CATEGORIES.map((c) => Math.abs(a?.cats[c.id] || 0)));
  const bar = (v, scale = max) => {
    const w = Math.min(50, (Math.abs(v) / scale) * 50);
    return `<span class="dv"><span class="dv-zero"></span><span class="dv-bar ${v < 0 ? 'neg' : 'pos'}" style="${v < 0 ? `right:50%` : `left:50%`};width:${w.toFixed(1)}%"></span></span>`;
  };
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');
  const st = a?.stats || {};
  const prox = st.girProxFt?.length ? Math.round(st.girProxFt.reduce((x, y) => x + y, 0) / st.girProxFt.length) : null;
  const drills = pickDrills(a || { rounds: [] });
  const log = S.practice || [];
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = (id) => log.some((l) => l.id === id && l.date === today);
  const last30 = (id) => log.filter((l) => l.id === id && Date.now() - new Date(l.date).getTime() < 30 * 864e5).length;
  const catLabel = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
  const roundMax = Math.max(1, ...(a?.rounds || []).map((r) => Math.abs(r.totalPer18)));
  const idxHist = S.indexHistory || [];
  return `
  <header class="bar"><button class="link" data-action="go" data-view="home">‹ Home</button><span class="wordmark">The Workshop</span><span></span></header>
  <main class="pad workshop">
    <section class="hero">
      <div class="eyebrow">Gap to goal${has ? ` · ${a.rounds.length} round${a.rounds.length > 1 ? 's' : ''}` : ''}</div>
      ${has ? `<div class="ws-big">${Math.abs(a.totalPer18).toFixed(1)}</div>
        <div class="ws-big-sub">${a.totalPer18 < 0 ? `strokes from ${esc(goalName())}` : `strokes better than ${esc(goalName())}`}, per 18 holes</div>
        <p class="goal">Biggest leak: <span class="hl">${esc(a.leak.label)}</span> (${signed(a.leak.v)} per 18).</p>`
      : `<h1 class="display">Your workshop opens after your first round.</h1>`}
    </section>

    ${has ? `
    <h2>Where the strokes go</h2>
    <p class="muted small">Strokes gained per 18 holes against ${esc(goalName())}. Left of center costs you strokes; right of center gains them.</p>
    <div class="dv-rows">${CATEGORIES.map((c) => `<div class="dv-row" title="${esc(c.label)}: ${signed(a.cats[c.id], 2)} strokes per 18">
      <span class="dv-lbl">${esc(c.label)}</span>${bar(a.cats[c.id])}<span class="dv-val">${signed(a.cats[c.id])}</span></div>`).join('')}</div>

    <h2>Round by round</h2>
    <div class="dv-rows">${[...a.rounds].reverse().map((r) => `<div class="dv-row" title="Strokes gained ${signed(r.totalPer18, 2)} per 18">
      <span class="dv-lbl"><b>${fmtDate(r.round.date, { month: 'short', day: 'numeric' })}</b> ${esc(courseMeta(r.round.courseId).short || '')} · ${r.round.totalStrokes ?? ''}</span>${bar(r.totalPer18, roundMax)}<span class="dv-val">${signed(r.totalPer18)}</span></div>`).join('')}</div>

    <h2>The numbers</h2>
    <div class="totals ws-stats">
      <div><b>${pct(st.gir, st.girHoles)}</b><span>Greens</span></div>
      <div><b>${pct(st.fw, st.fwHoles)}</b><span>Fairways</span></div>
      <div><b>${pct(st.scrambleMade, st.scrambleTry)}</b><span>Up & down</span></div>
      <div><b>${st.puttsPer18 ? st.puttsPer18.toFixed(1) : '–'}</b><span>Putts / 18</span></div>
      <div><b>${st.threePutts ?? 0}</b><span>3-putts</span></div>
      <div><b>${prox != null ? `${prox}′` : '–'}</b><span>1st putt on GIR</span></div>
    </div>
    <table class="card-table ws-putts"><tr><th>Putts</th>${a.putting.map((g) => `<th>${esc(g.label)}</th>`).join('')}</tr>
      <tr><td>All</td>${a.putting.map((g) => `<td>${g.tries ? `${g.made}/${g.tries}` : '–'}</td>`).join('')}</tr>
      ${a.puttingByGreens.length > 1 || a.puttingByGreens[0]?.id !== 'untagged' ? a.puttingByGreens.map((c) => `<tr><td>${esc(c.label)}</td>${c.makes.map((g) => `<td>${g.tries ? `${g.made}/${g.tries}` : '–'}</td>`).join('')}</tr>`).join('') : ''}</table>
    ${puttingByGreens(a)}
    ${shortByTurf(a)}

    ${missMap(a.misses)}

    <h2>Patterns</h2>
    ${a.patterns.length ? `<ul class="ws-patterns">${a.patterns.map((p) => `<li><span class="k">${esc(catLabel[p.kind] || '')}</span>${esc(p.text)}</li>`).join('')}</ul>`
      : '<p class="muted serif" style="font-style:italic">Patterns appear after a few more rounds.</p>'}` : ''}

    <h2>Practice</h2>
    <p class="muted small">${has ? `Picked for your biggest leak${a.patterns.some((p) => p.text.includes('left')) ? ' and your left miss' : ''}.` : 'A starter set. These adapt once you have rounds logged.'} Check one off when you've done it.</p>
    <div class="drills">${drills.map((d) => `<article class="drill">
      <div class="drill-head"><span class="eyebrow">${esc(catLabel[d.cat])} · ${esc(d.time)}</span>
        <button class="drill-done ${doneToday(d.id) ? 'on' : ''}" data-action="drill-done" data-id="${d.id}">${doneToday(d.id) ? 'Done today ✓' : 'Mark done'}</button></div>
      <h3>${esc(d.name)}</h3>
      <p>${esc(d.how)}</p>
      <p class="muted small">${esc(d.measure)}${last30(d.id) ? ` · Done ${last30(d.id)}× in the last 30 days` : ''}</p>
    </article>`).join('')}</div>

    <h2>Handicap index</h2>
    <p class="muted small">Your official index from GHIN. Update it when it changes; it's a slow-moving number, so strokes gained above is the better daily guide.</p>
    <div class="idx-row"><input id="idx-input" type="number" step="0.1" inputmode="decimal" value="${esc(S.player.handicap ?? '')}" placeholder="7.5"><button class="btn" data-action="update-index">Update index</button></div>
    ${idxHist.length ? `<ul class="idx-hist">${[...idxHist].reverse().slice(0, 8).map((h) => `<li><span>${fmtDate(h.date)}</span><b>${esc(h.index)}</b></li>`).join('')}</ul>` : ''}

    <p class="muted small baseline-note"><b>${esc(BASELINE.name)}.</b> ${esc(BASELINE.note)}</p>
  </main>`;
}

// Putting strokes gained split by green conditions, so punched greens don't hide real putting skill
function puttingByGreens(a) {
  const rows = a.puttingByGreens.filter((c) => c.id !== 'untagged');
  if (!rows.length) return '<p class="muted small">Tag each round\'s greens on its scorecard (Normal, Punched, Slow, Fast) to see putting by conditions.</p>';
  const normal = rows.find((c) => c.id === 'normal');
  return `<div class="greens-split">${rows.map((c) => `<div><b>${signed(c.sgPer18)}</b><span>Putting on ${esc(c.label.toLowerCase())} greens · ${c.rounds} round${c.rounds > 1 ? 's' : ''}</span></div>`).join('')}</div>
    ${normal ? '' : `<p class="muted small">No rounds on normal greens yet. Once there are, this shows your putting without the aeration noise.</p>`}`;
}

// Short game split by turf, so a dewy 6:54 tee time doesn't read as a short-game collapse
function shortByTurf(a) {
  const rows = a.shortByTurf.filter((c) => c.id !== 'untagged');
  if (!rows.length) return '';
  return `<div class="greens-split">${rows.map((c) => `<div><b>${signed(c.sgPer18)}</b><span>Around the green on ${esc(c.label.toLowerCase())} turf · ${c.rounds} round${c.rounds > 1 ? 's' : ''}</span></div>`).join('')}</div>`;
}

// Where approaches finished when they missed the green: the target is the middle, long is up
function missMap(m) {
  if (!m || (!m.approachDots.length && !Object.keys(m.tee).length)) return '';
  const R = 40; // yards shown each way from the target
  const clamp = (v) => Math.max(-R + 2, Math.min(R - 2, v));
  const word = { left: 'left', right: 'right', short: 'short', long: 'long', on_target: 'on target' };
  const list = (o) => ['left', 'right', 'short', 'long', 'on_target'].filter((k) => o[k]).map((k) => `<b>${o[k]}</b> ${word[k]}`).join(' · ');
  return `<h2>Misses</h2>
    <p class="muted small">Where approaches finished when they missed the green, from GPS (your own notes win when you leave one). The target is the middle; long is up.</p>
    ${m.approachDots.length ? `<div class="miss-wrap">
      <svg class="miss-map" viewBox="${-R} ${-R} ${2 * R} ${2 * R}" role="img" aria-label="Approach misses around the target">
        <circle class="mm-green" cx="0" cy="0" r="10"/>
        <line class="mm-axis" x1="${-R}" y1="0" x2="${R}" y2="0"/><line class="mm-axis" x1="0" y1="${-R}" x2="0" y2="${R}"/>
        <text class="mm-lbl" x="0" y="${-R + 5}">Long</text><text class="mm-lbl" x="0" y="${R - 2}">Short</text>
        <text class="mm-lbl" x="${-R + 7}" y="1.5">Left</text><text class="mm-lbl" x="${R - 7}" y="1.5">Right</text>
        ${m.approachDots.map((d) => `<circle class="mm-dot" cx="${clamp(d.side).toFixed(1)}" cy="${clamp(-d.along).toFixed(1)}" r="2.4"><title>No. ${d.hole}, ${esc(d.club)}: ${Math.abs(d.along)} ${d.along < 0 ? 'short' : 'long'}, ${Math.abs(d.side)} ${d.side < 0 ? 'left' : 'right'}</title></circle>`).join('')}
      </svg>
      <div class="miss-counts"><div class="eyebrow">Approach</div><p>${list(m.approach) || '–'}</p>
        <div class="eyebrow">Off the tee</div><p>${list(m.tee) || '–'}</p></div>
    </div>` : `<p>${list(m.tee)}</p>`}`;
}

function viewWelcome() {
  return `
  <header class="bar"><span></span><span class="wordmark">Dialed<i class="dot"></i></span><span></span></header>
  <main class="pad">
    <section class="hero">
      <div class="eyebrow">Welcome</div>
      <h1 class="display">Let's set up <em>your</em> yardage book.</h1>
      <p class="muted">Takes a minute. You can change all of this later in Settings.</p>
    </section>
    <h2>You</h2>
    <label class="field">First name <input data-player="name" value="${esc(S.player.name)}" placeholder="Name" autocomplete="given-name"></label>
    <label class="field">Handicap index <input data-player="handicap" type="number" step="0.1" inputmode="decimal" value="${esc(S.player.handicap)}" placeholder="e.g. 12.4"></label>
    <label class="field">Goal handicap <input data-player="goal" type="number" step="0.1" inputmode="decimal" value="${esc(S.player.goal)}" placeholder="e.g. 9"></label>
    <h2>Your bag</h2>
    <p class="muted small">Tick the clubs you carry and enter how far each one <b>carries</b> in the air (not including roll). These drive every club suggestion, including the plans in the course book.</p>
    ${bagTable()}
    <button class="btn primary xl" data-action="finish-welcome" style="margin-top:24px">Start using Dialed</button>
  </main>`;
}

function bagTable() {
  return `<table class="bag">${S.bag.map((b, i) => `<tr>
      <td><input type="checkbox" data-bag="${i}" data-f="active" ${b.active ? 'checked' : ''}></td>
      <td>${esc(b.label)}</td>
      <td>${b.type === 'putter' ? '' : `<input type="number" inputmode="numeric" data-bag="${i}" data-f="yds" value="${b.yds}"> carry`}</td>
      <td class="muted small">${S.profiles[b.id] ? `logged total ${S.profiles[b.id].median} (${S.profiles[b.id].n})` : ''}</td></tr>`).join('')}</table>`;
}

function viewSetup() {
  const st = S.setup;
  const is18 = st.courseId === 'balboa-park-18';
  return `
  <header class="bar"><button class="link" data-action="go" data-view="home">‹ Back</button><span class="wordmark">New round</span><span></span></header>
  <main class="pad">
    <h2>Course</h2>
    ${COURSES.map((c) => `<button class="course-card ${st.courseId === c.id ? 'on' : ''}" data-action="setup" data-k="courseId" data-v="${c.id}">
      ${c.crest ? `<span class="crest" style="-webkit-mask-image:url('${c.crest}');mask-image:url('${c.crest}')" aria-hidden="true"></span>` : ''}
      <span class="cc-text"><span class="eyebrow">${esc(c.name)}</span>
      <span class="cc-name">${esc(c.sub)}</span>
      <span class="cc-meta">Par ${c.par} · ${c.yards.toLocaleString()} yards</span></span></button>`).join('')}
    <h2>Tees</h2>
    <div class="seg">${TEE_SETS.map((t, i) => `<button class="${st.teeIdx === i ? 'on' : ''}" data-action="setup" data-k="teeIdx" data-v="${i}">${t.label}</button>`).join('')}</div>
    ${is18 ? `<h2>Holes</h2>
    <div class="seg">${[['all', 'Eighteen'], ['front', 'Front'], ['back', 'Back']].map(([k, l]) => `<button class="${st.mode === k ? 'on' : ''}" data-action="setup" data-k="mode" data-v="${k}">${l}</button>`).join('')}</div>` : ''}
    <button class="btn primary xl" data-action="start-round" style="margin-top:28px">Tee off</button>
    <p class="muted small">Location is used for yardages and shot positions. Rounds are kept on this phone.</p>
  </main>`;
}

function viewHole() {
  const c = holeCtx();
  const { hole, strokes, holed, puttMode } = c;
  const sum = R.scoreSummary(S.round, S.holeResults);
  const idx = S.round.holes.indexOf(S.hole);
  const teeYds = teeBox(hole, S.round.teeIndex).yards_to_center;
  const lastStroke = c.last;

  return `
  <header class="bar hole-bar">
    <button class="icon" data-action="nav-hole" data-d="-1" ${idx === 0 ? 'disabled' : ''}>‹</button>
    <div class="hole-title" data-action="open-summary" data-id="${S.round.id}">
      <div class="h-num"><em>No.</em>${hole.number}</div>
      <div class="h-meta">Par ${hole.par} &nbsp;·&nbsp; ${teeYds} yds &nbsp;·&nbsp; Hcp ${hole.handicap}</div>
    </div>
    <button class="icon" data-action="nav-hole" data-d="1" ${idx === S.round.holes.length - 1 ? 'disabled' : ''}>›</button>
  </header>

  <section class="page">
    <div class="page-map" data-live="map"></div>
    <div class="page-yds">
      <div class="y"><span class="lbl">Back</span><b data-live="back">–</b></div>
      <div class="y main"><span class="lbl" data-live="main-lbl">Center</span><b data-live="main">–</b></div>
      <div class="y"><span class="lbl">Front</span><b data-live="front">–</b></div>
      <div class="page-foot">
        <button class="card-btn" data-action="open-summary" data-id="${S.round.id}">
          <span class="score-line">${sum.holesDone ? `${R.fmtToPar(sum.toPar)} <span>thru ${sum.holesDone}</span>` : `<span>${esc(courseMeta(S.round.courseId).sub)}</span>`}</span>
          <span class="cb-lbl">Scorecard &nbsp;→</span></button>
        <div class="aim-info" data-live="aim"></div>
        <div class="wind" data-live="wind"></div>
        <div class="status"><span data-live="gps">GPS…</span> <span data-live="lie"></span></div>
      </div>
    </div>
  </section>

  ${!holed && lastStroke ? quickTags(lastStroke, c) : ''}

  <section class="actions">
    ${holed ? `
      <div class="holed-row">${c.hr.strokes} <span>${scoreWord(c.hr.strokes - hole.par)}</span></div>
      <button class="btn primary xl" data-action="nav-hole" data-d="1">${idx === S.round.holes.length - 1 ? 'To the scorecard' : `On to No. ${S.round.holes[idx + 1]}`}</button>
      <div class="text-btns"><button class="text-btn" data-action="unhole">Undo holed</button></div>`
    : puttMode ? `
      ${puttTrail(strokes)}
      <div class="lbl">${strokes.some((s) => s.shotType === 'putt') ? 'Next putt · feet' : 'First putt · feet'}</div>
      <div class="grid buckets">${R.PUTT_BUCKETS.map((b) => b === 1
          ? `<button class="btn tapin ${flashing('putt:1') ? 'flash' : ''}" data-action="tapin">Tap-in</button>`
          : `<button class="btn ${flashing(`putt:${b}`) ? 'flash' : ''}" data-action="putt" data-ft="${b}">${R.puttLabel(b)}</button>`).join('')}</div>
      ${strokes.length ? `<button class="btn primary holed-wide" data-action="holed">Holed</button>` : ''}
      ${chipRow(c)}
      <div class="row-btns">
        ${!c.hr?.pin ? `<button class="btn ghost" data-action="set-pin">Pin is here</button>` : ''}
        <button class="btn ghost" data-action="show-clubs">All clubs</button>
      </div>`
    : `
      ${c.suggestion && S.selected?.hole === S.hole && S.selected.club === c.suggestion && S.selected.n === strokes.length
        ? `<div class="sel-hint"><b>${esc(c.suggestion)}</b> selected · tap it again to log the shot</div>` : ''}
      <div class="grid clubs">${S.bag.filter((b) => b.active).map((b) => `
        <button class="btn club ${b.type === 'putter' ? 'putter' : ''} ${c.suggestion === b.id ? 'suggest' : ''} ${flashing(`club:${b.id}`) ? 'flash' : ''}" data-action="club" data-club="${b.id}" data-club-btn="${b.id}">
          <b>${b.id}</b><span>${b.type === 'putter' ? 'putt' : clubDistance(b).yds || ''}</span></button>`).join('')}
      </div>
      <div class="row-btns">
        ${strokes.length ? `<button class="btn primary" data-action="holed">Holed</button>` : ''}
        <button class="btn ghost" data-action="show-putts">On the green</button>
      </div>`}
    ${!holed ? `<div class="text-btns">
      <button class="text-btn" data-action="penalty">Penalty stroke</button>
      <button class="text-btn" data-action="undo" ${c.shots.length ? '' : 'disabled'}>Undo last</button>
    </div>` : ''}
  </section>

  ${bookSection(hole.number)}

  <section class="notes">
    <h2>Notes · No. ${hole.number}</h2>
    <ol class="shots">
      ${c.shots.map((s, i) => shotRow(s, i)).join('') || `<li class="empty">Tap a club to log your tee shot.</li>`}
    </ol>
  </section>
  ${S.editShotId ? editSheet() : ''}
  ${S.noteShotId ? noteCard() : ''}
  <div class="toast" id="toast"></div>`;
}

// Andrew's book for the hole: miss-zone legend, his notes, and the zone list
function bookSection(n) {
  const book = holeBook(S.course, n);
  if (!book.zones.length && !book.notes.length) return '';
  const order = { dead: 0, trouble: 1, safe: 2 };
  const zones = [...book.zones].sort((a, b) => order[a.kind] - order[b.kind]);
  return `<section class="notes book">
    <h2>The book · No. ${n}</h2>
    <div class="legend"><span><i class="l-dead"></i>Dead</span><span><i class="l-trouble"></i>Trouble</span><span><i class="l-safe"></i>Safe</span></div>
    ${book.notes.map((t) => `<div class="book-note">${esc(bookNote(t, book.caddy))}</div>`).join('')}
    <ul class="zone-list">${zones.map((z) => `<li><span class="k k-${z.kind}">${z.kind}</span><span>${esc(z.label)}</span></li>`).join('')}</ul>
    ${(S.course.bookNotes || []).map((t) => `<p class="muted small course-note">${esc(t)}</p>`).join('')}
  </section>`;
}

// Feedback for logging taps: the tapped button flashes, and putts so far are listed
const flashing = (key) => S.flash?.key === key && Date.now() < S.flash.until;
function puttTrail(strokes) {
  const putts = strokes.filter((s) => s.shotType === 'putt');
  if (!putts.length) return '';
  const ft = (s) => (s.start.bucketFt === 1 ? 'tap-in' : `${s.start.distFt ?? s.start.bucketFt ?? '?'}${s.start.bucketFt === 40 ? '+' : ''} ft`);
  return `<div class="putt-trail"><span class="lbl">Putts</span>${putts.map((s, i) => `<b class="${i === putts.length - 1 ? 'last' : ''}">${ft(s)}</b>`).join('<i>→</i>')}</div>`;
}

// Wind relative to the line you're playing (from your ball, else the tee, to the pin)
function windHtml(c) {
  const w = S.wind;
  if (!w || w.windMph == null) return navigator.onLine ? '' : '<span class="muted">Wind: offline</span>';
  const from = c.live || teeBox(c.hole, S.round.teeIndex).point;
  const line = (bearing(from, c.pin || c.hole.green.center) * 180) / Math.PI;
  const rel = ((w.windDirDeg + 180 - line) % 360 + 360) % 360; // where it blows, relative to your line
  const r = (rel * Math.PI) / 180;
  const along = Math.cos(r) * w.windMph, cross = Math.sin(r) * w.windMph;
  const words = w.windMph < 3 ? ['calm'] : [
    Math.abs(along) >= 3 ? (along > 0 ? 'helping' : 'into') : null,
    Math.abs(cross) >= 3 ? (cross > 0 ? 'L→R' : 'R→L') : null,
  ].filter(Boolean);
  const ageMin = Math.round((Date.now() - new Date(w.at).getTime()) / 60000);
  return `<svg class="wind-arrow" viewBox="-10 -10 20 20" style="transform:rotate(${rel.toFixed(0)}deg)" aria-hidden="true"><path d="M0 8V-7M-4.5 -2.5L0 -7L4.5 -2.5"/></svg>
    <b>${Math.round(w.windMph)}</b><span class="unit">mph</span>${w.gustMph > w.windMph + 4 ? `<span class="muted"> g${Math.round(w.gustMph)}</span>` : ''}
    <span class="w-words">${words.join(' · ')}</span>${ageMin > 15 ? `<span class="muted"> · ${ageMin}m ago</span>` : ''}`;
}

async function refreshWind() {
  if (!S.course || !S.round) return;
  const w = await currentConditions(getHole(S.course, S.hole).green.center);
  if (w) { S.wind = w; renderLive(); }
}

function shotRow(s, i) {
  if (s.kind === 'penalty') return `<li class="shot penalty" data-action="edit-shot" data-id="${s.id}"><span class="n">${i + 1}</span><span>Penalty stroke</span></li>`;
  const club = clubById(s.club);
  const from = s.shotType === 'putt' && s.start.lie === 'green'
    ? (s.start.bucketFt === 1 ? 'Tap-in' : `${s.start.distFt ?? '?'} ft${s.start.bucketFt === 40 ? '+' : ''}`)
    : `${s.start.distYds ?? '?'} yds · ${LIE_LABEL[s.start.lie] || '<b class="warn">lie?</b>'}`;
  const tags = [s.shotType !== 'full' && s.shotType !== 'putt' ? s.shotType : null, s.miss ? MISS_LABEL[s.miss] : null].filter(Boolean);
  const acc = s.start.pos?.acc && s.start.pos.acc > 12 ? ` <span class="warn">±${Math.round(s.start.pos.acc)}m</span>` : '';
  return `<li class="shot" data-action="edit-shot" data-id="${s.id}">
    <span class="n">${i + 1}</span><span class="club-tag">${club ? club.id : s.club || '?'}</span>
    <span>${from}${acc}</span><span class="tags">${tags.join(' · ')}</span>
    ${s.note ? `<span class="pencil">“${esc(s.note)}”</span>` : ''}</li>`;
}

function quickTags(s, c) {
  const askLie = s.shotType !== 'putt' && s.lieNeedsConfirm;
  return `<section class="quick">
    ${askLie ? `<div class="lbl">Lie for shot ${c.strokes.indexOf(s) + 1}? (map data incomplete here)</div>
      <div class="chips">${['fairway', 'rough', 'sand', 'recovery'].map((l) => `<button class="chip ${s.start.lie === l ? 'on' : ''}" data-action="set-lie" data-id="${s.id}" data-lie="${l}">${LIE_LABEL[l]}</button>`).join('')}</div>` : ''}
    <div class="lbl">Result of ${s.club ? clubById(s.club)?.id || s.club : 'last shot'}</div>
    <div class="chips"><button class="chip voice" data-action="note" data-id="${s.id}"><svg class="mic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>Note</button>${R.MISSES.map((m) => `<button class="chip ${s.miss === m ? 'on' : ''}" data-action="set-miss" data-id="${s.id}" data-miss="${m}">${MISS_LABEL[m]}</button>`).join('')}</div>
  </section>`;
}

// Quick note card: pinned to the TOP so the keyboard never covers it; keyboard opens right away.
function noteCard() {
  const s = S.shots.find((x) => x.id === S.noteShotId);
  if (!s) return '';
  const club = clubById(s.club)?.id || s.club || 'shot';
  return `<div class="sheet-bg" data-action="note-done"></div>
  <div class="note-card">
    <div class="sheet-head"><b>Note · ${esc(club)}</b><button class="link" data-action="note-done">Save</button></div>
    <textarea id="note" rows="3" placeholder='e.g. "7 iron, pulled it left, wind into me"'>${esc(s.note)}</textarea>
    <div class="note-tools">
      ${speechAvailable && !speechOff() ? `<button class="btn speak" data-action="speak"><svg class="mic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg><span>Speak</span></button>` : ''}
      <span class="muted small">${speechAvailable && !speechOff() ? 'or tap' : 'Tap'} the mic on your keyboard to dictate.</span>
    </div>
    <div class="muted small" id="parsed"></div>
  </div>`;
}

const speechOff = () => { try { return localStorage.getItem('speechOff') === '1'; } catch { return false; } };
const setSpeechOff = () => { try { localStorage.setItem('speechOff', '1'); } catch {} };
const sheetOpen = () => !!(S.editShotId || S.noteShotId || S.confirm);

function editSheet() {
  const s = S.shots.find((x) => x.id === S.editShotId);
  if (!s) return '';
  const penalty = s.kind === 'penalty';
  return `<div class="sheet-bg" data-action="close-sheet"></div>
  <div class="sheet">
    <div class="sheet-head"><b>${penalty ? 'Penalty stroke' : 'Edit shot'}</b><button class="link" data-action="close-sheet">Done</button></div>
    ${penalty ? '' : `
    <div class="lbl">Club</div>
    <div class="chips">${S.bag.filter((b) => b.active).map((b) => `<button class="chip ${s.club === b.id ? 'on' : ''}" data-action="edit-field" data-f="club" data-v="${b.id}">${b.id}</button>`).join('')}</div>
    ${s.shotType === 'putt' ? `<div class="lbl">Putt distance (ft)</div>
      <div class="chips">${R.PUTT_BUCKETS.map((b) => `<button class="chip ${s.start.bucketFt === b ? 'on' : ''}" data-action="edit-field" data-f="bucketFt" data-v="${b}">${R.puttLabel(b)}</button>`).join('')}</div>` : `
    <div class="lbl">Lie (where it was hit from)</div>
    <div class="chips">${R.LIES.map((l) => `<button class="chip ${s.start.lie === l ? 'on' : ''}" data-action="edit-field" data-f="lie" data-v="${l}">${LIE_LABEL[l]}</button>`).join('')}</div>`}
    <div class="lbl">Shot type</div>
    <div class="chips">${R.SHOT_TYPES.map((t) => `<button class="chip ${s.shotType === t ? 'on' : ''}" data-action="edit-field" data-f="shotType" data-v="${t}">${t}</button>`).join('')}</div>
    <div class="lbl">Result</div>
    <div class="chips">${R.MISSES.map((m) => `<button class="chip ${s.miss === m ? 'on' : ''}" data-action="edit-field" data-f="miss" data-v="${m}">${MISS_LABEL[m]}</button>`).join('')}</div>
    <div class="lbl">Note <span class="muted small">· tap the mic on your keyboard to dictate</span></div>
    <div class="note-row"><input id="note" type="text" placeholder='e.g. "7 iron, pulled it left"' value="${esc(s.note)}" autocomplete="off"></div>
    <div class="muted small" id="parsed"></div>`}
    <button class="btn danger" data-action="delete-shot">Delete</button>
  </div>`;
}

// Parts that change with every GPS reading
function renderLive() {
  if (S.view !== 'hole') return;
  const c = holeCtx();
  const set = (k, v) => { const el = $app.querySelector(`[data-live="${k}"]`); if (el) el.innerHTML = v; };
  const d = c.dist;
  set('front', d ? d.front : '–');
  set('back', d ? d.back : '–');
  set('main', d ? (c.pin ? d.pin : d.center) : '–');
  set('main-lbl', c.pin ? 'Pin' : 'Center');
  const st = gps.state;
  set('gps', st.simulate ? '<span class="sim">Simulated GPS · double-tap the drawing to move</span>'
    : st.error ? `<span class="warn">${esc(st.error)}</span>`
    : st.last ? `GPS ±${Math.round(st.last.acc)} m` : 'Finding GPS…');
  set('lie', c.live && c.strokes.length ? `· ${LIE_LABEL[c.liveLie.lie]}` : '');
  set('wind', windHtml(c));
  set('aim', c.aim ? `<span class="a-sum"><b>${c.aim.toTarget}</b> to target · <b>${c.aim.toCenter}</b> ${c.aim.past ? 'past center' : 'left'}</span>
    ${c.aim.zone ? `<span class="a-zone k-${c.aim.zone.kind}">Target in ${c.aim.zone.kind}: ${esc(c.aim.zone.label)}</span>` : ''}
    ${c.aim.manual ? `<button class="text-btn a-clear" data-action="clear-target">Reset target</button>` : ''}` : '');
  const map = $app.querySelector('[data-live="map"]');
  if (map) {
    const aspect = map.clientWidth && map.clientHeight ? map.clientWidth / map.clientHeight : 0.55;
    map.innerHTML = renderHoleMap({ hole: c.hole, teeIndex: S.round.teeIndex, shots: c.shots, live: c.live, pin: c.pin, zones: holeBook(S.course, S.hole).zones, aim: c.aim, aspect });
  }
  $app.querySelectorAll('[data-club-btn]').forEach((b) => b.classList.toggle('suggest', b.dataset.clubBtn === c.suggestion));
  // Switch between clubs and putt buckets when walking onto / off the green
  const onPutts = !!$app.querySelector('.buckets');
  if (!c.holed && onPutts !== c.puttMode && !sheetOpen()) render();
}

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function viewSummary() {
  const round = (S.round?.id === S.summaryRoundId && S.round) || S.rounds.find((r) => r.id === S.summaryRoundId);
  const hrs = S.summaryHoleResults || {};
  const course = S.summaryCourse;
  const sum = R.scoreSummary(round, hrs);
  const active = round.status === 'active';
  const shots = S.summaryShots || [];
  const half = (holes) => holes.map((h) => ({ h, par: getHole(course, h).par, hr: hrs[h], ...R.holeStats(shots, h, hrs[h]) }));
  const nines = round.holes.length > 9 ? [round.holes.slice(0, 9), round.holes.slice(9)] : [round.holes];
  const all = half(round.holes);
  const fwHoles = all.filter((x) => x.fw !== null), girHoles = all.filter((x) => x.gir !== null);
  const ratio = (arr, k) => (arr.length ? `${arr.filter((x) => x[k]).length}<small>/${arr.length}</small>` : '–');
  const hitMark = (v) => (v === null ? '' : v ? '<span class="hit"></span>' : '<span class="miss">–</span>');
  const cur = active ? round.currentHole : null;
  const colCls = (h) => (h === cur ? ' class="cur"' : '');
  return `
  <header class="bar"><button class="link" data-action="${active ? 'back-to-hole' : 'go'}" data-view="home">‹ ${active ? `No. ${cur}` : 'Back'}</button><span class="wordmark">Scorecard</span><span></span></header>
  <main class="pad">
    <div class="sc-head"><div class="eyebrow">${esc(courseMeta(round.courseId).name)}</div>
      <h1 class="display">${esc(courseMeta(round.courseId).sub)}</h1>
      <div class="muted">${fmtDate(round.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · ${esc(round.teeLabel)} tees</div></div>
    <div class="greens-tag"><span class="lbl">Greens</span>
      <div class="chips">${GREENS.filter((g) => g.id !== 'untagged').map((g) => `<button class="chip ${round.conditions?.greens === g.id ? 'on' : ''}" data-action="tag-greens" data-id="${round.id}" data-v="${g.id}">${g.label}</button>`).join('')}</div>
      <span class="lbl">Turf</span>
      <div class="chips">${TURF.filter((g) => g.id !== 'untagged').map((g) => `<button class="chip ${round.conditions?.turf === g.id ? 'on' : ''}" data-action="tag-greens" data-k="turf" data-id="${round.id}" data-v="${g.id}">${g.label}</button>`).join('')}</div></div>
    <div class="totals">
      <div><b>${sum.strokes || '–'}</b><span>Score</span></div>
      <div><b>${sum.holesDone ? R.fmtToPar(sum.toPar) : '–'}</b><span>${sum.holesDone && sum.holesDone < round.holes.length ? `Thru ${sum.holesDone}` : 'To par'}</span></div>
      <div><b>${sum.holesDone ? sum.putts : '–'}</b><span>Putts</span></div>
      <div><b>${ratio(fwHoles, 'fw')}</b><span>Fairways</span></div>
      <div><b>${ratio(girHoles, 'gir')}</b><span>Greens</span></div>
      <div><b>${sum.holesDone ? sum.penalties : '–'}</b><span>Penalties</span></div>
    </div>
    ${nines.map((n, ni) => {
      const xs = half(n);
      const tot = (f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
      const cnt = (k) => { const a = xs.filter((x) => x[k] !== null); return a.length ? `${a.filter((x) => x[k]).length}/${a.length}` : ''; };
      const label = nines.length === 1 ? 'Tot' : ni === 0 ? 'Out' : 'In';
      const jump = (h) => (active ? ` data-action="jump-hole" data-h="${h}"` : '');
      return `<table class="card-table"><tr><th>Hole</th>${n.map((h) => `<th${colCls(h)}${jump(h)}>${h}</th>`).join('')}<th class="tot">${label}</th></tr>
      <tr><td>Par</td>${xs.map((x) => `<td${colCls(x.h)}${jump(x.h)}>${x.par}</td>`).join('')}<td class="tot">${tot((x) => x.par)}</td></tr>
      <tr class="score-row"><td>Score</td>${xs.map((x) => `<td${colCls(x.h)}${jump(x.h)}>${x.hr?.holed ? `<span class="mark ${scoreCls(x.hr.strokes - x.par)}">${x.hr.strokes}</span>` : ''}</td>`).join('')}<td class="tot">${tot((x) => x.hr?.holed && x.hr.strokes) || ''}</td></tr>
      <tr><td>Putts</td>${xs.map((x) => `<td${colCls(x.h)}${jump(x.h)}>${x.hr?.holed ? x.hr.putts : ''}</td>`).join('')}<td class="tot">${tot((x) => x.hr?.holed && x.hr.putts) || ''}</td></tr>
      <tr class="mark-row"><td>Fwy</td>${xs.map((x) => `<td${colCls(x.h)}${jump(x.h)}>${hitMark(x.fw)}</td>`).join('')}<td class="tot small-tot">${cnt('fw')}</td></tr>
      <tr class="mark-row"><td>GIR</td>${xs.map((x) => `<td${colCls(x.h)}${jump(x.h)}>${hitMark(x.gir)}</td>`).join('')}<td class="tot small-tot">${cnt('gir')}</td></tr></table>`;
    }).join('')}
    ${active ? (sum.holesDone === round.holes.length ? `
      <button class="btn primary xl" data-action="finish-round">Finish round</button>`
    : `<p class="muted small center">Tap a hole to go to it.</p>
      <button class="btn primary xl" data-action="back-to-hole">Back to No. ${cur}</button>
      ${sum.holesDone ? `<button class="btn ghost" data-action="end-early">End round early</button>` : ''}`) : ''}
    <div class="text-btns">
      <button class="text-btn" data-action="export-round" data-id="${round.id}">Export</button>
      <button class="text-btn danger-text" data-action="${active ? 'discard-round' : 'delete-round'}" data-id="${round.id}">${active ? 'Discard round' : 'Delete round'}</button>
    </div>
    <div class="maker">Dialed<i class="dot"></i></div>
  </main>`;
}
const scoreCls = (d) => (d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 1 ? 'bogey' : d >= 2 ? 'double' : '');
const scoreWord = (d) => ({ '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double bogey', 3: 'Triple bogey' }[d] || (d > 0 ? `+${d}` : `${d}`));

function viewSettings() {
  return `
  <header class="bar"><button class="link" data-action="go" data-view="home">‹ Back</button><span class="wordmark">Settings</span><span></span></header>
  <main class="pad">
    <h2>Player</h2>
    <label class="field">Name <input data-player="name" value="${esc(S.player.name)}"></label>
    <label class="field">Handicap index <input data-player="handicap" type="number" step="0.1" inputmode="decimal" value="${esc(S.player.handicap)}"></label>
    <label class="field">Goal handicap <input data-player="goal" type="number" step="0.1" inputmode="decimal" value="${esc(S.player.goal ?? '')}"></label>
    <h2>My bag</h2>
    <p class="muted small">Tick the clubs in the bag today (max 14). Yardages are <b>carry</b> and drive the club suggestions. Logged totals from your rounds appear alongside for reference.</p>
    ${bagTable()}
    <h2>Testing</h2>
    <label class="field row-field"><input type="checkbox" data-action="toggle-sim" ${gps.state.simulate ? 'checked' : ''}> Simulate GPS (double-tap the hole drawing to place yourself)</label>
    <h2>Your data</h2>
    <p class="muted small">Rounds are stored on this phone only. Export a backup now and then until cloud sync is added.</p>
    <button class="btn" data-action="export-all">Export all data</button>
    <label class="btn">Import backup<input type="file" accept="application/json" data-action="import" hidden></label>
    <p class="muted small">Version ${APP_VERSION}</p>
  </main>`;
}

// ---------- actions ----------

async function recompute(holeNum = S.hole) {
  await R.recomputeHole(S.course, S.round, S.shots, S.holeResults, holeNum);
}

async function addShot({ club, shotType, bucketFt, offGreen = false }) {
  const c = holeCtx();
  const seq = c.shots.length ? c.shots[c.shots.length - 1].seq + 1 : 1;
  const first = c.strokes.length === 0;
  const clubObj = clubById(club);
  const shot = {
    id: db.uid(), roundId: S.round.id, hole: S.hole, seq, kind: 'stroke',
    club, shotType: null, miss: null, note: '',
    start: { pos: null, lie: first ? 'tee' : c.liveLie.lie, t: new Date().toISOString() },
    lieNeedsConfirm: !first && c.liveLie.lie === 'rough' && !c.liveLie.trusted && shotType !== 'putt',
  };
  if (bucketFt != null) { shot.start.bucketFt = bucketFt; shot.start.lie = 'green'; }
  // GPS on the fringe often reads "green"; a wedge, or a putter from the chip row, is off the green
  const fringe = (lie) => (bucketFt == null && lie === 'green' && (offGreen || clubObj?.type !== 'putter') ? 'fairway' : lie);
  shot.start.lie = fringe(shot.start.lie);
  shot.shotType = shotType || inferShotType(clubObj, shot.start.lie, c.dist?.pin);
  S.shots.push(shot);
  S.target = null;
  S.selected = null;
  S.showClubsOnGreen = false;
  S.showPuttsOffGreen = false;

  // Later putts don't need a GPS fix — the bucket is the distance.
  const needsPos = !(shotType === 'putt' && c.strokes.some((s) => s.shotType === 'putt'));
  if (needsPos) {
    // The fix is refined ~2 s later; always apply it to the hole the shot was hit on, even if the screen moved on
    gps.capture(async (pos, final) => {
      if (first && !final) recordHoleWeather(S.round.id, shot.hole, pos ? [pos.lon, pos.lat] : getHole(S.course, shot.hole).tee.point);
      shot.start.pos = pos;
      if (pos && !first && bucketFt == null) {
        const det = detectLie(S.course, shot.hole, [pos.lon, pos.lat]);
        if (det.lie) { shot.start.lie = fringe(det.lie); shot.lieNeedsConfirm = det.lie === 'rough' && !det.trusted; }
      }
      await recompute(shot.hole);
      // Don't redraw under an open edit sheet (it would wipe a note being typed)
      if (!(final && sheetOpen())) render();
    });
  } else {
    await recompute();
    render();
  }
}

async function goToHole(n) {
  S.hole = n;
  S.round.currentHole = n;
  S.target = null;
  S.selected = null;
  S.showClubsOnGreen = S.showPuttsOffGreen = false;
  await db.put('rounds', S.round);
  render();
  window.scrollTo(0, 0);
}

async function finishRound() {
  const sum = R.scoreSummary(S.round, S.holeResults);
  Object.assign(S.round, { status: 'complete', totalStrokes: sum.strokes, toPar: sum.toPar, holesCompleted: sum.holesDone, finishedAt: new Date().toISOString() });
  await db.put('rounds', S.round);
  S.round = null;
  gps.stop();
  await refreshRounds();
  S.view = 'home';
  render();
}

async function openSummary(id) {
  const { round, shots, holeResults } = await R.loadRound(id);
  S.summaryRoundId = id;
  S.summaryHoleResults = holeResults;
  S.summaryShots = shots;
  S.summaryCourse = await loadCourse(round.courseId);
  if (!S.rounds.find((r) => r.id === id)) S.rounds.push(round);
  S.view = 'summary';
  render();
}

function download(name, data) {
  const json = JSON.stringify(data, null, 1);
  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) return navigator.share({ files: [file] }).catch(() => {});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
}

const actions = {
  go: (el) => { S.view = el.dataset.view; render(); },
  resume: async (el) => { await openRound(el.dataset.id); render(); },
  setup: (el) => {
    const { k, v } = el.dataset;
    S.setup[k] = k === 'teeIdx' ? +v : v;
    if (k === 'courseId' && v !== 'balboa-park-18') S.setup.mode = 'all';
    render();
  },
  'start-round': async () => {
    const course = await loadCourse(S.setup.courseId);
    const round = await R.createRound({ course, teeSet: TEE_SETS[S.setup.teeIdx], mode: S.setup.mode, player: S.player });
    await refreshRounds();
    await openRound(round.id);
    render();
  },
  'nav-hole': async (el) => {
    const idx = S.round.holes.indexOf(S.hole) + +el.dataset.d;
    if (idx >= S.round.holes.length) return openSummary(S.round.id);
    if (idx >= 0) goToHole(S.round.holes[idx]);
  },
  'back-to-hole': () => { S.view = 'hole'; render(); window.scrollTo(0, 0); },
  'jump-hole': (el) => { S.view = 'hole'; goToHole(+el.dataset.h); },
  'toggle-map': async () => { S.showMap = !S.showMap; await db.setMeta('showMap', S.showMap); render(); },
  'clear-target': () => { S.target = null; S.selected = null; render(); },
  club: (el) => {
    const id = el.dataset.club;
    const c = holeCtx();
    const sel = S.selected?.hole === S.hole && S.selected.n === c.strokes.length ? S.selected.club : null;
    const offGreen = el.dataset.offgreen === '1' || c.puttMode;
    const yellow = offGreen ? sel === id : c.suggestion === id;
    if (!yellow) {
      // first tap on a different club: make it the yellow one and show where it carries
      S.selected = { hole: S.hole, n: c.strokes.length, club: id };
      S.target = null;
      return render();
    }
    if (Date.now() - lastClubLog < 900) return; // accidental double tap on the yellow club
    lastClubLog = Date.now();
    S.flash = { key: `club:${id}`, until: Date.now() + 900 };
    addShot({ club: id, offGreen });
  },
  tapin: async () => {
    S.flash = { key: 'putt:1', until: Date.now() + 900 };
    await addShot({ club: 'P', shotType: 'putt', bucketFt: 1 });
    await actions.holed();
  },
  putt: (el) => { S.flash = { key: `putt:${el.dataset.ft}`, until: Date.now() + 900 }; addShot({ club: 'P', shotType: 'putt', bucketFt: +el.dataset.ft }); },
  'show-clubs': () => { S.showClubsOnGreen = true; S.showPuttsOffGreen = false; render(); },
  'show-putts': () => { S.showPuttsOffGreen = true; S.showClubsOnGreen = false; render(); },
  holed: async () => {
    const hr = S.holeResults[S.hole] || {};
    S.holeResults[S.hole] = { ...hr, id: `${S.round.id}:${S.hole}`, roundId: S.round.id, hole: S.hole, holed: true, completedAt: new Date().toISOString() };
    const res = await R.recomputeHole(S.course, S.round, S.shots, S.holeResults, S.hole);
    const idx = S.round.holes.indexOf(S.hole);
    const msg = `No. ${S.hole} · ${res.strokes} · ${scoreWord(res.strokes - res.par)}`;
    if (idx < S.round.holes.length - 1) { await goToHole(S.round.holes[idx + 1]); toast(msg); }
    else { render(); toast(msg); }
  },
  unhole: async () => { S.holeResults[S.hole].holed = false; await recompute(); render(); },
  penalty: async () => {
    const c = holeCtx();
    const seq = c.shots.length ? c.shots[c.shots.length - 1].seq + 1 : 1;
    S.shots.push({ id: db.uid(), roundId: S.round.id, hole: S.hole, seq, kind: 'penalty', club: null, shotType: null, start: { lie: 'penalty', pos: null, t: new Date().toISOString() } });
    await recompute(); render(); toast('Penalty stroke added');
  },
  undo: async () => {
    const c = holeCtx();
    const last = c.shots[c.shots.length - 1];
    if (!last) return;
    S.shots = S.shots.filter((s) => s.id !== last.id);
    await db.del('shots', last.id);
    await recompute(); render();
  },
  'set-pin': () => {
    gps.capture(async (pos, final) => {
      if (!pos) return toast('No GPS fix yet');
      const hr = S.holeResults[S.hole] || { id: `${S.round.id}:${S.hole}`, roundId: S.round.id, hole: S.hole };
      hr.pin = pos;
      S.holeResults[S.hole] = hr;
      await recompute();
      render();
      if (final || gps.state.simulate) toast('Pin saved');
    });
  },
  'set-miss': async (el) => {
    const s = S.shots.find((x) => x.id === el.dataset.id);
    s.miss = s.miss === el.dataset.miss ? null : el.dataset.miss;
    await db.put('shots', s); render();
  },
  'set-lie': async (el) => {
    const s = S.shots.find((x) => x.id === el.dataset.id);
    s.start.lie = el.dataset.lie; s.lieNeedsConfirm = false;
    await recompute(); render();
  },
  'edit-shot': (el) => { S.editShotId = el.dataset.id; render(); },
  'close-sheet': async () => { await saveNote(); S.editShotId = null; render(); },
  'edit-field': async (el) => {
    const s = S.shots.find((x) => x.id === S.editShotId);
    const { f, v } = el.dataset;
    await saveNote();
    if (f === 'lie') { s.start.lie = v; s.lieNeedsConfirm = false; }
    else if (f === 'bucketFt') s.start.bucketFt = +v;
    else if (f === 'miss') s.miss = s.miss === v ? null : v;
    else s[f] = v;
    if (f === 'club' && clubById(v)?.type === 'putter' && s.start.lie === 'green') s.shotType = 'putt';
    if (f === 'club' && clubById(v)?.type !== 'putter' && (s.start.bucketFt != null || s.shotType === 'putt')) {
      // it was logged as a putt but it's a chip: drop the putt distance; the GPS spot gives the yards
      delete s.start.bucketFt; delete s.start.distFt;
      if (s.start.lie === 'green') s.start.lie = 'fairway';
      s.shotType = 'chip';
    }
    await recompute(); render();
  },
  'delete-shot': async () => {
    const id = S.editShotId;
    S.shots = S.shots.filter((s) => s.id !== id);
    await db.del('shots', id);
    S.editShotId = null;
    await recompute(); render();
  },
  note: (el) => {
    S.noteShotId = el.dataset.id;
    render();
    const t = document.getElementById('note');
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); showParsed(); }
  },
  'note-done': async () => { await saveNote(true); S.noteShotId = null; render(); },
  speak: (el) => {
    const label = el.querySelector('span');
    el.classList.add('listening');
    label.textContent = 'Listening…';
    let reported = false;
    listen({
      onText: (text) => {
        const t = document.getElementById('note');
        if (!t) return;
        t.value = (t.value ? t.value + ' ' : '') + text;
        showParsed();
        saveNote(false);
      },
      onError: (code) => {
        if (reported) return;
        reported = true;
        const hard = ['not-allowed', 'service-not-allowed', 'unsupported', 'start-failed', 'audio-capture'].includes(code);
        const out = document.getElementById('parsed');
        if (out) out.textContent = hard
          ? 'Voice capture isn’t available in this app on your phone. Tap the mic on your keyboard instead.'
          : 'Didn’t catch that. Try again, or tap the mic on your keyboard.';
        if (hard) { setSpeechOff(); el.remove(); document.getElementById('note')?.focus(); }
      },
      onEnd: () => { el.classList.remove('listening'); label.textContent = 'Speak'; },
    });
  },
  'finish-round': finishRound,
  'open-summary': (el) => openSummary(el.dataset.id),
  'export-round': async (el) => {
    const all = await db.exportAll();
    const id = el.dataset.id;
    const pick = (arr) => arr.filter((r) => r.roundId === id);
    download(`round-${id.slice(0, 8)}.json`, { ...all, rounds: all.rounds.filter((r) => r.id === id), shots: pick(all.shots), holeResults: pick(all.holeResults), weather: pick(all.weather), meta: [] });
  },
  'export-all': async () => download(`dialed-backup-${new Date().toISOString().slice(0, 10)}.json`, await db.exportAll()),
  'delete-round': (el) => askConfirm({
    title: 'Delete this round?', body: 'Its scorecard and every shot will be removed from this phone. This can’t be undone.',
    ok: 'Delete round', danger: true, run: () => leaveRound(el.dataset.id, true),
  }),
  'discard-round': (el) => askConfirm({
    title: 'Discard this round?', body: 'Nothing from it will be saved: no scorecard, no shots, no stats. Use this for test rounds or a round started by mistake.',
    ok: 'Discard round', danger: true, run: () => leaveRound(el.dataset.id, true),
  }),
  'end-early': () => {
    const sum = R.scoreSummary(S.round, S.holeResults);
    askConfirm({
      title: 'End the round here?', body: `Your ${sum.holesDone} completed hole${sum.holesDone === 1 ? '' : 's'} will be saved to your record. Any unfinished hole is left off the card.`,
      ok: `Save ${sum.holesDone} hole${sum.holesDone === 1 ? '' : 's'} & end`, run: finishRound,
    });
  },
  'tag-greens': async (el) => {
    const id = el.dataset.id, v = el.dataset.v, k = el.dataset.k || 'greens';
    const round = (S.round?.id === id && S.round) || S.rounds.find((r) => r.id === id) || (await db.get('rounds', id));
    round.conditions = { ...(round.conditions || {}), [k]: round.conditions?.[k] === v ? null : v };
    await db.put('rounds', round);
    if (S.round?.id === id) S.round.conditions = round.conditions;
    await refreshRounds();
    render();
  },
  'drill-done': async (el) => {
    const today = new Date().toISOString().slice(0, 10);
    const log = S.practice || [];
    const i = log.findIndex((l) => l.id === el.dataset.id && l.date === today);
    S.practice = i >= 0 ? log.filter((_, j) => j !== i) : [...log, { id: el.dataset.id, date: today }];
    await db.setMeta('practice', S.practice);
    render();
  },
  'update-index': async () => {
    const v = parseFloat(document.getElementById('idx-input')?.value);
    if (!Number.isFinite(v)) return toast('Enter your index');
    S.player.handicap = v;
    S.indexHistory = [...(S.indexHistory || []), { date: new Date().toISOString(), index: v }];
    await db.setMeta('player', S.player);
    await db.setMeta('indexHistory', S.indexHistory);
    toast(`Index updated to ${v}`);
    render();
  },
  'finish-welcome': async () => {
    if (!String(S.player.name || '').trim()) { const el = document.querySelector('[data-player="name"]'); el?.focus(); return toast('Add your first name'); }
    await db.setMeta('player', S.player);
    await db.setMeta('bag', S.bag);
    S.view = 'home';
    render();
    window.scrollTo(0, 0);
  },
  'confirm-ok': async () => { const run = S.confirm.run; S.confirm = null; await run(); },
  'confirm-cancel': () => { S.confirm = null; render(); },
};

// Notes: parse on the fly, apply club/miss/type when the sheet closes
function showParsed() {
  const input = document.getElementById('note');
  const out = document.getElementById('parsed');
  if (!input || !out) return;
  const p = parseNote(input.value, S.bag);
  const parts = [p.club && `club ${p.club}`, p.miss && MISS_LABEL[p.miss], p.shotType].filter(Boolean);
  out.textContent = parts.length ? `Will set: ${parts.join(', ')}` : '';
}

// Saves the note text as you go; club/miss/type from the note are applied when you finish (apply = true).
async function saveNote(apply = true) {
  const input = document.getElementById('note');
  const s = S.shots.find((x) => x.id === (S.noteShotId || S.editShotId));
  if (!input || !s) return;
  const changed = input.value !== (s.note || '');
  if (!changed && !(apply && s.noteUnapplied)) return;
  s.note = input.value;
  s.noteUnapplied = !apply;
  if (apply) {
    const p = parseNote(s.note, S.bag);
    if (p.club) s.club = p.club;
    if (p.miss) s.miss = p.miss;
    if (p.shotType && s.shotType !== 'putt' && clubById(s.club)?.type !== 'putter') s.shotType = p.shotType; // a putt stays a putt
  }
  await db.put('shots', s);
}

let noteTimer;
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNote(true); });

// A repeat tap on the SAME logging button within 0.9 s is almost always an accidental double tap
const LOGGING = new Set(['putt', 'tapin', 'holed', 'penalty']);
let lastClubLog = 0;
let lastLogTap = { key: '', t: 0 };

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  if (LOGGING.has(el.dataset.action)) {
    const key = `${el.dataset.action}:${el.dataset.club || el.dataset.ft || ''}`;
    if (key === lastLogTap.key && Date.now() - lastLogTap.t < 900) return;
    lastLogTap = { key, t: Date.now() };
  }
  if (el.tagName === 'INPUT' && el.type === 'file') return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el, e);
});

// The hole drawing: tap or drag to place the target. In Simulate mode, a double-tap moves "you".
let drag = null, lastTap = { t: 0, prev: null };
function targetFromEvent(e) {
  const svg = $app.querySelector('.holemap');
  const p = svg && mapEventToLonLat(svg, e);
  if (p) { S.target = { hole: S.hole, pt: p }; S.selected = null; renderLive(); }
}
$app.addEventListener('pointerdown', (e) => {
  const wrap = e.target.closest('.page-map');
  if (!wrap || S.view !== 'hole') return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  wrap.setPointerCapture?.(e.pointerId);
});
$app.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) drag.moved = true;
  if (drag.moved) targetFromEvent(e);
});
$app.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const wasDrag = drag.moved;
  drag = null;
  if (wasDrag) return;
  const now = Date.now();
  if (gps.state.simulate && now - lastTap.t < 320) {
    S.target = lastTap.prev; // a double-tap isn't a target move: put the target back, then move "you"
    const svg = $app.querySelector('.holemap');
    const p = svg && mapEventToLonLat(svg, e);
    if (p) gps.setSimPoint(p);
    lastTap = { t: 0, prev: null };
    return;
  }
  lastTap = { t: now, prev: S.target };
  targetFromEvent(e);
});
$app.addEventListener('pointercancel', () => { drag = null; });

// Redraw the hole when the screen size changes (rotation, Safari toolbars)
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderLive, 150); });

$app.addEventListener('input', (e) => {
  if (e.target.id === 'note') {
    showParsed();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveNote(false), 500); // keep typing/dictation safe if the phone locks
  }
});

$app.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.player) {
    S.player[t.dataset.player] = t.type === 'number' ? parseFloat(t.value) : t.value;
    await db.setMeta('player', S.player);
    if (t.dataset.player === 'goal' && S.view !== 'welcome') await refreshRounds();
  } else if (t.dataset.bag) {
    const club = S.bag[+t.dataset.bag];
    if (t.dataset.f === 'active') club.active = t.checked;
    else club.yds = parseInt(t.value, 10) || 0;
    await db.setMeta('bag', S.bag);
  } else if (t.dataset.action === 'toggle-sim') {
    gps.setSimulate(t.checked);
    await db.setMeta('simulateGps', t.checked);
  } else if (t.dataset.action === 'import' && t.files[0]) {
    try {
      const data = JSON.parse(await t.files[0].text());
      if (data.app !== 'golf-tracker') throw new Error('Not a Dialed backup');
      await db.importAll(data);
      S.bag = await db.getMeta('bag', S.bag);
      S.player = await db.getMeta('player', S.player);
      await refreshRounds();
      alert(`Imported ${data.rounds?.length || 0} rounds.`);
      render();
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  }
});

boot();
