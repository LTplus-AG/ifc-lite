/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Holds the on-demand property extractor (`extractPropertiesOnDemand`,
 * driven by `property-value-parser.ts::parsePropertyValueWithComplex`) to
 * the SAME shared fixture as its Rust twin,
 * `rust/processing/tests/space_zone_property_type_vectors.rs`, which drives
 * `processor::properties::resolve_space_zone_properties_lazy` (the
 * IfcSpace/IfcZone property resolver feeding `MeshData::properties`) through
 * `process_geometry`.
 *
 * `properties.rs` previously carried a doc comment claiming byte-identical
 * "Parity", but the comparison it verified was against this crate's OWN
 * earlier eager decode path, never against this TS extractor. This is the
 * first harness that actually runs both sides on one fixture.
 *
 * Both sides resolve to the SAME values for every property they both
 * support (text/real/integer/boolean/logical/enumerated, a $-absent value,
 * and STEP `\S\`/`\X2\...\X0\`-escaped text). The two are NOT claimed
 * type-identical: the Rust side's output is `BTreeMap<String, String>` (a
 * compact display map for `MeshData::properties`, currently unread by any
 * downstream consumer), so it stringifies everything and cannot carry
 * `PropertyValueType.Boolean`/`.Logical` the way this extractor does. See
 * the Rust test file for the two documented structural divergences
 * (type erasure on booleans/logicals; a $-absent value is a `null`-valued
 * entry here vs. a dropped key there).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StepTokenizer } from './tokenizer.js';
import { ColumnarParser, extractPropertiesOnDemand } from './columnar-parser.js';

// The fixture lives beside the Rust half of the harness; skip gracefully if
// this package is tested outside the monorepo.
const fixturePath = fileURLToPath(
  new URL(
    '../../../rust/processing/tests/fixtures/space_zone_property_type_vectors.json',
    import.meta.url,
  ),
);

const SPACE_ID = 30;

describe.skipIf(!existsSync(fixturePath))('extractPropertiesOnDemand vs. the Rust space/zone resolver', () => {
  const ifc = existsSync(fixturePath)
    ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as { ifc: string }).ifc
    : '';

  async function extractSpaceProperties() {
    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs: Array<{
      expressId: number;
      type: string;
      byteOffset: number;
      byteLength: number;
      lineNumber: number;
    }> = [];
    for (const ref of tokenizer.scanEntitiesFast()) {
      entityRefs.push({
        expressId: ref.expressId,
        type: ref.type,
        byteOffset: ref.offset,
        byteLength: ref.length,
        lineNumber: ref.line,
      });
    }
    const parser = new ColumnarParser();
    const store = await parser.parseLite(source.buffer.slice(0), entityRefs, {});
    return extractPropertiesOnDemand(store, SPACE_ID);
  }

  function propsByName(psets: Awaited<ReturnType<typeof extractSpaceProperties>>, psetName: string) {
    const pset = psets.find((p) => p.name === psetName);
    if (!pset) throw new Error(`pset ${psetName} not found`);
    return Object.fromEntries(pset.properties.map((p) => [p.name, p]));
  }

  it('fixture is present', () => {
    expect(ifc.length).toBeGreaterThan(0);
  });

  it('resolves every supported value kind with its declared type, agreeing with the Rust printed form', async () => {
    const psets = await extractSpaceProperties();
    const psetA = propsByName(psets, 'PsetA');

    // Text (also exercises the \S\ escape: 'e' shifted +128 -> "å",
    // matching the Rust side's "Cafå").
    expect(psetA.TextProp.value).toBe('Cafå');
    // Numeric measures print the same digits as Rust's Display-based
    // stringification, but stay typed here.
    expect(psetA.RealProp).toMatchObject({ type: 1, value: 3.5 }); // Real
    expect(psetA.IntProp).toMatchObject({ type: 2, value: 4 }); // Integer
    expect(psetA.EnumProp.value).toBe('Red');
    // \X2\00E9\X0\ decodes to the same "é" both sides see.
    expect(psetA.UnicodeProp.value).toBe('café');
  });

  it('preserves the IFC-declared boolean/logical TYPE where Rust\'s string map cannot', async () => {
    const psets = await extractSpaceProperties();
    const psetA = propsByName(psets, 'PsetA');

    // Rust's twin stringifies these to the bare enum token ("T" / "U") —
    // see space_zone_property_type_vectors.rs. This extractor keeps the
    // declared type for the property panel.
    expect(psetA.BoolProp).toMatchObject({ type: 3, value: true }); // Boolean
    expect(psetA.LogicalProp).toMatchObject({ type: 4, value: null }); // Logical (.U.)
  });

  it('keeps a $-absent property listed (null value) where Rust drops the key entirely', async () => {
    const psets = await extractSpaceProperties();
    const psetA = propsByName(psets, 'PsetA');

    expect(psetA.AbsentProp).toBeDefined();
    expect(psetA.AbsentProp.value).toBeNull();
  });

  it('keeps a same-named property in two psets separate, unlike the flattened Rust map', async () => {
    const psets = await extractSpaceProperties();
    const psetA = propsByName(psets, 'PsetA');
    const psetB = propsByName(psets, 'PsetB');

    // No collision here: each pset is its own entry in the returned array.
    // Rust's twin flattens to one map, where the unscoped key is first-wins
    // (PsetA) and only the pset-scoped alias ("PsetB.TextProp") still
    // reaches PsetB's value — see
    // same_named_property_in_two_psets_survives_under_its_scoped_key.
    expect(psetA.TextProp.value).toBe('Cafå');
    expect(psetB.TextProp.value).toBe('Overridden');
  });
});
