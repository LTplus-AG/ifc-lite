/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The host-facing entry for server-processed models: which processing server
 * the viewer asks, and "open this stored result".
 *
 * Plain functions, callable before the viewer mounts or after, from code that
 * holds no React hook: a host reads its own configuration and calls
 *
 *     openProcessedModel({ sha256, bytes, name }, { serverUrl: '/ifc' });
 *
 * The request waits here until the mounted viewer takes it
 * (`useProcessedModelAutoload`), which loads it through the canonical
 * `loadFile` path. The `?processed=` URL entry files the same request.
 */

import { assertProcessedModelHash, type ProcessedModelRef } from '@ifc-lite/server-client';
import { SERVER_URL, USE_SERVER } from '@/utils/ifcConfig';

/** A stored result to open: the reference (`bytes` 0 when unknown) and the name to show. */
export interface ProcessedModelRequest extends ProcessedModelRef {
  /** Display name, e.g. the source file's name. */
  readonly name: string;
}

export interface OpenProcessedModelOptions {
  /** Processing server for this and later requests: an absolute URL or a same-origin path. Omitted: unchanged. */
  serverUrl?: string;
}

let serverUrl: string = SERVER_URL;
let pending: ProcessedModelRequest | null = null;
const listeners = new Set<() => void>();

/** The processing server the viewer asks: the runtime value, else the build's `VITE_IFC_SERVER_URL`. */
export function getProcessingServerUrl(): string {
  return serverUrl;
}

/**
 * Point the viewer at a processing server at runtime. Every server request
 * goes there, uploads of locally opened IFC files included when the build
 * routes them to the server (`VITE_USE_SERVER=true`).
 */
export function setProcessingServerUrl(url: string): void {
  // Trailing slashes go, unless nothing would be left: '/' is the page's own origin, a valid server URL.
  serverUrl = url.replace(/\/+$/, '') || (url.startsWith('/') ? '/' : '');
}

/** Whether a locally opened IFC is sent to the processing server: the build flag, and a server to send it to. */
export function serverUploadsEnabled(): boolean {
  return USE_SERVER && serverUrl !== '';
}

/**
 * Open a model the processing server has already processed. Replaces the
 * model in the viewer, like any primary load. Throws on a hash that is not a
 * SHA-256, before anything is asked of the server.
 */
export function openProcessedModel(model: ProcessedModelRequest, options?: OpenProcessedModelOptions): void {
  const sha256 = assertProcessedModelHash(model.sha256);
  if (options?.serverUrl !== undefined) setProcessingServerUrl(options.serverUrl);
  const bytes = Number.isSafeInteger(model.bytes) && model.bytes > 0 ? model.bytes : 0;
  pending = { sha256, bytes, name: model.name || 'model.ifc' };
  for (const listener of [...listeners]) listener();
}

/**
 * Apply a host configuration's processing members (`server`, `open`). Called
 * once by `mountViewer`, after the feature set is fixed: the server first, so
 * the model opens from it.
 */
export function applyProcessingConfig(config: {
  server?: { url: string };
  open?: { processedModel: ProcessedModelRequest };
} | undefined): void {
  if (config?.server) setProcessingServerUrl(config.server.url);
  if (config?.open) openProcessedModel(config.open.processedModel);
}

/** The mounted viewer's side: take the waiting request, once. */
export function takeProcessedModelRequest(): ProcessedModelRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/** Called when a request is filed; returns the unsubscribe. */
export function onProcessedModelRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
