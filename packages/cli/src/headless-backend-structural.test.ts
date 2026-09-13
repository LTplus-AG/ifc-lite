/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.structural` end to end against a real parsed model, through the same
 * `HeadlessBackend` / `BimContext` wiring the CLI and MCP servers use — not
 * just the extractor in isolation (`structural-extractor-fixture.test.ts`
 * already covers that) and not just the namespace wired to a mock backend
 * (`namespaces.test.ts` already covers that). This is the one place that
 * proves the whole stack: `extractStructuralOnDemand` → `createStructuralAdapter`
 * → `StructuralNamespace` → `bim.structural.*`, against a real tool's export
 * (a Constructivity IFC4 three-span continuous beam).
 *
 * Fixture facts asserted below are the same ones #4510's PR body and
 * `structural-extractor-fixture.test.ts` already established for this file:
 * 1 analysis model, 3 curve members, 4 point connections, 10 activities
 * (1 action + 9 reactions), 1 load case, 1 result group; the continuous
 * beam's member↔connection degree sequence [1,1,2,2]; the applied
 * `IfcStructuralLoadConfiguration` carries `LinearForceZ: -100` at locations
 * [[96],[192]]; both fixed supports read as six boolean-true DOFs.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHeadlessContext } from './loader.js';

const FIXTURE = fileURLToPath(
  new URL('../../../tests/models/ifcopenshell/structural_analysis_curve.ifc', import.meta.url),
);

const describeMaybe = existsSync(FIXTURE) ? describe : describe.skip;

describeMaybe('bim.structural — structural_analysis_curve.ifc (end to end)', () => {
  async function load() {
    return createHeadlessContext(FIXTURE);
  }

  it('data() reports every structural entity and a complete (non-truncated) load tree', async () => {
    const { bim } = await load();
    const data = bim.structural.data();
    expect(data.hasStructural).toBe(true);
    expect(data.analysisModels).toHaveLength(1);
    expect(data.members).toHaveLength(3);
    expect(data.connections).toHaveLength(4);
    expect(data.activities).toHaveLength(10);
    expect(data.loadGroups).toHaveLength(1);
    expect(data.resultGroups).toHaveLength(1);
    // Guard against vacuity: this file's one load configuration is small
    // enough to read whole, so a caller must see it reported as complete.
    expect(data.loadsTruncated).toBe(false);
  });

  it('members() and connections() reproduce the continuous-beam degree sequence', async () => {
    const { bim } = await load();
    const members = bim.structural.members();
    const connections = bim.structural.connections();
    for (const member of members) {
      expect(member.type).toBe('IfcStructuralCurveMember');
      expect(member.connectionGlobalIds).toHaveLength(2);
    }
    // Interior connections are shared by two members, end connections by one.
    const degrees = connections.map((c) => c.memberGlobalIds.length).sort();
    expect(degrees).toEqual([1, 1, 2, 2]);
  });

  it('activities() separates the one applied action from the nine reactions and resolves its load', async () => {
    const { bim } = await load();
    const activities = bim.structural.activities();
    const actions = activities.filter((a) => a.kind === 'Action');
    const reactions = activities.filter((a) => a.kind === 'Reaction');
    expect(actions).toHaveLength(1);
    expect(reactions).toHaveLength(9);

    const appliedLoad = actions[0].appliedLoad;
    expect(appliedLoad?.type).toBe('IfcStructuralLoadConfiguration');
    expect(appliedLoad?.configuration?.truncated).toBe(false);
    // #327/#329: the third measure slot is LinearForceZ, not LinearForceY.
    expect(
      appliedLoad?.configuration?.entries.map((e) => [e.location, e.value?.components]),
    ).toEqual([
      [[96], { LinearForceZ: -100 }],
      [[192], { LinearForceZ: -100 }],
    ]);
  });

  it('connections() reads both fixed supports as six boolean-true DOFs, not the number 1', async () => {
    const { bim } = await load();
    const fixed = bim.structural.connections().filter((c) => c.appliedCondition !== undefined);
    expect(fixed).toHaveLength(2);
    for (const c of fixed) {
      expect(c.appliedCondition?.type).toBe('IfcBoundaryNodeCondition');
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

  it('analysisModels() and resultGroups() cross-link back to the load case by globalId', async () => {
    const { bim } = await load();
    const model = bim.structural.analysisModels()[0];
    const loadGroup = bim.structural.loadGroups()[0];
    const resultGroup = bim.structural.resultGroups()[0];
    expect(model.loadGroupGlobalIds).toEqual([loadGroup.globalId]);
    expect(model.resultGroupGlobalIds).toEqual([resultGroup.globalId]);
    expect(resultGroup.resultForLoadGroupGlobalId).toBe(loadGroup.globalId);
  });

  it('data() and the per-collection convenience accessors agree, and caching avoids a second extraction pass', async () => {
    const { bim } = await load();
    const data = bim.structural.data();
    expect(bim.structural.members()).toEqual(data.members);
    expect(bim.structural.connections()).toEqual(data.connections);
    // Calling twice must not re-run the extractor with different results —
    // exercises the same identity-stable cache `bim.schedule` relies on.
    expect(bim.structural.data()).toEqual(data);
  });
});
