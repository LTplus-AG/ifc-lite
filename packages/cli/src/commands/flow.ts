/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite flow <run|describe|validate>` — evaluate a `*.flow.json` graph
 * headlessly over the same `HeadlessBackend` every other command uses.
 *
 *   flow run      <graph.flow.json> <model.ifc> [--input k=v]... [--out F] [--tracking F|--no-tracking] [--json]
 *   flow describe <graph.flow.json> [--json]        inputs/outputs schema (the Hops `/io`)
 *   flow validate <graph.flow.json> [--json]        document + node availability report
 *
 * The CLI is a trusted caller running a local file, so no capability grants
 * are applied; the graph's declared `capabilities` are still reported.
 * Viewer nodes run as no-ops (`headlessFeatures`), so a graph that
 * colorizes failures in the viewer validates and runs in CI unchanged.
 */

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { checkAvailability, parseFlowDocument, runFlow, validateFlowWiring, type FlowDocument, type RunResult } from '@ifc-lite/flow';
import { createStandardRegistry, headlessFeatures, type FlowHost } from '@ifc-lite/flow-nodes';
import { createHeadlessContext } from '../loader.js';
import { fatal, getAllFlags, hasFlag, printJson } from '../output.js';
import { defaultTrackingPath, FileTrackingStore } from './flow-tracking.js';

const USAGE = 'Usage: ifc-lite flow <run|describe|validate> <graph.flow.json> [<model.ifc>] [--input k=v]... [--out F] [--tracking F | --no-tracking] [--json]';

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

const VALUE_FLAGS = new Set(['--input', '--out', '--tracking']);

/** Arguments that are neither flags nor the value of a value-taking flag. */
function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_FLAGS.has(args[i])) i += 1;
    else if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}

/**
 * A value-taking flag's operand. An absent flag and a flag whose operand is
 * missing are different things: `--out` at the end of the line, or
 * `--out --json`, would otherwise write a file literally named `--json`.
 */
function requireFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) fatal(`${flag} needs a value`);
  return value;
}

/**
 * `--input nodeId.param=value`; values parse as JSON when they can, else as
 * strings. A key that names no declared parameter is refused rather than
 * ignored: the scheduler silently drops unknown keys, so `--input
 * rating=REI90` (missing the node id) would run the graph on its DEFAULTS
 * and report success while writing the wrong value.
 */
function parseInputs(raws: string[], doc: FlowDocument, registry: ReturnType<typeof createStandardRegistry>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of raws) {
    const eq = raw.indexOf('=');
    if (eq <= 0) fatal(`--input expects nodeId.param=value, got "${raw}"`);
    const key = raw.slice(0, eq);
    const dot = key.lastIndexOf('.');
    const node = dot > 0 ? doc.nodes.find((n) => n.id === key.slice(0, dot)) : undefined;
    const param = node ? registry.get(node.type)?.params.find((p) => p.name === key.slice(dot + 1)) : undefined;
    if (!param) {
      const known = doc.inputs.map((i) => `${i.nodeId}.${i.param}`);
      fatal(`--input "${key}" names no parameter${known.length > 0 ? `; this graph declares ${known.join(', ')}` : ''}`);
    }
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
    log: result.log,
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
    // Wiring first: `parseFlowDocument` is registry-free, so a declared
    // output naming a port no node has would otherwise validate clean and
    // then produce nothing at run time.
    const wiring = validateFlowWiring(doc, registry);
    const availability = checkAvailability(doc, registry, headlessFeatures(Object.keys(process.env)));
    const problems = availability.filter((a) => a.status === 'unavailable' || a.status === 'unknown');
    // The report goes out in either format FIRST, then the exit code — a
    // `--json` run that printed `ok: false` and returned 0 let CI read an
    // unrunnable graph as a successful validation.
    if (json) printJson({ ok: problems.length === 0 && wiring.length === 0, wiring, nodes: availability });
    else {
      for (const w of wiring) process.stdout.write(`  wiring      ${w.path}: ${w.message}\n`);
      for (const a of availability) process.stdout.write(`  ${a.status.padEnd(11)} ${a.nodeId} (${a.type})${a.reasons.length ? `: ${a.reasons.join('; ')}` : ''}\n`);
    }
    if (problems.length > 0 || wiring.length > 0) {
      if (wiring.length > 0) process.stderr.write(`${wiring.length} wiring problem(s)\n`);
      if (problems.length > 0) process.stderr.write(`${problems.length} node(s) cannot run on this host\n`);
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

  let tracking: FileTrackingStore | undefined;
  const trackingPath = requireFlagValue(args, '--tracking') ?? defaultTrackingPath(graphPath);
  // An existing sidecar is opened even when no node is tracked any more:
  // that is how a set whose node was deleted gets removed from the model.
  const wantsTracking = doc.nodes.some((n) => registry.get(n.type)?.tracked) || (await stat(trackingPath).then(() => true, () => false));
  if (!hasFlag(args, '--no-tracking') && wantsTracking) {
    const pin = `file:${createHash('sha256').update(await readFile(modelPath)).digest('hex')}`;
    tracking = await FileTrackingStore.open(trackingPath, pin);
    if (tracking.loadedPin !== undefined && tracking.loadedPin !== pin) {
      process.stderr.write(`  warn  tracking sidecar ${tracking.path} was written against another model state; tracked elements that are missing will be re-created\n`);
    }
  }

  const result = await runFlow(doc, {
    host,
    registry,
    inputs: parseInputs(getAllFlags(args, '--input'), doc, registry),
    features: headlessFeatures(Object.keys(process.env)),
    modelRevisions: { [host.defaultModelId ?? 'model']: 0 },
    tracking,
  });
  const trackingWritten = tracking ? await tracking.flush() : false;

  // A failed run can still have written through earlier nodes. Exporting
  // that half-applied state would hand the next step a model no graph run
  // ever produced, under a green-looking file on disk.
  const out = requireFlagValue(args, '--out');
  const wrote = out !== undefined && result.ok;
  if (wrote) {
    const content = bim.export.ifc(null, { schema: (store.schemaVersion as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined) ?? 'IFC4', includeMutations: true });
    await writeFile(out, typeof content === 'string' ? content : Buffer.from(content));
  }

  const summary = summarize(result);
  if (json) printJson({ ...summary, out: wrote ? out : null, tracking: trackingWritten ? tracking!.path : null });
  else {
    process.stdout.write(`${result.ok ? 'ok' : 'FAILED'}: ${Object.entries(summary.nodes).map(([k, v]) => `${v} ${k}`).join(', ')}\n`);
    for (const o of summary.outputs) process.stdout.write(`  ${o.label}: ${JSON.stringify(o.data, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v))}\n`);
    for (const e of summary.errors) process.stderr.write(`  error ${e.nodeId}${e.laneKey ? `[${e.laneKey}]` : ''}: ${e.message}\n`);
    for (const w of summary.warnings) process.stderr.write(`  warn  ${w.nodeId}${w.laneKey ? `[${w.laneKey}]` : ''}: ${w.message}\n`);
    if (wrote) process.stdout.write(`  wrote ${out}
`);
    else if (out !== undefined) process.stderr.write(`  not written: the run failed, so ${out} would hold a half-applied model
`);
    if (trackingWritten) process.stdout.write(`  tracking ${tracking!.path}
`);
  }
  if (!result.ok) process.exit(1);
}
