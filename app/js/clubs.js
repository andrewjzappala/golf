// The bag, club suggestions, and a first-pass club profile from logged shots.

import { distYd } from './geo.js';

// Andrew's bag and stock yardages (given 2026-09-30). Editable in Settings;
// once a club has 3+ logged full shots, his on-course numbers take over.
export const DEFAULT_BAG = [
  { id: 'D', label: 'Driver', type: 'driver', loft: 10.5, yds: 275, active: true },
  { id: '5W', label: '5 Wood', type: 'wood', loft: 18, yds: 250, active: true },
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

// Carry/total/dispersion come later (step 5). For now: median distance of clean full shots.
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

export function clubDistance(club, profiles) {
  const p = profiles[club.id];
  return p && p.n >= 3 ? { yds: p.median, fromHistory: true, n: p.n } : { yds: club.yds, fromHistory: false };
}

// Closest club to the distance (putter excluded). Returns the club id or null.
export function suggestClub(distanceYds, bag, profiles) {
  if (distanceYds == null) return null;
  let best = null, bestDiff = Infinity;
  for (const c of bag) {
    if (!c.active || c.type === 'putter') continue;
    const diff = Math.abs(clubDistance(c, profiles).yds - distanceYds);
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
