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
 * `loadFile` path. The `?processed=` URL entry files the same request, unless
 * a host has asked for a model: the host's model wins over the page URL.
 */

import { assertProcessedModelHash, processedModelSize, type ProcessedModelRef } from '@ifc-lite/server-client';
import { SERVER_URL, USE_SERVER } from '@/utils/ifcConfig';
import type { ViewerRuntimeConfig } from './features/runtime-config';

/** A stored result to open: the reference (`bytes` 0 when unknown) and the name to show. */
export interface ProcessedModelRequest extends ProcessedModelRef {
  /** Display name, e.g. the source file's name. */
  readonly name: string;
}

export interface OpenProcessedModelOptions {
  /** Processing server for this request and its Retry only. Omitted: the global server when the load runs. */
  serverUrl?: string;
}

const buildServerUrl = cleanServerUrl(SERVER_URL);
let runtimeServerUrl: string | undefined;
/** A stored result and, when a request picked one, the processing server to ask for it (also on Retry). */
export type ProcessedModelSource = ProcessedModelRef & { readonly serverUrl?: string };

/** The normalized reference stored on a loaded model. Zero means the source size is unknown. */
export type ProcessedModelRecord = ProcessedModelSource & { readonly bytes: number };
export type FiledProcessedModelRequest = ProcessedModelRequest & Pick<ProcessedModelSource, 'serverUrl'>;
let pending: FiledProcessedModelRequest | null = null;
const listeners = new Set<() => void>();
const pendingListeners = new Set<() => void>();
/** A host asked for a model (`openProcessedModel`, or the configuration's start model); a model named in the page URL then yields. */
let hostRequested = false;
type PageUrlParameter = 'processed' | 'model' | 'room';
const ignoredLogged = new Set<PageUrlParameter>();
const hostRequestListeners = new Set<() => void>();

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
  runtimeServerUrl = cleanServerUrl(url);
}

function cleanServerUrl(url: unknown): string {
  const trimmed = typeof url === 'string' ? url.trim() : ''; // a config value may carry spaces, or be missing
  // Trailing slashes go, unless nothing would be left: '/' is the page's own origin, a valid server URL.
  return trimmed.replace(/\/+$/, '') || (trimmed.startsWith('/') ? '/' : '');
}

/** Whether a locally opened IFC is sent to the processing server: the build flag, and a server to send it to. */
export function serverUploadsEnabled(): boolean {
  return USE_SERVER && getProcessingServerUrl() !== '';
}

/**
 * Open a model the processing server has already processed. Replaces the
 * model in the viewer, like any primary load. Throws on a hash that is not a
 * SHA-256, before anything is asked of the server.
 */
export function openProcessedModel(model: ProcessedModelRequest, options?: OpenProcessedModelOptions): void {
  const override = options?.serverUrl;
  const request = override == null ? normalizedRequest(model) : { ...normalizedRequest(model), serverUrl: cleanServerUrl(override) };
  hostRequested = true;
  for (const listener of [...hostRequestListeners]) listener();
  fileRequest(request);
}

/**
 * The viewer's own `?processed=` entry: files the request the page URL names,
 * unless a host already asked for a model (`pageUrlModelAllowed`). Unlike
 * `openProcessedModel` it does not count as a host request.
 */
export function openProcessedModelFromUrl(model: ProcessedModelRequest): void {
  if (pageUrlModelAllowed('processed')) fileRequest(normalizedRequest(model));
}

/**
 * Whether a model named in the page URL (`?processed=`, `?model=`, or the
 * collaboration room of `?room=`) may load.
 * Not once a host has asked for one: the host's model wins, also when it was
 * asked for before the viewer mounted and is still waiting. The rule holds for
 * the page; each ignored parameter is logged once.
 */
export function pageUrlModelAllowed(parameter: PageUrlParameter): boolean {
  if (!hostRequested) return true;
  if (!ignoredLogged.has(parameter)) {
    ignoredLogged.add(parameter);
    console.info(`[viewer] ?${parameter}= in the page URL is ignored: the host asked for its own model`);
  }
  return false;
}

/** Tests only: forget host requests, the waiting request and the ignored-parameter log. */
export function resetProcessedModelRequestsForTests(): void {
  hostRequested = false;
  ignoredLogged.clear();
  pending = null;
}

function normalizedRequest(model: ProcessedModelRequest): ProcessedModelRequest {
  const sha256 = assertProcessedModelHash(model.sha256);
  return { sha256, bytes: processedModelSize(model.bytes), name: (typeof model.name === 'string' && model.name.trim()) || 'model.ifc' };
}

/** Whether a server-meshed model is waiting for the viewer to take it. */
export function processedModelRequested(): boolean {
  return pending !== null;
}

/** Observe the handoff from the request queue to the viewer's loader. */
export function onPendingProcessedModelChange(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

function fileRequest(request: FiledProcessedModelRequest): void {
  pending = request;
  for (const listener of pendingListeners) listener();
  for (const listener of [...listeners]) listener();
}

/**
 * Apply a host configuration's processing members (`server`, `open`). Called
 * once by `mountViewer`, after the feature set is fixed: the server first, so
 * the model opens from it.
 */
export function applyProcessingConfig(config: Pick<ViewerRuntimeConfig, 'server' | 'open'> | undefined): void {
  if (config?.server) setProcessingServerUrl(config.server.url);
  if (config?.open) {
    if (!getProcessingServerUrl()) console.error('[viewer config] open.processedModel requires server.url or VITE_IFC_SERVER_URL.');
    openProcessedModel(config.open.processedModel); // a host request: the page URL yields
  }
}

/** The mounted viewer's side: take the waiting request, once. */
export function takeProcessedModelRequest(): FiledProcessedModelRequest | null {
  const request = pending;
  pending = null;
  if (request) for (const listener of pendingListeners) listener();
  return request;
}

/** Called when a request is filed; returns the unsubscribe. */
export function onProcessedModelRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}


/** Called for a valid host request before the viewer can consume it. */
export function onHostProcessedModelRequest(listener: () => void): () => void {
  hostRequestListeners.add(listener);
  return () => { hostRequestListeners.delete(listener); };
}
