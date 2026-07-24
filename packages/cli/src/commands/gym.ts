/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite gym (--model <file.ifc> | --seed <n>) [--checks schema,clash,ids] [--ids <rules.xml>]`
 *
 * A reset/step/reward environment loop over the existing headless checks:
 * the skeleton of an RLVR environment for buildings (docs/vision/moonshots-tech.md
 * M2, docs/vision/moonshots-execution-plan.md B0.4). No procedural generator: the
 * environment wraps ONE loaded model and lets an agent apply data-mutation ops,
 * scoring each step against the same schema/clash/ids checks the `validate`,
 * `clash`, and `ids` commands already run. Geometry-creating ops are out of
 * scope for v0, see the "op vocabulary gaps" note in the class doc below.
 *
 * Protocol (newline-delimited JSON on stdout, one JSON command per stdin line):
 *
 *   -> (on start)     {"type":"reset","observation":{...},"channels":{...}}
 *   <- {"type":"step","ops":[{"op":"setProperty","expressId":42,"psetName":"Pset_WallCommon","propName":"IsExternal","value":true}]}
 *   -> {"type":"reward","channels":{...},"done":false}
 *   <- {"type":"reset"}
 *   -> {"type":"reset","observation":{...},"channels":{...}}
 *   <- {"type":"close"}
 *   -> (process exits 0, no reply line)
 *
 * Malformed input never crashes the process: it replies with a structured
 * {"type":"error","message":"..."} line and keeps reading.
 *
 * Episode factory (B2.2): instead of `--model`, `--seed <n>` generates a
 * World Gym benchmark model in-process (tools/world-gym/generator.mjs,
 * dynamically imported from the repo checkout - the published npm package
 * does not ship the generator, so `--seed` fails there with a clear error
 * while `--model` keeps working). `[--family frame|office|auto]` pins the
 * family; corruption follows the benchmark's deterministic Bernoulli draw at
 * the spec's corrupt rate (tools/world-gym/benchmark/splits.mjs) unless
 * `--corrupt` / `--no-corrupt` forces it or `--corrupt-rate <p>` overrides
 * the rate. Mid-session, `{"type":"reset","seed":8}` (plus optional
 * "family"/"corrupt"/"corruptRate" fields) swaps to a fresh generated
 * episode, so an RL consumer can stream the whole benchmark through one gym
 * process without touching generator internals. Generated-episode reset
 * lines carry an extra `episode` field: {seed, family, corrupted}. (The
 * `corrupted` flag is deliberately exposed: the gym is the TRAINING surface;
 * benchmark ground truth is regenerable from the seed anyway - see
 * tools/world-gym/benchmark/BENCHMARK.md.)
 *
 * Determinism: the same model plus the same op sequence must yield
 * byte-identical reward lines. Every array the reward payload emits is
 * explicitly sorted (never left in Map/engine iteration order) and every
 * fractional score is rounded to a fixed number of decimals, so a run is
 * reproducible even though property-set overlay creation mints a fresh
 * random GlobalId each time (those GlobalIds are never echoed into the
 * reward payload, only counts are).
 *
 * Mutation surface: v0 supports `setProperty` / `setAttribute` /
 * `deleteProperty`, mirroring `bim.mutate`'s method names exactly. Ops are
 * applied via `MutablePropertyView` + `StepExporter` (the same classes
 * `ifc-lite mutate` uses) rather than through `bim.mutate` itself, because
 * `HeadlessBackend.mutate` (packages/cli/src/headless-backend.ts) is
 * currently a no-op stub: `bim.mutate.setProperty()` silently does nothing
 * in headless mode. Wiring that backend up to the same MutablePropertyView
 * this file drives is a mechanical follow-up, not a redesign, since the op
 * vocabulary already matches.
 *
 * Each step re-exports the accumulated mutation overlay to STEP text and
 * re-parses it into a fresh `IfcDataStore` before running checks. This is
 * deliberate, not a perf shortcut we forgot to remove: `ids`/`clash`/the
 * schema checks all read directly from an `IfcDataStore` (via
 * `createDataAccessor(store)` / `EntityNode(store, id)`), with no
 * mutation-overlay awareness, so a live overlay would silently be invisible
 * to every check. Re-parsing after export guarantees the checks see exactly
 * what a human re-opening the mutated file would see.
 *
 * Op vocabulary gaps (v0, tracked for a follow-up bet, not fixed here):
 *   - Ops target entities by `expressId`, not `GlobalId`. Stable within one
 *     gym session (StepExporter never renumbers existing entities), but a
 *     GlobalId-keyed op format would be more robust for agents that only
 *     ever see a model's IFC-standard identifiers.
 *   - `observation.bounds` is always `null`: no geometry pass runs on
 *     `reset`, and even the `clash` channel's mesh pass never feeds a
 *     bounding box back into the observation.
 *   - No entity-creation ops (new walls/slabs/etc. via `packages/create`) and
 *     no episode-termination signal (`done` is always `false`); both need a
 *     real reward-shaping design, not just wiring.
 *   - `bim.mutate.setProperty/setAttribute/deleteProperty` are no-ops on
 *     `HeadlessBackend` (see above); this file works around that directly
 *     rather than fixing the backend, to keep this bet's diff scoped to one
 *     new command.
 */

import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadIfcFile, loadIfcBytes } from '../loader.js';
import { getFlag, fatal } from '../output.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { PropertyValueType } from '@ifc-lite/data';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { createClashEngine, type ClashRule, type Clash } from '@ifc-lite/clash';
import { elementsFromStep } from '@ifc-lite/clash/step';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { IDSNamespace, type IDSSupportedLocale } from '@ifc-lite/sdk';
import { computeValidationIssues } from './validate.js';

/** Reward channels this prototype knows how to compute. */
type GymCheck = 'schema' | 'clash' | 'ids';
const KNOWN_CHECKS: GymCheck[] = ['schema', 'clash', 'ids'];

/** A single mutation op, applied cumulatively across `step` calls. */
type GymOp =
  | { op: 'setProperty'; expressId: number; psetName: string; propName: string; value: string | number | boolean | null }
  | { op: 'setAttribute'; expressId: number; attrName: string; value: string }
  | { op: 'deleteProperty'; expressId: number; psetName: string; propName: string };

const USAGE = 'Usage: ifc-lite gym (--model <file.ifc> | --seed <n> [--family frame|office|auto] [--corrupt|--no-corrupt|--corrupt-rate <p>]) [--checks schema,clash,ids] [--ids <rules.xml>] [--locale en|de|fr]';

// ============================================================================
// Episode factory: the World Gym generator, loaded from the repo checkout
// ============================================================================

interface GeneratedModel {
  seed: number | string;
  family: string;
  corrupted: boolean;
  content: string;
}

interface WorldGymGenerator {
  generateModel: (
    seed: number | string,
    family?: string,
    opts?: { corruptRate?: number; forceCorrupt?: boolean },
  ) => GeneratedModel;
}

/** Episode descriptor echoed on generated-episode reset lines. */
interface EpisodeInfo {
  seed: number | string;
  family: string;
  corrupted: boolean;
}

interface EpisodeSpec {
  seed: number | string;
  family: string;
  forceCorrupt?: boolean;
  corruptRate?: number;
}

/** Benchmark default; overwritten from benchmark/splits.mjs when loadable. */
let benchmarkCorruptRate = 0.3;
let generatorModule: WorldGymGenerator | null = null;

async function loadGenerator(): Promise<WorldGymGenerator> {
  if (generatorModule) return generatorModule;
  // Both src (vitest) and dist layouts sit 4 levels below the repo root.
  const generatorUrl = new URL('../../../../tools/world-gym/generator.mjs', import.meta.url);
  try {
    generatorModule = (await import(generatorUrl.href)) as WorldGymGenerator;
  } catch (err) {
    throw new Error(
      `the gym episode factory needs the ifc-lite repo checkout (could not load ${generatorUrl.pathname}: ${(err as Error).message}); use --model <file.ifc> instead`,
    );
  }
  try {
    const splits = (await import(new URL('../../../../tools/world-gym/benchmark/splits.mjs', import.meta.url).href)) as { CORRUPT_RATE?: number };
    if (typeof splits.CORRUPT_RATE === 'number') benchmarkCorruptRate = splits.CORRUPT_RATE;
  } catch {
    // Keep the compiled-in default; the generator itself is what matters.
  }
  return generatorModule;
}

function parseSeed(raw: unknown, source: string): number | string {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : raw;
  }
  throw new Error(`${source} must be a non-negative integer (benchmark seed) or a non-empty string`);
}

function parseCorruptRate(raw: unknown, source: string): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${source} must be a number in [0, 1]`);
  }
  return n;
}

async function generateEpisode(spec: EpisodeSpec): Promise<{ model: GeneratedModel; episode: EpisodeInfo }> {
  const generator = await loadGenerator();
  const opts = spec.forceCorrupt !== undefined
    ? { forceCorrupt: spec.forceCorrupt }
    : { corruptRate: spec.corruptRate ?? benchmarkCorruptRate };
  const model = generator.generateModel(spec.seed, spec.family, opts);
  return {
    model,
    episode: { seed: spec.seed, family: model.family, corrupted: model.corrupted },
  };
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parseChecks(raw: string | undefined, idsPath: string | undefined): Set<GymCheck> {
  if (raw === undefined) {
    return idsPath ? new Set<GymCheck>(['schema', 'clash', 'ids']) : new Set<GymCheck>(['schema', 'clash']);
  }
  const result = new Set<GymCheck>();
  for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    if (!KNOWN_CHECKS.includes(part as GymCheck)) {
      fatal(`Unknown check "${part}" in --checks (supported: ${KNOWN_CHECKS.join(', ')})`);
    }
    result.add(part as GymCheck);
  }
  return result;
}

function inferValueType(value: unknown): PropertyValueType {
  if (typeof value === 'boolean') return PropertyValueType.Boolean;
  if (typeof value === 'number') return Number.isInteger(value) ? PropertyValueType.Integer : PropertyValueType.Real;
  return PropertyValueType.String;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`op field "${field}" must be a non-empty string`);
  }
  return value;
}

function requireExpressId(value: unknown): number {
  if (!isFiniteNumber(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error('op field "expressId" must be a positive integer');
  }
  return value;
}

/**
 * Apply one gym op to the running mutation overlay. Throws a plain Error on
 * anything malformed; the caller wraps this in a try/catch and turns it into
 * a structured `{type:"error"}` line rather than crashing the process.
 */
function applyOp(view: MutablePropertyView, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { op?: unknown }).op !== 'string') {
    throw new Error('each op needs a string "op" field');
  }
  const op = raw as GymOp;
  switch (op.op) {
    case 'setProperty': {
      const expressId = requireExpressId(op.expressId);
      const psetName = requireString(op.psetName, 'psetName');
      const propName = requireString(op.propName, 'propName');
      const value = op.value;
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error('op field "value" must be a string, number, boolean, or null');
      }
      view.setProperty(expressId, psetName, propName, value, inferValueType(value));
      return;
    }
    case 'setAttribute': {
      const expressId = requireExpressId(op.expressId);
      const attrName = requireString(op.attrName, 'attrName');
      const value = requireString(op.value, 'value');
      view.setAttribute(expressId, attrName, value);
      return;
    }
    case 'deleteProperty': {
      const expressId = requireExpressId(op.expressId);
      const psetName = requireString(op.psetName, 'psetName');
      const propName = requireString(op.propName, 'propName');
      view.deleteProperty(expressId, psetName, propName);
      return;
    }
    default:
      throw new Error(`Unsupported op "${(op as { op: string }).op}" (v0 supports setProperty, setAttribute, deleteProperty)`);
  }
}

function computeSchemaChannel(store: IfcDataStore): Record<string, unknown> {
  const issues = computeValidationIssues(store)
    .slice()
    .sort((a, b) => (a.rule === b.rule ? a.message.localeCompare(b.message) : a.rule.localeCompare(b.rule)));
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const info = issues.filter(i => i.severity === 'info').length;
  const score = errors > 0 ? 0 : warnings > 0 ? 0.5 : 1;
  return { score, errors, warnings, info, issues };
}

async function computeClashChannel(store: IfcDataStore, processor: GeometryProcessor, modelId: string): Promise<Record<string, unknown>> {
  const bytes = store.source;
  if (!bytes || bytes.byteLength === 0) {
    return { score: null, error: 'clash check needs source bytes, which the current store did not retain' };
  }
  const result = await processor.process(bytes);
  const meshes: MeshData[] = result.meshes;
  const { elements, exclusions } = elementsFromStep({ store, meshes, modelId });

  // v0 default: a single self-clash rule across every element, matching
  // `ifc-lite clash` with no `--matrix`/`--a`/`--b` flags.
  const rules: ClashRule[] = [{ id: 'gym-self-clash', name: '* self-clash', a: '*', mode: 'hard' }];
  const engine = createClashEngine({ backend: 'ts' });
  const clashResult = await engine.run(elements, rules, { exclusions });

  const sorted = clashResult.clashes.slice().sort((a: Clash, b: Clash) => {
    if (a.a.key !== b.a.key) return a.a.key < b.a.key ? -1 : 1;
    if (a.b.key !== b.b.key) return a.b.key < b.b.key ? -1 : 1;
    return a.distance - b.distance;
  });

  return {
    score: clashResult.summary.total,
    bySeverity: clashResult.summary.bySeverity,
    top: sorted.slice(0, 20).map(c => ({
      a: c.a.key,
      aTag: c.a.tag,
      b: c.b.key,
      bTag: c.b.tag,
      severity: c.severity,
      status: c.status,
      distance: round(c.distance),
    })),
  };
}

async function computeIdsChannel(
  store: IfcDataStore,
  ids: IDSNamespace,
  idsDoc: unknown,
  locale: IDSSupportedLocale,
): Promise<Record<string, unknown>> {
  if (!idsDoc) {
    return { score: null, error: 'ids check requested but --ids <rules.xml> was not provided' };
  }
  const accessor = createDataAccessor(store);
  const report = (await ids.validate(idsDoc, {
    accessor,
    modelInfo: { schemaVersion: store.schemaVersion },
    locale,
    includePassingEntities: false,
  })) as {
    summary: {
      totalSpecifications: number;
      passedSpecifications: number;
      failedSpecifications: number;
      totalEntitiesChecked: number;
      totalEntitiesPassed: number;
      totalEntitiesFailed: number;
    };
  };
  const summary = report.summary;
  const passRatio = summary.totalEntitiesChecked > 0
    ? round(summary.totalEntitiesPassed / summary.totalEntitiesChecked)
    : 1;
  return {
    score: passRatio,
    totalSpecifications: summary.totalSpecifications,
    passedSpecifications: summary.passedSpecifications,
    failedSpecifications: summary.failedSpecifications,
    totalEntitiesChecked: summary.totalEntitiesChecked,
    totalEntitiesPassed: summary.totalEntitiesPassed,
    totalEntitiesFailed: summary.totalEntitiesFailed,
  };
}

function computeObservation(store: IfcDataStore): Record<string, unknown> {
  const entityCounts: Record<string, number> = {};
  for (const [type, ids] of store.entityIndex.byType) {
    if (ids.length > 0) entityCounts[type] = ids.length;
  }
  const sortedEntityCounts: Record<string, number> = {};
  for (const type of Object.keys(entityCounts).sort()) {
    sortedEntityCounts[type] = entityCounts[type];
  }
  const storeyCount = (store.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? []).length;
  return {
    entityCounts: sortedEntityCounts,
    storeyCount,
    schema: store.schemaVersion ?? null,
    // v0 gap: no geometry pass runs on reset (only the "clash" channel
    // meshes, and only for clash detection, not to derive bounds), so
    // `bounds` is always null for now. See the module doc's "op vocabulary
    // gaps" note.
    bounds: null,
  };
}

/**
 * Options that let tests drive the stdin/stdout loop without touching the
 * real process streams.
 */
export interface GymIO {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function gymCommand(args: string[], io: GymIO = {}): Promise<void> {
  const modelPath = getFlag(args, '--model');
  const seedFlag = getFlag(args, '--seed');
  if (!modelPath && seedFlag === undefined) fatal(USAGE);
  if (modelPath && seedFlag !== undefined) fatal(`--model and --seed are mutually exclusive\n${USAGE}`);

  const idsPath = getFlag(args, '--ids');
  const checks = parseChecks(getFlag(args, '--checks'), idsPath);
  const locale = (getFlag(args, '--locale') ?? 'en') as IDSSupportedLocale;

  const output = io.output ?? process.stdout;
  const input = io.input ?? process.stdin;

  function send(msg: Record<string, unknown>): void {
    output.write(`${JSON.stringify(msg)}\n`);
  }

  let modelId: string;
  let originalStore: IfcDataStore;
  let episode: EpisodeInfo | null = null;

  async function loadEpisode(spec: EpisodeSpec): Promise<void> {
    const { model, episode: info } = await generateEpisode(spec);
    originalStore = await loadIfcBytes(new TextEncoder().encode(model.content), `gym-seed-${info.seed}.ifc`);
    episode = info;
    modelId = `gym-seed-${info.seed}.ifc`;
  }

  if (modelPath) {
    modelId = basename(modelPath);
    originalStore = await loadIfcFile(modelPath);
  } else {
    const forceCorrupt = args.includes('--corrupt') ? true : args.includes('--no-corrupt') ? false : undefined;
    const corruptRateFlag = getFlag(args, '--corrupt-rate');
    await loadEpisode({
      seed: parseSeed(seedFlag, '--seed'),
      family: getFlag(args, '--family') ?? 'auto',
      forceCorrupt,
      corruptRate: corruptRateFlag !== undefined ? parseCorruptRate(corruptRateFlag, '--corrupt-rate') : undefined,
    });
  }

  const ids = new IDSNamespace();
  let idsDoc: unknown = null;
  if (idsPath) {
    const idsXml = await readFile(idsPath, 'utf-8');
    idsDoc = await ids.parse(idsXml);
  }

  // Lazily initialised: wasm geometry init is only worth paying for when
  // the "clash" channel is actually requested.
  let processor: GeometryProcessor | null = null;
  async function getProcessor(): Promise<GeometryProcessor> {
    if (!processor) {
      processor = new GeometryProcessor();
      await processor.init();
    }
    return processor;
  }

  let mutationView = createMutationView();

  function createMutationView(): MutablePropertyView {
    const view = new MutablePropertyView(null, 'default');
    view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(originalStore, entityId));
    return view;
  }

  /**
   * Materialise the current mutation overlay into a fresh, independently
   * parsed store. See the module doc for why re-export + re-parse is
   * required rather than reading through the overlay directly.
   */
  async function materializeStore(): Promise<IfcDataStore> {
    const schema = (originalStore.schemaVersion ?? 'IFC4') as 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
    const exporter = new StepExporter(originalStore, mutationView);
    const result = exporter.export({ schema, applyMutations: true });
    return loadIfcBytes(result.content, modelId);
  }

  async function computeChannels(store: IfcDataStore): Promise<Record<string, unknown>> {
    const channels: Record<string, unknown> = {};
    // Fixed canonical key order regardless of --checks argument order, so
    // two runs requesting the same set in a different order still produce
    // byte-identical JSON.
    if (checks.has('schema')) channels.schema = computeSchemaChannel(store);
    if (checks.has('clash')) channels.clash = await computeClashChannel(store, await getProcessor(), modelId);
    if (checks.has('ids')) channels.ids = await computeIdsChannel(store, ids, idsDoc, locale);
    return channels;
  }

  async function emitReset(): Promise<void> {
    mutationView = createMutationView();
    const observation = computeObservation(originalStore);
    const channels = await computeChannels(originalStore);
    // `episode` only exists for generated episodes; --model resets keep the
    // exact v0 payload shape for backward compatibility.
    send(episode ? { type: 'reset', episode, observation, channels } : { type: 'reset', observation, channels });
  }

  await emitReset();

  const rl = createInterface({ input, terminal: false, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      send({ type: 'error', message: `Malformed JSON: ${(err as Error).message}` });
      continue;
    }

    const type = typeof msg === 'object' && msg !== null ? (msg as { type?: unknown }).type : undefined;
    try {
      if (type === 'step') {
        const ops = (msg as { ops?: unknown }).ops;
        if (!Array.isArray(ops)) throw new Error('"step" command needs an "ops" array');
        for (const op of ops) applyOp(mutationView, op);
        const store = await materializeStore();
        const channels = await computeChannels(store);
        send({ type: 'reward', channels, done: false });
      } else if (type === 'reset') {
        const m = msg as { seed?: unknown; family?: unknown; corrupt?: unknown; corruptRate?: unknown };
        if (m.seed !== undefined) {
          // New generated episode over the same protocol (episode factory).
          if (m.family !== undefined && typeof m.family !== 'string') {
            throw new Error('reset field "family" must be a string (frame|office|auto)');
          }
          if (m.corrupt !== undefined && typeof m.corrupt !== 'boolean') {
            throw new Error('reset field "corrupt" must be a boolean');
          }
          await loadEpisode({
            seed: parseSeed(m.seed, 'reset field "seed"'),
            family: (m.family as string | undefined) ?? 'auto',
            forceCorrupt: m.corrupt as boolean | undefined,
            corruptRate: m.corruptRate !== undefined ? parseCorruptRate(m.corruptRate, 'reset field "corruptRate"') : undefined,
          });
        }
        await emitReset();
      } else if (type === 'close') {
        rl.close();
        return;
      } else {
        send({ type: 'error', message: `Unknown command type: ${JSON.stringify(type ?? null)}` });
      }
    } catch (err) {
      send({ type: 'error', message: (err as Error).message });
    }
  }
}
