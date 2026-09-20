/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plural cardinality of the double-georeference agreement (#4918, review
 * thread PRRT_kwDOQ3UF-86kFSkT). `localizedScaleOverride` and
 * `localizedRawValuesNote` used to pick between exactly two catalogue keys
 * with a `length === 1 ? …One : …Other` ternary in the caller — collapsing
 * every non-singular cardinality (2, 3, 11, …) into the same "Other" key
 * before `t` ever ran a plural rule. A locale whose `Intl.PluralRules`
 * distinguishes `two`/`few` from `other` (Arabic does: 0 zero, 1 one, 2 two,
 * 3-10 few, 11-99 many, else other) could never surface those forms because
 * the ternary already decided "not one, so Other" ahead of time.
 *
 * The fix passes the raw cardinality as `count` into a single plural-valued
 * catalogue key (`scaleOverride`/`scaleOverrideReason`/
 * `rawValuesCorrectionFactor`) and lets `selectPluralCategory` (via `t`)
 * choose the category. These tests register an Arabic-rules locale that
 * defines distinct `two` and `few` forms and would fail (falling through to
 * the shared "other" text) without that fix.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { registerLocale, resolve, setLocale } from '@/i18n/registry';
import { localizedRawValuesNote, localizedScaleOverride } from './georeference-i18n.js';
import type { DoubleGeoreference } from '@/lib/geo/double-georeference';

const LOCALE = 'ar-SA-x-georef-plural-test';

function found(overrides: Partial<Pick<DoubleGeoreference, 'scaleForExport' | 'factorsForExport'>>): DoubleGeoreference {
  return {
    worldCenter: { x: 0, y: 0 },
    offset: { easting: 0, northing: 0 },
    residual: 0,
    displacement: 0,
    overridesAuthoredRotation: false,
    scaleForExport: null,
    factorsForExport: [],
    ...overrides,
  };
}

describe('georeference-i18n plural cardinality (#4918)', () => {
  it('selects the two/few forms for scaleOverride/scaleOverrideReason instead of collapsing to other', () => {
    registerLocale(LOCALE, {
      'properties.georef.scaleOverride': {
        one: '[one {fields}]',
        two: '[two {fields}]',
        few: '[few {fields}]',
        other: '[other {fields}]',
      },
      'properties.georef.scaleOverrideReason': {
        one: '[reason-one {fields}]',
        two: '[reason-two {fields}]',
        few: '[reason-few {fields}]',
        other: '[reason-other {fields}]',
      },
    });
    setLocale(LOCALE);

    // 2 fields (Scale + one factor) -> Arabic "two", never the shared "other" text.
    const two = found({ scaleForExport: 2, factorsForExport: ['FactorX'] });
    assert.match(localizedScaleOverride(resolve, LOCALE, two) ?? '', /^\[reason-two /);

    // 3 fields (Scale + two factors) -> Arabic "few", never English "other".
    const few = found({ scaleForExport: 3, factorsForExport: ['FactorX', 'FactorY'] });
    assert.match(localizedScaleOverride(resolve, LOCALE, few) ?? '', /^\[reason-few /);

    // No override reason (scaleForExport null) still selects the plain key's plural forms.
    const twoNoReason = found({ scaleForExport: null, factorsForExport: ['FactorX', 'FactorY'] });
    assert.match(localizedScaleOverride(resolve, LOCALE, twoNoReason) ?? '', /^\[two /);

    setLocale('en');
  });

  it('selects the two/few forms for rawValuesCorrectionFactor instead of collapsing to other', () => {
    registerLocale(LOCALE, {
      'properties.georef.rawValuesCorrectionFactor': {
        one: '[factor-one {edits}|{factors}]',
        two: '[factor-two {edits}|{factors}]',
        few: '[factor-few {edits}|{factors}]',
        other: '[factor-other {edits}|{factors}]',
      },
      'properties.georef.correctionOffsets': 'offsets',
      'properties.georef.correctionAngle': 'angle',
    });
    setLocale(LOCALE);

    const two = found({ factorsForExport: ['FactorX', 'FactorY'] });
    assert.match(localizedRawValuesNote(resolve, LOCALE, two), /^\[factor-two /);

    const few = found({ factorsForExport: ['FactorX', 'FactorY', 'FactorZ'] });
    assert.match(localizedRawValuesNote(resolve, LOCALE, few), /^\[factor-few /);

    const one = found({ factorsForExport: ['FactorX'] });
    assert.match(localizedRawValuesNote(resolve, LOCALE, one), /^\[factor-one /);

    setLocale('en');
  });
});
