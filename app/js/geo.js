// Geometry helpers. Coordinates are [lon, lat] (GeoJSON order) throughout.

const EARTH_R = 6371008.8; // meters
export const M_TO_YD = 1.0936133;

const rad = (d) => (d * Math.PI) / 180;

export function distM(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

export const distYd = (a, b) => distM(a, b) * M_TO_YD;

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(pt, rings) {
  if (!rings.length || !pointInRing(pt, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(pt, rings[k])) return false; // hole in polygon
  return true;
}

export function pointInGeom(pt, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInPolygonCoords(pt, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((p) => pointInPolygonCoords(pt, p));
  return false;
}

// Combine several GPS fixes into one position, weighting the more accurate ones.
// fixes: [{lon, lat, acc}]. Returns {lon, lat, acc, n} or null.
export function averageFixes(fixes) {
  const good = fixes.filter((f) => f.acc <= 30);
  const use = good.length ? good : fixes;
  if (!use.length) return null;
  let w = 0, lon = 0, lat = 0;
  for (const f of use) {
    const wi = 1 / Math.max(f.acc, 1) ** 2;
    w += wi; lon += f.lon * wi; lat += f.lat * wi;
  }
  const accs = use.map((f) => f.acc).sort((a, b) => a - b);
  return {
    lon: +(lon / w).toFixed(7),
    lat: +(lat / w).toFixed(7),
    acc: Math.round(accs[Math.floor(accs.length / 2)] * 10) / 10, // median accuracy, meters
    n: use.length,
  };
}

// Local flat projection (meters) around an origin, rotated so `up` points north on screen.
export function makeProjection(origin, bearingRad = 0) {
  const kx = EARTH_R * Math.cos(rad(origin[1])) * (Math.PI / 180);
  const ky = EARTH_R * (Math.PI / 180);
  const c = Math.cos(bearingRad), s = Math.sin(bearingRad);
  return {
    toXY([lon, lat]) {
      const x = (lon - origin[0]) * kx;
      const y = (lat - origin[1]) * ky;
      // rotate so the bearing direction points up (screen y grows downward)
      return [x * c - y * s, -(x * s + y * c)];
    },
    toLonLat([sx, sy]) {
      const rx = sx, ry = -sy;
      const x = rx * c + ry * s;
      const y = -rx * s + ry * c;
      return [origin[0] + x / kx, origin[1] + y / ky];
    },
  };
}

// Bearing from a to b, radians clockwise from north.
export function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x =
    Math.cos(rad(a[1])) * Math.sin(rad(b[1])) -
    Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return Math.atan2(y, x);
}
