/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambient types for the slice of Google Identity Services (GIS) and Google
 * Picker global APIs the browser-only Drive path uses. Both scripts attach a
 * `window.google` (and `window.gapi`) global at runtime once loaded lazily by
 * `google-drive-browser-loader.ts` — this file only describes the surface we
 * actually call, not the full SDKs, so the app never needs `as any` /
 * `as unknown as` to touch them.
 *
 * Reference: https://developers.google.com/identity/oauth2/web/guides/use-token-model
 * and https://developers.google.com/drive/picker/guides/overview
 */

export interface GoogleTokenResponse {
  access_token: string;
  /** Seconds until expiry. */
  expires_in: number;
  error?: string;
  error_description?: string;
}

export interface GoogleTokenClientError {
  type: string;
  message?: string;
}

export interface GoogleTokenClient {
  requestAccessToken(overrideConfig?: { prompt?: string }): void;
}

export interface GoogleTokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: GoogleTokenResponse) => void;
  error_callback?: (error: GoogleTokenClientError) => void;
}

export interface GoogleAccountsOauth2 {
  initTokenClient(config: GoogleTokenClientConfig): GoogleTokenClient;
  revoke(accessToken: string, done?: () => void): void;
}

export interface GooglePickerDocument {
  id: string;
  name: string;
  mimeType?: string;
  sizeBytes?: string;
}

export interface GooglePickerResponse {
  action: string;
  docs?: GooglePickerDocument[];
}

export interface GooglePickerInstance {
  setVisible(visible: boolean): void;
}

export interface GooglePickerBuilder {
  addView(viewId: string): GooglePickerBuilder;
  setOAuthToken(token: string): GooglePickerBuilder;
  setDeveloperKey(key: string): GooglePickerBuilder;
  setAppId(appId: string): GooglePickerBuilder;
  setCallback(cb: (data: GooglePickerResponse) => void): GooglePickerBuilder;
  build(): GooglePickerInstance;
}

export interface GooglePickerNamespace {
  PickerBuilder: new () => GooglePickerBuilder;
  ViewId: { DOCS: string };
  Action: { PICKED: string; CANCEL: string };
}

export interface GoogleNamespace {
  accounts: { oauth2: GoogleAccountsOauth2 };
  picker: GooglePickerNamespace;
}

export interface GapiNamespace {
  load(api: string, callback: () => void): void;
}

declare global {
  interface Window {
    google?: GoogleNamespace;
    gapi?: GapiNamespace;
  }
}
