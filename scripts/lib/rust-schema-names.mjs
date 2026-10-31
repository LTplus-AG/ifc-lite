/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Slice from `marker` up to the next `pub fn`, or '' when `marker` is absent. */
function fnBody(source, marker, from = 0) {
  const start = source.indexOf(marker, from);
  if (start === -1) return '';
  const next = source.indexOf('pub fn ', start + marker.length);
  return source.slice(start, next === -1 ? undefined : next);
}

/**
 * Uppercase name -> variant for every slot of `IfcType::from_canonical_name`.
 * The slots name only variants; the accepted spelling is the variant's
 * `as_str()` arm, which the lookup compares against (#7914).
 */
function canonicalNameSlots(schemaSource) {
  const lookup = fnBody(schemaSource, 'fn from_canonical_name');
  const variants = [...lookup.matchAll(/^\s+\d+\s*=>\s*Self::(Ifc[A-Za-z0-9]+),/gm)].map(
    (match) => match[1],
  );
  if (variants.length === 0) return new Map();

  // `UnknownIfcType` also has an `as_str`; the enum's own one has the Unknown arm.
  let asStr = '';
  for (let at = schemaSource.indexOf('pub fn as_str'); at !== -1; ) {
    const body = fnBody(schemaSource, 'pub fn as_str', at);
    if (body.includes('Self::Unknown(')) {
      asStr = body;
      break;
    }
    at = schemaSource.indexOf('pub fn as_str', at + 1);
  }
  // rustfmt wraps long arms as `Self::X => {\n "IFCX"\n }`.
  const spelling = new Map(
    [...asStr.matchAll(/Self::(Ifc[A-Za-z0-9]+)\s*=>\s*(?:\{\s*)?"(IFC[A-Z0-9]+)"/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
  const slots = new Map();
  for (const variant of variants) {
    const name = spelling.get(variant);
    if (name === undefined) {
      throw new Error(`rust-schema-names: from_canonical_name slot Self::${variant} has no as_str arm`);
    }
    slots.set(name, variant);
  }
  return slots;
}

/** Uppercase names `IfcType::from_str` resolves to a real variant. */
export function generatedNames(schemaSource) {
  return new Set(canonicalNameSlots(schemaSource).keys());
}

/** Names in the canonical schema catalog, excluding supplemental variants. */
export function canonicalGeneratedNames(schemaSource) {
  const allStart = schemaSource.indexOf('pub static ALL:');
  if (allStart === -1) return new Set();
  const allEnd = schemaSource.indexOf('];', allStart);
  if (allEnd === -1) return new Set();
  const variants = new Set(
    [...schemaSource.slice(allStart, allEnd).matchAll(/IfcType::(Ifc[A-Za-z0-9]+)/g)].map(
      (match) => match[1],
    ),
  );
  return new Set(
    [...canonicalNameSlots(schemaSource)]
      .filter(([, variant]) => variants.has(variant))
      .map(([name]) => name),
  );
}
