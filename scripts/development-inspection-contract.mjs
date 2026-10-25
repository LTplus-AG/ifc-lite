#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// #7955: actual Node-WASM source inspection, explicitly no SKIP success path.
import assert from 'node:assert/strict';
import { loadDevelopmentInspection } from './lib/development-inspection.mjs';
import { validateShape } from './retained-contract/validate.mjs';
import { exerciseInspectionClock } from './consumer/development-inspection-clock.mjs';

const source = `ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));#4=IFCLOCALPLACEMENT($,#2);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#10=IFCWALL('0000000000000000000001',$,'Wall',$,$,#4,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#2,#3,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
ENDSEC;END-ISO-10303-21;`;
const options = { schemaVersion: 1, chordToleranceMetres: 0.001, angleToleranceRadians: 0.1,
  maxWork: '10000', maxBytes: '16777216', deadlineMs: '10000', typeGeometryMode: 'suppress_instanced',
  normalPolicy: 'source_analytic_v1', instancePolicy: 'uncut_mapped_v1', interfacePolicy: 'certified_internal_v1',
  openings: 'all', layers: 'preserve', skipSmallCuts: false, mergeLayers: false };
const encode = text => new TextEncoder().encode(text);
let fetches = 0, workers = 0;
const oldFetch = globalThis.fetch, oldWorker = globalThis.Worker;
globalThis.fetch = () => { fetches++; throw new Error('Inspection must not fetch SDK or assets'); };
globalThis.Worker = class { constructor() { workers++; throw new Error('Inspection must not construct Workers'); } };
try {
  const inspect = await loadDevelopmentInspection(process.env.IFC_RETAINED_BUILD_COMMIT);
  const run = (text = source, intent = options, id = 10) => inspect(encode(text), id, JSON.stringify(intent));
  const report = run();
  assert.equal(report.outcome.kind, 'requires_numerical_evaluation');
  assert.ok(BigInt(report.outcome.requestOrdinal) > 1n, 'Actual traversal reached numerical work');
  assert.equal(report.authority, 'diagnostic_only');
  assert.equal(report.product.GlobalId.value, '0000000000000000000001');
  for (const requirement of ['openings', 'layers', 'textures', 'palettes', 'normals', 'face_identity',
    'numerical_evaluation', 'final_geometry', 'protected_removal', 'publication']) {
    assert.ok(report.unchecked.includes(requirement), requirement);
  }
  assert.equal(Object.hasOwn(report, 'partition'), false);
  const refused = run(source.replace('(#13));', '(#13,$));'));
  assert.equal(refused.outcome.kind, 'refused');
  assert.equal(refused.outcome.refusal.code, 'SOURCE_INVALID');
  const changed = run(source.replace('#3,3.);', '#3,4.);'));
  assert.notEqual(changed.identity.source.sha256, report.identity.source.sha256);
  assert.notEqual(changed.identity.resultId, report.identity.resultId);
  const intentChanged = run(source, { ...options, chordToleranceMetres: 0.002 });
  assert.notEqual(intentChanged.identity.resultId, report.identity.resultId);
  // A second equal-byte source has its own SourceBundle/decoder admission.
  assert.equal(run().identity.source.sha256, report.identity.source.sha256);
  const entry = expected => error => {
    assert.equal(error.kind, 'entry_refused'); assert.equal(error.authority, 'diagnostic_only');
    assert.equal(validateShape('Code', error.code), expected); return true;
  };
  for (const change of [{ mergeLayers: true }, { chordToleranceMetres: 0 }, { maxWork: '0' },
    { maxBytes: '18446744073709551616' }, { extra: true }, { source: report.identity.source }]) {
    assert.throws(() => run(source, { ...options, ...change }), entry('INVALID_OPTIONS'));
  }
  for (const id of [-1, 0, 1.5, 4294967306, NaN, Infinity]) {
    assert.throws(() => run(source, options, id), entry('INVALID_OPTIONS'));
  }
  assert.throws(() => inspect(encode(source), 10, JSON.stringify(options).replace('0.001', 'NaN')), entry('INVALID_OPTIONS'));
  assert.throws(() => inspect(encode(source), 10, JSON.stringify(options).replace('{', '{"schemaVersion":1,')), entry('INVALID_OPTIONS'));
  assert.throws(() => run(source.replace('0000000000000000000001', 'forged')), entry('SOURCE_INVALID'));
  assert.throws(() => run(source, options, 999), entry('SOURCE_INVALID'));
  exerciseInspectionClock(run, options, entry);
  assert.equal(fetches, 0); assert.equal(workers, 0);
  console.log(JSON.stringify({ actualWasm: true, implementationCommit: report.implementationCommit,
    sourceSha256: report.identity.source.sha256, numericalBoundary: true, finality: false,
    refusal: refused.outcome.refusal.code, realElapsedDeadline: true, unavailableClockRefused: true, fetches, workers }));
} finally {
  globalThis.fetch = oldFetch;
  if (oldWorker === undefined) delete globalThis.Worker; else globalThis.Worker = oldWorker;
}
