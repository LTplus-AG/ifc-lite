/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4937 — the bytes the viewer actually hands the browser for a LandXML model.
 *
 * `@ifc-lite/create` already proves the conversion itself, including the axis
 * order, against a re-parsed file. What can only be proven HERE is that the
 * viewer reaches that converter at all rather than some other path, that the
 * result is offered as `.ifc`, and that a refusal from the converter is
 * reported instead of an empty download.
 *
 * The save-as path is observed at the two real seams `downloadBlob` uses — an
 * object URL and an anchor click — so this records what was offered to the
 * browser rather than a stub's return value. The repo bans module mocking.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downloadLandXmlAsIfc, landXmlIfcExportOutcome } from './landXmlIfcDownload.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics.js';

const SURFACE = {
  sourceId: 'landxml:surface:1', ordinal: 0, sourcePath: '/LandXML/Surfaces/Surface',
  properties: {}, definitionProperties: {}, name: 'Existing Ground',
  kind: 'tin' as const, renderState: 'rendered' as const,
  points: [
    { sourceId: 'p1', id: '1', northing: 6406977.86, easting: 157899.16, elevation: 20.77 },
    { sourceId: 'p2', id: '2', northing: 6406990.12, easting: 157903.44, elevation: 21.03 },
    { sourceId: 'p3', id: '3', northing: 6407001.55, easting: 157888.02, elevation: 19.88 },
  ],
  sourceDataPoints: [], faces: [['1', '2', '3']] as Array<readonly [string, string, string]>,
  faceSourceIds: ['f1'], faceVisibility: [true], hiddenFaceCount: 0,
  boundaries: [], breaklines: [], contours: [],
};

function document(overrides: Partial<LandXmlTinDocument> = {}): LandXmlTinDocument {
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: true, preservedOnlySurfaces: 0, unknownExtensions: 0 },
    units: {
      linearUnit: 'meter', elevationUnit: 'meter',
      linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
    },
    surfaces: [SURFACE], extensions: [], warnings: [],
    alignments: [], profiles: [], crossSections: [], crossSectionSurfaces: [], roadways: [],
    capabilityDiagnostics: [], preservedOnlyExtensions: [],
    rendering: { meshProvenance: [], surfaceCounts: [] },
    ...overrides,
  } as LandXmlTinDocument;
}

/** Record what `downloadBlob` offers the browser, without stubbing it. */
async function captureDownload(run: () => void): Promise<{ filename: string; text: string }> {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  let filename = '';
  let blob: Blob | undefined;
  URL.createObjectURL = ((value: Blob) => { blob = value; return 'blob:landxml-ifc-test'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { filename = this.download; };
  try {
    run();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
  }
  return { filename, text: blob ? await blob.text() : '' };
}

describe('downloadLandXmlAsIfc (#4937)', () => {
  it('offers an IFC4X3 STEP file named after the source', async () => {
    let result: ReturnType<typeof downloadLandXmlAsIfc> | undefined;
    const { filename, text } = await captureDownload(() => {
      result = downloadLandXmlAsIfc({ document: document(), name: 'Example_Terrain.xml' });
    });

    assert.equal(result?.status, 'exported');
    assert.match(filename, /^Example_Terrain.*\.ifc$/, 'the source name seeds the download, with an .ifc extension');
    // The ISO identifier for the layouts written: the bare `IFC4X3` token is
    // resolved by IfcOpenShell to a later development schema (#5351).
    assert.match(text, /FILE_SCHEMA\(\('IFC4X3_ADD2'\)\)/);
    assert.match(text, /IFCGEOGRAPHICELEMENT/);
    // The one assertion that would survive a transposed writer only by luck:
    // X is the authored easting, Y the northing.
    assert.match(text, /IFCCARTESIANPOINTLIST3D\(\(\(157899\.16,6406977\.86,20\.77\)/);
  });

  it('writes georeferencing for a declared datum, passed through and not resolved', async () => {
    const { text } = await captureDownload(() => {
      downloadLandXmlAsIfc({
        document: document({ coordinateSystem: { horizontalDatum: 'SWEREF99 TM', verticalDatum: 'RH2000' } }),
        name: 'terrain.xml',
      });
    });
    // §4.2: the datum string is the CRS Name verbatim. ifc-lite never resolves
    // an EPSG code, so nothing here should look like a lookup result.
    assert.match(text, /IFCPROJECTEDCRS\('SWEREF99 TM'/);
    assert.match(text, /IFCMAPCONVERSION/);
  });

  it('writes no georeferencing at all when no datum is declared', async () => {
    const { text } = await captureDownload(() => {
      downloadLandXmlAsIfc({ document: document(), name: 'terrain.xml' });
    });
    // A placeholder CRS would be worse than none: it reads as a claim.
    assert.doesNotMatch(text, /IFCPROJECTEDCRS/);
    assert.doesNotMatch(text, /IFCMAPCONVERSION/);
  });

  it('reports the converter refusal instead of downloading an empty file', async () => {
    let result: ReturnType<typeof downloadLandXmlAsIfc> | undefined;
    const { filename } = await captureDownload(() => {
      result = downloadLandXmlAsIfc({
        document: document({ surfaces: [], alignments: [{}, {}] as never }),
        name: 'alignment.xml',
      });
    });

    assert.equal(result?.status, 'refused');
    assert.equal(filename, '', 'nothing is handed to the browser when the mapping covers nothing');
    assert.match(result?.status === 'refused' ? result.reason : '', /2 alignments/);
  });
});

describe('landXmlIfcExportOutcome (#4937, #5848)', () => {
  // The real catalogue is not needed to prove the wiring; echoing the key
  // keeps the assertion about WHICH message was chosen.
  const t = ((key: string) => key) as never;

  it('reports success', async () => {
    let outcome: ReturnType<typeof landXmlIfcExportOutcome> | undefined;
    await captureDownload(() => {
      outcome = landXmlIfcExportOutcome({ document: document(), name: 'terrain.xml' }, t);
    });

    assert.equal(outcome?.success, true);
    assert.equal(outcome?.message, 'exportDialog.landXml.exported');
  });

  it('reports a refusal as a failure', async () => {
    let outcome: ReturnType<typeof landXmlIfcExportOutcome> | undefined;
    await captureDownload(() => {
      outcome = landXmlIfcExportOutcome(
        { document: document({ surfaces: [], alignments: [{}] as never }), name: 'alignment.xml' },
        t,
      );
    });

    assert.equal(outcome?.success, false);
    assert.match(outcome?.message ?? '', /1 alignments/);
  });

  it('reports a thrown conversion as a failure rather than leaving the dialog hung', async () => {
    // A face naming a point the surface does not define makes the converter
    // throw. The dialog must show that, not spin forever.
    const broken = document({
      surfaces: [{ ...SURFACE, faces: [['1', '2', '99']] as Array<readonly [string, string, string]> }],
    });
    let outcome: ReturnType<typeof landXmlIfcExportOutcome> | undefined;
    await captureDownload(() => {
      outcome = landXmlIfcExportOutcome({ document: broken, name: 'broken.xml' }, t);
    });

    assert.equal(outcome?.success, false);
    assert.match(outcome?.message ?? '', /99/);
  });
});
