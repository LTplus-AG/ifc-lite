/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { A2UI_PROTOCOL_VERSION, buildSurface, SECTION_KINDS, type SurfaceSpec } from '@ifc-lite/a2ui';
import { toolError, ToolErrorCode } from '../errors.js';
import type { CallToolResult } from '../protocol/index.js';
import type { Tool } from '../tools/types.js';
import { checkJsonBounds, isRecord } from './json-bounds.js';
import { BRIDGE_SURFACE_TOOL } from './protocol.js';

async function prepare(input: Record<string, unknown>) {
  if ((input.messages === undefined) === (input.spec === undefined)) {
    throw new Error('Provide exactly one of messages or spec.');
  }
  const issue = checkJsonBounds(input, { maxDepth: 32, maxNodes: 40_000 }, 'Surface');
  if (issue) throw new Error(issue);
  if (Buffer.byteLength(JSON.stringify(input)) > 512 * 1024) throw new Error('Surface exceeds 512 KiB.');
  const title = input.title as string | undefined;
  const messages = input.messages === undefined
    ? buildSurface({ ...(input.spec as SurfaceSpec), ...(title === undefined ? {} : { title }) })
    : input.messages as unknown[];
  if (messages.some((message) => !isRecord(message) || message.version !== A2UI_PROTOCOL_VERSION
    || !['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].some((kind) => kind in message))) {
    throw new Error('Provide A2UI v1.0 surface and data messages.');
  }
  if (input.spec !== undefined && Buffer.byteLength(JSON.stringify({ messages, title })) > 512 * 1024) throw new Error('Built surface exceeds 512 KiB.');
  const { validateIfcMessages } = await import('@ifc-lite/a2ui/agent');
  const errors = validateIfcMessages(messages);
  if (errors.length) throw new Error(errors.join('\n'));
  return { messages, ...(title === undefined ? {} : { title }) };
}

export function surfacePushTool(forward: (surface: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>): Tool {
  return {
    name: BRIDGE_SURFACE_TOOL,
    description: 'Show an IFC A2UI v1.0 surface in the paired viewer. Supply messages or a builder spec with surfaceId and sections.',
    scope: 'read',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object', additionalProperties: false, anyOf: [{ required: ['messages'] }, { required: ['spec'] }],
      properties: {
        title: { type: 'string', maxLength: 256 },
        messages: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object' } },
        spec: {
          type: 'object', required: ['surfaceId', 'sections'], additionalProperties: false,
          properties: {
            surfaceId: { type: 'string', maxLength: 128 },
            title: { type: 'string', maxLength: 256 },
            card: { type: 'boolean' },
            sections: { type: 'array', minItems: 1, maxItems: 64, items: {
              type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: [...SECTION_KINDS] } },
            } },
          },
        },
      },
    },
    async handler(input, ctx) {
      let surface: Awaited<ReturnType<typeof prepare>>;
      try {
        surface = await prepare(input);
      } catch (err) {
        return toolError({ code: ToolErrorCode.INVALID_INPUT, message: err instanceof Error ? err.message : String(err) });
      }
      return forward(surface, ctx.signal);
    },
  };
}
