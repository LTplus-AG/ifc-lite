/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { extractStructuralOnDemand } from '../src/structural-extractor.js';

/**
 * The synthetic suite proves each read in isolation; this one proves the whole
 * extraction against a file a real tool wrote — a Constructivity IFC4 export of
 * a three-span continuous beam, carrying an analysis model, curve members,
 * point connections with boundary conditions, an applied curve action, a load
 * case, and a result group of computed reactions.
 */
const FIXTURE = fileURLToPath(
  new URL('../../../tests/models/ifcopenshell/structural_analysis_curve.ifc', import.meta.url),
);

const describeMaybe = existsSync(FIXTURE) ? describe : describe.skip;

describeMaybe('extractStructuralOnDemand — structural_analysis_curve.ifc', () => {
  async function parseFixture() {
    const source = new Uint8Array(readFileSync(FIXTURE));
    const tokenizer = new StepTokenizer(source);
    const entityRefs = Array.from(tokenizer.scanEntitiesFast()).map((ref) => ({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    }));
    const parser = new ColumnarParser();
    return await parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
  }

  it('finds every structural entity the file declares', async () => {
    // Counted directly from the STEP text: 1 analysis model, 3 curve members,
    // 4 point connections, 1 curve action + 6 point reactions + 3 curve
    // reactions = 10 activities, 1 load case, 1 result group.
    const out = extractStructuralOnDemand(await parseFixture());
    expect(out.hasStructural).toBe(true);
    expect(out.analysisModels).toHaveLength(1);
    expect(out.members).toHaveLength(3);
    expect(out.connections).toHaveLength(4);
    expect(out.activities).toHaveLength(10);
    expect(out.loadGroups).toHaveLength(1);
    expect(out.resultGroups).toHaveLength(1);
  });

  it('connects the analysis model to its load case, results and items', async () => {
    const out = extractStructuralOnDemand(await parseFixture());
    const model = out.analysisModels[0];
    expect(model.name).toBe('Structural Analysis #1');
    expect(model.predefinedType).toBe('NOTDEFINED');
    expect(model.loadGroupGlobalIds).toEqual([out.loadGroups[0].globalId]);
    expect(model.resultGroupGlobalIds).toEqual([out.resultGroups[0].globalId]);
    // #239 assigns all 3 members and all 4 connections into the model.
    expect(model.itemGlobalIds).toHaveLength(7);
  });

  it('joins each curve member to the two point connections it spans', async () => {
    const out = extractStructuralOnDemand(await parseFixture());
    for (const member of out.members) {
      expect(member.type).toBe('IfcStructuralCurveMember');
      expect(member.predefinedType).toBe('RIGID_JOINED_MEMBER');
      expect(member.connectionGlobalIds).toHaveLength(2);
      expect(member.analysisModelGlobalIds).toEqual([out.analysisModels[0].globalId]);
    }
    // The beam is continuous: the two interior connections are each shared by
    // two members, the two end connections by one. A member↔connection read in
    // one direction only would not reproduce that 6-edge shape.
    const degrees = out.connections.map((c) => c.memberGlobalIds.length).sort();
    expect(degrees).toEqual([1, 1, 2, 2]);
  });

  it('separates the one applied action from the nine computed reactions', async () => {
    const out = extractStructuralOnDemand(await parseFixture());
    const actions = out.activities.filter((a) => a.kind === 'Action');
    const reactions = out.activities.filter((a) => a.kind === 'Reaction');
    expect(actions).toHaveLength(1);
    expect(reactions).toHaveLength(9);
    expect(actions[0].type).toBe('IfcStructuralCurveAction');
    expect(actions[0].predefinedType).toBe('LINEAR');
    expect(actions[0].globalOrLocal).toBe('GLOBAL_COORDS');
    expect(actions[0].destabilizingLoad).toBe(false);
    // The action is assigned into the load case, the reactions into the
    // result group — not the other way round.
    expect(actions[0].groupGlobalIds).toEqual([out.loadGroups[0].globalId]);
    for (const r of reactions) {
      expect(r.groupGlobalIds).toEqual([out.resultGroups[0].globalId]);
    }
  });

  it('resolves the applied load down to its named measure components', async () => {
    const out = extractStructuralOnDemand(await parseFixture());
    const action = out.activities.find((a) => a.kind === 'Action');
    const load = action?.appliedLoad;
    expect(load?.type).toBe('IfcStructuralLoadConfiguration');
    // #327/#329 = IFCSTRUCTURALLOADLINEARFORCE(.,$,$,-100.,$,$,$): the third
    // measure slot is LinearForceZ, not LinearForceY.
    expect(load?.configuration?.truncated).toBe(false);
    expect(
      load?.configuration?.entries.map((e) => [e.location, e.value?.components, e.dropped]),
    ).toEqual([
      [[96], { LinearForceZ: -100 }, undefined],
      [[192], { LinearForceZ: -100 }, undefined],
    ]);
  });

  it('reads the fixed supports as boolean stiffness, not as the number 1', async () => {
    const out = extractStructuralOnDemand(await parseFixture());
    const fixed = out.connections.filter((c) => c.appliedCondition !== undefined);
    // Two of the four point connections carry an IfcBoundaryNodeCondition.
    expect(fixed).toHaveLength(2);
    for (const c of fixed) {
      expect(c.appliedCondition?.type).toBe('IfcBoundaryNodeCondition');
      expect(c.appliedCondition?.name).toBe('Fixed');
      expect(c.appliedCondition?.components).toEqual({
        TranslationalStiffnessX: true,
        TranslationalStiffnessY: true,
        TranslationalStiffnessZ: true,
        RotationalStiffnessX: true,
        RotationalStiffnessY: true,
        RotationalStiffnessZ: true,
      });
    }
  });

  it('links the result group back to the load case it solved', async () => {
    const out = extractStructuralOnDemand(await parseFixture());
    const results = out.resultGroups[0];
    expect(results.theoryType).toBe('FIRST_ORDER_THEORY');
    expect(results.isLinear).toBe(true);
    expect(results.resultForLoadGroupGlobalId).toBe(out.loadGroups[0].globalId);
    expect(out.loadGroups[0].type).toBe('IfcStructuralLoadCase');
    expect(out.loadGroups[0].selfWeightCoefficients).toEqual([0, 0, 0]);
  });
});
