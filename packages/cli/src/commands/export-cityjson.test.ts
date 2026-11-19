/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite export --format cityjson|cityjsonseq` end to end through the REAL
 * wasm boundary, every document validated against the official CityJSON
 * 2.0.2 JSON schemas (vendored in `__fixtures__/cityjson-2.0.2`, CC0).
 * The mapping, LoD geometry and control-point arithmetic are pinned by the
 * Rust tests (`rust/export/src/cityjson_tests.rs`); this pins that the CLI
 * writes what a CityJSON reader accepts.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Ajv, type ValidateFunction } from 'ajv';
import { exportCommand } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '../../../../apps/viewer/public/samples');
// buildingSMART sample house: IfcMapConversion to EPSG:32760.
const GEOREFERENCED = join(SAMPLES, 'building-architecture.ifc');
// One wall, no map conversion.
const LOCAL = join(SAMPLES, 'hello-wall.ifc');
// Several IfcBuildings under one site.
const MULTI = join(SAMPLES, 'infra-bridge.ifc');

function schema(name: string): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  return ajv.compile(JSON.parse(readFileSync(join(__dirname, '__fixtures__/cityjson-2.0.2', name), 'utf-8')) as object);
}
const validCityJson = schema('cityjson.min.schema.json');
const validFeature = schema('cityjsonfeature.min.schema.json');

function expectValid(validate: ValidateFunction, doc: unknown): void {
  const ok = validate(doc);
  expect(ok, JSON.stringify(validate.errors?.slice(0, 5), null, 2)).toBe(true);
}

type CityObject = { type: string; parents?: string[]; children?: string[]; geometry?: { type: string; lod: string }[]; attributes?: Record<string, unknown> };
type CityJsonDoc = { metadata: { referenceSystem?: string }; CityObjects: Record<string, CityObject>; vertices: number[][] };

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-cli-cityjson-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function run(input: string, format: string, extra: string[] = []): Promise<{ text: string; stderr: string }> {
  const out = join(tmp, `${format}-${Math.random().toString(36).slice(2)}.json`);
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await exportCommand([input, '--format', format, '--out', out, ...extra]);
  } finally {
    spy.mockRestore();
  }
  return { text: await readFile(out, 'utf-8'), stderr: writes.join('') };
}

describe('export --format cityjson', () => {
  it('writes a schema-valid georeferenced building model in EPSG:32760', { timeout: 30_000 }, async () => {
    const { text, stderr } = await run(GEOREFERENCED, 'cityjson');
    const doc = JSON.parse(text) as CityJsonDoc;
    expectValid(validCityJson, doc);
    expect(doc.metadata.referenceSystem).toBe('https://www.opengis.net/def/crs/EPSG/0/32760');
    const buildings = Object.values(doc.CityObjects).filter((o) => o.type === 'Building');
    expect(buildings).toHaveLength(1);
    expect(buildings[0].geometry?.map((g) => `${g.type}@${g.lod}`)).toEqual(['MultiSurface@0', 'Solid@1']);
    expect(buildings[0].attributes?.ifcClass).toBe('IfcBuilding');
    expect(Object.values(doc.CityObjects).some((o) => o.type === 'BuildingStorey')).toBe(true);
    expect(Object.values(doc.CityObjects).some((o) => o.type === 'BuildingConstructiveElement' && o.geometry?.[0]?.lod === '3')).toBe(true);
    expect(stderr).toContain('EPSG/0/32760');
  });

  it('writes local coordinates with a warning and no reference system when the model is not georeferenced', async () => {
    const { text, stderr } = await run(LOCAL, 'cityjson');
    const doc = JSON.parse(text) as CityJsonDoc;
    expectValid(validCityJson, doc);
    expect(doc.metadata.referenceSystem).toBeUndefined();
    expect(stderr).toMatch(/Warning: not georeferenced/);
  });

  it('--blocks-only keeps the hierarchy but writes geometry only on buildings', async () => {
    const { text } = await run(GEOREFERENCED, 'cityjson', ['--blocks-only', '--scale', '0.01']);
    const doc = JSON.parse(text) as CityJsonDoc & { transform: { scale: number[] } };
    expectValid(validCityJson, doc);
    expect(doc.transform.scale).toEqual([0.01, 0.01, 0.01]);
    for (const o of Object.values(doc.CityObjects)) {
      if (o.type !== 'Building' && o.type !== 'BuildingPart') expect(o.geometry).toBeUndefined();
    }
  });

  it('rejects an invalid --scale before exporting', async () => {
    await expect(exportCommand([LOCAL, '--format', 'cityjson', '--scale', '0'])).rejects.toThrow();
  });

  it('rejects --scale without a value instead of exporting at the default grid', async () => {
    const out = join(tmp, 'missing-scale.city.json');
    await expect(exportCommand([LOCAL, '--format', 'cityjson', '--out', out, '--scale'])).rejects.toThrow();
    await expect(readFile(out, 'utf-8')).rejects.toThrow();
  });
});

describe('export --format cityjsonseq', () => {
  // --blocks-only: ajv takes seconds per feature over the bridge's dense LoD3
  // triangle surfaces (the export itself is ~50 ms); LoD3 MultiSurfaces are
  // schema-validated by the document test above.
  it('writes a schema-valid header and one schema-valid feature per building', { timeout: 30_000 }, async () => {
    const { text } = await run(MULTI, 'cityjsonseq', ['--blocks-only']);
    const [header, ...features] = text.trimEnd().split('\n').map((line) => JSON.parse(line) as { type: string; id?: string; CityObjects: Record<string, CityObject> });
    expectValid(validCityJson, header);
    expect(header.type).toBe('CityJSON');
    expect(Object.keys(header.CityObjects)).toHaveLength(0);
    expect(features.length).toBeGreaterThan(1);
    for (const f of features) {
      expectValid(validFeature, f);
      expect(f.CityObjects[f.id!]?.type).toBe('Building');
    }
  });
});
