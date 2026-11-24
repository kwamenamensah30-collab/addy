// Local storage on the device (IndexedDB), so collection keeps working with no signal.
const DB_NAME = 'addy', VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('points')) d.createObjectStore('points', { keyPath: 'id' }).createIndex('project', 'project_id');
      if (!d.objectStoreNames.contains('datasets')) d.createObjectStore('datasets', { keyPath: 'id' }).createIndex('project', 'project_id');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  async get(key, fallback) {
    const d = await open();
    const v = await reqP(d.transaction('kv').objectStore('kv').get(key));
    return v === undefined ? fallback : v;
  },
  async set(key, value) {
    const d = await open();
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    return done(tx);
  },
  async all(storeName, projectId) {
    const d = await open();
    return reqP(d.transaction(storeName).objectStore(storeName).index('project').getAll(projectId));
  },
  async put(storeName, items) {
    const d = await open();
    const tx = d.transaction(storeName, 'readwrite');
    const os = tx.objectStore(storeName);
    for (const it of [].concat(items)) os.put(it);
    return done(tx);
  },
  async remove(storeName, ids) {
    const d = await open();
    const tx = d.transaction(storeName, 'readwrite');
    for (const id of [].concat(ids)) tx.objectStore(storeName).delete(id);
    return done(tx);
  },
};
