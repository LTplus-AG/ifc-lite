/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SERVER_URL, USE_SERVER } from '@/utils/ifcConfig';

const buildServerUrl = normalizeProcessingServerUrl(SERVER_URL);
let runtimeServerUrl: string | undefined;

/** The processing server the viewer asks: the runtime value, else the build's `VITE_IFC_SERVER_URL`. */
export function getProcessingServerUrl(): string {
  return runtimeServerUrl ?? buildServerUrl;
}

/** Whether the host explicitly selected the global server at runtime. */
export function hasRuntimeProcessingServer(): boolean {
  return runtimeServerUrl !== undefined;
}

/**
 * Point the viewer at a processing server at runtime. Every server request
 * goes there, uploads of locally opened IFC files included when the build
 * routes them to the server (`VITE_USE_SERVER=true`), except a processed-model
 * request that named its own server.
 */
export function setProcessingServerUrl(url: string): void {
  runtimeServerUrl = normalizeProcessingServerUrl(url);
}

export function normalizeProcessingServerUrl(url: unknown): string {
  const trimmed = typeof url === 'string' ? url.trim() : ''; // a config value may carry spaces, or be missing
  // Trailing slashes go, unless nothing would be left: '/' is the page's own origin, a valid server URL.
  return trimmed.replace(/\/+$/, '') || (trimmed.startsWith('/') ? '/' : '');
}

/** Whether a locally opened IFC is sent to the processing server: the build flag, and a server to send it to. */
export function serverUploadsEnabled(): boolean {
  return USE_SERVER && getProcessingServerUrl() !== '';
}
