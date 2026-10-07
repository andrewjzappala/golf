// The caddy: picks a club and a target by simulating where the ball could land and scoring each
// landing spot with the strokes-gained baseline plus Andrew's book (dead / trouble / safe zones).
//
// For each candidate (club + aim point) it:
//   1. adjusts for conditions: temperature (hot air carries further) and wind (into plays longer,
//      helping plays shorter, crosswind drifts the ball sideways),
//   2. spreads ~160 landing points around the expected spot with a realistic dispersion that grows
//      with club length, shifted by the player's known miss,
//   3. scores every landing point: expected strokes from there (green → putt length; fairway / rough
//      / sand by distance), + penalties for the book's dead and trouble zones,
//   4. keeps the lowest expected score.
// Everything here is PROVISIONAL tuning (dispersion %, wind and heat rules of thumb) until his own
// shot history is large enough to fit the numbers to him.

import { expected } from './baseline.js';
import { distYd, bearing, pointInGeom } from './geo.js';
import { detectLie, zoneAt, pointAlongHoleLine } from './course.js';

const YD = 0.9144;

// Fixed pseudo-random normal pairs, so the same situation always gives the same answer
const SAMPLES = (() => {
  let s = 20261007;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const out = [];
  for (let i = 0; i < 160; i++) {
    const u = rnd() || 1e-9, v = rnd(), m = Math.sqrt(-2 * Math.log(u));
    out.push([m * Math.cos(2 * Math.PI * v), m * Math.sin(2 * Math.PI * v)]);
  }
  return out;
})();

// Move `yds` from a point along a bearing (radians, clockwise from north)
function offset([lon, lat], brg, yds) {
  const m = yds * YD, R = 6371008.8;
  const dLat = (m * Math.cos(brg)) / R, dLon = (m * Math.sin(brg)) / (R * Math.cos((lat * Math.PI) / 180));
  return [lon + (dLon * 180) / Math.PI, lat + (dLat * 180) / Math.PI];
}

// Conditions → how far the ball actually flies relative to its stock carry, and sideways drift
export function conditions(wind, lineBrg) {
  const tempF = wind?.tempF ?? 70;
  const heat = 1 + 0.0012 * (tempF - 70); // ~2 yds per 10°F on a 165-yd shot
  let along = 0, cross = 0;
  if (wind?.windMph != null) {
    const to = ((wind.windDirDeg + 180) * Math.PI) / 180; // direction the wind blows toward
    along = Math.cos(to - lineBrg) * wind.windMph; // + helping, − into
    cross = Math.sin(to - lineBrg) * wind.windMph; // + pushes right
  }
  const windFactor = along >= 0 ? 1 + along * 0.005 : 1 + along * 0.01; // into the wind hurts twice as much
  return { factor: heat * windFactor, heat, windFactor, along, cross, tempF };
}

// Dispersion (yards, 1 standard deviation) for a carry. Wider off the tee and on partial swings.
function spread(carry, { tee = false, partial = false } = {}) {
  const side = (tee ? 0.075 : carry < 100 ? 0.05 : 0.06) * carry + 2;
  const long = (0.045 * carry + 2) * (partial ? 1.25 : 1);
  return { side, long };
}

// Expected strokes to hole out from a landing point (incl. book penalties)
function scorePoint(ctx, pt) {
  const { course, hole, pin } = ctx;
  const d = distYd(pt, pin);
  if (pointInGeom(pt, hole.green.polygon)) return expected('green', d * 3);
  const lie = detectLie(course, hole.number, pt).lie || 'rough';
  const zone = zoneAt(course, hole.number, pt);
  let e = expected(lie === 'penalty' || lie === 'tee' ? 'rough' : lie, d);
  if (lie === 'penalty') e += 1;
  if (zone?.kind === 'dead') e += 0.9;
  else if (zone?.kind === 'trouble') e += 0.3;
  if (ctx.maxLandingPin && d > 4 && ctx.beyondPin(pt)) e += 0.25; // book: never past the hole here
  return e;
}

function simulate(ctx, from, aimBrg, flyYds, carry, opts) {
  const sp = spread(carry, opts);
  const side = sp.side, long = opts.longSd ?? sp.long;
  const bias = (opts.tee ? ctx.teeBias : ctx.approachBias) * carry; // + right, − left
  const drift = ctx.cond.cross * (carry / 100) * 0.45;
  let total = 0;
  for (const [zx, zy] of SAMPLES) {
    const fwd = flyYds + zy * long;
    const lat = bias + drift + zx * side;
    const p = offset(offset(from, aimBrg, fwd), aimBrg + Math.PI / 2, lat);
    total += scorePoint(ctx, p);
  }
  return 1 + total / SAMPLES.length;
}

// clubs: [{id, label, type, yds(carry), loft}] in play. Returns null when there's nothing to advise.
// Tee-shot distance for a club: his logged tee shots blended with the stock number (stock counts as
// 4 shots' worth), so a few drives move it but one bad swing doesn't. Total distance incl. roll.
function teeDistance(club, profiles) {
  const stock = club.yds * 1.08, stockSd = 0.045 * club.yds + 2;
  const p = profiles?.[club.id];
  if (!p?.n) return { mean: stock, sd: stockSd, n: 0 };
  const k = 4;
  return { mean: (p.n * p.mean + k * stock) / (p.n + k), sd: Math.sqrt((p.n * p.sd ** 2 + k * stockSd ** 2) / (p.n + k)), n: p.n };
}

export function advise({ course, hole, from, pin, clubs, wind, isTee, plan, rules = {}, bias = {}, profiles = {} }) {
  if (!from) return null;
  const pinPt = pin || hole.green.center;
  const toPin = distYd(from, pinPt);
  if (toPin < 25) return null; // chips and putts: feel shots, no caddy maths
  const lineBrg = bearing(from, pinPt);
  const cond = conditions(wind, isTee ? bearing(from, pointAlongHoleLine(hole, 200)) : lineBrg);
  const ctx = {
    course, hole, pin: pinPt, cond,
    teeBias: bias.tee || 0, approachBias: bias.approach || 0,
    maxLandingPin: rules.max_landing === 'pin',
    beyondPin: (pt) => distYd(from, pt) > toPin + 2,
  };
  const full = clubs.filter((c) => c.type !== 'putter' && c.yds > 0);
  const options = [];

  if (isTee && hole.par >= 4) {
    // Tee shots: every club that's a sensible tee club, aimed along the hole line, a few aim lines
    for (const c of full.filter((x) => x.yds >= 140)) {
      const td = teeDistance(c, profiles);
      for (const swing of ['full', 'three-quarter']) {
        const k = swing === 'full' ? 1 : 0.9;
        const fly = td.mean * k * cond.factor;
        const centre = pointAlongHoleLine(hole, fly);
        for (const sideAim of [-12, -6, 0, 6, 12]) {
          const brg = bearing(from, centre) + Math.atan2(sideAim, fly);
          options.push({ club: c, swing, aimSide: sideAim, fly, brg, logged: td.n,
            exp: simulate(ctx, from, brg, fly, c.yds * k, { tee: true, longSd: td.sd * (swing === 'full' ? 1 : 0.85) }) });
        }
      }
    }
  } else {
    // Approaches: aim points around the pin; the club that carries there (or a partial wedge)
    const wedges = full.filter((c) => c.type === 'wedge').sort((a, b) => a.yds - b.yds);
    for (const along of [-10, -5, 0, 5]) {
      for (const sideAim of [-8, -4, 0, 4, 8]) {
        const tgt = offset(offset(pinPt, lineBrg, along), lineBrg + Math.PI / 2, sideAim);
        const need = distYd(from, tgt);
        const carryNeeded = need / cond.factor;
        const brg = bearing(from, tgt);
        const near = [...full].sort((a, b) => Math.abs(a.yds - carryNeeded) - Math.abs(b.yds - carryNeeded)).slice(0, 2);
        const cands = near.map((c) => ({ club: c, carry: c.yds, partial: false }));
        if (wedges.length && carryNeeded < wedges[0].yds - 3) cands.push({ club: wedges[0], carry: carryNeeded, partial: true });
        for (const k of cands) {
          const fly = k.carry * cond.factor;
          options.push({ club: k.club, partial: k.partial, carry: k.carry, along, aimSide: sideAim, fly, brg, target: tgt,
            exp: simulate(ctx, from, brg, fly, k.carry, { partial: k.partial }) });
        }
      }
    }
  }
  if (!options.length) return null;
  options.sort((a, b) => a.exp - b.exp);

  // Book rule: between clubs, club down (if the shorter club is within 0.02 strokes)
  let best = options[0];
  if (rules.between_clubs === 'down') {
    const shorter = options.find((o) => o.club.yds < best.club.yds && o.exp - best.exp < 0.02);
    if (shorter) best = shorter;
  }
  // Best option per club, for "Driver vs hybrid" style comparisons
  const perClub = [];
  for (const o of options) if (!perClub.some((p) => p.club.id === o.club.id && p.partial === o.partial && p.swing === o.swing)) perClub.push(o);

  const landing = offset(from, best.brg, best.fly); // where it's expected to finish
  const toPinBrg = bearing(from, pinPt);
  const lAlong = distYd(from, landing) * Math.cos(bearing(from, landing) - toPinBrg) - toPin;
  const lSide = distYd(from, landing) * Math.sin(bearing(from, landing) - toPinBrg);
  const playsLike = Math.round(distYd(from, landing) / cond.factor);
  return {
    best, landing, playsLike, toTarget: Math.round(distYd(from, landing)), cond, lAlong, lSide,
    zone: zoneAt(course, hole.number, landing),
    alternatives: perClub.filter((p) => p !== best).slice(0, 2),
    planClub: plan || null,
    planOption: plan ? perClub.find((p) => p.club.id === plan && (!rules.plan?.swing || p.swing === rules.plan.swing)) || perClub.find((p) => p.club.id === plan) || null : null,
  };
}
