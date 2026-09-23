/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4937 — what IFC export offers for a LandXML model, and why.
 *
 * Before v1 of the mapping this was a blanket refusal, so the only thing a
 * test could check was that the button stayed disabled. The interesting cases
 * are now the ones in between: a model the mapping covers in part must still
 * export while NAMING what it leaves out, and a model it cannot cover at all
 * must still refuse. §6 of `docs/architecture/landxml-to-ifc-mapping.md`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landXmlExportPlan } from './landXmlIfcPlan.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics.js';

/** Asymmetric on purpose, per §2.2 — never a square. */
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

function landXmlModel(doc: LandXmlTinDocument | undefined) {
  return { id: 'm1', name: 'terrain.xml', sourceSchema: 'LandXML-1.2', landXmlDocument: doc };
}

describe('landXmlExportPlan (#4937)', () => {
  it('returns null when no LandXML model is in scope, leaving IFC→IFC export untouched', () => {
    const plan = landXmlExportPlan(new Map(), { sourceSchema: 'IFC4' } as never, false);
    assert.equal(plan, null);
  });

  it('covers a renderable TIN and counts its surfaces', () => {
    const plan = landXmlExportPlan(new Map(), landXmlModel(document()) as never, false);
    assert.ok(plan);
    assert.equal(plan.covered, true);
    assert.equal(plan.scope, 'selected');
    assert.equal(plan.surfaces, 1);
    assert.equal(plan.surveyPoints, 0);
  });

  it('exports a partial source and NAMES every family it leaves out', () => {
    const plan = landXmlExportPlan(
      new Map(),
      landXmlModel(document({ alignments: [{}, {}] as never, profiles: [{}] as never })) as never,
      false,
    );
    assert.ok(plan);
    // Covered AND refusing: the case §6 exists for. A silent partial is the
    // one outcome the mapping forbids.
    assert.equal(plan.covered, true);
    const alignments = plan.refusals.find((refusal) => refusal.family === 'alignments');
    assert.equal(alignments?.count, 2);
    assert.equal(plan.refusals.find((refusal) => refusal.family === 'profiles')?.count, 1);
  });

  it('refuses an alignment-only source rather than offering an empty IFC', () => {
    const plan = landXmlExportPlan(
      new Map(),
      landXmlModel(document({ surfaces: [], alignments: [{}, {}, {}] as never })) as never,
      false,
    );
    assert.ok(plan);
    assert.equal(plan.covered, false);
    assert.equal(plan.refusals.find((refusal) => refusal.family === 'alignments')?.count, 3);
  });

  it('counts mappable alignments as covered records, and names the ones it refuses', () => {
    const fixture = JSON.parse(readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../tools/ifcopenshell_reference/alignment_fixture.json'),
      'utf8',
    )) as { alignments: LandXmlTinDocument['alignments'] };
    const irregular = {
      ...fixture.alignments[0], sourceId: 'landxml:alignment:ramp', name: 'Ramp',
      segments: [{
        sourceId: 's', ordinal: 0,
        primitive: {
          kind: 'irregular_line' as const,
          start: { kind: 'coordinates' as const, point: { northing: 0, easting: 0, elevation: null } },
          end: { kind: 'coordinates' as const, point: { northing: 1, easting: 1, elevation: null } },
          points: [], declaredLength: null,
        },
      }],
    };
    const plan = landXmlExportPlan(
      new Map(),
      landXmlModel(document({ surfaces: [], alignments: [...fixture.alignments, irregular] })) as never,
      false,
    );
    assert.ok(plan);
    assert.equal(plan.covered, true, 'an alignment-only file with mappable alignments is covered');
    assert.equal(plan.alignments, 3);
    const refused = plan.refusals.find((refusal) => refusal.family === 'alignments');
    assert.equal(refused?.count, 1);
    assert.match(refused?.message ?? '', /'Ramp': segment 1 is an IrregularLine/);
  });

  it('refuses a LandXML model whose document was not retained', () => {
    // A cache-restored session has the source schema but no parsed records.
    // Claiming coverage we cannot deliver is worse than refusing.
    const plan = landXmlExportPlan(new Map(), landXmlModel(undefined) as never, false);
    assert.ok(plan);
    assert.equal(plan.covered, false);
    assert.equal(plan.surfaces, 0);
  });

  it('refuses a document with no resolved units, whatever else it holds', () => {
    const plan = landXmlExportPlan(new Map(), landXmlModel(document({ units: null })) as never, false);
    assert.ok(plan);
    assert.equal(plan.covered, false);
  });

  it('surfaces an assumed linear unit and a missing CRS as standing assumptions', () => {
    const assumed = document({
      units: {
        linearUnit: 'US survey foot', elevationUnit: 'US survey foot',
        linearScaleToMeters: 0.3048006096, elevationScaleToMeters: 0.3048006096, assumed: true,
      },
    });
    const plan = landXmlExportPlan(new Map(), landXmlModel(assumed) as never, false);
    assert.ok(plan);
    assert.equal(plan.assumedUnit, 'US survey foot');
    assert.equal(plan.missingCrs, true);

    const declared = document({ coordinateSystem: { horizontalDatum: 'SWEREF99 TM' } });
    const declaredPlan = landXmlExportPlan(new Map(), landXmlModel(declared) as never, false);
    assert.equal(declaredPlan?.assumedUnit, null);
    assert.equal(declaredPlan?.missingCrs, false);
    // Carried so the dialog can say the CRS is written but UNVERIFIED: §2.2's
    // transposition check needs bounds this repo will not resolve from a name.
    assert.equal(declaredPlan?.crsName, 'SWEREF99 TM');
    assert.equal(plan?.crsName, null, 'an undeclared datum names nothing');
  });

  it('sums one family across the models of a merged export, without double-counting the selection', () => {
    const selected = landXmlModel(document({ alignments: [{}] as never }));
    const other = { ...landXmlModel(document({ alignments: [{}, {}] as never })), id: 'm2' };
    const models = new Map([[selected.id, selected], [other.id, other]]) as never;
    const plan = landXmlExportPlan(models, selected as never, true);
    assert.ok(plan);
    // One row for the family, three alignments — not two rows reading as two
    // different problems, and not four from counting the selection twice.
    assert.equal(plan.refusals.filter((refusal) => refusal.family === 'alignments').length, 1);
    assert.equal(plan.refusals.find((refusal) => refusal.family === 'alignments')?.count, 3);
    assert.equal(plan.surfaces, 2);
  });

  it('refuses a merged scope that holds covered records, naming the scope as the fix', () => {
    const other = { ...landXmlModel(document()), id: 'm2' };
    const models = new Map([[other.id, other]]) as never;
    const plan = landXmlExportPlan(models, { sourceSchema: 'IFC4' } as never, true);
    assert.equal(plan?.scope, 'merged');
    // v1 converts ONE document into a standalone file. Converting only the
    // selected model would silently drop the rest of the merge; running the
    // merger would silently drop the terrain. Neither is `covered`.
    assert.equal(plan?.covered, false);
    assert.equal(plan?.mergedUnsupported, true, 'and it is distinct from "nothing to convert"');
  });

  it('separates a merge it cannot do from a source it cannot cover', () => {
    const empty = { ...landXmlModel(document({ surfaces: [] })), id: 'm2' };
    const models = new Map([[empty.id, empty]]) as never;
    const plan = landXmlExportPlan(models, { sourceSchema: 'IFC4' } as never, true);
    // Nothing to convert in the first place: the scope is not the problem, so
    // telling the user to change it would send them down a dead end.
    assert.equal(plan?.covered, false);
    assert.equal(plan?.mergedUnsupported, false);
  });
});
