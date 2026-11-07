/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `info` and `diff` on `oci://` references print the same JSON as on the
 * local files they were pushed from; only the field naming the input differs.
 * A CI workflow compares exactly these outputs, so this is the contract.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { infoCommand } from './info.js';
import { diffCommand } from './diff.js';
import { startTestRegistry, type TestRegistry } from '../oci-test-helpers.js';

const SAMPLES = resolve(__dirname, '../../../../apps/viewer/public/samples');
const BASE = resolve(SAMPLES, 'building-architecture.ifc');
const HEAD = resolve(SAMPLES, 'building-architecture-rev-b.ifc');

let registry: TestRegistry;
let v1: string;
let v2: string;
let stdout = '';

beforeAll(async () => {
  registry = await startTestRegistry({ username: 'ci-bot', password: 'secret' });
  registry.push('fixtures/model', 'v1', [
    { bytes: await readFile(BASE), mediaType: 'application/x-step', title: 'building-architecture.ifc' },
  ]);
  registry.push('fixtures/model', 'v2', [
    { bytes: await readFile(HEAD), mediaType: 'application/x-step', title: 'building-architecture-rev-b.ifc' },
  ]);
  v1 = `oci://${registry.host}/fixtures/model:v1`;
  v2 = `oci://${registry.host}/fixtures/model:v2`;
});

afterAll(() => registry.close());

beforeEach(() => {
  process.env.IFC_LITE_OCI_USERNAME = 'ci-bot';
  process.env.IFC_LITE_OCI_PASSWORD = 'secret';
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.IFC_LITE_OCI_USERNAME;
  delete process.env.IFC_LITE_OCI_PASSWORD;
});

async function json(run: () => Promise<void>): Promise<Record<string, unknown>> {
  stdout = '';
  await run();
  return JSON.parse(stdout) as Record<string, unknown>;
}

/** Drops the named dotted paths from a JSON object, returning what they held. */
function without(value: Record<string, unknown>, paths: string[]): { rest: Record<string, unknown>; taken: unknown[] } {
  const rest = structuredClone(value);
  const taken = paths.map((path) => {
    const keys = path.split('.');
    const last = keys.pop() as string;
    const parent = keys.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, rest);
    const held = parent[last];
    delete parent[last];
    return held;
  });
  return { rest, taken };
}

describe('oci:// model references in commands', () => {
  it('info --json matches the local file except .file and .parseTime', async () => {
    const local = without(await json(() => infoCommand(['--json', BASE])), ['file', 'parseTime']);
    const pulled = without(await json(() => infoCommand(['--json', v1])), ['file', 'parseTime']);

    expect(pulled.rest).toEqual(local.rest);
    expect(local.taken[0]).toBe(BASE);
    expect(pulled.taken[0]).toBe(v1);
    expect((pulled.rest.entityCount as number)).toBeGreaterThan(0);
  });

  it('diff --json matches the local diff except the two input paths', async () => {
    const local = without(await json(() => diffCommand(['--json', BASE, HEAD])), ['file1.path', 'file2.path']);
    const pulled = without(await json(() => diffCommand(['--json', v1, v2])), ['file1.path', 'file2.path']);

    expect(pulled.rest).toEqual(local.rest);
    expect(pulled.taken).toEqual([v1, v2]);
    // The revisions really differ, and differing models are not a failure.
    expect(pulled.rest.entityCountDelta).not.toBe(0);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('diff --by-content --json matches the local content diff except the two input paths', async () => {
    const local = await json(() => diffCommand(['--by-content', '--json', BASE, HEAD]));
    const pulled = await json(() => diffCommand(['--by-content', '--json', v1, v2]));
    const paths = ['base.path', 'head.path'];

    expect(without(local, paths).taken).toEqual([BASE, HEAD]);
    expect(without(pulled, paths).rest).toEqual(without(local, paths).rest);
    expect(without(pulled, paths).taken).toEqual([v1, v2]);
    expect(process.exit).not.toHaveBeenCalled();
  });
});
