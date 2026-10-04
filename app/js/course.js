// Course data: loading, tee sets, green targets, and automatic lie detection.

import { distYd, pointInGeom } from './geo.js';

export const COURSES = [
  { id: 'balboa-park-18', short: 'Balboa 18', name: 'Balboa Park', sub: 'The Eighteen', crest: 'courses/balboa-emblem.png', par: 72, yards: 6339, file: 'courses/balboa_18_course.json' },
  { id: 'balboa-park-9', short: 'Balboa 9', name: 'Balboa Park', sub: 'The Executive Nine', crest: 'courses/balboa-emblem.png', par: 32, yards: 2175, file: 'courses/balboa_9_course.json', zones: 'courses/balboa_9_zones.json' },
];

// Tee sets as positions in each hole's tee_boxes list (ordered back → forward).
// Andrew plays the back tees on both Balboa courses (the default).
export const TEE_SETS = [
  { index: 0, label: 'Back' },
  { index: 1, label: 'Middle' },
  { index: 99, label: 'Forward' },
];

const cache = new Map();

export async function loadCourse(id) {
  if (cache.has(id)) return cache.get(id);
  const meta = COURSES.find((c) => c.id === id);
  const res = await fetch(meta.file);
  const course = await res.json();
  course.short = meta.short;
  course.lieFeatures = buildLieFeatures(course);
  const book = await loadBook(meta); // Andrew's miss zones + notes (separate manual file)
  course.book = book.holes || {};
  course.bookNotes = book.course_notes || [];
  cache.set(id, course);
  return course;
}

export const getHole = (course, n) => course.holes.find((h) => h.number === n);

async function loadBook(meta) {
  if (!meta.zones) return {};
  try {
    const res = await fetch(meta.zones);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

// { zones: [{kind: 'dead'|'trouble'|'safe', label, polygon}], notes: [string] } for a hole
export const holeBook = (course, n) => course.book?.[n] || { zones: [], notes: [] };

// Which miss zone a point falls in (worst level wins). Used later by the caddy and stats.
export function zoneAt(course, n, pt) {
  if (!pt) return null;
  const order = ['dead', 'trouble', 'safe'];
  const hits = holeBook(course, n).zones.filter((z) => pointInGeom(pt, z.polygon));
  return hits.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0] || null;
}

// The point a given number of yards from the tee along the hole's playing line (follows doglegs)
export function pointAlongHoleLine(hole, yards) {
  const line = hole.hole_line?.coordinates || [hole.tee.point, hole.green.center];
  let left = yards;
  for (let i = 1; i < line.length; i++) {
    const seg = distYd(line[i - 1], line[i]);
    if (left <= seg) {
      const f = left / seg;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f];
    }
    left -= seg;
  }
  // beyond the green: keep going along the last segment's direction
  const a = line[line.length - 2], b = line[line.length - 1];
  const f = 1 + left / distYd(a, b);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

export function teeBox(hole, teeIndex) {
  const boxes = hole.tee_boxes?.length ? hole.tee_boxes : [{ point: hole.tee.point, yards_to_center: hole.measured_yards_to_center }];
  return boxes[Math.min(teeIndex, boxes.length - 1)];
}

// Checked in priority order: the first shape containing the ball wins.
function buildLieFeatures(course) {
  const f = { green: [], sand: [], penalty: [], tee: [], fairway: [] };
  for (const h of course.holes) {
    if (h.green?.polygon) f.green.push(h.green.polygon);
    for (const b of h.bunkers || []) f.sand.push(b.polygon);
    for (const w of h.water || []) f.penalty.push(w.polygon);
    for (const t of h.tee_boxes || []) if (t.polygon) f.tee.push(t.polygon);
    if (h.tee?.polygon) f.tee.push(h.tee.polygon);
    for (const fw of h.fairways || []) f.fairway.push(fw.polygon);
  }
  return f;
}

const LIE_ORDER = ['green', 'sand', 'penalty', 'tee', 'fairway'];

// Returns 'green' | 'sand' | 'penalty' | 'tee' | 'fairway' | 'rough'.
// `trusted` is false when the hole is missing shapes (so "rough" may really be fairway/sand).
export function detectLie(course, holeNumber, pt) {
  if (!pt) return { lie: null, trusted: false };
  for (const lie of LIE_ORDER) {
    if (course.lieFeatures[lie].some((g) => pointInGeom(pt, g))) return { lie, trusted: true };
  }
  const c = getHole(course, holeNumber)?.completeness || {};
  return { lie: 'rough', trusted: !!(c.fairway && c.bunkers) };
}

export function greenTargets(hole, pin) {
  const g = hole.green;
  return { front: g.front, center: g.center, back: g.back, pin: pin || g.center };
}

export function distancesFrom(hole, pt, pin) {
  if (!pt) return null;
  const t = greenTargets(hole, pin);
  return {
    front: Math.round(distYd(pt, t.front)),
    center: Math.round(distYd(pt, t.center)),
    back: Math.round(distYd(pt, t.back)),
    pin: Math.round(distYd(pt, t.pin)),
  };
}
