/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tool registry: every tool is one JSON Schema plus a handler.
 *
 * The workspace has no zod. The schema handed to the provider and the check
 * run before the handler are the same object, interpreted by the op
 * contract's own validator (`validateJson` from `@ifc-lite/ids-authoring`),
 * so a tool definition cannot drift from what it accepts. `ids_apply_ops`
 * embeds the op vocabulary's schema (`getOpJsonSchema`) rather than a copy.
 *
 * A call never throws into the loop: an unknown tool, unparseable JSON, a
 * schema violation and a handler failure all come back as an error result
 * the model reads and can correct.
 */

import type { ToolSpec } from '@ifc-lite/ai';
import { validateJson, type JsonSchema, type SchemaError } from '@ifc-lite/ids-authoring';

/** Tool names are `[a-z_]` (providers reject dots), grouped by prefix: `schema_`, `ids_`, `model_`, `bsdd_`. */
export type ToolGroup = 'schema' | 'ids' | 'model' | 'bsdd';

export interface ToolOutcome {
  ok: boolean;
  /** Serialised as the tool result the model reads. */
  data: unknown;
  /** One line for progress events and receipts; never document content. */
  summary: string;
  /**
   * Stable failure keys (gate code + offending value, diagnostic code + node)
   * used by no-progress detection. Empty or absent on success.
   */
  signature?: readonly string[];
}

export interface AgentTool<Ctx> {
  readonly name: string;
  readonly group: ToolGroup;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Shared `$defs` the input schema refers to. */
  readonly defs?: Readonly<Record<string, JsonSchema>>;
  /** Ask the provider for strict, schema-constrained inputs (small schemas only). */
  readonly strict: boolean;
  /** True when the tool cannot change the sandbox document. */
  readonly readOnly: boolean;
  run(input: unknown, ctx: Ctx): Promise<ToolOutcome> | ToolOutcome;
}

export interface ToolDefinition<Input, Ctx> extends Omit<AgentTool<Ctx>, 'run'> {
  /** Called only with input that passed `inputSchema`. */
  run(input: Input, ctx: Ctx): Promise<ToolOutcome> | ToolOutcome;
}

/** Declare a tool whose handler receives schema-validated input of type `Input`. */
export function defineTool<Input, Ctx>(definition: ToolDefinition<Input, Ctx>): AgentTool<Ctx> {
  // The registry validates against `inputSchema` before `run`, so the
  // narrowing below is the schema's own guarantee.
  return { ...definition, run: (input, ctx) => definition.run(input as Input, ctx) };
}

export interface ToolRegistry<Ctx> {
  readonly tools: readonly AgentTool<Ctx>[];
  /** Provider-neutral definitions, in registration order (stable for prompt caching). */
  specs(): ToolSpec[];
  has(name: string): boolean;
  call(name: string, input: unknown, rawInput: string | undefined, ctx: Ctx): Promise<ToolOutcome>;
}

export function failure(summary: string, data: Record<string, unknown>, signature?: readonly string[]): ToolOutcome {
  return { ok: false, summary, data: { ok: false, ...data }, ...(signature ? { signature } : {}) };
}

export function success(summary: string, data: Record<string, unknown>): ToolOutcome {
  return { ok: true, summary, data: { ok: true, ...data } };
}

function toSpec<Ctx>(tool: AgentTool<Ctx>): ToolSpec {
  const schema: Record<string, unknown> = { ...tool.inputSchema };
  if (tool.defs) schema.$defs = tool.defs;
  return { name: tool.name, description: tool.description, inputSchema: schema, strict: tool.strict };
}

function formatErrors(errors: readonly SchemaError[]): string[] {
  return errors.slice(0, 20).map((e) => `${e.path}: ${e.message}`);
}

export function createToolRegistry<Ctx>(tools: readonly AgentTool<Ctx>[]): ToolRegistry<Ctx> {
  const byName = new Map<string, AgentTool<Ctx>>();
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error(`Invalid tool name "${tool.name}"`);
    if (byName.has(tool.name)) throw new Error(`Duplicate tool "${tool.name}"`);
    byName.set(tool.name, tool);
  }
  return {
    tools,
    specs: () => tools.map(toSpec),
    has: (name) => byName.has(name),
    async call(name, input, rawInput, ctx) {
      const tool = byName.get(name);
      if (!tool) {
        return failure(`unknown tool ${name}`, { error: `There is no tool named "${name}".`, tools: [...byName.keys()] }, [`TOOL:${name}`]);
      }
      if (rawInput !== undefined) {
        return failure(`${name}: invalid JSON`, { error: 'INVALID_JSON', input: rawInput.slice(0, 2000) }, [`JSON:${name}`]);
      }
      const errors = validateJson(input, tool.inputSchema, { ...tool.defs });
      if (errors.length > 0) {
        return failure(`${name}: invalid input`, { error: 'The input does not match the tool schema.', errors: formatErrors(errors) },
          errors.slice(0, 5).map((e) => `INPUT:${name}:${e.path}`));
      }
      try {
        return await tool.run(input, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`${name}: failed`, { error: message }, [`FAIL:${name}`]);
      }
    },
  };
}
