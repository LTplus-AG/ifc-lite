/* SPDX-License-Identifier: MPL-2.0 */
/** Matches rust/export/src/schema_structural_diagnostics.rs (#9668). */
import { getSchemaRegistryForVersion, getCanonicalEntityName, type IfcDataStore } from '@ifc-lite/parser';
import { convertEntityType } from './schema-converter.js';
import { destabilizingUnknown, isStructuralAssignmentConversion } from './schema-converter-structural.js';
import { StructuralAxes } from './schema-converter-structural-axes.js';
import { StructuralCarriers } from './schema-converter-structural-carriers.js';
import { SourceRecords } from './schema-converter-structural-source.js';
import { StructuralThickness, THICKNESS_WRITTEN } from './schema-converter-structural-thickness.js';
import { StructuralLinks } from './schema-converter-structural-links.js';
import { StructuralVarying } from './schema-converter-structural-varying.js';
import { readStepSlots } from './step-argument-parser.js';
import { referencesAnyExpressId } from './step-ref-scan.js';

const NONE: ReadonlySet<string> = new Set();
const CAUSED_BY_UNCONVERTED = "IFC2X3 CausedBy of a varying action that stays unconverted is kept only in that IFC2X3 record; no 'Causes' relationship is written";
const LINK = 'IfcRelAssignsToProduct linking one structural member to its element is written as IfcRelConnectsStructuralElement, the IFC2X3 physical-to-analytical link';

export class StructuralDiagnostics {
  readonly axes = new StructuralAxes();
  readonly links = new StructuralLinks();
  readonly varying = new StructuralVarying();
  readonly carriers = new StructuralCarriers();
  readonly thickness = new StructuralThickness();
  private readonly losses = new Map<string, number>();
  /** Source record id -> attributes the target holds elsewhere (`note*`), which `inspect` does not report lost. */
  private readonly carried = new Map<number, ReadonlySet<string>>();

  /**
   * The source prepasses for an IFC2X3 <-> IFC4 export; the caller arms them
   * only for an unedited full export.
   */
  fromStore(store: IfcDataStore, from: string, to: string): void {
    if (from !== 'IFC2X3') this.links.fromStore(store);
    this.varying.fromStore(store, from, to);
    const source = new SourceRecords(store);
    this.axes.fromStore(source, from, to);
    this.carriers.fromStore(source, from, to);
    this.thickness.fromStore(source, from, to);
  }

  /** The exporter's express-id allocator, for the records the prepasses add. */
  set ids(next: () => number) { this.varying.ids = next; this.carriers.ids = next; this.thickness.ids = next; this.axes.ids = next; }

  /** Records the prepasses added, to append after the source records. */
  added(): string[] { return [...this.varying.added(), ...this.carriers.added(), ...this.thickness.added(), ...this.axes.added()]; }

  /** An already converted IFC2X3 <-> IFC4 line with the values carriers fill in place (`StructuralCarriers.after`). */
  after(line: string, withheld: ReadonlySet<number> | undefined): string {
    if (!this.carriers.rewritesAfter) return line;
    const filled = this.carriers.after(Number(/^\s*#(\d+)/.exec(line)?.[1]), line, withheld);
    if (!filled) return line;
    if (filled.loss) this.record(filled.loss);
    return filled.line;
  }

  inspect(id: number, line: string, from: string, to: string): void {
    const assignment = /^\s*#\d+\s*=\s*IFCRELCONNECTSSTRUCTURALELEMENT\s*\(/i.test(line) ? readStepSlots(line) : null;
    if (assignment && isStructuralAssignmentConversion(assignment.type, from, to)) {
      this.record('IfcRelConnectsStructuralElement is mapped to IfcRelAssignsToProduct; the relationship kind is not kept in the target file');
      return;
    }
    if (!((from === 'IFC2X3' && to === 'IFC4') || (from === 'IFC4' && to === 'IFC2X3'))) return;
    if (!/^\s*#\d+\s*=\s*(?:IFCSTRUCTURAL|IFCRELCONNECTSSTRUCTURAL|IFCRELASSOCIATESPROFILEPROPERTIES)/i.test(line)) return;
    const rec = readStepSlots(line);
    if (!rec || !(rec.type.startsWith('IFCSTRUCTURAL') || rec.type.startsWith('IFCRELCONNECTSSTRUCTURAL') || rec.type === 'IFCRELASSOCIATESPROFILEPROPERTIES')) return;
    // Recorded here, where the record takes the generic path, never for one withheld or rewritten.
    const notice = this.thickness.notice(id, rec.type, rec.slots);
    if (notice) this.record(notice);
    const source = getSchemaRegistryForVersion(from), target = getSchemaRegistryForVersion(to);
    const name = getCanonicalEntityName(source, rec.type);
    if (!name) return;
    const targetName = getCanonicalEntityName(target, convertEntityType(rec.type, from, to));
    const src = source.entities[name].allAttributes ?? source.entities[name].attributes;
    const meta = targetName ? target.entities[targetName] : undefined;
    if (!meta) {
      const outcome = to === 'IFC4' ? 'record remains unconverted; output does not conform to IFC4' : 'the original entity semantics cannot be retained';
      this.record(`${rec.type} has no representation in ${to}; ${outcome}`);
      return;
    }
    const tgt = (meta.allAttributes ?? meta.attributes).map(a => a.name);
    const carried = this.carried.get(id);
    this.carried.delete(id);
    src.forEach((attr, i) => {
      // CONST is intrinsic to IFC2X3 linear/planar actions, not lost data.
      if (attr.name === 'PredefinedType' && rec.slots[i]?.trim() === '.CONST.'
        && ['IFCSTRUCTURALCURVEACTION', 'IFCSTRUCTURALSURFACEACTION', 'IFCSTRUCTURALLINEARACTION', 'IFCSTRUCTURALPLANARACTION'].includes(rec.type)) return;
      if (attr.name === 'DestabilizingLoad' && rec.slots[i]?.trim() === '$' && to === 'IFC2X3')
        this.record(destabilizingUnknown(rec.type));
      if (carried?.has(attr.name)) return;
      if (!tgt.includes(attr.name) && rec.slots[i] && !['$', '*', ''].includes(rec.slots[i].trim())) {
        const effect = attr.name === 'ConditionCoordinateSystem' ? '; restraint directions in that coordinate system are not preserved' : '';
        this.record(`${rec.type}.${attr.name} has no slot in ${to}; its value is omitted${effect}`);
      }
    });
    // A tangent does not determine the local section z-axis. Do not invent one.
    if (to === 'IFC4' && tgt.includes('Axis') && !src.some(a => a.name === 'Axis') && !this.axes.axis(line))
      this.record(`${rec.type}.Axis is required by IFC4 but unknown; output does not conform until the model's section orientation is resolved`);
  }

  /**
   * A record written as another entity from source-derived facts (`StructuralLinks`,
   * `StructuralVarying`, `StructuralCarriers`, `StructuralThickness`, each armed only for its schema pair):
   * the target record body, or `null` for a carrier record the target leaves out.
   * A body still naming a `withheld` id is refused, and then nothing is reported.
   */
  rewrite(id: number, entity: string, args: readonly string[], withheld: ReadonlySet<number> | undefined): string | null | undefined {
    // An IFC2X3 varying action that stays unconverted is no IFC4 product a 'Causes' relationship could name.
    const unconverted = this.varying.staysUnconverted(entity, args);
    if (unconverted && this.carriers.causeOf(entity, args, withheld) !== null) this.record(CAUSED_BY_UNCONVERTED);
    const cause = unconverted ? null : this.carriers.noteCause(id, entity, args, withheld);
    const thickness = cause ? [] : this.thickness.note(id, entity, args, withheld);
    const axis = cause || thickness.length ? null : this.axes.hold(id, args, withheld);
    const held = cause ? ['CausedBy'] : axis ? ['Axis'] : thickness;
    let carried = NONE;
    if (held.length) {
      carried = new Set(held);
      this.record(cause ?? axis ?? THICKNESS_WRITTEN);
      this.carried.set(id, carried);
    }
    const attrs = this.links.link(entity, args);
    const rewrite = attrs ? { body: `IFCRELCONNECTSSTRUCTURALELEMENT(${attrs})`, losses: [LINK] }
      : this.varying.rewrite(entity, args, carried) ?? this.carriers.rewrite(id, entity, args, withheld) ?? this.thickness.rewrite(id, entity, args) ?? this.axes.rewrite(id, args);
    if (!rewrite || (withheld && rewrite.body !== null && referencesAnyExpressId(rewrite.body, withheld))) return undefined;
    rewrite.losses.forEach((loss) => this.record(loss));
    // A rewritten record skips `inspect`, which would free this.
    this.carried.delete(id);
    return rewrite.body;
  }

  private record(message: string): void { this.losses.set(message, (this.losses.get(message) ?? 0) + 1); }
  warnings(): string[] { return [...this.losses].sort(([a], [b]) => a.localeCompare(b)).map(([message, count]) => `${count} structural conversion record(s): ${message} (#9668).`); }
}
