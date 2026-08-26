/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ePSet_ProjectedCRS.MapUnit` label resolution.
 *
 * The IFC2x3 ePSet georeferencing convention carries the map unit as a free
 * text `IfcLabel` rather than an `IfcNamedUnit`, so the reader has to decide
 * which spellings it recognises and which it refuses. That decision — and the
 * derived table behind it — lives here rather than in the extractor, next to
 * its twin `infer_map_unit_scale` in rust/core/src/georef.rs and pinned by
 * the shared vectors in rust/core/tests/fixtures/georef_vectors.json.
 */

import { CONVERSION_BASED_UNIT_FACTORS, SI_PREFIX_MULTIPLIERS } from './unit-extractor.js';

/** Fold a free-text unit label to its alphanumerics, upper-cased. */
function foldUnitLabel(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Split a free-text unit label into upper-cased alphanumeric tokens. */
function tokenizeUnitLabel(label: string): string[] {
  return label.toUpperCase().split(/[^A-Z0-9]+/).filter((token) => token.length > 0);
}

/** 1200/3937 m — the US survey foot, distinct from the international 0.3048. */
const US_SURVEY_FOOT_SCALE = 0.3048006096;

/**
 * Exact-match table for an `ePSet_ProjectedCRS.MapUnit` free-text label,
 * DERIVED rather than hand-written: every member of the `IfcSIPrefix` EXPRESS
 * enumeration crossed with the METRE/METER spellings, the unprefixed base,
 * and the conversion-based length units from the shared table.
 *
 * A `Map` rather than an object literal so a label like `CONSTRUCTOR` cannot
 * resolve through `Object.prototype`.
 */
const MAP_UNIT_LABEL_SCALE: Map<string, number> = (() => {
  const table = new Map<string, number>();
  for (const spelling of ['METRE', 'METER']) {
    table.set(foldUnitLabel(spelling), 1);
    for (const [prefix, factor] of Object.entries(SI_PREFIX_MULTIPLIERS)) {
      table.set(foldUnitLabel(prefix + spelling), factor);
    }
  }
  for (const [name, factor] of Object.entries(CONVERSION_BASED_UNIT_FACTORS)) {
    table.set(foldUnitLabel(name), factor);
  }
  // The US survey foot is a different ratio from the international foot
  // (1200/3937 vs 0.3048) and is spelled several ways in the wild. These are
  // the accepted spellings, matched exactly rather than sniffed for.
  for (const alias of ['USSURVEYFOOT', 'USSURVEYFEET', 'USSURVEYFT', 'USFOOT', 'USFEET', 'USFT', 'FTUS']) {
    table.set(alias, US_SURVEY_FOOT_SCALE);
  }
  return table;
})();

/** The foot/feet spellings a US-survey qualifier may be attached to. */
const FOOT_TOKENS = new Set(['FOOT', 'FEET', 'FT']);

/**
 * Order-insensitive recogniser for the separated US-survey foot spellings —
 * `foot (US survey)`, `SURVEY FEET (US)`, `US survey foot`. The glued
 * spellings (`USSURVEYFOOT`, `FTUS`, …) are in {@link MAP_UNIT_LABEL_SCALE}
 * and matched exactly there; once an exporter puts separators in, the word
 * order varies and gluing alone cannot see it.
 *
 * Accepts exactly one foot token plus either `US` (or the glued `USSURVEY`)
 * or both `US` and `SURVEY`. A bare `SURVEY FOOT` without `US` is REFUSED:
 * other national survey feet exist (the Indian and Clarke feet are different
 * ratios), so the qualifier alone does not identify the value.
 */
function isUsSurveyFootTokens(tokens: string[]): boolean {
  const feet = tokens.filter((token) => FOOT_TOKENS.has(token));
  if (feet.length !== 1) return false;
  const rest = tokens.filter((token) => !FOOT_TOKENS.has(token));
  if (rest.length === 1) return rest[0] === 'US' || rest[0] === 'USSURVEY';
  return rest.length === 2 && rest.includes('US') && rest.includes('SURVEY');
}

/**
 * Resolve an `ePSet_ProjectedCRS.MapUnit` free-text label to its metre scale.
 *
 * `MapUnit` on the ePSet path is exporter free text, so the label is
 * NORMALISED and then matched EXACTLY — never substring-matched.
 *
 * What the normalisation accepts:
 * - any case and any separators: `metres`, `Meters`, `US survey foot`,
 *   `MILLI-METRE` (letters and digits are kept, everything else dropped);
 * - the two base spellings `METRE` and `METER`, each prefixed by any of the
 *   sixteen `IfcSIPrefix` members (`MILLIMETRE` … `GIGAMETER`);
 * - the conversion-based length units of the shared table (`FOOT`, `FEET`,
 *   `INCH`, `YARD`, `MILE`);
 * - one English plural suffix on any of the above, stripped once and then
 *   re-matched exactly: `METRES`, `KILOMETERS`, `MILLIMETRES`, `INCHES`,
 *   `MILES`;
 * - the US survey foot, glued (`USSURVEYFOOT`, `USFT`, `FTUS`, …) or
 *   separated in any word order (see {@link isUsSurveyFootTokens}).
 *
 * What it still REFUSES (returns `undefined`, so the ePSet convention defers
 * to the project length unit downstream):
 * - an absent or blank label;
 * - a label that merely CONTAINS a known unit: `SQUARE METRE` is an area,
 *   `BANANAMETRE` is not a unit, and neither may borrow the metre's scale;
 * - abbreviations that are not in the table (`M`, `MM`, `MTR`);
 * - a survey foot with no nationality (`SURVEY FOOT`);
 * - anything else, including a plural whose singular is still unknown.
 *
 * The exactness is the point. An `includes('METRE')` test is satisfied by
 * MILLIMETRE, CENTIMETRE, KILOMETRE, DECAMETRE, HECTOMETRE and every other
 * prefixed spelling, so a decametre map unit answered 1 — a silent 10x error
 * in the CRS scale; the same shape scaled a projected CRS by 1000x in #3274.
 * Normalising a recognisable spelling onto a table entry is not that: the
 * answer is still one exact table hit, and `DECAMETRES` resolves to 10, not
 * to 1. Where no exact answer exists after normalisation, decline rather than
 * approximate — an absent MapUnit is honest and has a defined meaning, a
 * wrong one relocates the model.
 *
 * Twin of `infer_map_unit_scale` in rust/core/src/georef.rs; both are pinned
 * to the shared vectors in rust/core/tests/fixtures/georef_vectors.json.
 */
export function inferMapUnitScaleFromLabel(mapUnit: string | undefined): number | undefined {
  if (!mapUnit) return undefined;
  const tokens = tokenizeUnitLabel(mapUnit);
  if (tokens.length === 0) return undefined;
  if (isUsSurveyFootTokens(tokens)) return US_SURVEY_FOOT_SCALE;

  const key = foldUnitLabel(mapUnit);
  const exact = MAP_UNIT_LABEL_SCALE.get(key);
  if (exact !== undefined) return exact;

  // One English plural suffix, removed once and re-matched exactly. `-ES`
  // covers INCHES, whose singular is not reachable by dropping a single `S`.
  for (const suffix of ['S', 'ES']) {
    if (!key.endsWith(suffix)) continue;
    const singular = MAP_UNIT_LABEL_SCALE.get(key.slice(0, -suffix.length));
    if (singular !== undefined) return singular;
  }
  return undefined;
}
