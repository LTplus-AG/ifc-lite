/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #5227: on a server-parsed store (no `source` bytes) the relationship
 * graph still proves which elements carry an IfcRelAssociatesMaterial, but
 * `extractAllMaterialsOnDemand` returned `[]` before consulting it. A
 * materially-associated element then read exactly like an unmaterialed one:
 * MATERIAL_MISSING for both.
 *
 * The contract now mirrors the classification facet's `unresolved` (#3948).
 * A proven association satisfies a presence-only facet. It cannot satisfy or
 * mismatch a value, so a value check reports MATERIAL_UNRESOLVED, and that
 * FAILS, even under a prohibition. "Cannot verify" is never a pass.
 *
 * Every buildingSMART material corpus model is run twice, once fully parsed
 * and once with its source bytes dropped (the server-parsed shape, as
 * `classification-cardinality-unresolved.test.ts` builds it), and the two
 * reports are compared entity by entity.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SOURCE_BYTES, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { checkMaterialFacet } from './material-facet.js';
import type { IDSDocument, IDSMaterialFacet, IDSValidationReport } from '../types.js';

// Vitest runs in packages/ids and may rewrite import.meta.url to a data URL.
const MATERIAL_CORPUS = resolve(process.cwd(), 'src/__corpus__/buildingsmart-ids/material');

interface CasePair {
  name: string;
  document: IDSDocument;
  full: IDSValidationReport;
  sourceEmpty: IDSValidationReport;
}

async function runCase(name: string): Promise<CasePair> {
  const document = parseIDS(readFileSync(resolve(MATERIAL_CORPUS, `${name}.ids`), 'utf-8'));
  const bytes = readFileSync(resolve(MATERIAL_CORPUS, `${name}.ifc`));
  const full: IfcDataStore = await new IfcParser().parseColumnar(Uint8Array.from(bytes).buffer, {
    disableWorkerScan: true,
  });
  const empty: IfcDataStore = { ...full, source: EMPTY_SOURCE_BYTES, onDemandMaterialMap: undefined };
  const info = (store: IfcDataStore) => ({ modelId: name, schemaVersion: 'IFC4', entityCount: store.entityCount });
  return {
    name,
    document,
    full: await validateIDS(document, createDataAccessor(full), info(full)),
    sourceEmpty: await validateIDS(document, createDataAccessor(empty), info(empty)),
  };
}

describe('IDS material facet on a server-parsed (source-empty) store (#5227)', () => {
  const cases: CasePair[] = [];
  beforeAll(async () => {
    const names = readdirSync(MATERIAL_CORPUS)
      .filter((f) => f.endsWith('.ids') && !f.startsWith('invalid-'))
      .map((f) => f.slice(0, -'.ids'.length));
    for (const name of names) cases.push(await runCase(name));
  }, 120_000);

  it('runs every material corpus pair (not vacuous)', () => {
    expect(cases.length).toBe(29);
  });

  it('never reports MATERIAL_MISSING for an element the full parse found a material on', () => {
    let checked = 0;
    for (const c of cases) {
      c.sourceEmpty.specificationResults.forEach((spec, s) => {
        for (const entity of spec.entityResults) {
          const fullEntity = c.full.specificationResults[s].entityResults.find((e) => e.expressId === entity.expressId);
          entity.requirementResults.forEach((r, i) => {
            if (r.failure?.type !== 'MATERIAL_MISSING') return;
            checked++;
            expect(fullEntity?.requirementResults[i].failure?.type, `${c.name} #${entity.expressId}`).toBe('MATERIAL_MISSING');
          });
        }
      });
    }
    expect(checked, 'some genuinely unmaterialed elements are in the corpus').toBeGreaterThan(0);
  });

  it('a value check it cannot read fails as MATERIAL_UNRESOLVED, whatever the optionality', () => {
    let unresolved = 0;
    for (const c of cases) {
      for (const spec of c.sourceEmpty.specificationResults) {
        for (const entity of spec.entityResults) {
          for (const r of entity.requirementResults) {
            if (r.failure?.type !== 'MATERIAL_UNRESOLVED') continue;
            unresolved++;
            expect(r.status, `${c.name} (${r.requirement.optionality})`).toBe('fail');
            expect(r.failureReason).toMatch(/cannot be read from this data source/);
          }
        }
      }
    }
    expect(unresolved).toBeGreaterThan(0);
  });

  it('never turns a failing specification into a pass', () => {
    for (const c of cases) {
      c.full.specificationResults.forEach((spec, s) => {
        if (spec.status === 'fail') expect(c.sourceEmpty.specificationResults[s].status, c.name).toBe('fail');
      });
    }
  });

  it('a presence-only facet passes on the proven association, as with a readable material', () => {
    const presence = cases.filter((c) =>
      c.document.specifications.some((spec) =>
        spec.requirements.some((r) => r.facet.type === 'material' && !r.facet.value && r.optionality === 'required'),
      ),
    );
    expect(presence.length).toBeGreaterThan(0);
    for (const c of presence) {
      expect(c.sourceEmpty.specificationResults.map((s) => s.status), c.name).toEqual(
        c.full.specificationResults.map((s) => s.status),
      );
    }
  });
});

describe('checkMaterialFacet on a graph-only store (#5227)', () => {
  // #200 = IfcRelAssociatesMaterial relating material #300 to wall #100, as
  // `apps/viewer/src/utils/serverDataModel.ts` builds the graph.
  function serverStore(): IfcDataStore {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(300, 100, RelationshipType.AssociatesMaterial, 200);
    return {
      source: EMPTY_SOURCE_BYTES,
      entityIndex: { byId: new Map(), byType: new Map() },
      relationships: builder.build(),
      onDemandMaterialMap: undefined,
    } as unknown as IfcDataStore;
  }
  const concrete: IDSMaterialFacet = { type: 'material', value: { type: 'simpleValue', value: 'Concrete' } };

  it('associated element: presence passes, a value is MATERIAL_UNRESOLVED', () => {
    const accessor = createDataAccessor(serverStore());
    expect(checkMaterialFacet({ type: 'material' }, 100, accessor).passed).toBe(true);
    const value = checkMaterialFacet(concrete, 100, accessor);
    expect(value.passed).toBe(false);
    expect(value.failure?.type).toBe('MATERIAL_UNRESOLVED');
  });

  it('unassociated element: MATERIAL_MISSING for both, so the two are distinguishable', () => {
    const accessor = createDataAccessor(serverStore());
    expect(checkMaterialFacet({ type: 'material' }, 999, accessor).failure?.type).toBe('MATERIAL_MISSING');
    expect(checkMaterialFacet(concrete, 999, accessor).failure?.type).toBe('MATERIAL_MISSING');
  });
});
