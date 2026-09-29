/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for a straight curtain wall (#6232): an IfcCurtainWall
 * contained in the storey that aggregates its real parts, IfcMember mullions
 * and transoms and IfcPlate panels, laid out on a U/V grid.
 *
 * `IfcCreator.addIfcCurtainWall` writes one thin box. This builder writes the
 * system instead:
 *
 *   - U grid lines run up the wall at offsets along the path, V grid lines run
 *     along it at heights above the base. Either is a bay count (equal bays)
 *     or the explicit interior offsets.
 *   - Mullions stand on every U line, full height. Transoms lie on every V
 *     line, bay by bay between the mullion faces (a stick system with
 *     continuous mullions).
 *   - With `EdgeMembers` (the default) the perimeter is framed too, with the
 *     edge members set inside the outline, so the whole curtain wall spans
 *     exactly `Start -> End` and `0 -> Height`, like IfcCreator's box.
 *   - One panel fills each clear opening between member faces, `PanelThickness`
 *     thick, centred on the path line like the members.
 *
 * The member section comes from the shared profile factory (`ProfileSection`,
 * any of rectangle, I, L, T, U, C, circle, hollow). Profile X lies in the wall
 * plane across the member and profile Y across the wall, towards the left of
 * `Start -> End`, for mullions and transoms alike, so an asymmetric section
 * faces the same side on both.
 *
 * The IfcCurtainWall has no representation of its own; its geometry is its
 * parts' (IfcRelAggregates), and every part is placed relative to the curtain
 * wall, so moving the curtain wall moves the lot.
 *
 * Schema gating (D2): attributes are laid out from the anchor schema's
 * registry. IFC4/IFC4X3 get `PredefinedType`s (MULLION members, CURTAIN_PANEL
 * plates); IFC2X3 has none on these classes; IFC5 is refused.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3 } from '../ifc-creator-math.js';
import { toNativeLength, toNativePoint3, type SpatialAnchor } from './anchor.js';
import {
  assertPositiveFinite,
  emitBodyRepresentation,
  emitLocalPlacement,
  emitRectangleProfile,
  emitRelContainedInSpatialStructure,
  ownerHistoryRef,
  productGuid,
} from './_emit-helpers.js';
import {
  assertProfileSectionAuthorable,
  emitProfileSection,
  profileSectionExtent,
  validateProfileSection,
  type ProfileSection,
} from './profile.js';
import { schemaAttributes } from './schema-attributes.js';

type Attrs = Parameters<StoreEditor['addEntity']>[1];

const DEFAULT_MULLION: ProfileSection = { Type: 'Rectangle', XDim: 0.05, YDim: 0.15 };
const DEFAULT_PANEL_THICKNESS = 0.024;
/** Widest bay the default U grid makes (metres). */
const DEFAULT_MAX_BAY = 1.5;
const EPS = 1e-9;

/**
 * Round away the float noise of the face arithmetic (0.975 - 0.05 =
 * 0.9249999999999999) so the STEP file carries the dimensions as authored.
 */
const snap = (x: number) => Math.round(x * 1e9) / 1e9;

/** A grid direction: a bay count (equal bays), or the interior grid lines' offsets (metres). */
export type CurtainWallGridSpec = number | readonly number[];

export interface CurtainWallInStoreParams {
  /** Start of the base line, storey-local (metres). Its Z is the base elevation. */
  Start: [number, number, number];
  /** End of the base line, storey-local (metres). Same Z as `Start`. */
  End: [number, number, number];
  /** Height above the base line (metres). */
  Height: number;
  /**
   * Vertical grid lines along the path: a bay count, or the interior lines'
   * distances from `Start` (strictly increasing, inside the length).
   * Default: equal bays no wider than 1.5 m.
   */
  UGrid?: CurtainWallGridSpec;
  /**
   * Horizontal grid lines up the wall: a bay count, or the interior lines'
   * heights above the base (strictly increasing, inside the height).
   * Default: 1 (no intermediate transom).
   */
  VGrid?: CurtainWallGridSpec;
  /** Mullion section. Default: a 50 x 150 mm rectangle (in-plane x depth). */
  MullionProfile?: ProfileSection;
  /** Transom section. Default: `MullionProfile`. */
  TransomProfile?: ProfileSection;
  /** Panel thickness (metres). Default 0.024. */
  PanelThickness?: number;
  /** Frame the perimeter with edge mullions and transoms. Default true. */
  EdgeMembers?: boolean;
  /** IfcCurtainWall PredefinedType (IFC4+). Default `NOTDEFINED`. */
  PredefinedType?: 'USERDEFINED' | 'NOTDEFINED';
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
  /** Explicit GlobalId for the IfcCurtainWall (22-char IFC GUID); generated when omitted. Parts always get fresh ones. */
  GlobalId?: string;
}

/** A member or panel of the layout, in the curtain wall's frame (metres): u along the path, v up. */
export interface CurtainWallLayout {
  length: number;
  height: number;
  /** U grid lines, 0 and the length included. */
  uLines: number[];
  /** V grid lines, 0 and the height included. */
  vLines: number[];
  /** Mullion centre lines (u), each full height. */
  mullions: number[];
  /** Transoms: centre height v, spanning u0 -> u1 between mullion faces. */
  transoms: Array<{ v: number; u0: number; u1: number }>;
  /** Panels: the clear openings between member faces. */
  panels: Array<{ u0: number; u1: number; v0: number; v1: number }>;
}

export interface CurtainWallBuildResult {
  curtainWallId: number;
  placementId: number;
  /** IfcMember ids, in `layout.mullions` order. */
  mullionIds: number[];
  /** IfcMember ids, in `layout.transoms` order. */
  transomIds: number[];
  /** IfcPlate ids, in `layout.panels` order. */
  panelIds: number[];
  mullionProfileId: number;
  transomProfileId: number;
  relAggregatesId: number;
  relContainedId: number;
  layout: CurtainWallLayout;
}

function gridLines(extent: number, spec: CurtainWallGridSpec, name: string, op: string): number[] {
  if (typeof spec === 'number') {
    if (!Number.isInteger(spec) || spec < 1) throw new Error(`${op}: ${name} bay count must be a positive integer`);
    return Array.from({ length: spec + 1 }, (_, i) => (i === spec ? extent : (extent * i) / spec));
  }
  if (!Array.isArray(spec)) throw new Error(`${op}: ${name} must be a bay count or an array of offsets`);
  let previous = 0;
  for (const value of spec) {
    if (!Number.isFinite(value) || value <= previous + EPS || value >= extent - EPS) {
      throw new Error(`${op}: ${name} offsets must be finite, strictly increasing and inside (0, ${extent})`);
    }
    previous = value;
  }
  return [0, ...spec, extent];
}

/**
 * The curtain wall's members and panels, in metres, without emitting anything.
 * Refuses a layout whose members leave no clear opening.
 */
export function curtainWallLayout(params: CurtainWallInStoreParams, op = 'curtainWallLayout'): CurtainWallLayout {
  assertFinitePoint3({ Start: params.Start, End: params.End }, op);
  if (Math.abs(params.End[2] - params.Start[2]) > EPS) {
    throw new Error(`${op}: Start and End must be at the same height (the base elevation)`);
  }
  const length = Math.hypot(params.End[0] - params.Start[0], params.End[1] - params.Start[1]);
  if (length <= EPS) throw new Error(`${op}: Start and End must be distinct points`);
  assertPositiveFinite([params.Height], `${op}: Height must be a finite positive number`);
  const height = params.Height;
  const mullion = params.MullionProfile ?? DEFAULT_MULLION;
  const transom = params.TransomProfile ?? mullion;
  validateProfileSection(mullion, op);
  validateProfileSection(transom, op);
  const [w] = profileSectionExtent(mullion);
  const [h] = profileSectionExtent(transom);
  const edge = params.EdgeMembers ?? true;

  const uLines = gridLines(length, params.UGrid ?? Math.max(1, Math.ceil(length / DEFAULT_MAX_BAY - EPS)), 'UGrid', op);
  const vLines = gridLines(height, params.VGrid ?? 1, 'VGrid', op);
  const nu = uLines.length - 1;
  const nv = vLines.length - 1;

  const mullions = edge ? [w / 2, ...uLines.slice(1, -1), length - w / 2] : uLines.slice(1, -1);
  const bayU = (j: number): [number, number] => [
    j === 0 ? (edge ? w : 0) : uLines[j] + w / 2,
    j === nu - 1 ? (edge ? length - w : length) : uLines[j + 1] - w / 2,
  ];
  const bayV = (k: number): [number, number] => [
    k === 0 ? (edge ? h : 0) : vLines[k] + h / 2,
    k === nv - 1 ? (edge ? height - h : height) : vLines[k + 1] - h / 2,
  ];
  const rows = edge ? [h / 2, ...vLines.slice(1, -1), height - h / 2] : vLines.slice(1, -1);

  const transoms: CurtainWallLayout['transoms'] = [];
  const panels: CurtainWallLayout['panels'] = [];
  for (let j = 0; j < nu; j++) {
    const [u0, u1] = bayU(j);
    if (u1 - u0 <= EPS) throw new Error(`${op}: the mullions leave no clear opening in bay ${j + 1}; widen the bays or slim the mullion`);
    for (const v of rows) transoms.push({ v, u0, u1 });
  }
  for (let k = 0; k < nv; k++) {
    const [v0, v1] = bayV(k);
    if (v1 - v0 <= EPS) throw new Error(`${op}: the transoms leave no clear opening in row ${k + 1}; raise the rows or slim the transom`);
    for (let j = 0; j < nu; j++) {
      const [u0, u1] = bayU(j);
      panels.push({ u0, u1, v0, v1 });
    }
  }
  return {
    length,
    height,
    uLines: uLines.map(snap),
    vLines: vLines.map(snap),
    mullions: mullions.map(snap),
    transoms: transoms.map((t) => ({ v: snap(t.v), u0: snap(t.u0), u1: snap(t.u1) })),
    panels: panels.map((p) => ({ u0: snap(p.u0), u1: snap(p.u1), v0: snap(p.v0), v1: snap(p.v1) })),
  };
}

export function addCurtainWallToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: CurtainWallInStoreParams,
): CurtainWallBuildResult {
  const op = 'addCurtainWallToStore';
  const mullionSection = params.MullionProfile ?? DEFAULT_MULLION;
  const transomSection = params.TransomProfile ?? mullionSection;
  const registry = assertProfileSectionAuthorable(anchor, mullionSection, op);
  assertProfileSectionAuthorable(anchor, transomSection, op);
  const panelThickness = params.PanelThickness ?? DEFAULT_PANEL_THICKNESS;
  assertPositiveFinite([panelThickness], `${op}: PanelThickness must be a finite positive number`);
  if (params.EdgeMembers !== undefined && typeof params.EdgeMembers !== 'boolean') {
    throw new Error(`${op}: EdgeMembers must be a boolean`);
  }
  const layout = curtainWallLayout(params, op);
  const isIfc2x3 = registry.name.toUpperCase() === 'IFC2X3';

  const owner = ownerHistoryRef(anchor.ownerHistoryId);
  const wallName = params.Name ?? 'Curtain Wall';
  const curtainWallGuid = productGuid(params, anchor.guidRandom);
  const curtainWallValues = (placement: string | null) => ({
    GlobalId: curtainWallGuid,
    OwnerHistory: owner,
    Name: wallName,
    Description: params.Description,
    ObjectType: params.ObjectType,
    ObjectPlacement: placement,
    Tag: params.Tag,
    ...(isIfc2x3 ? {} : { PredefinedType: params.PredefinedType ?? 'NOTDEFINED' }),
  });
  const partValues = (name: string, placement: string | null, shape: string | null, predefinedType: string) => ({
    GlobalId: generateIfcGuid(anchor.guidRandom),
    OwnerHistory: owner,
    Name: name,
    ObjectPlacement: placement,
    Representation: shape,
    ...(isIfc2x3 ? {} : { PredefinedType: predefinedType }),
  });
  // Lay every record class out once before the first emit, so a bad
  // PredefinedType or a missing IFC2X3 OwnerHistory refuses cleanly.
  schemaAttributes(registry, 'IfcCurtainWall', curtainWallValues(null), op);
  schemaAttributes(registry, 'IfcMember', partValues('', null, null, 'MULLION'), op);
  schemaAttributes(registry, 'IfcPlate', partValues('', null, null, 'CURTAIN_PANEL'), op);

  const n = (metres: number) => toNativeLength(anchor, metres);
  const start = toNativePoint3(anchor, params.Start);
  const dx = params.End[0] - params.Start[0];
  const dy = params.End[1] - params.Start[1];
  const placementId = emitLocalPlacement(
    editor,
    anchor.storeyPlacementId,
    start,
    [0, 0, 1],
    [dx / layout.length, dy / layout.length, 0],
  );

  // Shared across every part: one extrusion frame and direction.
  const solidOrigin = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const solidPosition = editor.addEntity('IfcAxis2Placement3D', [`#${solidOrigin}`, null, null]).expressId;
  const up = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
  const extrude = (profileId: number, depth: number) => editor.addEntity('IfcExtrudedAreaSolid', [
    `#${profileId}`, `#${solidPosition}`, `#${up}`, n(depth),
  ]).expressId;
  const part = (type: 'IfcMember' | 'IfcPlate', name: string, placement: number, solid: number, predefinedType: string) => {
    const { productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solid);
    return editor.addEntity(
      type,
      schemaAttributes(registry, type, partValues(name, `#${placement}`, `#${productShapeId}`, predefinedType), op) as Attrs,
    ).expressId;
  };

  const mullionProfileId = emitProfileSection(editor, anchor, mullionSection, op);
  const transomProfileId = params.TransomProfile === undefined
    ? mullionProfileId
    : emitProfileSection(editor, anchor, transomSection, op);

  // Mullions: local Z up the wall, profile X along the path, Y across it.
  const mullionIds = layout.mullions.map((u, i) => {
    const placement = emitLocalPlacement(editor, placementId, [n(u), 0, 0]);
    return part('IfcMember', `Mullion ${i + 1}`, placement, extrude(mullionProfileId, layout.height), 'MULLION');
  });
  // Transoms: local Z along the path; RefDirection down, so profile X lies in
  // the wall plane and profile Y (Z x X) across it, the same side as the mullions'.
  const transomIds = layout.transoms.map((t, i) => {
    const placement = emitLocalPlacement(editor, placementId, [n(t.u0), 0, n(t.v)], [1, 0, 0], [0, 0, -1]);
    return part('IfcMember', `Transom ${i + 1}`, placement, extrude(transomProfileId, snap(t.u1 - t.u0)), 'MULLION');
  });
  // Panels: one rectangle per clear width (shared between panels of the same width).
  const panelProfiles = new Map<number, number>();
  const panelIds = layout.panels.map((p, i) => {
    const width = n(snap(p.u1 - p.u0));
    let profileId = panelProfiles.get(width);
    if (profileId === undefined) {
      profileId = emitRectangleProfile(editor, width, n(panelThickness), width / 2, 0);
      panelProfiles.set(width, profileId);
    }
    const placement = emitLocalPlacement(editor, placementId, [n(p.u0), 0, n(p.v0)]);
    return part('IfcPlate', `Panel ${i + 1}`, placement, extrude(profileId, snap(p.v1 - p.v0)), 'CURTAIN_PANEL');
  });

  const curtainWallId = editor.addEntity(
    'IfcCurtainWall',
    schemaAttributes(registry, 'IfcCurtainWall', curtainWallValues(`#${placementId}`), op) as Attrs,
  ).expressId;
  const relAggregatesId = editor.addEntity('IfcRelAggregates', schemaAttributes(registry, 'IfcRelAggregates', {
    GlobalId: generateIfcGuid(anchor.guidRandom),
    OwnerHistory: owner,
    RelatingObject: `#${curtainWallId}`,
    RelatedObjects: [...mullionIds, ...transomIds, ...panelIds].map((id) => `#${id}`),
  }, op) as Attrs).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(
    editor, anchor.ownerHistoryId, curtainWallId, anchor.storeyId, anchor.guidRandom,
  );

  return {
    curtainWallId,
    placementId,
    mullionIds,
    transomIds,
    panelIds,
    mullionProfileId,
    transomProfileId,
    relAggregatesId,
    relContainedId,
    layout,
  };
}
