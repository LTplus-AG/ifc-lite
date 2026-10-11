/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JsonResponseSchema } from './response-schema.js';

export interface PreparedInput<Message> {
  readonly messages: readonly Message[];
  readonly system?: string;
  readonly outputSchema?: JsonResponseSchema;
}

/** Explicit producer boundary: parse once, dispatch and digest the SAME owned JSON data.
 * Never clone or reflect on a generic transport's opaque caller messages. */
export function prepareInput<Message>(serialized: string): PreparedInput<Message> {
  if (typeof serialized !== 'string') throw new Error('invalid-request-input-snapshot');
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-request-input-snapshot');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.messages) || (input.system !== undefined && typeof input.system !== 'string')
    || (input.outputSchema !== undefined && (!input.outputSchema || typeof input.outputSchema !== 'object'
      || Array.isArray(input.outputSchema)))) throw new Error('invalid-request-input-snapshot');
  return { messages: input.messages as Message[], ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema as JsonResponseSchema }) };
}
