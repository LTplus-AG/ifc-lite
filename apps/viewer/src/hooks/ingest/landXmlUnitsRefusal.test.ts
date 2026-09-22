/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLandXmlUnitsRefusal, LANDXML_ASSUMABLE_LINEAR_UNITS } from './landXmlUnitsRefusal.js';

// The exact wasm-boundary message for LXML009
// (`rust/landxml/src/parser/finalize.rs::require_units_for_renderable_tin`,
// prefixed by `LandXmlError`'s `Display` in `rust/landxml/src/model.rs`).
// `rust/landxml/tests/units_required_5175.rs`'s `assert_lxml009` pins the two
// substrings this test also keys on, on the Rust side.
const LXML009_MESSAGE = 'LXML009: a numeric, renderable TIN surface requires a '
  + 'LandXML/Units element with a linearUnit attribute';

describe('isLandXmlUnitsRefusal (#5175)', () => {
  it('recognizes the LXML009 "no declared Units" refusal', () => {
    assert.equal(isLandXmlUnitsRefusal(LXML009_MESSAGE), true);
  });

  it('does not flag an unrelated LandXML failure', () => {
    // A resource-limit refusal: names neither `linearUnit` nor `LandXML/Units`.
    assert.equal(isLandXmlUnitsRefusal('LXML004: parser limits must be positive'), false);
    // A malformed-XML refusal.
    assert.equal(isLandXmlUnitsRefusal('LXML001: unexpected end of input while parsing LandXML'), false);
    // Mentions "units" in passing but not the two pinned substrings together.
    assert.equal(isLandXmlUnitsRefusal('LXML002: unsupported LandXML schema version'), false);
  });

  it('requires BOTH substrings, not just one', () => {
    assert.equal(isLandXmlUnitsRefusal('a message naming only linearUnit'), false);
    assert.equal(isLandXmlUnitsRefusal('a message naming only LandXML/Units'), false);
  });

  it('offers exactly the tokens LandXmlParseOptionsJs.assumedLinearUnit accepts', () => {
    assert.deepEqual(
      LANDXML_ASSUMABLE_LINEAR_UNITS.map((unit) => unit.value),
      ['meter', 'millimeter', 'centimeter', 'kilometer', 'inch', 'foot', 'USSurveyFoot', 'mile'],
    );
  });
});
