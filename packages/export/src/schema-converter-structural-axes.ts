/* SPDX-License-Identifier: MPL-2.0 */
/**
 * IfcStructuralCurveMember.Axis IFC2X3 <-> IFC4 (#9668). IFC4 requires it
 * (IFC4_ADD2_TC1.exp:9423) and gives it "relative to ... the
 * SELF\IfcProduct.ObjectPlacement" (IFC4 IfcStructuralCurveMember.Axis).
 * IFC2X3 has no slot (IFC2X3_TC1.exp:7281); it holds the section orientation
 * as IfcRelAssociatesProfileProperties.ProfileOrientation (:6548), a direction
 * "of the structural coordinate system of the analysis model" (IFC2x3 TC1
 * IfcRelAssociatesProfileProperties), the world frame an unplaced member is
 * given in (IFC2x3 TC1 IfcStructuralCurveMember, Placement).
 *
 * The upgrade fills Axis from that orientation, turned into the member's
 * placement frame. The downgrade writes Axis turned into the world frame:
 * into the one association the member has when it leaves the orientation
 * unset, else as a new association named `AXIS_CARRIER` to an
 * IfcGeneralProfileProperties with no values (all its attributes are
 * OPTIONAL and its WR1 holds on an unset area). The upgrade leaves such a
 * carrier out, so a round trip gives back the source records.
 *
 * An unrotated frame names the source direction itself; a rotated one names
 * a new direction, and the way back names a source direction of equal value.
 * Reads the source store, so only an unedited full export arms it.
 * The upgrade for unplaced members matches rust/export/src/schema_structural_axes.rs.
 */
import { formatStepReal } from '@ifc-lite/data';
import { deterministicGlobalId } from '@ifc-lite/parser';
import { readStepSlots } from './step-argument-parser.js';
import { parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';
// A cycle with the source module, which reads lists here; only functions cross it, called after load.
import { conversionMode, namesWithheld, slotRef, slotUnset, stepString, type ConversionMode, type SourceRecords, type StructuralRewrite } from './schema-converter-structural-source.js';

/** The Name of an association the downgrade writes only to carry an Axis. */
const AXIS_CARRIER = 'IFC4 Axis';
const AXIS_WRITTEN = `IFC4 Axis is written as IfcRelAssociatesProfileProperties.ProfileOrientation in the analysis model frame`;
const MEMBERS = new Set(['IFCSTRUCTURALCURVEMEMBER', 'IFCSTRUCTURALCURVEMEMBERVARYING']);
const RELATION = 'IFCRELASSOCIATESPROFILEPROPERTIES';
const OBJECT_PLACEMENT = 5;
/** IFC4 IfcStructuralCurveMember.Axis. */
const AXIS = 8;
/** IfcRelAssociatesProfileProperties.RelatedObjects, RelatingProfileProperties, ProfileOrientation. */
const RELATED = 4, PROPERTIES = 5, ORIENTATION = 7;
/** How far apart two direction ratios may be and still be the same direction. */
const EPS = 1e-9;

type Vec3 = [number, number, number];
/** A rotation as the images of the local x, y and z axes. */
type Frame = [Vec3, Vec3, Vec3];
const IDENTITY: Frame = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export function listItems(token: string | undefined): readonly string[] | null {
  if (token === undefined) return null;
  const start = skipStepTrivia(token, 0);
  if (start < 0 || token[start] !== '(') return null;
  // Reuse the shared record frame for a standalone tuple, including trailing
  // comments containing ')'. This parsing envelope is never exported.
  return readStepSlots(`#0=IFCDIRECTION${token};`)?.slots ?? null;
}

/** The three finite ratios of a direction tuple, not all zero, or null. */
function ratios(token: string | undefined): Vec3 | null {
  const values = listItems(token)?.map(parseStepNumber);
  return values?.length === 3 && values.every(Number.isFinite) && values.some((x) => x !== 0) ? values as Vec3 : null;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 | null => { const n = Math.sqrt(dot(a, a)); return n < EPS ? null : scale(a, 1 / n); };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** `v` in local coordinates, in the parent's. */
const apply = (f: Frame, v: Vec3): Vec3 => [0, 1, 2].map((i) => f[0][i] * v[0] + f[1][i] * v[1] + f[2][i] * v[2]) as Vec3;
/** `v` in the parent's coordinates, in local ones. */
const unapply = (f: Frame, v: Vec3): Vec3 => [dot(f[0], v), dot(f[1], v), dot(f[2], v)];
const isIdentity = (f: Frame): boolean => f.every((axis, i) => axis.every((x, j) => x === (i === j ? 1 : 0)));
const near = (a: Vec3, b: Vec3): boolean => a.every((x, i) => Math.abs(x - b[i]) <= EPS * Math.max(1, Math.abs(x)));
/** A key equal for directions whose ratios agree to 12 digits. */
const key = (v: Vec3): string => tuple(v, 12);
/** Ratios as STEP, with the float noise of a turn rounded away. */
const tuple = (v: Vec3, digits = 15): string => `(${v.map((x) => formatStepReal(Number(x.toPrecision(digits)) || 0)).join(',')})`;

export class StructuralAxes {
  /** The exporter's express-id allocator, shared with every other record it appends. */
  ids: (() => number) | null = null;
  private readonly pending: string[] = [];
  private mode: ConversionMode = null;
  /** Upgrade: member id -> its one ProfileOrientation, or null when its associations disagree. */
  private readonly axes = new Map<number, number | null>();
  private readonly directions = new Map<number, Vec3>();
  /** Upgrade: direction value key -> the first source direction with it, built on the first turned member. */
  private byValue: Map<string, number> | null = null;
  /** Placement id -> its rotation in the world frame, or null when it does not read. */
  private readonly frames = new Map<number, Frame | null>();
  private source: SourceRecords | null = null;
  /** Upgrade: member id -> the Axis written for it. */
  private readonly filled = new Map<number, string | undefined>();
  /** Upgrade: carrier records left out. Downgrade: association id -> the member whose Axis fills its orientation. */
  private readonly consumed = new Set<number>();
  private readonly fills = new Map<number, number>();
  /** Downgrade: member id -> its world Axis and how it travels: in an association it has, or in a new one. */
  private readonly carried = new Map<number, { world: Vec3; axis: number; frame: Frame; into: number | null }>();

  /** Reads one IFC2X3 record; `fromStore` reads them all. */
  note(line: string): void {
    const rec = readStepSlots(line), id = /^\s*#(\d+)/.exec(line)?.[1];
    if (rec && id) this.read(Number(id), rec.type, rec.slots);
  }

  private read(id: number, type: string, slots: readonly string[]): void {
    if (type === 'IFCDIRECTION') {
      const values = ratios(slots[0]);
      if (values) this.directions.set(id, values);
    } else if (type === RELATION && slots.length === 8) {
      const axis = slotRef(slots[ORIENTATION]);
      for (const token of listItems(slots[RELATED]) ?? []) {
        const member = slotRef(token);
        if (member === null) continue;
        this.axes.set(member, this.axes.has(member) && this.axes.get(member) !== axis ? null : axis);
      }
    }
  }

  fromStore(source: SourceRecords, from: string, to: string): void {
    this.mode = conversionMode(from, to);
    const rels = source.ids(RELATION);
    if (!this.mode || (this.mode === 'upgrade' && !rels.length)) return;
    const members = [...MEMBERS].flatMap((t) => source.ids(t));
    if (!members.length) return;
    this.source = source;
    for (const id of source.ids('IFCDIRECTION')) this.read(id, 'IFCDIRECTION', source.slots(id) ?? []);
    if (this.mode === 'upgrade') {
      for (const id of rels) this.read(id, RELATION, source.slots(id) ?? []);
      this.findCarriers(source, rels);
    } else {
      this.planCarriers(source, members, rels);
    }
  }

  /** The rotation of a placement slot in the world frame: identity for `$`, null when it does not read. */
  private frame(token: string | undefined, depth = 0): Frame | null {
    if (slotUnset(token)) return IDENTITY;
    const id = slotRef(token);
    if (id === null || depth > 64 || !this.source) return null;
    if (this.frames.has(id)) return this.frames.get(id)!;
    const source = this.source;
    let frame: Frame | null = null;
    const slots = source.type(id) === 'IFCLOCALPLACEMENT' ? source.slots(id) : undefined;
    const place = slotRef(slots?.[1]);
    const placement = source.slots(place), type = source.type(place);
    const parent = slots ? this.frame(slots[0], depth + 1) : null;
    const direction = (token: string | undefined, fallback: Vec3): Vec3 | null =>
      slotUnset(token) ? fallback : source.type(slotRef(token)) === 'IFCDIRECTION' ? ratios(source.slots(slotRef(token))?.[0]) : null;
    if (parent && placement && (type === 'IFCAXIS2PLACEMENT3D' || type === 'IFCAXIS2PLACEMENT2D')) {
      // IfcBuildAxes: z, then x made orthogonal to it, then y = z x x.
      const z = type === 'IFCAXIS2PLACEMENT3D' ? direction(placement[1], [0, 0, 1]) : [0, 0, 1] as Vec3;
      const ref = direction(placement[type === 'IFCAXIS2PLACEMENT3D' ? 2 : 1], [1, 0, 0]);
      const zu = z && unit(z);
      const xu = zu && ref && unit([0, 1, 2].map((i) => ref[i] - dot(ref, zu) * zu[i]) as Vec3);
      if (zu && xu) {
        const local: Frame = [xu, cross(zu, xu), zu];
        frame = local.map((axis) => apply(parent, axis)) as Frame;
      }
    }
    this.frames.set(id, frame);
    return frame;
  }

  /** IFC2X3 -> IFC4: the carrier associations to leave out, each only an Axis the upgrade then fills. */
  private findCarriers(source: SourceRecords, rels: readonly number[]): void {
    const found: { rel: number; props: number; axis: number; member: number }[] = [];
    for (const rel of rels) {
      const args = source.slots(rel);
      const related = listItems(args?.[RELATED])?.map(slotRef) ?? [];
      const props = slotRef(args?.[PROPERTIES]), axis = slotRef(args?.[ORIENTATION]), member = related[0] ?? null;
      if (args?.length !== 8 || stepString(args[2]) !== AXIS_CARRIER || !slotUnset(args[3]) || !slotUnset(args[6])
        || related.length !== 1 || member === null || !MEMBERS.has(source.type(member) ?? '')
        || axis === null || this.axes.get(member) !== axis || source.type(props) !== 'IFCGENERALPROFILEPROPERTIES') continue;
      const values = source.slots(props);
      if (values?.length !== 7 || !values.every(slotUnset)) continue;
      found.push({ rel, props: props!, axis, member });
    }
    if (!found.length) return;
    const uses = source.referrers(new Set(found.flatMap((c) => [c.props, c.axis])));
    for (const c of found) {
      if (uses.get(c.props) !== 1) continue;
      const frame = this.frame(source.slots(c.member)?.[OBJECT_PLACEMENT]);
      if (!frame) continue;
      this.consumed.add(c.rel);
      this.consumed.add(c.props);
      // A turned Axis names another direction, so the world one goes with its carrier.
      if (!isIdentity(frame) && uses.get(c.axis) === 1) this.consumed.add(c.axis);
    }
  }

  /** IFC4 -> IFC2X3: how each member's Axis travels, or nothing for one that cannot. */
  private planCarriers(source: SourceRecords, members: readonly number[], rels: readonly number[]): void {
    const owned = new Map<number, number[]>();
    for (const rel of rels) {
      for (const m of listItems(source.slots(rel)?.[RELATED])?.map(slotRef) ?? []) if (m !== null) owned.set(m, [...owned.get(m) ?? [], rel]);
    }
    const plans = new Map<number, { world: Vec3; axis: number; frame: Frame }>();
    for (const member of members) {
      const args = source.slots(member);
      const axis = slotRef(args?.[AXIS]);
      const local = axis === null ? undefined : this.directions.get(axis);
      const frame = args?.length === 9 && local ? this.frame(args[OBJECT_PLACEMENT]) : null;
      if (frame) plans.set(member, { world: apply(frame, local!), axis: axis!, frame });
    }
    for (const [member, plan] of plans) {
      const rels = owned.get(member) ?? [];
      if (!rels.length) { this.carried.set(member, { ...plan, into: null }); continue; }
      // IFC2X3 reads one orientation per member, so a member with two associations takes no third.
      const args = rels.length === 1 ? source.slots(rels[0]) : undefined;
      if (args?.length !== 8) continue;
      const held = slotRef(args[ORIENTATION]);
      if (held !== null) {
        const value = this.directions.get(held);
        if (value && near(value, plan.world)) this.carried.set(member, { ...plan, into: rels[0] });
        continue;
      }
      // An unset orientation holds the Axis of every member it relates, so they must all agree.
      const related = listItems(args[RELATED])?.map(slotRef) ?? [];
      if (!slotUnset(args[ORIENTATION]) || !related.every((m) => m !== null && plans.has(m) && near(plans.get(m)!.world, plan.world) && owned.get(m)!.length === 1)) continue;
      this.carried.set(member, { ...plan, into: rels[0] });
      if (!this.fills.has(rels[0])) this.fills.set(rels[0], member);
    }
  }

  /** The direction id naming `world`: the member's own Axis when its frame is unturned, else a new record. */
  private worldDirection(plan: { world: Vec3; axis: number; frame: Frame }): string {
    if (isIdentity(plan.frame)) return `#${plan.axis}`;
    const id = this.ids!();
    this.pending.push(`#${id}=IFCDIRECTION(${tuple(plan.world)});`);
    return `#${id}`;
  }

  /**
   * IFC2X3 -> IFC4: the Axis of a curve member, from its one ProfileOrientation
   * turned into its placement frame, or undefined. Angles and conflicting
   * orientations stay unknown; a tangent does not give a section axis.
   */
  axis(line: string): string | undefined {
    if (!/^\s*#\d+\s*=\s*IFCSTRUCTURALCURVEMEMBER(?:VARYING)?\s*\(/i.test(line)) return undefined;
    const rec = readStepSlots(line), id = Number(/^\s*#(\d+)/.exec(line)?.[1]);
    if (!rec || !id || !MEMBERS.has(rec.type) || rec.slots.length !== 8) return undefined;
    if (this.filled.has(id)) return this.filled.get(id);
    const orientation = this.axes.get(id);
    const world = orientation == null ? undefined : this.directions.get(orientation);
    // Without the source store (`note` alone) only an unplaced member reads.
    const frame = slotUnset(rec.slots[OBJECT_PLACEMENT]) ? IDENTITY : this.frame(rec.slots[OBJECT_PLACEMENT]);
    let axis: string | undefined;
    if (world && frame && isIdentity(frame)) axis = `#${orientation}`;
    else if (world && frame && this.ids) {
      const local = unapply(frame, world);
      if (!this.byValue) {
        this.byValue = new Map();
        for (const [d, v] of this.directions) if (!this.consumed.has(d) && !this.byValue.has(key(v))) this.byValue.set(key(v), d);
      }
      const same = this.byValue.get(key(local));
      if (same !== undefined) axis = `#${same}`;
      else {
        axis = `#${this.ids()}`;
        this.pending.push(`${axis}=IFCDIRECTION(${tuple(local)});`);
      }
    }
    this.filled.set(id, axis);
    return axis;
  }

  /** IFC4 -> IFC2X3: the message when this member's Axis travels in an association, writing a new one when it needs it; else null. */
  hold(id: number, entity: string, args: readonly string[], withheld: ReadonlySet<number> | undefined): string | null {
    const plan = this.mode === 'downgrade' && MEMBERS.has(entity) ? this.carried.get(id) : undefined;
    if (!plan || !this.ids || namesWithheld([args[1], args[AXIS]], withheld) || (plan.into !== null && withheld?.has(plan.into))) return null;
    if (plan.into === null) {
      const props = this.ids(), rel = this.ids();
      const guid = deterministicGlobalId(`ifc4-axis:${args[0].trim()}`);
      const orientation = this.worldDirection(plan);
      this.pending.push(`#${props}=IFCGENERALPROFILEPROPERTIES($,$,$,$,$,$,$);`,
        `#${rel}=${RELATION}('${guid}',${args[1]},'${AXIS_CARRIER}',$,(#${id}),#${props},$,${orientation});`);
    }
    return AXIS_WRITTEN;
  }

  /** The target body of a carrier record: left out on the upgrade, an association given the orientation on the downgrade. */
  rewrite(id: number, args: readonly string[]): StructuralRewrite | undefined {
    if (this.consumed.has(id)) return { body: null, losses: [] };
    const member = this.fills.get(id);
    const plan = member === undefined ? undefined : this.carried.get(member);
    if (!plan || !this.ids) return undefined;
    return { body: `${RELATION}(${[...args.slice(0, ORIENTATION), this.worldDirection(plan)].join(',')})`, losses: [] };
  }

  /** Records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }
}
