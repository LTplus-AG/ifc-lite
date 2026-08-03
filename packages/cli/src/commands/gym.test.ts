/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, PassThrough } from 'node:stream';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { gymCommand } from './gym.js';
import { clashScoreFromCount } from './gym/channels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// AB22.ifc is one of the smallest manifest fixtures (~220KB, ~2900 entities,
// parses in single-digit ms). Fixtures are not committed: the `--model`
// suites below SKIP (never fail) when it has not been fetched via
// `pnpm fixtures` (or alone via `node scripts/fixtures/fetch-fixtures.mjs
// AB22.ifc`). The `--seed` episode-factory suite generates its models
// in-process and always runs.
const MODEL = join(__dirname, '../../../../tests/models/AB22.ifc');
const MODEL_AVAILABLE = existsSync(MODEL);

/** IfcPavement #30 in AB22.ifc ("Pavement"): a stable target for property ops. */
const PAVEMENT_EXPRESS_ID = 30;

// ---------------------------------------------------------------------------
// Typed views of the JSONL protocol, so the tests break at compile time when
// the payload shape changes instead of silently reading undefined fields.
// ---------------------------------------------------------------------------

interface SchemaChannel {
  score: number;
  errors: number;
  warnings: number;
  info: number;
  issues: { severity: string; rule: string; message: string }[];
}

interface ClashChannel {
  score: number;
  totalClashes: number;
}

interface IdsChannel {
  score: number | null;
  totalEntitiesPassed: number;
  totalEntitiesFailed: number;
}

interface Channels {
  schema?: SchemaChannel;
  clash?: ClashChannel;
  ids?: IdsChannel;
}

interface EpisodeInfo {
  seed: number | string;
  family: string;
  corrupted: boolean;
}

interface Observation {
  entityCounts: Record<string, number>;
  storeyCount: number;
  schema: string | null;
  bounds: null;
}

interface ResetLine {
  type: 'reset';
  episode?: EpisodeInfo;
  observation: Observation;
  channels: Channels;
}

interface RewardLine {
  type: 'reward';
  channels: Channels;
  done: boolean;
}

interface ErrorLine {
  type: 'error';
  message: string;
}

type GymLine = ResetLine | RewardLine | ErrorLine;

function isReset(line: GymLine): line is ResetLine {
  return line.type === 'reset';
}
function isReward(line: GymLine): line is RewardLine {
  return line.type === 'reward';
}
function isError(line: GymLine): line is ErrorLine {
  return line.type === 'error';
}

/** Assert-and-narrow: fail the test with a clear message on a shape mismatch. */
function expectReward(line: GymLine | undefined): RewardLine {
  if (!line || !isReward(line)) throw new Error(`expected a reward line, got ${JSON.stringify(line)}`);
  return line;
}
function expectReset(line: GymLine | undefined): ResetLine {
  if (!line || !isReset(line)) throw new Error(`expected a reset line, got ${JSON.stringify(line)}`);
  return line;
}
function expectError(line: GymLine | undefined): ErrorLine {
  if (!line || !isError(line)) throw new Error(`expected an error line, got ${JSON.stringify(line)}`);
  return line;
}

const IDS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ids:ids xmlns:ids="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <ids:info>
    <ids:title>Gym test spec</ids:title>
  </ids:info>
  <ids:specifications>
    <ids:specification name="Pavement has TestFlag" ifcVersion="IFC4X3">
      <ids:applicability>
        <ids:entity>
          <ids:name><ids:simpleValue>IFCPAVEMENT</ids:simpleValue></ids:name>
        </ids:entity>
      </ids:applicability>
      <ids:requirements>
        <ids:property dataType="IFCBOOLEAN">
          <ids:propertySet><ids:simpleValue>Pset_Gym</ids:simpleValue></ids:propertySet>
          <ids:baseName><ids:simpleValue>TestFlag</ids:simpleValue></ids:baseName>
        </ids:property>
      </ids:requirements>
    </ids:specification>
  </ids:specifications>
</ids:ids>
`;

/** Drive gymCommand over an in-memory stdin, collecting each JSONL reply. */
async function runGym(
  args: string[],
  commands: Record<string, unknown>[],
): Promise<GymLine[]> {
  const input = new Readable({ read() {} });
  const output = new PassThrough();
  const lines: GymLine[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) lines.push(JSON.parse(line) as GymLine);
    }
  });

  const done = gymCommand(args, { input, output });

  // gymCommand emits the initial "reset" synchronously-ish before reading
  // stdin; queue every scripted line on the microtask/macrotask queue so
  // they arrive after that first reset without a real clock dependency.
  for (const cmd of commands) {
    input.push(`${JSON.stringify(cmd)}\n`);
  }
  input.push(null);

  await done;
  return lines;
}

describe('clash reward shaping', () => {
  it('scores 1 for a clash-free model and strictly decreases as clashes grow', () => {
    expect(clashScoreFromCount(0)).toBe(1);
    const counts = [0, 1, 2, 5, 10, 100, 10_000];
    const scores = counts.map(clashScoreFromCount);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
    for (const s of scores) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe.skipIf(!MODEL_AVAILABLE)('gymCommand (fixture: AB22.ifc)', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  });

  async function writeIdsFixture(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-gym-'));
    tmpDirs.push(dir);
    const path = join(dir, 'spec.ids');
    await writeFile(path, IDS_XML, 'utf-8');
    return path;
  }

  it('reset emits a well-formed observation and the requested channels', async () => {
    const lines = await runGym(['--model', MODEL, '--checks', 'schema,clash'], [{ type: 'close' }]);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    const reset = expectReset(lines[0]);
    expect(reset.observation.storeyCount).toBe(0); // AB22.ifc is an infra model, no storeys
    expect(reset.observation.schema).toBe('IFC4X3');
    const entityCounts = reset.observation.entityCounts;
    expect(entityCounts.IFCPAVEMENT).toBe(1);
    expect(entityCounts.IFCPROJECT).toBe(1);
    // Keys must be sorted for determinism.
    expect(Object.keys(entityCounts)).toEqual([...Object.keys(entityCounts)].sort());

    expect(reset.channels.schema).toBeDefined();
    expect(reset.channels.clash).toBeDefined();
    expect(reset.channels.ids).toBeUndefined(); // not requested
  });

  it('a benign property step returns every requested channel', async () => {
    const idsPath = await writeIdsFixture();
    const lines = await runGym(
      ['--model', MODEL, '--checks', 'schema,clash,ids', '--ids', idsPath],
      [
        {
          type: 'step',
          ops: [{ op: 'setProperty', expressId: PAVEMENT_EXPRESS_ID, psetName: 'Pset_Gym', propName: 'TestFlag', value: true }],
        },
        { type: 'close' },
      ],
    );

    const reward = expectReward(lines.find(isReward));
    expect(reward.done).toBe(false);
    const { schema, clash, ids } = reward.channels;
    expect(schema).toBeDefined();
    expect(clash).toBeDefined();
    expect(ids).toBeDefined();

    // The op we applied should make the one IDS spec pass now.
    expect(ids!.score).toBe(1);
    expect(ids!.totalEntitiesPassed).toBe(1);
    expect(ids!.totalEntitiesFailed).toBe(0);

    // Clash score is shaped higher-is-better in [0, 1]; the raw count is a
    // separate field so a maximizing agent is never rewarded for clashes.
    expect(clash!.score).toBeGreaterThan(0);
    expect(clash!.score).toBeLessThanOrEqual(1);
    expect(clash!.totalClashes).toBeGreaterThanOrEqual(0);
    expect(clash!.score).toBe(clashScoreFromCount(clash!.totalClashes));
    expect(typeof schema!.score).toBe('number');
  });

  it('the ids channel fails before the op and passes after it, in the same episode', async () => {
    const idsPath = await writeIdsFixture();
    const lines = await runGym(
      ['--model', MODEL, '--checks', 'ids', '--ids', idsPath],
      [
        // Step 0: no ops yet, Pset_Gym.TestFlag does not exist on the model.
        { type: 'step', ops: [] },
        // Step 1: add it, the same spec should now pass.
        {
          type: 'step',
          ops: [{ op: 'setProperty', expressId: PAVEMENT_EXPRESS_ID, psetName: 'Pset_Gym', propName: 'TestFlag', value: true }],
        },
        { type: 'close' },
      ],
    );

    const rewards = lines.filter(isReward);
    expect(rewards).toHaveLength(2);
    expect(rewards[0].channels.ids!.score).toBe(0);
    expect(rewards[1].channels.ids!.score).toBe(1);
  });

  it('a step batch is atomic: a malformed op mid-batch leaves earlier ops unapplied', async () => {
    const idsPath = await writeIdsFixture();
    const lines = await runGym(
      ['--model', MODEL, '--checks', 'ids', '--ids', idsPath],
      [
        // Baseline: no ops applied, the IDS spec fails.
        { type: 'step', ops: [] },
        // A batch whose FIRST op would make the IDS spec pass, followed by a
        // malformed op. The whole batch must be rejected without applying
        // the first op.
        {
          type: 'step',
          ops: [
            { op: 'setProperty', expressId: PAVEMENT_EXPRESS_ID, psetName: 'Pset_Gym', propName: 'TestFlag', value: true },
            { op: 'setProperty', expressId: PAVEMENT_EXPRESS_ID, psetName: 'Pset_Gym', propName: '', value: true },
          ],
        },
        // Post-failure probe: the reward must be byte-identical to the
        // baseline, proving the valid op did not survive the failed batch.
        { type: 'step', ops: [] },
        { type: 'close' },
      ],
    );

    const rewards = lines.filter(isReward);
    const errors = lines.filter(isError);
    expect(rewards).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/propName.*non-empty string/);
    expect(rewards[0].channels.ids!.score).toBe(0);
    expect(JSON.stringify(rewards[1])).toBe(JSON.stringify(rewards[0]));
  });

  it('produces byte-identical reward lines for the same 3-step episode run twice', async () => {
    const episode = [
      { type: 'step', ops: [{ op: 'setProperty', expressId: PAVEMENT_EXPRESS_ID, psetName: 'Pset_Gym', propName: 'Step', value: 1 }] },
      { type: 'step', ops: [{ op: 'setAttribute', expressId: PAVEMENT_EXPRESS_ID, attrName: 'Description', value: 'gym-step-2' }] },
      { type: 'step', ops: [{ op: 'deleteProperty', expressId: PAVEMENT_EXPRESS_ID, psetName: 'Pset_Gym', propName: 'Step' }] },
      { type: 'close' },
    ];

    const run1 = await runGym(['--model', MODEL, '--checks', 'schema,clash'], episode);
    const run2 = await runGym(['--model', MODEL, '--checks', 'schema,clash'], episode);

    const rewards1 = run1.filter(isReward);
    const rewards2 = run2.filter(isReward);
    expect(rewards1).toHaveLength(3);
    expect(rewards2).toHaveLength(3);
    for (let i = 0; i < rewards1.length; i++) {
      expect(JSON.stringify(rewards1[i])).toBe(JSON.stringify(rewards2[i]));
    }
    // The only test in this file that runs the SAME episode twice, so it pays
    // the fixture parse and three step applications twice over -- structurally
    // the slowest case here, and the 5 s default left it about 1.5x of margin
    // (3.3 s observed on lighter branches). vitest runs suites concurrently, so
    // that margin is a function of what else is running: on a branch that adds
    // a heavy provenance battery this file's tests went 8.87 s -> 14.09 s and
    // this case timed out at 5.59 s TWICE, having never once disagreed on a
    // byte. A determinism test that fails by running out of clock reports the
    // opposite of what it measures, which is worth more than the 10 s.
  }, 20_000);

  it('reset mid-session restores the pristine model', async () => {
    const lines = await runGym(
      ['--model', MODEL, '--checks', 'schema'],
      [
        { type: 'step', ops: [{ op: 'setAttribute', expressId: PAVEMENT_EXPRESS_ID, attrName: 'Name', value: 'Renamed' }] },
        { type: 'reset' },
        { type: 'close' },
      ],
    );

    const resets = lines.filter(isReset);
    expect(resets).toHaveLength(2); // initial + mid-session
    // Both resets describe the same pristine model.
    expect(JSON.stringify(resets[0].observation)).toBe(JSON.stringify(resets[1].observation));
  });

  it('malformed stdin JSON produces a structured error line, not a crash', async () => {
    // Exercised directly against the raw stream (rather than `runGym`, which
    // only accepts well-formed command objects) so an actual unparsable line
    // reaches the readline loop.
    const input = new Readable({ read() {} });
    const output = new PassThrough();
    const raw: string[] = [];
    output.on('data', (chunk: Buffer) => raw.push(chunk.toString('utf-8')));

    const done = gymCommand(['--model', MODEL, '--checks', 'schema'], { input, output });
    input.push('{not valid json at all\n');
    input.push(`${JSON.stringify({ type: 'bogus-command' })}\n`);
    input.push(`${JSON.stringify({ type: 'step', ops: [{ op: 'setProperty', expressId: 999999, psetName: 'P', propName: 'X', value: 1 }] })}\n`);
    input.push(`${JSON.stringify({ type: 'close' })}\n`);
    input.push(null);
    await done;

    const parsed = raw.join('').split('\n').filter(Boolean).map(l => JSON.parse(l) as GymLine);
    const errors = parsed.filter(isError);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors[0].message).toMatch(/Malformed JSON/);
    expect(errors[1].message).toMatch(/Unknown command type/);
  });

  it('rejects an unsupported op with a structured error, not a crash', async () => {
    const lines = await runGym(
      ['--model', MODEL, '--checks', 'schema'],
      [
        { type: 'step', ops: [{ op: 'addWall', expressId: PAVEMENT_EXPRESS_ID }] },
        { type: 'close' },
      ],
    );
    const error = expectError(lines.find(isError));
    expect(error.message).toMatch(/Unsupported op "addWall"/);
  });
});

describe('gymCommand episode factory (--seed, B2.2)', () => {
  // Seed 42 is a clean office model under the benchmark corrupt rate (0.3);
  // seed 8 force-corrupted plants duplicate-globalid + multiple-project
  // (both schema errors). All deterministic by construction.

  it('serves a generated episode from --seed, byte-identical across runs', async () => {
    const run1 = await runGym(['--seed', '42', '--checks', 'schema'], [{ type: 'close' }]);
    const run2 = await runGym(['--seed', '42', '--checks', 'schema'], [{ type: 'close' }]);

    const reset = expectReset(run1[0]);
    expect(reset.episode).toEqual({ seed: 42, family: 'office', corrupted: false });
    expect(reset.observation.storeyCount).toBe(1);
    const entityCounts = reset.observation.entityCounts;
    expect(entityCounts.IFCPROJECT).toBe(1);
    expect(entityCounts.IFCSPACE).toBeGreaterThan(0);
    expect(reset.channels.schema!.score).toBe(1);

    expect(JSON.stringify(run1[0])).toBe(JSON.stringify(run2[0]));
  });

  it('mid-session reset with a seed swaps to a new generated episode', async () => {
    const lines = await runGym(
      ['--seed', '42', '--checks', 'schema'],
      [
        // Seed 2 is a frame-family model: its observation (columns, beams, no
        // spaces) cannot coincide with seed 42's office observation.
        { type: 'reset', seed: 2, corrupt: false },
        { type: 'close' },
      ],
    );
    const resets = lines.filter(isReset);
    expect(resets).toHaveLength(2);
    expect(resets[0].episode!.seed).toBe(42);
    expect(resets[1].episode!.seed).toBe(2);
    expect(resets[1].episode!.family).toBe('frame');
    expect(resets[1].episode!.corrupted).toBe(false);
    expect(JSON.stringify(resets[0].observation)).not.toBe(JSON.stringify(resets[1].observation));
  });

  it('a forced-corrupt episode surfaces planted schema defects in the reward channel', async () => {
    const lines = await runGym(['--seed', '8', '--corrupt', '--checks', 'schema'], [{ type: 'close' }]);
    const reset = expectReset(lines[0]);
    expect(reset.episode!.corrupted).toBe(true);
    const schema = reset.channels.schema!;
    expect(schema.score).toBe(0); // duplicate-globalid + multiple-project are errors
    expect(schema.errors).toBeGreaterThan(0);
  });

  it('step ops apply to a generated episode', async () => {
    // #58 is 'Perimeter Wall 0' (IFCWALL) in the seed-42 office model.
    const lines = await runGym(
      ['--seed', '42', '--checks', 'schema'],
      [
        { type: 'step', ops: [{ op: 'setProperty', expressId: 58, psetName: 'Pset_Gym', propName: 'Touched', value: true }] },
        { type: 'close' },
      ],
    );
    const reward = expectReward(lines.find(isReward));
    expect(reward.channels.schema!.score).toBe(1);
  });

  it('rejects a malformed reset seed with a structured error, keeping the session alive', async () => {
    const lines = await runGym(
      ['--seed', '42', '--checks', 'schema'],
      [
        { type: 'reset', seed: -3 },
        { type: 'reset' },
        { type: 'close' },
      ],
    );
    const error = expectError(lines.find(isError));
    expect(error.message).toMatch(/non-negative integer/);
    // The plain reset afterwards still answers with the original episode.
    const resets = lines.filter(isReset);
    expect(resets).toHaveLength(2);
    expect(resets[1].episode!.seed).toBe(42);
  });

  it('rejects a reset combining "corrupt" and "corruptRate" with a structured error', async () => {
    const lines = await runGym(
      ['--seed', '42', '--checks', 'schema'],
      [
        { type: 'reset', seed: 8, corrupt: true, corruptRate: 0.5 },
        { type: 'close' },
      ],
    );
    const error = expectError(lines.find(isError));
    expect(error.message).toMatch(/mutually exclusive/);
    // Session stays on the original episode.
    const resets = lines.filter(isReset);
    expect(resets).toHaveLength(1);
    expect(resets[0].episode!.seed).toBe(42);
  });
});

describe('gymCommand GeometryProcessor disposal (#1959 P2 leak)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disposes the session-scoped GeometryProcessor once the "clash" channel was used', async () => {
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');

    await runGym(['--seed', '42', '--checks', 'clash'], [{ type: 'close' }]);

    // getProcessor() is lazily created once per gymCommand call and reused
    // across every step/reset message in the session — exactly one instance,
    // disposed exactly once when the session ends.
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not accumulate handles across repeated gymCommand calls in the same process', async () => {
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');

    await runGym(['--seed', '1', '--checks', 'clash'], [{ type: 'close' }]);
    await runGym(['--seed', '2', '--checks', 'clash'], [{ type: 'close' }]);
    await runGym(['--seed', '3', '--checks', 'clash'], [{ type: 'close' }]);

    // A test harness (or any long-lived host) invoking gymCommand more than
    // once per process must free each session's handle, not just the last one.
    expect(disposeSpy).toHaveBeenCalledTimes(3);
  });

  it('never constructs a GeometryProcessor when the "clash" channel is not requested', async () => {
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');

    await runGym(['--seed', '42', '--checks', 'schema'], [{ type: 'close' }]);

    // getProcessor() is never called, so there is nothing to dispose — this
    // pins that the fix did not turn a lazy processor into an eager one.
    expect(disposeSpy).not.toHaveBeenCalled();
  });
});
