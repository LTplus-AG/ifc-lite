/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-relationship-per-inverse bookkeeping for a merge (#5471, #5726, #5923,
 * #5774).
 *
 * A merge unifies entities that share a GlobalId (and spatial containers that
 * match), but it never unifies relationships: each model's `IfcRel*` lines are
 * written with fresh GlobalIds. So when two models state the same fact about a
 * unified entity, the output states it twice, and where the inverse that fact
 * fills is `SET [0:1]` (or a WHERE rule limits it to one) that is a schema
 * violation. This module holds the rule, once, for every such inverse.
 *
 * Split out of {@link ../merged-exporter.ts} (kept under its module-size
 * budget) rather than duplicated: `findEntitiesByType`/`extractStepAttribute`
 * stay the single source of truth in `MergedExporter` and are passed in here,
 * so this file has no data-model logic of its own to drift from it.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { filterHiddenRefsFromRelationshipLine } from './reference-collector.js';
import type { IfcSchemaVersion } from './schema-converter.js';
import { readStepSlots } from './step-argument-parser.js';

/**
 * How one relationship type fills a single-valued inverse. Every rule names a
 * single-valued `relating` attribute and a `related` attribute (a list, or a
 * single ref for the voids/fills pair), with the same indices in every schema.
 *
 * - `member`: the inverse on each RELATED object is single-valued. A later rel
 *   drops the members that already have one written (and is withheld when none
 *   is left).
 * - `owner`: the inverse on the RELATING object is single-valued (one
 *   `IfcRelDefinesByProperties` per property set, one `IfcRelDefinesByType` per
 *   type). A later rel whose relating object already has a written rel folds
 *   its members into that first rel instead of being written, so no object
 *   loses the definition.
 */
interface RelRule {
  relating: number;
  related: number;
  member?: string;
  owner?: string;
}

const AGGREGATES: RelRule = { relating: 4, related: 5, member: 'Decomposes' };
const CONTAINMENT: RelRule = { relating: 5, related: 4, member: 'ContainedInStructure' };
const VOIDS: RelRule = { relating: 4, related: 5, member: 'VoidsElements' };
const FILLS: RelRule = { relating: 4, related: 5, member: 'FillsVoids' };

/**
 * Relationship type (uppercase) → how it fills a single-valued inverse, in the
 * OUTPUT schema. The output schema decides because each rule is an inverse of
 * the schema the file is written in (#5726).
 *
 * IFC2X3: IfcRelAggregates and IfcRelNests are both IfcRelDecomposes, sharing
 * `Decomposes : SET [0:1]`; `IfcPropertySetDefinition.PropertyDefinitionOf` and
 * `IfcTypeObject.ObjectTypeOf` are `SET [0:1]`, and `IfcObject.WR1` allows one
 * IfcRelDefinesByType in `IsDefinedBy`.
 */
const IFC2X3_RULES: ReadonlyMap<string, RelRule> = new Map([
  ['IFCRELAGGREGATES', AGGREGATES],
  ['IFCRELNESTS', AGGREGATES],
  ['IFCRELCONTAINEDINSPATIALSTRUCTURE', CONTAINMENT],
  ['IFCRELDEFINESBYPROPERTIES', { relating: 5, related: 4, owner: 'PropertyDefinitionOf' }],
  ['IFCRELDEFINESBYTYPE', { relating: 5, related: 4, member: 'IsDefinedBy(IfcRelDefinesByType)', owner: 'ObjectTypeOf' }],
  ['IFCRELVOIDSELEMENT', VOIDS],
  ['IFCRELFILLSELEMENT', FILLS],
]);
/**
 * IFC4 and later split `Nests : SET [0:1]` off `Decomposes`, and replace the
 * IFC2X3 definers with `IsTypedBy`/`Types`/`DefinesOccurrence`, each
 * `SET [0:1]`; `HasContext` (IfcRelDeclares) and a property set's
 * `IsDefinedBy` (IfcRelDefinesByTemplate) are `SET [0:1]` too.
 */
const IFC4_RULES: ReadonlyMap<string, RelRule> = new Map([
  ['IFCRELAGGREGATES', AGGREGATES],
  ['IFCRELNESTS', { relating: 4, related: 5, member: 'Nests' }],
  ['IFCRELCONTAINEDINSPATIALSTRUCTURE', CONTAINMENT],
  ['IFCRELDEFINESBYPROPERTIES', { relating: 5, related: 4, owner: 'DefinesOccurrence' }],
  ['IFCRELDEFINESBYTYPE', { relating: 5, related: 4, member: 'IsTypedBy', owner: 'Types' }],
  ['IFCRELDEFINESBYTEMPLATE', { relating: 5, related: 4, member: 'IsDefinedBy(IfcRelDefinesByTemplate)' }],
  ['IFCRELDECLARES', { relating: 4, related: 5, member: 'HasContext' }],
  ['IFCRELVOIDSELEMENT', VOIDS],
  ['IFCRELFILLSELEMENT', FILLS],
]);

/** The first written rel of an `owner` rule for one relating object. */
interface OwnerRel {
  /** Attribute of the rel line that lists its members. */
  related: number;
  /** Final ids the rel already lists, and the ones later rels fold in. */
  members: Set<number>;
  extra: number[];
  /** Index of the rendered line in the output, once written. */
  lineIndex?: number;
}

/**
 * The final ids that already fill a single-valued inverse in the merge
 * output, per inverse of the output schema. One instance per merge, grown
 * model by model in merge order.
 */
export class ParentClaims {
  /** Relationship type (uppercase) → its rule; see {@link IFC4_RULES}. */
  readonly rules: ReadonlyMap<string, RelRule>;
  private readonly parented = new Map<string, Set<number>>();
  private readonly owners = new Map<string, Map<number, OwnerRel>>();

  /** `only` narrows the claimed relationship types (the #5725 drop planner's view). */
  constructor(outputSchema: IfcSchemaVersion, only: (relType: string) => boolean = () => true) {
    const rules = outputSchema === 'IFC2X3' ? IFC2X3_RULES : IFC4_RULES;
    this.rules = new Map([...rules].filter(([relType]) => only(relType)));
  }

  /** The final ids that already fill `inverse` in the output. */
  parentedVia(inverse: string): Set<number> {
    let ids = this.parented.get(inverse);
    if (ids === undefined) this.parented.set(inverse, (ids = new Set()));
    return ids;
  }

  /** The first written rel per relating object, for an `owner` inverse. */
  ownersVia(inverse: string): Map<number, OwnerRel> {
    let owners = this.owners.get(inverse);
    if (owners === undefined) this.owners.set(inverse, (owners = new Map()));
    return owners;
  }

  /**
   * Append the members later models folded into each owner rel to its written
   * line (see {@link claimSingleParents}). Runs once, after every model is
   * rendered, since an owner is written before the rel folded into it.
   */
  foldInto(lines: string[]): void {
    for (const owners of this.owners.values()) {
      for (const owner of owners.values()) {
        if (owner.extra.length === 0 || owner.lineIndex === undefined) continue;
        lines[owner.lineIndex] = appendToListAttribute(lines[owner.lineIndex], owner.related, owner.extra);
      }
    }
  }
}

/** What {@link claimSingleParents} needs to know about one model's plan. */
export interface ParentClaimInput {
  dataStore: IfcDataStore;
  /** Local id → final id for every unified entity (spatial, infrastructure, GlobalId). */
  sharedRemap: ReadonlyMap<number, number>;
  /** This model's id offset: an unremapped local id's final id is `id + idOffset`. */
  idOffset: number;
  /** Local ids not written; a skipped rel claims nothing, and a rel skipped here is added. */
  skipEntityIds: Set<number>;
  /** Local rel id → member ids to drop from its written related list. */
  relParentStrip: Map<number, Set<number>>;
  /** Local rel id → the owner record it writes; {@link bindOwnerLine} records where. */
  ownerRels: Map<number, OwnerRel>;
  /**
   * Whether a local id survives into the output as a reference: false for a
   * hidden product under `visibleOnly` or a dropped empty container, which
   * `renderEntity` narrows out of (or, as a relating object, withholds) the rel.
   */
  isEmitted: (localId: number) => boolean;
  /** Whether the rel line itself is in the written set at all (visibility closure). */
  isIncluded: (localId: number) => boolean;
  /** Strip or fold already-claimed members (a later, unified model); false just records claims. */
  dedupe: boolean;
}

/**
 * Keep one relationship per object and single-valued inverse across a merge.
 *
 * `IfcObjectDefinition.Decomposes` is `SET [0:1]` (#5471, #5726), and so is
 * `IfcElement.ContainedInStructure` (#5923), a property set's definer
 * (#5774), and the rest of {@link IFC4_RULES}. Once a later model's entity
 * unifies with an earlier one, the earlier model's rel already fills that
 * inverse, so the later rel naming the same (final) id fills it a second time,
 * whether its other end remaps to the same entity (a duplicate edge) or a
 * different one. Which relationships share an inverse is the output schema's
 * call, held by {@link ParentClaims}.
 *
 * Called once per model in merge order, after all of that model's unification
 * and container drops. Every rel the model will write records its written
 * members. A rel that will not be written (skipped, outside the visibility
 * closure, or with a hidden or dropped relating object) claims nothing, and
 * neither does a member narrowed out of it, so a later model's rel still
 * states a fact whose earlier statement is not in the output.
 *
 * With `dedupe`, for a `member` rule a written member already claimed is
 * redundant: a rel whose written members are ALL redundant is skipped, one
 * with SOME is kept for its new members and the redundant ids go to
 * `relParentStrip` for {@link applyRelParentStrip}. A unified member with no
 * claim yet is kept, since that rel is then its only statement (#3550). For an
 * `owner` rule whose relating object already has a written rel, the rel is
 * skipped and its remaining members are folded into that rel's line
 * ({@link ParentClaims.foldInto}).
 */
export function claimSingleParents(
  input: ParentClaimInput,
  claims: ParentClaims,
  findEntitiesByType: (dataStore: IfcDataStore, typeUpper: string) => number[],
  extractStepAttribute: (expressId: number, dataStore: IfcDataStore, attrIndex: number) => string | null,
): void {
  const { dataStore, sharedRemap, idOffset, skipEntityIds, relParentStrip, ownerRels, isEmitted, isIncluded, dedupe } = input;
  const finalId = (ref: number) => sharedRemap.get(ref) ?? ref + idOffset;
  for (const [relType, rule] of claims.rules) {
    const parented = rule.member === undefined ? null : claims.parentedVia(rule.member);
    const owners = rule.owner === undefined ? null : claims.ownersVia(rule.owner);
    for (const relId of findEntitiesByType(dataStore, relType)) {
      if (skipEntityIds.has(relId) || !isIncluded(relId)) continue;
      // The relating end is a single #ref; a hidden or dropped one withholds the line.
      const relatingMatch = extractStepAttribute(relId, dataStore, rule.relating)?.match(/^#(\d+)$/);
      const relating = relatingMatch ? parseInt(relatingMatch[1], 10) : null;
      if (relating !== null && !isEmitted(relating)) continue;
      // The related end is a list of #refs like (#2,#3), or one #ref; hidden members are narrowed out.
      const refs = listRefs(extractStepAttribute(relId, dataStore, rule.related)).filter(isEmitted);
      if (refs.length === 0) continue;

      const redundant = dedupe && parented !== null ? refs.filter(ref => parented.has(finalId(ref))) : [];
      if (redundant.length === refs.length) {
        // Every written member already fills the inverse in the output — fully redundant.
        skipEntityIds.add(relId);
        continue;
      }
      const kept = redundant.length === 0 ? refs : refs.filter(ref => !redundant.includes(ref));
      for (const ref of kept) parented?.add(finalId(ref));

      if (owners !== null && relating !== null) {
        const owner = owners.get(finalId(relating));
        if (owner !== undefined && dedupe) {
          skipEntityIds.add(relId);
          for (const id of kept.map(finalId)) {
            if (owner.members.has(id)) continue;
            owner.members.add(id);
            owner.extra.push(id);
          }
          continue;
        }
        if (owner === undefined) {
          const record: OwnerRel = { related: rule.related, members: new Set(kept.map(finalId)), extra: [] };
          owners.set(finalId(relating), record);
          ownerRels.set(relId, record);
        }
      }
      if (redundant.length > 0) relParentStrip.set(relId, new Set(redundant));
    }
  }
}

/** Record where an owner rel's line landed in the output (see {@link ParentClaims.foldInto}). */
export function bindOwnerLine(ownerRels: ReadonlyMap<number, OwnerRel>, localId: number, lineIndex: number): void {
  const owner = ownerRels.get(localId);
  if (owner !== undefined) owner.lineIndex = lineIndex;
}

/** The `#id`s in one STEP list (or single-ref) attribute, in order; `[]` for a missing one. */
function listRefs(attr: string | null): number[] {
  if (!attr) return [];
  const refs: number[] = [];
  const refRegex = /#(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(attr)) !== null) refs.push(parseInt(match[1], 10));
  return refs;
}

/** `line` with `#id`s appended to its list attribute `attrIndex`; unchanged if that is not a list. */
function appendToListAttribute(line: string, attrIndex: number, ids: readonly number[]): string {
  const record = readStepSlots(line);
  const slot = record?.slots[attrIndex]?.trim();
  if (record === null || slot === undefined || !slot.startsWith('(') || !slot.endsWith(')')) return line;
  const additions = ids.map(id => `#${id}`).join(',');
  const slots = [...record.slots];
  slots[attrIndex] = slot === '()' ? `(${additions})` : `${slot.slice(0, -1)},${additions})`;
  return `${record.prefix}${slots.join(',')}${record.suffix}`;
}

/**
 * Render-time counterpart of {@link claimSingleParents}: drop the related
 * members of a partially redundant rel that already fill that inverse in the
 * output. Reuses the same list/scalar-aware ref filter the
 * `visibleOnly`/deletion dangling-ref path uses. Must run in LOCAL id
 * space, before any id offset/remap — `localId` and the ids inside
 * `relParentStrip` are both local to the model being rendered.
 *
 * Returns `entityText` unchanged when `localId` has no strip entry, and
 * `null` when the filter would withhold the whole line — a strip set built
 * by {@link claimSingleParents} is a strict subset of the related list, so
 * for well-formed input the filter only narrows, but a degenerate file (a
 * stripped member id that also appears as a single-valued ref, e.g.
 * self-aggregation) can null the line. The caller must withhold it, like
 * every other user of the filter: every edge the line declared is already
 * declared by an earlier model, and emitting the unfiltered bytes instead
 * would reintroduce the duplicate this module exists to remove.
 */
export function applyRelParentStrip(
  entityText: string,
  localId: number,
  relParentStrip: ReadonlyMap<number, ReadonlySet<number>>,
): string | null {
  const toStrip = relParentStrip.get(localId);
  if (toStrip === undefined) return entityText;
  return filterHiddenRefsFromRelationshipLine(entityText, id => toStrip.has(id));
}
