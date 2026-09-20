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

const PIPE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter" diameterUnit="millimeter"/></Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>0 10 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="600"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;

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

  test('LandXML raw-byte parser serializes validated pipe records with metre coordinates', () => {
    const document = api.parseLandXmlTinBytes(new TextEncoder().encode(PIPE_XML));
    const pipe = document.pipe_networks.networks[0].pipes[0];
    assert.equal(pipe.name, 'P');
    assert.equal(pipe.part.diameter.meters, 0.6);
    assert.equal(pipe.connectivity.start_structure_source_id, 'landxml:pipe-network:1:1:structure:1');
    assert.equal(document.pipe_networks.networks[0].structures[1].center.easting_meters, 10);
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
