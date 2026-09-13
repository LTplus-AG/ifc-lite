/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { clashReviewKey, type Clash, type ClashResult } from '@ifc-lite/clash';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { buildClashTable, exportClashTableCsv } from './export-table.js';

/**
 * A real parsed store: the storey comes from `IfcRelContainedInSpatialStructure`
 * through the columnar parser's spatial hierarchy, which is the lookup the
 * export resolves storeys through. A hand-shaped hierarchy would test the
 * fixture, not the resolution (#3944).
 */
const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building00000000000003',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.);
#11=IFCRELAGGREGATES('0Agg000000000000000011',$,$,$,#1,(#2));
#12=IFCRELAGGREGATES('0Agg000000000000000012',$,$,$,#2,(#3));
#13=IFCRELAGGREGATES('0Agg000000000000000013',$,$,$,#3,(#5));
#42=IFCWALL('0Wall00000000000000042',$,'Wall A',$,$,$,$,$,$);
#43=IFCBEAM('0Beam00000000000000043',$,'Beam, B',$,$,$,$,$,$);
#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000090',$,$,$,(#42,#43),#5);
ENDSEC;
END-ISO-10303-21;
`;

const OFFSET = 1_000_000;

async function parsedModel(id: string, name: string, idOffset: number): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store: IfcDataStore = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return { ...fixtureModel(id, { idOffset }), name, ifcDataStore: store, maxExpressId: 90 };
}

function clashBetween(model: string, idOffset: number, id: string): Clash {
  return {
    id,
    a: { key: '0Wall00000000000000042', ref: idOffset + 42, model, tag: 'IfcWall', name: 'Wall A' },
    b: { key: '0Beam00000000000000043:occ-1', ref: idOffset + 43, model, tag: 'IfcBeam', name: 'Beam, B' },
    rule: 'str-vs-str',
    status: 'hard',
    distance: -0.12,
    distanceKind: 'mesh',
    point: [1, 2, 3],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'major',
  };
}

function resultOf(clashes: Clash[]): ClashResult {
  return {
    clashes,
    summary: { total: clashes.length, byRule: {}, byTypePair: {}, bySeverity: { critical: 0, major: clashes.length, minor: 0, info: 0 } },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

describe('clash table export (#3944)', () => {
  beforeEach(() => {
    useViewerStore.setState({ clashResult: null, clashGroups: null, clashReviews: new Map(), models: new Map(), activeModelId: null });
  });

  it('returns null with no run, so the caller can disable the action rather than download an empty file', () => {
    assert.strictEqual(buildClashTable(), null);
    assert.strictEqual(exportClashTableCsv(() => assert.fail('nothing to emit')), null);
  });

  it('resolves storey and model name through the federation for an offset model, joins the review, and bares the GUIDs', async () => {
    const model = await parsedModel('m-str', 'structure.ifc', OFFSET);
    const clash = clashBetween('m-str', OFFSET, 'c1');
    useViewerStore.setState({
      models: new Map([[model.id, model]]),
      activeModelId: model.id,
      clashResult: resultOf([clash]),
      clashReviews: new Map([[clashReviewKey(clash), { status: 'resolved', comment: 'moved beam', updatedAt: Date.UTC(2026, 8, 12) }]]),
    });

    const rows = buildClashTable();
    assert.ok(rows);
    assert.strictEqual(rows.length, 1);
    const [row] = rows;
    assert.strictEqual(row.StoreyA, 'Level 2');
    assert.strictEqual(row.StoreyB, 'Level 2');
    assert.strictEqual(row.ModelA, 'structure.ifc');
    assert.strictEqual(row.GlobalIdA, '0Wall00000000000000042');
    assert.strictEqual(row.GlobalIdB, '0Beam00000000000000043');
    assert.strictEqual(row.KeyB, '0Beam00000000000000043:occ-1');
    assert.strictEqual(row.Review, 'resolved');
    assert.strictEqual(row.ReviewComment, 'moved beam');
    assert.strictEqual(row.Distance, -0.12);
  });

  it('leaves the storey empty when the element cannot be resolved in its model, instead of guessing', async () => {
    const model = await parsedModel('m-str', 'structure.ifc', OFFSET);
    // A ref outside the model's id range: the run outlived a reload that
    // reassigned ids, or the element sits in a model that is gone.
    const clash = clashBetween('m-str', OFFSET + 500_000, 'stale');
    useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id, clashResult: resultOf([clash]) });
    const [row] = buildClashTable() ?? [];
    assert.strictEqual(row.StoreyA, '');
    assert.strictEqual(row.GlobalIdA, '0Wall00000000000000042');
  });

  it('downloads an RFC 4180 CSV named after the active model with every column and the name quoted', async () => {
    const model = await parsedModel('m-str', 'structure.ifc', OFFSET);
    useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id, clashResult: resultOf([clashBetween('m-str', OFFSET, 'c1')]) });

    const emitted: Array<{ content: string; filename: string; mime: string }> = [];
    const outcome = exportClashTableCsv((content, filename, mime) => emitted.push({ content, filename, mime }));

    assert.deepStrictEqual(outcome, { rows: 1, filename: 'structure-clashes.csv' });
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].mime, 'text/csv');
    const [header, line, trailing] = emitted[0].content.split('\n');
    assert.strictEqual(header.split(',')[0], 'ClashId');
    assert.ok(header.includes('GlobalIdA,GlobalIdB'));
    assert.ok(line.includes('"Beam, B"'), line);
    assert.ok(line.includes('Level 2,Level 2'), line);
    assert.strictEqual(trailing, '');
  });
});
