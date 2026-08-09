/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite gym (--model <file.ifc> | --seed <n>) [--checks schema,clash,ids] [--ids <rules.xml>]`
 *
 * A reset/step/reward environment loop over the existing headless checks:
 * the skeleton of an RLVR environment for buildings (docs/vision/moonshots-tech.md
 * M2, docs/vision/moonshots-execution-plan.md B0.4). The environment wraps a
 * model - either a fixed file (`--model`) or a procedurally generated World
 * Gym episode (`--seed`, see `gym/episode.ts`) - and lets an agent apply
 * data-mutation ops, scoring each step against the same schema/clash/ids
 * checks the `validate`, `clash`, and `ids` commands already run.
 * Geometry-creating ops are out of scope for v0, see "op vocabulary gaps"
 * below.
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
 * {"type":"error","message":"..."} line and keeps reading. A `step` batch is
 * ATOMIC: it either fully applies (one `reward` line) or leaves the session
 * exactly as it was (one `error` line) - a malformed op mid-batch never
 * leaves earlier ops of the same batch applied.
 *
 * Episode factory (B2.2): instead of `--model`, `--seed <n>` generates a
 * World Gym benchmark model in-process (tools/world-gym/generator.mjs,
 * dynamically imported from the repo checkout - the published npm package
 * does not ship the generator, so `--seed` fails there with a clear error
 * while `--model` keeps working). `[--family frame|office|auto]` pins the
 * family; corruption follows the benchmark's deterministic Bernoulli draw at
 * the spec's corrupt rate (tools/world-gym/benchmark/splits.mjs) unless
 * `--corrupt` / `--no-corrupt` forces it or `--corrupt-rate <p>` overrides
 * the rate (forcing and a rate are mutually exclusive). Mid-session,
 * `{"type":"reset","seed":8}` (plus optional "family"/"corrupt"/"corruptRate"
 * fields) swaps to a fresh generated episode, so an RL consumer can stream
 * the whole benchmark through one gym process without touching generator
 * internals. Generated-episode reset lines carry an extra `episode` field:
 * {seed, family, corrupted}. (The `corrupted` flag is deliberately exposed:
 * the gym is the TRAINING surface; benchmark ground truth is regenerable
 * from the seed anyway - see tools/world-gym/benchmark/BENCHMARK.md.)
 *
 * Determinism: the same model plus the same op sequence must yield
 * byte-identical reward lines - see `gym/channels.ts` for the sorting and
 * rounding contract. Reward shaping: every channel's `score` is in [0, 1]
 * with higher-is-better (the clash channel scores 1 for clash-free and
 * decreases as the clash count grows; the raw count is `totalClashes`).
 *
 * Mutation surface: v0 supports `setProperty` / `setAttribute` /
 * `deleteProperty`, mirroring `bim.mutate`'s method names exactly (see
 * `gym/ops.ts`). Ops are applied via `MutablePropertyView` + `StepExporter`
 * (the same classes `ifc-lite mutate` uses) rather than through `bim.mutate`
 * itself, because `HeadlessBackend.mutate` (packages/cli/src/headless-backend.ts)
 * is currently a no-op stub: `bim.mutate.setProperty()` silently does
 * nothing in headless mode. Wiring that backend up to the same
 * MutablePropertyView this file drives is a mechanical follow-up, not a
 * redesign, since the op vocabulary already matches.
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
import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { IDSNamespace, type IDSSupportedLocale } from '@ifc-lite/sdk';
import {
  type GymCheck,
  KNOWN_CHECKS,
  computeSchemaChannel,
  computeClashChannel,
  computeIdsChannel,
  computeObservation,
} from './gym/channels.js';
import { type GymOp, parseOp, applyOp } from './gym/ops.js';
import {
  type EpisodeInfo,
  type EpisodeSpec,
  generateEpisode,
  parseSeed,
  parseCorruptRate,
} from './gym/episode.js';

const USAGE = 'Usage: ifc-lite gym (--model <file.ifc> | --seed <n> [--family frame|office|auto] [--corrupt|--no-corrupt|--corrupt-rate <p>]) [--checks schema,clash,ids] [--ids <rules.xml>] [--locale en|de|fr]';

const SUPPORTED_LOCALES: IDSSupportedLocale[] = ['en', 'de', 'fr'];

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

function parseLocale(raw: string | undefined): IDSSupportedLocale {
  if (raw === undefined) return 'en';
  if (!SUPPORTED_LOCALES.includes(raw as IDSSupportedLocale)) {
    fatal(`Unsupported --locale "${raw}" (supported: ${SUPPORTED_LOCALES.join(', ')})`);
  }
  return raw as IDSSupportedLocale;
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
  const locale = parseLocale(getFlag(args, '--locale'));

  const output: NodeJS.WritableStream = io.output ?? process.stdout;
  const input: NodeJS.ReadableStream = io.input ?? process.stdin;

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
    if (forceCorrupt !== undefined && corruptRateFlag !== undefined) {
      fatal(`--corrupt/--no-corrupt and --corrupt-rate are mutually exclusive\n${USAGE}`);
    }
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
  // the "clash" channel is actually requested. Boxed rather than a plain
  // `let`: TS's control-flow analysis does not track the assignment made
  // inside `getProcessor`, so at the `finally` below it still considers the
  // variable `null`, narrows `?.dispose()` to `never`, and fails to compile.
  // A property read sidesteps the narrowing. (Verified: the plain-`let` form
  // errors with TS2339 "Property 'dispose' does not exist on type 'never'".)
  const processorRef: { current: GeometryProcessor | null } = { current: null };
  async function getProcessor(): Promise<GeometryProcessor> {
    if (!processorRef.current) {
      // Assign only after init() succeeds: caching the instance before a
      // failed init would hand every later call an uninitialized processor
      // instead of retrying (the init throw itself surfaces as a structured
      // error line on the step that requested the clash channel).
      const p = new GeometryProcessor();
      await p.init();
      processorRef.current = p;
    }
    return processorRef.current;
  }

  function createMutationView(): MutablePropertyView {
    const view = new MutablePropertyView(null, 'default');
    view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(originalStore, entityId));
    // The quantity half of the same base — see #2487: an overlay with nothing
    // under it writes an edited quantity set out missing every sibling.
    view.setQuantityExtractor((entityId: number) => extractQuantitiesOnDemand(originalStore, entityId));
    return view;
  }

  /**
   * The committed op journal: every op of every successfully rewarded step,
   * in order. `step` batches are atomic - a failing batch (malformed op,
   * export/parse failure, channel failure) must leave the session exactly as
   * it was - so the journal is the single source of truth and the view is
   * rebuilt from it whenever a batch fails partway through.
   */
  let journal: GymOp[] = [];
  let mutationView = createMutationView();

  function rebuildViewFromJournal(): void {
    mutationView = createMutationView();
    for (const op of journal) applyOp(mutationView, op);
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

  /** Apply a step batch atomically: on ANY failure, restore the pre-batch state. */
  async function stepBatch(rawOps: unknown[]): Promise<Record<string, unknown>> {
    // Phase 1: validate the whole batch before anything is applied.
    const ops = rawOps.map(raw => parseOp(raw));
    // Phase 2: apply + materialize + score; roll back to the journal on failure.
    try {
      for (const op of ops) applyOp(mutationView, op);
      const store = await materializeStore();
      const channels = await computeChannels(store);
      journal.push(...ops);
      return channels;
    } catch (err) {
      rebuildViewFromJournal();
      throw err;
    }
  }

  async function emitReset(): Promise<void> {
    journal = [];
    mutationView = createMutationView();
    const observation = computeObservation(originalStore);
    const channels = await computeChannels(originalStore);
    // `episode` only exists for generated episodes; --model resets keep the
    // exact v0 payload shape for backward compatibility.
    send(episode ? { type: 'reset', episode, observation, channels } : { type: 'reset', observation, channels });
  }

  try {
    await emitReset();

    const rl = createInterface({ input, terminal: false, crlfDelay: Infinity });
    // A broken pipe on stdout or a stdin failure must end the loop cleanly,
    // not take the process down with an uncaught 'error' emitter event.
    const onStreamError = (): void => {
      rl.close();
    };
    input.on('error', onStreamError);
    output.on('error', onStreamError);

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
          const channels = await stepBatch(ops);
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
            if (m.corrupt !== undefined && m.corruptRate !== undefined) {
              throw new Error('reset fields "corrupt" and "corruptRate" are mutually exclusive');
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
  } finally {
    // The clash channel's GeometryProcessor is session-scoped, not per-request:
    // it is created lazily at most once per gymCommand call and reused across
    // every 'step'/'reset' message. A test harness or any other caller that
    // invokes gymCommand more than once per process must not accumulate one
    // WASM handle per call.
    processorRef.current?.dispose();
  }
}
