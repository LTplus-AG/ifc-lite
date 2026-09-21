/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite flow <run|describe|validate>` — evaluate a `*.flow.json` graph
 * headlessly over the same `HeadlessBackend` every other command uses.
 *
 *   flow run      <graph.flow.json> <model.ifc> [--input k=v]... [--out F] [--json]
 *   flow describe <graph.flow.json> [--json]        inputs/outputs schema (the Hops `/io`)
 *   flow validate <graph.flow.json> [--json]        document + node availability report
 *
 * The CLI is a trusted caller running a local file, so no capability grants
 * are applied; the graph's declared `capabilities` are still reported.
 * Viewer nodes run as no-ops (`headlessFeatures`), so a graph that
 * colorizes failures in the viewer validates and runs in CI unchanged.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { checkAvailability, parseFlowDocument, runFlow, type FlowDocument, type RunResult } from '@ifc-lite/flow';
import { createStandardRegistry, headlessFeatures, type FlowHost } from '@ifc-lite/flow-nodes';
import { createHeadlessContext } from '../loader.js';
import { fatal, getAllFlags, getFlag, hasFlag, printJson } from '../output.js';

const USAGE = 'Usage: ifc-lite flow <run|describe|validate> <graph.flow.json> [<model.ifc>] [--input k=v]... [--out F] [--json]';

async function loadDocument(path: string | undefined): Promise<FlowDocument> {
  if (!path) fatal(USAGE);
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    fatal(`cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return parseFlowDocument(text);
  } catch (err) {
    fatal((err as Error).message);
  }
}

const VALUE_FLAGS = new Set(['--input', '--out']);

/** Arguments that are neither flags nor the value of a value-taking flag. */
function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_FLAGS.has(args[i])) i += 1;
    else if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}

/** `--input nodeId.param=value`; values parse as JSON when they can, else as strings. */
function parseInputs(raws: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of raws) {
    const eq = raw.indexOf('=');
    if (eq <= 0) fatal(`--input expects nodeId.param=value, got "${raw}"`);
    const key = raw.slice(0, eq);
    const text = raw.slice(eq + 1);
    try {
      out[key] = JSON.parse(text);
    } catch {
      out[key] = text;
    }
  }
  return out;
}

function describe(doc: FlowDocument, registry: ReturnType<typeof createStandardRegistry>) {
  const inputs = doc.inputs.map((i) => {
    const def = registry.get(doc.nodes.find((n) => n.id === i.nodeId)?.type ?? '');
    const param = def?.params.find((p) => p.name === i.param);
    return { key: `${i.nodeId}.${i.param}`, label: i.label, kind: i.kind, options: i.options, default: param?.default, paramKind: param?.kind };
  });
  const outputs = doc.outputs.map((o) => {
    const def = registry.get(doc.nodes.find((n) => n.id === o.nodeId)?.type ?? '');
    const port = def?.outputs.find((p) => p.name === o.port);
    return { key: `${o.nodeId}.${o.port}`, label: o.label, kind: port?.type.kind, access: port?.type.access };
  });
  return { id: doc.id, name: doc.name, description: doc.description, capabilities: doc.capabilities, inputs, outputs };
}

function summarize(result: RunResult) {
  const statuses: Record<string, number> = {};
  for (const r of result.reports) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  return {
    ok: result.ok,
    nodes: statuses,
    outputs: result.graphOutputs.map((o) => ({ label: o.label, key: `${o.nodeId}.${o.port}`, data: o.data })),
    errors: result.log.filter((l) => l.level === 'error'),
    warnings: result.log.filter((l) => l.level === 'warn'),
  };
}

export async function flowCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const positional = positionalArgs(args.slice(1));
  const json = hasFlag(args, '--json');
  const registry = createStandardRegistry();

  if (sub === 'describe') {
    const doc = await loadDocument(positional[0]);
    const info = describe(doc, registry);
    if (json) return printJson(info);
    process.stdout.write(`${info.name} (${info.id})\n`);
    if (info.description) process.stdout.write(`  ${info.description}\n`);
    process.stdout.write(`  capabilities: ${info.capabilities.join(', ') || '(none)'}\n  inputs:\n`);
    for (const i of info.inputs) process.stdout.write(`    ${i.key}  ${i.label} [${i.kind}]${i.default !== undefined ? ` default=${JSON.stringify(i.default)}` : ''}\n`);
    process.stdout.write('  outputs:\n');
    for (const o of info.outputs) process.stdout.write(`    ${o.key}  ${o.label} [${o.kind ?? '?'}/${o.access ?? '?'}]\n`);
    return;
  }

  if (sub === 'validate') {
    const doc = await loadDocument(positional[0]);
    const availability = checkAvailability(doc, registry, headlessFeatures(Object.keys(process.env)));
    const problems = availability.filter((a) => a.status === 'unavailable' || a.status === 'unknown');
    if (json) return printJson({ ok: problems.length === 0, nodes: availability });
    for (const a of availability) process.stdout.write(`  ${a.status.padEnd(11)} ${a.nodeId} (${a.type})${a.reasons.length ? `: ${a.reasons.join('; ')}` : ''}\n`);
    if (problems.length > 0) {
      process.stderr.write(`${problems.length} node(s) cannot run on this host\n`);
      process.exit(2);
    }
    return;
  }

  if (sub !== 'run') fatal(USAGE);
  const [graphPath, modelPath] = positional;
  if (!modelPath) fatal(USAGE);
  const doc = await loadDocument(graphPath);
  const { bim, store } = await createHeadlessContext(modelPath);
  const host: FlowHost = { bim, defaultModelId: bim.model.activeId() ?? undefined };
  const result = await runFlow(doc, {
    host,
    registry,
    inputs: parseInputs(getAllFlags(args, '--input')),
    features: headlessFeatures(Object.keys(process.env)),
    modelRevisions: { [host.defaultModelId ?? 'model']: 0 },
  });

  const out = getFlag(args, '--out');
  if (out) {
    const content = bim.export.ifc(null, { schema: (store.schemaVersion as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined) ?? 'IFC4', includeMutations: true });
    await writeFile(out, typeof content === 'string' ? content : Buffer.from(content));
  }

  const summary = summarize(result);
  if (json) printJson({ ...summary, out: out ?? null });
  else {
    process.stdout.write(`${result.ok ? 'ok' : 'FAILED'}: ${Object.entries(summary.nodes).map(([k, v]) => `${v} ${k}`).join(', ')}\n`);
    for (const o of summary.outputs) process.stdout.write(`  ${o.label}: ${JSON.stringify(o.data, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v))}\n`);
    for (const e of summary.errors) process.stderr.write(`  error ${e.nodeId}${e.laneKey ? `[${e.laneKey}]` : ''}: ${e.message}\n`);
    for (const w of summary.warnings) process.stderr.write(`  warn  ${w.nodeId}${w.laneKey ? `[${w.laneKey}]` : ''}: ${w.message}\n`);
    if (out) process.stdout.write(`  wrote ${out}\n`);
  }
  if (!result.ok) process.exit(1);
}
