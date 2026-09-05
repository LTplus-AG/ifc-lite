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

/** Extracts the bounded `let rel_types = [ ... ];` array in relationships.rs. */
export function rustRelationshipTypes(src) {
  const code = stripComments(src);
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
  const found = new Set();
  for (const name of ['HIERARCHY_REL_TYPES', 'PROPERTY_REL_TYPES', 'ASSOCIATION_REL_TYPES']) {
    const m = new RegExp(`export const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(code);
    if (!m) continue;
    for (const x of m[1].matchAll(/'([A-Z0-9]+)'/g)) found.add(x[1]);
  }
  return found;
}

/** Extracts the two `matches!(type_name.to_uppercase().as_str(), "A" | "B" | ...)`
 * arms in spatial.rs: is_spatial_type is the full set; is_building_like is a
 * SUBSET used for a different purpose (deciding a "building-like" root), not
 * an independent concept, so only the first is compared here. */
export function rustSpatialTypes(src) {
  const code = stripComments(src);
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
