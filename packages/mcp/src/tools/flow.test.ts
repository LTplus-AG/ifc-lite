/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `describe_flow` / `run_flow` (#5167 Phase 4.3): the MCP mirror of
 * `ifc-lite flow describe|run`. These tests go through
 * `buildDefaultToolRegistry()` and look the tools up by name — the same
 * seam every other MCP tool test uses (see `structural.test.ts`,
 * `check-rules.test.ts`) — so a revert of the production change fails on an
 * assertion (`toBeDefined()` / a handler call) rather than a load error.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { buildDefaultToolRegistry } from './index.js';
import type { CallToolResult } from '../protocol/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../../');
const SAMPLE_IFC = resolve(REPO_ROOT, 'apps/viewer/public/samples/building-architecture.ifc');
// The same shipped example the CLI's `flow.test.ts` runs: a write-capable
// graph (`model.setProperty`, gated on the exact pset) with no element
// creation, so it runs fine against `HeadlessLikeBackend`'s store adapter
// (which does not yet implement `addColumn`/`addWall`/etc. — see flow.ts's
// module doc).
const AUDIT_FLOW = resolve(REPO_ROOT, 'apps/viewer/src/lib/flow/examples/05-fire-rating-audit.flow.json');

const registry = buildDefaultToolRegistry();
const describeFlow = registry.get('describe_flow');
const runFlow = registry.get('run_flow');

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-flow-'));
});

async function contextWithModel(): Promise<ToolContext> {
  const registryInstance = new InMemoryModelRegistry();
  registryInstance.add(await loadIfcModel(SAMPLE_IFC, { modelId: 'sample' }));
  return {
    registry: registryInstance,
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [dirname(AUDIT_FLOW), tmp] },
  };
}

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe('#5167 describe_flow / run_flow', () => {
  it('registers both tools in default discovery', () => {
    expect(describeFlow, 'describe_flow must be registered').toBeDefined();
    expect(runFlow, 'run_flow must be registered').toBeDefined();
  });

  it('describe_flow returns the declared inputs and outputs with types, from an inline document', async () => {
    if (!describeFlow) throw new Error('describe_flow not registered');
    const text = await readFile(AUDIT_FLOW, 'utf-8');
    const ctx = await contextWithModel();
    const result = await describeFlow.handler({ flow: JSON.parse(text) }, ctx);
    const info = structured(result) as {
      ok: boolean;
      id: string;
      inputs: Array<{ key: string; kind: string; default?: unknown; paramKind?: string }>;
      outputs: Array<{ key: string; kind?: string; access?: string }>;
      diagnostics: unknown[];
    };
    expect(info.ok).toBe(true);
    expect(info.diagnostics).toEqual([]);
    expect(info.id).toBe('example-fire-rating-audit');
    expect(info.inputs).toEqual([{ key: 'rating.value', label: 'Default fire rating', kind: 'scalar', options: undefined, default: '', paramKind: 'string' }]);
    expect(info.outputs).toEqual([
      { key: 'missingCount.count', label: 'Walls without FireRating', kind: 'scalar', access: 'item' },
      { key: 'table.table', label: 'Wall table', kind: 'table', access: 'item' },
    ]);
  });

  // The #5167 defect this tool exists to close: `parseFlowDocument` is
  // registry-free, so a declared output naming a missing port validates
  // clean under it alone. `describe_flow` must run `validateFlowWiring`
  // (registry-aware) and report the defect, not `ok: true`.
  it('describe_flow reports a declared output naming a missing port as a diagnostic, not ok — and does not throw', async () => {
    if (!describeFlow) throw new Error('describe_flow not registered');
    const doc = {
      flowVersion: 1,
      id: 'bad-output',
      name: 'bad',
      capabilities: [],
      inputs: [],
      outputs: [{ nodeId: 'n', port: 'no_such_port', label: 'x' }],
      nodes: [{ id: 'n', type: 'core.number', params: { value: 1 } }],
      edges: [],
    };
    const ctx = await contextWithModel();
    const result = await describeFlow.handler({ flow: doc }, ctx);
    const info = structured(result) as { ok: boolean; diagnostics: Array<{ path: string; message: string }> };
    expect(info.ok).toBe(false);
    expect(info.diagnostics.some((d) => /has no output "no_such_port"/.test(d.message))).toBe(true);
  });

  it('run_flow executes a fixture graph against a real loaded model and returns its declared outputs', async () => {
    if (!runFlow) throw new Error('run_flow not registered');
    const ctx = await contextWithModel();
    const result = await runFlow.handler({ flow_path: AUDIT_FLOW, model_id: 'sample' }, ctx);
    const summary = structured(result) as {
      ok: boolean;
      outputs: Array<{ key: string; label: string; data: unknown }>;
    };
    expect(summary.ok).toBe(true);
    const missing = summary.outputs.find((o) => o.key === 'missingCount.count');
    const table = summary.outputs.find((o) => o.key === 'table.table');
    expect(missing?.data).toEqual(4);
    expect((table?.data as { rows: unknown[] })?.rows.length).toBeGreaterThan(0);
  });

  it('run_flow with an input override changes the output — proves overrides are applied, not defaults', async () => {
    if (!runFlow) throw new Error('run_flow not registered');
    const ctx = await contextWithModel();
    const result = await runFlow.handler({ flow_path: AUDIT_FLOW, model_id: 'sample', inputs: { 'rating.value': 'REI90' } }, ctx);
    const summary = structured(result) as { ok: boolean; outputs: Array<{ key: string; data: unknown }> };
    expect(summary.ok).toBe(true);
    const table = summary.outputs.find((o) => o.key === 'table.table');
    const rows = (table?.data as { rows: Array<Record<string, unknown>> }).rows;
    // The rows the run just wrote (walls that had no FireRating) now carry
    // the overridden value, never the graph's own default ('REI60').
    expect(rows.some((r) => r['Pset_WallCommon.FireRating'] === 'REI90')).toBe(true);
    expect(rows.some((r) => r['Pset_WallCommon.FireRating'] === 'REI60')).toBe(false);
  });

  // The CLI had exactly this bug: `--input rating=REI90` (missing the node
  // id) named no declared parameter, was dropped silently, and the graph
  // ran on its defaults while reporting success (#5167).
  it('run_flow rejects an unknown inputs key, naming it, instead of dropping it', async () => {
    if (!runFlow) throw new Error('run_flow not registered');
    const ctx = await contextWithModel();
    await expect(runFlow.handler({ flow_path: AUDIT_FLOW, model_id: 'sample', inputs: { rating: 'REI90' } }, ctx))
      .rejects.toThrow(/"rating" name no declared parameter.*rating\.value/s);
  });

  // A node that fails partway (division by zero) must mark the whole run
  // failed; downstream outputs come back without data rather than the
  // half-applied model being reported as success.
  it('a failed node marks the run failed, never reports the half-applied model as success', async () => {
    if (!runFlow) throw new Error('run_flow not registered');
    const doc = {
      flowVersion: 1,
      id: 'broken',
      name: 'broken',
      capabilities: [],
      inputs: [],
      outputs: [{ nodeId: 'boom', port: 'result', label: 'result' }],
      nodes: [
        { id: 'zero', type: 'core.number', params: { value: 0 } },
        { id: 'boom', type: 'core.math', params: { op: 'divide' } },
      ],
      edges: [
        { from: ['zero', 'value'], to: ['boom', 'a'] },
        { from: ['zero', 'value'], to: ['boom', 'b'] },
      ],
    };
    const ctx = await contextWithModel();
    const result = await runFlow.handler({ flow: doc, model_id: 'sample' }, ctx);
    const summary = structured(result) as { ok: boolean; outputs: Array<{ key: string; data: unknown }> };
    expect(summary.ok).toBe(false);
    expect(summary.outputs.find((o) => o.key === 'boom.result')?.data).toBeUndefined();
  });

  it('refuses a flow_path that escapes the allowed root (safe-path)', async () => {
    if (!describeFlow) throw new Error('describe_flow not registered');
    const outside = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-flow-outside-'));
    const evil = join(outside, 'evil.flow.json');
    await writeFile(evil, await readFile(AUDIT_FLOW, 'utf-8'));
    const ctx: ToolContext = {
      registry: new InMemoryModelRegistry(),
      scope: fullScope(),
      progress: NOOP_PROGRESS,
      log: SILENT_LOGGER,
      signal: new AbortController().signal,
      // Allowed root is `tmp`, not `outside` — a sibling temp dir outside it.
      config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
    };
    await expect(describeFlow.handler({ flow_path: evil }, ctx)).rejects.toThrow(/outside allowed roots/);
    await rm(outside, { recursive: true, force: true });
  });

  it('rejects a structurally invalid document with a diagnostic, not an opaque throw, from describe_flow', async () => {
    if (!describeFlow) throw new Error('describe_flow not registered');
    const ctx = await contextWithModel();
    const result = await describeFlow.handler({ flow: { flowVersion: 1, id: 'x', name: 'x', nodes: [{ id: 'a', type: 'core.number', lacing: 'sideways' }], edges: [], inputs: [], outputs: [], capabilities: [] } }, ctx);
    const info = structured(result) as { ok: boolean; diagnostics: Array<{ message: string }> };
    expect(info.ok).toBe(false);
    expect(info.diagnostics.some((d) => /must be one of shortest, longest, cross/.test(d.message))).toBe(true);
  });
});
