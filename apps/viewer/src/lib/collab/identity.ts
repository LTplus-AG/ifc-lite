/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ephemeral, accountless identity (plan §2.2).
 *
 * Sharing is link-based with no login. Each browser gets a friendly,
 * editable handle and a stable color, persisted in `localStorage` so the
 * same browser keeps its identity across sessions. This is purely a display
 * concern — authorization rides entirely in the room token (plan §3), never
 * in an account.
 */

const LS_IDENTITY_KEY = 'ifc-lite:collab:identity';

/**
 * Deterministic per-user color, replicated from `@ifc-lite/collab`'s
 * `colorForUser` (FNV-1a over a 12-hue palette). Kept local so the identity
 * bootstrap — which runs at store init even when collab is disabled — never
 * pulls the collab runtime (yjs/automerge) into the main bundle. The palette
 * and hash MUST stay in sync with the package so a peer's color matches what
 * the server-side awareness would compute for the same id.
 */
const USER_PALETTE: readonly string[] = [
  '#5b8def', '#ef6f6c', '#7ac74f', '#f5b041', '#a569bd', '#48c9b0',
  '#ec7063', '#5d6d7e', '#f4d03f', '#ec407a', '#26a69a', '#7e57c2',
];

function colorForUser(userId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return USER_PALETTE[(hash >>> 0) % USER_PALETTE.length];
}

export interface EphemeralIdentity {
  /** Stable per-browser id. Used for the presence color hash + audit keys. */
  id: string;
  /** Friendly, user-editable display name. */
  name: string;
  /** Stable color derived from `id` (overridable). */
  color: string;
}

const ADJECTIVES = [
  'swift', 'curious', 'calm', 'bright', 'bold', 'quiet', 'clever', 'eager',
  'gentle', 'brave', 'lucky', 'merry', 'noble', 'witty',
];
const ANIMALS = [
  'otter', 'lynx', 'heron', 'fox', 'ibex', 'marten', 'falcon', 'badger',
  'gecko', 'puffin', 'tapir', 'quokka', 'narwhal', 'pangolin',
];

function randomId(): string {
  // crypto.randomUUID is available in all viewer-supported browsers.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `u-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function randomHandle(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a}-${n}`;
}

function isIdentity(value: unknown): value is EphemeralIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.color === 'string';
}

/** Load the persisted identity, minting (and persisting) a fresh one if absent. */
export function loadOrCreateIdentity(): EphemeralIdentity {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(LS_IDENTITY_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isIdentity(parsed)) return parsed;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[collab] failed to read stored identity; minting a fresh one:', err);
    }
  }
  const id = randomId();
  const identity: EphemeralIdentity = { id, name: randomHandle(), color: colorForUser(id) };
  persistIdentity(identity);
  return identity;
}

/** Persist an identity (e.g. after the user renames themselves). */
export function persistIdentity(identity: EphemeralIdentity): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_IDENTITY_KEY, JSON.stringify(identity));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[collab] failed to persist identity to localStorage:', err);
  }
}
