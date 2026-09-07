/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-concept type-name extractors for scripts/check-server-browser-type-parity.mjs.
 * Split out purely to stay under the module-size budget (AGENTS.md: "Prefer
 * splitting to allowlisting") — these are read together with the allowlist
 * and CLI in the parent file, which explains WHY this shape exists at all.
 *
 * Each `rustX`/`tsX` pair extracts the set of IFC type-name string literals
 * one side's source switches on for one concept. See the parent file's
 * header for the overall approach and its limits.
 */

/** Strips `/* … *‍/` and `//` comments — symmetric on both languages, same
 * naive strip `check-clash-degenerate-reason-parity.mjs` uses. Neither
 * source's relevant string literals contain `//`, so nothing real is eaten. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Thrown by an extractor that has detected a shape it cannot be sure it read
 * completely (see below) — a distinct failure mode from "found zero types"
 * (the existing vacuity guard): the extractor DID find types, but a sibling
 * binding it does not know how to read exists alongside the one it does, so
 * its result may silently be missing whatever that sibling carries. Caught
 * by `checkConcept` in the parent script and reported loudly rather than
 * compared as if it were complete. */
export class ExtractorUnderReadError extends Error {}

/**
 * Guards the exact silent-pass shape found in review of #3979: the Rust
 * `rel_types` extractor (and its TS mirror, the three `*_REL_TYPES` Sets
 * below) only reads ONE bounded region. A later patch that adds a genuinely
 * new set of types via a SIBLING binding — e.g.
 * `let extra_rel_types = [...]` next to `let rel_types = [...]` — is
 * syntactically ordinary and would compile/run fine, but this extractor
 * would never see the new types at all: verified in an isolated repro
 * (`--root /tmp/parity-test2`) that adding such a sibling array stays GREEN
 * even though the server now genuinely handles a type the allowlist still
 * lists as a Rust-side gap. Rather than parsing Rust properly (out of
 * scope), this scans the WHOLE stripped source for any OTHER binding that
 * matches `bindingPattern`, is not in `recognizedNames`, and whose captured
 * body contains at least one string literal shaped like an IFC type name —
 * and refuses to guess by throwing instead of silently under-reporting.
 *
 * `nameFilter` narrows `bindingPattern` matches to those actually worth
 * inspecting (e.g. only names containing `REL_TYPES`): several *_TYPES sets
 * in these same files are legitimately unrelated concepts (geometry types,
 * spatial types, property container types), and scanning every binding for
 * "contains an uppercase quoted literal" would flag all of them, which would
 * make the real, unmutated tree fail this check — the one control this
 * hardening must never break.
 */
export function assertNoUnrecognizedSiblingBindings(
  code,
  { bindingPattern, valuePattern, nameFilter, recognizedNames, label },
) {
  for (const m of code.matchAll(bindingPattern)) {
    const name = m[1];
    const body = m[2];
    if (recognizedNames.includes(name)) continue;
    if (nameFilter && !nameFilter.test(name)) continue;
    if (valuePattern.test(body)) {
      throw new ExtractorUnderReadError(
        `${label}: found a binding \`${name}\` alongside the recognized one(s) (${recognizedNames.join(', ')}) that looks like it carries IFC type name literals this extractor does not read. The extractor may be under-reading; update it.`,
      );
    }
  }
}

/** Extracts the bounded `let rel_types = [ ... ];` array in relationships.rs.
 * See `assertNoUnrecognizedSiblingBindings` above: also refuses to guess if a
 * sibling `let X = [...]` binding carrying IFC-looking literals exists
 * alongside `rel_types` — a shape this bounded regex would otherwise never
 * see. */
export function rustRelationshipTypes(src) {
  const code = stripComments(src);
  assertNoUnrecognizedSiblingBindings(code, {
    bindingPattern: /let\s+(\w+)\s*=\s*\[([\s\S]*?)\];/g,
    valuePattern: /"[A-Z][A-Z0-9]{3,}"/,
    nameFilter: /types/i,
    recognizedNames: ['rel_types'],
    label: 'rustRelationshipTypes',
  });
  const m = /let rel_types = \[([\s\S]*?)\];/.exec(code);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/"([A-Z0-9]+)"/g)].map((x) => x[1]));
}

/** Union of the three Sets that gate what the TS columnar parser collects as
 * a relationship edge: HIERARCHY_REL_TYPES (the eager index-time gate),
 * PROPERTY_REL_TYPES and ASSOCIATION_REL_TYPES (the on-demand gates for
 * property/material/classification/document rels). Together these are the
 * TS-side analogue of the Rust `rel_types` array — one flat list of every
 * IfcRel* type the parser is willing to route to a relationship extractor. */
export function tsRelationshipTypes(src) {
  const code = stripComments(src);
  const RECOGNIZED = ['HIERARCHY_REL_TYPES', 'PROPERTY_REL_TYPES', 'ASSOCIATION_REL_TYPES'];
  // Mirrors the Rust-side guard above: a future 4th `export const
  // SOMETHING_REL_TYPES = new Set([...])` added alongside these three would
  // otherwise be silently invisible to this union (the same shape as the
  // `extra_rel_types` repro, on the TS side). Narrowed to names containing
  // `REL_TYPES` so it does not fire on this file's other, unrelated `*_TYPES`
  // sets (GEOMETRY_TYPES, SPATIAL_TYPES, PROPERTY_ENTITY_TYPES, ...).
  assertNoUnrecognizedSiblingBindings(code, {
    bindingPattern: /export const (\w+) = new Set\(\[([\s\S]*?)\]\);/g,
    valuePattern: /'[A-Z][A-Z0-9]{3,}'/,
    nameFilter: /REL_TYPES/,
    recognizedNames: RECOGNIZED,
    label: 'tsRelationshipTypes',
  });
  const found = new Set();
  for (const name of RECOGNIZED) {
    const m = new RegExp(`export const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(code);
    if (!m) continue;
    for (const x of m[1].matchAll(/'([A-Z0-9]+)'/g)) found.add(x[1]);
  }
  return found;
}

/** Extracts the `matches!(type_name.to_uppercase().as_str(), "A" | "B" | ...)`
 * arms in spatial.rs: is_spatial_type is the full set; is_building_like_spatial_type
 * and is_space_like_spatial_type are SUBSETS used for different purposes
 * (deciding a "building-like" or "space-like" root), not independent
 * concepts, so only is_spatial_type is compared here.
 *
 * Same silent-pass shape as `rustRelationshipTypes` above: is_spatial_type is
 * ONE bounded region, so a later patch recognizing a new spatial type only
 * via a SIBLING closure (a 4th `let is_X_spatial_type = |type_name: &str| {
 * matches!(...) }` alongside the three named/recognized ones) would never be
 * read by this regex. Guarded the same way. */
export function rustSpatialTypes(src) {
  const code = stripComments(src);
  assertNoUnrecognizedSiblingBindings(code, {
    bindingPattern:
      /let\s+(\w+)\s*=\s*\|type_name: &str\|\s*\{\s*matches!\(\s*type_name\.to_uppercase\(\)\.as_str\(\),([\s\S]*?)\)\s*\};/g,
    valuePattern: /"[A-Z][A-Z0-9]{3,}"/,
    nameFilter: /spatial_type/i,
    recognizedNames: ['is_spatial_type', 'is_building_like_spatial_type', 'is_space_like_spatial_type'],
    label: 'rustSpatialTypes',
  });
  const m = /let is_spatial_type = \|type_name: &str\| \{\s*matches!\(\s*type_name\.to_uppercase\(\)\.as_str\(\),([\s\S]*?)\)\s*\};/.exec(
    code,
  );
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/"([A-Z0-9]+)"/g)].map((x) => x[1]));
}

/** The TS canonical spatial-type list is ENUM-based
 * (`packages/data/src/spatial-types.ts`), not string literals: an
 * `IfcTypeEnum.IfcSpace` reference. Its member name IS the IFC type name
 * (`IfcSpace` -> `IFCSPACE`), so uppercasing each identifier after the
 * `IfcTypeEnum.` prefix reconstructs the same string-literal universe the
 * Rust side spells out directly — the two sides encode the identical
 * information in different syntaxes, and this is a faithful decode of the
 * enum form, not a guess. */
export function tsSpatialTypes(src) {
  const code = stripComments(src);
  // Same silent-pass shape as `tsRelationshipTypes` above: SPATIAL_STRUCTURE_TYPE_ENUMS
  // is ONE bounded region. A later patch adding a genuinely new spatial type
  // only via a 5th `export const X_TYPE_ENUMS = [...] as const;` sibling
  // (alongside the master list and its three known subset lists) would never
  // be read here.
  assertNoUnrecognizedSiblingBindings(code, {
    bindingPattern: /export const (\w+) = \[([\s\S]*?)\] as const;/g,
    valuePattern: /IfcTypeEnum\.Ifc[A-Za-z0-9]+/,
    nameFilter: /_TYPE_ENUMS$/,
    recognizedNames: [
      'SPATIAL_STRUCTURE_TYPE_ENUMS',
      'BUILDING_LIKE_SPATIAL_TYPE_ENUMS',
      'STOREY_LIKE_SPATIAL_TYPE_ENUMS',
      'SPACE_LIKE_SPATIAL_TYPE_ENUMS',
    ],
    label: 'tsSpatialTypes',
  });
  const m = /export const SPATIAL_STRUCTURE_TYPE_ENUMS = \[([\s\S]*?)\] as const;/.exec(code);
  if (!m) return new Set();
  return new Set(
    [...m[1].matchAll(/IfcTypeEnum\.(Ifc[A-Za-z0-9]+)/g)].map((x) => x[1].toUpperCase()),
  );
}

/** The IfcProperty subtype the server's `match` names, plus
 * `IFCCOMPLEXPROPERTY` if ever referenced (it currently is not — that
 * absence IS the #3963 defect this gate exists to catch). */
export function rustPropertyTypes(src) {
  const code = stripComments(src);
  const found = new Set();
  // `match ty.as_str() { "IFCPROPERTY..." => ... }` — restricted to actual
  // match ARMS (`=>`), which excludes the unrelated `IFCPROPERTYSET` literal
  // used elsewhere in this file as the *container* type's job filter
  // (`job.type_name.eq_ignore_ascii_case("IFCPROPERTYSET")`), not an
  // IfcProperty VALUE-shape arm.
  for (const m of code.matchAll(/"(IFCPROPERTY[A-Z]+|IFCCOMPLEXPROPERTY)"\s*=>/g)) found.add(m[1]);
  return found;
}

/** The TS side's `switch (typeUpper)` names 5 of the 6 IfcProperty value
 * subtypes as explicit `case` literals; `IFCPROPERTYSINGLEVALUE` is instead
 * the switch's unconditional `default` arm (the doc comment above the
 * function names it: "IfcPropertySingleValue: direct value"), so it carries
 * no quoted literal for a regex to find. It is added back in explicitly here
 * rather than left as a false "TS is missing SINGLEVALUE" divergence — the
 * single case where this extractor's information is NOT the literal text
 * alone, and it is called out for exactly that reason. IfcComplexProperty is
 * handled by a SEPARATE dispatcher (`parsePropertyValueWithComplex`) via an
 * `=== 'IFCCOMPLEXPROPERTY'` comparison rather than a `case`, so the pattern
 * below matches both `case '...'` and `=== '...'` against the same prefix. */
export function tsPropertyTypes(src) {
  const code = stripComments(src);
  const found = new Set(['IFCPROPERTYSINGLEVALUE']);
  for (const m of code.matchAll(/(?:case|===)\s*'(IFCPROPERTY[A-Z]+|IFCCOMPLEXPROPERTY)'/g)) {
    found.add(m[1]);
  }
  return found;
}

/** The `IfcQuantity*` types the server's if/else-if chain recognizes, via
 * `eq_ignore_ascii_case("IFCQUANTITY...")`. `IfcPhysicalComplexQuantity` is
 * never named here at all (it falls through the final `else` and is
 * silently dropped) — contrast the TS side, which names and skips it
 * explicitly (see below). */
export function rustQuantityTypes(src) {
  const code = stripComments(src);
  const found = new Set();
  for (const m of code.matchAll(/eq_ignore_ascii_case\("(IFCQUANTITY[A-Z]+|IFCPHYSICALCOMPLEXQUANTITY)"\)/g)) {
    found.add(m[1]);
  }
  return found;
}

/** TS quantity types come from two files: `QUANTITY_TYPE_MAP`'s keys
 * (columnar-parser-indexes.ts) are the resolved `IfcQuantity*` leaf types;
 * `quantity-collect.ts` separately NAMES `IfcPhysicalComplexQuantity` (as
 * `COMPLEX_QUANTITY_TYPE`) purely to skip it — a deliberate, tracked gap
 * (#3254), not a resolved quantity type, but still a type name this side
 * "switches on" (an explicit `if (qtyTypeUpper === COMPLEX_QUANTITY_TYPE) continue`),
 * so it belongs in the set this gate compares. */
export function tsQuantityTypes(mapSrc, collectSrc) {
  const found = new Set();
  const mapCode = stripComments(mapSrc);
  // Same silent-pass shape as `tsRelationshipTypes`/`tsSpatialTypes` above:
  // QUANTITY_TYPE_MAP is ONE bounded region in columnar-parser-indexes.ts. A
  // later patch recognizing a new IfcQuantity* leaf type only via a sibling
  // `export const X_QUANTITY_MAP = {...}` (or similarly named object)
  // alongside it would never be read here.
  assertNoUnrecognizedSiblingBindings(mapCode, {
    bindingPattern: /export const (\w+)(?::[^=]+)?\s*=\s*\{([\s\S]*?)\};/g,
    valuePattern: /'IFCQUANTITY[A-Z]+'/,
    nameFilter: /QUANTITY/i,
    recognizedNames: ['QUANTITY_TYPE_MAP'],
    label: 'tsQuantityTypes',
  });
  const m = /QUANTITY_TYPE_MAP[^{]*\{([\s\S]*?)\};/.exec(mapCode);
  if (m) {
    for (const x of m[1].matchAll(/'(IFCQUANTITY[A-Z]+)'/g)) found.add(x[1]);
  }
  const collectCode = stripComments(collectSrc);
  const c = /const COMPLEX_QUANTITY_TYPE = '([A-Z]+)';/.exec(collectCode);
  if (c) found.add(c[1]);
  return found;
}

/** The `IfcMaterial*` variants the server's `match ty.as_str()` in
 * `resolve_material` names. */
export function rustMaterialTypes(src) {
  const code = stripComments(src);
  const found = new Set();
  for (const m of code.matchAll(/"(IFCMATERIAL[A-Z]*)"\s*=>/g)) found.add(m[1]);
  return found;
}

/** The TS side names the same variants twice (a resolver and a display-label
 * helper further down the file) — a Set naturally dedupes, so scanning the
 * whole file for `case '...'` is equivalent to scanning either function
 * alone and does not double-count. */
export function tsMaterialTypes(src) {
  const code = stripComments(src);
  const found = new Set();
  for (const m of code.matchAll(/case '(IFCMATERIAL[A-Z]*)'/g)) found.add(m[1]);
  return found;
}
