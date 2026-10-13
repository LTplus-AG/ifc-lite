/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { NativeReviewCaptures, readNativeReview, validationFindings, type NativeReviewModel } from './review.js';

const samples = new URL('../../../apps/viewer/public/samples/', import.meta.url);
async function fixture(capacity = 32, filename = 'building-architecture.ifc', modelId = 'actual-architecture') {
  const bytes = new Uint8Array(readFileSync(new URL(filename, samples)));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const xml = readFileSync(new URL('building-architecture.ids', samples), 'utf8');
  const model: NativeReviewModel = { id: modelId, name: 'Actual architecture', owner: store,
    store, source: store.source, mutationView: () => null,
    expressIdOf: GlobalId => store.entities.getExpressIdByGlobalId(GlobalId),
    globalIdOf: expressId => store.entities.getGlobalId(expressId) ?? '' };
  let permitted = true;
  const models = () => [model];
  const allowed = (id: string) => permitted && id === model.id;
  const native = (definition = xml) => validateIDS(parseIDS(definition), createDataAccessor(store), {
    modelId: model.id, schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
  const control = await native();
  expect(control.specificationResults.every(spec => !spec.error)).toBe(true);
  const actualRows = validationFindings({ report: control, stale: false }, models());
  expect(actualRows.findings.length).toBeGreaterThan(0);
  const captures = new NativeReviewCaptures(capacity);
  const produce = async (definition = xml) => {
    const token = await captures.begin('ids', definition, models(), models, allowed);
    expect(token).not.toBeNull();
    const report = await native(definition); captures.finish(token, report); return report;
  };
  const read = () => readNativeReview(captures, models, { sources: ['validation'], maxFindings: 512 }, allowed);
  const title = (label: string) => xml.replace('<title>Building Architecture IDS</title>', `<title>${label}</title>`);
  const unchanged = () => expect(createHash('sha256').update(store.source.materialize()).digest('hex')).toBe(hash);
  return { store, xml, model, models, allowed, native, actualRows, captures, produce, read, title, unchanged, hash,
    permit: (value: boolean) => { permitted = value; } };
}

it('#7477 native SDK reruns settle latest contexts without a lifetime admission limit', async () => {
  const f = await fixture();
  const ids = new Set<string>();
  for (let i = 0; i < 33; i++) {
    await f.produce(); const read = await f.read();
    expect(read.findings.length).toBe(f.actualRows.findings.length);
    expect(read.provenance).toHaveLength(1);
    expect(ids.has(read.provenance[0].runId)).toBe(false); ids.add(read.provenance[0].runId);
    expect(read.bounds.nativeCoverageComplete).toBe(true);
  }
  for (let i = 0; i < 33; i++) await f.produce(f.title(`Distinct native definition ${i}`));
  const retained = await f.read();
  expect(retained.runs.map(run => run.label)).toEqual(Array.from({ length: 32 }, (_, i) => `Distinct native definition ${i + 1}`));
  expect(retained.retention).toMatchObject({ inventoryOmitted: true, omittedHistoricalRuns: null });
  expect(retained.bounds).toMatchObject({ knownFindings: 32 * f.actualRows.findings.length,
    knownFindingsScope: 'retained-current-contexts', nativeCoverageComplete: false }); f.unchanged();
}, 30_000);

it('#7477 SDK abandons failed native attempts, preserves original historical provenance and recovers permission refusal', async () => {
  const f = await fixture(); await f.produce(); const before = await f.read();
  for (let i = 0; i < 33; i++) {
    const token = await f.captures.begin('ids', f.xml, f.models(), f.models, f.allowed);
    expect(token).not.toBeNull();
    const accessor = createDataAccessor(f.store);
    const actualEntities = accessor.getEntitiesByType.bind(accessor);
    // #7490 isolates ordinary specification errors; AbortError still ends the actual producer.
    const controlledFailure = new DOMException('Controlled native enumeration failure', 'AbortError');
    accessor.getEntitiesByType = (...args: Parameters<typeof actualEntities>) => { actualEntities(...args); throw controlledFailure; };
    let failed = false;
    try { await validateIDS(parseIDS(f.xml), accessor, { modelId: f.model.id,
      schemaVersion: f.store.schemaVersion, entityCount: f.store.entityCount }); }
    catch (error) { failed = true; expect(error).toBe(controlledFailure); f.captures.abandon(token); }
    expect(failed).toBe(true);
  }
  const historical = await f.read();
  expect(historical.provenance).toEqual(before.provenance); expect(historical.coverage).toEqual(before.coverage);
  expect(historical.runs[0]).toMatchObject({ temporal: 'historical', complete: false });
  expect(historical.latestAttempt).toMatchObject({ state: 'failed', refusal: 'producer-failed' });
  f.permit(false);
  expect(await f.captures.begin('ids', f.xml, f.models(), f.models, f.allowed)).toBeNull();
  f.permit(true); await f.produce();
  const recovered = await f.read(); expect(recovered.latestAttempt).toMatchObject({ state: 'succeeded' });
  expect(recovered.bounds.nativeCoverageComplete).toBe(true); f.unchanged();
}, 30_000);

it('#7477 SDK bounds 32 proof-pending admissions before work and does not erase a newer refusal', async () => {
  const f = await fixture();
  const source = f.store.source; const original = source.withMaterializedAsync.bind(source);
  const releases: Array<() => void> = [];
  const gates = Array.from({ length: 32 }, () => new Promise<void>(resolve => { releases.push(resolve); }));
  let reached: () => void = () => { throw new Error('Source barrier not installed'); };
  const ready = new Promise<void>(resolve => { reached = resolve; });
  let entered = 0;
  const pending: Array<ReturnType<typeof f.produce>> = [];
  try {
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const index = entered++; const value = await original(fn);
      if (index < 32) { if (entered === 32) reached(); await gates[index]; } return value;
    };
    for (let i = 0; i < 32; i++) pending.push(f.produce(f.title(`Pending native definition ${i}`)));
    await ready;
    expect(await f.captures.begin('ids', f.xml, f.models(), f.models, f.allowed)).toBeNull(); expect(entered).toBe(32);
    for (const release of releases) release(); await Promise.all(pending);
    const refused = await f.read(); expect(refused.runs).toHaveLength(32);
    expect(refused.latestAttempt).toEqual({ state: 'refused', refusal: 'work-bound', proof: null });
    expect(refused.bounds.knownFindings).toBeNull();
    await f.produce(f.title('Pending native definition 0'));
    expect((await f.read()).bounds.nativeCoverageComplete).toBe(true); f.unchanged();
  } finally { for (const release of releases) release(); await Promise.allSettled(pending); source.withMaterializedAsync = original; }
}, 30_000);

it('#7477 SDK refuses older proof history after genuine newer context evidence is evicted', async () => {
  const f = await fixture(2); const source = f.store.source;
  const original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No proof is awaiting the barrier yet. */ };
  let older: ReturnType<typeof f.produce> | undefined;
  try {
    let reached: () => void = () => { throw new Error('Source barrier not installed'); };
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; }); let first = true;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const value = await original(fn); if (first) { first = false; reached(); await pause; } return value;
    };
    older = f.produce(); await ready;
    await f.produce(); await f.produce(f.title('Later B')); await f.produce(f.title('Later C'));
    release(); await older;
    const read = await f.read(); expect(read.runs.map(run => run.label)).toEqual(['Later B', 'Later C']);
    expect(read.retention).toMatchObject({ inventoryOmitted: true, omittedHistoricalRuns: null, captureRefusal: 'capture-bound' });
    expect(read.latestAttempt).toMatchObject({ state: 'succeeded' }); expect(read.bounds.nativeCoverageComplete).toBe(false); f.unchanged();
  } finally { release(); if (older) await Promise.allSettled([older]); source.withMaterializedAsync = original; }
});

it('#7477 SDK fences replaced capture membership and credentials enrolled during a real source hash', async () => {
  const f = await fixture(); await f.produce();
  const source = f.store.source; const original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No read is awaiting source proof yet. */ };
  let pending: ReturnType<typeof f.read> | undefined;
  try {
    const install = () => {
      let reached: () => void = () => { throw new Error('Source barrier not installed'); };
      const ready = new Promise<void>(resolve => { reached = resolve; });
      const pause = new Promise<void>(resolve => { release = resolve; }); let first = true;
      source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
        const value = await original(fn); if (first) { first = false; reached(); await pause; } return value;
      }; return ready;
    };
    let ready = install(); pending = f.read(); await ready; await f.produce(); release();
    const invalidated = await pending; expect(invalidated.findings).toEqual([]);
    expect(invalidated.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'capture-bound' }]);
    expect((await f.read()).bounds.nativeCoverageComplete).toBe(true);
    const secret = 'native-sdk"private\\credential'; await f.produce(f.title(secret));
    ready = install(); pending = f.read(); await ready; f.captures.enrollCredentials([secret]); release();
    const guarded = await pending; expect(guarded.findings).toEqual([]); expect(guarded.provenance).toEqual([]);
    expect(guarded.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'sensitive-input' }]);
    expect(JSON.stringify(guarded)).not.toContain(JSON.stringify(secret).slice(1, -1)); f.unchanged();
  } finally { release(); if (pending) await Promise.allSettled([pending]); source.withMaterializedAsync = original; }
});

for (const change of ['permission', 'edit'] as const) {
  it(`#7477 SDK final native ownership fence observes ${change} during real source proof`, async () => {
    const f = await fixture();
    const { MutablePropertyView } = await import('@ifc-lite/mutations');
    const view = new MutablePropertyView(f.store.properties ?? null, f.model.id);
    f.model.mutationView = () => view;
    await f.produce(); expect((await f.read()).bounds.nativeCoverageComplete).toBe(true);
    const source = f.store.source, original = source.withMaterializedAsync.bind(source);
    let release: () => void = () => { /* No source read is awaiting a barrier yet. */ };
    let pending: ReturnType<typeof f.read> | undefined;
    try {
      let reached: () => void = () => { throw new Error('Actual source barrier not installed'); };
      const ready = new Promise<void>(resolve => { reached = resolve; });
      const pause = new Promise<void>(resolve => { release = resolve; });
      source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
        const actual = await original(fn); reached(); await pause; return actual;
      };
      pending = f.read(); await ready;
      if (change === 'permission') f.permit(false);
      else {
        const evidence = f.actualRows.findings[0]?.evidence;
        const expressId = evidence?.kind === 'validation' ? evidence.expressId : undefined;
        if (typeof expressId !== 'number') throw new Error('Native failed entity address missing');
        view.setAttribute(expressId, 'Name', 'Actual overlay edit during native proof');
      }
      release(); const result = await pending;
      if (change === 'permission') {
        expect(result.findings).toEqual([]); expect(result.provenance).toEqual([]);
        expect(result.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'scope' }]);
      } else {
        expect(result.runs[0].complete).toBe(false); expect(result.runs[0].incomplete).toContainEqual({ code: 'stale' });
      }
      expect(result.bounds.nativeCoverageComplete).toBe(false); f.unchanged();
    } finally { release(); if (pending) await Promise.allSettled([pending]); source.withMaterializedAsync = original; }
  });
}

it('#7477 direct SDK envelope protection does not depend on a host card projection', async () => {
  const f = await fixture(); const secret = 'direct-native"secret\\7372'; await f.produce(f.title(secret));
  const raw = () => f.captures.read(f.models, f.allowed, result => result);
  expect((await raw()).runs[0].label).toBe(secret);
  const source = f.store.source, original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No hash is pending before barrier installation. */ };
  let pending: ReturnType<typeof raw> | undefined;
  try {
    let reached: () => void = () => { throw new Error('Actual source barrier not installed'); };
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; });
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn); reached(); await pause; return actual;
    };
    pending = raw(); await ready; f.captures.enrollCredentials([secret]); release();
    const guarded = await pending;
    expect(guarded.availability).toBe('unavailable'); expect(guarded.refusal).toBe('sensitive-input');
    expect(guarded.findings).toEqual([]); expect(guarded.runs).toEqual([]); expect(guarded.provenance).toEqual([]);
    expect(guarded.coverage).toEqual([]); expect(guarded.latestAttempt).toBeNull();
    expect(JSON.stringify(guarded)).not.toContain(JSON.stringify(secret).slice(1, -1));
    f.captures.enrollCredentials(Array.from({ length: 257 }, () => secret));
    expect((await raw()).refusal).toBe('work-bound'); f.unchanged();
  } finally { release(); if (pending) await Promise.allSettled([pending]); source.withMaterializedAsync = original; }
});

for (const replaceFailure of [false, true]) {
  it(`#7477 older deferred proof respects a newer proven native failure${replaceFailure ? ' after its descriptor is replaced' : ''}`, async () => {
    const f = await fixture();
    const source = f.store.source, original = source.withMaterializedAsync.bind(source);
    let release: () => void = () => { /* No source proof is awaiting a barrier yet. */ };
    let older: ReturnType<typeof f.produce> | undefined;
    try {
      let reached: () => void = () => { throw new Error('Actual source barrier not installed'); };
      const ready = new Promise<void>(resolve => { reached = resolve; });
      const pause = new Promise<void>(resolve => { release = resolve; }); let first = true;
      source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
        const actual = await original(fn); if (first) { first = false; reached(); await pause; } return actual;
      };
      older = f.produce(); await ready;
      const newer = await f.captures.begin('ids', f.xml, f.models(), f.models, f.allowed);
      expect(newer).not.toBeNull();
      const accessor = createDataAccessor(f.store), enumerate = accessor.getEntitiesByType.bind(accessor);
      const controlledFailure = new DOMException('Controlled newer native enumeration failure', 'AbortError');
      accessor.getEntitiesByType = (...args: Parameters<typeof enumerate>) => {
        enumerate(...args); throw controlledFailure;
      };
      let actualFailure: unknown;
      try { await validateIDS(parseIDS(f.xml), accessor, { modelId: f.model.id,
        schemaVersion: f.store.schemaVersion, entityCount: f.store.entityCount }); }
      catch (error) { actualFailure = error; f.captures.abandon(newer); }
      expect(actualFailure).toBe(controlledFailure);
      const failed = await f.read();
      expect(failed.latestAttempt).toMatchObject({ state: 'failed', refusal: 'producer-failed' });
      expect(failed.latestAttempt?.proof).not.toBeNull();
      if (replaceFailure) await f.produce(f.title('Later distinct successful context'));
      release(); const oldReport = await older;
      expect(oldReport.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
      const read = await f.read();
      if (replaceFailure) {
        expect(read.runs.map(run => run.label)).toEqual(['Later distinct successful context']);
        expect(read.latestAttempt).toMatchObject({ state: 'succeeded' });
        expect(read.retention).toMatchObject({ inventoryOmitted: true, omittedHistoricalRuns: null, captureRefusal: 'capture-bound' });
      } else {
        expect(read.runs).toHaveLength(1);
        expect(read.runs[0]).toMatchObject({ temporal: 'historical', complete: false });
        expect(read.latestAttempt).toEqual(failed.latestAttempt);
        expect(read.provenance[0].runId).not.toBe(newer?.runId);
        expect(read.findings.length).toBe(f.actualRows.findings.length);
      }
      expect(read.bounds.nativeCoverageComplete).toBe(false);
      const oldId = read.provenance.find(proof => proof.definitionSHA256 === failed.latestAttempt?.proof?.definitionSHA256)?.runId;
      await f.produce();
      const recovered = await f.read();
      expect(recovered.latestAttempt).toMatchObject({ state: 'succeeded' });
      if (oldId !== undefined) expect(recovered.provenance.some(proof => proof.runId === oldId)).toBe(false);
      expect(recovered.latestAttempt?.proof?.runId).not.toBe(newer?.runId);
      expect(recovered.runs.every(run => run.complete)).toBe(true);
      expect(recovered.bounds.nativeCoverageComplete).toBe(!replaceFailure); f.unchanged();
    } finally { release(); if (older) await Promise.allSettled([older]); source.withMaterializedAsync = original; }
  });
}


it('#7372 native rerun ordering survives resequencing while an older source proof remains pending', async () => {
  const f = await fixture();
  const source = f.store.source, original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No source proof is awaiting a barrier yet. */ };
  let older: ReturnType<typeof f.produce> | undefined;
  try {
    let reached: () => void = () => { throw new Error('Actual source barrier not installed'); };
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; }); let first = true;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn); if (first) { first = false; reached(); await pause; } return actual;
    };
    older = f.produce(); await ready;
    // Genuine native attempts cross the fixed ordering bound while the oldest
    // reservation remains live. Independent native reports precede Review assertions.
    for (let i = 0; i < 130; i++) {
      const report = await f.produce();
      expect(report.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    }
    const latestSuccess = await f.read();
    expect(latestSuccess.provenance).toHaveLength(1);
    expect(latestSuccess.findings.length).toBe(f.actualRows.findings.length);
    const newer = await f.captures.begin('ids', f.xml, f.models(), f.models, f.allowed);
    expect(newer).not.toBeNull();
    const accessor = createDataAccessor(f.store), enumerate = accessor.getEntitiesByType.bind(accessor);
    const controlledFailure = new DOMException('Controlled native failure after ordering resequence', 'AbortError');
    accessor.getEntitiesByType = (...args: Parameters<typeof enumerate>) => {
      enumerate(...args); throw controlledFailure;
    };
    let actualFailure: unknown;
    try { await validateIDS(parseIDS(f.xml), accessor, { modelId: f.model.id,
      schemaVersion: f.store.schemaVersion, entityCount: f.store.entityCount }); }
    catch (error) { actualFailure = error; f.captures.abandon(newer); }
    expect(actualFailure).toBe(controlledFailure);
    const failed = await f.read();
    expect(failed.latestAttempt).toMatchObject({ state: 'failed', refusal: 'producer-failed' });
    expect(failed.latestAttempt?.proof).not.toBeNull();
    release(); const originalReport = await older;
    expect(originalReport.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    const historical = await f.read();
    expect(historical.latestAttempt).toEqual(failed.latestAttempt);
    expect(historical.provenance).toEqual(latestSuccess.provenance);
    expect(historical.runs).toHaveLength(1);
    expect(historical.runs[0]).toMatchObject({ temporal: 'historical', complete: false });
    expect(historical.findings.length).toBe(f.actualRows.findings.length);
    expect(historical.bounds.nativeCoverageComplete).toBe(false);
    await f.produce(); const recovered = await f.read();
    expect(recovered.latestAttempt).toMatchObject({ state: 'succeeded' });
    expect(recovered.provenance).toHaveLength(1);
    expect(recovered.provenance[0].runId).not.toBe(latestSuccess.provenance[0].runId);
    expect(recovered.runs[0].complete).toBe(true);
    expect(recovered.bounds.nativeCoverageComplete).toBe(true); f.unchanged();
  } finally { release(); if (older) await Promise.allSettled([older]); source.withMaterializedAsync = original; }
}, 30_000);


it('#7372 late proven older native context cannot revive after its newer retained context is evicted', async () => {
  const f = await fixture(2), source = f.store.source, original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No source proof is pending before barrier setup. */ };
  let older: ReturnType<typeof f.captures.begin> | undefined;
  try {
    let reached: () => void = () => { throw new Error('Actual source barrier not installed'); };
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; }); let first = true;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn); if (first) { first = false; reached(); await pause; } return actual;
    };
    older = f.captures.begin('ids', f.xml, f.models(), f.models, f.allowed); await ready;
    const newerReport = await f.produce();
    expect(newerReport.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    release(); const token = await older; expect(token).not.toBeNull();
    // The older proof is now prepared while its newer same-context record is
    // still retained. Its actual native report completes before that record is evicted.
    const originalReport = await f.native();
    expect(originalReport.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    await f.produce(f.title('Later retained B')); await f.produce(f.title('Later retained C'));
    const before = await f.read(); f.captures.finish(token, originalReport);
    const after = await f.read();
    expect(after.runs.map(run => run.label)).toEqual(['Later retained B', 'Later retained C']);
    expect(after.provenance).toEqual(before.provenance);
    expect(after.latestAttempt).toEqual(before.latestAttempt);
    expect(after.retention).toMatchObject({ inventoryOmitted: true, omittedHistoricalRuns: null });
    expect(after.bounds.nativeCoverageComplete).toBe(false); f.unchanged();
  } finally { release(); if (older) await Promise.allSettled([older]); source.withMaterializedAsync = original; }
});

it('#7372 model selection omits permitted unrelated native contexts while authorization revocation stays fail closed', async () => {
  const a = await fixture(), b = await fixture(32, 'building-architecture.ifc', 'actual-peer');
  const models = () => [a.model, b.model]; let permitB = true;
  const allowed = (id: string) => id === a.model.id || permitB && id === b.model.id;
  const captures = new NativeReviewCaptures();
  for (const f of [a, b]) {
    const report = await f.native(); expect(report.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    const token = await captures.begin('ids', f.xml, [f.model], models, allowed); expect(token).not.toBeNull();
    captures.finish(token, report);
  }
  for (const f of [a, b]) {
    const selected = await readNativeReview(captures, models, { sources: ['validation'], modelIds: [f.model.id] }, allowed);
    expect(selected.sources).toEqual([{ source: 'validation', state: 'available' }]);
    expect(selected.findings.length).toBe(f.actualRows.findings.length);
    expect(selected.provenance).toHaveLength(1);
    expect(selected.provenance[0].sources.map(source => source.modelId)).toEqual([f.model.id]);
    expect(selected.findings.every(finding => finding.elements.every(element => element.modelId === f.model.id))).toBe(true);
    expect(selected.bounds.knownFindings).toBe(f.actualRows.findings.length);
    expect(selected.bounds.nativeCoverageComplete).toBe(true);
    if (f === a) expect(selected.latestAttempt).toBeNull();
  }
  permitB = false;
  const revoked = await readNativeReview(captures, models, { sources: ['validation'], modelIds: [a.model.id] }, allowed);
  expect(revoked.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'scope' }]);
  expect(revoked.bounds.knownFindings).toBeNull(); expect(revoked.bounds.nativeCoverageComplete).toBe(false);
  permitB = true;
  expect((await readNativeReview(captures, models, { modelIds: [a.model.id] }, allowed)).bounds.nativeCoverageComplete).toBe(true);
  a.unchanged(); b.unchanged();
});

it('#7372 distinct genuine native source hashes stay fresh when models share one host owner', async () => {
  const a = await fixture(), b = await fixture(32, 'building-architecture-rev-b.ifc', 'actual-revision');
  expect(a.hash).not.toBe(b.hash);
  const owner = { stores: [a.store, b.store] };
  const shared = [a, b].map(f => ({ ...f.model, owner })); const models = () => shared;
  const allowed = (id: string) => shared.some(model => model.id === id);
  const captures = new NativeReviewCaptures();
  for (const [index, f] of [a, b].entries()) {
    const report = await f.native(); expect(report.specificationResults.every(spec => !spec.error)).toBe(true);
    expect(report.specificationResults.some(spec => spec.applicableCount > 0)).toBe(true);
    const token = await captures.begin('ids', f.xml, [shared[index]], models, allowed); expect(token).not.toBeNull();
    captures.finish(token, report);
  }
  const read = await readNativeReview(captures, models, { sources: ['validation'] }, allowed);
  expect(read.runs).toHaveLength(2); expect(read.runs.every(run => run.complete)).toBe(true);
  expect(read.provenance.map(proof => proof.sources[0].sourceSHA256)).toEqual([a.hash, b.hash]);
  expect(read.findings.length).toBe(a.actualRows.findings.length + b.actualRows.findings.length);
  expect(read.findings.every(finding => finding.elements.every(element => element.nativeUnresolved === undefined))).toBe(true);
  expect(read.bounds.nativeCoverageComplete).toBe(true); a.unchanged(); b.unchanged();
});


it('#7372 older unproven native context cannot become current after a non-latest proven newer failure', async () => {
  const f = await fixture();
  const source = f.store.source, original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No source proof is pending before barrier setup. */ };
  let older: ReturnType<typeof f.produce> | undefined;
  try {
    let reached: () => void = () => { throw new Error('Actual source barrier not installed'); };
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; }); let first = true;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn); if (first) { first = false; reached(); await pause; } return actual;
    };
    older = f.produce(); await ready;
    const cancellation = new AbortController();
    const newer = await f.captures.begin('ids', f.xml, f.models(), f.models, f.allowed, cancellation.signal);
    expect(newer).not.toBeNull();
    const proven = await f.read();
    expect(proven.latestAttempt).toMatchObject({ state: 'pending' });
    expect(proven.latestAttempt?.proof?.sources[0].sourceSHA256).toBe(f.hash);
    const distinctReport = await f.produce(f.title('Unrelated newer native context'));
    expect(distinctReport.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    const distinct = await f.read();
    expect(distinct.latestAttempt).toMatchObject({ state: 'succeeded' });
    expect(distinct.latestAttempt?.proof?.runId).not.toBe(newer?.runId);
    const accessor = createDataAccessor(f.store), enumerate = accessor.getEntitiesByType.bind(accessor);
    const controlledFailure = new DOMException('Controlled non-latest native cancellation', 'AbortError');
    accessor.getEntitiesByType = (...args: Parameters<typeof enumerate>) => {
      // Native enumeration still runs; cancellation is observed inside the
      // actual producer, and remains a global abort when ordinary errors isolate.
      const entities = enumerate(...args); cancellation.abort(controlledFailure); cancellation.signal.throwIfAborted();
      return entities;
    };
    let actualFailure: unknown;
    try { await validateIDS(parseIDS(f.xml), accessor, { modelId: f.model.id,
      schemaVersion: f.store.schemaVersion, entityCount: f.store.entityCount }); }
    catch (error) { actualFailure = error; f.captures.abandon(newer, 'aborted'); }
    expect(cancellation.signal.aborted).toBe(true);
    expect(actualFailure).toBe(controlledFailure);
    release(); const oldReport = await older;
    expect(oldReport.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    const read = await f.read();
    expect(read.runs.map(run => run.label)).toEqual(['Unrelated newer native context']);
    expect(read.provenance).toEqual(distinct.provenance);
    expect(read.coverage).toEqual(distinct.coverage);
    expect(read.latestAttempt).toEqual(distinct.latestAttempt);
    expect(read.retention).toMatchObject({ inventoryOmitted: true, omittedHistoricalRuns: null, captureRefusal: 'capture-bound' });
    expect(read.bounds.nativeCoverageComplete).toBe(false);
    await f.produce(); const recovered = await f.read();
    expect(recovered.runs).toHaveLength(2);
    expect(recovered.runs.every(run => run.complete && run.temporal === 'current')).toBe(true);
    expect(recovered.latestAttempt).toMatchObject({ state: 'succeeded' });
    expect(recovered.latestAttempt?.proof?.runId).not.toBe(newer?.runId);
    expect(recovered.retention?.inventoryOmitted).toBe(true); f.unchanged();
  } finally { release(); if (older) await Promise.allSettled([older]); source.withMaterializedAsync = original; }
}, 30_000);

it('#7372 native Review label and title clipping preserves a surrogate pair at the UTF-16 boundary', async () => {
  for (const [label, expected] of [
    ['a'.repeat(511) + '😀' + 'suffix', 'a'.repeat(511)],
    ['b'.repeat(510) + '😀' + 'suffix', 'b'.repeat(510) + '😀'],
    ['c'.repeat(512) + 'suffix', 'c'.repeat(512)],
  ]) {
    const f = await fixture();
    const definition = f.title(label).replace(/(<specification\b[^>]*\bname=")[^"]*"/g, `$1${label}"`);
    const report = await f.produce(definition);
    expect(report.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    expect(report.specificationResults.every(spec => spec.specification.name === label)).toBe(true);
    const originalFacts = validationFindings({ report, stale: false }, f.models());
    expect(originalFacts.runs[0].label).toBe(label);
    expect(originalFacts.findings.length).toBe(f.actualRows.findings.length);
    expect(originalFacts.findings.every(finding => finding.title === label)).toBe(true);
    const read = await f.read();
    expect(read.runs).toHaveLength(1);
    expect(read.runs[0].label).toBe(expected);
    expect(read.findings.length).toBe(originalFacts.findings.length);
    expect(read.findings.every(finding => finding.title === expected)).toBe(true);
    expect(read.runs[0].label.length).toBeLessThanOrEqual(512);
    expect(read.bounds.nativeCoverageComplete).toBe(true);
    // Projection clips its cloned presentation; the actual native report stays exact.
    expect(report.specificationResults.every(spec => spec.specification.name === label)).toBe(true);
    expect(originalFacts.runs[0].label).toBe(label); f.unchanged();
  }
});


it('#7372 settled inventory added during an actual native read hash cannot appear complete', async () => {
  const f = await fixture(); const firstReport = await f.produce();
  expect(firstReport.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
  const before = await f.read();
  expect(before.findings.length).toBe(f.actualRows.findings.length);
  expect(before.bounds.nativeCoverageComplete).toBe(true);
  const source = f.store.source, original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No read hash is pending before barrier setup. */ };
  let pending: ReturnType<typeof f.read> | undefined;
  try {
    let reached: () => void = () => { throw new Error('Actual read hash barrier not installed'); };
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; }); let first = true;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn); if (first) { first = false; reached(); await pause; } return actual;
    };
    pending = f.read(); await ready;
    const definition = f.title('Distinct native context settled during read');
    const distinctReport = await f.produce(definition);
    const distinctFacts = validationFindings({ report: distinctReport, stale: false }, f.models());
    expect(distinctReport.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    expect(distinctFacts.findings.length).toBe(f.actualRows.findings.length);
    release(); const invalidated = await pending;
    expect(invalidated.bounds).toMatchObject({ knownFindings: null, omittedFindings: null,
      nativeCoverageComplete: false, presentationComplete: false });
    expect(invalidated.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'capture-bound' }]);
    expect(invalidated.findings).toEqual([]); expect(invalidated.provenance).toEqual([]);
    // A later real read hashes the complete settled inventory without mutating it.
    const fresh = await f.read();
    expect(fresh.runs.map(run => run.label)).toEqual([before.runs[0].label, 'Distinct native context settled during read']);
    expect(fresh.findings.length).toBe(before.findings.length + distinctFacts.findings.length);
    expect(fresh.provenance).toHaveLength(2);
    expect(fresh.provenance[0]).toEqual(before.provenance[0]);
    expect(fresh.latestAttempt?.proof?.runId).toBe(fresh.provenance[1].runId);
    expect(fresh.retention?.inventoryOmitted).toBe(false);
    expect(fresh.bounds).toMatchObject({ knownFindings: fresh.findings.length, omittedFindings: 0,
      nativeCoverageComplete: true, presentationComplete: true });
    f.unchanged();
  } finally { release(); if (pending) await Promise.allSettled([pending]); source.withMaterializedAsync = original; }
}, 30_000);


it('#7372 requested native inventory change cannot evade the read fence by evicting an unrequested context', async () => {
  const a = await fixture(2, 'building-architecture.ifc', 'requested-A');
  const b = await fixture(2, 'building-architecture.ifc', 'unrequested-B');
  const models = () => [a.model, b.model];
  const allowed = (id: string) => models().some(model => model.id === id);
  const produce = async (f: typeof a, definition = f.xml) => {
    const token = await a.captures.begin('ids', definition, f.models(), models, allowed);
    expect(token).not.toBeNull();
    const report = await f.native(definition);
    expect(report.specificationResults.every(spec => !spec.error)).toBe(true);
    expect(report.specificationResults.some(spec => spec.failedCount > 0)).toBe(true);
    a.captures.finish(token, report);
    return validationFindings({ report, stale: false }, f.models());
  };
  // The excluded B context is oldest; both independent native models produce
  // actual failing rows before testing the asynchronous inventory boundary.
  const bFacts = await produce(b); expect(bFacts.findings.length).toBe(b.actualRows.findings.length);
  const firstFacts = await produce(a);
  const read = () => readNativeReview(a.captures, models,
    { sources: ['validation'], modelIds: [a.model.id], maxFindings: 512 }, allowed);
  const before = await read();
  expect(before.runs).toHaveLength(1);
  expect(before.findings.length).toBe(firstFacts.findings.length);
  expect(before.bounds.nativeCoverageComplete).toBe(true);
  const source = a.store.source, original = source.withMaterializedAsync.bind(source);
  let release: () => void = () => { /* No proof await precedes barrier setup. */ };
  let pending: ReturnType<typeof read> | undefined;
  try {
    let reached: () => void = () => { throw new Error('Actual A source barrier not installed'); };
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; }); let first = true;
    source.withMaterializedAsync = async <T,>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> => {
      const actual = await original(fn);
      if (first) { first = false; reached(); await pause; }
      return actual;
    };
    pending = read(); await ready;
    const distinct = await produce(a, a.title('New requested A context evicts unrequested B'));
    expect(distinct.findings.length).toBe(firstFacts.findings.length);
    release(); const invalidated = await pending;
    expect(invalidated.sources).toEqual([{ source: 'validation', state: 'unavailable', refusal: 'capture-bound' }]);
    expect(invalidated.bounds).toMatchObject({ knownFindings: null, omittedFindings: null,
      nativeCoverageComplete: false, presentationComplete: false });
    expect(invalidated.findings).toEqual([]); expect(invalidated.provenance).toEqual([]);
    const fresh = await read();
    expect(fresh.runs.map(run => run.label)).toEqual([before.runs[0].label, 'New requested A context evicts unrequested B']);
    expect(fresh.findings.length).toBe(firstFacts.findings.length + distinct.findings.length);
    expect(fresh.provenance).toHaveLength(2);
    expect(fresh.provenance[0]).toEqual(before.provenance[0]);
    expect(fresh.latestAttempt?.proof?.runId).toBe(fresh.provenance[1].runId);
    expect(fresh.retention?.inventoryOmitted).toBe(true);
    expect(fresh.bounds).toMatchObject({ knownFindings: fresh.findings.length, omittedFindings: 0,
      nativeCoverageComplete: false, presentationComplete: true });
    a.unchanged(); b.unchanged();
  } finally { release(); if (pending) await Promise.allSettled([pending]); source.withMaterializedAsync = original; }
}, 30_000);
