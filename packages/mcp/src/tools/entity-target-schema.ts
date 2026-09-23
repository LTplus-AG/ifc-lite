/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JsonSchema } from '../protocol/index.js';

const IDENTITY_RULE = ' Provide `global_id` or `express_id` (at least one; `express_id` wins when both are given).';

/**
 * Input schema for a mutate tool that targets one existing entity.
 *
 * Every such tool resolves its target through `resolveExpressId` in
 * `mutate.ts`, which reads `express_id`, else `global_id`, and throws
 * `INVALID_INPUT` when neither is present. The `anyOf` states that same
 * contract in the schema so `validateInput` rejects the call before the
 * handler runs, and one builder keeps the four tools from drifting (#5192).
 *
 * `tools/list` does not publish the root `anyOf` (the Anthropic API rejects
 * root combinators, see `advertisedInputSchema`), so the property
 * descriptions carry the rule for the agent reading the schema.
 */
export function entityTargetSchema(properties: Record<string, JsonSchema>, required?: string[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      global_id: { type: 'string', description: `Target entity's GlobalId.${IDENTITY_RULE}` },
      express_id: { type: 'integer', description: `Target entity's express id.${IDENTITY_RULE}` },
      ...properties,
    },
    ...(required ? { required } : {}),
    anyOf: [{ required: ['global_id'] }, { required: ['express_id'] }],
    additionalProperties: false,
  };
}
