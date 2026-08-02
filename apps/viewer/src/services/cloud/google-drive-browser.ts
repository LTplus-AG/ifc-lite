/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-only Google Drive path: Google Identity Services (GIS) for auth and
 * the Google Picker for file selection, both loaded lazily. No server is
 * involved, and no client secret exists — GIS's implicit token model issues a
 * short-lived access token directly to the browser after the user consents in
 * a Google-hosted popup.
 *
 * Scope is deliberately `drive.file`, never `drive.readonly`: `drive.file` is
 * non-sensitive (no Google OAuth verification required) and only ever grants
 * access to files the user explicitly opens or creates through the Picker —
 * this app can never enumerate or read the rest of the user's Drive. The
 * server-side flow in `google-drive.ts` / `server/google/google.ts` requests
 * `drive.readonly` for its own reasons (folder browsing); that scope is not
 * reused here.
 *
 * The Picker stands in for the folder-browsing half of `CloudProvider`:
 * `listFolder` opens the Picker (ignoring `path`, since the Picker has its own
 * navigation UI) and resolves a single-entry list for whatever the user
 * picked, so `CloudImportDialog` needs no changes to drive this flow — the
 * user clicks the one resulting row same as any other provider, and
 * `download()` does the actual byte fetch.
 *
 * `DriveAuthClient` / `DriveFilePicker` are the seam: the real
 * implementations (`GisAuthClient`, `GooglePickerClient`) talk to `window
 * .google`, but `downloadDriveFile` — the download → `File` step — takes a
 * plain access token and `fetch` implementation, so it (and
 * `BrowserGoogleDriveProvider` wired with fake auth/picker clients) can be
 * unit-tested without any real Google session.
 */

import {
  type CloudDownloadProgress,
  type CloudFileEntry,
  type CloudProvider,
  CloudNotConnectedError,
  isSupportedCloudFile,
} from './types.js';
import { readBodyWithProgress, readErrorBody } from './oauth-provider-base.js';
import { loadGoogleIdentityServices, loadGooglePicker } from './google-drive-browser-loader.js';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Config read from Vite env; presence of both gates the browser-only path. */
export interface GoogleBrowserConfig {
  clientId: string;
  apiKey: string;
  /** Cloud project number, used as the Picker's `appId`. Optional. */
  appId?: string;
}

/** Reads `VITE_GOOGLE_CLIENT_ID` / `VITE_GOOGLE_API_KEY` / `VITE_GOOGLE_APP_ID`. */
export function loadGoogleBrowserConfig(
  env: Pick<ImportMetaEnv, 'VITE_GOOGLE_CLIENT_ID' | 'VITE_GOOGLE_API_KEY' | 'VITE_GOOGLE_APP_ID'>,
): GoogleBrowserConfig | null {
  const clientId = env.VITE_GOOGLE_CLIENT_ID;
  const apiKey = env.VITE_GOOGLE_API_KEY;
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey, appId: env.VITE_GOOGLE_APP_ID || undefined };
}

/** The file a Picker selection resolves to. */
export interface DrivePickedFile {
  id: string;
  name: string;
  sizeBytes: number | null;
}

/** Auth half of the seam: get/revoke an access token. Real impl: `GisAuthClient`. */
export interface DriveAuthClient {
  requestAccessToken(): Promise<{ accessToken: string; expiresInSec: number }>;
  revoke(accessToken: string): void;
}

/** Picker half of the seam: resolve a chosen file, or null on cancel. Real impl: `GooglePickerClient`. */
export interface DriveFilePicker {
  pickFile(accessToken: string): Promise<DrivePickedFile | null>;
}

/** Real `DriveAuthClient` backed by Google Identity Services. */
export class GisAuthClient implements DriveAuthClient {
  constructor(private readonly clientId: string) {}

  async requestAccessToken(): Promise<{ accessToken: string; expiresInSec: number }> {
    await loadGoogleIdentityServices();
    const google = window.google;
    if (!google) throw new Error('Google Identity Services failed to load');

    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: DRIVE_FILE_SCOPE,
        callback: (response) => {
          if (response.error) {
            reject(new Error(response.error_description || `Google sign-in failed: ${response.error}`));
            return;
          }
          resolve({ accessToken: response.access_token, expiresInSec: response.expires_in });
        },
        error_callback: (error) => {
          reject(new Error(error.message || `Google sign-in was ${error.type}`));
        },
      });
      client.requestAccessToken({ prompt: '' });
    });
  }

  revoke(accessToken: string): void {
    window.google?.accounts.oauth2.revoke(accessToken);
  }
}

/** Real `DriveFilePicker` backed by the Google Picker. */
export class GooglePickerClient implements DriveFilePicker {
  constructor(
    private readonly apiKey: string,
    private readonly appId?: string,
  ) {}

  async pickFile(accessToken: string): Promise<DrivePickedFile | null> {
    await loadGooglePicker();
    const google = window.google;
    if (!google) throw new Error('Google Picker failed to load');
    const picker = google.picker;

    return new Promise((resolve, reject) => {
      try {
        const builder = new picker.PickerBuilder()
          .addView(picker.ViewId.DOCS)
          .setOAuthToken(accessToken)
          .setDeveloperKey(this.apiKey);
        if (this.appId) builder.setAppId(this.appId);
        builder
          .setCallback((data) => {
            if (data.action === picker.Action.PICKED) {
              const doc = data.docs?.[0];
              resolve(
                doc
                  ? { id: doc.id, name: doc.name, sizeBytes: doc.sizeBytes ? Number(doc.sizeBytes) : null }
                  : null,
              );
            } else if (data.action === picker.Action.CANCEL) {
              resolve(null);
            }
          })
          .build()
          .setVisible(true);
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Failed to open Google Picker'));
      }
    });
  }
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

/**
 * Browser-only `CloudProvider` for Google Drive. Selected instead of the
 * server-side `GoogleDriveProvider` only when `loadGoogleBrowserConfig`
 * resolves — see `providers.ts`.
 */
export class BrowserGoogleDriveProvider implements CloudProvider {
  readonly id = 'google';
  readonly label = 'Google Drive';

  private token: CachedToken | null = null;

  constructor(
    private readonly auth: DriveAuthClient,
    private readonly picker: DriveFilePicker,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConnected(): boolean {
    return this.token !== null && this.token.expiresAt > Date.now();
  }

  async connect(): Promise<void> {
    const { accessToken, expiresInSec } = await this.auth.requestAccessToken();
    this.token = { accessToken, expiresAt: Date.now() + expiresInSec * 1000 };
  }

  async disconnect(): Promise<void> {
    if (this.token) this.auth.revoke(this.token.accessToken);
    this.token = null;
  }

  /**
   * The Picker replaces folder browsing entirely, so `path` is unused —
   * every call (including "refresh") reopens the Picker and resolves to
   * whatever the user just chose, wrapped as a single-entry list so
   * `CloudImportDialog` can render and download it exactly like any other
   * provider's listing.
   */
  async listFolder(_path: string): Promise<CloudFileEntry[]> {
    const accessToken = this.requireToken();
    const picked = await this.picker.pickFile(accessToken);
    if (!picked) throw new Error('Selection cancelled — no file was chosen.');
    if (!isSupportedCloudFile(picked.name)) {
      throw new Error(`${picked.name}: unsupported file type — pick an .ifc or .ifcx file.`);
    }
    return [
      {
        id: picked.id,
        name: picked.name,
        path: picked.id,
        size: picked.sizeBytes ?? 0,
        isFolder: false,
        modifiedMs: null,
      },
    ];
  }

  async download(entry: CloudFileEntry, onProgress?: CloudDownloadProgress): Promise<File> {
    const accessToken = this.requireToken();
    return downloadDriveFile(entry, accessToken, this.fetchImpl, onProgress);
  }

  private requireToken(): string {
    if (!this.token || this.token.expiresAt <= Date.now()) {
      this.token = null;
      throw new CloudNotConnectedError(this.id);
    }
    return this.token.accessToken;
  }
}

/**
 * The download → `File` step, factored out of the class so it can be
 * unit-tested with a mocked `fetch` and a plain access token — no GIS/Picker
 * interaction required.
 */
export async function downloadDriveFile(
  entry: CloudFileEntry,
  accessToken: string,
  fetchImpl: typeof fetch,
  onProgress?: CloudDownloadProgress,
): Promise<File> {
  const url = new URL(`${FILES_URL}/${encodeURIComponent(entry.id)}`);
  url.searchParams.set('alt', 'media');

  const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) throw new CloudNotConnectedError('google');
  if (!res.ok) {
    const detail = await readErrorBody(res, 'google');
    throw new Error(`Google Drive download failed (${res.status}): ${detail}`);
  }

  const total = entry.size || Number(res.headers.get('content-length')) || null;
  const blob = await readBodyWithProgress(res, total, onProgress);
  if (blob.size === 0) {
    throw new Error(`${entry.name} downloaded as 0 bytes — check the file still exists and try again.`);
  }
  return new File([blob], entry.name, { type: 'application/x-step' });
}

/** Build the real (non-test) browser Google Drive provider from env config. */
export function createBrowserGoogleDriveProvider(config: GoogleBrowserConfig): CloudProvider {
  return new BrowserGoogleDriveProvider(
    new GisAuthClient(config.clientId),
    new GooglePickerClient(config.apiKey, config.appId),
  );
}
