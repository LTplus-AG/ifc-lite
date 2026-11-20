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
import { list } from './schema-ifc2x3-records.js';
import { stepRecordHead } from './step-record-frame.js';
import { skipStepComment } from './step-comment-skip.js';
import { stepStringLiteralEnd } from '@ifc-lite/encoding';

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

function map(ifc2x3: string, ifc4: string, extra: Partial<AttrMap> = {}): AttrMap {
  return { ifc2x3, ifc4, renamed: [], retyped: [], upOnly: [], setOfOne: null, ...extra };
}

const same = (type: string, extra: Partial<AttrMap> = {}): AttrMap => map(type, type, extra);

/** IfcResource gained `Identification` and `LongDescription` (the renamed
 *  `ResourceGroup`); `BaseQuantity` became an IfcPhysicalQuantity. */
function resource(type: string): AttrMap {
  return same(type, { renamed: [['ResourceIdentifier', 'Identification'], ['ResourceGroup', 'LongDescription']], retyped: ['BaseQuantity'] });
}

export const ATTR_MAPS: readonly AttrMap[] = [
  same('IFCAPPROVAL', { renamed: [['ApprovalStatus', 'Status'], ['ApprovalLevel', 'Level'], ['ApprovalQualifier', 'Qualifier']] }),
  same('IFCAPPROVALRELATIONSHIP', { setOfOne: ['RelatedApproval', 'RelatedApprovals'] }),
  // IFC4 replaced IfcSurfaceTexture's `TextureType` enum with a `Mode` string of another meaning.
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
  // IFC4 deleted this IFC2X3 subtype for its now-concrete supertype, so a
  // downgrade writes the deleted subtype (`IFC4_TO_IFC2X3`). Downgrade only:
  // nothing renames the IFC2X3 subtype on an upgrade. IfcMaterialProperties is
  // left unmapped here: its Material referent must be resolved first (#10763 follow-up).
  map('IFCGENERALPROFILEPROPERTIES', 'IFCPROFILEPROPERTIES'),
  same('IFCPERFORMANCEHISTORY'),
  same('IFCTASK', { renamed: [['TaskId', 'Identification']] }),
  same('IFCPROPERTYDEPENDENCYRELATIONSHIP'),
];

const BY_IFC2X3: ReadonlyMap<string, AttrMap> = new Map(ATTR_MAPS.map((m) => [m.ifc2x3, m]));
const BY_IFC4: ReadonlyMap<string, AttrMap> = new Map(ATTR_MAPS.map((m) => [m.ifc4, m]));

/** True when an IFC4 `line` upgraded from IFC2X3 gets its required slots
 *  counted: a structural record, or one a map wrote, which can leave a
 *  required slot with no source value (#10763). The type is read from the
 *  record head. Twin of Rust `upgrade_counts_ifc4_slots`. */
export function upgradeCountsIfc4Slots(line: string): boolean {
  const head = stepRecordHead(line);
  const type = head ? line.slice(head.typeStart, head.typeEnd) : '';
  return type.startsWith('IFCSTRUCTURAL') || BY_IFC4.has(type);
}

/** The map for writing `entityType` as `newType`, and whether it runs upward. */
export function attrMapFor(
  entityType: string,
  newType: string,
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): { map: AttrMap; up: boolean } | undefined {
  if (fromSchema === 'IFC2X3' && (toSchema === 'IFC4' || toSchema === 'IFC4X3')) {
    const found = BY_IFC2X3.get(entityType);
    return found?.ifc4 === newType ? { map: found, up: true } : undefined;
  }
  if (toSchema === 'IFC2X3' && (fromSchema === 'IFC4' || fromSchema === 'IFC4X3')) {
    const found = BY_IFC4.get(entityType);
    return found?.ifc2x3 === newType ? { map: found, up: false } : undefined;
  }
  return undefined;
}

type Source = { name: string; how: 'value' | 'wrap' | 'unwrap' };

/** The source attribute (in the source list `src`) that fills target `name`. */
function sourceOf(map: AttrMap, up: boolean, name: string, src: readonly string[]): Source | undefined {
  // Pairs are [IFC2X3 name, IFC4 name]; the target's side is the second on an upgrade.
  const [target, source] = up ? [1, 0] : [0, 1];
  const renamed = map.renamed.find((pair) => pair[target] === name);
  if (renamed) return { name: renamed[source], how: 'value' };
  if (map.setOfOne?.[target] === name) return { name: map.setOfOne[source], how: up ? 'wrap' : 'unwrap' };
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
  const members = list(value);
  if (members === null) return value;
  return members.find(holdsValue)?.trim() ?? '$';
}

/** `value` with each `/* ... *\/` comment read as a space, trimmed. Literals and comments
 *  end by the shared rules; an unclosed one runs to the end. Twin of Rust
 *  `without_comments`. */
function withoutComments(value: string): string {
  let out = '';
  let kept = 0;
  for (let i = 0; i < value.length;) {
    if (value[i] === "'") {
      const end = stepStringLiteralEnd(value, i);
      i = end === -1 ? value.length : end;
    } else if (value.startsWith('/*', i)) {
      out += `${value.slice(kept, i)} `; // a space keeps the tokens the comment parted apart
      i = kept = skipStepComment(value, i);
    } else i++;
  }
  return (out + value.slice(kept)).trim();
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
    if (!from) return '$';
    // A SET is rebuilt, so comments around it or its members go.
    const bare = from.how === 'value' ? value : withoutComments(value);
    if (!holdsValue(bare)) return '$';
    if (from.how === 'value') return bare;
    if (from.how === 'unwrap') return firstMember(bare);
    return bare.startsWith('(') ? bare : `(${bare})`;
  }).join(',');
}

/** Whether narrowing this SET to one value discards any held member. */
export function dropsSetMembers(value: string): boolean {
  const members = list(withoutComments(value));
  return members !== null && members.filter(holdsValue).length > 1;
}

/** Source attributes with no target slot for their values, including a SET
 *  that could lose members. The model report checks that SET per record. */
export function attrsDroppedByMap(map: AttrMap, up: boolean, src: readonly string[], tgt: readonly string[]): string[] {
  const used = new Set(tgt.flatMap((name) => sourceOf(map, up, name, src)?.name ?? []));
  return src.filter((name) => !used.has(name) || (!up && name === map.setOfOne?.[1]));
}
