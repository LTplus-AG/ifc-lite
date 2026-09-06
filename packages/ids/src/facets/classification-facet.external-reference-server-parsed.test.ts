/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3954: `appendExternalReferenceClassifications`
 * (packages/ids/src/bridge/classifications.ts) is the only path that
 * resolves classifications attached via `IfcExternalReferenceRelationship`
 * — the mechanism non-rooted resources (`IfcMaterial`, `IfcProfileDef`) use
 * INSTEAD of `IfcRelAssociatesClassification`. It used to bail whenever the
 * store had no raw STEP bytes, silently returning nothing — a genuinely
 * classified material was indistinguishable from an unclassified one, both
 * reported as `CLASSIFICATION_MISSING`.
 *
 * Unlike the sibling `IfcRelAssociatesClassification` path (#3948/#3951),
 * there is no relationship-graph fallback here at all: the server pipeline's
 * `IfcTypeEnum` (packages/data/src/types.ts) has no slot for
 * `IfcExternalReferenceRelationship`, `IfcMaterial` or `IfcProfileDef`, and
 * the server resolves classifications only via `IfcRelAssociatesClassification`
 * (confirmed by PR #3959, which explicitly leaves this pathway "unchanged —
 * out of scope"). So presence cannot be proven OR disproven on a
 * server-parsed store — the honest result is `CLASSIFICATION_UNRESOLVED`,
 * not `CLASSIFICATION_MISSING`.
 *
 * These stores are built from a REAL `IfcParser().parseColumnar` result (the
 * same "genuinely classified" ground truth `classifications.test.ts` uses
 * for the source-bearing path), then have `source` wiped to empty — matching
 * the documented supported state `serverDataModel.ts` produces
 * (`EMPTY_SOURCE_BYTES`) — rather than a store hand-built to fit the fix's
 * own assumptions.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { checkClassificationFacet } from './classification-facet.js';
import type { IDSClassificationFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

const HEADER = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;`;
const FOOTER = `ENDSEC;
END-ISO-10303-21;`;

async function realStore(ifc: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(
    new TextEncoder().encode(ifc).buffer,
    { disableWorkerScan: true },
  );
}

/**
 * Simulates a server-parsed store: the same entity/relationship data a full
 * (source-bearing) parse resolves, but `source` wiped to empty and the
 * on-demand classification map dropped — exactly the two conditions
 * `serverDataModel.ts` produces (no raw bytes, no client-side parse map).
 */
function asServerParsed(store: IfcDataStore): IfcDataStore {
  return {
    ...store,
    source: EMPTY_SOURCE_BYTES,
    onDemandClassificationMap: undefined,
  } as IfcDataStore;
}

const presenceFacet: IDSClassificationFacet = { type: 'classification' };
const valueFacet: IDSClassificationFacet = {
  type: 'classification',
  value: sv('Pr_20_93_08'),
};

const MATERIAL_IFC = `${HEADER}
#10=IFCMATERIAL('Concrete C30/37',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'Pr_20_93_08','Concrete',#22,$,$);
#22=IFCCLASSIFICATION($,$,$,'Uniclass 2015',$,$,$);
${FOOTER}`;

const UNCLASSIFIED_MATERIAL_IFC = `${HEADER}
#10=IFCMATERIAL('Uncoated Material',$,$);
${FOOTER}`;

describe('appendExternalReferenceClassifications on a server-parsed (source-empty) store (#3954)', () => {
  it('control: the source-bearing (WASM) path resolves the real classification untouched', async () => {
    const full = await realStore(MATERIAL_IFC);
    const accessor = createDataAccessor(full);
    expect(accessor.getClassifications(10)).toEqual([
      { system: 'Uniclass 2015', value: 'Pr_20_93_08', name: 'Concrete' },
    ]);
  });

  it('RED (pre-fix): a genuinely classified material reports CLASSIFICATION_UNRESOLVED, never CLASSIFICATION_MISSING, for a presence-only facet', async () => {
    const server = asServerParsed(await realStore(MATERIAL_IFC));
    const accessor = createDataAccessor(server);
    const result = checkClassificationFacet(presenceFacet, 10, accessor);

    expect(result.passed).toBe(false);
    // The honest answer: we cannot determine presence via this pathway on
    // this data source. Before the fix this silently returned `[]`, which
    // reads identically to a genuinely unclassified entity.
    expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');
    expect(result.failure?.type).not.toBe('CLASSIFICATION_MISSING');
  });

  it('a value-constrained facet on the same entity also reports CLASSIFICATION_UNRESOLVED, not a fabricated match or mismatch', async () => {
    const server = asServerParsed(await realStore(MATERIAL_IFC));
    const accessor = createDataAccessor(server);
    const result = checkClassificationFacet(valueFacet, 10, accessor);

    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');
    expect(result.failure?.type).not.toBe('CLASSIFICATION_VALUE_MISMATCH');
    expect(result.failure?.type).not.toBe('CLASSIFICATION_MISSING');
  });

  it('control: an IfcMaterial with genuinely no IfcExternalReferenceRelationship ALSO reports CLASSIFICATION_UNRESOLVED, not a fabricated MISSING', async () => {
    // A server-parsed store cannot prove OR disprove presence for this
    // pathway (#3954) — a material with zero external-ref relationships in
    // THIS model is just as unprovable as one classified through an edge the
    // store can't represent. Reporting MISSING here would be exactly the
    // fabricated-negative half of the bug this issue fixes: a confident
    // "unclassified" this data source never actually verified.
    const server = asServerParsed(await realStore(UNCLASSIFIED_MATERIAL_IFC));
    const accessor = createDataAccessor(server);
    const result = checkClassificationFacet(presenceFacet, 10, accessor);

    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');
  });

  it('control: a rooted entity type that can never carry an IfcExternalReferenceRelationship classification (schema-excluded) still reports CLASSIFICATION_MISSING', async () => {
    // IfcWall is an IfcRoot subtype, never a RelatedResourceObjects target —
    // the schema rules out this pathway for it entirely, with no data
    // needed. Applying the #3954 fallback here would regress the ordinary
    // "genuinely unclassified element" case into a false CLASSIFICATION_UNRESOLVED
    // on every server-parsed model.
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
${FOOTER}`;
    const server = asServerParsed(await realStore(ifc));
    const accessor = createDataAccessor(server);
    const result = checkClassificationFacet(presenceFacet, 1, accessor);

    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_MISSING');
  });

  it('the CLASSIFICATION_UNRESOLVED failure never claims the entity IS classified (no overclaiming presence)', async () => {
    const server = asServerParsed(await realStore(MATERIAL_IFC));
    const accessor = createDataAccessor(server);
    const result = checkClassificationFacet(presenceFacet, 10, accessor);

    expect(result.failure?.field).toBe('presence');
    expect(result.failure?.context?.reason).not.toMatch(/entity is classified,/i);
  });

  it('does not regress the sibling IfcRelAssociatesClassification path\'s own #3951 presence-only PASS on the same server-parsed store', async () => {
    // A rooted entity (IfcWall) classified via IfcRelAssociatesClassification
    // — the pathway #3951 already fixed. Its relationship-graph edge PROVES
    // presence even without source bytes, so a presence-only facet must stay
    // a confident PASS. This must not be diluted into CLASSIFICATION_UNRESOLVED
    // by the unrelated, always-added external-reference `presenceUnknown`
    // fallback — the fix only applies that fallback when the sibling path
    // found NOTHING (`list.length === 0`), which isn't the case here.
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#2=IFCRELASSOCIATESCLASSIFICATION('gid2',$,$,$,(#1),#3);
#3=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',#4,$,$);
#4=IFCCLASSIFICATION($,$,$,'Uniclass 2015',$,$,$);
${FOOTER}`;
    const full = await realStore(ifc);
    const fullAccessor = createDataAccessor(full);
    // Ground truth: a real, fully-resolved classification on the wall.
    expect(fullAccessor.getClassifications(1)).toEqual([
      { system: 'Uniclass 2015', value: 'Ss_25_10', name: 'Walls' },
    ]);

    const server = asServerParsed(full);
    const accessor = createDataAccessor(server);
    const result = checkClassificationFacet(presenceFacet, 1, accessor);
    expect(result.passed).toBe(true);

    // A value-constrained facet on the SAME entity still correctly reports
    // CLASSIFICATION_UNRESOLVED (per #3951 — the value genuinely can't be
    // read on this data source), with the "confirmed classified" wording,
    // not the new "presence unknown" one — the fix must not change which
    // `field` this pre-existing, correct case reports.
    const valueMatchFacet: IDSClassificationFacet = {
      type: 'classification',
      value: sv('Ss_25_10'),
    };
    const valueResult = checkClassificationFacet(valueMatchFacet, 1, accessor);
    expect(valueResult.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');
    expect(valueResult.failure?.field).toBe('value');
  });
});
