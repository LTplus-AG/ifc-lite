/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanup, click, render } from '@/test/render.js';
import { LandXmlModelSourceNavigation } from './LandXmlModelSourceNavigation.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics';

function profilesOnlyDocument(): LandXmlTinDocument {
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: false, preservedOnlySurfaces: 0, unknownExtensions: 0 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1 },
    surfaces: [], extensions: [], warnings: [], alignments: [{ sourceId: 'alignment', ordinal: 1, name: 'Route', length: 100, staStart: 0, profileSourceIds: ['design', 'ground'], crossSectionSourceIds: [] }],
    profiles: [
      { sourceId: 'design', parentAlignmentSourceId: 'alignment', ordinal: 1, name: 'design', kind: 'design', pvis: [], verticalCurves: [], gradeLines: [] },
      { sourceId: 'ground', parentAlignmentSourceId: 'alignment', ordinal: 2, name: 'ground', kind: 'sampled', pvis: [], verticalCurves: [], gradeLines: [] },
    ],
    crossSections: [], crossSectionSurfaces: [], roadways: [], preservedOnlyExtensions: [], rendering: { meshProvenance: [], surfaceCounts: [] },
    capabilityDiagnostics: [{ code: 'missing_reference', sourceId: 'roadway', sourcePath: 'LandXML/Roadways/Roadway/@surfaceRefs', message: 'Roadway references unknown Surface "terrain"' }],
  };
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
});
