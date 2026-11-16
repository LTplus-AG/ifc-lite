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
import { deterministicGlobalId, type IfcDataStore } from '@ifc-lite/parser';
import { listItems } from './schema-converter-structural-axes.js';
import { slotUnset } from './schema-converter-structural-links.js';
import {
  conversionMode, isSubtype, readCarrierSets, SourceRecords, stepString, writeCarrierSet,
  type ConversionMode, type StructuralRewrite,
} from './schema-converter-structural-source.js';
import { refId } from './schema-ifc2x3-records.js';
import { readStepSlots, replaceStepArgument } from './step-argument-parser.js';
import { parseStepNumber } from './step-slot-grammar.js';
import { referencesAnyExpressId } from './step-ref-scan.js';

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

const naming = (args: readonly string[] | undefined, withheld: ReadonlySet<number> | undefined): boolean =>
  !!withheld && !!args?.some((a) => referencesAnyExpressId(a, withheld));

export class StructuralCarriers {
  /** The exporter's express-id allocator, shared with every other record it appends. */
  ids: (() => number) | null = null;
  private readonly pending: string[] = [];
  private mode: ConversionMode = null;
  /** Upgrade: action id -> reaction ids a source 'Causes' relationship already names. */
  private readonly causesWritten = new Map<number, Set<number>>();
  /** Downgrade: action id -> the one point reaction that causes it. */
  private readonly causedBy = new Map<number, number>();
  /** Upgrade: analysis model id -> the placement all its grouped items share. */
  private readonly shared = new Map<number, number>();
  /** Upgrade: load group id -> its SelfWeightCoefficients token; and the carrier records left out. */
  private readonly loadCases = new Map<number, string>();
  private readonly consumed = new Set<number>();

  fromStore(store: IfcDataStore, from: string, to: string): void {
    this.mode = conversionMode(from, to);
    if (!this.mode) return;
    const source = new SourceRecords(store);
    const causes = this.readCauses(source, from as 'IFC2X3' | 'IFC4');
    if (this.mode === 'downgrade') {
      // IFC2X3 CausedBy names one reaction, and IFC2X3 has only point reactions.
      for (const [action, reactions] of causes) {
        if (reactions.length === 1 && source.type(reactions[0]) === 'IFCSTRUCTURALPOINTREACTION') this.causedBy.set(action, reactions[0]);
      }
      return;
    }
    for (const [action, reactions] of causes) this.causesWritten.set(action, new Set(reactions));
    if (source.ids('IFCSTRUCTURALANALYSISMODEL').length) this.findSharedPlacements(source);
    if (source.ids('IFCSTRUCTURALLOADGROUP').length) this.findLoadCases(source);
  }

  /** Action id -> the reactions 'Causes' relationships name for it. */
  private readCauses(source: SourceRecords, schema: 'IFC2X3' | 'IFC4'): Map<number, number[]> {
    const causes = new Map<number, number[]>();
    for (const id of source.ids('IFCRELASSIGNSTOPRODUCT')) {
      const args = source.slots(id);
      if (args?.length !== 7 || stepString(args[2]) !== CAUSES || !slotUnset(args[5])) continue;
      const action = refId(args[6]);
      if (action === null || !isSubtype(schema, source.type(action), 'IfcStructuralAction')) continue;
      for (const r of (listItems(args[4]) ?? []).map(refId)) {
        if (r === null || !isSubtype(schema, source.type(r), 'IfcStructuralReaction')) continue;
        const list = causes.get(action) ?? [];
        list.push(r);
        causes.set(action, list);
      }
    }
    return causes;
  }

  /**
   * IFC2X3 gives each product its own placement record (IfcObjectPlacement
   * PlacesObject is SET [1:1] there), so a placement IFC4 shared comes back as
   * equal copies: local placements with the same arguments count as one, and
   * the lowest id is written.
   */
  private findSharedPlacements(source: SourceRecords): void {
    const placements = new Map<number, Map<string, number>>();
    for (const id of source.ids('IFCRELASSIGNSTOGROUP')) {
      const args = source.slots(id);
      const model = refId(args?.[6]);
      if (!args || model === null || source.type(model) !== 'IFCSTRUCTURALANALYSISMODEL') continue;
      const seen = placements.get(model) ?? new Map<string, number>();
      for (const item of (listItems(args[4]) ?? []).map(refId)) {
        if (item === null || !isSubtype('IFC2X3', source.type(item), 'IfcStructuralItem')) continue;
        const placement = refId(source.slots(item)?.[5]);
        const key = source.type(placement) === 'IFCLOCALPLACEMENT' ? source.slots(placement)?.map((a) => a.trim()).join(',') ?? '' : '';
        seen.set(key, Math.min(seen.get(key) ?? Infinity, placement ?? Infinity));
      }
      placements.set(model, seen);
    }
    for (const [model, seen] of placements) {
      if (seen.size !== 1) continue;
      const [[key, placement]] = seen;
      if (key) this.shared.set(model, placement);
    }
  }

  private findLoadCases(source: SourceRecords): void {
    for (const set of readCarrierSets(source, LOAD_CASE_PSET)) {
      const group = set.related.length === 1 ? set.related[0] : null;
      const prop = set.props.size === 1 ? set.props.get(COEFFICIENTS) : undefined;
      if (!set.exclusive || group === null || prop === undefined || source.type(group) !== 'IFCSTRUCTURALLOADGROUP') continue;
      if (source.slots(group)?.[5]?.trim().toUpperCase() !== '.LOAD_CASE.' || this.loadCases.has(group)) continue;
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
    const values = (listItems(args[2]) ?? []).map((v) => /^\s*IFCRATIOMEASURE\s*\((.*)\)\s*$/i.exec(v)?.[1]?.trim() ?? '');
    return values.length === 3 && values.every((v) => Number.isFinite(parseStepNumber(v))) ? `(${values.join(',')})` : null;
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
      if (entity === 'IFCSTRUCTURALLOADGROUP' && coefficients !== undefined && args.length === 10)
        return { body: `IFCSTRUCTURALLOADCASE(${[...args, coefficients].join(',')})`, losses: [LOAD_CASE_READ] };
      const placement = this.shared.get(id);
      if (entity === 'IFCSTRUCTURALANALYSISMODEL' && placement !== undefined && args.length === 9 && !withheld?.has(placement))
        return { body: `IFCSTRUCTURALANALYSISMODEL(${[...args, `#${placement}`].join(',')})`, losses: [SHARED_PLACEMENT] };
    } else if (this.mode === 'downgrade' && entity === 'IFCSTRUCTURALLOADCASE' && args.length === 11 && this.ids && !naming(args, withheld)) {
      const values = listItems(args[10]);
      const property = values?.length === 3
        ? `IFCPROPERTYLISTVALUE('${COEFFICIENTS}',$,(${values.map((v) => `IFCRATIOMEASURE(${v.trim()})`).join(',')}),$)`
        : `IFCPROPERTYSINGLEVALUE('${COEFFICIENTS}',$,$,$)`;
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
    if (reaction === null || withheld?.has(reaction) || naming(args, withheld)) return false;
    if (this.causesWritten.get(id)?.has(reaction)) return true;
    const guid = deterministicGlobalId(`ifc2x3-caused-by:${args[0].trim()}:#${reaction}`);
    this.pending.push(`#${this.ids()}=IFCRELASSIGNSTOPRODUCT('${guid}',${args[1]},'${CAUSES}',$,(#${reaction}),$,#${id});`);
    return true;
  }

  /** IFC4 -> IFC2X3: `line`, already converted record `id`, with an action's CausedBy filled from its 'Causes' relationship. */
  fillCausedBy(id: number, line: string, withheld: ReadonlySet<number> | undefined): string {
    const reaction = this.mode === 'downgrade' ? this.causedBy.get(id) : undefined;
    if (reaction === undefined || withheld?.has(reaction)) return line;
    const rec = readStepSlots(line);
    const slot = rec && IFC2X3_ACTIONS.has(rec.type) ? rec.slots[CAUSED_BY] : undefined;
    return slot !== undefined && slotUnset(slot) ? replaceStepArgument(line, CAUSED_BY, `#${reaction}`) ?? line : line;
  }

  /** Records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }
}
