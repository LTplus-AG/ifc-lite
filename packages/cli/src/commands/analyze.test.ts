/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `analyzeCommand` accepted `--out` in its positional-argument exclusion
 * list (so the path wasn't mistaken for the input file) but never actually
 * wrote to it — results only ever went to stdout (`--json`) or a stderr
 * summary. A user running `ifc-lite analyze model.ifc --viewer 3456
 * --type IfcWall --out results.json` got no error and no file: a silent
 * no-op. These tests pin the fix (write match results as JSON to --out)
 * and the pre-existing stdout/`--json` behaviour it must not disturb.
 */

import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { analyzeCommand } from './analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');

describe('analyzeCommand --out', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    stdoutSpy?.mockRestore();
    stderrSpy?.mockRestore();
  });

  it('writes match results as JSON to --out instead of stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-analyze-'));
    const out = join(dir, 'results.json');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await analyzeCommand([SAMPLE_IFC, '--viewer', '3456', '--type', 'IfcWall', '--color', 'red', '--out', out]);

    // Regression guard for the original bug: the file must actually exist.
    await expect(access(out)).resolves.toBeUndefined();
    const written = JSON.parse(await readFile(out, 'utf-8'));
    expect(Array.isArray(written)).toBe(true);
    expect(written[0]).toMatchObject({ rule: 'IfcWall' });

    // --out must suppress the stdout JSON payload — it goes to the file, not both places.
    const stdoutCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(stdoutCalls.join('')).not.toContain('"rule"');
  });

  it('still prints JSON to stdout when --out is absent (baseline, unchanged by the fix)', async () => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await analyzeCommand([SAMPLE_IFC, '--viewer', '3456', '--type', 'IfcWall', '--color', 'red', '--json']);

    const stdoutCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stdoutCalls).toContain('"rule"');
  });
});

/**
 * `--isolate` only sent the `isolateEntities` viewer command when the rule
 * matched at least one entity (`rule.isolate && matchedIds.length > 0`).
 * `viewer-html.ts`'s `isolateEntities` handler fades every entity NOT named
 * in `ids`, so an empty `ids` array is how "isolate to nothing" is spelled
 * -- exactly what a zero-match rule should show. Gating on `matchedIds.length
 * > 0` skipped the command entirely instead, silently leaving whatever the
 * viewer had on screen before the rule ran. These tests pin: the command is
 * sent (with an empty `ids`) when the rule matches nothing, and is NOT sent
 * at all when `--isolate` is absent.
 */
describe('analyzeCommand --isolate on a zero-match rule', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: MockInstance<typeof fetch>;

  afterEach(() => {
    stderrSpy?.mockRestore();
    fetchSpy?.mockRestore();
  });

  it('still sends isolateEntities with an empty ids array when the rule matches nothing', async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    // IfcFurnishingElement does not occur in the sample model: the rule
    // matches zero entities, but --isolate is still requested.
    await analyzeCommand([SAMPLE_IFC, '--viewer', '3456', '--type', 'IfcFurnishingElement', '--isolate', '--json']);

    const isolateCalls = fetchSpy.mock.calls.filter(([, init]) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      return body.includes('"isolateEntities"');
    });
    expect(isolateCalls).toHaveLength(1);
    const body = JSON.parse(String(isolateCalls[0][1]?.body));
    expect(body).toEqual({ action: 'isolateEntities', ids: [] });
  });

  it('does not send isolateEntities at all when --isolate is absent', async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await analyzeCommand([SAMPLE_IFC, '--viewer', '3456', '--type', 'IfcFurnishingElement', '--json']);

    const isolateCalls = fetchSpy.mock.calls.filter(([, init]) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      return body.includes('"isolateEntities"');
    });
    expect(isolateCalls).toHaveLength(0);
  });
});
