const DB_NAME = "pr-quality-cache";
const STORE_NAME = "responses";
const DB_VERSION = 1;

export type CachedValue<T> = {
  value: T;
  expiresAt: number;
};

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export const cacheGet = async <T>(key: string): Promise<T | null> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => {
      const record = req.result as CachedValue<T> | undefined;
      if (!record) {
        resolve(null);
        return;
      }
      if (Date.now() > record.expiresAt) {
        resolve(null);
        return;
      }
      resolve(record.value);
    };
    req.onerror = () => reject(req.error);
  });
};

export const cacheSet = async <T>(key: string, value: T, ttlMs: number): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ value, expiresAt: Date.now() + ttlMs } satisfies CachedValue<T>, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const cacheClear = async (): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const cachedFetch = async <T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number
): Promise<T> => {
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    return cached;
  }
  const value = await fetcher();
  await cacheSet(key, value, ttlMs);
  return value;
};
