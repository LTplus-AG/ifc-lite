/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite anonymize` (#2934, the "anonymized isolated export" CLI) — thin
 * wiring over `@ifc-lite/export`'s `collectRelatedEntities`/
 * `exportAnonymizedSubset`, already exhaustively covered by that package's
 * own test suite. This file covers what is CLI-specific: selector resolution
 * (`--id`/`--guid`/`--type`/`--storey`, unioned, fail loudly on zero
 * matches), the flag -> `RelatedEntityOptions`/`AnonymizeOptions` wiring, the
 * `--guid-map` sidecar file, and `--json` output — plus one wasm-gated
 * triangle-count check that the geometry survives the round trip.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { anonymizeCommand } from './anonymize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample with real render geometry — used only by the
// wasm-gated triangle-count check below, so this suite never needs `pnpm
// fixtures` for its selector/flag coverage.
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');
// The sample's one wall — see `apps/viewer/public/samples/hello-wall.ifc`
// `#1222=IFCWALL(...)`.
const SAMPLE_WALL_EXPRESS_ID = 1222;

/** 22-char synthetic GlobalId, deterministic and unique per `n`. */
const guid = (n: number): string => `ANON${String(n).padStart(18, '0')}`;

/**
 * A small but relationally rich fixture: project -> site -> building -> two
 * storeys; Wall A (storey 1) with an opening + window, an `IfcWallType`, a
 * material association, and an occurrence-level `Pset_WallCommon`; Column C
 * (storey 2), structurally connected to Wall A; an `IfcElementAssembly`
 * aggregating a plate. Every entity's own name/type is deliberately distinct
 * from every OTHER entity's TYPE keyword (e.g. "Column C" is an
 * `IFCCOLUMN`, not an `IFCWALL`) so a `--type IfcWall` selector matches only
 * Wall A, keeping each flag test's expansion unambiguous.
 */
const FIXTURE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('anonymize-cli-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#2=IFCSITE('${guid(2)}',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('${guid(3)}',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('${guid(4)}',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#5=IFCBUILDINGSTOREY('${guid(5)}',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.);
#10=IFCWALL('${guid(10)}',$,'Wall A',$,$,$,$,'TAG-A');
#17=IFCCOLUMN('${guid(17)}',$,'Column C',$,$,$,$,'TAG-C');
#11=IFCOPENINGELEMENT('${guid(11)}',$,'Opening',$,$,$,$,$);
#12=IFCWINDOW('${guid(12)}',$,'Window',$,$,$,$,'TAG-W',1.,1.);
#13=IFCWALLTYPE('${guid(13)}',$,'WallType',$,$,$,$,$,$,.NOTDEFINED.);
#16=IFCMATERIAL('Concrete');
#40=IFCPROPERTYSET('${guid(40)}',$,'Pset_WallCommon',$,(#41));
#41=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#60=IFCELEMENTASSEMBLY('${guid(60)}',$,'Assembly',$,$,$,$,$,$,.RIGID.);
#61=IFCPLATE('${guid(61)}',$,'Plate',$,$,$,$,$,$);
#20=IFCRELVOIDSELEMENT('${guid(20)}',$,$,$,#10,#11);
#21=IFCRELFILLSELEMENT('${guid(21)}',$,$,$,#11,#12);
#22=IFCRELDEFINESBYTYPE('${guid(22)}',$,$,$,(#10),#13);
#23=IFCRELASSOCIATESMATERIAL('${guid(23)}',$,$,$,(#10),#16);
#30=IFCRELAGGREGATES('${guid(30)}',$,$,$,#1,(#2));
#31=IFCRELAGGREGATES('${guid(31)}',$,$,$,#2,(#3));
#32=IFCRELAGGREGATES('${guid(32)}',$,$,$,#3,(#4,#5));
#33=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(33)}',$,$,$,(#10),#4);
#34=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(34)}',$,$,$,(#17),#5);
#42=IFCRELDEFINESBYPROPERTIES('${guid(42)}',$,$,$,(#10),#40);
#50=IFCRELCONNECTSPATHELEMENTS('${guid(50)}',$,$,$,$,#10,#17,(),(),.ATSTART.,.ATEND.);
#62=IFCRELAGGREGATES('${guid(62)}',$,$,$,#60,(#61));
ENDSEC;
END-ISO-10303-21;
`;

/** Every `#N` referenced with no `#N=` defining line — same helper as the
 *  `@ifc-lite/export` anonymize test files. */
function findDanglingRefs(content: string): number[] {
  const defined = new Set<number>();
  for (const m of content.matchAll(/(^|\n)#(\d+)=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const id = +m[1];
    if (!defined.has(id)) dangling.add(id);
  }
  return [...dangling].sort((a, b) => a - b);
}

/** Parse an exported STEP file's text back into a store so a test can assert
 *  on entity TYPES via `entityIndex.byType`, not text matching — `'IFCWALL'`
 *  is a substring of `'IFCWALLTYPE'`/`'IFCWALLSTANDARDCASE'`, so
 *  `content.toContain('IFCWALL')` gives a false positive/negative the moment
 *  a `*TYPE`/`*STANDARDCASE` sibling is anywhere in the file. */
async function parseOutput(content: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(content).buffer as ArrayBuffer);
}

/** Whether at least one entity of the exact EXPRESS type keyword (e.g.
 *  `'IFCWALL'`) survived in a parsed output store. */
function hasType(store: IfcDataStore, type: string): boolean {
  return (store.entityIndex.byType.get(type)?.length ?? 0) > 0;
}

class ProcessExited extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Run `anonymizeCommand`, capturing stderr/stdout and turning `fatal()`'s
 *  `process.exit` into a catchable throw — same pattern as
 *  `export.whole-model-filters.test.ts`. */
async function run(args: string[]): Promise<{ stderr: string; stdout: string; exited: boolean }> {
  let stderr = '';
  let stdout = '';
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExited(code);
  }) as never);
  try {
    await anonymizeCommand(args);
    return { stderr, stdout, exited: false };
  } catch (err) {
    if (err instanceof ProcessExited) return { stderr, stdout, exited: true };
    throw err;
  } finally {
    errSpy.mockRestore();
    outSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe('anonymize — selector resolution', () => {
  it('--type selects the type + its host/opening/type/material/spatial context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited } = await run([src, '--type', 'IfcWindow', '--out', out]);
    expect(exited).toBe(false);

    const content = await readFile(out, 'utf-8');
    const store = await parseOutput(content);
    expect(hasType(store, 'IFCWALL')).toBe(true);
    expect(hasType(store, 'IFCOPENINGELEMENT')).toBe(true);
    expect(hasType(store, 'IFCWINDOW')).toBe(true);
    expect(hasType(store, 'IFCPROJECT')).toBe(true);
    // Nothing structurally connects Column C to a window seed at depth 0.
    expect(hasType(store, 'IFCCOLUMN')).toBe(false);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--id selects the same subset as the equivalent --type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited } = await run([src, '--id', '10', '--out', out]);
    expect(exited).toBe(false);
    const content = await readFile(out, 'utf-8');
    const store = await parseOutput(content);
    expect(hasType(store, 'IFCWALLTYPE')).toBe(true);
    expect(hasType(store, 'IFCMATERIAL')).toBe(true); // the material association itself is kept
    // The material's own Name is pseudonymized by default (pseudonymizeAllNames) —
    // see the dedicated '--keep-other-names' test below for the opt-out.
    expect(content).not.toContain('Concrete');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--guid resolves a GlobalId to the same entity as --id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited } = await run([src, '--guid', guid(10), '--out', out]);
    expect(exited).toBe(false);
    const content = await readFile(out, 'utf-8');
    expect(hasType(await parseOutput(content), 'IFCWALLTYPE')).toBe(true);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--storey selects only entities contained in that storey', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited } = await run([src, '--storey', 'Level 1', '--out', out]);
    expect(exited).toBe(false);
    const content = await readFile(out, 'utf-8');
    const store = await parseOutput(content);
    expect(hasType(store, 'IFCWALL')).toBe(true);
    // Column C lives on Level 2 and is not structurally connected at depth 0.
    expect(hasType(store, 'IFCCOLUMN')).toBe(false);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('selectors are unioned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited } = await run([src, '--type', 'IfcWall', '--id', '17', '--out', out]);
    expect(exited).toBe(false);
    const content = await readFile(out, 'utf-8');
    const store = await parseOutput(content);
    expect(hasType(store, 'IFCWALL')).toBe(true);
    expect(hasType(store, 'IFCCOLUMN')).toBe(true);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('fails loudly when --type matches nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited, stderr } = await run([src, '--type', 'IfcSlab', '--out', join(dir, 'out.ifc')]);
    expect(exited).toBe(true);
    expect(stderr).toContain('no entities matched');
  });

  it('fails loudly when --guid matches nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited, stderr } = await run([src, '--guid', 'NOTAREALGUID00000000X', '--out', join(dir, 'out.ifc')]);
    expect(exited).toBe(true);
    expect(stderr).toContain('GlobalId not found');
  });

  it('fails loudly when no selector is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited, stderr } = await run([src, '--out', join(dir, 'out.ifc')]);
    expect(exited).toBe(true);
    expect(stderr).toContain('No entities selected');
  });

  it('fails loudly when --out is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited, stderr } = await run([src, '--type', 'IfcWall']);
    expect(exited).toBe(true);
    expect(stderr).toContain('--out is required');
  });
});

describe('anonymize — relationship expansion flags', () => {
  it('--no-rel-fills-element keeps the opening but drops the filler window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const outDefault = join(dir, 'default.ifc');
    await run([src, '--type', 'IfcWall', '--out', outDefault]);
    const defaultContent = await readFile(outDefault, 'utf-8');
    expect(hasType(await parseOutput(defaultContent), 'IFCWINDOW')).toBe(true);

    const outNoOpenings = join(dir, 'no-openings.ifc');
    const { exited } = await run([src, '--type', 'IfcWall', '--no-rel-fills-element', '--out', outNoOpenings]);
    expect(exited).toBe(false);
    const content = await readFile(outNoOpenings, 'utf-8');
    const store = await parseOutput(content);
    expect(hasType(store, 'IFCOPENINGELEMENT')).toBe(true);
    expect(hasType(store, 'IFCWINDOW')).toBe(false);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--no-rel-voids-element reaches the opening from a window seed but not its host wall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited } = await run([src, '--id', '12', '--no-rel-voids-element', '--out', out]);
    expect(exited).toBe(false);
    const content = await readFile(out, 'utf-8');
    const store = await parseOutput(content);
    expect(hasType(store, 'IFCWINDOW')).toBe(true);
    expect(hasType(store, 'IFCOPENINGELEMENT')).toBe(true);
    expect(hasType(store, 'IFCWALL')).toBe(false);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--no-rel-defines-by-type drops the IfcTypeObject', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited } = await run([src, '--type', 'IfcWall', '--no-rel-defines-by-type', '--out', out]);
    expect(exited).toBe(false);
    const content = await readFile(out, 'utf-8');
    expect(hasType(await parseOutput(content), 'IFCWALLTYPE')).toBe(false);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--no-rel-associates-material drops the IfcRelAssociatesMaterial relationship', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited } = await run([src, '--type', 'IfcWall', '--no-rel-associates-material', '--out', out]);
    expect(exited).toBe(false);
    const content = await readFile(out, 'utf-8');
    // Assert the actual contract — the relationship entity is gone — rather
    // than `not.toContain('Concrete')`: the default scrub already
    // pseudonymizes material names (see `--id selects...` above), so that
    // assertion would pass even with `IfcRelAssociatesMaterial` still present.
    expect(hasType(await parseOutput(content), 'IFCRELASSOCIATESMATERIAL')).toBe(false);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--no-rel-aggregates drops an IfcElementAssembly\'s children', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const outDefault = join(dir, 'default.ifc');
    await run([src, '--id', '60', '--out', outDefault]);
    expect(hasType(await parseOutput(await readFile(outDefault, 'utf-8')), 'IFCPLATE')).toBe(true);

    const outNoAgg = join(dir, 'no-agg.ifc');
    const { exited } = await run([src, '--id', '60', '--no-rel-aggregates', '--out', outNoAgg]);
    expect(exited).toBe(false);
    const content = await readFile(outNoAgg, 'utf-8');
    expect(hasType(await parseOutput(content), 'IFCPLATE')).toBe(false);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--connect-depth reaches a structurally connected neighbour; the default (0) does not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const outDefault = join(dir, 'default.ifc');
    await run([src, '--type', 'IfcWall', '--out', outDefault]);
    expect(hasType(await parseOutput(await readFile(outDefault, 'utf-8')), 'IFCCOLUMN')).toBe(false);

    const outDepth1 = join(dir, 'depth1.ifc');
    const { exited } = await run([src, '--type', 'IfcWall', '--connect-depth', '1', '--out', outDepth1]);
    expect(exited).toBe(false);
    const content = await readFile(outDepth1, 'utf-8');
    expect(hasType(await parseOutput(content), 'IFCCOLUMN')).toBe(true);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--keep-psets pulls in the occurrence-level property set; the default drops it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const outDefault = join(dir, 'default.ifc');
    await run([src, '--type', 'IfcWall', '--out', outDefault]);
    expect(hasType(await parseOutput(await readFile(outDefault, 'utf-8')), 'IFCPROPERTYSET')).toBe(false);

    const outKeep = join(dir, 'keep.ifc');
    const { exited } = await run([src, '--type', 'IfcWall', '--keep-psets', '--out', outKeep]);
    expect(exited).toBe(false);
    const content = await readFile(outKeep, 'utf-8');
    expect(hasType(await parseOutput(content), 'IFCPROPERTYSET')).toBe(true);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('--keep-other-names keeps the material Name; the default pseudonymizes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const outDefault = join(dir, 'default.ifc');
    await run([src, '--id', '10', '--out', outDefault]);
    expect(await readFile(outDefault, 'utf-8')).not.toContain('Concrete');

    const outKeep = join(dir, 'keep.ifc');
    const { exited } = await run([src, '--id', '10', '--keep-other-names', '--out', outKeep]);
    expect(exited).toBe(false);
    const content = await readFile(outKeep, 'utf-8');
    expect(content).toContain('Concrete');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});

describe('anonymize — GUID map and JSON output', () => {
  it('writes a GUID map with the original GlobalIds as keys, distinct new GlobalIds as values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    const map = join(dir, 'map.json');
    await writeFile(src, FIXTURE_MODEL);

    const { exited } = await run([src, '--type', 'IfcWall', '--out', out, '--guid-map', map]);
    expect(exited).toBe(false);

    const parsed = JSON.parse(await readFile(map, 'utf-8')) as Record<string, string>;
    expect(parsed[guid(10)]).toBeDefined();
    expect(parsed[guid(10)]).not.toBe(guid(10));
    expect(parsed[guid(10)]).toHaveLength(22);
    // The export carries the NEW GlobalId (map value); the ORIGINAL (map key)
    // — the identifying signal this feature exists to remove — is gone.
    const content = await readFile(out, 'utf-8');
    expect(content).toContain(parsed[guid(10)]);
    expect(content).not.toContain(guid(10));
  });

  it('--json prints a machine-readable summary to stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const src = join(dir, 'model.ifc');
    const out = join(dir, 'out.ifc');
    await writeFile(src, FIXTURE_MODEL);

    const { exited, stdout } = await run([src, '--type', 'IfcWindow', '--out', out, '--json']);
    expect(exited).toBe(false);
    const parsed = JSON.parse(stdout) as { seedCount: number; includedCount: number; entityCount: number; out: string };
    expect(parsed.seedCount).toBe(1);
    expect(parsed.includedCount).toBeGreaterThan(1);
    expect(parsed.entityCount).toBeGreaterThan(0);
    expect(parsed.out).toBe(out);
  });
});

describe('anonymize — geometry (wasm-gated)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the selected wall\'s triangle count across anonymization', async () => {
    // Skip cleanly (never fail) when the wasm package/runtime this repo's
    // other wasm-backed CLI tests assume (`build:wasm`/`build:wasm:fetch`) is
    // unavailable — same intent as `pnpm test:wasm-contract`'s "skip clean
    // (exit 0) if the wasm runtime isn't built" (AGENTS.md), applied at the
    // single-test level since this suite otherwise needs no wasm at all.
    let geometry: typeof import('@ifc-lite/geometry');
    try {
      geometry = await import('@ifc-lite/geometry');
    } catch {
      console.warn('anonymize triangle-count check: @ifc-lite/geometry is not installed, skipping.');
      return;
    }

    const countWallTriangles = async (bytes: Uint8Array): Promise<number | undefined> => {
      const gp = new geometry.GeometryProcessor();
      try {
        await gp.init();
      } catch {
        console.warn('anonymize triangle-count check: wasm runtime not built (run scripts/build-wasm.sh), skipping.');
        return undefined;
      }
      try {
        const res = await gp.process(bytes);
        let tris = 0;
        for (const m of res.meshes) {
          if (m.expressId === SAMPLE_WALL_EXPRESS_ID) tris += m.indices.length / 3;
        }
        return tris;
      } finally {
        gp.dispose();
      }
    };

    const srcBuf = await readFile(SAMPLE_IFC);
    const before = await countWallTriangles(new Uint8Array(srcBuf.buffer, srcBuf.byteOffset, srcBuf.byteLength));
    if (before === undefined) return; // wasm runtime unavailable — already warned above

    const dir = await mkdtemp(join(tmpdir(), 'ifc-anonymize-'));
    const out = join(dir, 'anon.ifc');
    await anonymizeCommand([SAMPLE_IFC, '--type', 'IfcWall', '--out', out]);

    const outBuf = await readFile(out);
    const after = await countWallTriangles(new Uint8Array(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength));

    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  }, 30_000);
});
