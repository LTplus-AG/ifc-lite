/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opening a processed model (`ModelLoadOptions.processedModel`): its reference
 * in the form the server keys by, and why it could not be opened, worded for
 * the user, with whether trying again can help. Unlike an upload, a processed
 * model has no local fallback, so each cause gets its own message: a generic
 * "could not be opened" leaves a host with nothing to fix.
 */

import { IfcServerError, normalizeProcessedModelHash, type ProcessedModelRef } from '@ifc-lite/server-client';
import { resolve as translate } from '@/i18n/registry';
import type { TranslationKey } from '@/i18n';
import { isNetworkUnavailableError } from '@/lib/cancelled-and-network-errors';
import { formatLoadError } from '@/lib/load-error-message';

/** `ref` with its hash lowercased, so the model record holds one spelling; a hash that is not a SHA-256 is kept for the client to refuse. */
export function normalizedProcessedModel(ref: ProcessedModelRef): ProcessedModelRef {
  return { sha256: normalizeProcessedModelHash(ref.sha256) ?? ref.sha256, bytes: ref.bytes };
}

/** A cause found in the viewer, before or instead of a server answer. */
export class ProcessedModelUnavailable extends Error {
  constructor(readonly reason: 'not-primary' | 'no-server' | 'unreachable' | 'unsupported') {
    super(`Processed model unavailable: ${reason}`);
    this.name = 'ProcessedModelUnavailable';
  }
}

export interface ProcessedModelFailure {
  message: string;
  /** Load-error code for analytics; a fixed vocabulary, never user data. */
  code: string;
  /** Only a transient cause (network, timeout, server error, server busy) offers Retry. */
  retryable: boolean;
}

const failure = (key: TranslationKey, code: string, retryable: boolean, values?: Record<string, string>): ProcessedModelFailure =>
  ({ message: translate(key, values), code: `processed_model_${code}`, retryable });

const VIEWER_CAUSES: Record<ProcessedModelUnavailable['reason'], () => ProcessedModelFailure> = {
  'not-primary': () => failure('viewportLighting.container.processedModel.notPrimary', 'not_primary', false),
  'no-server': () => failure('viewportLighting.container.processedModel.noServer', 'no_server', false),
  unreachable: () => failure('viewportLighting.container.processedModel.unreachable', 'server_unreachable', false),
  unsupported: () => failure('viewportLighting.container.processedModel.unsupported', 'unsupported', false),
};

/** `error` is what the load threw; `null` when it ended without saying why. */
export function describeProcessedModelFailure(error: unknown): ProcessedModelFailure {
  if (error === null) {
    console.warn('[useIfc] A processed model could not be opened and no cause was reported');
    return failure('viewportLighting.container.processedModel.unknown', 'unknown', true);
  }
  if (error instanceof ProcessedModelUnavailable) return VIEWER_CAUSES[error.reason]();
  if (error instanceof IfcServerError) {
    if (error.status === 404) return failure('viewportLighting.container.processedModel.notStored', 'not_stored', false);
    if (error.status === 401 || error.status === 403) return failure('viewportLighting.container.processedModel.forbidden', 'forbidden', false);
    if (error.status === 408 || error.status === 429 || error.status === 503) return failure('viewportLighting.container.processedModel.busy', 'server_busy', true);
    if (error.status >= 500) return failure('viewportLighting.container.processedModel.serverError', 'server_error', true);
    return failure('viewportLighting.container.processedModel.refused', 'refused', false, { status: String(error.status) });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isNetworkUnavailableError(message) || (error instanceof Error && error.name === 'TimeoutError')) {
    return failure('viewportLighting.container.processedModel.network', 'network', true);
  }
  // Anything else (a malformed hash given to the load option, a decode failure) will not change on Retry.
  return { message: formatLoadError(error), code: 'processed_model_failed', retryable: false };
}
