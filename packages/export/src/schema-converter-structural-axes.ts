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
import { firstProjAxis, formatStepReal, walkPlacementChain } from '@ifc-lite/data';
import { deterministicGlobalId } from '@ifc-lite/parser';
import { readStepSlots } from './step-argument-parser.js';
import { EPS, OBJECT_PLACEMENT, type Vec3 } from './schema-ifc2x3-records.js';
import { parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';
// A cycle with the source module, which reads lists here; only functions cross it, called after load.
import { conversionMode, namesWithheld, slotRef, slotUnset, stepString, type SourceRecords, type StructuralRewrite } from './schema-converter-structural-source.js';

/** The Name of an association the downgrade writes only to carry an Axis. */
const AXIS_CARRIER = 'IFC4 Axis';
const AXIS_WRITTEN = `IFC4 Axis is written as IfcRelAssociatesProfileProperties.ProfileOrientation in the analysis model frame`;
const MEMBERS = new Set(['IFCSTRUCTURALCURVEMEMBER', 'IFCSTRUCTURALCURVEMEMBERVARYING']);
const RELATION = 'IFCRELASSOCIATESPROFILEPROPERTIES';
/** IFC4 IfcStructuralCurveMember.Axis. */
const AXIS = 8;
/** IfcRelAssociatesProfileProperties.RelatedObjects, RelatingProfileProperties, ProfileOrientation. */
const RELATED = 4, PROPERTIES = 5, ORIENTATION = 7;
/** A rotation as the images of the local x, y and z axes. */
type Frame = [Vec3, Vec3, Vec3];
const IDENTITY: Frame = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
/** A member's Axis on the downgrade: in the world frame, its source direction, and its placement's rotation. */
type Plan = { world: Vec3; axis: number; frame: Frame };

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
/** Whether two directions point the same way, whatever their lengths. */
const same = (a: Vec3, b: Vec3): boolean => {
  const [ua, ub] = [unit(a), unit(b)];
  return !!ua && !!ub && ua.every((x, i) => Math.abs(x - ub[i]) <= EPS);
};
/** A key equal for directions whose ratios agree to 12 digits. */
const key = (v: Vec3): string => tuple(v, 12);
/** Ratios as STEP, with the float noise of a turn rounded away: a ratio within EPS of zero is zero. */
const tuple = (v: Vec3, digits = 15): string => `(${v.map((x) => formatStepReal(Math.abs(x) < EPS ? 0 : Number(x.toPrecision(digits)))).join(',')})`;

export class StructuralAxes {
  /** The exporter's express-id allocator, shared with every other record it appends. */
  ids: (() => number) | null = null;
  private readonly pending: string[] = [];
  /** Upgrade: member id -> its one ProfileOrientation, or null when its associations disagree. */
  private readonly axes = new Map<number, number | null>();
  /** Direction id -> its ratios, for the directions a member or an association names. */
  private readonly directions = new Map<number, Vec3>();
  /** Upgrade: member id -> its placement's rotation, for members with an orientation. */
  private readonly memberFrames = new Map<number, Frame>();
  /** Upgrade: direction value key -> the first source direction with it; built only when a member is turned. */
  private readonly byValue = new Map<string, number>();
  /** Upgrade: member id -> the Axis written for it (`axis` is asked twice per member). */
  private readonly filled = new Map<number, string | undefined>();
  /** Upgrade: carrier records left out. */
  private readonly consumed = new Set<number>();
  /** Downgrade: association id -> the Axis that fills its unset orientation. */
  private readonly fills = new Map<number, Plan>();
  /** Downgrade: member id -> its Axis and where it travels: an association it has (with its slots), or a new one (null). */
  private readonly carried = new Map<number, Plan & { into: number | null; intoArgs?: readonly string[] }>();

  /** Reads one IFC2X3 record; `fromStore` reads them all. */
  note(line: string): void {
    const rec = readStepSlots(line), id = /^\s*#(\d+)/.exec(line)?.[1];
    if (!rec || !id) return;
    if (rec.type === 'IFCDIRECTION') {
      const values = ratios(rec.slots[0]);
      if (values) this.directions.set(Number(id), values);
    } else this.readRelation(rec.type, rec.slots);
  }

  private readRelation(type: string | undefined, slots: readonly string[] | undefined): void {
    if (type !== RELATION || slots?.length !== 8) return;
    const axis = slotRef(slots[ORIENTATION]);
    for (const token of listItems(slots[RELATED]) ?? []) {
      const member = slotRef(token);
      if (member === null) continue;
      this.axes.set(member, this.axes.has(member) && this.axes.get(member) !== axis ? null : axis);
    }
  }

  fromStore(source: SourceRecords, from: string, to: string): void {
    const mode = conversionMode(from, to);
    const rels = source.ids(RELATION);
    if (!mode || (mode === 'upgrade' && !rels.length)) return;
    const members = [...MEMBERS].flatMap((t) => source.ids(t));
    if (!members.length) return;
    const frames = frameReader(source, (id) => this.direction(source, id));
    if (mode === 'downgrade') {
      this.planCarriers(source, members, rels, frames);
      return;
    }
    for (const id of rels) this.readRelation(source.type(id), source.slots(id));
    for (const [member, orientation] of this.axes) {
      const args = MEMBERS.has(source.type(member) ?? '') ? source.slots(member) : undefined;
      // `axis` reads only an IFC2X3 member (8 slots), so only its carrier may go.
      const frame = orientation !== null && args?.length === 8 && this.direction(source, orientation) ? frames(args[OBJECT_PLACEMENT]) : null;
      if (frame) this.memberFrames.set(member, frame);
    }
    this.findCarriers(source, rels);
    if ([...this.memberFrames.values()].some((f) => !isIdentity(f))) {
      for (const d of source.ids('IFCDIRECTION')) {
        const value = this.consumed.has(d) ? null : this.direction(source, d);
        const k = value && key(value);
        if (k && !this.byValue.has(k)) this.byValue.set(k, d);
      }
    }
  }

  /** The ratios of direction `id`, read once. */
  private direction(source: SourceRecords, id: number | null): Vec3 | null {
    if (id === null || source.type(id) !== 'IFCDIRECTION') return null;
    if (!this.directions.has(id)) {
      const values = ratios(source.slots(id)?.[0]);
      if (values) this.directions.set(id, values);
    }
    return this.directions.get(id) ?? null;
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
        || axis === null || this.axes.get(member) !== axis || !this.memberFrames.has(member)
        || source.type(props) !== 'IFCGENERALPROFILEPROPERTIES') continue;
      const values = source.slots(props);
      if (values?.length !== 7 || !values.every(slotUnset)) continue;
      found.push({ rel, props: props!, axis, member });
    }
    if (!found.length) return;
    const uses = source.referrers(new Set(found.flatMap((c) => [c.props, c.axis])));
    for (const c of found) {
      if (uses.get(c.props) !== 1) continue;
      this.consumed.add(c.rel);
      this.consumed.add(c.props);
      // A turned Axis names another direction, so the world one goes with its carrier.
      if (!isIdentity(this.memberFrames.get(c.member)!) && uses.get(c.axis) === 1) this.consumed.add(c.axis);
    }
  }

  /** IFC4 -> IFC2X3: how each member's Axis travels, or nothing for one that cannot. */
  private planCarriers(source: SourceRecords, members: readonly number[], rels: readonly number[], frames: (token: string | undefined) => Frame | null): void {
    const owned = new Map<number, number[]>();
    for (const rel of rels) {
      for (const m of listItems(source.slots(rel)?.[RELATED])?.map(slotRef) ?? []) {
        if (m === null) continue;
        const list = owned.get(m);
        if (list) list.push(rel); else owned.set(m, [rel]);
      }
    }
    const plans = new Map<number, Plan>();
    for (const member of members) {
      const args = source.slots(member);
      const axis = slotRef(args?.[AXIS]);
      const local = args?.length === 9 ? this.direction(source, axis) : null;
      const frame = local ? frames(args![OBJECT_PLACEMENT]) : null;
      if (frame) plans.set(member, { world: apply(frame, local!), axis: axis!, frame });
    }
    /** Association id -> whether every member it relates agrees on one Axis, so its unset orientation can hold it. */
    const agreed = new Map<number, boolean>();
    for (const [member, plan] of plans) {
      const rels = owned.get(member) ?? [];
      if (!rels.length) { this.carried.set(member, { ...plan, into: null }); continue; }
      // IFC2X3 reads one orientation per member, so a member with two associations takes no third.
      const rel = rels[0], args = rels.length === 1 ? source.slots(rel) : undefined;
      if (args?.length !== 8) continue;
      const held = slotRef(args[ORIENTATION]);
      if (held !== null) {
        const value = this.direction(source, held);
        if (value && same(value, plan.world)) this.carried.set(member, { ...plan, into: rel, intoArgs: args });
        continue;
      }
      if (!slotUnset(args[ORIENTATION])) continue;
      if (!agreed.has(rel)) {
        const related = listItems(args[RELATED])?.map(slotRef) ?? [];
        agreed.set(rel, related.every((m) => m !== null && plans.has(m) && same(plans.get(m)!.world, plan.world) && owned.get(m)!.length === 1));
      }
      if (!agreed.get(rel)) continue;
      this.carried.set(member, { ...plan, into: rel, intoArgs: args });
      if (!this.fills.has(rel)) this.fills.set(rel, plan);
    }
  }

  /** The direction id naming `world`: the member's own Axis when its frame is unturned, else a new record. */
  private worldDirection(plan: Plan): string {
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
    const id = Number(/^\s*#(\d+)/.exec(line)?.[1]);
    if (this.filled.has(id)) return this.filled.get(id);
    const rec = readStepSlots(line);
    if (!rec || !id || !MEMBERS.has(rec.type) || rec.slots.length !== 8) return undefined;
    const orientation = this.axes.get(id);
    const world = orientation == null ? undefined : this.directions.get(orientation);
    // Without the source store (`note` alone) only an unplaced member reads.
    const frame = slotUnset(rec.slots[OBJECT_PLACEMENT]) ? IDENTITY : this.memberFrames.get(id);
    let axis: string | undefined;
    if (world && frame && isIdentity(frame)) axis = `#${orientation}`;
    else if (world && frame && this.ids) {
      const local = unapply(frame, world);
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
  hold(id: number, args: readonly string[], withheld: ReadonlySet<number> | undefined): string | null {
    const plan = this.holds(id, args, withheld) ? this.carried.get(id) : undefined;
    if (!plan || !this.ids) return null;
    if (plan.into === null) {
      const props = this.ids(), rel = this.ids();
      const guid = deterministicGlobalId(`ifc4-axis:${args[0].trim()}`);
      const orientation = this.worldDirection(plan);
      this.pending.push(`#${props}=IFCGENERALPROFILEPROPERTIES($,$,$,$,$,$,$);`,
        `#${rel}=${RELATION}('${guid}',${args[1]},'${AXIS_CARRIER}',$,(#${id}),#${props},$,${orientation});`);
    }
    return AXIS_WRITTEN;
  }

  /** The association `hold` fills for this member's Axis, or null when it writes a new one. */
  association(id: number): number | null { return this.carried.get(id)?.into ?? null; }

  /** Whether `hold` carries this member's Axis, without writing anything. */
  holds(id: number, args: readonly string[], withheld: ReadonlySet<number> | undefined): boolean {
    const plan = this.carried.get(id);
    // A record naming a withheld id is refused or proxied, so neither the member nor its association may carry it.
    return !!plan && !!this.ids && !namesWithheld(args, withheld) && !namesWithheld(plan.intoArgs, withheld);
  }

  /** The target body of a carrier record: left out on the upgrade, an association given the orientation on the downgrade. */
  rewrite(id: number, args: readonly string[], withheld: ReadonlySet<number> | undefined): StructuralRewrite | undefined {
    if (this.consumed.has(id)) return { body: null, losses: [] };
    const plan = this.fills.get(id);
    if (!plan || !this.ids || namesWithheld(args, withheld)) return undefined;
    return { body: `${RELATION}(${[...args.slice(0, ORIENTATION), this.worldDirection(plan)].join(',')})`, losses: [] };
  }

  /** Records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }
}

/**
 * The world rotation of a placement slot: identity for `$`, null when the
 * placement is not a chain of local placements with readable axes (a grid
 * placement, a cycle). Memoized per placement for one prepass.
 */
function frameReader(source: SourceRecords, direction: (id: number | null) => Vec3 | null): (token: string | undefined) => Frame | null {
  const cache = new Map<number, Frame | null>();
  const planar = (id: number | null): Vec3 | null => {
    const values = source.type(id) === 'IFCDIRECTION' ? listItems(source.slots(id)?.[0])?.map(parseStepNumber) : undefined;
    return values?.length === 2 && values.every(Number.isFinite) ? [values[0], values[1], 0] : null;
  };
  const localSlots = (id: number) => (source.type(id) === 'IFCLOCALPLACEMENT' ? source.slots(id) : undefined);
  /** An axis placement's rotation by IfcBuildAxes: z, then x made orthogonal to it, then y = z x x. */
  const axes = (id: number | null): Frame | null => {
    const s = source.slots(id), type = source.type(id);
    if (!s || (type !== 'IFCAXIS2PLACEMENT3D' && type !== 'IFCAXIS2PLACEMENT2D')) return null;
    const read = (token: string | undefined, fallback: Vec3): Vec3 | null => (slotUnset(token) ? fallback : direction(slotRef(token)));
    const z = type === 'IFCAXIS2PLACEMENT3D' ? read(s[1], [0, 0, 1]) : [0, 0, 1] as Vec3;
    const zu = z && unit(z);
    const refToken = s[type === 'IFCAXIS2PLACEMENT3D' ? 2 : 1];
    // An unset RefDirection is the renderer's (`firstProjAxis`), which also settles an Axis along world X.
    // A 2D placement's RefDirection has two ratios.
    const ref = zu && (slotUnset(refToken) ? firstProjAxis(zu) : type === 'IFCAXIS2PLACEMENT3D' ? direction(slotRef(refToken)) : planar(slotRef(refToken)));
    const xu = zu && ref && unit([0, 1, 2].map((i) => ref[i] - dot(ref, zu) * zu[i]) as Vec3);
    return zu && xu ? [xu, cross(zu, xu), zu] : null;
  };
  return (token) => {
    if (slotUnset(token)) return IDENTITY;
    const start = slotRef(token);
    if (start === null) return null;
    if (cache.has(start)) return cache.get(start)!;
    const walked = walkPlacementChain(start, (id) => {
      const relTo = localSlots(id)?.[0];
      return relTo === undefined || slotUnset(relTo) ? null : slotRef(relTo) ?? -1;
    }, { stopAt: (id) => cache.has(id) });
    const stopped = walked.end === 'stopped';
    const chain = stopped ? walked.ids.slice(0, -1) : walked.ids;
    let frame: Frame | null = walked.end === 'cycle' ? null : stopped ? cache.get(walked.ids[walked.ids.length - 1])! : IDENTITY;
    // Composed from the top of the chain down. A top that is no local placement (a grid placement, an unreadable link) does not read.
    for (let i = chain.length - 1; i >= 0; i--) {
      const slots = localSlots(chain[i]);
      const local = slots ? axes(slotRef(slots[1])) : null;
      frame = frame && local && local.map((axis) => apply(frame!, axis)) as Frame;
      cache.set(chain[i], frame);
    }
    return cache.get(start) ?? null;
  };
}
