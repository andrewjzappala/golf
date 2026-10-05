// The Workshop's numbers: strokes gained per shot against the goal-player baseline, rolled up by
// category and round, plus the classic stats and simple pattern spotting.

import { expected } from './baseline.js';
import { shotsForHole, holeStats } from './rounds.js';

export const CATEGORIES = [
  { id: 'tee', label: 'Off the tee' },
  { id: 'approach', label: 'Approach' },
  { id: 'short', label: 'Around the green' },
  { id: 'putt', label: 'Putting' },
];

const ftOf = (o) => o?.distFt ?? (o?.distYds != null ? o.distYds * 3 : null);
const startExp = (s, isTee) =>
  s.start.lie === 'green' ? expected('green', ftOf(s.start)) : expected(s.start.lie, s.start.distYds, { isTee });
function endExp(s) {
  const e = s.end;
  if (!e) return null;
  if (e.holed) return 0;
  const lie = e.lie === 'penalty' ? e.nextLie : e.lie;
  return lie === 'green' ? expected('green', ftOf(e)) : expected(lie, e.distYds);
}

function category(s, isTeeShotOnPar45) {
  if (s.start.lie === 'green' || s.shotType === 'putt') return 'putt';
  if (isTeeShotOnPar45) return 'tee';
  return (s.start.distYds ?? 999) > 30 ? 'approach' : 'short'; // par-3 tee shots count as approach
}

// One round → strokes gained (per shot, per category, total) and its stats.
export function analyzeRound(round, allShots, holeResultsByHole) {
  const shots = allShots.filter((s) => s.roundId === round.id);
  const cats = { tee: 0, approach: 0, short: 0, putt: 0 };
  const perShot = [];
  let total = 0, holes = 0, unknown = 0;
  const st = { gir: 0, girHoles: 0, fw: 0, fwHoles: 0, scrambleTry: 0, scrambleMade: 0, putts: 0, threePutts: 0, onePutts: 0, girProxFt: [] };

  for (const h of round.holes) {
    const hr = holeResultsByHole[h];
    if (!hr?.holed) continue;
    const list = shotsForHole(shots, h);
    const strokes = list.filter((s) => s.kind === 'stroke');
    if (!strokes.length) continue;
    holes++;
    const first = strokes[0];
    const holeStart = startExp(first, true);
    if (holeStart != null) total += holeStart - hr.strokes; // exact for the hole, whatever we know per shot
    let known = 0;
    for (const s of strokes) {
      const isTee = s === first && hr.par >= 4;
      const a = startExp(s, s === first), b = endExp(s);
      if (a == null || b == null) continue;
      const sg = a - b - 1 - (s.end?.penaltyStrokes || 0);
      const cat = category(s, isTee);
      cats[cat] += sg; known += sg;
      perShot.push({ id: s.id, hole: h, club: s.club, cat, sg, miss: s.miss, start: s.start, end: s.end, isTeeShot: s === first, par: hr.par });
    }
    if (holeStart != null) unknown += holeStart - hr.strokes - known;

    // classic stats
    const hs = holeStats(shots, h, hr);
    if (hs.gir !== null) { st.girHoles++; if (hs.gir) st.gir++; else { st.scrambleTry++; if (hr.strokes <= hr.par) st.scrambleMade++; } }
    if (hs.fw !== null) { st.fwHoles++; if (hs.fw) st.fw++; }
    st.putts += hr.putts;
    if (hr.putts >= 3) st.threePutts++;
    if (hr.putts === 1) st.onePutts++;
    if (hs.gir) { const p = strokes.find((s) => s.shotType === 'putt'); const ft = p && ftOf(p.start); if (ft != null) st.girProxFt.push(ft); }
  }
  const per18 = (v) => (holes ? (v * 18) / holes : 0);
  return {
    round, holes, total, unknown, cats, perShot, stats: st,
    totalPer18: per18(total),
    catsPer18: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, per18(v)])),
  };
}

// All finished rounds → averages per 18 holes, biggest leak, stats, patterns.
export function analyzeAll(rounds, allShots, allHoleResults) {
  const byRound = {};
  for (const hr of allHoleResults) (byRound[hr.roundId] ||= {})[hr.hole] = hr;
  const done = rounds.filter((r) => r.status === 'complete').sort((a, b) => a.date.localeCompare(b.date));
  const per = done.map((r) => analyzeRound(r, allShots, byRound[r.id] || {})).filter((a) => a.holes > 0);
  const holes = per.reduce((n, a) => n + a.holes, 0);
  const sum = (f) => per.reduce((n, a) => n + f(a), 0);
  const per18 = (v) => (holes ? (v * 18) / holes : 0);
  const cats = Object.fromEntries(CATEGORIES.map((c) => [c.id, per18(sum((a) => a.cats[c.id]))]));
  const leak = CATEGORIES.map((c) => ({ ...c, v: cats[c.id] })).sort((a, b) => a.v - b.v)[0];
  const st = per.reduce((acc, a) => { for (const [k, v] of Object.entries(a.stats)) acc[k] = Array.isArray(v) ? [...(acc[k] || []), ...v] : (acc[k] || 0) + v; return acc; }, {});
  const shots = per.flatMap((a) => a.perShot);
  const putting = puttMakes(allShots.filter((s) => per.some((a) => a.round.id === s.roundId)));
  return {
    rounds: per, holes,
    totalPer18: per18(sum((a) => a.total)),
    cats, leak, stats: { ...st, holes, puttsPer18: per18(st.putts || 0) }, putting,
    patterns: findPatterns(shots, st, putting, per.length),
  };
}

// Make rate by putt length (every putt, not just the first)
function puttMakes(shots) {
  const groups = [
    { id: 'tap', label: 'Tap-in & 3 ft', test: (ft) => ft <= 3 },
    { id: 'short', label: '4–8 ft', test: (ft) => ft > 3 && ft <= 8 },
    { id: 'mid', label: '9–15 ft', test: (ft) => ft > 8 && ft <= 15 },
    { id: 'long', label: '16 ft +', test: (ft) => ft > 15 },
  ].map((g) => ({ ...g, tries: 0, made: 0 }));
  for (const s of shots) {
    if (s.shotType !== 'putt') continue;
    const ft = ftOf(s.start);
    const g = ft != null && groups.find((x) => x.test(ft));
    if (!g) continue;
    g.tries++;
    if (s.end?.holed) g.made++;
  }
  return groups;
}

// Plain-English observations. Deliberately cautious: needs a minimum sample before saying anything.
function findPatterns(shots, st, putting, nRounds) {
  const out = [];
  const tee = shots.filter((s) => s.isTeeShot && s.par >= 4 && s.cat === 'tee');
  const dirMiss = tee.filter((s) => s.miss === 'left' || s.miss === 'right');
  const left = dirMiss.filter((s) => s.miss === 'left');
  if (dirMiss.length >= 3 && left.length / dirMiss.length >= 0.65) {
    const clubs = [...new Set(left.map((s) => s.club))].join(', ');
    out.push({ kind: 'tee', text: `Left is the miss: ${left.length} of ${dirMiss.length} tee shots that missed went left (${clubs}).` });
  } else if (dirMiss.length >= 3 && left.length / dirMiss.length <= 0.35) {
    out.push({ kind: 'tee', text: `Right is the miss: ${dirMiss.length - left.length} of ${dirMiss.length} tee shots that missed went right.` });
  }
  const allLeft = shots.filter((s) => s.cat !== 'putt' && s.miss === 'left').length;
  const allRight = shots.filter((s) => s.cat !== 'putt' && s.miss === 'right').length;
  if (allLeft + allRight >= 5 && allLeft >= 2 * allRight) out.push({ kind: 'approach', text: `Across all full shots, misses lean left ${allLeft} to ${allRight}.` });

  const par3 = shots.filter((s) => s.isTeeShot && s.par === 3);
  const par3Gir = par3.filter((s) => s.end?.lie === 'green' || s.end?.holed).length;
  if (par3.length >= 4) out.push({ kind: 'approach', text: `Par 3s: ${par3Gir} of ${par3.length} greens hit from the tee.` });

  if ((st.scrambleTry || 0) >= 3) out.push({ kind: 'short', text: `Up-and-downs: ${st.scrambleMade} of ${st.scrambleTry} when you missed the green.` });

  const mid = putting.find((g) => g.id === 'mid'), short = putting.find((g) => g.id === 'short');
  if (mid.tries >= 3) out.push({ kind: 'putt', text: `From 9–15 ft you've made ${mid.made} of ${mid.tries}.` });
  if (short.tries >= 3) out.push({ kind: 'putt', text: `From 4–8 ft you've made ${short.made} of ${short.tries}.` });
  if ((st.threePutts || 0) > 0) out.push({ kind: 'putt', text: `${st.threePutts} three-putt${st.threePutts > 1 ? 's' : ''} in ${nRounds} round${nRounds > 1 ? 's' : ''}.` });
  return out;
}
