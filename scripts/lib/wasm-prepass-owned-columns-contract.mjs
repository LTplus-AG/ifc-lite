/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #6537: actual sharded ABI ownership, ordered discovery and failure boundaries. */
import assert from 'node:assert/strict';

const METHODS = ['buildPrePassStreamingSharded', 'buildPrePassStreamingShardedWithSourceFingerprint'];
const FIELDS = ['ids', 'starts', 'lengths', 'classes'];

function fixture({ rebaseIds = false, typeGeometry = false, lowercase = false, duplicate = false } = {}) {
  let text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Owned sharded prepass contract'),'2;1');
FILE_NAME('owned.ifc','2026-10-03T00:00:00',('Test'),('Test'),'ifc-lite','ifc-lite','');
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
#200=IFCWALL('0000000000000000000200',$,'First wall',$,$,#5,#15,$,.NOTDEFINED.);
#100=IFCWALL('0000000000000000000100',$,'Second wall',$,$,#5,#15,$,.NOTDEFINED.);
`;
  if (typeGeometry) text += "#16=IFCREPRESENTATIONMAP(#4,#14);\n#300=IFCWALLTYPE('0000000000000000000300',$,'Orphan type',$,$,$,(#16),$,$,.NOTDEFINED.);\n";
  if (duplicate) text += "#200=IFCCOLUMN('0000000000000000000200',$,'Last duplicate',$,$,#5,#15,$,.NOTDEFINED.);\n";
  text += 'ENDSEC;\nEND-ISO-10303-21;\n';
  if (rebaseIds) text = text.replace(/#(\d+)/g, (_, id) => `#${Number(id) + 10000}`);
  if (lowercase) text = text.replaceAll('IFCWALL(', 'ifcwall(');
  return new TextEncoder().encode(text);
}

function withApi(IfcAPI, callback) {
  const api = new IfcAPI();
  try { return callback(api); }
  finally { api.clearPrePassCache(); api.free(); }
}

function scan(IfcAPI, bytes) {
  return withApi(IfcAPI, api => api.scanEntityIndexShard(bytes, 0, bytes.length));
}

function call(api, method, bytes, columns, callback, disabled, skipTypes = true) {
  return api[method](bytes, callback, 1024, disabled, skipTypes, ...FIELDS.map(key => columns[key]));
}

function key(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return `${bytes.length.toString(16)}-${(hash >>> 0).toString(16)}`;
}

function capture(IfcAPI, method, bytes, columns, disabled, skipTypes = true) {
  const before = FIELDS.map(field => columns[field].slice());
  const events = withApi(IfcAPI, api => {
    const result = [];
    assert.equal(call(api, method, bytes, columns, event => result.push(event), disabled, skipTypes), undefined);
    return result;
  });
  FIELDS.forEach((field, index) => assert.deepEqual(columns[field], before[index], 'Rust must not mutate/detach JS columns'));
  assert.equal(events.filter(event => event.type === 'complete').length, 1);
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.at(-1).sourceContentKey, method.endsWith('WithSourceFingerprint') ? key(bytes) : undefined);
  return events.map(({ sourceContentKey: _key, ...event }) => event);
}

function jobs(events) {
  return events.filter(event => event.type === 'jobs').flatMap(event => Array.from(event.jobs));
}

function geometry(api, bytes, pre) {
  const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, ...pre.rtcOffset, pre.needsShift,
    pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
  try {
    const meshes = [];
    for (let row = 0; row < collection.length; row++) {
      const mesh = collection.get(row);
      assert.ok(mesh, 'actual fixture must return a mesh handle');
      try {
        meshes.push({ expressId: mesh.expressId, positions: mesh.positions, normals: mesh.normals,
          indices: mesh.indices, color: mesh.color });
      } finally { mesh.free(); }
    }
    return meshes;
  } finally { collection.free(); }
}

function seed(api, bytes) {
  const pre = api.buildPrePassOnce(bytes);
  const meshes = geometry(api, bytes, pre);
  assert.ok(meshes.length > 0, 'cache/diagnostic control must contain real geometry');
  assert.ok(api.getPipelineDiagnostics()?.batches > 0);
  return { pre, meshes };
}

function reordered(columns, ascending) {
  const order = Array.from(columns.ids, (_, index) => index).sort((a, b) =>
    ascending ? columns.ids[a] - columns.ids[b] : columns.ids[b] - columns.ids[a]);
  return Object.fromEntries(FIELDS.map(field => [field,
    field === 'classes' ? Uint8Array.from(order, index => columns[field][index])
      : Uint32Array.from(order, index => columns[field][index])]));
}

function shared(columns) {
  return Object.fromEntries(FIELDS.map(field => {
    const input = columns[field];
    const buffer = new SharedArrayBuffer(input.byteLength);
    const result = field === 'classes' ? new Uint8Array(buffer) : new Uint32Array(buffer);
    result.set(input);
    return [field, result];
  }));
}

/** Registered in the existing real-WASM suite; no source-text assertions. */
export function runOwnedShardedPrepassContracts(IfcAPI, test, memory, BaselineIfcAPI) {
  const bytes = fixture();
  const columns = scan(IfcAPI, bytes);
  // The existing optional historical pair may predate fingerprint wrappers.
  // Compare its advertised original method; the candidate must expose BOTH.
  const referenceMethods = BaselineIfcAPI ? withApi(BaselineIfcAPI, api => Object.fromEntries(
    METHODS.map(method => [method, typeof api[method] === 'function' ? method : METHODS[0]]))) : undefined;
  for (const method of METHODS) {
    test(`${method} preserves ordered discovery, filters and JS inputs (#6537)`, () => {
      for (const [input, expected] of [[columns, [200, 100]], [shared(columns), [200, 100]], [reordered(columns, true), [100, 200]],
        [reordered(columns, false), [200, 100]]]) {
        const events = capture(IfcAPI, method, bytes, input);
        assert.deepEqual(jobs(events).filter((_, index) => index % 3 === 0), expected);
        assert.equal(events[0].type, 'meta');
        assert.equal(events.at(-1).totalJobs, 2);
        assert.ok(events.some(event => event.type === 'prepass-columns'));
        assert.ok(!events.some(event => event.type === 'entity-index' || event.type === 'styles'));
        if (BaselineIfcAPI) assert.deepEqual(events, capture(BaselineIfcAPI, referenceMethods[method], bytes, input));
      }
      const lower = fixture({ lowercase: true });
      const filtered = capture(IfcAPI, method, lower, scan(IfcAPI, lower), ['ifcwall']);
      assert.equal(filtered.at(-1).totalJobs, 0, 'disabled-name normalization and keyword folding must both work');
      const duplicate = fixture({ duplicate: true });
      const duplicateColumns = scan(IfcAPI, duplicate);
      const occurrences = capture(IfcAPI, method, duplicate, duplicateColumns);
      assert.deepEqual(jobs(occurrences).filter((_, index) => index % 3 === 0), [200, 100, 200],
        'index deduplication must not drop discovery occurrences with distinct classes');
      if (BaselineIfcAPI) assert.deepEqual(occurrences, capture(BaselineIfcAPI, referenceMethods[method], duplicate, duplicateColumns));
      const typed = fixture({ typeGeometry: true });
      const typedColumns = scan(IfcAPI, typed);
      for (const skipTypes of [false, true]) {
        const events = capture(IfcAPI, method, typed, typedColumns, undefined, skipTypes);
        assert.deepEqual(jobs(events).filter((_, index) => index % 3 === 0), skipTypes ? [200, 100] : [200, 100, 300]);
        if (BaselineIfcAPI) assert.deepEqual(events, capture(BaselineIfcAPI, referenceMethods[method], typed, typedColumns, undefined, skipTypes));
      }
      const tail = new Uint8Array(bytes.length + 3);
      tail.set(bytes); tail.set([0, 255, 10], bytes.length);
      for (const input of [tail, new Uint8Array()]) {
        const events = capture(IfcAPI, method, input, scan(IfcAPI, input));
        assert.equal(events.at(-1).totalJobs, input.length ? 2 : 0);
        if (BaselineIfcAPI) assert.deepEqual(events, capture(BaselineIfcAPI, referenceMethods[method], input, scan(IfcAPI, input)));
      }
    });

    test(`${method} keeps JS columns owned after API free and WASM memory growth (#6537)`, () => {
      const input = scan(IfcAPI, bytes);
      const expected = FIELDS.map(field => input[field].slice());
      capture(IfcAPI, method, bytes, input);
      memory.grow(1);
      FIELDS.forEach((field, index) => {
        assert.deepEqual(input[field], expected[index]);
        assert.notEqual(input[field].buffer, memory.buffer);
      });
      capture(IfcAPI, method, bytes, input);
    });

    test(`${method} refuses lengths before callbacks, diagnostic reset or cache replacement (#6537)`, () => {
      const other = fixture({ rebaseIds: true });
      const otherColumns = scan(IfcAPI, other);
      const preOther = withApi(IfcAPI, api => api.buildPrePassOnce(other));
      // Positive cache discriminator: old ids cannot resolve the new source's references.
      withApi(IfcAPI, api => {
        seed(api, bytes);
        assert.equal(geometry(api, other, preOther).length, 0);
      });
      for (const field of FIELDS) {
        for (const delta of [-1, 1]) {
          withApi(IfcAPI, api => {
            seed(api, bytes);
            const before = api.getPipelineDiagnostics();
            const invalid = { ...otherColumns };
            const old = otherColumns[field];
            const Type = field === 'classes' ? Uint8Array : Uint32Array;
            invalid[field] = new Type(old.length + delta);
            invalid[field].set(old.subarray(0, invalid[field].length));
            let callbacks = 0;
            assert.throws(() => call(api, method, other, invalid, () => callbacks++),
              error => String(error).startsWith('buildPrePassStreamingSharded: entity index columns disagree in length:'));
            assert.equal(callbacks, 0);
            assert.deepEqual(api.getPipelineDiagnostics(), before, 'rejected calls must not reset diagnostics');
            assert.equal(geometry(api, other, preOther).length, 0, 'rejected calls must retain old index, not clear/install');
          });
        }
      }
      withApi(IfcAPI, api => {
        seed(api, bytes);
        const invalid = { ...otherColumns, starts: new Uint32Array(), classes: new Uint8Array() };
        assert.throws(() => call(api, method, other, invalid, () => assert.fail('refusal must precede callbacks')),
          error => String(error) === `buildPrePassStreamingSharded: entity index columns disagree in length: ids ${otherColumns.ids.length}, classes 0`);
      });
    });

    test(`${method} propagates callbacks at the original cache-install boundaries (#6537)`, () => {
      const other = fixture({ rebaseIds: true });
      const otherColumns = scan(IfcAPI, other);
      const expected = withApi(IfcAPI, api => seed(api, other));
      for (const phase of ['meta', 'jobs', 'complete']) {
        withApi(IfcAPI, api => {
          seed(api, bytes);
          const marker = new Error(`callback-${phase}`);
          const seen = [];
          assert.throws(() => call(api, method, other, otherColumns, event => {
            seen.push(event.type);
            if (event.type === phase) throw marker;
          }), error => error === marker, 'the original callback exception must propagate');
          assert.equal(seen.at(-1), phase);
          assert.equal(api.getPipelineDiagnostics(), undefined, 'successful input resets before any callback');
          const actual = geometry(api, other, expected.pre);
          if (phase === 'meta') assert.equal(actual.length, 0, 'meta throw precedes new cache installation');
          else assert.deepEqual(actual, expected.meshes, 'jobs/complete throw follows new cache installation');
          // A subsequent complete call must remain usable after every exception.
          const events = [];
          call(api, method, other, otherColumns, event => events.push(event));
          assert.equal(events.at(-1).type, 'complete');
          assert.deepEqual(geometry(api, other, expected.pre), expected.meshes);
        });
      }
    });
  }
}
