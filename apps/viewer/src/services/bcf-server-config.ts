/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Persisted BCF server connection and URL validation helpers. */

export interface BcfServerConfig {
  /** Normalized base URL, e.g. https://host/bcf (no version segment). */
  serverUrl: string;
  /** Signed-in user id (email) from `current-user`. */
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires; 0 when the server didn't say. */
  tokenExpiresAt: number;
  /**
   * OAuth app credentials, kept only for client-credentials connections so
   * an expired access token can be re-granted without user interaction.
   */
  clientId: string;
  clientSecret: string;
  /** Last-selected project, so reconnects re-sync without re-picking. */
  projectId: string;
  projectName: string;
}

const STORAGE_KEY = 'ifc-lite:bcf-server:v1';
const CHANGED_EVENT = 'ifc-lite:bcf-server-changed';

function sanitize(value: unknown): BcfServerConfig | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<BcfServerConfig>;
  if (typeof parsed.serverUrl !== 'string' || parsed.serverUrl.length === 0) return null;
  if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) return null;
  return {
    serverUrl: parsed.serverUrl,
    userId: typeof parsed.userId === 'string' ? parsed.userId : '',
    accessToken: parsed.accessToken,
    refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
    tokenExpiresAt: typeof parsed.tokenExpiresAt === 'number' ? parsed.tokenExpiresAt : 0,
    clientId: typeof parsed.clientId === 'string' ? parsed.clientId : '',
    clientSecret: typeof parsed.clientSecret === 'string' ? parsed.clientSecret : '',
    projectId: typeof parsed.projectId === 'string' ? parsed.projectId : '',
    projectName: typeof parsed.projectName === 'string' ? parsed.projectName : '',
  };
}

export function loadBcfServerConfig(): BcfServerConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : null;
  } catch (error) {
    console.warn('[bcf-server] failed to read saved connection', error);
    return null;
  }
}

export function saveBcfServerConfig(config: BcfServerConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.warn('[bcf-server] failed to persist connection', error);
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function clearBcfServerConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('[bcf-server] failed to clear saved connection', error);
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function subscribeBcfServer(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGED_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Same server + account + OAuth app; refresh-token rotation still matches. */
export function isSameBcfAccount(a: BcfServerConfig, b: BcfServerConfig): boolean {
  return a.serverUrl === b.serverUrl && a.userId === b.userId && a.clientId === b.clientId;
}

/** Require TLS for BCF servers and discovered OAuth endpoints off localhost. */
export function validateBcfServerUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return 'Enter the full server URL, e.g. https://example.com/bcf';
  }
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocalhost) {
    return 'BCF server URLs must use https://';
  }
  return null;
}

/** Discovered OAuth URLs (token, auth, registration) must pass the TLS rule. */
export function requireSecureOAuthUrl(url: string | undefined, kind: string): string {
  if (!url) {
    throw new Error(`This BCF server does not advertise an OAuth2 ${kind}`);
  }
  const problem = validateBcfServerUrl(url);
  if (problem) {
    throw new Error(`This BCF server advertises an insecure ${kind} (${problem})`);
  }
  return url;
}

export function requireSecureTokenUrl(tokenUrl: string | undefined): string {
  return requireSecureOAuthUrl(tokenUrl, 'token endpoint');
}
