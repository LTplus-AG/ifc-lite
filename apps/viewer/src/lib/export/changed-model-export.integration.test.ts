/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end verification of the #1534 fix through the REAL exporters: two
 * separately-edited models must yield two files, each carrying its own change,
 * and the multi-model case must bundle into one zip that round-trips back to
 * both files. Drives the shipped `defaultBuildArtifactsDeps` (real StepExporter
 * + real MutablePropertyView), not fakes — only the store-hydration dep is
 * stubbed so no live viewer store is needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel, SchemaVersion } from '@/store/types';
import { buildChangedArtifacts, type ChangesExportState, type ArtifactFile } from './model-changes.js';
import { defaultBuildArtifactsDeps } from './changed-model-export.js';

type Entry = [number, string, string];

/** Minimal real IfcDataStore from STEP lines (mirrors the export package tests). */
function buildDataStore(entries: Entry[]): IfcDataStore {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
  const byType = new Map<string, number[]>();
  let offset = 0;
  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    byId.set(id, { expressId: id, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(id);
    parts.push(encoded);
    offset += encoded.byteLength;
  }
  const source = new Uint8Array(offset);
  let pos = 0;
  for (const p of parts) {
    source.set(p, pos);
    pos += p.byteLength;
  }
  return {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source,
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
}

function mkModel(id: string, name: string, ifcDataStore: IfcDataStore): FederatedModel {
  return {
    id,
    name,
    schemaVersion: 'IFC4' as SchemaVersion,
    ifcDataStore,
    geometryResult: null,
    idOffset: 0,
  } as unknown as FederatedModel;
}

function decode(content: string | Uint8Array): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

/** Two models, each an IfcWall whose Name we edit to a distinct value. */
function twoEditedModels(): { state: ChangesExportState; resolve: (id: string) => Promise<IfcDataStore | null> } {
  const storeA = buildDataStore([[1, 'IFCWALL', "#1=IFCWALL('gidA',$,'Wall A',$,$,$,$,$);"]]);
  const storeB = buildDataStore([[1, 'IFCWALL', "#1=IFCWALL('gidB',$,'Wall B',$,$,$,$,$);"]]);

  const viewA = new MutablePropertyView(null, 'a');
  viewA.setAttribute(1, 'Name', 'ALPHA-EDITED');
  const viewB = new MutablePropertyView(null, 'b');
  viewB.setAttribute(1, 'Name', 'BETA-EDITED');

  const stores = new Map<string, IfcDataStore>([['a', storeA], ['b', storeB]]);
  const state: ChangesExportState = {
    models: new Map<string, FederatedModel>([
      ['a', mkModel('a', 'alpha.ifc', storeA)],
      ['b', mkModel('b', 'beta.ifc', storeB)],
    ]),
    ifcDataStore: null,
    geometryResult: null,
    mutationViews: new Map([['a', viewA], ['b', viewB]]),
    georefMutations: new Map(),
    scheduleData: null,
    scheduleIsEdited: false,
    scheduleSourceModelId: null,
  };
  return { state, resolve: async (id) => stores.get(id) ?? null };
}

function zipFiles(files: ArtifactFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[`${f.base}.${f.ext}`] = typeof f.content === 'string' ? strToU8(f.content) : f.content;
  return zipSync(entries);
}

describe('changed-model export (real exporters, #1534)', () => {
  it('produces one STEP file per edited model, each carrying its own edit', async () => {
    const { state, resolve } = twoEditedModels();
    const deps = { ...defaultBuildArtifactsDeps, resolveStepDataStore: resolve };

    const { files, skipped } = await buildChangedArtifacts(state, deps);

    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(files.length, 2, 'both edited models must export (issue #1534)');

    const byId = new Map(files.map((f) => [f.modelId, decode(f.content)]));
    const a = byId.get('a')!;
    const b = byId.get('b')!;

    // Each file is a real STEP file carrying ONLY its own edit.
    assert.ok(a.includes('END-ISO-10303-21;'), 'model a is a complete STEP file');
    assert.ok(a.includes('ALPHA-EDITED'), 'model a carries its edited Name');
    assert.ok(!a.includes('BETA-EDITED'), 'model a is not contaminated by model b');
    assert.ok(b.includes('BETA-EDITED'), 'model b carries its edited Name');
    assert.ok(!b.includes('ALPHA-EDITED'), 'model b is not contaminated by model a');
  });

  it('bundles multiple models into a zip that round-trips to both files', async () => {
    const { state, resolve } = twoEditedModels();
    const deps = { ...defaultBuildArtifactsDeps, resolveStepDataStore: resolve };
    const { files } = await buildChangedArtifacts(state, deps);

    const zipped = zipFiles(files);
    const unzipped = unzipSync(zipped);
    const names = Object.keys(unzipped).sort();
    assert.deepStrictEqual(names, ['alpha.ifc', 'beta.ifc']);
    assert.ok(strFromU8(unzipped['alpha.ifc']).includes('ALPHA-EDITED'));
    assert.ok(strFromU8(unzipped['beta.ifc']).includes('BETA-EDITED'));
  });
});
