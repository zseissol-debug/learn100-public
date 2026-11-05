const DB_NAME = 'learn100-v1';
const STORE = 'sessions';

function db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(mode, operation) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const result = operation(tx.objectStore(STORE));
    tx.oncomplete = () => { database.close(); resolve(result.result); };
    tx.onerror = () => { database.close(); reject(tx.error); };
  });
}

export const saveSession = session => transact('readwrite', store => store.put(structuredClone(session)));
export const getSession = id => transact('readonly', store => store.get(id));
export const allSessions = () => transact('readonly', store => store.getAll());

export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
