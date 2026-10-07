// The bag, club suggestions, and a first-pass club profile from logged shots.

import { distYd } from './geo.js';

// Andrew's bag and stock CARRY yardages (given 2026-09-30). Editable in Settings.
// The 5 wood and 4 iron swap in and out depending on the course (5W is out by default).
// Used only on Andrew's own phone; anyone else starts from STARTER_BAG in the welcome setup.
export const ANDREW_PLAYER = { name: 'Andrew', handicap: 7.5, goal: 2, hand: 'right', homeCourse: 'balboa-park-18' };
// Andrew's "sporty half set" (Oct 2026 hot-weather practice rounds), editable in Settings
export const DEFAULT_HALF_SET = ['D', '3H', '5i', '7i', '9i', 'AW', '50', '54', 'P'];

export const ANDREW_BAG = [
  { id: 'D', label: 'Driver', type: 'driver', loft: 10.5, yds: 275, active: true },
  { id: '5W', label: '5 Wood', type: 'wood', loft: 18, yds: 250, active: false },
  { id: '3H', label: '3 Hybrid', type: 'hybrid', loft: 19, yds: 235, active: true },
  { id: '4i', label: '4 Iron', type: 'iron', loft: 21, yds: 220, active: true },
  { id: '5i', label: '5 Iron', type: 'iron', loft: 24, yds: 210, active: true },
  { id: '6i', label: '6 Iron', type: 'iron', loft: 27, yds: 195, active: true },
  { id: '7i', label: '7 Iron', type: 'iron', loft: 31, yds: 180, active: true },
  { id: '8i', label: '8 Iron', type: 'iron', loft: 35, yds: 165, active: true },
  { id: '9i', label: '9 Iron', type: 'iron', loft: 39, yds: 155, active: true },
  { id: 'PW', label: 'Pitching Wedge', type: 'wedge', loft: 44, yds: 145, active: true },
  { id: 'AW', label: 'A Wedge', type: 'wedge', loft: 48, yds: 135, active: true },
  { id: '50', label: '50° Wedge', type: 'wedge', loft: 50, yds: 125, active: true },
  { id: '54', label: '54° Wedge', type: 'wedge', loft: 54, yds: 110, active: true },
  { id: '58', label: '58° Wedge', type: 'wedge', loft: 58, yds: 95, active: true },
  { id: 'P', label: 'Putter', type: 'putter', loft: 3, yds: 0, active: true },
];

// Starting point for a new player's bag. Typical mid-handicap carries; they edit these in the welcome setup.
export const STARTER_BAG = [
  { id: 'D', label: 'Driver', type: 'driver', loft: 10.5, yds: 230, active: true },
  { id: '3W', label: '3 Wood', type: 'wood', loft: 15, yds: 210, active: true },
  { id: '5W', label: '5 Wood', type: 'wood', loft: 18, yds: 195, active: false },
  { id: '3H', label: '3 Hybrid', type: 'hybrid', loft: 19, yds: 190, active: false },
  { id: '4H', label: '4 Hybrid', type: 'hybrid', loft: 22, yds: 180, active: true },
  { id: '4i', label: '4 Iron', type: 'iron', loft: 21, yds: 175, active: false },
  { id: '5i', label: '5 Iron', type: 'iron', loft: 24, yds: 170, active: true },
  { id: '6i', label: '6 Iron', type: 'iron', loft: 27, yds: 160, active: true },
  { id: '7i', label: '7 Iron', type: 'iron', loft: 31, yds: 150, active: true },
  { id: '8i', label: '8 Iron', type: 'iron', loft: 35, yds: 140, active: true },
  { id: '9i', label: '9 Iron', type: 'iron', loft: 39, yds: 130, active: true },
  { id: 'PW', label: 'Pitching Wedge', type: 'wedge', loft: 44, yds: 120, active: true },
  { id: 'AW', label: 'Gap Wedge', type: 'wedge', loft: 50, yds: 105, active: true },
  { id: '54', label: '54° Wedge', type: 'wedge', loft: 54, yds: 90, active: true },
  { id: '58', label: '58° Wedge', type: 'wedge', loft: 58, yds: 75, active: true },
  { id: 'P', label: 'Putter', type: 'putter', loft: 3, yds: 0, active: true },
];

// The club in THIS player's bag that best carries a planned distance. A three-quarter swing
// takes about 10% off a club's carry, so a "three-quarter 215" picks a club that carries ~240.
export function clubForCarry(bag, carry, swing, exclude = []) {
  const factor = swing === 'three-quarter' ? 0.9 : 1;
  let best = null, bestDiff = Infinity;
  for (const c of bag) {
    if (!c.active || c.type === 'putter' || exclude.includes(c.type)) continue;
    const diff = Math.abs(c.yds * factor - carry);
    if (diff < bestDiff) { best = c.id; bestDiff = diff; }
  }
  return best;
}

// GPS start→end measures TOTAL distance (carry + roll), so it's shown for reference only and
// does not replace his carry numbers. Carry vs total modelling comes with the caddy (step 5).
export function buildProfiles(shots) {
  const samples = {};
  for (const s of shots) {
    if (s.kind !== 'stroke' || s.shotType !== 'full' || !s.club) continue;
    if (!s.start?.pos || !s.end?.pos || s.end.lie === 'penalty' || s.end.holed) continue;
    if (!['tee', 'fairway', 'rough'].includes(s.start.lie)) continue;
    const d = distYd([s.start.pos.lon, s.start.pos.lat], [s.end.pos.lon, s.end.pos.lat]);
    (samples[s.club] ||= []).push(d);
  }
  const profiles = {};
  for (const [club, arr] of Object.entries(samples)) {
    arr.sort((a, b) => a - b);
    profiles[club] = { n: arr.length, median: Math.round(arr[Math.floor(arr.length / 2)]) };
  }
  return profiles;
}

export function clubDistance(club) {
  return { yds: club.yds, kind: 'carry' };
}

// Closest club to the distance (putter excluded). Returns the club id or null.
export function suggestClub(distanceYds, bag, profiles) {
  if (distanceYds == null) return null;
  let best = null, bestDiff = Infinity;
  for (const c of bag) {
    if (!c.active || c.type === 'putter') continue;
    const diff = Math.abs(clubDistance(c).yds - distanceYds);
    if (diff < bestDiff) { best = c.id; bestDiff = diff; }
  }
  return best;
}

export function inferShotType(club, startLie, distanceYds) {
  if (club?.type === 'putter' || startLie === 'green') return 'putt';
  if (startLie === 'tee' || distanceYds == null) return 'full';
  if (distanceYds <= 30) return 'chip';
  if (distanceYds <= 75) return 'pitch';
  return 'full';
}
