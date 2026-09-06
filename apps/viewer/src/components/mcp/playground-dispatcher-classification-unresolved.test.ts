/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The playground's own `makeIdsAccessor().getClassifications` (used by the
 * `ids_validate` tool, the chat agent's IDS check) is a SEPARATE
 * reimplementation of `IFCDataAccessor` from `@ifc-lite/ids`'s
 * `createDataAccessor` (packages/ids/src/bridge/data-accessor.ts) — the same
 * "two paths that must agree" shape already caught once for materials (see
 * playground-dispatcher-materials.test.ts).
 *
 * Issue #3948 added a tri-state `unresolved` marker to `ClassificationInfo`
 * so a classified-but-unreadable entity (server-parsed / source-empty store)
 * can be told apart from a genuinely unclassified one. The canonical bridge
 * (`resolveClassifications` / `createDataAccessor`) forwards `unresolved`.
 * The playground's own `makeIdsAccessor` does not: it rebuilds a plain
 * object literal from `m.bim.classifications(...)` and drops the
 * `unresolved` field, so a classified-but-unresolved entity looks to the
 * IDS engine like a REAL classification with `system: ''` / `value: ''` —
 * which a system/value-constrained facet then reports as a genuine
 * CLASSIFICATION_SYSTEM_MISMATCH / CLASSIFICATION_VALUE_MISMATCH instead of
 * the honest CLASSIFICATION_UNRESOLVED the same fixture reports via the
 * canonical bridge (packages/ids/src/facets/classification-facet.server-parsed.test.ts).
 *
 * A normally-parsed (source-bearing) model never hits this: `source` is
 * always populated in that case, so this test simulates the server-parsed
 * shape the way #3948's own fixtures do — parse a real model (so the
 * relationship graph is genuine), then strip the fields a server-parsed
 * store never has (`source`, `onDemandClassificationMap`) so the resolver's
 * existing fallback path is what runs, not a hand-built assumption.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch, parsePlaygroundModel, type LoadedPlaygroundModel } from './playground-dispatcher.js';

function ifc4(body: string): string {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', body, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

const CLASSIFIED_WALL = ifc4(`
#100=IFCWALL('0Wall0000000000000001',$,'Wall A',$,$,$,$,$,$);
#300=IFCCLASSIFICATION('Uniclass',$,$,'Uniclass 2015');
#310=IFCCLASSIFICATIONREFERENCE('','Ss_25_10','Some Name',#300,$,$);
#320=IFCRELASSOCIATESCLASSIFICATION('0RelCls00000000000001',$,$,$,(#100),#310);
`);

const SYSTEM_IDS_XML = `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>System check</title></info>
  <specifications>
    <specification name="Uniclass required" ifcVersion="IFC4" minOccurs="1" maxOccurs="unbounded">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <classification><system><simpleValue>Uniclass 2015</simpleValue></system></classification>
      </requirements>
    </specification>
  </specifications>
</ids>`;

/** Force the parsed model's store into a server-parsed shape: no source
 *  bytes, no on-demand classification map — the same condition that makes
 *  `extractClassificationsOnDemand` fall back to the relationship graph and
 *  report `unresolved: true` (issue #3948). The relationship edge itself
 *  (`IfcRelAssociatesClassification`) is genuine — built by the real parser
 *  from the fixture above — not fabricated. */
function toServerParsedShape(model: LoadedPlaygroundModel): void {
  const store = model.store as unknown as { source?: Uint8Array; onDemandClassificationMap?: unknown };
  store.source = new Uint8Array(0);
  store.onDemandClassificationMap = undefined;
}

async function runSystemCheck(): Promise<{ status: string; failureType?: string; failureReason?: string }> {
  const model = await parsePlaygroundModel(
    new TextEncoder().encode(CLASSIFIED_WALL).buffer as ArrayBuffer,
    'fixture.ifc',
  );
  toServerParsedShape(model);
  const result = await dispatch(model, 'ids_validate', { ids_xml: SYSTEM_IDS_XML });
  assert.equal(result.isError, false, `ids_validate should not error: ${result.text}`);
  const report = result.structured as {
    specificationResults: Array<{
      status: string;
      entityResults: Array<{ requirementResults: Array<{ status: string; failure?: { type: string }; failureReason?: string }> }>;
    }>;
  };
  const req = report.specificationResults[0]?.entityResults[0]?.requirementResults[0];
  return { status: req?.status ?? '(none)', failureType: req?.failure?.type, failureReason: req?.failureReason };
}

describe('playground ids_validate — classification facet on a server-parsed-shaped store (#3948/#3951)', () => {
  it('reports CLASSIFICATION_UNRESOLVED, not a fabricated SYSTEM_MISMATCH, for a classified-but-unresolved entity', async () => {
    const { status, failureType, failureReason } = await runSystemCheck();
    assert.equal(status, 'fail', 'entity IS classified but unreadable here, so the facet cannot pass');
    assert.equal(
      failureType,
      'CLASSIFICATION_UNRESOLVED',
      `expected an honest "cannot verify" reason, got ${failureType} (${failureReason}) — ` +
        'the playground\'s own IDS accessor dropped the unresolved marker, making the entity ' +
        'look like a real classification with an empty system, which reads as a genuine mismatch',
    );
    assert.notEqual(failureType, 'CLASSIFICATION_SYSTEM_MISMATCH');
    assert.notEqual(failureType, 'CLASSIFICATION_MISSING');
  });
});
