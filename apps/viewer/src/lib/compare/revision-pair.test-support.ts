/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The committed revision pair (#6921): `building-architecture.ifc` (A, a real
 * SketchUp export) and `building-architecture-rev-b.ifc` (B, derived by
 * `tools/demo-kit/derive-variants.mts` with GlobalIds preserved). B carries
 * one data change, one moved element, one deletion and one added duct that
 * hard-clashes a wall; `demo-kit.json` pins their GlobalIds.
 *
 * Everything here runs the native engines: the real parser, wasm meshing,
 * the viewer's fingerprinting + `diffModels`, the TS clash engine through
 * `elementsFromStep` (as `useClash` gathers), and `validateIDS` over the
 * committed IDS (as `runIdsCheck` falls back to on the main thread). Callers
 * skip, never fail, when the wasm runtime is not built.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { diffModels } from '@ifc-lite/diff';
import { initSync } from '@ifc-lite/wasm';
import { createClashEngine, disciplineMatrixRules, type ClashResult, type ClashRule } from '@ifc-lite/clash';
import { elementsFromStep } from '@ifc-lite/clash/step';
import { parseIDS, validateIDS, type ValidationReport } from '@ifc-lite/ids';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel } from '@/store';
import type { CompareResult } from '@/store/slices/compareSlice';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { recordGatheredModel, rememberFederationIdentity } from '@/lib/clash/federation-identity';
import { buildEntityFingerprints } from './buildFingerprints';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const SAMPLES = join(ROOT, 'apps', 'viewer', 'public', 'samples');
const WASM = join(ROOT, 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm');

export const PINS = JSON.parse(readFileSync(join(SAMPLES, 'demo-kit.json'), 'utf8')).globalIds as {
  dataModified: string; geometryMoved: string; deleted: string; added: string; clashAdded: string; clashHit: string;
};

/** A loaded federation model whose store is present (the fixture always parses). */
export type LoadedModel = FederatedModel & { ifcDataStore: IfcDataStore };

export interface RevisionPair {
  base: LoadedModel;
  head: LoadedModel;
  meshes: ReadonlyMap<string, MeshData[]>;
  compare: CompareResult;
}

function model(id: string, name: string, store: IfcDataStore): LoadedModel {
  // @raw-entity-enumeration-ok test fixture sizes a freshly parsed source before any mutation view exists
  const maxExpressId = Math.max(...store.entityIndex.byId.keys());
  return { id, name, ifcDataStore: store, geometryResult: null, visible: true, collapsed: false, schemaVersion: 'IFC4',
    loadedAt: 0, fileSize: 0, idOffset: 0, maxExpressId, sourceFingerprint: `fingerprint-${id}` } as LoadedModel;
}

let cached: Promise<RevisionPair> | null = null;

async function load(): Promise<RevisionPair> {
  const read = (file: string) => {
    const bytes = readFileSync(join(SAMPLES, file));
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
  };
  const files = { A: read('building-architecture.ifc'), B: read('building-architecture-rev-b.ifc') };
  const meshes = new Map<string, MeshData[]>();
  // Synchronous init: the DOM test environment's fetch refuses file:// URLs.
  initSync({ module: readFileSync(WASM) });
  const processor = new GeometryProcessor();
  try {
    await processor.init();
    processor.enableGeometryHashes();
    for (const [id, bytes] of Object.entries(files)) meshes.set(id, (await processor.process(bytes.slice())).meshes);
  } finally {
    processor.dispose();
  }
  const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const base = model('A', 'building-architecture.ifc', await parse(files.A));
  const head = model('B', 'building-architecture-rev-b.ifc', await parse(files.B));
  const fingerprints = (m: LoadedModel) =>
    buildEntityFingerprints({ modelId: m.id, store: m.ifcDataStore, meshes: meshes.get(m.id) ?? [], idOffset: 0 });
  const diff = diffModels(await fingerprints(base), await fingerprints(head), { scope: 'both' });
  const compare: CompareResult = { baseModelId: 'A', headModelId: 'B', baseName: base.name, headName: head.name, scope: 'both',
    geometryUnavailable: false, excludedHiddenIds: new Set(), mutationVersion: 0, diff };
  return { base, head, meshes, compare };
}

/** The parsed, meshed and compared pair; null (test skipped) without the wasm runtime. */
export async function revisionPair(t: TestContext): Promise<RevisionPair | null> {
  if (!existsSync(WASM)) {
    t.skip('wasm runtime not built: run `pnpm build:wasm` (or `pnpm build:wasm:fetch`)');
    return null;
  }
  cached ??= load();
  return cached;
}

export interface ClashRunOptions {
  rules?: ClashRule[];
  tolerance?: number;
  /** Engine pair cap; a small cap produces a truncated run. */
  maxCandidatePairs?: number;
}

/** One native clash run over the listed models, gathered the way `useClash` gathers. */
export async function runClash(pair: RevisionPair, modelIds: readonly string[], options: ClashRunOptions = {}): Promise<ClashResult> {
  const elements = [];
  const exclusions = new Set<string>();
  const identity = new Map<string, unknown>();
  for (const id of modelIds) {
    const m = id === pair.base.id ? pair.base : pair.head;
    const built = elementsFromStep({ store: m.ifcDataStore, meshes: pair.meshes.get(id) ?? [], modelId: id });
    elements.push(...built.elements);
    for (const key of built.exclusions) exclusions.add(key);
    recordGatheredModel(identity, id, m);
  }
  const result = await createClashEngine({ backend: 'ts' }).run(elements, options.rules ?? disciplineMatrixRules('hard'), {
    exclusions, tolerance: options.tolerance ?? 0.002,
    ...(options.maxCandidatePairs !== undefined ? { maxCandidatePairs: options.maxCandidatePairs } : {}),
  });
  rememberFederationIdentity(result, identity);
  return result;
}

let ids: ReturnType<typeof parseIDS> | null = null;

export interface IdsRunOptions {
  /** Rewrites the committed IDS text before parsing (a declared rule edit). */
  edit?: (xml: string) => string;
  /** Pending native property edits, read the way the viewer's accessor reads them. */
  view?: MutablePropertyView;
}

/** The committed IDS validated against one model, as the viewer's main-thread path runs it. */
export async function runIds(pair: RevisionPair, modelId: string, options: IdsRunOptions = {}): Promise<ValidationReport> {
  const m = modelId === pair.base.id ? pair.base : pair.head;
  const xml = readFileSync(join(SAMPLES, 'building-architecture.ids'), 'utf8');
  const document = options.edit ? parseIDS(options.edit(xml)) : (ids ??= parseIDS(xml));
  const accessor = createDataAccessor(m.ifcDataStore, modelId, options.view ?? null);
  return validateIDS(document, accessor, { modelId, schemaVersion: 'IFC4', entityCount: m.ifcDataStore.entityCount },
    { includePassingEntities: true });
}
