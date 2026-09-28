/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CommitSourceErrorCode } from '@ifc-lite/plugin-api';

/**
 * A commit-path failure carrying the contract's `code`, so a host narrows it
 * with `isCommitSourceError` and branches without knowing it is talking to
 * Dalux — `not-found` on a model that is in no version set reads very
 * differently from a network outage, and only the provider can tell them
 * apart.
 *
 * Separate from `DaluxHttpError` (which carries an HTTP status and nothing
 * else) rather than bolted onto it: the codes are a contract vocabulary, not
 * a restatement of the status line, and most of these failures never had an
 * HTTP response at all.
 */
export class DaluxCommitError extends Error {
  readonly code: CommitSourceErrorCode;
  readonly status: number;

  constructor(code: CommitSourceErrorCode, message: string, status: number) {
    super(message);
    this.name = 'DaluxCommitError';
    this.code = code;
    this.status = status;
  }
}
