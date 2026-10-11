/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The agent's view of the op vocabulary, derived from `getOpJsonSchema()`
 * at load time (never copied by hand):
 *
 * - the fidelity kinds (`*.restore`, `*.patch`) are dropped: the reducer
 *   emits them as exact inverses, an author never writes them;
 * - `opId` becomes optional (the sandbox fills it);
 * - a node id may be a handle (`@doors`) as well as a UUID.
 *
 * Everything else, including every payload schema, is the vocabulary's own.
 * The sandbox still validates the RESOLVED ops against the real schema in
 * the gate, so this relaxation cannot let a malformed op through.
 */

import { getOpJsonSchema, type JsonSchema } from '@ifc-lite/ids-authoring';
import { FIDELITY_KINDS } from '../sandbox/sandbox.js';
import { HANDLE_PATTERN } from '../sandbox/handles.js';

const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export interface AgentOpSchema {
  /** Schema of one op as the agent may write it: `{ $ref: '#/$defs/AgentOp' }`. */
  op: JsonSchema;
  defs: Record<string, JsonSchema>;
  /** The op kinds the agent may use, in vocabulary order. */
  kinds: string[];
}

function opKind(def: JsonSchema): string | undefined {
  const kind = def.properties?.kind?.const;
  return typeof kind === 'string' ? kind : undefined;
}

let cached: AgentOpSchema | undefined;

export function agentOpSchema(): AgentOpSchema {
  if (cached) return cached;
  const full = getOpJsonSchema();
  // `getOpJsonSchema` returns plain JSON Schema data built from `JsonSchema` values.
  const source = full.$defs as Record<string, JsonSchema>;
  const defs: Record<string, JsonSchema> = {};
  const refs: JsonSchema[] = [];
  const kinds: string[] = [];
  for (const [name, def] of Object.entries(source)) {
    const kind = name.startsWith('Op_') ? opKind(def) : undefined;
    if (kind === undefined) {
      if (name !== 'StudioOp') defs[name] = def;
      continue;
    }
    if (FIDELITY_KINDS.has(kind)) continue;
    defs[name] = { ...def, required: (def.required ?? []).filter((key) => key !== 'opId') };
    refs.push({ $ref: `#/$defs/${name}` });
    kinds.push(kind);
  }
  defs.Uuid = {
    type: 'string',
    pattern: `^(?:${UUID_BODY}|${HANDLE_PATTERN.slice(1, -1)})$`,
    description: 'A node UUID from ids_read, or a handle "@name" for a node created in this run.',
  };
  defs.AgentOp = { oneOf: refs };
  cached = { op: { $ref: '#/$defs/AgentOp' }, defs, kinds };
  return cached;
}
