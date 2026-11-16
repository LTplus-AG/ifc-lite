/* SPDX-License-Identifier: MPL-2.0 */
/**
 * Structural values one of IFC2X3 and IFC4 holds in an attribute and the other
 * holds elsewhere (#9668). Each carrier is written so the other direction reads
 * it back:
 *
 * - CausedBy. IFC4 deleted IfcStructuralAction.CausedBy; an action caused by a
 *   reaction is the RelatingProduct of an IfcRelAssignsToProduct named 'Causes'
 *   whose RelatedObjects is the reaction (IFC4 IfcStructuralAction, "IFC4
 *   CHANGE ... use IfcRelAssignsToProduct via ReferencedBy instead"). The
 *   upgrade adds that relationship; the downgrade keeps it (IFC2X3 has the same
 *   entity) and fills CausedBy from it.
 * - SharedPlacement. IFC4's informal proposition on IfcStructuralAnalysisModel:
 *   every structural item grouped into the model uses SharedPlacement as its
 *   ObjectPlacement. The upgrade writes it when the IFC2X3 items' placements
 *   are one placement or equal copies of one.
 * - IfcStructuralLoadCase. IFC2X3 folds it into IfcStructuralLoadGroup and has
 *   no slot for SelfWeightCoefficients. The downgrade attaches a property set
 *   (`LOAD_CASE_PSET`) holding them; the upgrade turns a LOAD_CASE group that
 *   carries it back into the load case and leaves the property set out.
 *
 * Reads the source store, so only an unedited full export arms it.
 */
import { deterministicGlobalId } from '@ifc-lite/parser';
import { listItems } from './schema-converter-structural-axes.js';
import { slotUnset } from './schema-converter-structural-links.js';
import {
  conversionMode, isSubtype, namesWithheld, readCarrierSets, SourceRecords, stepString, writeCarrierSet,
  type ConversionMode, type StructuralRewrite,
} from './schema-converter-structural-source.js';
import { refId } from './schema-ifc2x3-records.js';
import { readStepSlots, replaceStepArgument } from './step-argument-parser.js';
import { parseStepNumber } from './step-slot-grammar.js';

/** The property set an IFC2X3 load group carries when it was an IFC4 IfcStructuralLoadCase. */
export const LOAD_CASE_PSET = 'IFC4 IfcStructuralLoadCase';
const COEFFICIENTS = 'SelfWeightCoefficients';
const CAUSES = 'Causes';
/** IfcStructuralAction.CausedBy in IFC2X3 (IFC2X3_TC1.exp:7237): slot 10 of every action. */
const CAUSED_BY = 10;
const IFC2X3_ACTIONS = new Set(['IFCSTRUCTURALPOINTACTION', 'IFCSTRUCTURALLINEARACTION', 'IFCSTRUCTURALPLANARACTION', 'IFCSTRUCTURALLINEARACTIONVARYING', 'IFCSTRUCTURALPLANARACTIONVARYING']);

export const CAUSED_BY_WRITTEN = "IFC2X3 CausedBy is written as an IfcRelAssignsToProduct named 'Causes' from the action to the reaction, as IFC4 holds it";
export const CAUSED_BY_READ = "an IfcRelAssignsToProduct named 'Causes' from an action to one point reaction also fills the IFC2X3 CausedBy";
export const LOAD_CASE_WRITTEN = `IfcStructuralLoadCase is written as an IfcStructuralLoadGroup with a '${LOAD_CASE_PSET}' property set holding ${COEFFICIENTS}`;
export const LOAD_CASE_READ = `an IfcStructuralLoadGroup with a '${LOAD_CASE_PSET}' property set is written as the IFC4 IfcStructuralLoadCase it came from`;
export const SHARED_PLACEMENT = 'IfcStructuralAnalysisModel.SharedPlacement is written as the ObjectPlacement all of its grouped structural items share';
export const SHARED_ITEM_PLACEMENT = 'a structural item on an equal copy of its analysis model\'s SharedPlacement is placed by the SharedPlacement itself';
export const SHARED_PLACEMENT_KEPT = 'IfcStructuralAnalysisModel.SharedPlacement has no slot in IFC2X3; it is kept as the ObjectPlacement of every grouped structural item, from which the upgrade restores it';

export class StructuralCarriers {
  /** The exporter's express-id allocator, shared with every other record it appends. */
  ids: (() => number) | null = null;
  private readonly pending: string[] = [];
  private mode: ConversionMode = null;
  /** Upgrade: action id -> reaction ids a source 'Causes' relationship already names. */
  private readonly causesWritten = new Map<number, Set<number>>();
  /** Downgrade: action id -> the one point reaction that causes it. */
  private readonly causedBy = new Map<number, number>();
  /** Upgrade: analysis model id -> the placement all its grouped items share; item id -> that placement, where it uses a copy. */
  private readonly shared = new Map<number, number>();
  /** Upgrade: item id -> the shared placement and the model whose SharedPlacement it is. */
  private readonly itemPlacements = new Map<number, { placement: number; model: readonly string[] }>();
  /** Upgrade: load group id -> its SelfWeightCoefficients token; carrier record id -> the group it carries for. */
  private readonly loadCases = new Map<number, string>();
  private readonly consumed = new Map<number, readonly string[]>();
  /** Downgrade: analysis models whose SharedPlacement every grouped item uses as its ObjectPlacement. */
  private readonly sharedKept = new Set<number>();

  fromStore(source: SourceRecords, from: string, to: string): void {
    this.mode = conversionMode(from, to);
    if (!this.mode) return;
    const causes = this.readCauses(source, from as 'IFC2X3' | 'IFC4');
    if (this.mode === 'downgrade') {
      // IFC2X3 CausedBy names one reaction, and IFC2X3 has only point reactions.
      for (const [action, reactions] of causes) {
        const [only] = reactions;
        if (reactions.size === 1 && source.type(only) === 'IFCSTRUCTURALPOINTREACTION') this.causedBy.set(action, only);
      }
      if (source.ids('IFCSTRUCTURALANALYSISMODEL').length) this.findKeptPlacements(source);
      return;
    }
    for (const [action, reactions] of causes) this.causesWritten.set(action, reactions);
    if (source.ids('IFCSTRUCTURALANALYSISMODEL').length) this.findSharedPlacements(source);
    if (source.ids('IFCSTRUCTURALLOADGROUP').length) this.findLoadCases(source);
  }

  /** Action id -> the reactions 'Causes' relationships name for it. */
  private readCauses(source: SourceRecords, schema: 'IFC2X3' | 'IFC4'): Map<number, Set<number>> {
    const causes = new Map<number, Set<number>>();
    for (const id of source.ids('IFCRELASSIGNSTOPRODUCT')) {
      const args = source.slots(id);
      if (args?.length !== 7 || stepString(args[2]) !== CAUSES) continue;
      const action = refId(args[6]);
      if (action === null || !isSubtype(schema, source.type(action), 'IfcStructuralAction')) continue;
      for (const r of (listItems(args[4]) ?? []).map(refId)) {
        if (r === null || !isSubtype(schema, source.type(r), 'IfcStructuralReaction')) continue;
        causes.set(action, (causes.get(action) ?? new Set<number>()).add(r));
      }
    }
    return causes;
  }

  /**
   * IFC2X3 gives each product its own placement record (IfcObjectPlacement
   * PlacesObject is SET [1:1] there), so a placement IFC4 shared comes back as
   * equal copies: local placements with the same arguments count as one, the
   * lowest id is written, and items on a copy are pointed at it, so the IFC4
   * proposition holds.
   */
  private findSharedPlacements(source: SourceRecords): void {
    const grouped = groupedItems(source, 'IFC2X3');
    /** Item id -> the shared placement of the first model claiming it. */
    const claimed = new Map<number, number>();
    const conflicted = new Set<number>();
    for (const [model, items] of grouped) {
      const args = source.slots(model);
      if (args?.length !== 9) continue;
      const seen = new Map<string, number>();
      for (const placement of items.values()) {
        const key = source.type(placement) === 'IFCLOCALPLACEMENT' ? source.slots(placement)?.map((a) => a.trim()).join(',') ?? '' : '';
        seen.set(key, Math.min(seen.get(key) ?? Infinity, placement ?? Infinity));
      }
      if (seen.size !== 1) continue;
      const [[key, placement]] = seen;
      if (!key) continue;
      this.shared.set(model, placement);
      for (const [item, own] of items) {
        // An item two models would place differently keeps its placement, and neither model claims one.
        if ((claimed.get(item) ?? placement) !== placement) conflicted.add(item);
        claimed.set(item, placement);
        if (own !== placement) this.itemPlacements.set(item, { placement, model: args });
      }
    }
    for (const item of conflicted) this.itemPlacements.delete(item);
    for (const [model, items] of grouped) {
      if ([...items.keys()].some((i) => conflicted.has(i))) this.shared.delete(model);
    }
  }

  /** IFC4 -> IFC2X3: the models whose SharedPlacement every grouped item uses, which the upgrade can restore. */
  private findKeptPlacements(source: SourceRecords): void {
    for (const [model, items] of groupedItems(source, 'IFC4')) {
      const placement = refId(source.slots(model)?.[9]);
      if (placement !== null && items.size && [...items.values()].every((p) => p === placement)) this.sharedKept.add(model);
    }
  }

  /** Whether the downgrade keeps this analysis model's SharedPlacement as its items' placement. */
  keepsSharedPlacement(id: number): boolean { return this.sharedKept.has(id); }

  private findLoadCases(source: SourceRecords): void {
    const sets = readCarrierSets(source, LOAD_CASE_PSET);
    const perGroup = new Map<number, number>();
    for (const set of sets) for (const g of set.related) perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
    for (const set of sets) {
      const group = set.related.length === 1 ? set.related[0] : null;
      const prop = set.props.size === 1 ? set.props.get(COEFFICIENTS) : undefined;
      // A group with two carriers is ambiguous, so it keeps both and stays a load group.
      if (!set.exclusive || group === null || prop === undefined || perGroup.get(group) !== 1 || source.type(group) !== 'IFCSTRUCTURALLOADGROUP') continue;
      const groupArgs = source.slots(group);
      if (groupArgs?.length !== 10 || groupArgs[5].trim().toUpperCase() !== '.LOAD_CASE.') continue;
      const coefficients = this.coefficients(source.type(prop), source.slots(prop));
      if (coefficients === null) continue;
      this.loadCases.set(group, coefficients);
      for (const id of [set.rel, set.pset, prop]) this.consumed.set(id, groupArgs);
    }
  }

  /** The IFC4 SelfWeightCoefficients a carrier property holds: three ratios, or `$` from a value-less single value. */
  private coefficients(type: string | undefined, args: readonly string[] | undefined): string | null {
    if (args?.length !== 4) return null;
    if (type === 'IFCPROPERTYSINGLEVALUE' && slotUnset(args[2])) return '$';
    if (type !== 'IFCPROPERTYLISTVALUE') return null;
    const values = (listItems(args[2]) ?? []).map(ratio);
    return values.length === 3 && values.every((v) => v !== null) ? `(${values.join(',')})` : null;
  }

  /**
   * The target body for one source record, `null` to leave it out, or
   * undefined to convert it as before. Records consumed as a carrier are left
   * out; a load group or analysis model gains its IFC4 value.
   */
  rewrite(id: number, entity: string, args: readonly string[], withheld: ReadonlySet<number> | undefined): StructuralRewrite | undefined {
    if (this.mode === 'upgrade') {
      // Left out only while its group can become the load case: a group naming a withheld id is refused.
      const group = this.consumed.get(id);
      if (group && !namesWithheld(group, withheld)) return { body: null, losses: [] };
      const coefficients = this.loadCases.get(id);
      if (entity === 'IFCSTRUCTURALLOADGROUP' && coefficients !== undefined && args.length === 10)
        return { body: `IFCSTRUCTURALLOADCASE(${[...args, coefficients].join(',')})`, losses: [LOAD_CASE_READ] };
      const placement = this.shared.get(id);
      if (entity === 'IFCSTRUCTURALANALYSISMODEL' && placement !== undefined && args.length === 9 && !withheld?.has(placement))
        return { body: `IFCSTRUCTURALANALYSISMODEL(${[...args, `#${placement}`].join(',')})`, losses: [SHARED_PLACEMENT] };
    } else if (this.mode === 'downgrade' && entity === 'IFCSTRUCTURALLOADCASE' && args.length === 11 && this.ids && !namesWithheld(args, withheld)) {
      const property = coefficientsProperty(args[10]);
      if (property === null) return undefined;
      this.pending.push(...writeCarrierSet(this.ids, `ifc4-load-case:${args[0].trim()}`, args[1], LOAD_CASE_PSET, id, [property]));
      return { body: `IFCSTRUCTURALLOADGROUP(${args.slice(0, 10).join(',')})`, losses: [LOAD_CASE_WRITTEN] };
    }
    return undefined;
  }

  /**
   * IFC2X3 -> IFC4: adds the 'Causes' relationship for an action's CausedBy,
   * unless the source has it already. True when IFC4 holds the cause either way.
   */
  noteCause(id: number, entity: string, args: readonly string[], withheld: ReadonlySet<number> | undefined): boolean {
    if (this.mode !== 'upgrade' || !this.ids || !IFC2X3_ACTIONS.has(entity)) return false;
    const reaction = refId(args[CAUSED_BY]);
    if (reaction === null || withheld?.has(reaction) || namesWithheld(args, withheld)) return false;
    if (this.causesWritten.get(id)?.has(reaction)) return true;
    const guid = deterministicGlobalId(`ifc2x3-caused-by:${args[0].trim()}:#${reaction}`);
    this.pending.push(`#${this.ids()}=IFCRELASSIGNSTOPRODUCT('${guid}',${args[1]},'${CAUSES}',$,(#${reaction}),$,#${id});`);
    return true;
  }

  /** Whether `after` may change a converted line, so callers parse its id only then. */
  get rewritesAfter(): boolean { return this.causedBy.size > 0 || this.itemPlacements.size > 0; }

  /**
   * Record `id`, already converted to `line`, with what a carrier fills in
   * place, and the message for it: on the downgrade an action's CausedBy from
   * its 'Causes' relationship, on the upgrade a grouped item's ObjectPlacement
   * as the model's SharedPlacement. Undefined when nothing changes.
   */
  after(id: number, line: string, withheld: ReadonlySet<number> | undefined): { line: string; loss: string } | undefined {
    if (this.mode === 'upgrade') {
      const shared = this.itemPlacements.get(id);
      // Only where the model's SharedPlacement is written: its rewrite is refused when it names a withheld id.
      const filled = !shared || withheld?.has(shared.placement) || namesWithheld(shared.model, withheld) ? null : replaceStepArgument(line, 5, `#${shared.placement}`);
      return filled ? { line: filled, loss: SHARED_ITEM_PLACEMENT } : undefined;
    }
    const reaction = this.mode === 'downgrade' ? this.causedBy.get(id) : undefined;
    if (reaction === undefined || withheld?.has(reaction)) return undefined;
    const rec = readStepSlots(line);
    const slot = rec && IFC2X3_ACTIONS.has(rec.type) ? rec.slots[CAUSED_BY] : undefined;
    const filled = slot !== undefined && slotUnset(slot) ? replaceStepArgument(line, CAUSED_BY, `#${reaction}`) : null;
    return filled ? { line: filled, loss: CAUSED_BY_READ } : undefined;
  }

  /** Records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }
}

/** The structural items grouped into each analysis model, with each item's ObjectPlacement id. */
function groupedItems(source: SourceRecords, schema: 'IFC2X3' | 'IFC4'): Map<number, Map<number, number | null>> {
  const models = new Map<number, Map<number, number | null>>();
  for (const id of source.ids('IFCRELASSIGNSTOGROUP')) {
    const args = source.slots(id);
    const model = refId(args?.[6]);
    if (!args || model === null || source.type(model) !== 'IFCSTRUCTURALANALYSISMODEL') continue;
    const items = models.get(model) ?? new Map<number, number | null>();
    for (const item of (listItems(args[4]) ?? []).map(refId)) {
      if (item !== null && isSubtype(schema, source.type(item), 'IfcStructuralItem')) items.set(item, refId(source.slots(item)?.[5]));
    }
    models.set(model, items);
  }
  return models;
}

/** A ratio as a bare number, from `0.` or `IFCRATIOMEASURE(0.)`, or null. */
function ratio(token: string): string | null {
  const bare = (/^\s*IFCRATIOMEASURE\s*\((.*)\)\s*$/i.exec(token)?.[1] ?? token).trim();
  return Number.isFinite(parseStepNumber(bare)) ? bare : null;
}

/** The carrier property for an IFC4 SelfWeightCoefficients slot, or null when it is not three ratios or `$`. */
function coefficientsProperty(token: string): string | null {
  if (slotUnset(token)) return `IFCPROPERTYSINGLEVALUE('${COEFFICIENTS}',$,$,$)`;
  const values = (listItems(token) ?? []).map(ratio);
  return values.length === 3 && values.every((v) => v !== null)
    ? `IFCPROPERTYLISTVALUE('${COEFFICIENTS}',$,(${values.map((v) => `IFCRATIOMEASURE(${v})`).join(',')}),$)`
    : null;
}
