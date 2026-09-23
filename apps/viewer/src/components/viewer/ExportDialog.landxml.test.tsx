/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { useViewerStore } from '@/store';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ExportDialog } from './ExportDialog.js';

const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

function landXmlModel(id: string) {
  const model = fixtureModel(id);
  model.sourceSchema = 'LandXML-1.2';
  model.schemaVersion = 'IFC4';
  return model;
}

function openDialog(): void {
  const trigger = [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Export IFC'));
  assert.ok(trigger, 'the export trigger is available');
  click(trigger);
}

function exportButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === 'Export');
  assert.ok(button, 'the dialog renders its export action');
  return button;
}

describe('ExportDialog LandXML source fidelity (#5042)', () => {
  it('refuses IFC export from a LandXML-only model instead of synthesizing IFC', () => {
    const terrain = landXmlModel('survey.xml');
    useViewerStore.setState({ ...fixtureModels(terrain), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    assert.match(document.body.textContent ?? '', /LandXML cannot be exported as IFC/);
    assert.match(document.body.textContent ?? '', /no IFC entities are synthesized for export/);
    assert.equal(exportButton().disabled, true, 'a LandXML source has no IFC export action');
  });

  it('keeps the non-IFC JSON mutation-delta export available', () => {
    const terrain = landXmlModel('survey.xml');
    useViewerStore.setState({ ...fixtureModels(terrain), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    const label = [...document.querySelectorAll('label')]
      .find((candidate) => candidate.textContent?.trim() === 'Changes Only');
    const toggle = label?.parentElement?.parentElement?.querySelector('button[role="switch"]');
    assert.ok(toggle, 'changes-only switch is available for a LandXML source');
    click(toggle);

    assert.doesNotMatch(document.body.textContent ?? '', /LandXML cannot be exported as IFC/);
    assert.equal(exportButton().disabled, false, 'source-independent mutation JSON remains exportable');
  });

  it('does not route LandXML changes-only through the IFC5 exporter', () => {
    const terrain = landXmlModel('survey.xml');
    terrain.schemaVersion = 'IFC5';
    useViewerStore.setState({ ...fixtureModels(terrain), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    const label = [...document.querySelectorAll('label')]
      .find((candidate) => candidate.textContent?.trim() === 'Changes Only');
    const toggle = label?.parentElement?.parentElement?.querySelector('button[role="switch"]');
    assert.ok(toggle, 'changes-only switch is available');
    click(toggle);

    assert.equal(exportButton().disabled, true, 'LandXML cannot enter IFC5 synthesis through changes-only');
  });

  it('refuses merged IFC export when any participating model is LandXML', () => {
    const authored = fixtureModel('building.ifc');
    authored.schemaVersion = 'IFC4';
    const terrain = landXmlModel('survey.xml');
    useViewerStore.setState({ ...fixtureModels(authored, terrain), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    const scope = document.querySelector('[role="combobox"]');
    assert.ok(scope, 'multiple models expose a scope selector');
    click(scope);
    const merged = [...document.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent?.includes('Merged (All Models)'));
    assert.ok(merged, 'merged scope is offered before the source-aware guard evaluates it');
    click(merged);

    assert.match(document.body.textContent ?? '', /LandXML cannot be exported as IFC/);
    assert.equal(exportButton().disabled, true, 'a mixed IFC/LandXML merge cannot fabricate terrain IFC entities');
  });
});

/**
 * #5175: the refusal above tells the user to export the original LandXML file
 * instead. Before this, no such route existed anywhere in the viewer — the
 * message promised an action the UI could not perform.
 */
describe('ExportDialog LandXML source-format export (#5175)', () => {
  function sourceButton(): HTMLButtonElement | undefined {
    return [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Download original LandXML');
  }

  /**
   * Observes the real save-as path: `downloadBlob` builds an object URL and
   * clicks an anchor carrying the filename. Patching those two seams records
   * what was actually offered to the browser rather than asserting on a stub's
   * return value. `revokeObjectURL` stays installed because `downloadBlob`
   * defers it behind a timer that outlives the restore.
   */
  function captureDownload(run: () => void): { filename: string; bytes?: Blob } {
    const originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    let filename = '';
    let bytes: Blob | undefined;
    URL.createObjectURL = ((blob: Blob) => { bytes = blob; return 'blob:landxml-test'; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { filename = this.download; };
    try {
      run();
    } finally {
      URL.createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
    }
    return { filename, bytes };
  }

  it('offers the retained source bytes under the producer filename', () => {
    const terrain = landXmlModel('survey.xml');
    terrain.sourceFile = new File(['<LandXML/>'], 'Example_Terrain.xml', { type: 'application/xml' });
    useViewerStore.setState({ ...fixtureModels(terrain), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    const button = sourceButton();
    assert.ok(button, 'the refusal offers the source-format route it points users at');

    const { filename, bytes } = captureDownload(() => click(button));
    assert.equal(filename, 'Example_Terrain.xml', 'the producer filename and extension survive');
    assert.equal(bytes, terrain.sourceFile, 'the original bytes are served, not a re-synthesis');
  });

  it('states plainly when the original bytes are no longer held', () => {
    const terrain = landXmlModel('survey.xml');
    delete terrain.sourceFile;
    useViewerStore.setState({ ...fixtureModels(terrain), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    assert.equal(sourceButton(), undefined, 'no action is offered that cannot be performed');
    assert.match(document.body.textContent ?? '', /original file is no longer held in memory/);
  });

  it('does not offer a source download for a non-LandXML model', () => {
    const authored = fixtureModel('building.ifc');
    authored.schemaVersion = 'IFC4';
    authored.sourceFile = new File(['ISO-10303-21;'], 'building.ifc');
    useViewerStore.setState({ ...fixtureModels(authored), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    assert.equal(sourceButton(), undefined, 'the route belongs to the LandXML refusal, not to every export');
  });
});

/**
 * #4937 — LandXML export stops being a blanket refusal.
 *
 * The cases above are still refusals, and deliberately so: they use a model
 * with a LandXML `sourceSchema` but no retained document, which the mapping
 * cannot prove holds anything writable. These cases attach a real document and
 * pin the other half of §6 — a covered source exports, and a source covered
 * only in PART exports while naming what it leaves out, before the user
 * commits.
 */
describe('ExportDialog LandXML→IFC conversion (#4937)', () => {
  const TIN = {
    sourceId: 'landxml:surface:1', ordinal: 0, sourcePath: '/LandXML/Surfaces/Surface',
    properties: {}, definitionProperties: {}, name: 'Existing Ground',
    kind: 'tin', renderState: 'rendered',
    // Asymmetric, per §2.2: a square renders identically when transposed.
    points: [
      { sourceId: 'p1', id: '1', northing: 6406977.86, easting: 157899.16, elevation: 20.77 },
      { sourceId: 'p2', id: '2', northing: 6406990.12, easting: 157903.44, elevation: 21.03 },
      { sourceId: 'p3', id: '3', northing: 6407001.55, easting: 157888.02, elevation: 19.88 },
    ],
    sourceDataPoints: [], faces: [['1', '2', '3']], faceSourceIds: ['f1'],
    faceVisibility: [true], hiddenFaceCount: 0, boundaries: [], breaklines: [], contours: [],
  };

  function terrainWithDocument(id: string, overrides: Record<string, unknown> = {}) {
    const model = landXmlModel(id);
    model.landXmlDocument = {
      format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
      capabilities: { renderableTin: true, preservedOnlySurfaces: 0, unknownExtensions: 0 },
      units: {
        linearUnit: 'meter', elevationUnit: 'meter',
        linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
      },
      surfaces: [TIN], extensions: [], warnings: [],
      alignments: [], profiles: [], crossSections: [], crossSectionSurfaces: [], roadways: [],
      capabilityDiagnostics: [], preservedOnlyExtensions: [],
      rendering: { meshProvenance: [], surfaceCounts: [] },
      ...overrides,
    } as never;
    return model;
  }

  it('offers the conversion, by record count, for a covered source', () => {
    useViewerStore.setState({
      ...fixtureModels(terrainWithDocument('survey.xml')), dirtyModels: new Set(),
    });
    render(<ExportDialog />);
    openDialog();

    const text = document.body.textContent ?? '';
    assert.match(text, /LandXML will be converted to IFC4X3/);
    assert.match(text, /1 terrain surface/);
    assert.doesNotMatch(text, /LandXML cannot be exported as IFC/);
    assert.equal(exportButton().disabled, false, 'a covered source has an IFC export action');
  });

  it('names what a partially covered source leaves out, before the user commits', () => {
    useViewerStore.setState({
      ...fixtureModels(terrainWithDocument('survey.xml', { alignments: [{}, {}] })),
      dirtyModels: new Set(),
    });
    render(<ExportDialog />);
    openDialog();

    const text = document.body.textContent ?? '';
    // Exporting AND refusing at once is the case §6 exists for; a silent
    // partial is the one outcome the mapping rules out.
    assert.match(text, /Not included in the IFC/);
    assert.match(text, /2 alignments records will not be included/);
    assert.equal(exportButton().disabled, false, 'a partial source still exports');
  });

  it('still refuses an alignment-only source rather than writing an empty IFC', () => {
    useViewerStore.setState({
      ...fixtureModels(terrainWithDocument('alignment.xml', { surfaces: [], alignments: [{}, {}, {}] })),
      dirtyModels: new Set(),
    });
    render(<ExportDialog />);
    openDialog();

    assert.match(document.body.textContent ?? '', /LandXML cannot be exported as IFC/);
    assert.equal(exportButton().disabled, true, 'nothing the mapping covers means nothing to export');
  });

  it('surfaces an assumed unit as a standing assumption on the conversion', () => {
    const assumed = terrainWithDocument('survey.xml', {
      units: {
        linearUnit: 'US survey foot', elevationUnit: 'US survey foot',
        linearScaleToMeters: 0.3048006096, elevationScaleToMeters: 0.3048006096, assumed: true,
      },
    });
    useViewerStore.setState({ ...fixtureModels(assumed), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    // The scale is an operator's choice, not the file's. Nothing in the
    // geometry says so, which is exactly why the dialog must.
    assert.match(document.body.textContent ?? '', /assumed linear unit \(US survey foot\)/);
  });

  it('refuses IFC5 for a covered source, because v1 derives IFC4X3 STEP only', () => {
    useViewerStore.setState({
      ...fixtureModels(terrainWithDocument('survey.xml')), dirtyModels: new Set(),
    });
    render(<ExportDialog />);
    openDialog();

    const schema = [...document.querySelectorAll('[role="combobox"]')].at(-1);
    assert.ok(schema, 'the dialog offers a schema selector');
    click(schema);
    const ifc5 = [...document.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent?.includes('IFC5'));
    assert.ok(ifc5, 'IFC5 is offered before the mapping-aware guard evaluates it');
    click(ifc5);

    // Not the generic "no IFC entities are synthesized" refusal: this source
    // IS covered, and the fix is the schema, not the file.
    assert.match(document.body.textContent ?? '', /derives IFC4X3 STEP only/);
    assert.equal(exportButton().disabled, true, 'IFC5/IFCX is not a mapping target');
  });
});
