/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared parametric-profile factory for the in-store builders (#6232).
 *
 * One discriminated union covers the cross-sections a beam, column or member
 * can carry: the default rectangle plus the steel/hollow sections IfcCreator
 * offers (`addIShapeProfile`, `addLShapeProfile`, ...). Every profile is
 * centred on its own origin, the IFC convention for parameterised profiles,
 * so an extrusion along the element axis runs through the section's centre.
 *
 * Attributes are laid out from the target schema's registry by name
 * (`schemaAttributes`, decision D2): IFC2X3 and IFC4/IFC4X3 differ in the
 * optional tail of several of these classes (IFC2X3 has `CentreOfGravityIn*`,
 * IFC4 has `FlangeEdgeRadius`, `FlangeSlope`, ...), and IFC5 is refused.
 *
 * Params are metres; dimensions are converted to the file's native length
 * unit on emit, like every other in-store builder.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertPositiveFinite } from './_emit-helpers.js';
import { toNativeLength, type SpatialAnchor } from './anchor.js';
import { schemaAttributes, schemaRegistry } from './schema-attributes.js';

/** Centred rectangle, XDim along profile X, YDim along profile Y. */
export interface RectangleSection { Type: 'Rectangle'; XDim: number; YDim: number }
/** I / H section (`IfcIShapeProfileDef`). Depth along profile Y. */
export interface ISection {
  Type: 'I';
  OverallWidth: number;
  OverallDepth: number;
  WebThickness: number;
  FlangeThickness: number;
  FilletRadius?: number;
}
/** Angle (`IfcLShapeProfileDef`). Depth along profile Y, Width along X. */
export interface LSection { Type: 'L'; Depth: number; Width: number; Thickness: number; FilletRadius?: number }
/** Tee (`IfcTShapeProfileDef`). Flange at +Y. */
export interface TSection {
  Type: 'T';
  Depth: number;
  FlangeWidth: number;
  WebThickness: number;
  FlangeThickness: number;
  FilletRadius?: number;
}
/** Channel (`IfcUShapeProfileDef`). Web at -X, flanges towards +X. */
export interface USection {
  Type: 'U';
  Depth: number;
  FlangeWidth: number;
  WebThickness: number;
  FlangeThickness: number;
  FilletRadius?: number;
}
/** Cold-formed lipped channel (`IfcCShapeProfileDef`). */
export interface CSection {
  Type: 'C';
  Depth: number;
  Width: number;
  WallThickness: number;
  Girth: number;
  InternalFilletRadius?: number;
}
/** Solid circle (`IfcCircleProfileDef`). */
export interface CircleSection { Type: 'Circle'; Radius: number }
/** Rectangular hollow section / tube (`IfcRectangleHollowProfileDef`). */
export interface RectangleHollowSection {
  Type: 'RectangleHollow';
  XDim: number;
  YDim: number;
  WallThickness: number;
  InnerFilletRadius?: number;
  OuterFilletRadius?: number;
}
/** Circular hollow section / pipe (`IfcCircleHollowProfileDef`). */
export interface CircleHollowSection { Type: 'CircleHollow'; Radius: number; WallThickness: number }

/** A parameterised cross-section for a beam, column or member. Metres. */
export type ProfileSection =
  | RectangleSection
  | ISection
  | LSection
  | TSection
  | USection
  | CSection
  | CircleSection
  | RectangleHollowSection
  | CircleHollowSection;

export type ProfileSectionType = ProfileSection['Type'];

const IFC_CLASS: Record<ProfileSectionType, string> = {
  Rectangle: 'IfcRectangleProfileDef',
  I: 'IfcIShapeProfileDef',
  L: 'IfcLShapeProfileDef',
  T: 'IfcTShapeProfileDef',
  U: 'IfcUShapeProfileDef',
  C: 'IfcCShapeProfileDef',
  Circle: 'IfcCircleProfileDef',
  RectangleHollow: 'IfcRectangleHollowProfileDef',
  CircleHollow: 'IfcCircleHollowProfileDef',
};

/** The IFC profile class a section is written as. */
export function profileSectionIfcClass(section: ProfileSection): string {
  const cls = IFC_CLASS[section?.Type];
  if (!cls) throw new Error(`profile: unknown section Type ${String((section as { Type?: unknown })?.Type)}`);
  return cls;
}

/** The section's dimension fields (everything but `Type`), keyed by IFC attribute name. */
function dimensions(section: ProfileSection): Record<string, number | undefined> {
  const { Type: _type, ...dims } = section;
  return dims as Record<string, number | undefined>;
}

/** Mandatory dimensions per section: finite and > 0. Optional ones (fillets): finite and >= 0 when set. */
const REQUIRED: Record<ProfileSectionType, readonly string[]> = {
  Rectangle: ['XDim', 'YDim'],
  I: ['OverallWidth', 'OverallDepth', 'WebThickness', 'FlangeThickness'],
  L: ['Depth', 'Width', 'Thickness'],
  T: ['Depth', 'FlangeWidth', 'WebThickness', 'FlangeThickness'],
  U: ['Depth', 'FlangeWidth', 'WebThickness', 'FlangeThickness'],
  C: ['Depth', 'Width', 'WallThickness', 'Girth'],
  Circle: ['Radius'],
  RectangleHollow: ['XDim', 'YDim', 'WallThickness'],
  CircleHollow: ['Radius', 'WallThickness'],
};

/**
 * Refuse a section the mesher could not build or would build inside out:
 * non-positive dimensions, and walls, webs or flanges that do not fit in the
 * outer size. Throws with `op` in the message.
 */
export function validateProfileSection(section: ProfileSection, op: string): void {
  const cls = profileSectionIfcClass(section);
  const dims = dimensions(section);
  const required = REQUIRED[section.Type];
  for (const [name, value] of Object.entries(dims)) {
    if (value === undefined) continue;
    if (!required.includes(name) && !isNonNegativeFinite(value)) {
      throw new Error(`${op}: ${cls}.${name} must be a finite number >= 0`);
    }
  }
  for (const name of required) {
    const value = dims[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${op}: ${cls}.${name} must be a finite positive number`);
    }
  }
  const fits = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`${op}: ${cls} ${what}`);
  };
  switch (section.Type) {
    case 'I':
      fits(section.WebThickness < section.OverallWidth, 'WebThickness must be less than OverallWidth');
      fits(2 * section.FlangeThickness < section.OverallDepth, 'two FlangeThicknesses must be less than OverallDepth');
      break;
    case 'L':
      fits(section.Thickness < section.Depth && section.Thickness < section.Width, 'Thickness must be less than Depth and Width');
      break;
    case 'T':
      fits(section.WebThickness < section.FlangeWidth, 'WebThickness must be less than FlangeWidth');
      fits(section.FlangeThickness < section.Depth, 'FlangeThickness must be less than Depth');
      break;
    case 'U':
      fits(section.WebThickness < section.FlangeWidth, 'WebThickness must be less than FlangeWidth');
      fits(2 * section.FlangeThickness < section.Depth, 'two FlangeThicknesses must be less than Depth');
      break;
    case 'C':
      fits(2 * section.WallThickness < section.Width, 'two WallThicknesses must be less than Width');
      fits(2 * section.Girth < section.Depth, 'two Girths must be less than Depth');
      fits(section.WallThickness < section.Girth, 'WallThickness must be less than Girth');
      break;
    case 'RectangleHollow':
      fits(2 * section.WallThickness < Math.min(section.XDim, section.YDim), 'two WallThicknesses must be less than XDim and YDim');
      break;
    case 'CircleHollow':
      fits(section.WallThickness < section.Radius, 'WallThickness must be less than Radius');
      break;
    default:
      break;
  }
}

function isNonNegativeFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The section's axis-aligned extent in its own frame (metres):
 * `[along profile X, along profile Y]`. Profiles are centred, so the section
 * spans half of each on either side of the element axis. For callers that
 * need the outer size without meshing (fallback meshes, snapping, HUDs).
 */
export function profileSectionExtent(section: ProfileSection): [number, number] {
  switch (section.Type) {
    case 'Rectangle':
    case 'RectangleHollow':
      return [section.XDim, section.YDim];
    case 'I':
      return [section.OverallWidth, section.OverallDepth];
    case 'L':
    case 'C':
      return [section.Width, section.Depth];
    case 'T':
    case 'U':
      return [section.FlangeWidth, section.Depth];
    case 'Circle':
    case 'CircleHollow':
      return [2 * section.Radius, 2 * section.Radius];
  }
}

/**
 * Everything `emitProfileSection` would refuse, checked without emitting, so a
 * builder can validate its whole input before it writes its first entity.
 */
export function assertProfileSectionAuthorable(
  anchor: Pick<SpatialAnchor, 'schema'>,
  section: ProfileSection,
  op: string,
): ReturnType<typeof schemaRegistry> {
  validateProfileSection(section, op);
  return schemaRegistry(anchor.schema, op);
}

/**
 * Emit a centred parameterised profile (`IfcAxis2Placement2D` at the origin +
 * the profile class for `section.Type`) and return the profile's expressId.
 * Validates the section, converts it to native units, and lays the attributes
 * out for `anchor.schema` (IFC5 refused).
 */
export function emitProfileSection(
  editor: StoreEditor,
  anchor: Pick<SpatialAnchor, 'schema' | 'lengthUnitScale'>,
  section: ProfileSection,
  op = 'emitProfileSection',
): number {
  const registry = assertProfileSectionAuthorable(anchor, section, op);
  const cls = profileSectionIfcClass(section);
  const native: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(dimensions(section))) {
    if (value !== undefined) native[name] = toNativeLength(anchor, value);
  }
  const originPt = editor.addEntity('IfcCartesianPoint', [[0, 0]]).expressId;
  const position = editor.addEntity('IfcAxis2Placement2D', [`#${originPt}`, null]).expressId;
  const attrs = schemaAttributes(registry, cls, {
    ProfileType: 'AREA',
    Position: `#${position}`,
    ...native,
  }, op);
  return editor.addEntity(cls, attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
}

/** A linear element's validated section: the default rectangle or a `Profile`. */
export type LinearSection =
  | { Profile: ProfileSection; Width?: undefined; Height?: undefined }
  | { Width: number; Height: number; Profile?: undefined };

/**
 * Validate a beam's or member's section params: exactly one of the rectangle
 * (`Width` + `Height`, finite and positive) or a `Profile`, checked before
 * anything is emitted.
 */
export function linearSection(
  anchor: Pick<SpatialAnchor, 'schema'>,
  params: { Width?: number; Height?: number; Profile?: ProfileSection },
  op: string,
): LinearSection {
  if (params.Profile !== undefined) {
    if (params.Width !== undefined || params.Height !== undefined) {
      throw new Error(`${op}: give either Width and Height or a Profile, not both`);
    }
    assertProfileSectionAuthorable(anchor, params.Profile, op);
    return { Profile: params.Profile };
  }
  const { Width, Height } = params as { Width: number; Height: number };
  assertPositiveFinite([Width, Height], `${op}: Width and Height must be positive`);
  return { Width, Height };
}
