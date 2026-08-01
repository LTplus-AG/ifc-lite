/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * De-identification for B5.2's foreign inputs.
 *
 * The two foreign models are real delivered client work. Nothing that could
 * identify the project, the firm or the filesystem they came from may reach
 * this repository: not the file name, not the STEP header, not an owner
 * history, not a path. Every script in this bet therefore takes the model
 * path as a RUNTIME argument, reads it in place, and writes only what this
 * module lets through:
 *
 *   - a human-readable alias ("model-a" / "model-b") supplied on the command
 *     line by the operator, and nothing else that binds an artifact to a
 *     specific file;
 *   - COARSENED descriptors: a 5 MB size bucket, a 50,000-entity count
 *     bucket, the schema version, the ORDER of the dominant element types
 *     (names, no counts) and the authoring-tool FAMILY (a coarse label the
 *     operator passes in, never the FILE_NAME / FILE_DESCRIPTION strings).
 *
 * RE-IDENTIFICATION, which is the thing this module exists to prevent. A
 * measurement that is exact, cheap to recompute and effectively unique is not
 * a descriptor, it is a confirmation oracle: a reader holding a candidate file
 * can check it in seconds and know whether they are holding the model. A
 * sha256 prefix does that outright; so, very nearly, do an exact byte length,
 * an exact entity count and a full element histogram. None of those is emitted
 * by this bet. What IS emitted is coarse enough that a match narrows rather
 * than confirms.
 *
 * Two different filters, because the two kinds of string carry different
 * risk:
 *
 * `safeMessage()` - for strings ifc-lite ITSELF composed (validation issue
 * messages). Those are template text plus counts plus IFC type names, so the
 * only job here is to guarantee that assumption rather than trust it: any
 * token that is not template vocabulary, a number, an IFC type name or an
 * express-id reference is redacted.
 *
 * `standardNameOrPlaceholder()` - for strings the FILE authored (quantity-set
 * and quantity names). A custom pset can be named after the firm, so nothing
 * authored is echoed: a name is emitted verbatim only when it is
 * buildingSMART-standard vocabulary, and otherwise collapses to
 * `<non-standard>`. That is also the better measurement - "how much of this
 * file's quantity vocabulary is standard" is the number the report wants.
 */

/** Size bucket, in megabytes. Widened deliberately: see RE-IDENTIFICATION. */
export const SIZE_BUCKET_MB = 5;

/** Entity-count bucket. Widened deliberately: see RE-IDENTIFICATION. */
export const ENTITY_COUNT_BUCKET = 50_000;

/**
 * Coarsen a byte length to a 5 MB bucket. The exact length is one `stat` away
 * for anyone holding a candidate file and is very nearly unique to it; a 5 MB
 * bucket keeps the only claim the report makes from this number (these files
 * are three orders of magnitude larger than a corpus model) while admitting
 * far too many files to confirm one.
 *
 * Both buckets are sized for this bet's inputs, which are 75-90 MB and ~1M
 * entities. Anything much smaller rounds to 0, which is the honest bucket for
 * it and not a measurement failure.
 */
export function coarseMegabytes(byteLength) {
  if (typeof byteLength !== 'number' || !Number.isFinite(byteLength)) return null;
  return Math.round(byteLength / 1e6 / SIZE_BUCKET_MB) * SIZE_BUCKET_MB;
}

/**
 * Coarsen an entity count to a 50,000-entity bucket. Same reasoning as
 * `coarseMegabytes`: an exact count is one grep away and effectively unique,
 * while the scale comparison the report makes survives the bucket intact.
 */
export function coarseEntityCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.round(n / ENTITY_COUNT_BUCKET) * ENTITY_COUNT_BUCKET;
}

/**
 * The dominant element types, by descending count, as NAMES ONLY.
 *
 * The counted histogram this replaces was the strongest single fingerprint in
 * the artifact set: forty-odd exact per-type counts jointly identify a file
 * beyond doubt. The ordered names carry what the report actually claims from
 * it - whether the model is structural or architectural - and are shared by
 * every model of that character.
 */
export function dominantElementTypes(typeCounts, n = 8) {
  return Object.entries(typeCounts ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t);
}

/**
 * Vocabulary that may appear in an ifc-lite validation message. Anything a
 * message can legitimately contain: the template words, IFC type tokens, an
 * express-id reference, and any number with separators/units.
 */
const MESSAGE_SAFE = /^(?:IFC[A-Z0-9]*|Ifc[A-Za-z0-9]*|#\d+|[\d.,/%()+-]+|[A-Za-z][a-z]*)$/;

/** Redact anything in an ifc-lite-composed message that is not template vocabulary. */
export function safeMessage(text) {
  if (typeof text !== 'string') return text;
  return text
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s*$/.test(tok) || tok === '') return tok;
      // Punctuation that commonly wraps a word; test the bare core.
      const core = tok.replace(/^[^\w#]+/, '').replace(/[^\w%)\]]+$/, '');
      if (core === '' || MESSAGE_SAFE.test(core)) return tok;
      return '<redacted>';
    })
    .join('');
}

/**
 * buildingSMART-standard quantity-set names. Anything else is authored text
 * and never leaves the run.
 */
const STANDARD_QSET = /^(?:Qto_[A-Za-z0-9]+|BaseQuantities)$/;

/** buildingSMART-standard IfcPhysicalQuantity names used across Qto_*BaseQuantities. */
const STANDARD_QUANTITY = new Set([
  'Length', 'Width', 'Height', 'Depth', 'Thickness', 'Perimeter', 'Diameter', 'Span',
  'CrossSectionArea', 'OuterSurfaceArea', 'TotalSurfaceArea', 'GrossSurfaceArea', 'NetSurfaceArea',
  'GrossArea', 'NetArea', 'GrossSideArea', 'NetSideArea', 'GrossFootprintArea', 'NetFootprintArea',
  'GrossCeilingArea', 'NetCeilingArea', 'GrossWallArea', 'NetWallArea',
  'GrossFloorArea', 'NetFloorArea', 'GrossRoofArea', 'NetRoofArea',
  'GrossVolume', 'NetVolume', 'GrossWeight', 'NetWeight',
  'Area', 'Volume', 'Weight', 'Count', 'Number', 'Shape',
]);

/**
 * Emit a file-authored name only when it is standard vocabulary.
 * Returns `<non-standard>` otherwise.
 */
export function standardNameOrPlaceholder(name, kind) {
  if (typeof name !== 'string') return '<non-standard>';
  if (kind === 'qset') return STANDARD_QSET.test(name) ? name : '<non-standard>';
  return STANDARD_QUANTITY.has(name) ? name : '<non-standard>';
}

/** Round to `d` decimals, returning a finite number or null. */
export function round(v, d = 6) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
