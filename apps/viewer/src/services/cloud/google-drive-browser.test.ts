/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Covers the browser-only Google Drive path without any real GIS/Picker
 * session: `BrowserGoogleDriveProvider` is driven with fake `DriveAuthClient`
 * / `DriveFilePicker` implementations, and `downloadDriveFile` is exercised
 * directly with a stubbed `fetch`. No `window.google` interaction is needed
 * for any of this — that's the point of the seam.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CloudNotConnectedError, type CloudFileEntry } from './types.js';
import {
  BrowserGoogleDriveProvider,
  GoogleDriveNotConfiguredProvider,
  createGoogleDriveProvider,
  downloadDriveFile,
  loadGoogleBrowserConfig,
  type DriveAuthClient,
  type DriveFilePicker,
  type DrivePickedFile,
} from './google-drive-browser.js';

function makeAuth(overrides: Partial<DriveAuthClient> = {}): DriveAuthClient {
  return {
    requestAccessToken: async () => ({ accessToken: 'tok', expiresInSec: 3600 }),
    revoke: () => {},
    ...overrides,
  };
}

function makePicker(result: DrivePickedFile | null | (() => Promise<DrivePickedFile | null>)): DriveFilePicker {
  return {
    pickFile: async () => (typeof result === 'function' ? result() : result),
  };
}

describe('loadGoogleBrowserConfig', () => {
  it('resolves config when both client id and api key are set', () => {
    const config = loadGoogleBrowserConfig({
      VITE_GOOGLE_CLIENT_ID: 'client-id',
      VITE_GOOGLE_API_KEY: 'api-key',
      VITE_GOOGLE_APP_ID: '12345',
    });
    assert.deepStrictEqual(config, { clientId: 'client-id', apiKey: 'api-key', appId: '12345' });
  });

  it('returns null when either is missing (createGoogleDriveProvider falls back to the not-configured stub)', () => {
    assert.strictEqual(
      loadGoogleBrowserConfig({ VITE_GOOGLE_CLIENT_ID: 'x', VITE_GOOGLE_API_KEY: undefined, VITE_GOOGLE_APP_ID: undefined }),
      null,
    );
    assert.strictEqual(
      loadGoogleBrowserConfig({ VITE_GOOGLE_CLIENT_ID: undefined, VITE_GOOGLE_API_KEY: 'y', VITE_GOOGLE_APP_ID: undefined }),
      null,
    );
    assert.strictEqual(
      loadGoogleBrowserConfig({ VITE_GOOGLE_CLIENT_ID: undefined, VITE_GOOGLE_API_KEY: undefined, VITE_GOOGLE_APP_ID: undefined }),
      null,
    );
  });
});

describe('createGoogleDriveProvider', () => {
  it('returns the not-configured stub when config is null', () => {
    const provider = createGoogleDriveProvider(null);
    assert.ok(provider instanceof GoogleDriveNotConfiguredProvider);
    assert.strictEqual(provider.id, 'google');
    assert.strictEqual(provider.label, 'Google Drive');
  });

  it('returns a live BrowserGoogleDriveProvider when config is present', () => {
    const provider = createGoogleDriveProvider({ clientId: 'id', apiKey: 'key' });
    assert.ok(provider instanceof BrowserGoogleDriveProvider);
  });
});

describe('GoogleDriveNotConfiguredProvider', () => {
  it('is never connected and every action rejects with a real, specific message', async () => {
    const provider = new GoogleDriveNotConfiguredProvider();
    assert.strictEqual(provider.isConnected(), false);
    await assert.rejects(provider.connect(), /VITE_GOOGLE_CLIENT_ID.*VITE_GOOGLE_API_KEY/);
    await assert.rejects(provider.listFolder(''), /VITE_GOOGLE_CLIENT_ID/);
    await assert.rejects(
      provider.download({ id: 'f', name: 'Tower.ifc', path: 'f', size: 10, isFolder: false, modifiedMs: null }),
      /VITE_GOOGLE_CLIENT_ID/,
    );
    // disconnect() is a harmless no-op — there is nothing to revoke.
    await provider.disconnect();
  });
});

describe('BrowserGoogleDriveProvider — connect/disconnect lifecycle', () => {
  it('is not connected until connect() resolves a token', async () => {
    const provider = new BrowserGoogleDriveProvider(makeAuth(), makePicker(null));
    assert.strictEqual(provider.isConnected(), false);
    await provider.connect();
    assert.strictEqual(provider.isConnected(), true);
  });

  it('propagates a token refusal (e.g. user denies consent) from connect()', async () => {
    const provider = new BrowserGoogleDriveProvider(
      makeAuth({ requestAccessToken: async () => { throw new Error('Google sign-in was popup_closed'); } }),
      makePicker(null),
    );
    await assert.rejects(provider.connect(), /popup_closed/);
    assert.strictEqual(provider.isConnected(), false);
  });

  it('disconnect() revokes the token and clears connected state', async () => {
    let revoked: string | null = null;
    const provider = new BrowserGoogleDriveProvider(
      makeAuth({ revoke: (token) => { revoked = token; } }),
      makePicker(null),
    );
    await provider.connect();
    await provider.disconnect();
    assert.strictEqual(revoked, 'tok');
    assert.strictEqual(provider.isConnected(), false);
  });
});

describe('BrowserGoogleDriveProvider#listFolder', () => {
  it('throws CloudNotConnectedError when called before connect()', async () => {
    const provider = new BrowserGoogleDriveProvider(makeAuth(), makePicker(null));
    await assert.rejects(provider.listFolder(''), CloudNotConnectedError);
  });

  it('resolves a single entry for a supported picked file', async () => {
    const provider = new BrowserGoogleDriveProvider(
      makeAuth(),
      makePicker({ id: 'file-1', name: 'Tower.ifc', sizeBytes: 1024 }),
    );
    await provider.connect();
    const entries = await provider.listFolder('');
    assert.deepStrictEqual(entries, [
      { id: 'file-1', name: 'Tower.ifc', path: 'file-1', size: 1024, isFolder: false, modifiedMs: null },
    ]);
  });

  it('surfaces a clear message when the user cancels the Picker', async () => {
    const provider = new BrowserGoogleDriveProvider(makeAuth(), makePicker(null));
    await provider.connect();
    await assert.rejects(provider.listFolder(''), /cancelled/);
  });

  it('rejects an unsupported file type with an honest message instead of downloading it', async () => {
    const provider = new BrowserGoogleDriveProvider(
      makeAuth(),
      makePicker({ id: 'file-2', name: 'notes.pdf', sizeBytes: 200 }),
    );
    await provider.connect();
    await assert.rejects(provider.listFolder(''), /notes\.pdf.*unsupported file type/);
  });
});

describe('BrowserGoogleDriveProvider#download', () => {
  it('throws CloudNotConnectedError instead of calling fetch when the token expired', async () => {
    const provider = new BrowserGoogleDriveProvider(makeAuth(), makePicker(null));
    const entry: CloudFileEntry = { id: 'f', name: 'Tower.ifc', path: 'f', size: 10, isFolder: false, modifiedMs: null };
    await assert.rejects(provider.download(entry), CloudNotConnectedError);
  });

  it('clears the cached token on a 401 from the download call itself, so isConnected() reflects reality', async () => {
    const fetchImpl = (async () => new Response('', { status: 401 })) as typeof fetch;
    const provider = new BrowserGoogleDriveProvider(makeAuth(), makePicker(null), fetchImpl);
    await provider.connect();
    assert.strictEqual(provider.isConnected(), true);

    const entry: CloudFileEntry = { id: 'f', name: 'Tower.ifc', path: 'f', size: 10, isFolder: false, modifiedMs: null };
    await assert.rejects(provider.download(entry), CloudNotConnectedError);
    assert.strictEqual(
      provider.isConnected(),
      false,
      'a 401 surfaced by downloadDriveFile (which has no access to the token cache) must still invalidate it',
    );
  });
});

describe('downloadDriveFile', () => {
  const entry: CloudFileEntry = { id: 'file-1', name: 'Tower.ifc', path: 'file-1', size: 4, isFolder: false, modifiedMs: null };

  it('downloads bytes and builds a File, hitting the alt=media endpoint with a bearer token', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }) as typeof fetch;

    const file = await downloadDriveFile(entry, 'tok-123', fetchImpl);
    assert.strictEqual(file.name, 'Tower.ifc');
    assert.strictEqual(file.size, 4);
    assert.match(capturedUrl, /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/file-1\?alt=media$/);
    assert.strictEqual(capturedAuth, 'Bearer tok-123');
  });

  it('maps a 401 to CloudNotConnectedError (token expiry/refusal)', async () => {
    const fetchImpl = (async () => new Response('', { status: 401 })) as typeof fetch;
    await assert.rejects(downloadDriveFile(entry, 'tok', fetchImpl), CloudNotConnectedError);
  });

  it('surfaces a real message on a non-401 failure instead of swallowing it', async () => {
    const fetchImpl = (async () => new Response('quota exceeded', { status: 429 })) as typeof fetch;
    await assert.rejects(downloadDriveFile(entry, 'tok', fetchImpl), /429.*quota exceeded/);
  });

  it('rejects a zero-byte download instead of silently returning an empty File', async () => {
    const fetchImpl = (async () => new Response(new Uint8Array([]), { status: 200 })) as typeof fetch;
    await assert.rejects(downloadDriveFile(entry, 'tok', fetchImpl), /0 bytes/);
  });
});
