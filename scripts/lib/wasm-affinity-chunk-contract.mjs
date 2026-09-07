/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Actual-WASM streaming payload contract; #4051 incremental affinity publication. */
import assert from 'node:assert/strict';

export function makeAffinityChunkFixture() {
  // Ordinary occurrences share one explicit swept-solid representation. More
  // than three full bulk chunks exercise scratch-vector reuse and a short tail.
  const count = 4103;
  let source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Affinity chunk contract'),'2;1');
FILE_NAME('affinity.ifc','2026-09-06T00:00:00',('Test'),('Test'),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#4,$);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCUNITASSIGNMENT((#7));
#9=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#6),#8);
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCAXIS2PLACEMENT2D(#10,$);
#12=IFCRECTANGLEPROFILEDEF(.AREA.,$,#11,2.,0.2);
#13=IFCEXTRUDEDAREASOLID(#12,#4,#2,3.);
#14=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#13));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
`;
  const expected = [];
  for (let i = 0; i < count; i++) {
    const id = 1000 + i;
    const line = `#${id}=IFCWALL('${String(id).padStart(22, '0')}',$,'Wall ${i}',$,$,#5,#15,$,.NOTDEFINED.);`;
    // The fixture is ASCII: JS string positions are exact source byte offsets.
    expected.push([id, source.length, source.length + line.length]);
    source += `${line}\n`;
  }
  source += 'ENDSEC;\nEND-ISO-10303-21;\n';
  return { bytes: new TextEncoder().encode(source), expected };
}

function capture(api, bytes, expected) {
  const events = [];
  const snapshots = [];
  api.buildPrePassStreaming(bytes, event => {
    events.push(event);
    if (event.type === 'jobs') {
      assert.ok(event.jobs instanceof Uint32Array);
      assert.ok(event.affinity instanceof Uint32Array);
      snapshots.push({ jobs: Array.from(event.jobs), affinity: Array.from(event.affinity) });
    }
  }, 1024, undefined, true);
  const chunks = events.filter(event => event.type === 'jobs');
  assert.deepEqual(chunks.map(event => event.jobs.length / 3), [1024, 1024, 1024, 1024, 7]);
  const flattened = chunks.flatMap(event => Array.from(event.jobs));
  assert.deepEqual(flattened, expected.flat(), 'Every product and exact source span appears once in source order');
  assert.equal(new Set(flattened.filter((_, index) => index % 3 === 0)).size, expected.length,
    'Published products are unique');
  assert.deepEqual(Array.from(chunks[0].affinity), expected.slice(0, 1024).map(([id]) => id),
    'First-wave routing retains element IDs');
  const bulkKeys = chunks.slice(1).flatMap(event => Array.from(event.affinity));
  assert.equal(bulkKeys.length, expected.length - 1024);
  assert.equal(new Set(bulkKeys).size, 1, 'One shared representation retains the same bulk routing key');
  for (let i = 0; i < chunks.length; i++) {
    assert.equal(chunks[i].affinity.length, chunks[i].jobs.length / 3);
    assert.deepEqual(Array.from(chunks[i].jobs), snapshots[i].jobs);
    assert.deepEqual(Array.from(chunks[i].affinity), snapshots[i].affinity,
      'Later scratch-vector reuse cannot alter a retained event');
    for (let j = 0; j < i; j++) {
      assert.notEqual(chunks[i].jobs.buffer, chunks[j].jobs.buffer);
      assert.notEqual(chunks[i].affinity.buffer, chunks[j].affinity.buffer);
    }
  }
  assert.equal(events.filter(event => event.type === 'complete').length, 1);
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.at(-1).totalJobs, expected.length);
  for (const type of ['meta', 'styles', 'entity-index', 'prepass-columns']) {
    const position = events.findIndex(event => event.type === type);
    assert.ok(position >= 0 && position < events.findIndex(event => event.type === 'jobs'),
      `${type} must precede geometry jobs`);
  }
  return { chunks, snapshots, total: events.at(-1).totalJobs };
}

export function checkAffinityChunkContract(IfcAPI) {
  const { bytes, expected } = makeAffinityChunkFixture();
  const api = new IfcAPI();
  try {
    const first = capture(api, bytes, expected);
    const repeated = capture(api, bytes, expected);
    assert.deepEqual(repeated.snapshots, first.snapshots, 'Repeated API calls preserve every job and affinity payload');
    assert.equal(repeated.total, first.total);
    for (let i = 0; i < first.chunks.length; i++) {
      assert.deepEqual(Array.from(first.chunks[i].jobs), first.snapshots[i].jobs);
      assert.deepEqual(Array.from(first.chunks[i].affinity), first.snapshots[i].affinity,
        'Repeated prepass calls cannot overwrite retained callback arrays');
    }
  } finally {
    api.clearPrePassCache();
    api.free();
  }
}
