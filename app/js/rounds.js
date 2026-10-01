// Rounds, shots, and hole results. Shots hold the raw facts (where, what lie, which club);
// end positions, distances, and hole scores are derived from them and recomputed on every change.

import * as db from './db.js';
import { distYd } from './geo.js';
import { getHole, teeBox } from './course.js';

export const LIES = ['tee', 'fairway', 'rough', 'sand', 'green', 'recovery', 'penalty'];
export const SHOT_TYPES = ['full', 'punch', 'chip', 'pitch', 'putt'];
export const MISSES = ['on_target', 'left', 'right', 'short', 'long'];
export const PUTT_BUCKETS = [3, 6, 10, 15, 20, 30, 40];

export function holeOrder(course, mode) {
  const n = course.holes.length;
  if (mode === 'front') return [...Array(9)].map((_, i) => i + 1);
  if (mode === 'back') return [...Array(9)].map((_, i) => i + 10);
  return [...Array(n)].map((_, i) => i + 1);
}

export async function createRound({ course, teeSet, mode, player }) {
  const holes = holeOrder(course, mode);
  const round = {
    id: db.uid(),
    date: new Date().toISOString(),
    courseId: course.id,
    courseName: course.name,
    teeIndex: teeSet.index,
    teeLabel: teeSet.label,
    holes,
    holesPlayed: holes.length,
    currentHole: holes[0],
    status: 'active',
    notes: '',
    player: player ? { name: player.name, handicap: player.handicap } : null,
  };
  await db.put('rounds', round);
  return round;
}

export async function loadRound(roundId) {
  const [round, shots, holeResults] = await Promise.all([
    db.get('rounds', roundId),
    db.byRound('shots', roundId),
    db.byRound('holeResults', roundId),
  ]);
  return { round, shots, holeResults: Object.fromEntries(holeResults.map((h) => [h.hole, h])) };
}

export const shotsForHole = (shots, hole) =>
  shots.filter((s) => s.hole === hole).sort((a, b) => a.seq - b.seq);

const ll = (pos) => (pos ? [pos.lon, pos.lat] : null);

// True if a tee-shot GPS fix is more than 40 yds from every tee box on the hole
function farFromTees(hole, pos) {
  const boxes = hole.tee_boxes?.length ? hole.tee_boxes : [hole.tee];
  return boxes.every((t) => distYd(ll(pos), t.point) > 40);
}

// Recompute derived fields for one hole and save anything that changed.
export async function recomputeHole(course, round, shots, holeResults, holeNum) {
  const hole = getHole(course, holeNum);
  const hr = holeResults[holeNum] || { id: `${round.id}:${holeNum}`, roundId: round.id, hole: holeNum, par: hole.par };
  const pin = hr.pin ? [hr.pin.lon, hr.pin.lat] : hole.green.center;
  const list = shotsForHole(shots, holeNum);
  const strokes = list.filter((s) => s.kind === 'stroke');

  // Start distance for each stroke
  for (const s of strokes) {
    delete s.start.posSuspect;
    if (s.start.bucketFt != null) {
      s.start.distFt = s.start.bucketFt;
      s.start.distYds = Math.round((s.start.bucketFt / 3) * 10) / 10;
    } else if (s.start.pos && !(s === strokes[0] && s.start.lie === 'tee' && farFromTees(hole, s.start.pos))) {
      s.start.distYds = Math.round(distYd(ll(s.start.pos), pin));
      if (s.start.lie === 'green') s.start.distFt = Math.round(s.start.distYds * 3);
    } else if (s === strokes[0] && s.start.lie === 'tee') {
      // No GPS, or GPS clearly not at this hole's tees: use the tee set's playing-line yardage
      s.start.distYds = teeBox(hole, round.teeIndex).yards_to_center;
      s.start.posSuspect = !!s.start.pos;
    } else {
      s.start.distYds = null;
    }
  }

  // End of each stroke = start of the next stroke (penalties in between are counted)
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.kind !== 'stroke') continue;
    let penalties = 0, j = i + 1;
    while (j < list.length && list[j].kind === 'penalty') { penalties++; j++; }
    const next = list[j];
    if (next) {
      s.end = {
        pos: next.start.pos || null,
        lie: penalties ? 'penalty' : next.start.lie,
        nextLie: next.start.lie,
        distYds: next.start.distYds ?? null,
        distFt: next.start.distFt ?? null,
        penaltyStrokes: penalties,
        holed: false,
      };
    } else if (hr.holed && s === strokes[strokes.length - 1]) {
      s.end = { pos: null, lie: 'holed', distYds: 0, distFt: 0, penaltyStrokes: penalties, holed: true };
    } else {
      s.end = penalties ? { pos: null, lie: 'penalty', distYds: null, penaltyStrokes: penalties, holed: false } : null;
    }
  }

  hr.strokes = list.length; // strokes + penalty strokes
  hr.penalties = list.length - strokes.length;
  hr.putts = strokes.filter((s) => s.shotType === 'putt').length;
  hr.par = hole.par;

  holeResults[holeNum] = hr;
  await Promise.all([...list.map((s) => db.put('shots', s)), db.put('holeResults', hr)]);
  return hr;
}

export function scoreSummary(round, holeResults) {
  let strokes = 0, par = 0, putts = 0, penalties = 0, holesDone = 0;
  for (const h of round.holes) {
    const hr = holeResults[h];
    if (!hr?.holed) continue;
    strokes += hr.strokes; par += hr.par; putts += hr.putts; penalties += hr.penalties; holesDone++;
  }
  return { strokes, par, toPar: strokes - par, putts, penalties, holesDone };
}

export const fmtToPar = (n) => (n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);

// Fairway hit (par 4/5 only) and green in regulation for a completed hole, derived from its shots.
// Returns { fw: true|false|null, gir: true|false|null } — null means "doesn't apply / not known".
export function holeStats(shots, holeNum, hr) {
  if (!hr?.holed) return { fw: null, gir: null };
  const list = shotsForHole(shots, holeNum);
  const tee = list.find((s) => s.kind === 'stroke');
  let fw = null;
  if (hr.par >= 4 && tee?.end) fw = tee.end.holed || tee.end.lie === 'fairway';
  // GIR: on the green (or holed) with par − 2 or fewer strokes used
  const firstOnGreen = list.findIndex((s) => s.kind === 'stroke' && s.start.lie === 'green');
  const before = firstOnGreen === -1 ? hr.strokes : firstOnGreen;
  const gir = list.length ? before <= hr.par - 2 : null;
  return { fw, gir };
}
