/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which STEP value forms a target slot cannot hold that the source attribute
 * of the same name can (#10847).
 *
 * Many attributes keep their name across IFC2X3, IFC4 and IFC4X3 but change
 * type, so a value carried by name or position can be invalid in the target:
 * an IFC2X3 `IfcCalendarDate` reference in IFC4's `IfcDate` string slot, an
 * `IfcTimeMeasure` number in an `IfcDuration` string slot. Comparing names
 * cannot see that; comparing types one by one flags every compatible
 * widening (IfcLabel -> IfcIdentifier). This compares what a value LOOKS LIKE
 * in a STEP file instead. A form is one of:
 *
 *   `#` entity reference, `S` string, `R` real, `I` integer, `E` enumeration
 *   (and BOOLEAN / LOGICAL), `B` binary, `T:NAME` a typed select member
 *   `NAME(...)`, and `A` before any of these for an aggregate member.
 *
 * A form the source allows and the target does not is rejected. A reference
 * is rejected when no entity the source names, or any of their subtypes, is
 * related (sub- or supertype) to one the target names, so a date reference
 * is rejected and a narrowed select (IfcTextStyleSelect ->
 * IfcTextStyleTextModel) is kept: a line converter cannot read the
 * referenced record's type.
 *
 * Two rejections convert without loss instead, written `FORM>TO`:
 *  - `R>T:NAME`: an untyped value of the source's own defined type NAME, in
 *    a target select that takes NAME typed, is wrapped as `NAME(value)`
 *    (IFC4 IfcParameterValue -> IFC4X3 IfcCurveMeasureSelect);
 *  - `T:NAME>U`: a typed NAME value, in a target slot of type NAME, is
 *    unwrapped;
 *  - `R>I`: a real with no fraction, in an integer slot, is written as that
 *    integer (IFC4X3 made IfcCountMeasure an INTEGER); any other real is dropped.
 *
 * Pure, and free of package imports, so `scripts/generate-value-forms.mjs`
 * runs the same policy over the registries to write the reviewed ledger and
 * the Rust converter's table (`--check` in CI).
 */

export interface ValueFormRegistry {
  readonly entities: Readonly<Record<string, { readonly parent?: string }>>;
  readonly types: Readonly<Record<string, string>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
  readonly selects: Readonly<Record<string, readonly string[]>>;
}

export interface ValueFormAttribute {
  readonly name: string;
  readonly type: string;
  readonly isList?: boolean;
  readonly isSet?: boolean;
  readonly isArray?: boolean;
}

/** Form -> the entities a `#` form names. */
type Forms = Map<string, Set<string>>;

const PRIMITIVE: Readonly<Record<string, readonly string[]>> = {
  STRING: ['S'], REAL: ['R'], INTEGER: ['I'], NUMBER: ['R', 'I'], BOOLEAN: ['E'], LOGICAL: ['E'], BINARY: ['B'],
};

function add(out: Forms, form: string, entity?: string): void {
  const entities = out.get(form) ?? new Set<string>();
  if (entity) entities.add(entity);
  out.set(form, entities);
}

/** The forms a value of `type` takes, after `prefix`; `typed` inside a select. */
function collect(reg: ValueFormRegistry, type: string, prefix: string, typed: boolean, out: Forms, seen: Set<string>): void {
  const t = type.trim();
  const aggregate = /^(?:LIST|SET|ARRAY|BAG)\s*\[[^\]]*\]\s*OF\s+(?:UNIQUE\s+)?(.+)$/i.exec(t);
  if (aggregate) return collect(reg, aggregate[1], `${prefix}A`, false, out, seen);
  if (t.endsWith('[]')) return collect(reg, t.slice(0, -2), `${prefix}A`, false, out, seen);
  const primitive = PRIMITIVE[t.replace(/\s*\(\d+\)(\s*FIXED)?$/i, '').toUpperCase()];
  if (primitive) return primitive.forEach((form) => add(out, prefix + form));
  const key = `${prefix}|${typed}|${t}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (Object.hasOwn(reg.entities, t)) return add(out, `${prefix}#`, t);
  // The registry lists a select in `types` too, so selects come first.
  if (Object.hasOwn(reg.selects, t)) return reg.selects[t].forEach((member) => collect(reg, member, prefix, true, out, seen));
  // A select member that is not an entity is written typed: `IFCLABEL('x')`.
  if (typed && (Object.hasOwn(reg.types, t) || Object.hasOwn(reg.enums, t))) return add(out, `${prefix}T:${t.toUpperCase()}`);
  if (Object.hasOwn(reg.enums, t)) return add(out, `${prefix}E`);
  if (Object.hasOwn(reg.types, t)) collect(reg, reg.types[t], prefix, false, out, seen);
}

const CHILDREN = new WeakMap<ValueFormRegistry, Map<string, string[]>>();

/** `entity` and every subtype of it in `reg`. */
function descendants(reg: ValueFormRegistry, entity: string): string[] {
  let children = CHILDREN.get(reg);
  if (!children) {
    children = new Map();
    for (const [name, meta] of Object.entries(reg.entities)) {
      if (meta.parent) children.set(meta.parent, [...(children.get(meta.parent) ?? []), name]);
    }
    CHILDREN.set(reg, children);
  }
  const out = [entity];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]) ?? []));
  return out;
}

/** The attribute's own defined type, when it is neither an aggregate nor a select. */
function definedType(reg: ValueFormRegistry, attribute: ValueFormAttribute): string | undefined {
  const t = attribute.type;
  const plain = !attribute.isList && !attribute.isSet && !attribute.isArray && !t.endsWith('[]');
  return plain && Object.hasOwn(reg.types, t) && !Object.hasOwn(reg.selects, t) ? t.toUpperCase() : undefined;
}

function attributeForms(reg: ValueFormRegistry, attribute: ValueFormAttribute): Forms {
  const out: Forms = new Map();
  collect(reg, attribute.type, attribute.isList || attribute.isSet || attribute.isArray ? 'A' : '', false, out, new Set());
  return out;
}

/** Whether `a` is `b` or one of its subtypes in `reg`. */
function within(reg: ValueFormRegistry, a: string, b: string): boolean {
  for (let e: string | undefined = a, depth = 0; e !== undefined && depth < 64; e = reg.entities[e]?.parent, depth++) {
    if (e === b) return true;
  }
  return false;
}

/**
 * The forms a value of source attribute `from` (in `source`) can take that
 * target attribute `to` (in `target`) cannot hold, sorted; empty when every
 * form fits.
 */
export function rejectedForms(
  source: ValueFormRegistry,
  from: ValueFormAttribute,
  target: ValueFormRegistry,
  to: ValueFormAttribute,
): string[] {
  const accepted = attributeForms(target, to);
  const own = definedType(source, from), slot = definedType(target, to);
  const rejected: string[] = [];
  for (const [form, entities] of attributeForms(source, from)) {
    const named = accepted.get(form);
    const fits = named !== undefined && (!form.endsWith('#') || [...entities].flatMap((e) => descendants(source, e)).some((e) =>
      Object.hasOwn(target.entities, e) && [...named].some((t) => within(target, e, t) || within(target, t, e))));
    if (fits) continue;
    if (own && 'SRIEB'.includes(form) && accepted.has(`T:${own}`)) rejected.push(`${form}>T:${own}`);
    else if (slot && form === `T:${slot}`) rejected.push(`${form}>U`);
    else if (form.endsWith('R') && accepted.has(`${form.slice(0, -1)}I`)) rejected.push(`${form}>${form.slice(0, -1)}I`);
    else rejected.push(form);
  }
  return rejected.sort();
}

/** The form of one STEP value as written, or null for `$`, `*` and anything unread. */
export function valueForm(value: string): string | null {
  const v = value.trim();
  const c = v[0];
  if (c === undefined || c === '$' || c === '*') return null;
  if (c === '#') return '#';
  if (c === "'") return 'S';
  if (c === '"') return 'B';
  // A STEP real starts with a digit, so a leading `.` opens an enumeration.
  if (c === '.') return 'E';
  const typed = /^([A-Za-z][A-Za-z0-9_]*)\s*\(/.exec(v);
  if (typed) return `T:${typed[1].toUpperCase()}`;
  if (/^[+-]?\d/.test(v)) return /[.eE]/.test(v) ? 'R' : 'I';
  return null;
}

/** One reviewed attribute map's fields the pairing reads (the `schema_attribute_maps.json` shape). */
export interface ValueFormMap {
  readonly ifc2x3: string;
  readonly ifc4: string;
  readonly renamed: readonly (readonly [string, string])[];
  readonly retyped: readonly string[];
  readonly upOnly: readonly string[];
  readonly setOfOne: readonly [string, string] | null;
}

export interface ValueFormSlot {
  /** UPPERCASE target type. */
  readonly type: string;
  readonly entity: string;
  readonly index: number;
  readonly attribute: string;
  readonly sourceType: string;
  readonly targetType: string;
  readonly rejected: readonly string[];
}

/**
 * Slots another pass decides, by `TYPE.Attribute`. A row would drop what that
 * pass writes, or more than the invalid value.
 */
const DECIDED_ELSEWHERE: readonly string[] = [
  // StyleFlatten (#7742) writes IfcPresentationStyle members into IFC4X3; the way
  // down needs a new IfcPresentationStyleAssignment record, and dropping loses the colours.
  'IFCSTYLEDITEM.Styles',
  // #10778 converts the currency between the IFC2X3 enumeration and the IFC4 label.
  'IFCMONETARYUNIT.Currency',
];

interface EntityLike {
  readonly isAbstract?: boolean;
  readonly attributes: readonly ValueFormAttribute[];
  readonly allAttributes?: readonly ValueFormAttribute[];
}
type Registry = ValueFormRegistry & { readonly entities: Readonly<Record<string, EntityLike & { readonly parent?: string }>> };

/**
 * The slots of target type `entity` (as the registries spell it) whose
 * carried source attribute can hold a form the target rejects. A map's
 * renamed pair supplies the source name; its retyped, set-of-one and, on a
 * downgrade, up-only attributes are the map's to decide.
 */
export function valueFormSlotsOf(source: Registry, target: Registry, from: string, to: string, maps: readonly ValueFormMap[], entity: string): ValueFormSlot[] {
  const s = source.entities[entity], t = target.entities[entity];
  if (!s || !t || t.isAbstract) return [];
  const type = entity.toUpperCase();
  const up = from === 'IFC2X3' && to !== 'IFC2X3';
  const map = from === 'IFC2X3' || to === 'IFC2X3' ? maps.find((m) => m.ifc2x3 === type && m.ifc4 === type) : undefined;
  const srcAttrs = s.allAttributes ?? s.attributes, tgtAttrs = t.allAttributes ?? t.attributes;
  const out: ValueFormSlot[] = [];
  tgtAttrs.forEach((tgt, index) => {
    const pair = map?.renamed.find((p) => p[up ? 1 : 0] === tgt.name);
    const name = pair ? pair[up ? 0 : 1] : tgt.name;
    if (map && (map.retyped.includes(name) || map.setOfOne?.includes(name) || (!up && map.upOnly.includes(name)))) return;
    if (DECIDED_ELSEWHERE.includes(`${type}.${tgt.name}`)) return;
    const src = srcAttrs.find((a) => a.name === name);
    const rejected = src ? rejectedForms(source, src, target, tgt) : [];
    if (rejected.length) out.push({ type, entity, index, attribute: tgt.name, sourceType: src!.type, targetType: tgt.type, rejected });
  });
  return out;
}

/** Every such slot between the two registries, for the generator. */
export function valueFormSlots(source: Registry, target: Registry, from: string, to: string, maps: readonly ValueFormMap[]): ValueFormSlot[] {
  return Object.keys(target.entities).sort().flatMap((entity) => valueFormSlotsOf(source, target, from, to, maps, entity));
}
