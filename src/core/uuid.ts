import type { Uuid } from "./types.ts";

/**
 * Generate a 32-char hex id (128 bits).
 *
 * Ids are minted client-side so records have stable identity offline and push/sync stays
 * idempotent (ARCHITECTURE.md §9). Uses the platform CSPRNG (`crypto.getRandomValues`, present on
 * every browser and Node ≥ 15) for collision resistance and unpredictability — important because a
 * guessable or colliding id minted by one offline client could clash with (or expose) another
 * client's records on sync. Falls back to `Math.random` only on a runtime with no `crypto`.
 */
export function generateUuid(): Uuid {
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    let uuid = "";
    for (const b of bytes) uuid += b.toString(16).padStart(2, "0");
    return uuid;
  }
  const hex = "0123456789abcdef";
  let uuid = "";
  for (let i = 0; i < 32; i++) {
    uuid += hex[Math.floor(Math.random() * 16)];
  }
  return uuid;
}
