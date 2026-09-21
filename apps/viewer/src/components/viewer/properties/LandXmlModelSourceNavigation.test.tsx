/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanup, click, render } from '@/test/render.js';
import { LandXmlModelSourceNavigation } from './LandXmlModelSourceNavigation.js';
import type { LandXmlPipeUnits, LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics';

function profilesOnlyDocument(): LandXmlTinDocument {
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: false, preservedOnlySurfaces: 0, unknownExtensions: 0 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1 },
    surfaces: [], extensions: [], warnings: [], alignments: [{ sourceId: 'alignment', ordinal: 1, name: 'Route', length: 100, staStart: 0, profileSourceIds: ['design', 'ground'], crossSectionSourceIds: [], segments: [], cantStations: [], superelevations: [], unsupportedTransitions: [] }],
    profiles: [
      { sourceId: 'design', parentAlignmentSourceId: 'alignment', ordinal: 1, name: 'design', kind: 'design', pvis: [], verticalCurves: [], gradeLines: [] },
      { sourceId: 'ground', parentAlignmentSourceId: 'alignment', ordinal: 2, name: 'ground', kind: 'sampled', pvis: [], verticalCurves: [], gradeLines: [] },
    ],
    crossSections: [], crossSectionSurfaces: [], roadways: [], preservedOnlyExtensions: [], rendering: { meshProvenance: [], surfaceCounts: [] },
    capabilityDiagnostics: [{ code: 'missing_reference', sourceId: 'roadway', sourcePath: 'LandXML/Roadways/Roadway/@surfaceRefs', message: 'Roadway references unknown Surface "terrain"' }],
  };
}

const pipeUnits: LandXmlPipeUnits = {
  linearUnit: 'meter', elevationUnit: 'meter', diameterUnit: 'meter', widthUnit: 'meter', heightUnit: 'meter', flowUnit: null,
  linearScaleToMeters: 1, elevationScaleToMeters: 1, diameterScaleToMeters: 1, widthScaleToMeters: 1, heightScaleToMeters: 1,
};

function pipeNavigationDocument(): LandXmlTinDocument {
  const result = profilesOnlyDocument();
  result.alignments = [];
  result.profiles = [];
  result.capabilityDiagnostics = [];
  result.pipeNetworks = {
    version: '1.2', rootUnits: pipeUnits,
    collections: [{ sourceId: 'collection', sourcePath: 'PipeNetworks', properties: {} }],
    features: [{ sourceId: 'root-feature', sourcePath: 'PipeNetworks/Feature[1]', ownerSourceId: 'collection', properties: {} }],
    refusals: [],
    networks: Array.from({ length: 101 }, (_, index) => {
      const suffix = String(index + 1);
      return {
        sourceId: `network-${suffix}`, sourcePath: `PipeNetwork[${suffix}]`, name: `Network ${suffix}`, pipeNetworkType: 'storm', properties: {}, structureUnits: pipeUnits, pipeUnits,
        structures: [{ sourceId: `structure-${suffix}`, sourcePath: `Struct[${suffix}]`, name: `Structure ${suffix}`, properties: {}, units: pipeUnits, center: { northing: 0, easting: 0, northingMeters: 0, eastingMeters: 0, elevation: null }, part: { kind: 'circular' as const, properties: {}, material: null }, rimElevation: null, sumpElevation: null, inverts: [], flow: null }],
        pipes: [{ sourceId: `pipe-${suffix}`, sourcePath: `Pipe[${suffix}]`, name: `Pipe ${suffix}`, properties: {}, units: pipeUnits, connectivity: { startStructureSourceId: `structure-${suffix}`, endStructureSourceId: `structure-${suffix}` }, part: { kind: 'circular' as const, properties: {}, material: null }, geometry: { kind: 'straight' as const, point: null }, length: null, flow: null }],
        features: [{ sourceId: `feature-${suffix}`, sourcePath: `PipeNetwork[${suffix}]/Feature[1]`, ownerSourceId: `network-${suffix}`, properties: {} }],
      };
    }),
  };
  return result;
}

describe('LandXmlModelSourceNavigation (#5045)', () => {
  it('mounts and opens design and sampled profiles without a terrain mesh', () => {
    const selected: string[] = [];
    const ui = render(<LandXmlModelSourceNavigation modelId="profiles" document={profilesOnlyDocument()} selected={null}
      onSelect={(ref) => selected.push(`${ref.modelId}:${ref.sourceId}`)} />);
    assert.match(ui.textContent ?? '', /Profile and roadway records/);
    assert.match(ui.textContent ?? '', /missing_reference/);
    const buttons = [...ui.querySelectorAll('button')];
    const design = buttons.find((button) => button.textContent?.includes('Profile: design'));
    const ground = buttons.find((button) => button.textContent?.includes('Profile: ground'));
    assert.ok(design);
    assert.ok(ground);
    click(design);
    click(ground);
    assert.deepEqual(selected, ['profiles:design', 'profiles:ground']);
    cleanup();
  });

  it('paginates retained profile records instead of mounting every review row', () => {
    const document = profilesOnlyDocument();
    document.profiles = Array.from({ length: 101 }, (_, index) => ({
      sourceId: `profile-${index + 1}`, parentAlignmentSourceId: 'alignment', ordinal: index + 1,
      name: `profile ${index + 1}`, kind: 'design' as const, pvis: [], verticalCurves: [], gradeLines: [],
    }));
    const ui = render(<LandXmlModelSourceNavigation modelId="profiles" document={document} selected={null} onSelect={() => {}} />);
    assert.ok([...ui.querySelectorAll('button')].some((button) => button.textContent?.includes('Profile: profile 99')));
    assert.ok(![...ui.querySelectorAll('button')].some((button) => button.textContent?.includes('Profile: profile 100')));
    const pagers = [...ui.querySelectorAll('button')].filter((button) => button.textContent === 'Next');
    assert.ok(pagers.length >= 1);
    click(pagers.at(-1)!);
    assert.ok([...ui.querySelectorAll('button')].some((button) => button.textContent?.includes('Profile: profile 101')));
    cleanup();
  });

  it('labels an unnamed design cross-section surface with its retained source ID', () => {
    const document = profilesOnlyDocument();
    document.crossSectionSurfaces = [{
      sourceId: 'section-surface', parentCrossSectionSourceId: 'section', kind: 'design', name: null, segments: [], points: [],
    }];
    const ui = render(<LandXmlModelSourceNavigation modelId="profiles" document={document} selected={null} onSelect={() => {}} />);
    assert.ok([...ui.querySelectorAll('button')].some((button) => button.textContent?.includes('Cross-section surface: section-surface')));
    cleanup();
  });

  it('pages every retained network, collection, structure, pipe, and feature (#5047)', () => {
    const selected: string[] = [];
    const ui = render(<LandXmlModelSourceNavigation modelId="pipes" document={pipeNavigationDocument()} selected={null} onSelect={(ref) => selected.push(ref.sourceId)} />);
    const text = ui.textContent ?? '';
    for (const value of ['collection', 'Network 1', 'Structure 1', 'Pipe 1', 'root-feature']) assert.match(text, new RegExp(value));
    const next = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Next');
    assert.ok(next);
    click(next);
    const pipe = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Pipe 25'));
    assert.ok(pipe, 'later records are reachable through bounded pages');
    click(pipe);
    assert.deepEqual(selected, ['pipe-25']);
    cleanup();
  });
});
