/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5175: recognize the ONE LandXML load failure the "assumed unit" retry
 * affordance may act on — a numeric, renderable TIN surface refused because
 * the source declares no `<LandXML><Units>` element (Rust diagnostic
 * LXML009, `rust/landxml/src/parser/finalize.rs`). Every other LandXML
 * failure (malformed XML, an unsupported schema, a resource-limit refusal,
 * …) must NOT show a unit picker — there is no unit that would fix them.
 *
 * `require_units_for_renderable_tin` always throws the same fixed message:
 *
 *   "a numeric, renderable TIN surface requires a LandXML/Units element
 *    with a linearUnit attribute"
 *
 * and the wasm boundary prefixes it with the diagnostic code before it
 * becomes a JS `Error.message` (`LandXmlError`'s `Display`: `"{code}: {msg}"`
 * in `rust/landxml/src/model.rs`), so the final string always reads
 * `"LXML009: a numeric, renderable TIN surface requires a LandXML/Units
 * element with a linearUnit attribute"`.
 *
 * Matched by two stable substrings rather than the whole sentence (or the
 * `LXML009` code, which a caller-visible message is not guaranteed to keep
 * verbatim) so a copy-edit of the surrounding prose can't silently break the
 * affordance while `rust/landxml/tests/units_required_5175.rs`'s
 * `assert_lxml009` keeps both substrings pinned on the Rust side.
 */
export function isLandXmlUnitsRefusal(message: string): boolean {
  return message.includes('linearUnit') && message.includes('LandXML/Units');
}

/**
 * The prompt state a failed LandXML load should publish, or `null` when the
 * failure is not the units refusal. Kept beside `isLandXmlUnitsRefusal` so the
 * decision to offer a unit picker lives with the rule that recognizes one,
 * rather than inline in `useIfcLoader`'s error handler (#5175).
 */
export function landXmlUnitsRefusalPrompt(
  message: string,
  fileName: string,
  retry: (assumedLinearUnit: string) => void,
): { fileName: string; retry: (assumedLinearUnit: string) => void } | null {
  return isLandXmlUnitsRefusal(message) ? { fileName, retry } : null;
}

/**
 * Every linear-unit token `LandXmlParseOptionsJs.assumedLinearUnit` accepts
 * (`rust/landxml/src/semantics.rs::scale`, mirrored in
 * `rust/landxml/src/pipe_parser/convert.rs::scale`), paired with the
 * catalogue key for its display label. Deliberately in source order, not
 * metric-first or alphabetical, so nothing in this table reads as a
 * suggested/default choice — issue #5175 is exactly about the viewer never
 * assuming a unit on the user's behalf, so the picker starts unselected.
 */
export const LANDXML_ASSUMABLE_LINEAR_UNITS = [
  { value: 'meter', labelKey: 'landXml.unitsPrompt.unit.meter' },
  { value: 'millimeter', labelKey: 'landXml.unitsPrompt.unit.millimeter' },
  { value: 'centimeter', labelKey: 'landXml.unitsPrompt.unit.centimeter' },
  { value: 'kilometer', labelKey: 'landXml.unitsPrompt.unit.kilometer' },
  { value: 'inch', labelKey: 'landXml.unitsPrompt.unit.inch' },
  { value: 'foot', labelKey: 'landXml.unitsPrompt.unit.foot' },
  { value: 'USSurveyFoot', labelKey: 'landXml.unitsPrompt.unit.USSurveyFoot' },
  { value: 'mile', labelKey: 'landXml.unitsPrompt.unit.mile' },
] as const;
