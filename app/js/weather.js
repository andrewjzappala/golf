// Per-hole weather snapshots from Open-Meteo (free, no API key).
// If the phone is offline on the course, the snapshot stays "pending" and is
// filled in later from Open-Meteo's hourly history for that time and place.

import * as db from './db.js';

const FIELDS = 'temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const UNITS = '&wind_speed_unit=mph&temperature_unit=fahrenheit';
const BASE = 'https://api.open-meteo.com/v1/forecast';

function toSnapshot(v) {
  return {
    tempF: v.temperature_2m,
    humidityPct: v.relative_humidity_2m,
    pressureHpa: v.surface_pressure,
    windMph: v.wind_speed_10m,
    windDirDeg: v.wind_direction_10m, // direction the wind comes FROM
    gustMph: v.wind_gusts_10m,
  };
}

export async function recordHoleWeather(roundId, hole, pt) {
  const id = `${roundId}:${hole}`;
  if (await db.get('weather', id)) return;
  const snap = { id, roundId, hole, time: new Date().toISOString(), lon: pt[0], lat: pt[1], status: 'pending' };
  await db.put('weather', snap);
  fillCurrent(snap);
}

async function fillCurrent(snap) {
  if (!navigator.onLine) return;
  try {
    const res = await fetch(`${BASE}?latitude=${snap.lat}&longitude=${snap.lon}&current=${FIELDS}${UNITS}`);
    if (!res.ok) return;
    const j = await res.json();
    await db.put('weather', { ...snap, ...toSnapshot(j.current), status: 'live', source: 'open-meteo' });
  } catch {}
}

// Live conditions for the hole screen. Cached for 10 minutes; offline it returns the last known
// reading (with its time) so the screen never goes blank mid-round.
let live = null; // { t, data }
export async function currentConditions(pt) {
  if (live && Date.now() - live.t < 10 * 60e3) return live.data;
  if (!navigator.onLine || !pt) return live?.data || null;
  try {
    const res = await fetch(`${BASE}?latitude=${pt[1]}&longitude=${pt[0]}&current=${FIELDS}${UNITS}`);
    if (!res.ok) return live?.data || null;
    const j = await res.json();
    live = { t: Date.now(), data: { ...toSnapshot(j.current), at: new Date().toISOString() } };
    return live.data;
  } catch {
    return live?.data || null;
  }
}

// Fill any pending snapshots using hourly data around the recorded time.
export async function backfillPending() {
  if (!navigator.onLine) return;
  const pending = (await db.all('weather')).filter((w) => w.status === 'pending');
  for (const w of pending) {
    try {
      const day = w.time.slice(0, 10);
      const url = `${BASE}?latitude=${w.lat}&longitude=${w.lon}&hourly=${FIELDS}${UNITS}&timezone=GMT&start_date=${day}&end_date=${day}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = await res.json();
      const target = new Date(w.time).getTime();
      let best = 0, bestDiff = Infinity;
      j.hourly.time.forEach((t, i) => {
        const diff = Math.abs(new Date(t + 'Z').getTime() - target);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
      });
      const v = Object.fromEntries(FIELDS.split(',').map((k) => [k, j.hourly[k][best]]));
      await db.put('weather', { ...w, ...toSnapshot(v), status: 'hourly', source: 'open-meteo' });
    } catch {}
  }
}
