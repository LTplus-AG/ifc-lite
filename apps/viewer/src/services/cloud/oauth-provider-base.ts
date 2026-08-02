/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared browser-side base for cloud providers that authenticate through our
 * serverless OAuth routes (`/api/<id>/{auth-start,token,disconnect}`).
 *
 * The app secret and long-lived refresh token stay server-side (httpOnly
 * cookie); this client only ever holds a short-lived access token in memory and
 * uses it to call the provider's API directly, so IFC bytes stream straight to
 * the browser and never touch our servers.
 *
 * OAuth consent runs in a popup; completion is signalled back via a same-origin
 * `localStorage` write (the `storage` event), which survives the app's
 * `Cross-Origin-Opener-Policy: same-origin` header — `window.opener` does not.
 *
 * Subclasses implement only `listFolder`/`download` (the provider's REST shape).
 */

import {
  type CloudDownloadProgress,
  type CloudFileEntry,
  type CloudProvider,
  CloudNotConnectedError,
} from './types.js';

/** Key the popup callback page writes to; mirrors the server handler. */
const AUTH_RESULT_KEY = 'ifc-lite:cloud:auth-result';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

export abstract class OAuthCloudProvider implements CloudProvider {
  abstract readonly id: string;
  abstract readonly label: string;

  private token: CachedToken | null = null;

  abstract listFolder(path: string): Promise<CloudFileEntry[]>;
  abstract download(entry: CloudFileEntry, onProgress?: CloudDownloadProgress): Promise<File>;

  private get connectedFlag(): string {
    return `ifc-lite:${this.id}:connected`;
  }

  isConnected(): boolean {
    try {
      return localStorage.getItem(this.connectedFlag) === '1';
    } catch (err) {
      console.warn(`[${this.id}] could not read connection flag:`, err);
      return false;
    }
  }

  protected setConnected(connected: boolean): void {
    try {
      if (connected) localStorage.setItem(this.connectedFlag, '1');
      else localStorage.removeItem(this.connectedFlag);
    } catch (err) {
      console.warn(`[${this.id}] could not persist connection flag:`, err);
    }
  }

  /** Drop the cached access token (e.g. on a 401), forcing a refresh next call. */
  protected invalidateToken(): void {
    this.token = null;
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // `storage` only fires when the key's value actually *changes* — if a
      // stale result from an earlier attempt (this provider or another) is
      // still sitting in localStorage and the popup happens to write back an
      // identical value, the event never fires and this promise hangs
      // forever waiting for a signal that already happened. Clearing it
      // before opening the popup guarantees the next write is always a
      // change.
      try {
        localStorage.removeItem(AUTH_RESULT_KEY);
      } catch (err) {
        console.warn(`[${this.id}] could not clear stale auth result:`, err);
      }

      const w = 560;
      const h = 720;
      const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
      const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
      const popup = window.open(
        `/api/${this.id}/auth-start`,
        `${this.id}-oauth`,
        `popup,width=${w},height=${h},left=${left},top=${top}`,
      );
      if (!popup) {
        reject(new Error('Popup blocked — allow popups for ifclite.com to connect.'));
        return;
      }

      let settled = false;
      const cleanup = () => {
        window.removeEventListener('storage', onStorage);
        clearInterval(closedPoll);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onStorage = (e: StorageEvent) => {
        if (e.key !== AUTH_RESULT_KEY || !e.newValue) return;
        try {
          const result = JSON.parse(e.newValue) as { provider?: string; ok?: boolean; message?: string };
          if (result.provider && result.provider !== this.id) return; // another provider's popup
          localStorage.removeItem(AUTH_RESULT_KEY);
          if (result.ok) {
            this.setConnected(true);
            finish(resolve);
          } else {
            finish(() => reject(new Error(result.message || 'Connection failed')));
          }
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error('Bad auth result')));
        }
      };
      window.addEventListener('storage', onStorage);

      // Detect the user closing the popup without finishing consent.
      const closedPoll = window.setInterval(() => {
        if (popup.closed) finish(() => reject(new Error('Connection cancelled')));
      }, 500);
    });
  }

  async disconnect(): Promise<void> {
    this.invalidateToken();
    this.setConnected(false);
    try {
      await fetch(`/api/${this.id}/disconnect`, { method: 'POST', credentials: 'same-origin' });
    } catch (err) {
      // Non-fatal: the local flag is cleared regardless.
      console.warn(`[${this.id}] disconnect request failed:`, err);
    }
  }

  /** Fetch (and cache) a short-lived access token via our serverless route. */
  protected async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.accessToken;
    }
    const res = await fetch(`/api/${this.id}/token`, { method: 'POST', credentials: 'same-origin' });
    // 401 is the server's "the refresh token is definitively dead" signal
    // (see oauth-handlers.ts's `token` handler) — only then do we drop the
    // local connection and ask the user to reconnect. Any other failure
    // (503 = the provider/network hiccuped but the refresh token is still
    // good) leaves the connection flag alone so the next attempt just
    // retries, instead of forcing a full reconnect over a transient blip.
    if (res.status === 401) {
      this.setConnected(false);
      throw new CloudNotConnectedError(this.id);
    }
    if (res.status === 503) {
      throw new Error(`${this.label} is temporarily unavailable — try again in a moment.`);
    }
    if (!res.ok) {
      throw new Error(`${this.label} token request failed: ${res.status}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    this.setConnected(true);
    return this.token.accessToken;
  }

  /** Map a provider 401 onto the shared not-connected error and reset state. */
  protected notConnected(): CloudNotConnectedError {
    this.invalidateToken();
    this.setConnected(false);
    return new CloudNotConnectedError(this.id);
  }
}

/**
 * Read a response body for error diagnostics. Unlike a bare `.catch(() => '')`,
 * this logs (rather than silently swallows) a body-read failure before falling
 * back to an empty string, per the repo's catch-must-log rule.
 */
export async function readErrorBody(res: Response, providerId: string): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    console.warn(`[${providerId}] failed to read error response body:`, err);
    return '';
  }
}

/** Stream a response body into a Blob, reporting progress as bytes arrive. */
export async function readBodyWithProgress(
  res: Response,
  total: number | null,
  onProgress?: CloudDownloadProgress,
): Promise<Blob> {
  if (!res.body || !onProgress) {
    return res.blob();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded, total);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks as BlobPart[], { type: 'application/x-step' });
}
