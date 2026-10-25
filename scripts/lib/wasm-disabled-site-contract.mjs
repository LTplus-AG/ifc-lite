/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

const SOURCE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Disabled site contract'),'2;1');
FILE_NAME('site.ifc','2026-10-23T00:00:00',('Test'),('Test'),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((0.,1.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#4,$);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCUNITASSIGNMENT((#7));
#9=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#6),#8);
#70=IFCSITE('0000000000000000000070',$,'Site',$,$,#5,$,$,.ELEMENT.,$,$,$,$,$);
#50=IFCWALL('0000000000000000000050',$,'Wall',$,$,#5,$,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;
`;

function capture(IfcAPI, method, bytes, disabled) {
  const api = new IfcAPI();
  try {
    const events = [];
    const args = [bytes, event => events.push(event), 1024, disabled, true];
    if (method.includes('Sharded')) {
      const columns = api.scanEntityIndexShard(bytes, 0, bytes.length);
      args.push(...['ids', 'starts', 'lengths', 'classes'].map(key => columns[key]));
    }
    api[method](...args);
    assert.equal(events.at(-1).type, 'complete');
    return {
      ids: events.filter(event => event.type === 'jobs').flatMap(event =>
        Array.from(event.jobs).filter((_, index) => index % 3 === 0)),
      total: events.at(-1).totalJobs,
      meta: events.find(event => event.type === 'meta'),
    };
  } finally { api.clearPrePassCache(); api.free(); }
}

export function runDisabledSiteContracts(IfcAPI, test) {
  for (const method of ['buildPrePassStreaming', 'buildPrePassStreamingWithSourceFingerprint',
    'buildPrePassStreamingSharded', 'buildPrePassStreamingShardedWithSourceFingerprint']) {
    test(`${method} filters site jobs while preserving site rotation (#7782 C4-6a)`, () => {
      for (const keyword of ['IFCSITE', 'ifcsite']) {
        const bytes = new TextEncoder().encode(SOURCE.replace('IFCSITE(', `${keyword}(`));
        const enabled = capture(IfcAPI, method, bytes, []);
        assert.deepEqual(enabled.ids, [70, 50]);
        assert.equal(enabled.total, 2);
        assert.ok(Math.abs(enabled.meta.buildingRotation - Math.PI / 2) < 1e-10);
        for (const disabledName of ['IFCSITE', 'IfcSite']) {
          const disabled = capture(IfcAPI, method, bytes, [disabledName]);
          assert.deepEqual(disabled.ids, [50]);
          assert.equal(disabled.total, 1);
          assert.deepEqual(disabled.meta, enabled.meta);
        }
      }
    });
  }
}
