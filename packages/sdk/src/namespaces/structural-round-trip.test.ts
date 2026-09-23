/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5167 task S.1 — the structural write path, proven end-to-end: author a
 * structural analysis model with `@ifc-lite/create`'s in-store builders,
 * export REAL IFC bytes with `@ifc-lite/export`'s `StepExporter`, re-parse
 * those bytes with a FRESH `IfcParser`, and read the result back through
 * `bim.structural.*` (`StructuralNamespace`) — the same namespace a
 * consumer script calls.
 *
 * This does NOT assert on the builder's return values, the `StoreEditor`
 * overlay, or a mock backend: everything asserted below comes from
 * `extractStructuralOnDemand` running over the independently re-parsed STEP
 * text, so a bug that wrote a plausible-looking but wrong attribute order,
 * or an omitted relationship, shows up as a reader-side mismatch, not a
 * builder-side self-check.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, extractStructuralOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import {
  resolveSpatialAnchor,
  addStructuralAnalysisModelToStore,
  addStructuralCurveMemberToStore,
  addStructuralPointConnectionToStore,
  addStructuralLoadGroupToStore,
  addStructuralPointActionToStore,
  connectStructuralMemberToConnectionInStore,
  connectStructuralActivityToItemInStore,
  assignToStructuralGroupInStore,
} from '@ifc-lite/create';
import { StructuralNamespace } from './structural.js';
import type { BimBackend, StructuralExtractionData } from '../types.js';

/** Minimal IFC4 model with one storey — enough for `resolveSpatialAnchor`. */
const STOREY_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#8=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#7,$,.MODEL_VIEW.,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;`;

async function parse(bytes: Uint8Array | ArrayBuffer): Promise<IfcDataStore> {
  const buf = bytes instanceof Uint8Array ? (bytes.buffer as ArrayBuffer) : bytes;
  return new IfcParser().parseColumnar(buf, { disableWorkerScan: true });
}

/** Wraps a re-parsed `IfcDataStore` as the minimal `BimBackend` `StructuralNamespace` needs. */
function structuralNamespaceOver(store: IfcDataStore): StructuralNamespace {
  let cached: StructuralExtractionData | null = null;
  const extract = (): StructuralExtractionData => (cached ??= extractStructuralOnDemand(store));
  const backend = {
    structural: {
      data: extract,
      analysisModels: () => extract().analysisModels,
      members: () => extract().members,
      connections: () => extract().connections,
      activities: () => extract().activities,
      loadGroups: () => extract().loadGroups,
      resultGroups: () => extract().resultGroups,
    },
  } as unknown as BimBackend;
  return new StructuralNamespace(backend);
}

/**
 * Author one small but fully-connected analytical model — one curve member,
 * one point connection at its end, a point action applying a load to that
 * connection, and a load group + analysis model tying them together — then
 * export and re-parse it.
 */
/** `guids` lets a caller pin explicit GlobalIds on the products; omitted, every
 *  builder mints its own, which is the shape the other tests exercise. */
async function buildAndRoundTrip(guids: { analysis?: string; connection?: string } = {}) {
  const store = await parse(new TextEncoder().encode(STOREY_MODEL));
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 30);

  const { loadGroupId } = addStructuralLoadGroupToStore(editor, anchor, {
    Name: 'Dead Load',
    ActionType: 'PERMANENT_G',
    ActionSource: 'DEAD_LOAD_G',
    PredefinedType: 'LOAD_GROUP',
  });

  const { analysisModelId } = addStructuralAnalysisModelToStore(editor, anchor, {
    Name: 'Main Analysis Model',
    PredefinedType: 'LOADING_3D',
    LoadGroupIds: [loadGroupId],
    ...(guids.analysis ? { GlobalId: guids.analysis } : {}),
  });

  const { memberId } = addStructuralCurveMemberToStore(editor, anchor, {
    Start: [0, 0, 0],
    End: [4, 0, 0],
    PredefinedType: 'RIGID_JOINED_MEMBER',
    Name: 'Beam A',
  });

  const { connectionId } = addStructuralPointConnectionToStore(editor, anchor, {
    Position: [4, 0, 0],
    Name: 'Support A',
    ...(guids.connection ? { GlobalId: guids.connection } : {}),
    BoundaryCondition: {
      Name: 'Pinned',
      TranslationalStiffnessX: true,
      TranslationalStiffnessY: true,
      TranslationalStiffnessZ: true,
      RotationalStiffnessX: false,
      RotationalStiffnessY: false,
      RotationalStiffnessZ: false,
    },
  });

  const { activityId } = addStructuralPointActionToStore(editor, anchor, {
    Name: 'Point Load A',
    GlobalOrLocal: 'GLOBAL_COORDS',
    ForceX: 0,
    ForceY: 0,
    ForceZ: -1000,
  });

  connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, memberId, connectionId, anchor.guidRandom);
  connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, connectionId, activityId, anchor.guidRandom);
  assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, analysisModelId, [memberId, connectionId], anchor.guidRandom);
  assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, loadGroupId, [activityId], anchor.guidRandom);

  const { content } = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
  const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
  const reparsed = await parse(new TextEncoder().encode(text));
  return { text, ns: structuralNamespaceOver(reparsed) };
}

describe('#5167 structural write path: author -> export -> re-parse -> bim.structural.*', () => {
  it('the exported STEP text carries every structural entity as real records', async () => {
    const { text } = await buildAndRoundTrip();
    expect(text).toMatch(/=IFCSTRUCTURALANALYSISMODEL\(/);
    expect(text).toMatch(/=IFCSTRUCTURALCURVEMEMBER\(/);
    expect(text).toMatch(/=IFCSTRUCTURALPOINTCONNECTION\(/);
    expect(text).toMatch(/=IFCSTRUCTURALLOADGROUP\(/);
    expect(text).toMatch(/=IFCSTRUCTURALPOINTACTION\(/);
    expect(text).toMatch(/=IFCBOUNDARYNODECONDITION\(/);
    expect((text.match(/=IFCRELASSIGNSTOGROUP\(/g) ?? []).length).toBe(2);
    expect(text).toMatch(/=IFCRELCONNECTSSTRUCTURALMEMBER\(/);
    expect(text).toMatch(/=IFCRELCONNECTSSTRUCTURALACTIVITY\(/);
  });

  it('bim.structural.data() reports hasStructural and every collection non-empty', async () => {
    const { ns } = await buildAndRoundTrip();
    const data = ns.data();
    expect(data.hasStructural).toBe(true);
    expect(data.analysisModels.length).toBe(1);
    expect(data.members.length).toBe(1);
    expect(data.connections.length).toBe(1);
    expect(data.activities.length).toBe(1);
    expect(data.loadGroups.length).toBe(1);
  });

  it('bim.structural.analysisModels() sees its member/connection via IfcRelAssignsToGroup and its load group via LoadedBy', async () => {
    const { ns } = await buildAndRoundTrip();
    const [model] = ns.analysisModels();
    const [member] = ns.members();
    const [connection] = ns.connections();
    const [loadGroup] = ns.loadGroups();
    expect(model.name).toBe('Main Analysis Model');
    expect(model.predefinedType).toBe('LOADING_3D');
    expect(model.itemGlobalIds.sort()).toEqual([member.globalId, connection.globalId].sort());
    expect(model.loadGroupGlobalIds).toEqual([loadGroup.globalId]);
  });

  it('bim.structural.members()/connections() see each other via IfcRelConnectsStructuralMember', async () => {
    const { ns } = await buildAndRoundTrip();
    const [member] = ns.members();
    const [connection] = ns.connections();
    expect(member.type).toBe('IfcStructuralCurveMember');
    expect(member.predefinedType).toBe('RIGID_JOINED_MEMBER');
    expect(member.connectionGlobalIds).toEqual([connection.globalId]);
    expect(connection.memberGlobalIds).toEqual([member.globalId]);
    expect(connection.appliedCondition?.type).toBe('IfcBoundaryNodeCondition');
    expect(connection.appliedCondition?.components.TranslationalStiffnessX).toBe(true);
    expect(connection.appliedCondition?.components.RotationalStiffnessX).toBe(false);
  });

  it('bim.structural.activities() sees its load, its target, and its group via IfcRelConnectsStructuralActivity/IfcRelAssignsToGroup', async () => {
    const { ns } = await buildAndRoundTrip();
    const [connection] = ns.connections();
    const [activity] = ns.activities();
    const [loadGroup] = ns.loadGroups();
    expect(activity.type).toBe('IfcStructuralPointAction');
    expect(activity.kind).toBe('Action');
    expect(activity.appliesToGlobalId).toBe(connection.globalId);
    expect(activity.appliedLoad?.type).toBe('IfcStructuralLoadSingleForce');
    expect(activity.appliedLoad?.components.ForceZ).toBe(-1000);
    expect(activity.groupGlobalIds).toContain(loadGroup.globalId);
    expect(loadGroup.activityGlobalIds).toEqual([activity.globalId]);
  });

  /**
   * #5167: the repo-wide invariant that an in-store builder stamps a
   * caller-supplied GlobalId on the product it creates — the property a
   * re-runnable author (a flow graph) relies on so a re-run updates the
   * element instead of duplicating it. Asserted through an independent
   * re-parse of exported STEP, not off the builder's return value.
   */
  it('stamps a caller-supplied GlobalId on the structural product', async () => {
    const analysisGuid = '3StructuralModelGuid01';
    const connectionGuid = '3StructuralNodeGuid001';
    const { ns } = await buildAndRoundTrip({ analysis: analysisGuid, connection: connectionGuid });

    expect(ns.analysisModels().map((m) => m.globalId)).toContain(analysisGuid);
    expect(ns.connections().map((c) => c.globalId)).toContain(connectionGuid);
  });
});
