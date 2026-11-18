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
 *   ObjectPlacement. IFC2X3 gives each product its own placement record
 *   (IfcObjectPlacement PlacesObject is SET [1:1] there), so the downgrade
 *   leaves equal copies. The upgrade writes the lowest-id copy as
 *   SharedPlacement and places the items by it. A model sharing an item with
 *   another model is left alone.
 * - IfcStructuralLoadCase. IFC2X3 folds it into IfcStructuralLoadGroup and has
 *   no slot for SelfWeightCoefficients. The downgrade attaches a property set
 *   (`LOAD_CASE_PSET`) holding them; the upgrade turns a LOAD_CASE group that
 *   carries it back into the load case and leaves the property set out.
 *
 * The upgrade decides in `fromStore`: an IFC4 target withholds no ids
 * (`computeWithheldRefIds`), and `StructuralDiagnostics` adds no records when
 * one does. The downgrade checks withheld ids per record, where it writes.
 * Reads the source store, so only an unedited full export arms it.
 */
import { deterministicGlobalId } from '@ifc-lite/parser';
import { listItems } from './schema-converter-structural-axes.js';
import {
  bareMeasure, conversionMode, isSubtype, namesWithheld, readCarrierSets, slotRef, slotUnset, SourceRecords, stepString, writeCarrierSet,
  type ConversionMode, type StructuralRewrite,
} from './schema-converter-structural-source.js';
import { readStepSlots, replaceStepArgument } from './step-argument-parser.js';

/** The property set an IFC2X3 load group carries when it was an IFC4 IfcStructuralLoadCase. */
export const LOAD_CASE_PSET = 'IFC4 IfcStructuralLoadCase';
const COEFFICIENTS = 'SelfWeightCoefficients';
const CAUSES = 'Causes';
/** IfcStructuralAction.CausedBy in IFC2X3 (IFC2X3_TC1.exp:7237): slot 10 of every action. */
const CAUSED_BY = 10;
/** IfcProduct.ObjectPlacement. */
const OBJECT_PLACEMENT = 5;
const IFC2X3_ACTIONS = new Set(['IFCSTRUCTURALPOINTACTION', 'IFCSTRUCTURALLINEARACTION', 'IFCSTRUCTURALPLANARACTION', 'IFCSTRUCTURALLINEARACTIONVARYING', 'IFCSTRUCTURALPLANARACTIONVARYING']);

const CAUSED_BY_AMONG = "IFC2X3 CausedBy is one of several reactions the action's 'Causes' relationships name in IFC4, so IFC2X3 CausedBy cannot be restored from them";
const CAUSED_BY_WRITTEN = "IFC2X3 CausedBy is written as an IfcRelAssignsToProduct named 'Causes' from the action to the reaction, as IFC4 holds it";
const CAUSED_BY_READ = "an IfcRelAssignsToProduct named 'Causes' from an action to one point reaction also fills the IFC2X3 CausedBy";
const LOAD_CASE_WRITTEN = `IfcStructuralLoadCase is written as an IfcStructuralLoadGroup with a '${LOAD_CASE_PSET}' property set holding ${COEFFICIENTS}`;
const LOAD_CASE_READ = `an IfcStructuralLoadGroup with a '${LOAD_CASE_PSET}' property set is written as the IFC4 IfcStructuralLoadCase it came from`;
const SHARED_PLACEMENT = 'IfcStructuralAnalysisModel.SharedPlacement is written as the local placement all of its grouped structural items use or copy, and they are placed by it';

export class StructuralCarriers {
  /** The exporter's express-id allocator, shared with every other record it appends. */
  ids: (() => number) | null = null;
  /** Whether to find what the reverse conversion restores (`restored`, `restoredFrom`); only the loss report asks. */
  roundTrip = false;
  private readonly pending: string[] = [];
  private mode: ConversionMode = null;
  /** Upgrade: action id -> reaction ids a source 'Causes' relationship already names. */
  private causesWritten = new Map<number, Set<number>>();
  /** Upgrade: the source's point reactions, the only reactions IFC2X3 has. */
  private reactions: ReadonlySet<number> = new Set();
  /** Downgrade: action id -> the one point reaction that causes it. */
  private readonly causedBy = new Map<number, number>();
  /** Upgrade: analysis model id -> its SharedPlacement; item id -> the placement it is moved to. */
  private readonly shared = new Map<number, number>();
  private readonly itemPlacements = new Map<number, number>();
  /** Upgrade: load group id -> its SelfWeightCoefficients token; the carrier records left out. */
  private readonly loadCases = new Map<number, string>();
  private readonly consumed = new Set<number>();
  /** Downgrade: load cases that already have a carrier property set, so the upgrade would find two and read neither. */
  private readonly carrierLoadCases = new Set<number>();
  /** Downgrade: analysis models whose SharedPlacement the upgrade derives again from their items' placements. */
  private readonly sharedBack = new Set<number>();

  fromStore(source: SourceRecords, from: string, to: string): void {
    this.mode = conversionMode(from, to);
    if (!this.mode) return;
    const schema = from as 'IFC2X3' | 'IFC4';
    const hasActions = [...IFC2X3_ACTIONS, 'IFCSTRUCTURALCURVEACTION', 'IFCSTRUCTURALSURFACEACTION'].some((t) => source.ids(t).length);
    const causes = hasActions ? this.readCauses(source, schema) : new Map<number, Set<number>>();
    if (this.mode === 'downgrade') {
      // IFC2X3 CausedBy names one reaction, and IFC2X3 has only point reactions.
      for (const [action, reactions] of causes) {
        const [only] = reactions;
        if (reactions.size === 1 && source.type(only) === 'IFCSTRUCTURALPOINTREACTION') this.causedBy.set(action, only);
      }
      if (!this.roundTrip) return;
      if (source.ids('IFCSTRUCTURALLOADCASE').length) {
        for (const set of readCarrierSets(source, LOAD_CASE_PSET, false)) for (const g of set.related) this.carrierLoadCases.add(g);
      }
      if (source.ids('IFCSTRUCTURALANALYSISMODEL').length) {
        for (const [model, items] of soleModelItems(source, 'IFC4')) {
          // The upgrade takes the placement all items share; it is this one when this one shares it too.
          const args = source.slots(model);
          if (args?.length === 10 && items.size && commonPlacement(source, [slotRef(args[9]), ...items.values()]) !== null) this.sharedBack.add(model);
        }
      }
      return;
    }
    this.causesWritten = causes;
    if (hasActions) this.reactions = new Set(source.ids('IFCSTRUCTURALPOINTREACTION'));
    if (source.ids('IFCSTRUCTURALANALYSISMODEL').length) {
      for (const [model, items] of soleModelItems(source, 'IFC2X3')) this.findSharedPlacement(source, model, items);
    }
    if (source.ids('IFCSTRUCTURALLOADGROUP').length) this.findLoadCases(source);
  }

  /** Action id -> the reactions 'Causes' relationships name for it. */
  private readCauses(source: SourceRecords, schema: 'IFC2X3' | 'IFC4'): Map<number, Set<number>> {
    const causes = new Map<number, Set<number>>();
    for (const id of source.ids('IFCRELASSIGNSTOPRODUCT')) {
      const args = source.slots(id);
      if (args?.length !== 7 || stepString(args[2]) !== CAUSES) continue;
      const action = slotRef(args[6]);
      if (action === null || !isSubtype(schema, source.type(action), 'IfcStructuralAction')) continue;
      const reactions = listItems(args[4])?.map(slotRef);
      if (!reactions || reactions.includes(null)) continue;
      for (const r of reactions) {
        if (r !== null && isSubtype(schema, source.type(r), 'IfcStructuralReaction')) causes.set(action, (causes.get(action) ?? new Set<number>()).add(r));
      }
    }
    return causes;
  }

  /** IFC2X3 -> IFC4: the SharedPlacement of a model whose items' local placements are one or equal copies of one. */
  private findSharedPlacement(source: SourceRecords, model: number, items: ReadonlyMap<number, number | null>): void {
    if (source.slots(model)?.length !== 9 || !items.size) return;
    const placement = commonPlacement(source, items.values());
    if (placement === null) return;
    this.shared.set(model, placement);
    for (const [item, own] of items) if (own !== placement) this.itemPlacements.set(item, placement);
  }

  private findLoadCases(source: SourceRecords): void {
    const sets = readCarrierSets(source, LOAD_CASE_PSET);
    const perGroup = new Map<number, number>();
    for (const set of sets) for (const g of set.related) perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
    for (const set of sets) {
      const group = set.related.length === 1 ? set.related[0] : null;
      const prop = set.props.size === 1 ? set.props.get(COEFFICIENTS) : undefined;
      // A group with two carriers is ambiguous, so it keeps both and stays a load group.
      if (!set.exclusive || group === null || prop === undefined || perGroup.get(group) !== 1 || source.type(group) !== 'IFCSTRUCTURALLOADGROUP') continue;
      if (!isLoadCase(source.slots(group))) continue;
      const coefficients = this.coefficients(source.type(prop), source.slots(prop));
      if (coefficients === null) continue;
      this.loadCases.set(group, coefficients);
      for (const id of [set.rel, set.pset, prop]) this.consumed.add(id);
    }
  }

  /** The IFC4 SelfWeightCoefficients a carrier property holds: three ratios, or `$` from a value-less single value. */
  private coefficients(type: string | undefined, args: readonly string[] | undefined): string | null {
    if (args?.length !== 4) return null;
    if (type === 'IFCPROPERTYSINGLEVALUE' && slotUnset(args[2])) return '$';
    if (type !== 'IFCPROPERTYLISTVALUE') return null;
    const values = threeRatios(args[2]);
    return values ? `(${values.join(',')})` : null;
  }

  /**
   * The target body for one source record, `null` to leave it out, or
   * undefined to convert it as before. Records consumed as a carrier are left
   * out; a load group or analysis model gains its IFC4 value.
   */
  rewrite(id: number, entity: string, args: readonly string[], withheld: ReadonlySet<number> | undefined): StructuralRewrite | undefined {
    if (this.mode === 'upgrade') {
      if (this.consumed.has(id)) return { body: null, losses: [] };
      const coefficients = this.loadCases.get(id);
      if (coefficients !== undefined) return { body: `IFCSTRUCTURALLOADCASE(${[...args, coefficients].join(',')})`, losses: [LOAD_CASE_READ] };
      const placement = this.shared.get(id);
      if (placement !== undefined) return { body: `IFCSTRUCTURALANALYSISMODEL(${[...args, `#${placement}`].join(',')})`, losses: [SHARED_PLACEMENT] };
    } else if (this.mode === 'downgrade' && entity === 'IFCSTRUCTURALLOADCASE' && args.length === 11 && this.ids && !namesWithheld(args, withheld)) {
      const property = coefficientsProperty(args[10]);
      if (property === null) return undefined;
      this.pending.push(...writeCarrierSet(this.ids, `ifc4-load-case:${args[0].trim()}`, args[1], LOAD_CASE_PSET, id, [property]));
      const group = args.slice(0, 10);
      // The upgrade reads the set back only from a LOAD_CASE group that has no other.
      const restored = isLoadCase(group) && !this.carrierLoadCases.has(id) ? [[id, [COEFFICIENTS]] as const] : [];
      return { body: `IFCSTRUCTURALLOADGROUP(${group.join(',')})`, losses: [LOAD_CASE_WRITTEN], restored };
    }
    return undefined;
  }

  /** IFC4 -> IFC2X3: the attributes of record `id` that IFC2X3 leaves out and the upgrade derives again. */
  restoredFrom(id: number): readonly string[] {
    return this.sharedBack.has(id) ? ['SharedPlacement'] : [];
  }

  /**
   * IFC2X3 -> IFC4: the 'Causes' relationship for an action's CausedBy, added
   * unless the source's 'Causes' relationships already name that reaction.
   * Returns the message to report when IFC4 holds the cause and whether the
   * downgrade reads it back: it does when the action ends with that one cause
   * (CAUSED_BY_WRITTEN), not with several (CAUSED_BY_AMONG). Null when the carrier is not
   * armed (no upgrade, no id allocator, a withheld set) or the record is not an
   * IFC2X3 action whose CausedBy names a point reaction; `inspect` then reports
   * a set CausedBy omitted.
   */
  noteCause(id: number, entity: string, args: readonly string[], withheld: ReadonlySet<number> | undefined): { message: string; restored: boolean } | null {
    const reaction = this.causeOf(entity, args, withheld);
    if (reaction === null || !this.ids) return null;
    const written = this.causesWritten.get(id) ?? new Set<number>();
    if (!written.has(reaction)) {
      const guid = deterministicGlobalId(`ifc2x3-caused-by:${args[0].trim()}:#${reaction}`);
      this.pending.push(`#${this.ids()}=IFCRELASSIGNSTOPRODUCT('${guid}',${args[1]},'${CAUSES}',$,(#${reaction}),$,#${id});`);
    }
    // The downgrade restores CausedBy only for an action with exactly one cause.
    const total = written.size + (written.has(reaction) ? 0 : 1);
    return total === 1 ? { message: CAUSED_BY_WRITTEN, restored: true } : { message: CAUSED_BY_AMONG, restored: false };
  }

  /** IFC2X3 -> IFC4: the point reaction an action's CausedBy names that a 'Causes' relationship would carry, or null. */
  causeOf(entity: string, args: readonly string[], withheld: ReadonlySet<number> | undefined): number | null {
    // The added relationship names ids the source has; an IFC4 target withholds none, so none is checked.
    if (this.mode !== 'upgrade' || !this.ids || withheld?.size || !IFC2X3_ACTIONS.has(entity)) return null;
    const reaction = slotRef(args[CAUSED_BY]);
    return reaction !== null && this.reactions.has(reaction) ? reaction : null;
  }

  /** Whether `after` may change a converted line, so callers parse its id only then. */
  get rewritesAfter(): boolean { return this.causedBy.size > 0 || this.itemPlacements.size > 0; }

  /**
   * Record `id`, already converted to `line`, with what a carrier fills in
   * place: on the downgrade an action's CausedBy from its 'Causes'
   * relationship, on the upgrade a grouped item's ObjectPlacement as its
   * model's SharedPlacement. Undefined when nothing changes.
   */
  after(id: number, line: string, withheld: ReadonlySet<number> | undefined): { line: string; loss?: string } | undefined {
    const placement = this.itemPlacements.get(id);
    // SHARED_PLACEMENT, recorded once for the model, reports the move.
    if (placement !== undefined) {
      const filled = replaceStepArgument(line, OBJECT_PLACEMENT, `#${placement}`);
      return filled ? { line: filled } : undefined;
    }
    const reaction = this.causedBy.get(id);
    if (reaction === undefined || withheld?.has(reaction)) return undefined;
    const rec = readStepSlots(line);
    const slot = rec && IFC2X3_ACTIONS.has(rec.type) ? rec.slots[CAUSED_BY] : undefined;
    const filled = slot !== undefined && slotUnset(slot) ? replaceStepArgument(line, CAUSED_BY, `#${reaction}`) : null;
    return filled ? { line: filled, loss: CAUSED_BY_READ } : undefined;
  }

  /** Records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }
}

/**
 * The structural items an IFC2X3 IfcRelAssignsToGroup groups into each
 * analysis model, with each item's ObjectPlacement id, for the models none of
 * whose items another model also groups: IFC4 would require both models to
 * share one placement.
 */
function soleModelItems(source: SourceRecords, schema: 'IFC2X3' | 'IFC4'): Map<number, Map<number, number | null>> {
  const models = new Map<number, Map<number, number | null>>();
  const owners = new Map<number, Set<number>>();
  // A model one of whose groupings cannot be read in full is not known to share a placement.
  const unread = new Set<number>();
  for (const id of source.ids('IFCRELASSIGNSTOGROUP')) {
    const args = source.slots(id);
    const model = slotRef(args?.[6]);
    if (!args || model === null || source.type(model) !== 'IFCSTRUCTURALANALYSISMODEL') continue;
    const items = models.get(model) ?? new Map<number, number | null>();
    models.set(model, items);
    const listed = listItems(args[4])?.map(slotRef);
    if (!listed || listed.includes(null)) unread.add(model);
    for (const item of listed ?? []) {
      if (item === null || !isSubtype(schema, source.type(item), 'IfcStructuralItem')) continue;
      items.set(item, slotRef(source.slots(item)?.[OBJECT_PLACEMENT]));
      owners.set(item, (owners.get(item) ?? new Set<number>()).add(model));
    }
  }
  for (const [model, items] of models) if (unread.has(model) || [...items.keys()].some((i) => owners.get(i)!.size > 1)) models.delete(model);
  return models;
}

/**
 * The lowest-id local placement of `placements` when each is a local placement
 * and all are equal copies, or null. The upgrade writes it as SharedPlacement,
 * so the downgrade asks the same of the IFC4 one and its items' placements.
 */
function commonPlacement(source: SourceRecords, placements: Iterable<number | null>): number | null {
  const keys = new Set<string>();
  let placement = Infinity;
  for (const p of placements) {
    if (p === null || source.type(p) !== 'IFCLOCALPLACEMENT') return null;
    keys.add(source.slots(p)?.map((a) => a.trim()).join(',') ?? '');
    placement = Math.min(placement, p);
  }
  return keys.size === 1 ? placement : null;
}

/** Whether IFC2X3 load group slots are a LOAD_CASE group, the only kind the upgrade turns back into a load case. */
const isLoadCase = (args: readonly string[] | undefined): boolean => args?.length === 10 && args[5].trim().toUpperCase() === '.LOAD_CASE.';

/** Three ratios, each `0.` or `IFCRATIOMEASURE(0.)`, as bare numbers, or null. */
function threeRatios(token: string): string[] | null {
  const values = (listItems(token) ?? []).map((v) => bareMeasure(v, 'IFCRATIOMEASURE'));
  return values.length === 3 && values.every((v) => v !== null) ? values as string[] : null;
}

/** The carrier property for an IFC4 SelfWeightCoefficients slot, or null when it is not three ratios or `$`. */
function coefficientsProperty(token: string): string | null {
  if (slotUnset(token)) return `IFCPROPERTYSINGLEVALUE('${COEFFICIENTS}',$,$,$)`;
  const values = threeRatios(token);
  return values ? `IFCPROPERTYLISTVALUE('${COEFFICIENTS}',$,(${values.map((v) => `IFCRATIOMEASURE(${v})`).join(',')}),$)` : null;
}
