/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Credential-free failure shape shared with browser publication. */
export interface BcfPublicationFailure {
  code: 'auth' | 'permission' | 'vocabulary' | 'rejected' | 'no-response' | 'server-error' | 'conflict-exists'
    | 'interrupted' | 'confirmed-absent' | 'discarded';
  message: string;
  status?: number;
  at: string;
}

/** 409/5xx and missing answers remain uncertain, including unqualified network denials. */
export function classifyWriteError(error: unknown, at: string): {
  state: 'failed' | 'uncertain'; failure: BcfPublicationFailure;
} {
  const message = error instanceof Error ? error.message : String(error);
  // Only typed preflight provenance proves that a request never left the host.
  if (error instanceof Error && error.name === 'NetworkDeniedError'
    && (error as Error & { dispatched?: unknown }).dispatched === false) {
    return { state: 'failed', failure: { code: 'permission', message, at } };
  }
  const value = error instanceof Error && /ApiError$|AuthenticationError$/.test(error.name)
    ? (error as Error & { status?: unknown }).status : undefined;
  const status = typeof value === 'number' && Number.isInteger(value) ? value : undefined;
  if (status === undefined || status === 0) return { state: 'uncertain', failure: { code: 'no-response', message, at } };
  if (status >= 500) return { state: 'uncertain', failure: { code: 'server-error', message, status, at } };
  if (status === 409) return { state: 'uncertain', failure: { code: 'conflict-exists', message, status, at } };
  const code = status === 401 ? 'auth' : status === 403 ? 'permission' : 'rejected';
  return { state: 'failed', failure: { code, message, status, at } };
}
