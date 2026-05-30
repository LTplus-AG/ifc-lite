/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collaboration feature configuration (M1 scaffolding).
 *
 * Multiuser collab ships dark behind `collab.enabled` per the rollout plan
 * (`docs/architecture/essen-multiuser-collab-plan.md` §7.8). The flag is read
 * from the Vite build env, with a `localStorage` override so the feature can
 * be flipped on per-browser during development without a rebuild.
 *
 *   VITE_COLLAB_ENABLED=true        — enable the Share button + collab UI
 *   VITE_COLLAB_SERVER_URL=wss://…  — collab-server websocket endpoint
 *
 * When no server URL is configured the session falls back to a local-only
 * IndexedDB provider, which is enough to exercise the UI and presence wiring
 * in a single browser (multi-tab via BroadcastChannel) without a backend.
 */

const LS_OVERRIDE_KEY = 'ifc-lite:collab:enabled';

function readEnvFlag(): boolean {
  // import.meta.env.* is statically replaced by Vite at build time.
  const raw = import.meta.env.VITE_COLLAB_ENABLED;
  return raw === 'true' || raw === '1';
}

function readLocalStorageOverride(): boolean | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const v = localStorage.getItem(LS_OVERRIDE_KEY);
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return null;
  } catch {
    return null;
  }
}

/** Whether the collaboration feature is enabled in this session. */
export function isCollabEnabled(): boolean {
  const override = readLocalStorageOverride();
  if (override !== null) return override;
  return readEnvFlag();
}

/** Persist a per-browser override for the collab flag (dev affordance). */
export function setCollabEnabledOverride(enabled: boolean | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (enabled === null) localStorage.removeItem(LS_OVERRIDE_KEY);
    else localStorage.setItem(LS_OVERRIDE_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore — non-fatal
  }
}

/** Configured collab-server websocket URL, or `null` for local-only mode. */
export function collabServerUrl(): string | null {
  const raw = import.meta.env.VITE_COLLAB_SERVER_URL;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
