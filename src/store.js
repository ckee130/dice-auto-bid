/**
 * Everything the bot remembers between opening the popup and finishing a run.
 *
 * Two homes, chosen by what the data is. The profile and the loaded links are
 * small and wanted by every part of the extension, so they live in
 * chrome.storage.local. The results - one record per job ever worked
 * through, with what became of it - go to IndexedDB, which has no quota
 * worth mentioning.
 */

import { withDefaults } from "./profile.js";

const DATABASE = "dice-apply";
const VERSION = 1;
const RESULTS = "results";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RESULTS)) database.createObjectStore(RESULTS, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(store, mode, work) {
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(store, mode);
      const request = work(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/**
 * Records what became of a job. One record per id, the latest - except that
 * a record of an application sent is never written over by anything less: a
 * later look at the same link that skips it ("already applied") would
 * otherwise erase the proof that it was applied to.
 */
export async function recordResult(result) {
  const SENT = new Set(["submitted", "unconfirmed"]);
  if (!SENT.has(result.status)) {
    const existing = await transact(RESULTS, "readonly", (store) => store.get(result.id)).catch(() => null);
    if (existing && SENT.has(existing.status)) return existing;
  }
  return transact(RESULTS, "readwrite", (store) => store.put(result));
}

export function allResults() {
  return transact(RESULTS, "readonly", (store) => store.getAll()).then((rows) => rows ?? []);
}

export function clearResults() {
  return transact(RESULTS, "readwrite", (store) => store.clear());
}

/**
 * The links a run will work through: { id, link } per Dice posting, as
 * built by links.js. Loaded by pressing a button rather than read when the
 * run starts, so the list can be looked at before anything opens a tab.
 */
export async function saveLinks(links) {
  await chrome.storage.local.set({ links, linksLoadedAt: Date.now() });
}

export async function allLinks() {
  const stored = await chrome.storage.local.get(["links", "linksLoadedAt"]);
  return { links: stored.links ?? [], at: stored.linksLoadedAt ?? 0 };
}

export function clearLinks() {
  return chrome.storage.local.remove(["links", "linksLoadedAt"]);
}

export async function readProfile() {
  const stored = await chrome.storage.local.get("profile");
  return withDefaults(stored.profile);
}

export async function writeProfile(profile) {
  await chrome.storage.local.set({ profile: { ...(await readProfile()), ...profile } });
}

/**
 * Base64 for a blob, without FileReader.
 *
 * A service worker has no FileReader, and spreading a whole file into
 * String.fromCharCode overflows the argument limit somewhere around a hundred
 * thousand bytes - which a PDF reaches. Hence the chunking.
 */
export async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
