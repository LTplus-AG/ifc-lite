/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter"/></Units>
  <Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts>
    <P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P>
  </Pnts><Faces><F>1 2 3</F></Faces><Breaklines><Breakline><PntList3D>0 0 0 1 1 1</PntList3D></Breakline></Breaklines></Definition></Surface></Surfaces>
</LandXML>`;

const XML_WITHOUT_UNITS = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Surfaces><Surface name="preserved"><Definition surfType="VOLUME"/></Surface></Surfaces>
</LandXML>`;

const XML_WITH_PROFILE_REVIEW = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter"/></Units>
  <Surfaces><Surface name="ground"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces>
  <Alignments><Alignment name="A" length="100" staStart="0"><Profile><ProfAlign name="design"><PVI>0 0</PVI><ParaCurve length="20">50 5</ParaCurve><PVI>100 10</PVI></ProfAlign><ProfSurf name="survey"><PntList2D>0 0 25 2</PntList2D></ProfSurf></Profile><CrossSects><CrossSect sta="50"><DesignCrossSectSurf><CrossSectPnt alignRef="A">-2 4</CrossSectPnt></DesignCrossSectSurf></CrossSect></CrossSects></Alignment></Alignments>
  <Roadways><Roadway name="route" alignmentRefs="A" surfaceRefs="ground" gradeModelRefs="unavailable"/></Roadways>
</LandXML>`;

const PLAN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter"/></Units>
  <CgPoints><CgPoint name="control">10 20 0</CgPoint></CgPoints>
  <Monuments><Monument name="corner" pntRef="control"/></Monuments>
  <PlanFeatures><PlanFeature name="road"><CoordGeom><Line><Start pntRef="control"/><End>11 21 0</End></Line></CoordGeom></PlanFeature></PlanFeatures>
  <Parcels><Parcel name="retraced"><CoordGeom><Line><Start pntRef="control"/><End>11 20 0</End></Line><Line><Start>11 20 0</Start><End pntRef="control"/></Line></CoordGeom></Parcel></Parcels>
</LandXML>`;

const MALFORMED_PARCEL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter"/></Units><CgPoints><CgPoint name="safe">1 2</CgPoint></CgPoints>
  <Parcels><Parcel name="bad"><CoordGeom><Line><Start/><End>1 0</End></Line><Line><Start>0 0</Start><Start>0 0</Start><End>1 0</End></Line></CoordGeom></Parcel>
  <Parcel name="good"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line><Line><Start>1 0</Start><End>0 1</End></Line><Line><Start>0 1</Start><End>0 0</End></Line></CoordGeom></Parcel></Parcels>
</LandXML>`;

function aliasChainXml(count, cycle = false) {
  const points = ['<CgPoint name="p0">0 0 0</CgPoint>'];
  const geometry = [];
  for (let index = 1; index <= count; index++) {
    points.push(`<CgPoint name="p${index}" pntRef="p${cycle && index === count ? count : index - 1}"/>`);
    geometry.push(`<Line><Start pntRef="p${index}"/><End>1 1 0</End></Line>`);
  }
  return `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><CgPoints>${points.join('')}</CgPoints><Monuments>${Array.from({ length: count }, (_, index) => `<Monument pntRef="p${index + 1}"/>`).join('')}</Monuments><PlanFeatures><PlanFeature><CoordGeom>${geometry.join('')}</CoordGeom></PlanFeature></PlanFeatures></LandXML>`;
}

function bulkParcelAliasXml(count) {
  const points = ['<CgPoint name="p0">0 0 0</CgPoint>'];
  const parcels = [];
  for (let index = 1; index <= count; index++) {
    points.push(`<CgPoint name="p${index}" pntRef="p${index - 1}"/>`);
    parcels.push(`<Parcel name="p${index}"><CoordGeom><Line><Start pntRef="p${count}"/><End>1 0</End></Line><Line><Start>1 0</Start><End>0 1</End></Line><Line><Start>0 1</Start><End pntRef="p${count}"/></Line></CoordGeom></Parcel>`);
  }
  return `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><CgPoints>${points.join('')}</CgPoints><Monuments><Monument pntRef="p${count}"/></Monuments><PlanFeatures><PlanFeature><CoordGeom><Line><Start pntRef="p${count}"/><End>1 1 0</End></Line></CoordGeom></PlanFeature></PlanFeatures><Parcels>${parcels.join('')}</Parcels></LandXML>`;
}

const BULK_PARCEL_EDGE_CASES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units>
  <CgPoints><CgPoint name="shared">0 0</CgPoint></CgPoints>
  <Parcels><Parcel name="first"><CoordGeom><Line><Start pntRef="shared"/><End>1 0</End></Line><Line><Start>1 0</Start><End>0 1</End></Line><Line><Start>0 1</Start><End pntRef="shared"/></Line></CoordGeom></Parcel></Parcels>
  <CgPoints><CgPoint name="shared">10 10</CgPoint><CgPoint name="cycle-a" pntRef="cycle-b"/><CgPoint name="cycle-b" pntRef="cycle-a"/></CgPoints>
  <Parcels><Parcel name="second"><CoordGeom><Line><Start pntRef="shared"/><End>11 10</End></Line><Line><Start>11 10</Start><End>10 11</End></Line><Line><Start>10 11</Start><End pntRef="shared"/></Line></CoordGeom></Parcel><Parcel name="cycle"><CoordGeom><Line><Start pntRef="cycle-a"/><End>1 0</End></Line></CoordGeom></Parcel><Parcel name="dangling"><CoordGeom><Line><Start pntRef="missing"/><End>1 0</End></Line></CoordGeom></Parcel></Parcels>
</LandXML>`;

function regularLineParcel(edges, name) {
  const lines = [];
  for (let index = 0; index < edges; index++) {
    const angle = Math.PI * 2 * index / edges;
    const next = Math.PI * 2 * (index + 1) / edges;
    lines.push(`<Line><Start>${Math.sin(angle)} ${Math.cos(angle)}</Start><End>${Math.sin(next)} ${Math.cos(next)}</End></Line>`);
  }
  return `<Parcel name="${name}"><CoordGeom>${lines.join('')}</CoordGeom></Parcel>`;
}

function regularLineParcelXml(edges) {
  return `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><Parcels>${regularLineParcel(edges, 'regular')}</Parcels></LandXML>`;
}

function topologyLimitParcelXml() {
  return `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><CgPoints><CgPoint name="safe">2 3</CgPoint></CgPoints><Monuments><Monument pntRef="safe"/></Monuments><Parcels>${regularLineParcel(701, 'over-limit')}<Parcel name="safe"><CoordGeom><Line><Start pntRef="safe"/><End>3 3</End></Line><Line><Start>3 3</Start><End>2 4</End></Line><Line><Start>2 4</Start><End pntRef="safe"/></Line></CoordGeom></Parcel></Parcels></LandXML>`;
}

function curvedMultiLoopParcelXml(triangle) {
  return `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><Parcels><Parcel name="curved-multi"><CoordGeom><Curve rot="ccw" radius="1"><Start>0 1</Start><Center>0 0</Center><End>0 -1</End></Curve><Line><Start>0 -1</Start><End>0 1</End></Line></CoordGeom><CoordGeom>${triangle}</CoordGeom></Parcel></Parcels></LandXML>`;
}

const CURVE_MULTI_LOOP_CASES = [
  ['crossing', '<Line><Start>0.04895800097771826 0.9986005979070239</Start><End>0.0490774878622835 0.9989952152964134</End></Line><Line><Start>0.0490774878622835 0.9989952152964134</Start><End>0.04915772011680819 0.9985907863348819</End></Line><Line><Start>0.04915772011680819 0.9985907863348819</Start><End>0.04895800097771826 0.9986005979070239</End></Line>'],
  ['near-miss', '<Line><Start>0.1 1.1</Start><End>0.2 1.1</End></Line><Line><Start>0.2 1.1</Start><End>0.15 1.2</End></Line><Line><Start>0.15 1.2</Start><End>0.1 1.1</End></Line>'],
  ['tangent', '<Line><Start>0 1</Start><End>0.1 1.1</End></Line><Line><Start>0.1 1.1</Start><End>-0.1 1.1</End></Line><Line><Start>-0.1 1.1</Start><End>0 1</End></Line>'],
  ['disjoint', '<Line><Start>2 2</Start><End>3 2</End></Line><Line><Start>3 2</Start><End>2 3</End></Line><Line><Start>2 3</Start><End>2 2</End></Line>'],
];

function utf16Le(text) {
  const output = new Uint8Array(2 + text.length * 2);
  output.set([0xff, 0xfe]);
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index);
    output[2 + index * 2] = codeUnit & 0xff;
    output[3 + index * 2] = codeUnit >>> 8;
  }
  return output;
}

/** Assert the public raw-byte LandXML binding, not a mocked viewer adapter. */
export function runLandXmlContracts(api, test) {
  test('LandXML raw-byte parser accepts UTF-8 and UTF-16LE source', () => {
    const utf8 = api.parseLandXmlTinBytes(new TextEncoder().encode(XML));
    const utf16 = api.parseLandXmlTinBytes(utf16Le(XML.replace('UTF-8', 'UTF-16')));
    assert.equal(utf8.surfaces[0].name, 'grade');
    assert.deepEqual(utf8.surfaces[0].properties, { name: 'grade' });
    assert.deepEqual(utf8.surfaces[0].definition_properties, { surfType: 'TIN' });
    assert.deepEqual(utf8.surfaces[0].faces, [['1', '2', '3']]);
    assert.equal(utf8.surfaces[0].breaklines[0].name, undefined, 'serde_wasm_bindgen omits absent Option fields');
    assert.equal(utf8.surfaces[0].breaklines[0].kind, undefined, 'the TypeScript declaration must not promise null');
    assert.equal(utf16.surfaces[0].name, 'grade');
  });

  test('LandXML raw-byte parser omits optional Units rather than returning null', () => {
    const document = api.parseLandXmlTinBytes(new TextEncoder().encode(XML_WITHOUT_UNITS));
    assert.equal(document.units, undefined);
  });

  test('LandXML plan adapter exposes Rust resolution, probes and bounded batches', () => {
    const document = api.parseLandXmlTinBytes(new TextEncoder().encode(PLAN_XML));
    assert.deepEqual(document.plan.resolved_monuments, [{
      source_id: 'landxml:Monument:1:corner', point: { northing: 10, easting: 20, elevation: 0 },
    }]);
    assert.equal(document.plan.resolved_geometry[0].start.northing, 10);
    assert.deepEqual(document.plan.parcel_probes[0].state, {
      kind: 'preserved_only', reason: 'self-intersecting boundary',
    });
    assert.ok(document.plan.source_batches[0].source_ids.includes('landxml:PlanFeature:1:road:CoordGeom:1'));
  });

  test('LandXML plan adapter isolates malformed parcel children in the real WASM parser (#5046)', () => {
    const document = api.parseLandXmlTinBytes(new TextEncoder().encode(MALFORMED_PARCEL_XML));
    assert.equal(document.plan.cogo_points.length, 1);
    assert.equal(document.plan.parcels.length, 2);
    assert.equal(document.plan.parcels[0].loops[0].length, 0, 'bad Start/duplicate Start do not escape their parcel');
    assert.equal(document.plan.parcel_probes[0].state.kind, 'preserved_only');
    assert.equal(document.plan.parcel_probes[1].state.kind, 'analytic');
  });

  test('LandXML bulk resolver path-compresses hostile alias geometry and monuments (#5046)', () => {
    const count = 1_024;
    const document = api.parseLandXmlTinBytes(new TextEncoder().encode(aliasChainXml(count)));
    assert.equal(document.plan.resolved_geometry.length, count);
    assert.equal(document.plan.resolved_monuments.length, count);
    assert.ok(document.plan.resolved_geometry.every((geometry) => geometry.start?.northing === 0));
    assert.ok(document.plan.resolved_monuments.every((monument) => monument.point?.easting === 0));
    const cyclic = api.parseLandXmlTinBytes(new TextEncoder().encode(aliasChainXml(64, true)));
    assert.ok(cyclic.plan.resolved_geometry.some((geometry) => geometry.start === undefined), 'cycles remain unresolved rather than fabricated');
  });

  test('LandXML real-WASM bulk parcel probes share bounded aliases and retain analytic measurements (#5046)', () => {
    // This checks three input scales and exact semantic results, rather than a
    // flaky elapsed-time threshold. Every parcel reaches the same deep alias;
    // the adapter must therefore reuse its one resolver and aggregate budget.
    for (const count of [1_024, 2_048, 4_096]) {
      const document = api.parseLandXmlTinBytes(new TextEncoder().encode(bulkParcelAliasXml(count)));
      assert.equal(document.plan.parcel_probes.length, count, `${count} parcel probes survive`);
      assert.equal(document.plan.resolved_monuments[0].point.northing, 0, `${count} aliases resolve for monuments`);
      assert.equal(document.plan.resolved_geometry[0].start.northing, 0, `${count} aliases resolve for plan geometry`);
      for (const probe of document.plan.parcel_probes) {
        assert.deepEqual(probe.state, { kind: 'analytic' }, `${count} aliases retain analytic parcel topology`);
        assert.ok(Math.abs(probe.perimeter_in_declared_linear_units - (2 + Math.SQRT2)) < 1e-12, 'exact triangle perimeter remains authored-unit analytic');
        assert.ok(Math.abs(probe.area_in_declared_square_units - 0.5) < 1e-12, 'exact triangle area remains authored-unit analytic');
      }
    }
  });

  test('LandXML real-WASM bulk parcel probes preserve scoped, cyclic and dangling records (#5046)', () => {
    const document = api.parseLandXmlTinBytes(new TextEncoder().encode(BULK_PARCEL_EDGE_CASES_XML));
    assert.deepEqual(document.plan.parcel_probes.slice(0, 2).map((probe) => probe.state), [
      { kind: 'analytic' }, { kind: 'analytic' },
    ]);
    assert.deepEqual(document.plan.parcel_probes.slice(2).map((probe) => probe.state), [
      { kind: 'preserved_only', reason: 'open or unresolved boundary' },
      { kind: 'preserved_only', reason: 'open or unresolved boundary' },
    ]);
  });

  test('LandXML real-WASM regular production parcel boundaries stay analytic (#5046)', () => {
    for (const edges of [76, 100, 128]) {
      const document = api.parseLandXmlTinBytes(new TextEncoder().encode(regularLineParcelXml(edges)));
      const probe = document.plan.parcel_probes[0];
      assert.deepEqual(probe.state, { kind: 'analytic' }, `${edges}-edge regular boundary remains analytic`);
      assert.ok(Number.isFinite(probe.area_in_declared_square_units), `${edges}-edge regular boundary retains finite analytic area`);
    }
  });

  test('LandXML real-WASM preserves an over-limit parcel without discarding sibling records (#5046)', () => {
    const document = api.parseLandXmlTinBytes(new TextEncoder().encode(topologyLimitParcelXml()));
    assert.equal(document.plan.cogo_points[0].point.northing, 2, 'unrelated COGO survives');
    assert.equal(document.plan.resolved_monuments[0].point.easting, 3, 'unrelated monument still resolves');
    assert.deepEqual(document.plan.parcel_probes.map((probe) => probe.state), [
      { kind: 'preserved_only', reason: 'parcel topology work limit exceeded' },
      { kind: 'analytic' },
    ]);
  });

  test('LandXML real-WASM conservatively preserves multi-loop curve topology (#5046)', () => {
    for (const [name, triangle] of CURVE_MULTI_LOOP_CASES) {
      const document = api.parseLandXmlTinBytes(new TextEncoder().encode(curvedMultiLoopParcelXml(triangle)));
      assert.deepEqual(document.plan.parcel_probes[0].state, {
        kind: 'preserved_only', reason: 'multi-loop boundary with curves',
      }, `${name} cannot be inferred from sampled curve chords`);
    }
  });

  test('LandXML raw-byte parser preserves stable diagnostics', () => {
    assert.throws(
      () => api.parseLandXmlTinBytes(new TextEncoder().encode(XML.replace('linearUnit="meter"', 'linearUnit="bogus"'))),
      /LXML009: unsupported LandXML unit/,
    );
  });

  test('LandXML raw-byte parser exposes profile review semantics through WASM', () => {
    const document = api.parseLandXmlTinBytes(new TextEncoder().encode(XML_WITH_PROFILE_REVIEW));
    assert.equal(document.alignments[0].name, 'A');
    assert.deepEqual(document.alignments[0].profile_source_ids, [document.profiles[0].source_id, document.profiles[1].source_id]);
    assert.equal(document.profiles[0].kind, 'design');
    assert.equal(document.profiles[0].vertical_curves[0].kind, 'parabolic');
    assert.equal(document.profiles[1].grade_lines[0].points[1].elevation, 2);
    assert.equal(document.cross_sections[0].parent_alignment_source_id, document.alignments[0].source_id);
    assert.equal(document.cross_section_surfaces[0].points[0].alignment_source_id, document.alignments[0].source_id);
    assert.deepEqual(document.roadways[0].alignment_source_ids, [document.alignments[0].source_id]);
    assert.deepEqual(document.roadways[0].surface_source_ids, [document.surfaces[0].source_id]);
    assert.ok(document.capability_diagnostics.some((diagnostic) => diagnostic.code === 'unsupported_grade_model_reference'));
  });
}

/** Print the shared contract summary and deterministically release the API. */
export function finishContractRun(api, passed, failed, skipped) {
  console.log('\n' + '═'.repeat(50));
  console.log(`📊 Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('═'.repeat(50));
  api.free();
}
