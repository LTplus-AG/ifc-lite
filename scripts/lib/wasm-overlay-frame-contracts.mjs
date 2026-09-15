#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

const OVERLAY_FRAME_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#1000=IFCPROJECT('0Project0000000000000d',$,'P',$,$,$,$,(#1001),#1002);
#1001=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#1002=IFCUNITASSIGNMENT((#1003));
#1003=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#1=IFCCARTESIANPOINT((100000.,200000.,300000.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#6=IFCLOCALPLACEMENT($,#8);
#8=IFCAXIS2PLACEMENT3D(#9,#2,#3);
#9=IFCCARTESIANPOINT((0.,0.,0.));
#10=IFCCARTESIANPOINT((11.,22.));
#11=IFCCARTESIANPOINT((31.,42.));
#12=IFCPOLYLINE((#10,#11));
#13=IFCGRIDAXIS('A',#12,.T.);
#20=IFCGRID('0aBcDeFgHiJkLmNoPqRsT0',$,'Grid',$,$,#5,$,(#13),$,$);
#30=IFCCARTESIANPOINT((100011.,200022.,300033.));
#31=IFCCARTESIANPOINT((100031.,200042.,300053.));
#32=IFCPOLYLINE((#30,#31));
#40=IFCALIGNMENT('1aBcDeFgHiJkLmNoPqRsT0',$,'Alignment',$,$,$,$,#32,$);
#50=IFCSHAPEREPRESENTATION(#1001,'Annotation','Annotation2D',(#12));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#52=IFCANNOTATION('2aBcDeFgHiJkLmNoPqRsT0',$,'Annotation',$,$,#6,#51);
ENDSEC;
END-ISO-10303-21;`;

export function runOverlayFrameContracts(api, test) {
  console.log('\n📋 exact overlay RTC frame boundary (#4799)');

  test('all overlay bindings accept and apply one explicit RTC frame', () => {
    const raw = { x: 5, y: 6, z: 7, needsShift: false };
    const shifted = { x: 100005, y: 200006, z: 300007, needsShift: true };
    const zero = { x: 0, y: 0, z: 0, needsShift: true };
    const rawGrid = api.parseGridLinesInFrame(OVERLAY_FRAME_IFC, raw);
    const shiftedGrid = api.parseGridLinesInFrame(OVERLAY_FRAME_IFC, shifted);
    const zeroGrid = api.parseGridLinesInFrame(OVERLAY_FRAME_IFC, zero);
    const standaloneGrid = api.parseGridLines(OVERLAY_FRAME_IFC);
    assert.deepEqual(Array.from(rawGrid), Array.from(zeroGrid), 'true+zero and false both subtract zero');
    assert.notDeepEqual(Array.from(rawGrid), Array.from(standaloneGrid), 'false must override shifting standalone detection');
    assert.deepEqual(Array.from(shiftedGrid), [6, -7, -16, 26, -7, -36]);

    const rawAlignment = api.parseAlignmentLinesInFrame(OVERLAY_FRAME_IFC, raw);
    const shiftedAlignment = api.parseAlignmentLinesInFrame(OVERLAY_FRAME_IFC, shifted);
    const zeroAlignment = api.parseAlignmentLinesInFrame(OVERLAY_FRAME_IFC, zero);
    const standaloneAlignment = api.parseAlignmentLines(OVERLAY_FRAME_IFC);
    assert.deepEqual(Array.from(rawAlignment), Array.from(zeroAlignment));
    assert.notDeepEqual(Array.from(rawAlignment), Array.from(standaloneAlignment));
    assert.ok(shiftedAlignment.length > 0);
    assert.equal(shiftedAlignment.length, rawAlignment.length);
    assert.equal(shiftedAlignment.length % 6, 0, 'alignment output must contain line segments');
    assert.deepEqual(Array.from(shiftedAlignment.slice(0, 3)), [6, 26, -16]);
    assert.deepEqual(Array.from(shiftedAlignment.slice(-3)), [26, 46, -36]);
    const viewerRtc = [100005, 300007, -200006];
    for (let i = 0; i < shiftedAlignment.length; i++) {
      assert.ok(Number.isFinite(shiftedAlignment[i]), `shifted alignment component ${i} must be finite`);
      assert.ok(Number.isFinite(rawAlignment[i]), `raw alignment component ${i} must be finite`);
      // Raw values near 300 km incur up to 0.015625 m of f32 rounding before
      // subtraction; 0.02 covers that bound without hiding a moved vertex.
      assert.ok(
        Math.abs(shiftedAlignment[i] - (rawAlignment[i] - viewerRtc[i % 3])) <= 0.02,
        `shifted alignment component ${i} must reuse the supplied RTC frame`,
      );
    }

    const axes = api.parseGridAxesInFrame(OVERLAY_FRAME_IFC, shifted);
    const symbolic = api.parseSymbolicRepresentationsInFrame(OVERLAY_FRAME_IFC, shifted);
    const axisSnapshot = (collection) => {
      const axis = collection.getAxis(0);
      assert.ok(axis);
      try {
        return { start: Array.from(axis.start), end: Array.from(axis.end) };
      } finally {
        axis.free();
      }
    };
    const symbolicSnapshot = (collection) => {
      let annotation = null;
      for (let i = 0; i < collection.polylineCount; i++) {
        const polyline = collection.getPolyline(i);
        if (!polyline) continue;
        if (polyline.ifcType === 'IfcAnnotation') annotation = {
          points: Array.from(polyline.points),
          worldY: polyline.worldY,
        };
        polyline.free();
      }
      return annotation;
    };
    const rawAxes = api.parseGridAxesInFrame(OVERLAY_FRAME_IFC, raw);
    const zeroAxes = api.parseGridAxesInFrame(OVERLAY_FRAME_IFC, zero);
    const standaloneAxes = api.parseGridAxes(OVERLAY_FRAME_IFC);
    const rawSymbolic = api.parseSymbolicRepresentationsInFrame(OVERLAY_FRAME_IFC, raw);
    const zeroSymbolic = api.parseSymbolicRepresentationsInFrame(OVERLAY_FRAME_IFC, zero);
    const standaloneSymbolic = api.parseSymbolicRepresentations(OVERLAY_FRAME_IFC);
    try {
      assert.equal(axes.length, 1);
      assert.deepEqual(axisSnapshot(axes), { start: [6, -7, -16], end: [26, -7, -36] });
      assert.deepEqual(axisSnapshot(rawAxes), axisSnapshot(zeroAxes));
      assert.notDeepEqual(axisSnapshot(rawAxes), axisSnapshot(standaloneAxes));
      assert.ok(symbolic.polylineCount > 0, 'fixture must emit nonempty symbolic geometry');
      assert.deepEqual(symbolicSnapshot(symbolic), { points: [6, -16, 26, -36], worldY: -7 });
      assert.deepEqual(symbolicSnapshot(rawSymbolic), symbolicSnapshot(zeroSymbolic));
      assert.notDeepEqual(symbolicSnapshot(rawSymbolic), symbolicSnapshot(standaloneSymbolic));
    } finally {
      axes.free();
      symbolic.free();
      rawAxes.free();
      zeroAxes.free();
      standaloneAxes.free();
      rawSymbolic.free();
      zeroSymbolic.free();
      standaloneSymbolic.free();
    }
  });

  test('overlay frame validation rejects malformed inputs without standalone fallback', () => {
    const invalid = [
      null,
      [],
      {},
      { x: '0', y: 0, z: 0, needsShift: false },
      { x: Number.POSITIVE_INFINITY, y: 0, z: 0, needsShift: false },
      { x: 0, y: 0, z: 0, needsShift: 0 },
    ];
    for (const frame of invalid) {
      assert.throws(
        () => api.parseGridLinesInFrame(OVERLAY_FRAME_IFC, frame),
        undefined,
        `malformed frame ${JSON.stringify(frame)} must reject`,
      );
    }
  });
}
