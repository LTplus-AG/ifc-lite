/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLandXmlViewerModelAsync } from './landXmlViewerModel.js';
import { parseLandXmlSourceInCurrentRealm } from './landXmlWasm.js';

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function source(namespace: string, version: string): ArrayBuffer {
  return bytes(`<LandXML xmlns="${namespace}" version="${version}">
    <Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade">
    <Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P>
    <P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition>
    </Surface></Surfaces></LandXML>`);
}

describe('LandXML schema compatibility (#5051)', () => {
  it('loads synthetic 1.0 and 1.1 TINs through the canonical viewer bridge', async () => {
    for (const [namespace, version] of [
      ['http://www.landxml.org/schema/LandXML-1.0', '1.0'],
      ['http://www.landxml.org/schema/LandXML-1.1', '1.1'],
    ]) {
      const model = await parseLandXmlViewerModelAsync(source(namespace, version));
      assert.equal(model.semanticDocument.schema, `LandXML-${version}`);
      assert.equal(model.semanticDocument.version, version);
      assert.equal(model.geometryResult.meshes.length, 1);
    }
  });

  it('keeps known namespace/version mismatches observable to the viewer', async () => {
    for (const [namespace, version, schema] of [
      ['http://www.landxml.org/schema/LandXML-1.0', '1.1', 'LandXML-1.0'],
      ['http://www.landxml.org/schema/LandXML-1.1', '1.2', 'LandXML-1.1'],
      ['http://www.landxml.org/schema/LandXML-1.2', '1.0', 'LandXML-1.2'],
    ]) {
      const model = await parseLandXmlViewerModelAsync(source(namespace, version));
      assert.equal(model.semanticDocument.schema, schema);
      assert.equal(model.semanticDocument.version, version);
      assert.equal(model.geometryResult.meshes.length, 1);
      assert.ok(model.semanticDocument.capabilityDiagnostics.some((diagnostic) => (
        diagnostic.code === 'schema_version_mismatch' && diagnostic.sourcePath === 'LandXML'
      )));
    }
  });

  it('refuses an unknown declared version rather than guessing a grammar', async () => {
    await assert.rejects(
      parseLandXmlSourceInCurrentRealm(
        source('http://www.landxml.org/schema/LandXML-1.1', '9.9'),
      ),
      /LXML008: LandXML namespaces require a known version declaration/,
    );
  });
});
