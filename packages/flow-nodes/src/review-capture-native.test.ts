/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { snapshotFrom, validationFindings, type NativeReviewModel } from '@ifc-lite/sdk/review';
import { runFlow, type FlowDocument } from '@ifc-lite/flow';
import { createStandardRegistry, headlessFeatures, type FlowHost } from './index.js';
import { createFakeBim } from './__tests__/fake-backend.js';

it('#7477 registered Flow nodes capture actual native IDS facts and abandon real evaluation failures', async () => {
  const samples = new URL('../../../apps/viewer/public/samples/', import.meta.url);
  const bytes = new Uint8Array(readFileSync(new URL('building-architecture.ifc', samples)));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const xml = readFileSync(new URL('building-architecture.ids', samples), 'utf8');
  const schema = store.schemaVersion;
  if (schema !== 'IFC4') throw new Error('Committed native fixture must declare IFC4');
  // The existing host scaffold supplies unused namespaces only. Model identity,
  // population, every validator read and every Review fact come from this IFC.
  const { bim } = createFakeBim();
  const modelId = bim.model.activeId(); if (!modelId) throw new Error('Flow host has no active model');
  bim.model.list = () => [{ id: modelId, name: 'Real architecture', schema, schemaVersion: schema,
    entityCount: store.entityCount, fileSize: bytes.byteLength, loadedAt: Date.now() }];
  const model: NativeReviewModel = { id: modelId, name: 'Real architecture', owner: store, store,
    source: store.source, mutationView: () => null,
    expressIdOf: GlobalId => store.entities.getExpressIdByGlobalId(GlobalId),
    globalIdOf: expressId => store.entities.getGlobalId(expressId) ?? '' };
  const models = () => [model], allowed = (id: string) => id === model.id;
  const native = await validateIDS(parseIDS(xml), createDataAccessor(store), {
    modelId, schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
  const failures = native.specificationResults.flatMap(spec => spec.entityResults.filter(row => !row.passed));
  expect(failures.length).toBeGreaterThan(0);
  const baseFeatures = headlessFeatures();
  const features = { ...baseFeatures, backend: new Set([...baseFeatures.backend, 'review']) };
  const graph: FlowDocument = { flowVersion: 1, id: 'native-capture', name: 'Real native capture',
    capabilities: ['model.read'], inputs: [], outputs: [],
    nodes: [{ id: 'load', type: 'ids.load', params: { xml } }, { id: 'validate', type: 'ids.validate', params: {} },
      { id: 'review', type: 'review.snapshot', params: { sources: ['validation'] } }],
    edges: [{ from: ['load', 'ids'], to: ['validate', 'ids'] }, { from: ['validate', 'report'], to: ['review', 'after'] }] };
  // Exercise the registered host-read contract through stable original APIs
  // before using the new capture service. This is authentic native evidence,
  // not a fabricated provider result or an API-presence assertion.
  const controlHost: FlowHost = { bim, idsAccessor: () => createDataAccessor(store), review: {
    snapshot: async () => {
      const actual = snapshotFrom([{ kind: 'validation', collect: selected => validationFindings({ report: native, stale: false }, selected) }], models());
      // This existing collector proves native findings, but has no durable
      // capture proof. Do not advertise complete native provenance here.
      return { ...actual, retention: null, latestAttempt: null, provenance: [], coverage: [],
        sources: [{ source: 'validation' as const, state: 'available' }],
        bounds: { knownFindings: actual.findings.length, omittedFindings: 0, rowLimit: 512,
          textLimit: 512, clippedTextFields: 0, knownFindingsScope: 'retained-current-contexts' as const,
          nativeCoverageComplete: false, presentationComplete: false } };
    },
  } };
  const registration = await runFlow(graph, { host: controlHost, registry: createStandardRegistry(), features });
  expect(registration.ok, JSON.stringify(registration.log)).toBe(true);
  const observed = registration.outputs.get('review')?.get('snapshot');
  if (observed?.kind !== 'item' || typeof observed.value !== 'object' || observed.value === null || !('findings' in observed.value)) {
    throw new Error('Actual registered Review read must expose native facts');
  }
  const rows = observed.value.findings;
  if (!Array.isArray(rows)) throw new Error('Actual registered Review findings missing');
  const identities = rows.flatMap(row => {
    if (typeof row !== 'object' || row === null || !('elements' in row) || !Array.isArray(row.elements)) {
      throw new Error('Actual registered native finding identity missing');
    }
    return row.elements.map((element: unknown) => {
      if (typeof element !== 'object' || element === null || !('globalId' in element) || typeof element.globalId !== 'string') {
        throw new Error('Actual native GlobalId missing from registered read');
      }
      return element.globalId;
    });
  });
  expect(identities.sort()).toEqual(failures.map(row => row.globalId).sort());
  const { NativeReviewCaptures, readNativeReview } = await import('@ifc-lite/sdk/review');
  const captures = new NativeReviewCaptures();
  let fail = false, lookups = 0;
  // #7490 preserves AbortError as a producer failure even when ordinary spec errors isolate.
  const controlledFailure = new DOMException('Controlled actual native enumeration failure', 'AbortError');
  const host: FlowHost = { bim, idsAccessor() {
    const accessor = createDataAccessor(store), original = accessor.getEntitiesByType.bind(accessor);
    accessor.getEntitiesByType = (...args: Parameters<typeof original>) => {
      const actual = original(...args); lookups++;
      if (fail) throw controlledFailure; return actual;
    };
    return accessor;
  }, validationCapture: {
    begin: (definition, signal) => captures.begin('ids', definition, models(), models, allowed, signal),
    finish: (token, report) => captures.finish(token, report),
    abandon: (token, reason) => captures.abandon(token, reason),
  }, review: { snapshot: request => readNativeReview(captures, models, request, allowed) } };
  const run = () => runFlow(graph, { host, registry: createStandardRegistry(), features });
  const first = await run(); expect(first.ok).toBe(true); expect(lookups).toBeGreaterThan(0);
  const output = first.outputs.get('review')?.get('snapshot');
  if (output?.kind !== 'item' || typeof output.value !== 'object' || output.value === null || !('findings' in output.value)) {
    throw new Error('Registered native Review node must produce an actual snapshot');
  }
  const before = await readNativeReview(captures, models, {}, allowed);
  expect(before.findings.length).toBe(failures.length);
  expect(output.value).toMatchObject({ findings: before.findings, provenance: before.provenance, coverage: before.coverage });
  expect(before.findings.flatMap(f => f.elements.map(e => e.globalId)).sort()).toEqual(failures.map(row => row.globalId).sort());
  fail = true;
  for (let i = 0; i < 33; i++) {
    const failedRun = await run();
    expect(failedRun.ok).toBe(false);
    expect(failedRun.reports.some(report => report.error === controlledFailure.message)).toBe(true);
    expect((await readNativeReview(captures, models, {}, allowed)).latestAttempt).toMatchObject({ state: 'failed', refusal: 'producer-failed' });
  }
  const earlier = await readNativeReview(captures, models, {}, allowed);
  expect(earlier.provenance).toEqual(before.provenance); expect(earlier.runs[0]).toMatchObject({ temporal: 'historical', complete: false });
  fail = false; expect((await run()).ok).toBe(true);
  expect((await readNativeReview(captures, models, {}, allowed)).bounds.nativeCoverageComplete).toBe(true);
  expect(createHash('sha256').update(store.source.materialize()).digest('hex')).toBe(hash);
}, 30_000);
