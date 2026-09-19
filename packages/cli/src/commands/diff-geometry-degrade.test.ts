/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--geometry` degrades to `scope: 'data'` on a failing wasm pass, rather
 * than aborting the whole `--by-content` command (issue #4956 review).
 *
 * Split into its own file because it `vi.mock`s `@ifc-lite/wasm` module-wide
 * to fake a throw — `diff-geometry.test.ts`'s other tests need the real
 * runtime and would break under the same mock.
 *
 * The fake throw stands in for an internal wasm panic surfaced as a JS error.
 * A genuinely throwing STEP fixture could not be constructed: the real engine
 * is deliberately resilient to malformed per-element data (a dangling profile
 * reference, a truncated `DATA` section) and degrades that to a dropped
 * representation item rather than throwing — verified by hand against the
 * real wasm build before writing this test. `resolveGeometryScope`'s catch
 * has to hold regardless of WHY a pass throws, so faking the failure at the
 * module boundary tests the actual contract.
 *
 * Skips (never fails) when `packages/wasm/pkg/ifc-lite_bg.wasm` is not built
 * on this host — `loadWasmRuntime`'s OWN file resolution (`createRequire(...)
 * .resolve` + `readFile`) runs before the mocked import and needs the real
 * `.wasm` binary on disk even though this test never touches its contents.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { guid } from './diff-test-helpers.js';

const WASM_PATH = fileURLToPath(
  new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url),
);
const WASM_AVAILABLE = existsSync(WASM_PATH);

const wasmMockState = vi.hoisted(() => ({ freeCalls: 0 }));

vi.mock('@ifc-lite/wasm', () => {
  class FakeIfcAPI {
    setComputeGeometryHashes(): void {}
    free(): void {
      wasmMockState.freeCalls++;
    }
    buildPrePassOnce(): never {
      throw new Error('synthetic wasm panic (test)');
    }
  }
  return { initSync: (): void => {}, IfcAPI: FakeIfcAPI };
});

// Imported AFTER the mock declaration in source order, but `vi.mock` is
// hoisted above every import by vitest regardless.
const { contentDiffCommand } = await import('./diff-content.js');

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#70= IFCWALL('${guid('WALA')}',$,'Wall',$,$,#40,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

describe.runIf(WASM_AVAILABLE)('ifc-lite diff --by-content --geometry — wasm pass throws', () => {
  let dir: string;
  let basePath: string;
  let headPath: string;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(async () => {
    wasmMockState.freeCalls = 0;
    dir = await mkdtemp(join(tmpdir(), 'ifclite-geometry-throw-'));
    basePath = join(dir, 'v1.ifc');
    headPath = join(dir, 'v2.ifc');
    await writeFile(basePath, MODEL, 'utf-8');
    await writeFile(headPath, MODEL, 'utf-8');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('degrades to scope: data with a warning, instead of aborting the command', async () => {
    await contentDiffCommand({ basePath, headPath, geometry: true, json: true });

    const result = JSON.parse(stdoutSpy.mock.calls.map((c) => String(c[0])).join(''));
    expect(result.scope).toBe('data');
    // The comparison still ran to completion on data alone: project, storey
    // and wall all share a GlobalId across both (identical) files, so they
    // come back unchanged rather than the command having thrown/exited
    // before producing any output.
    expect(result.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 3 });

    const warnings = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(warnings).toContain('--geometry failed');
    expect(warnings).toContain('synthetic wasm panic');

    // The IfcAPI handle is still freed on the failing path (AGENTS.md
    // "Geometry & WASM") — `finally` ran even though the try body threw.
    expect(wasmMockState.freeCalls).toBe(1);
  }, 30_000);
});
