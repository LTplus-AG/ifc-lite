/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Numeric boundary helpers for BCF — both directions.
 *
 * A `.bcfzip` is an untrusted file, and every number in it arrives through a
 * bare `parseFloat`. `parseFloat` has no failure value that is out of band:
 * `"NaN"` parses to `NaN`, and `"1e999"` — a perfectly well-formed decimal
 * literal — parses to `Infinity`. Both then flow into the viewer camera, which
 * stores a pose verbatim by design.
 *
 * The WRITE side is the same boundary seen from the other end, and it is the
 * half that was missing: `${Infinity}` stringifies to `"Infinity"`, which is
 * not in `xs:double`'s lexical space (XSD 1.0 spells the infinities `INF` and
 * `-INF`), so every non-finite number the writer touched produced an archive
 * xmllint rejects. Keeping both halves in one file is deliberate: the read
 * guard and the write guard have to agree on what "a usable number" means, and
 * they can only be checked against each other while they sit side by side.
 */

/**
 * `parseFloat`, but a value that is not a real number is reported as
 * `undefined` rather than as `NaN`/`Infinity`.
 *
 * `undefined` is deliberately the *same* signal the parsers already use for
 * "this element is missing", so every call site handles it already: a camera
 * with an unusable coordinate is dropped exactly as a camera with no
 * `<CameraViewPoint>` is, a clipping plane is skipped exactly as one with no
 * `<Location>` is. That is what makes validating at the parser cheap — it adds
 * no new branch anywhere — and it is why this is the boundary the fix belongs
 * at rather than the six app-layer consumers downstream, which is the
 * arrangement that let the gap open in the first place.
 */
export function parseFiniteFloat(raw: string): number | undefined {
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * A caller-supplied camera-to-target distance, or `fallback` when it is not a
 * usable one.
 *
 * The viewer passes `camera.getDistance()` here, and that is raw by design:
 * `@ifc-lite/renderer` reports a malformed pose rather than hiding it, so a
 * pose already broken by some other route arrives as `NaN`. The conversions
 * that take this value compute `target = viewPoint + direction * distance` and
 * the result is written back into the camera — so *restoring a known-good
 * viewpoint*, the one action a user reaches for after the camera has gone
 * wrong, was the thing that could not repair it. Falling back to the
 * documented default here makes the restore land on a finite pose, which is
 * recoverable, and it needs one guard rather than one per consumer.
 *
 * Zero is rejected along with the non-finite values: a zero reference distance
 * collapses the target onto the eye, which is a degenerate pose in its own
 * right (`getDistance()` returns exactly 0 for it, and it is what a camera
 * that has never been positioned reports).
 */
export function usableTargetDistance(distance: number | undefined, fallback: number): number {
  return distance !== undefined && Number.isFinite(distance) && distance > 0 ? distance : fallback;
}

/**
 * A number on its way INTO an archive, as the text an XSD numeric type will
 * accept — or an error naming what was wrong and where.
 *
 * FINITENESS, not sign, is the property. That distinction is the whole bug:
 * `Infinity > 0` is `true`, so a positivity check passes it, and
 * `Number.isNaN(Number('Infinity'))` is `false`, so an `isNaN` check passes it
 * too. Only `Number.isFinite` rejects the pair, and each of the three
 * non-finite values fails the schemas a different way, which is why none of
 * them can be left to a facet:
 *
 * - `Infinity`/`-Infinity` stringify to `"Infinity"`/`"-Infinity"`, which
 *   `xs:double` does not admit at all (XSD 1.0's lexical space spells the
 *   infinities `INF` and `-INF`), so they are rejected as "not a valid value of
 *   the atomic type" wherever they appear.
 * - `NaN` stringifies to `"NaN"`, which `xs:double` DOES admit. A bare
 *   `xs:double` element — every camera/line/clipping-plane/bitmap coordinate,
 *   `ViewToWorldScale`, `Bitmap/Height` — therefore validates while carrying a
 *   number no consumer can use, and our own reader drops it on the way back in
 *   ({@link parseFiniteFloat}). Schema validity is not the bar here; a value
 *   that survives the round trip is.
 *
 * Refusing is the same policy the rest of the writer already applies to
 * unrepresentable input (`writer-camera.ts`'s camera-choice and AspectRatio
 * checks, `writer.ts`'s `Topic/@TopicType` check): we do not silently
 * substitute a number the caller never chose, and we do not emit markup a
 * conforming reader may reject.
 */
export function xsdDouble(value: number, element: string, where: string): string {
  if (!Number.isFinite(value)) {
    throw new Error(
      `BCF requires a finite number for ${element} (${where} has ${value}). ` +
        `XSD numeric types cannot express Infinity, -Infinity or NaN, so writing ` +
        `one produces an archive that fails schema validation or loses the value ` +
        `on read. Supply a finite number before writing.`
    );
  }
  return String(value);
}

/**
 * The `<X>/<Y>/<Z>` triple shared by `Point` and `Direction`, wrapped in
 * `tag`, with every component checked by {@link xsdDouble}.
 *
 * Both schemas declare `Point` and `Direction` as three `xs:double` children in
 * that order, and both are reached from four places (camera vectors, `Line`,
 * `ClippingPlane`, `Bitmap`). Emitting them from one function is what stops a
 * guard from being added to three of the four.
 */
export function xsdPointElement(
  tag: string,
  point: { x: number; y: number; z: number },
  indent: string,
  where: string
): string {
  return (
    `\n${indent}<${tag}>` +
    `\n${indent}  <X>${xsdDouble(point.x, `${tag}/X`, where)}</X>` +
    `\n${indent}  <Y>${xsdDouble(point.y, `${tag}/Y`, where)}</Y>` +
    `\n${indent}  <Z>${xsdDouble(point.z, `${tag}/Z`, where)}</Z>` +
    `\n${indent}</${tag}>`
  );
}

/**
 * A number on its way into an `xs:int` element (`Topic/Index` is the only one
 * the writer emits).
 *
 * `xs:int` is narrower than `xs:double` in two further ways a finiteness check
 * alone would miss: `1.5` is not an `xs:int` ("'1.5' is not a valid value of
 * the atomic type 'xs:int'"), and the type is 32-bit, so a whole number outside
 * [-2^31, 2^31-1] is out of range too. `Number.isInteger` is false for `NaN`
 * and both infinities, so finiteness comes with it rather than needing its own
 * branch.
 */
export function xsdInt(value: number, element: string, where: string): string {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new Error(
      `BCF requires a 32-bit integer for ${element} (${where} has ${value}). ` +
        `xs:int admits neither a fractional value, a non-finite one, nor one ` +
        `outside [-2147483648, 2147483647].`
    );
  }
  return String(value);
}
