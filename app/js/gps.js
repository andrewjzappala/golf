// Live GPS: keeps a short buffer of readings and averages several when a shot is marked.
// "Simulated" mode replaces GPS with a point tapped on the hole map (for testing at home).

import { averageFixes } from './geo.js';

const listeners = new Set();
let watchId = null;
let buffer = []; // recent fixes {lon, lat, acc, t}
let sim = null; // {lon, lat} when simulating
export const state = { enabled: false, simulate: false, error: null, last: null };

function emit() {
  listeners.forEach((fn) => fn(state));
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function push(fix) {
  const now = Date.now();
  buffer.push(fix);
  buffer = buffer.filter((f) => now - f.t < 15000);
  state.last = fix;
  state.error = null;
  emit();
}

export function start() {
  if (state.simulate || watchId !== null) return;
  if (!('geolocation' in navigator)) {
    state.error = 'This browser has no GPS access';
    emit();
    return;
  }
  state.enabled = true;
  watchId = navigator.geolocation.watchPosition(
    (p) => push({ lon: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy, t: Date.now() }),
    (err) => {
      state.error = err.code === 1 ? 'Location permission denied' : 'Waiting for GPS…';
      emit();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
}

export function stop() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  state.enabled = false;
}

export function setSimulate(on) {
  state.simulate = on;
  if (on) {
    stop();
    state.last = sim ? { ...sim, acc: 3, t: Date.now() } : null;
  } else {
    state.last = null;
    start();
  }
  emit();
}

export function setSimPoint([lon, lat]) {
  sim = { lon, lat };
  if (state.simulate) push({ lon, lat, acc: 3, t: Date.now() });
}

export const current = () => (state.last ? [state.last.lon, state.last.lat] : null);

// Mark the ball's position: average readings from just before the tap plus ~2s after it.
// Calls back once right away with the best guess, and again with the averaged result.
export function capture(onUpdate) {
  const tapT = Date.now();
  const pick = () => averageFixes(buffer.filter((f) => f.t >= tapT - 1500));
  const quick = pick() || (state.last ? averageFixes([state.last]) : null);
  onUpdate(quick, false);
  if (state.simulate) return;
  setTimeout(() => {
    const final = pick();
    if (final) onUpdate(final, true);
  }, 2200);
}
