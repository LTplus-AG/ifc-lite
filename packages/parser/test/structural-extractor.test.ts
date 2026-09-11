/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { extractStructuralOnDemand } from '../src/structural-extractor.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { StructuralLoadInfo } from '../src/structural-load-extractor.js';
import type { EntityRef } from '../src/types.js';

/**
 * Minimal in-memory IfcDataStore builder — same helper shape as the schedule
 * extractor suite, so both non-product domains are exercised through one kind
 * of store rather than two.
 */
function buildStoreFromStep(
  lines: string[],
  opts?: { schemaVersion?: IfcDataStore['schemaVersion'] },
): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);

  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  let cursor = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (!match) continue;
    const expressId = parseInt(match[1], 10);
    const type = match[2];
    const idx = text.indexOf(line, cursor);
    const byteOffset = idx >= 0 ? idx : cursor;
    byId.set(expressId, {
      expressId,
      type,
      byteOffset,
      byteLength: line.length,
      lineNumber: 1,
    });
    const typeUpper = type.toUpperCase();
    let list = byType.get(typeUpper);
    if (!list) {
      list = [];
      byType.set(typeUpper, list);
    }
    list.push(expressId);
    cursor = byteOffset + line.length + 1; // +1 for newline
  }

  return {
    source,
    schemaVersion: opts?.schemaVersion ?? 'IFC4',
    entityIndex: { byId, byType },
    entities: {
      getGlobalId: (id: number) => String(id),
      getName: (id: number) => `entity${id}`,
    },
  } as unknown as IfcDataStore;
}

/**
 * One analysis model holding two curve members joined at a shared point
 * connection, a linear action on the second member with a load configuration,
 * and a point reaction on the connection — deliberately asymmetric so that a
 * relationship read in the wrong direction cannot still pass.
 *
 * The member↔connection wiring is intentionally NOT commutative: member A
 * (#10) is joined to connection #30 only, member B (#11) to both #30 and #31.
 * Swapping RelatingStructuralMember and RelatedStructuralConnection therefore
 * produces a different answer rather than the same one.
 */
const MODEL = [
  "#1=IFCSTRUCTURALANALYSISMODEL('model-gid',$,'Frame',$,$,.LOADING_3D.,$,(#40),(#50),$);",
  "#10=IFCSTRUCTURALCURVEMEMBER('member-a',$,'Beam A',$,$,$,$,.RIGID_JOINED_MEMBER.,$);",
  "#11=IFCSTRUCTURALCURVEMEMBER('member-b',$,'Beam B',$,$,$,$,.PIN_JOINED_MEMBER.,$);",
  "#12=IFCSTRUCTURALSURFACEMEMBER('member-c',$,'Slab C',$,$,$,$,.SHELL.,0.25);",
  "#30=IFCSTRUCTURALPOINTCONNECTION('conn-fixed',$,'Support 1',$,$,$,$,#35,$);",
  "#31=IFCSTRUCTURALPOINTCONNECTION('conn-free',$,'Support 2',$,$,$,$,$,$);",
  "#35=IFCBOUNDARYNODECONDITION('Fixed',IFCBOOLEAN(.T.),IFCBOOLEAN(.T.),IFCBOOLEAN(.F.),1500.,$,$);",
  "#40=IFCSTRUCTURALLOADCASE('case-gid',$,'Dead',$,$,.LOAD_CASE.,.PERMANENT_G.,.DEAD_LOAD_G.,1.35,'self weight',(0.,0.,-1.));",
  "#50=IFCSTRUCTURALRESULTGROUP('result-gid',$,'Results',$,$,.FIRST_ORDER_THEORY.,#40,.T.);",
  "#60=IFCSTRUCTURALCURVEACTION('action-gid',$,'UDL',$,$,$,$,#65,.GLOBAL_COORDS.,.F.,$,.CONST.);",
  "#65=IFCSTRUCTURALLOADCONFIGURATION('Span',(#66),((0.),(4.5)));",
  "#66=IFCSTRUCTURALLOADLINEARFORCE('Nominal',$,$,-12.5,$,$,$);",
  "#70=IFCSTRUCTURALPOINTREACTION('reaction-gid',$,'R1',$,$,$,$,#75,.LOCAL_COORDS.);",
  "#75=IFCSTRUCTURALLOADSINGLEFORCE('R',0.,0.,31.25,$,$,$);",
  // member A is joined to conn-fixed only; member B to both.
  "#80=IFCRELCONNECTSSTRUCTURALMEMBER('rel-1',$,$,$,#10,#30,$,$,$,$);",
  "#81=IFCRELCONNECTSSTRUCTURALMEMBER('rel-2',$,$,$,#11,#30,$,$,$,$);",
  "#82=IFCRELCONNECTSSTRUCTURALMEMBER('rel-3',$,$,$,#11,#31,$,$,$,$);",
  // the action applies to member B; the reaction to the fixed connection.
  "#90=IFCRELCONNECTSSTRUCTURALACTIVITY('rel-4',$,$,$,#11,#60);",
  "#91=IFCRELCONNECTSSTRUCTURALACTIVITY('rel-5',$,$,$,#30,#70);",
  // group assignments: items into the model, the action into the load case,
  // the reaction into the result group.
  "#95=IFCRELASSIGNSTOGROUP('rel-6',$,$,$,(#10,#11,#12,#30,#31),.PRODUCT.,#1);",
  "#96=IFCRELASSIGNSTOGROUP('rel-7',$,$,$,(#60),.PRODUCT.,#40);",
  "#97=IFCRELASSIGNSTOGROUP('rel-8',$,$,$,(#70),.PRODUCT.,#50);",
  // The action is ALSO assigned straight into the analysis model, as exporters
  // do. It is not a structural item, so it must not appear in itemGlobalIds.
  "#93=IFCRELASSIGNSTOGROUP('rel-11',$,$,$,(#60),.PRODUCT.,#1);",
  // member-c is ALSO assigned into the load case. A structural group that is
  // not an analysis model must not be reported as the member's analysis model.
  "#94=IFCRELASSIGNSTOGROUP('rel-10',$,$,$,(#12),.PRODUCT.,#40);",
  // A non-structural group sharing IfcRelAssignsToGroup must not leak in.
  "#98=IFCGROUP('zone-gid',$,'Zone',$,$);",
  "#99=IFCRELASSIGNSTOGROUP('rel-9',$,$,$,(#10),.PRODUCT.,#98);",
];

/**
 * A load configuration whose `Locations` is written flat — `(0.,4.5)` instead
 * of the schema's LIST OF LIST `((0.),(4.5))`. Exporters do this; the reader
 * must report no locations rather than inventing one empty row per scalar.
 */
const MALFORMED_LOCATIONS = [
  "#1=IFCSTRUCTURALCURVEACTION('action-gid',$,'UDL',$,$,$,$,#65,.GLOBAL_COORDS.,.F.,$,.CONST.);",
  "#65=IFCSTRUCTURALLOADCONFIGURATION('Span',(#66),(0.,4.5));",
  "#66=IFCSTRUCTURALLOADLINEARFORCE('Nominal',$,$,-12.5,$,$,$);",
];

describe('extractStructuralOnDemand — empty and guard cases', () => {
  it('reports hasStructural=false for a model with no structural entity', () => {
    const store = buildStoreFromStep(["#1=IFCWALL('wall-gid',$,'W',$,$,$,$,$,$);"]);
    const out = extractStructuralOnDemand(store);
    expect(out.hasStructural).toBe(false);
    expect(out.members).toEqual([]);
    expect(out.analysisModels).toEqual([]);
  });

  it('reports hasStructural=false when only the connects-relationships are present', () => {
    // Relationship rows with no structural items to join are not a domain.
    const store = buildStoreFromStep([
      "#80=IFCRELCONNECTSSTRUCTURALMEMBER('rel-1',$,$,$,#10,#30,$,$,$,$);",
    ]);
    expect(extractStructuralOnDemand(store).hasStructural).toBe(false);
  });
});

describe('extractStructuralOnDemand — entities', () => {
  const out = extractStructuralOnDemand(buildStoreFromStep(MODEL));

  it('finds the analysis model with its typed attributes and inverse sets', () => {
    expect(out.hasStructural).toBe(true);
    expect(out.analysisModels).toHaveLength(1);
    const model = out.analysisModels[0];
    expect(model.globalId).toBe('model-gid');
    expect(model.name).toBe('Frame');
    expect(model.predefinedType).toBe('LOADING_3D');
    expect(model.loadGroupGlobalIds).toEqual(['case-gid']);
    expect(model.resultGroupGlobalIds).toEqual(['result-gid']);
  });

  it('classifies members, connections and activities by inheritance, not by name', () => {
    expect(out.members.map((m) => m.globalId).sort()).toEqual([
      'member-a',
      'member-b',
      'member-c',
    ]);
    expect(out.connections.map((c) => c.globalId).sort()).toEqual(['conn-fixed', 'conn-free']);
    expect(out.activities.map((a) => a.globalId).sort()).toEqual(['action-gid', 'reaction-gid']);
    expect(out.loadGroups.map((g) => g.globalId)).toEqual(['case-gid']);
    expect(out.resultGroups.map((g) => g.globalId)).toEqual(['result-gid']);
  });

  it('separates an action from a reaction by its supertype branch', () => {
    const action = out.activities.find((a) => a.globalId === 'action-gid');
    const reaction = out.activities.find((a) => a.globalId === 'reaction-gid');
    expect(action?.kind).toBe('Action');
    expect(reaction?.kind).toBe('Reaction');
    // DestabilizingLoad exists only on the action branch.
    expect(action?.destabilizingLoad).toBe(false);
    expect(reaction?.destabilizingLoad).toBeUndefined();
  });

  it('reads the surface member Thickness that curve members do not carry', () => {
    const slab = out.members.find((m) => m.globalId === 'member-c');
    const beam = out.members.find((m) => m.globalId === 'member-a');
    expect(slab?.thickness).toBe(0.25);
    expect(slab?.predefinedType).toBe('SHELL');
    // IfcStructuralCurveMember has no Thickness attribute; index 8 there is
    // Axis, so a positional read would have returned something.
    expect(beam?.thickness).toBeUndefined();
    expect(beam?.predefinedType).toBe('RIGID_JOINED_MEMBER');
  });

  it('reads the load case enums, coefficient and self-weight vector', () => {
    const group = out.loadGroups[0];
    expect(group.predefinedType).toBe('LOAD_CASE');
    expect(group.actionType).toBe('PERMANENT_G');
    expect(group.actionSource).toBe('DEAD_LOAD_G');
    expect(group.coefficient).toBe(1.35);
    expect(group.purpose).toBe('self weight');
    expect(group.selfWeightCoefficients).toEqual([0, 0, -1]);
  });

  it('reads the result group theory type and its load-group back-reference', () => {
    const group = out.resultGroups[0];
    expect(group.theoryType).toBe('FIRST_ORDER_THEORY');
    expect(group.isLinear).toBe(true);
    expect(group.resultForLoadGroupGlobalId).toBe('case-gid');
  });
});

describe('extractStructuralOnDemand — relationships', () => {
  const out = extractStructuralOnDemand(buildStoreFromStep(MODEL));
  const member = (gid: string) => out.members.find((m) => m.globalId === gid);
  const connection = (gid: string) => out.connections.find((c) => c.globalId === gid);

  it('joins members to connections in the direction the relationship states', () => {
    // Asymmetric on purpose: reading the two attributes the other way round
    // gives member-a two connections and conn-free two members.
    expect(member('member-a')?.connectionGlobalIds).toEqual(['conn-fixed']);
    expect(member('member-b')?.connectionGlobalIds.sort()).toEqual(['conn-fixed', 'conn-free']);
    expect(connection('conn-fixed')?.memberGlobalIds.sort()).toEqual(['member-a', 'member-b']);
    expect(connection('conn-free')?.memberGlobalIds).toEqual(['member-b']);
  });

  it('applies an activity to the item it names, and records the reverse edge', () => {
    expect(member('member-b')?.activityGlobalIds).toEqual(['action-gid']);
    expect(member('member-a')?.activityGlobalIds).toEqual([]);
    expect(connection('conn-fixed')?.activityGlobalIds).toEqual(['reaction-gid']);

    const action = out.activities.find((a) => a.globalId === 'action-gid');
    const reaction = out.activities.find((a) => a.globalId === 'reaction-gid');
    expect(action?.appliesToGlobalId).toBe('member-b');
    expect(reaction?.appliesToGlobalId).toBe('conn-fixed');
  });

  it('assigns items into the analysis model via IfcRelAssignsToGroup', () => {
    expect(out.analysisModels[0].itemGlobalIds.sort()).toEqual([
      'conn-fixed',
      'conn-free',
      'member-a',
      'member-b',
      'member-c',
    ]);
    expect(member('member-a')?.analysisModelGlobalIds).toEqual(['model-gid']);
    // #93 also assigns the action into the model. An action is not a
    // structural item, so itemGlobalIds must stay at the five members and
    // connections even though the model's raw membership is six.
    expect(out.analysisModels[0].itemGlobalIds).not.toContain('action-gid');
    const action = out.activities.find((a) => a.globalId === 'action-gid');
    expect(action?.groupGlobalIds.sort()).toEqual(['case-gid', 'model-gid']);
  });

  it('does not report a load case as a member analysis model', () => {
    // member-c is assigned into both the model (#95) and the load case (#94).
    // Only the model belongs in analysisModelGlobalIds; without that filter a
    // load case would be reported as the member's analysis model.
    expect(member('member-c')?.analysisModelGlobalIds).toEqual(['model-gid']);
  });

  it('does not report a non-structural group as an analysis model', () => {
    // #99 assigns member-a into a plain IfcGroup. That group is not a
    // structural group, so it must reach neither analysisModelGlobalIds nor
    // the extraction at all.
    expect(member('member-a')?.analysisModelGlobalIds).not.toContain('zone-gid');
    expect(out.loadGroups.map((g) => g.globalId)).not.toContain('zone-gid');
  });

  it('assigns the action to its load case and the reaction to its result group', () => {
    expect(out.loadGroups[0].activityGlobalIds).toEqual(['action-gid']);
    expect(out.resultGroups[0].activityGlobalIds).toEqual(['reaction-gid']);
    const action = out.activities.find((a) => a.globalId === 'action-gid');
    expect(action?.groupGlobalIds.sort()).toEqual(['case-gid', 'model-gid']);
  });
});

describe('extractStructuralOnDemand — loads and boundary conditions', () => {
  const out = extractStructuralOnDemand(buildStoreFromStep(MODEL));

  it('resolves an applied load configuration with its nested loads and locations', () => {
    const action = out.activities.find((a) => a.globalId === 'action-gid');
    expect(action?.globalOrLocal).toBe('GLOBAL_COORDS');
    expect(action?.predefinedType).toBe('CONST');

    const load = action?.appliedLoad;
    expect(load?.type).toBe('IfcStructuralLoadConfiguration');
    expect(load?.name).toBe('Span');
    // #65 writes one Values slot against two Locations rows. The slot pairs
    // with the first row; the orphan second row survives on `locations` rather
    // than being dropped or inventing a slot for it.
    expect(load?.configuration?.entries).toHaveLength(1);
    expect(load?.configuration?.entries[0].location).toEqual([0]);
    expect(load?.configuration?.entries[0].value?.components).toEqual({ LinearForceZ: -12.5 });
    expect(load?.configuration?.locations).toEqual([[0], [4.5]]);
    expect(load?.configuration?.truncated).toBe(false);
  });

  it('names every load component by its EXPRESS attribute name', () => {
    const reaction = out.activities.find((a) => a.globalId === 'reaction-gid');
    expect(reaction?.globalOrLocal).toBe('LOCAL_COORDS');
    // ForceX/ForceY are written as 0., which must be reported rather than
    // dropped as falsy; MomentX..Z are `$` and must be absent, not zero.
    expect(reaction?.appliedLoad?.components).toEqual({
      ForceX: 0,
      ForceY: 0,
      ForceZ: 31.25,
    });
  });

  it('keeps a boolean stiffness boolean and a numeric stiffness numeric', () => {
    const condition = out.connections.find((c) => c.globalId === 'conn-fixed')?.appliedCondition;
    expect(condition?.type).toBe('IfcBoundaryNodeCondition');
    expect(condition?.name).toBe('Fixed');
    // A rigid DOF is IfcBoolean(.T.); reporting it as the number 1 would say
    // "stiffness 1", which is a different support.
    expect(condition?.components.TranslationalStiffnessX).toBe(true);
    expect(condition?.components.TranslationalStiffnessZ).toBe(false);
    expect(condition?.components.RotationalStiffnessX).toBe(1500);
    expect(condition?.components.RotationalStiffnessY).toBeUndefined();
  });

  it('keeps a `$` or non-numeric Locations row as an empty placeholder so later rows stay on their slot', () => {
    const out = extractStructuralOnDemand(
      buildStoreFromStep([
        "#1=IFCSTRUCTURALCURVEACTION('action-gid',$,'UDL',$,$,$,$,#65,.GLOBAL_COORDS.,.F.,$,.CONST.);",
        "#65=IFCSTRUCTURALLOADCONFIGURATION('Span',(#66,#66,#66,#66),((0.),$,(4.5),(1.,'x')));",
        "#66=IFCSTRUCTURALLOADLINEARFORCE('Nominal',$,$,-12.5,$,$,$);",
      ]),
    );
    const config = out.activities[0]?.appliedLoad?.configuration;
    expect(config?.entries).toHaveLength(4);
    expect(config?.entries[0].location).toEqual([0]);
    expect(config?.entries[1].location).toBeUndefined(); // `$` row
    expect(config?.entries[2].location).toEqual([4.5]); // NOT shifted onto slot 1
    expect(config?.entries[3].location).toBeUndefined(); // non-numeric cell: not compacted to [1]
    expect(config?.locations).toEqual([[0], [], [4.5], []]);
  });

  it('reports no locations when Locations is written flat instead of nested', () => {
    const out = extractStructuralOnDemand(buildStoreFromStep(MALFORMED_LOCATIONS));
    const load = out.activities[0]?.appliedLoad;
    expect(load?.type).toBe('IfcStructuralLoadConfiguration');
    // The nested loads still read; only the unusable Locations is dropped, and
    // it is dropped rather than padded with one empty row per scalar.
    expect(load?.configuration?.entries).toHaveLength(1);
    expect(load?.configuration?.entries[0].value?.components).toEqual({ LinearForceZ: -12.5 });
    expect(load?.configuration?.entries[0].location).toBeUndefined();
    expect(load?.configuration?.locations).toBeUndefined();
  });

  it('leaves appliedCondition undefined when the connection carries none', () => {
    expect(out.connections.find((c) => c.globalId === 'conn-free')?.appliedCondition).toBeUndefined();
  });
});

/** Every load node the walk actually returned, the top one included. */
function countLoads(load: StructuralLoadInfo | undefined): number {
  if (!load) return 0;
  let n = 1;
  for (const entry of load.configuration?.entries ?? []) n += countLoads(entry.value);
  return n;
}

/** Every `dropped` reason anywhere in a returned tree. */
function droppedReasons(load: StructuralLoadInfo | undefined): Set<string> {
  const seen = new Set<string>();
  const visit = (node: StructuralLoadInfo | undefined): void => {
    for (const entry of node?.configuration?.entries ?? []) {
      if (entry.dropped) seen.add(entry.dropped);
      visit(entry.value);
    }
  };
  visit(load);
  return seen;
}

describe('extractStructuralOnDemand — bounding the load walk', () => {
  it('keeps a Values entry that repeats the same load reference', () => {
    // IfcStructuralLoadConfiguration.Values is a LIST, so the same leaf may
    // legitimately appear twice — one load applied at two locations. Cycle
    // detection therefore has to be path-local: a set shared across siblings
    // drops the second occurrence and silently misaligns values[i] against
    // locations[i], which the schema requires to be the same length.
    const out = extractStructuralOnDemand(
      buildStoreFromStep([
        "#1=IFCSTRUCTURALCURVEACTION('a',$,'UDL',$,$,$,$,#65,.GLOBAL_COORDS.,.F.,$,.CONST.);",
        "#65=IFCSTRUCTURALLOADCONFIGURATION('Span',(#66,#66),((0.),(4.5)));",
        "#66=IFCSTRUCTURALLOADLINEARFORCE('Nominal',$,$,-12.5,$,$,$);",
      ]),
    );
    const config = out.activities[0]?.appliedLoad?.configuration;
    expect(config?.entries.map((e) => [e.location, e.value?.components])).toEqual([
      [[0], { LinearForceZ: -12.5 }],
      [[4.5], { LinearForceZ: -12.5 }],
    ]);
    expect(config?.truncated).toBe(false);
  });

  it('drops a self-referential configuration instead of recursing forever', () => {
    // A configuration naming itself is exporter- (or attacker-) controlled.
    const out = extractStructuralOnDemand(
      buildStoreFromStep([
        "#1=IFCSTRUCTURALCURVEACTION('a',$,'UDL',$,$,$,$,#65,.GLOBAL_COORDS.,.F.,$,.CONST.);",
        "#65=IFCSTRUCTURALLOADCONFIGURATION('Loop',(#65,#66),((0.),(4.5)));",
        "#66=IFCSTRUCTURALLOADLINEARFORCE('Nominal',$,$,-12.5,$,$,$);",
      ]),
    );
    const config = out.activities[0]?.appliedLoad?.configuration;
    // The cycle is dropped, but its slot stays: #66 is the SECOND Values entry
    // and belongs at station 4.5. Compacting it into slot 0 would report it at
    // station 0 — a wrong number, not a missing one.
    expect(config?.entries).toHaveLength(2);
    expect(config?.entries[0]).toEqual({ value: undefined, dropped: 'cycle', location: [0] });
    expect(config?.entries[1].location).toEqual([4.5]);
    expect(config?.entries[1].value?.components).toEqual({ LinearForceZ: -12.5 });
    expect(config?.truncated).toBe(true);
    expect(out.loadsTruncated).toBe(true);
  });

  it('reads a configuration that appears twice among its siblings', () => {
    // The repeat case above uses a leaf, which never joins the path set. This
    // one repeats a nested CONFIGURATION, which does — so it fails unless the
    // path entry is removed again when its subtree is done.
    const out = extractStructuralOnDemand(
      buildStoreFromStep([
        "#1=IFCSTRUCTURALCURVEACTION('a',$,'UDL',$,$,$,$,#60,.GLOBAL_COORDS.,.F.,$,.CONST.);",
        '#60=IFCSTRUCTURALLOADCONFIGURATION(\'Outer\',(#65,#65),$);',
        "#65=IFCSTRUCTURALLOADCONFIGURATION('Inner',(#66),((0.)));",
        "#66=IFCSTRUCTURALLOADLINEARFORCE('Nominal',$,$,-12.5,$,$,$);",
      ]),
    );
    const outer = out.activities[0]?.appliedLoad?.configuration;
    expect(outer?.entries).toHaveLength(2);
    for (const entry of outer?.entries ?? []) {
      expect(entry.value?.type).toBe('IfcStructuralLoadConfiguration');
      expect(entry.value?.configuration?.entries[0].value?.components).toEqual({
        LinearForceZ: -12.5,
      });
    }
    expect(outer?.truncated).toBe(false);
    expect(out.loadsTruncated).toBe(false);
  });

  it('truncates a nesting chain longer than the depth cap', () => {
    // Ten configurations chained one deep each. The cap admits the top plus
    // four levels below it; the rest is dropped rather than read.
    const lines = ["#1=IFCSTRUCTURALCURVEACTION('a',$,'UDL',$,$,$,$,#10,.GLOBAL_COORDS.,.F.,$,.CONST.);"];
    for (let i = 10; i < 20; i++) {
      lines.push(`#${i}=IFCSTRUCTURALLOADCONFIGURATION('C${i}',(#${i + 1}),$);`);
    }
    lines.push("#20=IFCSTRUCTURALLOADLINEARFORCE('Leaf',$,$,-1.,$,$,$);");
    const out = extractStructuralOnDemand(buildStoreFromStep(lines));

    let node = out.activities[0]?.appliedLoad;
    let levels = 0;
    while (node?.configuration?.entries[0]?.value) {
      node = node.configuration.entries[0].value;
      levels++;
    }
    // depth 0 is the top configuration, and recursion stops once depth > 4.
    expect(levels).toBe(4);
    // The level below the cap is reported as a slot we refused to follow, not
    // as a configuration that happened to be empty.
    expect(node?.configuration?.entries).toEqual([
      { value: undefined, dropped: 'depth', location: undefined },
    ]);
    expect(node?.configuration?.truncated).toBe(true);
    // and it propagates all the way out to the extraction.
    expect(out.activities[0]?.appliedLoad?.configuration?.truncated).toBe(true);
    expect(out.loadsTruncated).toBe(true);
  });

  it('bounds total work when a configuration fans out at every level', () => {
    // A depth cap bounds one path's LENGTH, not its breadth: k children each
    // recursing to the cap costs O(k^depth), which turns an abort into a hang,
    // and a hang reports nothing. Only a node budget bounds the product.
    const K = 40;
    const lines = ["#1=IFCSTRUCTURALCURVEACTION('a',$,'UDL',$,$,$,$,#10,.GLOBAL_COORDS.,.F.,$,.CONST.);"];
    for (let i = 10; i < 15; i++) {
      const child = `#${i + 1}`;
      lines.push(
        `#${i}=IFCSTRUCTURALLOADCONFIGURATION('C${i}',(${Array(K).fill(child).join(',')}),$);`,
      );
    }
    lines.push("#15=IFCSTRUCTURALLOADLINEARFORCE('Leaf',$,$,-1.,$,$,$);");
    const out = extractStructuralOnDemand(buildStoreFromStep(lines));
    const top = out.activities[0]?.appliedLoad;
    expect(top?.type).toBe('IfcStructuralLoadConfiguration');
    // Unbounded this is 40^5 entity reads. Assert the bound itself, not the
    // wall clock: every load in the returned tree cost exactly one unit of
    // budget, so the tree holds MAX_LOAD_NODES nodes and no more. A time
    // bound alone would still pass with the budget raised a thousandfold.
    expect(countLoads(top)).toBe(256);
    // And the walk says so, instead of returning 256 nodes shaped like a
    // configuration that genuinely had 256.
    expect(top?.configuration?.truncated).toBe(true);
    expect(out.loadsTruncated).toBe(true);
    expect(droppedReasons(top).has('budget')).toBe(true);
  });
});

describe('extractStructuralOnDemand — a dropped Values slot keeps its position', () => {
  // Every one of these files writes two Values slots against two Locations
  // rows, with only the SECOND slot readable. The readable load belongs at
  // station 4.5; a reader that compacted the drop away would hand it back at
  // station 0, which is a plausible wrong answer rather than a visible gap.
  function firstSlotDropped(configLine: string, extra: string[] = []) {
    const out = extractStructuralOnDemand(
      buildStoreFromStep([
        "#1=IFCSTRUCTURALCURVEACTION('a',$,'UDL',$,$,$,$,#65,.GLOBAL_COORDS.,.F.,$,.CONST.);",
        configLine,
        ...extra,
        "#66=IFCSTRUCTURALLOADLINEARFORCE('Nominal',$,$,-12.5,$,$,$);",
      ]),
    );
    return out;
  }

  function expectSecondSlotStillAt4point5(out: ReturnType<typeof extractStructuralOnDemand>) {
    const config = out.activities[0]?.appliedLoad?.configuration;
    expect(config?.entries).toHaveLength(2);
    expect(config?.entries[1].location).toEqual([4.5]);
    expect(config?.entries[1].value?.components).toEqual({ LinearForceZ: -12.5 });
    return config;
  }

  it('keeps the slot of a Values element that is not a reference at all', () => {
    const out = firstSlotDropped("#65=IFCSTRUCTURALLOADCONFIGURATION('Bad',($,#66),((0.),(4.5)));");
    const config = expectSecondSlotStillAt4point5(out);
    expect(config?.entries[0].dropped).toBe('invalid-reference');
    // A malformed Values element is the file's defect, not a bound of ours:
    // there is nothing further to read, so this is not truncation.
    expect(config?.truncated).toBe(false);
    expect(out.loadsTruncated).toBe(false);
  });

  it('keeps the slot of a dangling reference', () => {
    const out = firstSlotDropped(
      "#65=IFCSTRUCTURALLOADCONFIGURATION('Miss',(#999,#66),((0.),(4.5)));",
    );
    const config = expectSecondSlotStillAt4point5(out);
    expect(config?.entries[0].dropped).toBe('unresolved');
    expect(config?.truncated).toBe(false);
    expect(out.loadsTruncated).toBe(false);
  });

  it('keeps the slot of a record that is indexed but does not parse', () => {
    // #67 is indexed from its `#id=TYPE(` prefix, but the record never closes,
    // so extractEntity returns null for it.
    const out = firstSlotDropped(
      "#65=IFCSTRUCTURALLOADCONFIGURATION('Torn',(#67,#66),((0.),(4.5)));",
      ["#67=IFCSTRUCTURALLOADLINEARFORCE('Unterminated',$,$,-1.,$,$,$"],
    );
    const config = expectSecondSlotStillAt4point5(out);
    expect(config?.entries[0].dropped).toBe('unreadable');
    expect(config?.truncated).toBe(false);
    expect(out.loadsTruncated).toBe(false);
  });

  it('keeps the slot of a child the node budget could not afford', () => {
    // 300 readable children against 300 locations, with a 256-node budget: the
    // tail must be reported as budget-dropped slots at their own stations, not
    // as a configuration that only ever had 255 loads.
    const kids = Array(300).fill('#66').join(',');
    const locs = Array.from({ length: 300 }, (_, i) => `(${i}.)`).join(',');
    const out = firstSlotDropped(
      `#65=IFCSTRUCTURALLOADCONFIGURATION('Budget',(${kids}),(${locs}));`,
    );
    const config = out.activities[0]?.appliedLoad?.configuration;
    expect(config?.entries).toHaveLength(300);
    // One unit of budget went on #65 itself, so 255 children fit.
    expect(config?.entries.filter((e) => e.value !== undefined)).toHaveLength(255);
    expect(config?.entries[255]).toEqual({
      value: undefined,
      dropped: 'budget',
      location: [255],
    });
    expect(config?.truncated).toBe(true);
    expect(out.loadsTruncated).toBe(true);
  });

  it('gives every Values slot exactly one entry, whatever the drops', () => {
    // The invariant the two-array shape could not hold: one entry per slot, in
    // file order, however many of them failed to read.
    const out = firstSlotDropped(
      "#65=IFCSTRUCTURALLOADCONFIGURATION('Mixed',(#65,#999,$,#67,#66),((0.),(1.),(2.),(3.),(4.5)));",
      ["#67=IFCSTRUCTURALLOADLINEARFORCE('Unterminated',$,$,-1.,$,$,$"],
    );
    const config = out.activities[0]?.appliedLoad?.configuration;
    expect(config?.entries.map((e) => [e.location, e.dropped])).toEqual([
      [[0], 'cycle'],
      [[1], 'unresolved'],
      [[2], 'invalid-reference'],
      [[3], 'unreadable'],
      [[4.5], undefined],
    ]);
    expect(config?.entries[4].value?.components).toEqual({ LinearForceZ: -12.5 });
    // One of the five drops was a bound of ours, so the tree is truncated.
    expect(config?.truncated).toBe(true);
  });
});
