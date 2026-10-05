// Strokes-gained baseline: expected strokes to hole out for the GOAL player (scratch-to-2 handicap).
//
// PROVISIONAL. There is no free, credible published table for low-handicap amateurs, so this is
// built from widely cited PGA Tour reference points (Mark Broadie's baseline, e.g. 150 yds fairway
// ≈ 2.98, 20 ft putt ≈ 1.87) and scaled to a 2-handicap:
//   E_goal = 1 + (E_tour − 1) × GOAL_SCALE
// GOAL_SCALE is calibrated so the goal player's expected score on Balboa 18 (back tees) is ~75.8:
// course rating 71.2 + a 2.0 index adjusted for slope (+2.2) + the usual ~2.4 gap between an
// average round and a handicap's best rounds. Swap in a real low-handicap table here when we find one;
// nothing else needs to change.

export const BASELINE = {
  name: 'Goal-player baseline (provisional)',
  note: 'PGA Tour reference points (Mark Broadie) scaled to a player at your goal handicap, calibrated on Balboa 18 from the back tees. Provisional until we find a published low-handicap table.',
};

// Scale for a goal handicap h, from the same calibration: the goal player's typical Balboa 18 score is
// 71.2 + h × 125/113 + 2.4, and the Tour reference sums to 68.74 there. h = 2 gives 1.139.
let GOAL_SCALE = 1.139;
export function setBaselineGoal(h) {
  const goal = Number.isFinite(+h) && h !== '' && h != null ? +h : 2;
  GOAL_SCALE = (71.2 + (goal * 125) / 113 + 2.4 - 18) / (68.74 - 18);
}

// Tour reference points. Distances in yards, except putting (feet).
const TOUR = {
  putt: [[1, 1.0], [2, 1.01], [3, 1.04], [4, 1.13], [5, 1.23], [6, 1.34], [8, 1.5], [10, 1.61], [15, 1.78], [20, 1.87], [30, 1.98], [40, 2.06], [50, 2.14], [60, 2.21], [90, 2.4]],
  fairway: [[5, 2.1], [10, 2.18], [20, 2.4], [40, 2.6], [60, 2.7], [80, 2.75], [100, 2.8], [120, 2.85], [140, 2.91], [150, 2.98], [175, 3.06], [200, 3.19], [225, 3.33], [250, 3.48], [275, 3.62], [300, 3.73]],
  tee: [[100, 2.92], [125, 2.97], [150, 2.99], [175, 3.05], [200, 3.12], [225, 3.24], [250, 3.45], [300, 3.71], [350, 3.86], [400, 3.99], [450, 4.17], [500, 4.41], [550, 4.65], [600, 4.85]],
  rough: [[5, 2.3], [10, 2.4], [20, 2.59], [40, 2.78], [60, 2.91], [80, 2.96], [100, 3.02], [120, 3.08], [150, 3.15], [175, 3.24], [200, 3.42], [250, 3.7], [300, 3.9]],
  sand: [[5, 2.3], [10, 2.43], [20, 2.53], [40, 2.82], [60, 3.15], [100, 3.23], [150, 3.4], [200, 3.6], [250, 3.8]],
  recovery: [[50, 3.4], [100, 3.8], [150, 3.8], [200, 3.87], [250, 4.05], [300, 4.2]],
};

function interp(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  const [xa, ya] = pts[pts.length - 2], [xb, yb] = pts[pts.length - 1];
  return yb + ((yb - ya) * (x - xb)) / (xb - xa); // gentle extrapolation past the table
}

// Expected strokes for the goal player. lie: tee | fairway | rough | sand | recovery | green.
// Green distances in feet; everything else in yards. Returns null if the distance is unknown.
export function expected(lie, dist, { isTee = false } = {}) {
  if (dist == null || Number.isNaN(dist)) return null;
  let table;
  if (lie === 'green') table = TOUR.putt;
  else if (lie === 'sand') table = TOUR.sand;
  else if (lie === 'recovery') table = TOUR.recovery;
  else if (lie === 'rough' || lie === 'penalty') table = TOUR.rough;
  else if (lie === 'tee' || isTee) table = TOUR.tee;
  else table = TOUR.fairway;
  return 1 + (interp(table, Math.max(dist, lie === 'green' ? 1 : 1)) - 1) * GOAL_SCALE;
}
