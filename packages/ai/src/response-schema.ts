/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A provider response contract; native evidence validation still runs afterwards (#7132). */
export interface JsonResponseSchema {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

/** Describes the outgoing request protocol, not an assessment of model quality. */
export type OutputFormat = 'text' | 'json-schema';
