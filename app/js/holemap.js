// Yardage-book style hole drawing (offline, no map tiles). Tee at the bottom, green at the top,
// with distance arcs measured from the center of the green.

import { makeProjection, bearing, M_TO_YD } from './geo.js';
import { teeBox } from './course.js';

let current = null; // projection for the drawing on screen, used to convert taps back to lon/lat

const ring = (proj, coords) => coords.map((p) => proj.toXY(p).map((v) => v.toFixed(1)).join(',')).join(' ');
const poly = (proj, geom, cls) =>
  geom?.type === 'Polygon' ? `<polygon class="${cls}" points="${ring(proj, geom.coordinates[0])}"/>` : '';

// aspect = width / height of the drawing on screen
export function renderHoleMap({ hole, teeIndex, shots, live, pin, aspect = 0.55 }) {
  const tee = teeBox(hole, teeIndex).point;
  const green = hole.green.center;
  const origin = [(tee[0] + green[0]) / 2, (tee[1] + green[1]) / 2];
  const proj = makeProjection(origin, bearing(tee, green));
  current = proj;

  const pts = [
    ...(hole.tee_boxes || []).map((t) => t.point),
    ...hole.green.polygon.coordinates[0],
    ...(hole.hole_line?.coordinates || []),
    ...(hole.fairways || []).flatMap((f) => f.polygon.coordinates[0]),
  ].map((p) => proj.toXY(p));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const padY = (maxY - minY) * 0.06 + 8;
  minY -= padY; maxY += padY;
  let w = maxX - minX + 16, h = maxY - minY;
  // widen or heighten the frame to match the space on screen
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  minX = cx - w / 2; minY = cy - h / 2;
  const k = h / 300; // ≈ meters per screen pixel, keeps marks the same size on every hole

  // Distance arcs from the green center, labelled along the line back toward the tee
  const g = proj.toXY(green), t = proj.toXY(tee);
  const len = Math.hypot(t[0] - g[0], t[1] - g[1]);
  const ux = (t[0] - g[0]) / len, uy = (t[1] - g[1]) / len;
  const teeYds = len * M_TO_YD;
  const arcs = [50, 100, 150, 200, 250, 300].filter((y) => y < teeYds - 25).map((y) => {
    const r = y / M_TO_YD;
    const lx = g[0] + ux * r + 7 * k, ly = g[1] + uy * r;
    return `<circle class="m-arc" cx="${g[0].toFixed(1)}" cy="${g[1].toFixed(1)}" r="${r.toFixed(1)}" stroke-width="${(0.7 * k).toFixed(2)}"/>
      <text class="m-arc-lbl" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="${(13 * k).toFixed(1)}" stroke-width="${(3 * k).toFixed(1)}">${y}</text>`;
  }).join('');

  const shotPts = shots.filter((s) => s.start?.pos).map((s) => proj.toXY([s.start.pos.lon, s.start.pos.lat]));
  const line = hole.hole_line?.coordinates
    ? `<polyline class="m-line" points="${ring(proj, hole.hole_line.coordinates)}" stroke-width="${(0.8 * k).toFixed(2)}" stroke-dasharray="${2 * k} ${3 * k}"/>` : '';
  const pinXY = proj.toXY(pin || green);
  const liveXY = live ? proj.toXY(live) : null;
  const sw = (0.9 * k).toFixed(2);

  return `<svg class="holemap" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" data-action="map-tap">
    <defs><pattern id="sand-dots" width="${3 * k}" height="${3 * k}" patternUnits="userSpaceOnUse">
      <circle cx="${1.5 * k}" cy="${1.5 * k}" r="${0.45 * k}" class="m-dot"/></pattern></defs>
    <g stroke-width="${sw}">
      ${(hole.fairways || []).map((f) => poly(proj, f.polygon, 'm-fairway')).join('')}
      ${(hole.water || []).map((f) => poly(proj, f.polygon, 'm-water')).join('')}
      ${(hole.tee_boxes || []).map((t) => poly(proj, t.polygon, 'm-tee')).join('')}
      ${poly(proj, hole.green.polygon, 'm-green')}
      ${(hole.bunkers || []).map((f) => poly(proj, f.polygon, 'm-sand')).join('')}
    </g>
    ${arcs}
    ${line}
    ${shotPts.length > 1 ? `<polyline class="m-shots" points="${shotPts.map((p) => p.join(',')).join(' ')}" stroke-width="${(1.1 * k).toFixed(2)}"/>` : ''}
    ${shotPts.map((p) => `<circle class="m-shot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(3.6 * k).toFixed(1)}" stroke-width="${(1.2 * k).toFixed(2)}"/>`).join('')}
    <circle class="m-pin" cx="${pinXY[0].toFixed(1)}" cy="${pinXY[1].toFixed(1)}" r="${(2.6 * k).toFixed(1)}"/>
    ${liveXY ? `<circle class="m-live" cx="${liveXY[0].toFixed(1)}" cy="${liveXY[1].toFixed(1)}" r="${(5 * k).toFixed(1)}" stroke-width="${(2 * k).toFixed(1)}"/>` : ''}
  </svg>`;
}

export function mapEventToLonLat(svg, evt) {
  if (!current) return null;
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return current.toLonLat([p.x, p.y]);
}
