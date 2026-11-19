/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entities whose attributes IFC4 INSERTED, REORDERED or RETYPED mid-list
 * relative to IFC2X3 (#10763), reconciled by a reviewed per-type map.
 *
 * The trim and pad in `schema-converter.ts` are only safe when one list is a
 * strict name prefix of the other. These types fail that test, so before
 * #10763 the converter kept the source layout: an IFC2X3 `IfcApproval`
 * upgraded to IFC4 put its `Description` in `Identifier`. A target slot takes
 * the source value of the same or the listed renamed attribute; every other
 * target slot is `$`. IFC4X3 declares the IFC4 lists for every mapped type.
 *
 * Twin of Rust `schema_attr_maps.rs`; both are held to
 * `rust/export/tests/fixtures/schema_attribute_maps.json`, which quotes the
 * IFC4 change note behind each map.
 */

import type { IfcSchemaVersion } from './schema-converter.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';

/** One reviewed IFC2X3 <-> IFC4 map. A same-named attribute in both lists is
 *  carried unless listed in `retyped` or, on a downgrade, `upOnly`. */
export interface AttrMap {
  readonly ifc2x3: string;
  /** The IFC4 (and IFC4X3) type. */
  readonly ifc4: string;
  /** `[IFC2X3 name, IFC4 name]`: one concept and one STEP value type. */
  readonly renamed: readonly (readonly [string, string])[];
  /** Same name, but a value of one type is not valid in the other. */
  readonly retyped: readonly string[];
  /** Same name; IFC4 widened the reference type, so only an upgrade carries it. */
  readonly upOnly: readonly string[];
  /** `[IFC2X3 single reference, IFC4 SET of them]`. */
  readonly setOfOne: readonly [string, string] | null;
}

function same(type: string, extra: Partial<AttrMap> = {}): AttrMap {
  return { ifc2x3: type, ifc4: type, renamed: [], retyped: [], upOnly: [], setOfOne: null, ...extra };
}

/** IfcResource gained `Identification` and `LongDescription` (the renamed
 *  `ResourceGroup`); `BaseQuantity` became an IfcPhysicalQuantity. */
function resource(type: string): AttrMap {
  return same(type, { renamed: [['ResourceIdentifier', 'Identification'], ['ResourceGroup', 'LongDescription']], retyped: ['BaseQuantity'] });
}

export const ATTR_MAPS: readonly AttrMap[] = [
  same('IFCAPPROVAL', { renamed: [['ApprovalStatus', 'Status'], ['ApprovalLevel', 'Level'], ['ApprovalQualifier', 'Qualifier']] }),
  same('IFCAPPROVALRELATIONSHIP', { setOfOne: ['RelatedApproval', 'RelatedApprovals'] }),
  same('IFCBLOBTEXTURE', { retyped: ['RasterCode'] }),
  same('IFCIMAGETEXTURE', { renamed: [['UrlReference', 'URLReference']] }),
  same('IFCPIXELTEXTURE'),
  same('IFCTEXTURECOORDINATEGENERATOR', { retyped: ['Parameter'] }),
  same('IFCTEXTUREMAP'),
  resource('IFCCONSTRUCTIONEQUIPMENTRESOURCE'),
  resource('IFCCONSTRUCTIONMATERIALRESOURCE'),
  resource('IFCCONSTRUCTIONPRODUCTRESOURCE'),
  resource('IFCCREWRESOURCE'),
  resource('IFCLABORRESOURCE'),
  resource('IFCSUBCONTRACTRESOURCE'),
  same('IFCCOSTSCHEDULE', { renamed: [['ID', 'Identification']], retyped: ['SubmittedOn', 'UpdateDate'] }),
  same('IFCCURRENCYRELATIONSHIP', { retyped: ['RateDateTime'] }),
  same('IFCDOCUMENTINFORMATIONRELATIONSHIP'),
  same('IFCLIBRARYINFORMATION', { retyped: ['VersionDate'], upOnly: ['Publisher'] }),
  // IFC4 deleted these IFC2X3 subtypes for its now-concrete supertype, so a
  // downgrade writes the deleted subtype (`IFC4_TO_IFC2X3`).
  { ...same('IFCEXTENDEDMATERIALPROPERTIES', { renamed: [['ExtendedProperties', 'Properties']] }), ifc4: 'IFCMATERIALPROPERTIES' },
  { ...same('IFCGENERALPROFILEPROPERTIES'), ifc4: 'IFCPROFILEPROPERTIES' },
  same('IFCPERFORMANCEHISTORY'),
  same('IFCTASK', { renamed: [['TaskId', 'Identification']] }),
  same('IFCPROPERTYDEPENDENCYRELATIONSHIP'),
];

const MAPPED_IFC4_TYPES: ReadonlySet<string> = new Set(ATTR_MAPS.map((m) => m.ifc4));

/** True when an IFC4 `line` upgraded from IFC2X3 gets its required slots
 *  counted: a structural record, or one a map wrote, which can leave a
 *  required slot with no source value (#10763). Twin of the check in Rust
 *  `convert_step_line`. */
export function upgradeCountsIfc4Slots(line: string): boolean {
  const type = /=\s*([A-Z0-9_]+)/i.exec(line)?.[1].toUpperCase() ?? '';
  return type.startsWith('IFCSTRUCTURAL') || MAPPED_IFC4_TYPES.has(type);
}

/** The map for writing `entityType` as `newType`, and whether it runs upward. */
export function attrMapFor(
  entityType: string,
  newType: string,
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): { map: AttrMap; up: boolean } | undefined {
  const ifc4Like = (s: IfcSchemaVersion) => s === 'IFC4' || s === 'IFC4X3';
  const up = fromSchema === 'IFC2X3' && ifc4Like(toSchema);
  if (!up && !(toSchema === 'IFC2X3' && ifc4Like(fromSchema))) return undefined;
  const [src, tgt] = up ? [entityType, newType] : [newType, entityType];
  const map = ATTR_MAPS.find((m) => m.ifc2x3 === src && m.ifc4 === tgt);
  return map && { map, up };
}

type Source = { name: string; how: 'value' | 'wrap' | 'unwrap' };

/** The source attribute (in the source list `src`) that fills target `name`. */
function sourceOf(map: AttrMap, up: boolean, name: string, src: readonly string[]): Source | undefined {
  // A pair read from the target's side: [target name, source name].
  const fromTarget = ([older, newer]: readonly [string, string]) => (up ? [newer, older] : [older, newer]);
  const renamed = map.renamed.map(fromTarget).find(([target]) => target === name);
  if (renamed) return { name: renamed[1], how: 'value' };
  const set = map.setOfOne && fromTarget(map.setOfOne);
  if (set && set[0] === name) return { name: set[1], how: up ? 'wrap' : 'unwrap' };
  const carried = !map.retyped.includes(name) && (up || !map.upOnly.includes(name));
  return carried && src.includes(name) ? { name, how: 'value' } : undefined;
}

/** A slot that carries information: not `$`, `*` or empty. */
function holdsValue(slot: string): boolean {
  const v = slot.trim();
  return v !== '' && v !== '$' && v !== '*';
}

/** The first member of a STEP list, or the value itself when it is not one. */
function firstMember(value: string): string {
  const v = value.trim();
  const members = v.startsWith('(') && v.endsWith(')') ? splitTopLevelStepArguments(v.slice(1, -1)) : null;
  if (members === null) return value;
  return members.find(holdsValue)?.trim() ?? '$';
}

/** `values` (in the source layout `src`) written in the target layout `tgt`.
 *  Same output as Rust `schema_attr_maps::remap`. */
export function remapByAttrMap(
  map: AttrMap,
  up: boolean,
  values: readonly string[],
  src: readonly string[],
  tgt: readonly string[],
): string {
  return tgt.map((name) => {
    const from = sourceOf(map, up, name, src);
    const i = from ? src.indexOf(from.name) : -1;
    const value = i >= 0 && i < values.length ? values[i] : '$';
    if (!from || !holdsValue(value)) return '$';
    if (from.how === 'unwrap') return firstMember(value);
    if (from.how === 'wrap' && !value.trimStart().startsWith('(')) return `(${value.trim()})`;
    return value;
  }).join(',');
}

/** Source attribute names whose values `remapByAttrMap` has no target slot for. */
export function attrsDroppedByMap(map: AttrMap, up: boolean, src: readonly string[], tgt: readonly string[]): string[] {
  const used = new Set(tgt.flatMap((name) => sourceOf(map, up, name, src)?.name ?? []));
  return src.filter((name) => !used.has(name));
}
