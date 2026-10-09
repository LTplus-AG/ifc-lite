/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The v1 tool set, assembled per mode and per what the host provides. */

import type { ModeConfig } from '../modes.js';
import { ACT_TOOLS } from './act-tools.js';
import { ASK_USER_TOOLS } from './ask-user.js';
import { BSDD_TOOLS } from './bsdd-tools.js';
import type { AgentToolContext, IdsAgentTool } from './context.js';
import { IDS_READ_TOOLS } from './ids-read.js';
import { MODEL_TOOLS } from './model-tools.js';
import { createToolRegistry, type ToolRegistry } from './registry.js';
import { SCHEMA_TOOLS } from './schema-tools.js';

/** Every v1 tool, in the stable order they are offered (prompt caching depends on it). */
export const ALL_TOOLS: readonly IdsAgentTool[] = [
  ...SCHEMA_TOOLS, ...IDS_READ_TOOLS, ...ACT_TOOLS, ...ASK_USER_TOOLS, ...MODEL_TOOLS, ...BSDD_TOOLS,
];

export function registryFor(mode: ModeConfig, available: { model: boolean; bsdd: boolean }): ToolRegistry<AgentToolContext> {
  const excluded = new Set(mode.excludeTools ?? []);
  return createToolRegistry(ALL_TOOLS.filter((t) =>
    mode.toolGroups.includes(t.group)
    && !excluded.has(t.name)
    && (t.group !== 'model' || available.model)
    && (t.group !== 'bsdd' || available.bsdd)));
}
