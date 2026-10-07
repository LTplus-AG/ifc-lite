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
 *   flow review   <checkpoint.json> [--approve D | --reject]   review a paused run (see `flow-review.ts`)
 *   flow resume   <graph.flow.json> <model.ifc> --checkpoint F  resume a reviewed run
 *
 * AI nodes (`@ifc-lite/flow-nodes/ai`) run only when the environment names a
 * provider (`flow-ai.ts`), spend one root budget per run (`--ai-max-requests`,
 * `--ai-max-output-tokens`), and pause the run for review: `run` then needs
 * `--checkpoint F` and exits 3.
 *
 * The CLI is a trusted caller running a local file, so no capability grants
 * are applied to model/viewer/export capabilities; the graph's declared
 * `capabilities` are still reported. `network.ai`, `network.fetch:<host>` and
 * `secret.read:<NAME>` are the exception: they are ALWAYS checked against
 * the graph's own declared capabilities regardless of trust level (see
 * `FlowHost.networkGrants`'s doc comment in `@ifc-lite/flow-nodes`) — a
 * local trusted run is still not trusted to reach an arbitrary host or leak
 * an env var the graph never wrote down. Viewer nodes run as no-ops
 * (`headlessFeatures`), so a graph that colorizes failures in the viewer
 * validates and runs in CI unchanged.
 *
 * Secrets: `{{secret:NAME}}` references in node params are validated
 * against the graph's `secret.read:<NAME>` capabilities and the real
 * environment BEFORE the run starts (`validateSecretReferences`), then
 * substituted into a throwaway copy of the document (`interpolateSecrets`)
 * — the original document, and anything derived from it before this point
 * (wiring/availability reports), never carries a real secret value.
 * Every text this command emits afterwards (`--json`, plain-text summary,
 * stderr) is passed through `redactDeep`/`redactText` first, so a secret
 * that reaches a remote response body and comes back in a node's output or
 * a thrown error is still scrubbed, not just the literal param it was
 * interpolated into.
 */

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import {
  checkAvailability, declaredInputKeys, describeFlowIO, parseFlowDocument, resolveDeclaredParam, runFlow,
  validateFlowWiring, type FlowDocument, type RunResult
} from '@ifc-lite/flow';
import { resumeOutputs } from '@ifc-lite/flow/checkpoint';
import { parseCapabilities } from '@ifc-lite/extensions';
import {
  buildRedactionMap,
  createStandardRegistry,
  headlessFeatures,
  interpolateSecrets,
  redactDeep,
  resolveSecretValues,
  usableSecretNames,
  validateSecretReferences,
} from '@ifc-lite/flow-nodes';
import { aiNodes, AI_FEATURE, FLOW_AI_BUDGET } from '@ifc-lite/flow-nodes/ai';
import { createRootBudget, restoreRootBudget } from '@ifc-lite/ai';
import { createHeadlessContext } from '../loader.js';
import { createCliAiService, flowAiConfig } from './flow-ai.js';
import { sourceDigestOf } from './flow-checkpoint.js';
import { checkPauseDestination, checkpointNodes, claimForResume, failResume, finishResume, PAUSED_FOR_REVIEW, preparePause, reportPause, reviewCommand, savePause, type Resume } from './flow-review.js';
import { createCliFlowSession } from './flow-host.js';
import { fatal, getAllFlags, hasFlag, printJson } from '../output.js';
import { defaultTrackingPath, FileTrackingStore } from './flow-tracking.js';

const USAGE = 'Usage: ifc-lite flow <run|resume|describe|validate|review> <graph.flow.json> [<model.ifc>] [--input k=v]... [--out F] [--tracking F | --no-tracking] [--checkpoint F] [--json]';

/** The standard nodes plus the AI nodes, so an AI graph reports what it lacks instead of an unknown type. */
function cliRegistry(): ReturnType<typeof createStandardRegistry> {
  return createStandardRegistry().registerAll(aiNodes);
}

function cliFeatures(): ReturnType<typeof headlessFeatures> {
  const features = headlessFeatures(usableSecretNames(process.env));
  return flowAiConfig(process.env) ? { ...features, backend: new Set([...features.backend, AI_FEATURE]) } : features;
}

function budgetLimit(args: string[], flag: string, fallback: number): number {
  const raw = requireFlagValue(args, flag);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) fatal(`${flag} must be a positive whole number`);
  return value;
}

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

const VALUE_FLAGS = new Set(['--input', '--out', '--tracking', '--checkpoint', '--next-checkpoint', '--approve', '--ai-max-requests', '--ai-max-output-tokens']);

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
 * and report success while writing the wrong value. The lookup itself is
 * `resolveDeclaredParam` from `@ifc-lite/flow`, shared with the MCP
 * `run_flow` tool so the two callers cannot drift on what counts as declared.
 */
function parseInputs(raws: string[], doc: FlowDocument, registry: ReturnType<typeof createStandardRegistry>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of raws) {
    const eq = raw.indexOf('=');
    if (eq <= 0) fatal(`--input expects nodeId.param=value, got "${raw}"`);
    const key = raw.slice(0, eq);
    if (!resolveDeclaredParam(key, doc, registry)) {
      const known = declaredInputKeys(doc);
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
  const registry = cliRegistry();

  if (sub === 'review') return reviewCommand(args, positional[0], json, requireFlagValue(args, '--approve'));

  if (sub === 'describe') {
    const doc = await loadDocument(positional[0]);
    const info = describeFlowIO(doc, registry);
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
    const availability = checkAvailability(doc, registry, cliFeatures());
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

  if (sub !== 'run' && sub !== 'resume') fatal(USAGE);
  const [graphPath, modelPath] = positional;
  if (!modelPath) fatal(USAGE);
  const doc = await loadDocument(graphPath);
  const checkpointPath = requireFlagValue(args, '--checkpoint');
  // Refuse malformed arguments before consuming a reviewed checkpoint.
  const out = requireFlagValue(args, '--out');
  const trackingPath = requireFlagValue(args, '--tracking') ?? defaultTrackingPath(graphPath);
  const requestedBudget = { maxRequests: budgetLimit(args, '--ai-max-requests', FLOW_AI_BUDGET.maxRequests),
    maxOutputTokens: budgetLimit(args, '--ai-max-output-tokens', FLOW_AI_BUDGET.maxOutputTokens) };
  if (sub === 'resume' && !checkpointPath) fatal('flow resume needs --checkpoint <file>');

  // Capabilities first: `declaredSecrets` reads the all-or-nothing parse, so
  // with one malformed capability every secret would be reported undeclared
  // instead of the malformed capability itself (#5446 review).
  const capsResult = parseCapabilities(doc.capabilities);
  if (!capsResult.ok) fatal(`the graph declares malformed capabilities: ${capsResult.errors.map((e) => e.message).join('; ')}`);

  // Secrets: validated against the real environment BEFORE anything else
  // touches the graph — an undeclared or unset `{{secret:NAME}}` reference
  // is refused here, never interpolated as an empty string.
  const secretErrors = validateSecretReferences(doc, process.env);
  if (secretErrors.length > 0) {
    for (const e of secretErrors) process.stderr.write(`  error secrets: ${e.message}\n`);
    fatal(`${secretErrors.length} secret reference problem(s); see above`);
  }
  const inputs = parseInputs(getAllFlags(args, '--input'), doc, registry);
  // A resume's restored nodes are not executed again, so they need no host
  // service: replaying a reviewed AI proposal needs no provider.
  const restored = new Set(sub === 'resume' ? await checkpointNodes(checkpointPath!) : []);
  const unavailable = checkAvailability(doc, registry, cliFeatures())
    .filter((node) => !restored.has(node.nodeId) && (node.status === 'unknown' || node.status === 'unavailable'));
  if (unavailable.length) fatal(`Flow cannot run on this host: ${unavailable.map((node) => `${node.nodeId}: ${node.reasons.join('; ')}`).join(' | ')}`);
  const reviewsAhead = doc.nodes.some((n) => registry.get(n.type)?.review && !restored.has(n.id));
  const nextCheckpoint = sub === 'resume' ? requireFlagValue(args, '--next-checkpoint') : checkpointPath;
  if (reviewsAhead && !nextCheckpoint) {
    fatal(sub === 'resume' ? 'this graph pauses for review again after the checkpoint; pass --next-checkpoint <file>' : 'this graph pauses for review; pass --checkpoint <file> to save the proposal');
  }
  if (reviewsAhead && nextCheckpoint) {
    try { await checkPauseDestination(nextCheckpoint); } catch (error) { fatal((error as Error).message); }
  }
  const modelBytes = await readFile(modelPath);
  // The claim is taken before anything runs, against the model this resume starts from.
  const resume: Resume | undefined = sub === 'resume' ? await claimForResume(checkpointPath!, doc, inputs, sourceDigestOf(modelBytes), registry) : undefined;

  const secretValues = resolveSecretValues(doc, process.env);
  const redaction = buildRedactionMap(secretValues);
  const runDoc = interpolateSecrets(doc, secretValues);

  // The host follows the model the graph works on: `model.openFromSource`
  // can replace the command-line model mid-run (see `flow-host.ts`).
  const aiConfig = flowAiConfig(process.env);
  const budget = restoreRootBudget(resume?.checkpoint.budget) ?? createRootBudget(requestedBudget);
  const initialModel = await createHeadlessContext(modelPath);
  const session = createCliFlowSession(initialModel, capsResult.value, aiConfig ? createCliAiService(aiConfig, budget) : undefined);
  const host = session.host;

  let tracking: FileTrackingStore | undefined;
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

  const result = await runFlow(runDoc, {
    host,
    registry,
    // `--input` overrides are NOT scanned for `{{secret:NAME}}` — a secret
    // must be authored into the graph's own node params, not passed at the
    // command line, where it would land in shell history / process args.
    inputs,
    features: cliFeatures(),
    ...(resume ? { resume: resumeOutputs(resume.checkpoint) } : {}),
    modelRevisions: { [host.defaultModelId ?? 'model']: 0 },
    tracking,
  });
  const paused = result.ok && result.review.length > 0;
  const activeModelChanged = session.active() !== initialModel;
  const wrote = out !== undefined && result.ok;
  let trackingWritten = false;
  let pause: Awaited<ReturnType<typeof savePause>> | undefined;
  try {
    if (paused && activeModelChanged && out === undefined) throw new Error('the run opened a different model before pausing for review; pass --out so the resume starts from that model');
    if (paused && result.writes > 0 && out === undefined) throw new Error('the run wrote to the model before pausing for review; pass --out so the resume can start from that model');
    if (paused && !nextCheckpoint) throw new Error(`the run paused for review at ${result.review.join(', ')} with no checkpoint file to save it to`);
    let written: string | Uint8Array | undefined;
    if (wrote) {
      const { bim, store } = session.active();
      const content = bim.export.ifc(null, { schema: (store.schemaVersion as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined) ?? 'IFC4', includeMutations: true });
      written = typeof content === 'string' ? content : Buffer.from(content);
    }
    // Refuse secrets in every restored output before either durable side effect.
    const proposal = paused ? preparePause({ registry, doc, result, inputs, sourceDigest: sourceDigestOf((result.writes > 0 || activeModelChanged) && written !== undefined ? written : modelBytes), budget: { ...budget } }, redaction) : undefined;
    if (written !== undefined) await writeFile(out!, written);
    trackingWritten = tracking ? await tracking.flush() : false;
    if (proposal) pause = await savePause(nextCheckpoint!, proposal);
    if (resume) await finishResume(resume, result);
  } catch (error) {
    const message = redactDeep((error as Error).message, redaction);
    if (resume) await failResume(resume, message);
    fatal(message);
  }

  // Redaction runs at the OUTER boundary, right before anything leaves this
  // process — on the whole summary object (`--json` output included), not
  // just the interpolated param string: a secret that reached a remote
  // response body and came back as a node output or an error message is
  // caught here too, not only at the point it was substituted in.
  const summary = redactDeep(summarize(result), redaction);
  if (json) printJson({ ...summary, out: wrote ? out : null, tracking: trackingWritten ? tracking!.path : null, ...(pause ? { checkpoint: { path: nextCheckpoint, id: pause.id, proposalDigest: pause.proposalDigest } } : {}) });
  else {
    if (pause) reportPause(pause, nextCheckpoint!);
    process.stdout.write(`${result.ok ? 'ok' : 'FAILED'}: ${Object.entries(summary.nodes).map(([k, v]) => `${v} ${k}`).join(', ')}\n`);
    // `summary` was already redacted (deep) above; `redactDeep` walks Maps
    // too, so `o.data` here never carries a raw secret value.
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
  if (pause) process.exit(PAUSED_FOR_REVIEW);
}
