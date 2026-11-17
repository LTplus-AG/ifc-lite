/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The small-file fast path changes when a small file is meshed, never what the
 * user gets. A spare worker makes the same `processAdaptive` call the loader
 * would make, so the scene must equal the normal pipeline's. Below 2 MiB that
 * is the single-session branch; from 2 MiB the worker pool with GPU instancing.
 * Each fixture is opened twice in fresh pages: with `?perf.fastPath=0`, and with
 * the fast path on after its spares are ready (a console line says so), and the
 * run was claimed. The comparison covers:
 * - per-element mesh bytes (flat meshes);
 * - the flat mesh count;
 * - instanced templates drawn and their GPU bytes;
 * - the instanced shards decoded;
 * - the data store's entity count.
 * A run that dropped instancing would differ in the flat count and the instanced bytes.
 *
 * Everything read back from the page is a count or a short string, never a mesh array.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const FIXTURES = [
  // Under 2 MiB: the single-session branch.
  'apps/viewer/public/samples/building-architecture.ifc',
  // 2.4 MiB: the worker pool, GPU instancing.
  'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc',
];
const LOAD_TIMEOUT_MS = 180_000;

interface LoadSummary {
  meshes: number;
  elements: [number, string][];
  instanced: { drawn: number | null; gpuBytes: number | null };
  /** Per instanced occurrence: entity id -> hashes of (transform, colour, template geometry), from the enqueued shards. */
  instances: [number, string][];
  shardsDecoded: number;
  entities: number | null;
}

/** CRC-32 (IEEE), for the STORED zip below. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A one-entry STORED (uncompressed) ZIP archive of `data` under `name`, written to a temp file named `outName`. */
function zipSample(name: string, data: Uint8Array, outName: string): string {
  const nameBytes = new TextEncoder().encode(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30); // local file header
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46); // central directory header
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  const centralOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22); // end of central directory
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(centralOffset, 16);
  const out = join(mkdtempSync(join(tmpdir(), 'fast-path-zip-')), outName);
  writeFileSync(out, Buffer.concat([local, nameBytes, data, central, nameBytes, end]));
  return out;
}

/**
 * A generated IFC between 2 and 10 MiB whose elements all reuse one mapped
 * representation (one box placed many times), so the worker pool meshes it with
 * GPU instancing. Modelled on rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc.
 */
function instancedIfc(occurrences: number): string {
  const head = [
    "ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    "FILE_NAME('instanced.ifc','2026-11-13T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;",
    "#1=IFCCARTESIANPOINT((0.,0.,0.));", "#2=IFCAXIS2PLACEMENT3D(#1,$,$);", "#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
    "#4=IFCUNITASSIGNMENT((#3));", "#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#2,$);",
    "#6=IFCCARTESIANPOINT((0.,0.));", "#7=IFCAXIS2PLACEMENT2D(#6,$);", "#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,0.9,2.1);",
    "#9=IFCDIRECTION((0.,0.,1.));", "#10=IFCCARTESIANPOINT((0.,0.,0.));", "#11=IFCAXIS2PLACEMENT3D(#10,$,$);",
    "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,0.05);", "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
    "#14=IFCCARTESIANPOINT((0.,0.,0.));", "#15=IFCAXIS2PLACEMENT3D(#14,$,$);", "#16=IFCREPRESENTATIONMAP(#15,#13);",
    "#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,$,$);", "#18=IFCLOCALPLACEMENT($,#2);",
    "#19=IFCSITE('0000000000000000000001',$,'Site',$,$,#18,$,$,.ELEMENT.,$,$,$,$,$);", "#20=IFCLOCALPLACEMENT(#18,#2);",
    "#21=IFCBUILDING('0000000000000000000002',$,'Building',$,$,#20,$,$,.ELEMENT.,$,$,$);", "#22=IFCLOCALPLACEMENT(#20,#2);",
    "#23=IFCBUILDINGSTOREY('0000000000000000000003',$,'Storey',$,$,#22,$,$,.ELEMENT.,0.);",
    "#24=IFCPROJECT('0000000000000000000004',$,'Proj',$,$,$,$,(#5),#4);",
  ];
  const lines = [...head];
  const proxies: number[] = [];
  const guid = (n: number) => `1${n.toString(36).padStart(21, '0')}`;
  let id = 25;
  for (let i = 0; i < occurrences; i++) {
    const x = (i % 100) * 1.5, y = Math.floor(i / 100) * 1.5;
    lines.push(`#${id}=IFCMAPPEDITEM(#16,#17);`, `#${id + 1}=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',(#${id}));`,
      `#${id + 2}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${id + 1}));`, `#${id + 3}=IFCCARTESIANPOINT((${x.toFixed(1)},${y.toFixed(1)},0.));`,
      `#${id + 4}=IFCAXIS2PLACEMENT3D(#${id + 3},$,$);`, `#${id + 5}=IFCLOCALPLACEMENT(#22,#${id + 4});`,
      `#${id + 6}=IFCDOOR('${guid(i)}',$,'Door_${i}',$,$,#${id + 5},#${id + 2},$,2.1,0.9,$,$,$);`);
    proxies.push(id + 6);
    id += 7;
  }
  lines.push(`#${id}=IFCRELAGGREGATES('0000000000000000000005',$,$,$,#24,(#19));`,
    `#${id + 1}=IFCRELAGGREGATES('0000000000000000000006',$,$,$,#19,(#21));`,
    `#${id + 2}=IFCRELAGGREGATES('0000000000000000000007',$,$,$,#21,(#23));`,
    `#${id + 3}=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000008',$,$,$,(${proxies.map((p) => `#${p}`).join(',')}),#23);`,
    'ENDSEC;', 'END-ISO-10303-21;');
  return lines.join('\n') + '\n';
}

async function openFixture(page: Page, fixture: string): Promise<void> {
  await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__ifc_lite_viewer_store__));
  const previous = await page.evaluate(() => (globalThis as Record<string, any>).__IFC_LITE_LOAD_TRACE__?.latest()?.loadId ?? null);
  await page.locator('#file-input-open').setInputFiles(fixture.startsWith('/') ? fixture : join(process.cwd(), fixture));
  await page.waitForFunction((previous) => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__?.latest();
    const state = g.__ifc_lite_viewer_store__.getState();
    // Flat meshes, or instanced elements only (the generated instanced file has no flat mesh).
    const geometry = (state.geometryResult?.meshes?.length ?? 0) + (state.geometryResult?.instancedGeometryHashes?.size ?? 0);
    return Boolean(load && load.loadId !== previous && load.end !== null && !state.loading && !state.geometryStreamingActive && geometry > 0);
  }, previous, { timeout: LOAD_TIMEOUT_MS, polling: 250 });
}

async function summary(page: Page): Promise<LoadSummary> {
  await page.waitForFunction(() => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__?.latest();
    const frame = g.__ifc_lite_render_frame__?.();
    return Boolean(load && load.end !== null && frame && frame.timestamp > load.end);
  }, null, { timeout: LOAD_TIMEOUT_MS, polling: 100 });
  return page.evaluate(() => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__.latest();
    const state = g.__ifc_lite_viewer_store__.getState();
    const meshes = state.geometryResult?.meshes ?? [];
    const fnv = (h: number, bytes: Uint8Array) => { for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; };
    const view = (a: ArrayBufferView | undefined) => (a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(0));
    const perElement = new Map<number, number[]>();
    for (const m of meshes) {
      let h = fnv(0x811c9dc5, view(new Float64Array(m.origin ?? [0, 0, 0])));
      h = fnv(h, view(m.positions)); h = fnv(h, view(m.normals)); h = fnv(h, view(m.indices)); h = fnv(h, view(new Float32Array(m.color)));
      (perElement.get(m.expressId) ?? perElement.set(m.expressId, []).get(m.expressId)!).push(h);
    }
    const stats = g.__ifc_lite_render_stats__?.();
    const model = state.models.get(state.activeModelId ?? '');
    return {
      meshes: meshes.length,
      elements: [...perElement].map(([id, hs]) => [id, hs.sort((a, b) => a - b).join('.')] as [number, string]),
      instanced: { drawn: stats?.frame?.instancedDrawn ?? null, gpuBytes: stats?.gpu?.instanced ?? null },
      instances: [...((g.__fastPathInstances as Map<number, number[]> | undefined) ?? new Map<number, number[]>())]
        .map(([id, hs]) => [id, hs.sort((x, y) => x - y).join('.')] as [number, string]),
      shardsDecoded: load.spans.filter((s: { name: string }) => s.name === 'instanced.decode').length,
      entities: model?.ifcDataStore?.entityCount ?? null,
    };
  });
}

/**
 * Records every instanced occurrence the load enqueues (the shards are not store state; the
 * queue's e2e hook hands out each enqueue's wire bytes). Reads the instance table of the IFNS
 * wire format (packed-instanced-decoder.ts): per occurrence the entity id, and a hash of its
 * transform and colour plus its template's origin, positions and indices.
 */
async function captureInstances(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__ifc_lite_instanced_shards__));
  await page.evaluate(() => {
    const g = globalThis as Record<string, any>;
    const perEntity = new Map<number, number[]>();
    g.__fastPathInstances = perEntity;
    const seen = new Set<ArrayBuffer>();
    const fnv = (h: number, bytes: Uint8Array) => { for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; };
    g.__ifc_lite_instanced_shards__.subscribe((event: { shards?: ReadonlyArray<{ bytes: ArrayBuffer }> }) => {
      for (const { bytes } of event.shards ?? []) {
        if (seen.has(bytes)) continue;
        seen.add(bytes);
        const view = new DataView(bytes);
        const u8 = new Uint8Array(bytes);
        // Header words: magic, version, templates, instances, positions/normals/indices lengths, stride (v2+).
        const version = view.getUint32(4, true), templates = view.getUint32(8, true), instances = view.getUint32(12, true);
        const positionsLen = view.getUint32(16, true), normalsLen = view.getUint32(20, true);
        const declared = version >= 2 ? view.getUint32(28, true) : 0;
        const stride = declared === 0 ? 88 : declared;
        const templateTable = 32;
        const instanceTable = templateTable + templates * 48;
        const data = instanceTable + instances * stride;
        const positions = data, indices = data + (positionsLen + normalsLen) * 4;
        const templateHash: number[] = [];
        for (let t = 0; t < templates; t++) {
          const b = templateTable + t * 48;
          const posOff = view.getUint32(b, true), posLen = view.getUint32(b + 4, true);
          const idxOff = view.getUint32(b + 16, true), idxLen = view.getUint32(b + 20, true);
          let h = fnv(0x811c9dc5, u8.subarray(b + 24, b + 48)); // origin (3 x f64)
          h = fnv(h, u8.subarray(positions + posOff * 4, positions + (posOff + posLen) * 4));
          templateHash.push(fnv(h, u8.subarray(indices + idxOff * 4, indices + (idxOff + idxLen) * 4)));
        }
        for (let i = 0; i < instances; i++) {
          const b = instanceTable + i * stride;
          const entityId = view.getUint32(b + 4, true);
          const h = fnv(templateHash[view.getUint32(b, true)] ?? 0, u8.subarray(b + 8, b + 88)); // colour + transform
          (perEntity.get(entityId) ?? perEntity.set(entityId, []).get(entityId)!).push(h);
        }
      }
    });
  });
}

function differingInstances(a: LoadSummary, b: LoadSummary): { count: number; first: number[] } {
  return differingElements({ ...a, elements: a.instances }, { ...b, elements: b.instances });
}

function differingElements(a: LoadSummary, b: LoadSummary): { count: number; first: number[] } {
  const other = new Map(b.elements);
  const mine = new Map(a.elements);
  const ids = new Set([...mine.keys(), ...other.keys()]);
  const differing = [...ids].filter((id) => mine.get(id) !== other.get(id));
  return { count: differing.length, first: differing.slice(0, 10) };
}

/** A fresh page; `fast` waits for the spares before the pick and records whether the run was claimed. */
async function load(context: BrowserContext, fixture: string, fast: boolean): Promise<{ summary: LoadSummary; claimed: boolean }> {
  const page = await context.newPage();
  let claimed = false;
  page.on('console', (msg) => { if (msg.text().startsWith('[fast-path] run claimed')) claimed = true; });
  const ready = fast ? page.waitForEvent('console', { predicate: (msg) => msg.text().startsWith('[fast-path] spares ready'), timeout: 60_000 }) : null;
  await page.goto(fast ? '/?perfTrace=1' : '/?perfTrace=1&perf.fastPath=0');
  await ready;
  await captureInstances(page);
  await openFixture(page, fixture);
  const result = await summary(page);
  await page.close();
  return { summary: result, claimed };
}

for (const FIXTURE of FIXTURES) test.describe(`small-file fast path: ${FIXTURE.split('/').pop()}`, () => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing`);

  test('meshing in the spare worker yields the same scene and data as the normal pipeline', async ({ context }) => {
    const off = await load(context, FIXTURE, false);
    const on = await load(context, FIXTURE, true);
    expect(off.claimed, 'with ?perf.fastPath=0 no run is claimed').toBe(false);
    expect(on.claimed, 'with the fast path on, the load used the spare worker\'s run').toBe(true);
    expect(off.summary.elements.length, 'elements compared').toBeGreaterThan(0);
    expect(on.summary.meshes, 'flat mesh count (instanced occurrences are not flat)').toBe(off.summary.meshes);
    expect(differingElements(off.summary, on.summary), 'per-element mesh bytes').toEqual({ count: 0, first: [] });
    expect(on.summary.instanced, 'instanced templates drawn and their GPU bytes').toEqual(off.summary.instanced);
    expect(on.summary.shardsDecoded, 'instanced shards decoded').toBe(off.summary.shardsDecoded);
    expect(differingInstances(off.summary, on.summary), 'per-occurrence instance transforms, colours and templates').toEqual({ count: 0, first: [] });
    expect(on.summary.entities, 'data store entities').toBe(off.summary.entities);
  });
});

test.describe('small-file fast path: a ZIP archive named .ifc', () => {
  const SAMPLE = 'apps/viewer/public/samples/building-architecture.ifc';
  test.skip(!existsSync(join(process.cwd(), SAMPLE)), `${SAMPLE} missing`);

  test('loads to the same scene as with the fast path off, and the spare\'s run is not used', async ({ context }) => {
    // Generated here from the committed sample (no binary fixture): STORED, one entry, named .ifc.
    const archive = zipSample(basename(SAMPLE), new Uint8Array(readFileSync(join(process.cwd(), SAMPLE))), 'zipped-sample.ifc');
    const off = await load(context, archive, false);
    const on = await load(context, archive, true);
    expect(off.claimed).toBe(false);
    expect(on.claimed, 'the claim is refused: the loader parses the unwrapped model, not the picked bytes').toBe(false);
    expect(off.summary.elements.length, 'elements compared').toBeGreaterThan(0);
    expect(on.summary.meshes).toBe(off.summary.meshes);
    expect(differingElements(off.summary, on.summary), 'per-element mesh bytes').toEqual({ count: 0, first: [] });
    expect(on.summary.entities).toBe(off.summary.entities);
  });
});

test.describe('small-file fast path: a generated instanced file between 2 and 10 MiB', () => {
  test('meshes through the worker pool with the same instancing as the normal pipeline', async ({ context }) => {
    const text = instancedIfc(7500);
    const bytes = Buffer.byteLength(text);
    expect(bytes, 'the generated file is in the pool range').toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(bytes).toBeLessThan(10 * 1024 * 1024);
    const path = join(mkdtempSync(join(tmpdir(), 'fast-path-instanced-')), 'instanced-doors.ifc');
    writeFileSync(path, text);
    const off = await load(context, path, false);
    const on = await load(context, path, true);
    expect(off.summary.instanced.gpuBytes ?? 0, 'the normal pipeline instances this file (else the comparison proves nothing)').toBeGreaterThan(0);
    expect(on.claimed).toBe(true);
    expect(on.summary.meshes, 'flat mesh count').toBe(off.summary.meshes);
    expect(on.summary.instanced, 'instanced templates drawn and their GPU bytes').toEqual(off.summary.instanced);
    expect(on.summary.shardsDecoded, 'instanced shards decoded').toBe(off.summary.shardsDecoded);
    // The file has no flat mesh: the per-element comparison is over the instanced occurrences.
    expect(off.summary.instances.length, 'every generated door is an instanced occurrence').toBe(7500);
    expect(on.summary.instances.length).toBe(7500);
    expect(differingInstances(off.summary, on.summary), 'per-occurrence instance transforms, colours and templates').toEqual({ count: 0, first: [] });
    expect(differingElements(off.summary, on.summary), 'per-element flat mesh bytes (none here)').toEqual({ count: 0, first: [] });
    expect(on.summary.entities).toBe(off.summary.entities);
  });
});
