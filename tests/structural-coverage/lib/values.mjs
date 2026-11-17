/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turning a STEP attribute into a comparable value, and comparing two.
 *
 * A reference becomes the target's GlobalId when the target is an IfcRoot
 * subtype (stable across a re-export), otherwise `#<id>` (mode `id`) or
 * `#<TYPE>` (mode `type`, for comparing across a conversion that may
 * renumber records).
 */

/** Uppercase STEP keyword -> { name, rooted } for one schema table. */
export function typeIndex({ table, chain }) {
  const out = new Map();
  for (const e of table.values()) out.set(e.name.toUpperCase(), { name: e.name, rooted: chain(e.name).includes('IfcRoot') });
  return out;
}

/**
 * With `typed`, a typed value (`IFCBOOLEAN(.T.)`) keeps its wrapper as
 * `{ type, value }`, so it never equals the bare value a SELECT slot rejects.
 */
export function normalize(v, step, types, refs = 'id', typed = false) {
  if (v === null || v === undefined || v === '*') return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => normalize(x, step, types, refs, typed));
  if ('enum' in v) return v.enum === 'T' ? true : v.enum === 'F' ? false : v.enum;
  if ('type' in v) {
    const inner = normalize(v.value, step, types, refs, typed);
    return typed ? { type: v.type, value: inner } : inner;
  }
  if ('ref' in v) {
    const target = step.get(v.ref);
    if (target && types.get(target.type)?.rooted && typeof target.args[0] === 'string') return target.args[0];
    return refs === 'type' ? `#${target?.type ?? 'UNRESOLVED'}` : `#${v.ref}`;
  }
  return JSON.stringify(v);
}

const sortable = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');

export function equal(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const [x, y] = sortable(a) && sortable(b) ? [[...a].sort(), [...b].sort()] : [a, b];
    return x.every((v, i) => equal(v, y[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && 'type' in a && 'type' in b) return a.type === b.type && equal(a.value, b.value);
  return a === b;
}

export const show = (v) => JSON.stringify(v) ?? 'undefined';

/** Status from per-record checks: pass when every record holds, partial when some evidence holds, fail otherwise. */
export function verdict(checked, problems, { anyHeld }) {
  if (!checked) return { status: 'fail', reason: 'no record was checked' };
  if (!problems.length) return { status: 'pass' };
  const reason = `${problems.length} problem(s) over ${checked} record(s): ${problems.slice(0, 4).join('; ')}${problems.length > 4 ? '; ...' : ''}`;
  return { status: anyHeld ? 'partial' : 'fail', reason };
}
