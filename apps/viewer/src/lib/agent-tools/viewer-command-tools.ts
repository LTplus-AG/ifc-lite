/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Palette and agent share the mounted commands, host callbacks and live prerequisites. */
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { getAgentCommandHost } from '@/lib/agent-bridge/command-host';
import type { Command } from '@/components/viewer/commandPaletteSearch';
import { resolveRef } from './refs';
import { assertDispatchActive } from './cancellation';
import type { AgentInputSchema, AgentTool, ToolCallContext, ToolOutput } from './types';

export const VIEWER_COMMAND_SPECS = {
  viewer_select: {
    description: 'Replace the native viewer selection with express_ids from one model. Validates every entity before changing either selection channel. Use query_entities to find ids, then run frame/hide/basket commands. An empty array clears selection. Requires commands and edits permission.',
    inputSchema: { type: 'object', properties: {
      model_id: { type: 'string' }, express_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 1000 },
    }, required: ['express_ids'] } satisfies AgentInputSchema,
    readOnly: false,
  },
  viewer_get_selection: {
    description: 'Read the current renderer selection as model-qualified IFC entity references.',
    inputSchema: { type: 'object', properties: {} } satisfies AgentInputSchema,
    readOnly: true,
  },
  viewer_commands: {
    description: 'Discover the live viewer command palette. Search by task, then inspect an exact command_id. Returns availability and no-argument input schemas. Commands launch native actions or interactive panels; opening a panel does not perform its workflow. Call again after changing selection or viewer state.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', maxLength: 200 },
      command_id: { type: 'string', maxLength: 300 },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    } } satisfies AgentInputSchema,
    readOnly: true,
  },
  viewer_command_run: {
    description: 'Dispatch an exact command_id discovered with viewer_commands through the native palette. Requires the tab user to allow commands and edits. Rechecks availability and permission at dispatch. Returns dispatched, NOT workflow completion; native dialogs and panels may need user input. No code, selectors or arbitrary arguments are accepted. File-picker commands require a real user gesture and cannot run here.',
    inputSchema: { type: 'object', properties: {
      command_id: { type: 'string', maxLength: 300 },
    }, required: ['command_id'] } satisfies AgentInputSchema,
    readOnly: false,
  },
} as const;

function invalid(message: string): never {
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
}

function commands(): readonly Command[] {
  const host = getAgentCommandHost();
  if (!host) throw new ToolExecutionError({
    code: ToolErrorCode.UNSUPPORTED_OPERATION,
    message: 'The mounted viewer command host is not ready. Retry after the viewer has finished loading.',
  });
  return host();
}

function unavailable(command: Command): string | undefined {
  // Browser activation is not transferable over MCP. Never pretend the picker opened.
  if (command.immediate) return 'Requires a real user gesture in the viewer.';
  if (!command.checkAvailability) return 'This command has no live prerequisite check and cannot be run by an agent.';
  const availability = command.checkAvailability();
  return availability.status === 'disabled' ? availability.reasonKey : undefined;
}

function boundedString(args: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${key} must be a nonempty string of at most ${max} characters.`);
  return value;
}

function keys(args: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) invalid('Unknown argument. Use the tool input schema.');
}

function integer(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || value > max) invalid(`Invalid ${key}.`);
  return value;
}

function output(structured: unknown): ToolOutput { return { structured, text: JSON.stringify(structured) }; }

function assertGranted(ctx: ToolCallContext): void {
  assertDispatchActive(ctx.signal);
  if (!ctx.canEdit?.()) throw new ToolExecutionError({
    code: ToolErrorCode.READ_ONLY,
    message: 'The tab has not allowed palette commands and edits. The user must enable them in the local agent connection panel.',
  });
}

export const viewerCommandTools: Record<keyof typeof VIEWER_COMMAND_SPECS, AgentTool> = {
  viewer_select: { needs: 'store', async run(_host, model, args, ctx) {
    assertGranted(ctx);
    keys(args, ['model_id', 'express_ids']);
    if (!Array.isArray(args.express_ids) || args.express_ids.length > 1000) invalid('express_ids must be an array of at most 1000 positive integers.');
    const refs = args.express_ids.map(express_id => resolveRef(model, { express_id }));
    ctx.checkpoint?.();
    assertGranted(ctx);
    model.bim.viewer.select(refs);
    return output({ selection: model.bim.viewer.getSelection() });
  } },
  viewer_get_selection: { needs: 'none', async run(host, args) {
    keys(args, []);
    return output({ selection: host.models()[0]?.bim.viewer.getSelection() ?? [] });
  } },
  viewer_commands: { needs: 'none', async run(_host, args) {
    keys(args, ['query', 'command_id', 'offset', 'limit']);
    const query = boundedString(args, 'query', 200)?.toLowerCase();
    const id = boundedString(args, 'command_id', 300);
    const offset = integer(args, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(args, 'limit', 25, 50);
    const matches = commands().filter(command => (!id || command.id === id)
      && (!query || `${command.id} ${command.label} ${command.keywords} ${command.category}`.toLowerCase().includes(query)));
    return output({ total: matches.length, offset,
      next_offset: offset + limit < matches.length ? offset + limit : null,
      commands: matches.slice(offset, offset + limit).map(command => {
        const reason = unavailable(command);
        return { command_id: command.id, label: command.label, category: command.category,
          available: reason === undefined, reason, state: command.stateKey,
          input_schema: { type: 'object', properties: {}, additionalProperties: false },
          completion: 'dispatch-only', requires_permission: true };
      }),
    });
  } },
  viewer_command_run: { needs: 'none', async run(_host, args, ctx) {
    assertGranted(ctx);
    keys(args, ['command_id']);
    const id = boundedString(args, 'command_id', 300);
    if (!id) invalid('command_id is required. Discover it with viewer_commands.');
    const host = getAgentCommandHost();
    const matches = commands().filter(command => command.id === id);
    if (matches.length > 1) invalid('Ambiguous command_id: more than one command is registered.');
    const command = matches[0];
    if (!command) invalid('Unknown or unavailable command_id. Discover current commands with viewer_commands.');
    const reason = unavailable(command);
    if (reason) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: reason });
    // Host checks can run user-owned callbacks. Recheck ownership and grant after them.
    if (getAgentCommandHost() !== host) throw new ToolExecutionError({ code: ToolErrorCode.STATE_CHANGED, message: 'The viewer command host changed. Discover commands again.' });
    assertGranted(ctx);
    command.action();
    return output({ command_id: id, status: 'dispatched',
      note: 'The native action was dispatched. Inspect viewer state or complete any native dialog; this does not assert workflow completion.' });
  } },
};
