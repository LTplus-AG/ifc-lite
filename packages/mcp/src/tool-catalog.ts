/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a session may see of the tool registry: the `tools/list` wire shape
 * and the compact catalog in `ifc-lite://server/manifest`. Both come from the
 * same visibility filter, so the two can never disagree.
 */

import type { ToolDefinition, ToolScope } from './protocol/index.js';
import { scopeAllows, type AuthScope } from './auth/scope.js';
import type { Tool, ToolRegistry } from './tools/types.js';
import { advertisedInputSchema } from './validate.js';

/** One row of the manifest's tool catalog. */
export interface ToolCatalogEntry {
  name: string;
  title?: string;
  /** First sentence of the description. */
  purpose: string;
  scope?: ToolScope;
}

const PURPOSE_MAX = 160;

/** Tools this scope may call. `readOnly` hides mutate tools even when the token grants `mutate`. */
export function visibleTools(tools: ToolRegistry, scope: AuthScope, readOnly: boolean): Tool[] {
  return tools.list().filter((t) => scopeAllows(scope, t.scope) && !(readOnly && t.scope === 'mutate'));
}

export function toToolDefinition(tool: Tool): ToolDefinition {
  const meta = tool.scope !== undefined ? { ...tool._meta, 'ifc-lite/scope': tool.scope } : tool._meta;
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: advertisedInputSchema(tool.inputSchema),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
  };
}

export function toCatalogEntry(tool: Tool): ToolCatalogEntry {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    purpose: firstSentence(tool.description),
    ...(tool.scope !== undefined ? { scope: tool.scope } : {}),
  };
}

/** A period that ends a sentence: not after e.g./i.e./etc./vs., and followed by a sentence start or the end. */
const SENTENCE_END = /(?<!\b(?:e\.g|i\.e|etc|vs))\.(?=\s+[A-Z0-9`"'(]|$)/;

function firstSentence(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  const end = flat.search(SENTENCE_END);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  const chars = Array.from(sentence);
  return chars.length > PURPOSE_MAX ? `${chars.slice(0, PURPOSE_MAX - 1).join('')}…` : sentence;
}
