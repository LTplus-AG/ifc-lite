/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, PassThrough } from 'node:stream';
import { gymCommand } from './gym.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// AB22.ifc is one of the two small committed `tests/models/` fixtures (~220KB,
// ~2900 entities, parses in single-digit ms), it never needs `pnpm fixtures`,
// unlike the much larger network-fetched corpus in the same directory.
const MODEL = join(__dirname, '../../../../tests/models/AB22.ifc');

/** IfcPavement #30 in AB22.ifc ("Pavement"): a stable target for property ops. */
const PAVEMENT_EXPRESS_ID = 30;

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
): Promise<Record<string, unknown>[]> {
  const input = new Readable({ read() {} });
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) lines.push(JSON.parse(line));
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

describe('gymCommand', () => {
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
    const reset = lines[0];
    expect(reset.type).toBe('reset');
    const observation = reset.observation as Record<string, unknown>;
    expect(observation.storeyCount).toBe(0); // AB22.ifc is an infra model, no storeys
    expect(observation.schema).toBe('IFC4X3');
    const entityCounts = observation.entityCounts as Record<string, number>;
    expect(entityCounts.IFCPAVEMENT).toBe(1);
    expect(entityCounts.IFCPROJECT).toBe(1);
    // Keys must be sorted for determinism.
    expect(Object.keys(entityCounts)).toEqual([...Object.keys(entityCounts)].sort());

    const channels = reset.channels as Record<string, unknown>;
    expect(channels.schema).toBeDefined();
    expect(channels.clash).toBeDefined();
    expect(channels.ids).toBeUndefined(); // not requested
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

    const reward = lines.find(l => l.type === 'reward');
    expect(reward).toBeDefined();
    expect(reward!.done).toBe(false);
    const channels = reward!.channels as Record<string, any>;
    expect(channels.schema).toBeDefined();
    expect(channels.clash).toBeDefined();
    expect(channels.ids).toBeDefined();

    // The op we applied should make the one IDS spec pass now.
    expect(channels.ids.score).toBe(1);
    expect(channels.ids.totalEntitiesPassed).toBe(1);
    expect(channels.ids.totalEntitiesFailed).toBe(0);

    expect(typeof channels.clash.score).toBe('number');
    expect(typeof channels.schema.score).toBe('number');
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

    const rewards = lines.filter(l => l.type === 'reward');
    expect(rewards).toHaveLength(2);
    expect((rewards[0].channels as any).ids.score).toBe(0);
    expect((rewards[1].channels as any).ids.score).toBe(1);
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

    const rewards1 = run1.filter(l => l.type === 'reward');
    const rewards2 = run2.filter(l => l.type === 'reward');
    expect(rewards1).toHaveLength(3);
    expect(rewards2).toHaveLength(3);
    for (let i = 0; i < rewards1.length; i++) {
      expect(JSON.stringify(rewards1[i])).toBe(JSON.stringify(rewards2[i]));
    }
  });

  it('reset mid-session restores the pristine model', async () => {
    const lines = await runGym(
      ['--model', MODEL, '--checks', 'schema'],
      [
        { type: 'step', ops: [{ op: 'setAttribute', expressId: PAVEMENT_EXPRESS_ID, attrName: 'Name', value: 'Renamed' }] },
        { type: 'reset' },
        { type: 'close' },
      ],
    );

    const resets = lines.filter(l => l.type === 'reset');
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

    const parsed = raw.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const errors = parsed.filter(l => l.type === 'error');
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
    const error = lines.find(l => l.type === 'error');
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/Unsupported op "addWall"/);
  });
});

describe('gymCommand episode factory (--seed, B2.2)', () => {
  // Seed 42 is a clean office model under the benchmark corrupt rate (0.3);
  // seed 8 force-corrupted plants duplicate-globalid + multiple-project
  // (both schema errors). All deterministic by construction.

  it('serves a generated episode from --seed, byte-identical across runs', async () => {
    const run1 = await runGym(['--seed', '42', '--checks', 'schema'], [{ type: 'close' }]);
    const run2 = await runGym(['--seed', '42', '--checks', 'schema'], [{ type: 'close' }]);

    const reset = run1[0];
    expect(reset.type).toBe('reset');
    expect(reset.episode).toEqual({ seed: 42, family: 'office', corrupted: false });
    const observation = reset.observation as Record<string, unknown>;
    expect(observation.storeyCount).toBe(1);
    const entityCounts = observation.entityCounts as Record<string, number>;
    expect(entityCounts.IFCPROJECT).toBe(1);
    expect(entityCounts.IFCSPACE).toBeGreaterThan(0);
    expect((reset.channels as any).schema.score).toBe(1);

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
    const resets = lines.filter(l => l.type === 'reset');
    expect(resets).toHaveLength(2);
    expect((resets[0].episode as any).seed).toBe(42);
    expect((resets[1].episode as any).seed).toBe(2);
    expect((resets[1].episode as any).family).toBe('frame');
    expect((resets[1].episode as any).corrupted).toBe(false);
    expect(JSON.stringify(resets[0].observation)).not.toBe(JSON.stringify(resets[1].observation));
  });

  it('a forced-corrupt episode surfaces planted schema defects in the reward channel', async () => {
    const lines = await runGym(['--seed', '8', '--corrupt', '--checks', 'schema'], [{ type: 'close' }]);
    const reset = lines[0];
    expect((reset.episode as any).corrupted).toBe(true);
    const schema = (reset.channels as any).schema;
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
    const reward = lines.find(l => l.type === 'reward');
    expect(reward).toBeDefined();
    expect((reward!.channels as any).schema.score).toBe(1);
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
    const error = lines.find(l => l.type === 'error');
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/non-negative integer/);
    // The plain reset afterwards still answers with the original episode.
    const resets = lines.filter(l => l.type === 'reset');
    expect(resets).toHaveLength(2);
    expect((resets[1].episode as any).seed).toBe(42);
  });
});
