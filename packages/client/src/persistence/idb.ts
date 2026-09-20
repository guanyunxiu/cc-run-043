/**
 * 极简 IndexedDB Promise 封装（不依赖外部库）。
 * 数据库与 y-indexeddb 采用同构的 update 存储语义。
 */

const DB_VERSION = 1;
const DEFAULT_DB = 'coedit-local';

export interface IdbSchema {
  /** Yjs 文档二进制增量（按 docId 多行累积） */
  updates: { key: 'id'; indexes: 'docId' };
  /** 压缩后的整文档快照（每 doc 一行） */
  snapshots: { key: 'docId' };
  /** 待同步增量队列（离线编辑暂存） */
  pending: { key: 'id'; indexes: 'docId' };
  /** 临时文档状态（滚动位置/活动块等，纯本地） */
  tempstate: { key: 'docId' };
}

type StoreName = keyof IdbSchema;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDatabase(name = DEFAULT_DB): Promise<IDBDatabase> {
  if (name === DEFAULT_DB && dbPromise) return dbPromise;
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('updates')) {
        const updates = db.createObjectStore('updates', { keyPath: 'id', autoIncrement: true });
        updates.createIndex('docId', 'docId', { unique: false });
      }
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'docId' });
      }
      if (!db.objectStoreNames.contains('pending')) {
        const pending = db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
        pending.createIndex('docId', 'docId', { unique: false });
      }
      if (!db.objectStoreNames.contains('tempstate')) {
        db.createObjectStore('tempstate', { keyPath: 'docId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (name === DEFAULT_DB) dbPromise = promise;
  return promise;
}

function tx<T>(
  db: IDBDatabase,
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut<T>(store: StoreName, value: T, dbName = DEFAULT_DB): Promise<IDBValidKey> {
  const db = await openDatabase(dbName);
  return tx(db, store, 'readwrite', (s) => s.put(value as any));
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey, dbName = DEFAULT_DB): Promise<T | undefined> {
  const db = await openDatabase(dbName);
  return tx(db, store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
}

export async function idbGetAllByIndex<T>(
  store: StoreName,
  indexName: string,
  query: IDBValidKey,
  dbName = DEFAULT_DB,
): Promise<T[]> {
  const db = await openDatabase(dbName);
  return new Promise<T[]>((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const idx = t.objectStore(store).index(indexName);
    const req = idx.getAll(query);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll<T>(store: StoreName, dbName = DEFAULT_DB): Promise<T[]> {
  const db = await openDatabase(dbName);
  return new Promise<T[]>((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const req = t.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(store: StoreName, keys: IDBValidKey[], dbName = DEFAULT_DB): Promise<void> {
  const db = await openDatabase(dbName);
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const k of keys) s.delete(k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbClearStore(store: StoreName, dbName = DEFAULT_DB): Promise<void> {
  const db = await openDatabase(dbName);
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbCountByIndex(
  store: StoreName,
  indexName: string,
  query: IDBValidKey,
  dbName = DEFAULT_DB,
): Promise<number> {
  const db = await openDatabase(dbName);
  return new Promise<number>((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const req = t.objectStore(store).index(indexName).count(query);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
