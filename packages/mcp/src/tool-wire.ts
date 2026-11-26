/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CallToolResult } from './protocol/index.js';
import type { Tool } from './tools/types.js';

/**
 * MCP clients validate any `structuredContent` against the tool's
 * `outputSchema`, error results included (the TS SDK client does), and the
 * error envelope `{ code, message, details, hint }` matches no success
 * schema. For a tool that declares one, the envelope moves into the text
 * block.
 */
export function fitOutputSchema(result: CallToolResult, tool: Tool | null): CallToolResult {
  if (!result.isError || result.structuredContent === undefined || !tool?.outputSchema) return result;
  const { structuredContent, ...rest } = result;
  return { ...rest, content: [...result.content, { type: 'text', text: JSON.stringify(structuredContent) }] };
}
