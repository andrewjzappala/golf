// Course data: loading, tee sets, green targets, and automatic lie detection.

import { distYd, pointInGeom } from './geo.js';

export const COURSES = [
  { id: 'balboa-park-18', short: 'Balboa 18', name: 'Balboa Park', sub: 'The Eighteen', par: 72, yards: 6339, file: 'courses/balboa_18_course.json' },
  { id: 'balboa-park-9', short: 'Balboa 9', name: 'Balboa Park', sub: 'The Executive Nine', par: 32, yards: 2175, file: 'courses/balboa_9_course.json' },
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
  cache.set(id, course);
  return course;
}

export const getHole = (course, n) => course.holes.find((h) => h.number === n);

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
