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
 * Some rows convert instead of dropping, written `FORM>TO`:
 *  - `R>T:NAME`: an untyped value of the source's own defined type NAME, in
 *    a target select that takes NAME typed, is wrapped as `NAME(value)`
 *    (IFC4 IfcParameterValue -> IFC4X3 IfcCurveMeasureSelect);
 *  - `T:NAME>U`: a typed NAME value, in a target slot of type NAME, is
 *    unwrapped;
 *  - `R>I`: a real with no fraction, in an integer slot, is written as that
 *    integer (IFC4X3 made IfcCountMeasure an INTEGER); a fractional real is
 *    dropped, so this one is lossless only for whole numbers;
 *  - `T:NAME(R)>I`, a payload row on a typed member the target takes: a NAME
 *    whose defined type narrowed from a number
 *    to an INTEGER (IFC4X3 IfcCountMeasure) keeps a whole payload as that
 *    integer and is dropped with a fractional one;
 *  - `T:NAME>U1`: a typed NAME set of the references the target slot takes
 *    (IFC4 IfcPropertySetDefinitionSet in IFC2X3's IfcPropertySetDefinition)
 *    is written as its member when it has one, and dropped otherwise.
 *
 * An aggregate loses only its rejected members, except where its members are
 * positional (`POSITIONAL`): a table's cells, a time series' values. There a
 * rejected member drops the whole aggregate and the slots it pairs with,
 * since removing one would shift every later member onto the wrong partner.
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
  readonly optional?: boolean;
  readonly isList?: boolean;
  readonly isSet?: boolean;
  readonly isArray?: boolean;
  /** An aggregate's `[lower, upper]`; null for `?`. */
  readonly arrayBounds?: readonly [number, number | null];
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

const isAggregate = (attribute: ValueFormAttribute): boolean => !!(attribute.isList || attribute.isSet || attribute.isArray);

/** The attribute's own defined type, when it is neither an aggregate nor a select. */
function definedType(reg: ValueFormRegistry, attribute: ValueFormAttribute): string | undefined {
  const t = attribute.type;
  const plain = !isAggregate(attribute) && !t.endsWith('[]');
  return plain && Object.hasOwn(reg.types, t) && !Object.hasOwn(reg.selects, t) ? t.toUpperCase() : undefined;
}

function attributeForms(reg: ValueFormRegistry, attribute: ValueFormAttribute): Forms {
  const out: Forms = new Map();
  collect(reg, attribute.type, isAggregate(attribute) ? 'A' : '', false, out, new Set());
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
    if (fits(source, form, entities, target, accepted.get(form))) {
      rejected.push(...narrowedPayload(source, target, form));
      continue;
    }
    if (own && 'SRIEB'.includes(form) && accepted.has(`T:${own}`)) rejected.push(`${form}>T:${own}`);
    else if (slot && form === `T:${slot}`) rejected.push(`${form}>U`);
    else if (from.type === 'IfcTimeMeasure' && to.type === 'IfcDuration' && form === 'R') rejected.push('R>D+');
    else if (from.type === 'IfcDuration' && to.type === 'IfcTimeMeasure' && form === 'S') rejected.push('S>D-');
    else if (stringAsText(source, target, form, accepted)) rejected.push(form + '>TEXT');
    else if (setOfAccepted(source, form, target, accepted)) rejected.push(`${form}>U1`);
    else if (form.endsWith('R') && accepted.has(`${form.slice(0, -1)}I`)) rejected.push(`${form}>${form.slice(0, -1)}I`);
    else rejected.push(form);
  }
  return rejected.sort();
}

/** A registry's spelling of the UPPERCASE defined type `upper`. */
const typeNamed = (reg: ValueFormRegistry, upper: string): string | undefined => Object.keys(reg.types).find((t) => t.toUpperCase() === upper);

/** The primitive forms a value of defined type `name` takes in `reg`; empty when it is not a primitive. */
function payloadForms(reg: ValueFormRegistry, name: string | undefined): string[] {
  if (name === undefined || Object.hasOwn(reg.selects, name)) return [];
  const out: Forms = new Map();
  collect(reg, reg.types[name], '', false, out, new Set());
  return [...out.keys()].every((f) => 'SRIEB'.includes(f)) ? [...out.keys()] : [];
}

/** Preserve the string of a defined type unavailable in a target IfcValue slot. */
function stringAsText(source: ValueFormRegistry, target: ValueFormRegistry, form: string, accepted: Forms): boolean {
  const typed = /^(A*)T:(.+)$/.exec(form);
  if (!typed || !accepted.has(typed[1] + 'T:IFCTEXT') || typeNamed(target, typed[2])) return false;
  const forms = payloadForms(source, typeNamed(source, typed[2]));
  return forms.length === 1 && forms[0] === 'S';
}

/** For a typed member both sides take, the payload forms the target's defined type no longer holds. */
function narrowedPayload(source: ValueFormRegistry, target: ValueFormRegistry, form: string): string[] {
  const typed = /^(A*)T:(.+)$/.exec(form);
  if (!typed) return [];
  const held = payloadForms(target, typeNamed(target, typed[2]));
  if (!held.length) return [];
  return payloadForms(source, typeNamed(source, typed[2])).filter((p) => !held.includes(p))
    .map((p) => (p === 'R' && held.includes('I') ? `${form}(R)>I` : `${form}(${p})`));
}

/** Whether a value of `form` naming `entities` fits a target slot whose same form names `named`. */
function fits(source: ValueFormRegistry, form: string, entities: Set<string>, target: ValueFormRegistry, named: Set<string> | undefined): boolean {
  return named !== undefined && (!form.endsWith('#') || [...entities].flatMap((e) => descendants(source, e)).some((e) =>
    Object.hasOwn(target.entities, e) && [...named].some((t) => within(target, e, t) || within(target, t, e))));
}

/** Whether `form` is a typed set (`T:NAME`, NAME an aggregate type) whose every member form the target slot takes. */
function setOfAccepted(source: ValueFormRegistry, form: string, target: ValueFormRegistry, accepted: Forms): boolean {
  const name = form.startsWith('T:') ? typeNamed(source, form.slice(2)) : undefined;
  if (name === undefined || !/^(?:LIST|SET|BAG|ARRAY)\s*\[/i.test(source.types[name])) return false;
  const inner: Forms = new Map();
  collect(source, source.types[name], '', false, inner, new Set());
  return inner.size > 0 && [...inner].every(([member, entities]) =>
    member.startsWith('A') && fits(source, member.slice(1), entities, target, accepted.get(member.slice(1))));
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
  /** The target requires the slot, so a dropped value leaves the record invalid. */
  readonly required: boolean;
  /** The target slot is an aggregate that may be empty, so dropping every member writes `()`. */
  readonly empty: boolean;
  /** Positional members: target slot indexes written `$` together when one member is rejected; empty otherwise. */
  readonly whole: readonly number[];
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

/**
 * Aggregates whose members are positional, by UPPERCASE type: each group is
 * dropped whole, together, when one member is rejected. A table row's cells
 * line up with the table's columns, a time series value's list with the
 * series' quantities, and IfcPropertyTableValue pairs DefiningValues with
 * DefinedValues one to one (IFC4 WR21 wants their sizes equal).
 */
export const POSITIONAL: Readonly<Record<string, readonly (readonly string[])[]>> = {
  IFCPROPERTYTABLEVALUE: [['DefiningValues', 'DefinedValues']],
  IFCTABLEROW: [['RowCells']],
  IFCTIMESERIESVALUE: [['ListValues']],
  IFCIRREGULARTIMESERIESVALUE: [['ListValues']],
};

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
    if (!rejected.length) return;
    const group = POSITIONAL[type]?.find((g) => g.includes(tgt.name)) ?? [];
    const whole = group.map((a) => tgtAttrs.findIndex((t) => t.name === a)).filter((i) => i >= 0);
    const empty = isAggregate(tgt) && tgt.arrayBounds?.[0] === 0;
    out.push({ type, entity, index, attribute: tgt.name, sourceType: src!.type, targetType: tgt.type, required: !tgt.optional, empty, whole, rejected });
  });
  return out;
}

/** Every such slot between the two registries, for the generator. */
export function valueFormSlots(source: Registry, target: Registry, from: string, to: string, maps: readonly ValueFormMap[]): ValueFormSlot[] {
  return Object.keys(target.entities).sort().flatMap((entity) => valueFormSlotsOf(source, target, from, to, maps, entity));
}
