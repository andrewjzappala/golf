// On-device storage (IndexedDB). Everything is saved on the phone first.

const DB_NAME = 'golf-tracker';
const VERSION = 1;
export const STORES = ['rounds', 'holeResults', 'shots', 'weather', 'meta'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('rounds', { keyPath: 'id' });
      for (const name of ['holeResults', 'shots', 'weather']) {
        db.createObjectStore(name, { keyPath: 'id' }).createIndex('roundId', 'roundId');
      }
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

const request = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const complete = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export async function put(store, obj) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put({ ...obj, updatedAt: new Date().toISOString() });
  await complete(tx);
  return obj;
}

export async function get(store, key) {
  const db = await open();
  return request(db.transaction(store).objectStore(store).get(key));
}

export async function all(store) {
  const db = await open();
  return request(db.transaction(store).objectStore(store).getAll());
}

export async function byRound(store, roundId) {
  const db = await open();
  return request(db.transaction(store).objectStore(store).index('roundId').getAll(roundId));
}

export async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await complete(tx);
}

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export const setMeta = (key, value) => put('meta', { key, value });

export async function exportAll() {
  const out = { app: 'golf-tracker', schema: VERSION, exportedAt: new Date().toISOString() };
  for (const s of STORES) out[s] = await all(s);
  return out;
}

// Merge an export back in (records with the same id are replaced).
export async function importAll(data) {
  const db = await open();
  const tx = db.transaction(STORES, 'readwrite');
  for (const s of STORES) for (const row of data[s] || []) tx.objectStore(s).put(row);
  await complete(tx);
}

export async function deleteRound(roundId) {
  const db = await open();
  const tx = db.transaction(['rounds', 'holeResults', 'shots', 'weather'], 'readwrite');
  tx.objectStore('rounds').delete(roundId);
  for (const s of ['holeResults', 'shots', 'weather']) {
    const store = tx.objectStore(s);
    // callbacks, not await, so the transaction stays open
    store.index('roundId').getAllKeys(roundId).onsuccess = (e) =>
      e.target.result.forEach((k) => store.delete(k));
  }
  await complete(tx);
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}
