/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PLY vertex-colour normalization.
 *
 * Split out of `ply.ts` (which decodes the rest of the file) because the
 * range policy carries a long documented rationale and the two ascii/binary
 * decoders that call it live in `ply.ts` itself.
 */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isFloatColorType(type: string): boolean {
  return type === 'float' || type === 'float32' || type === 'double' || type === 'float64';
}

/**
 * Normalize a decoded RGB channel value to 0..1.
 *
 * The PLY format has no single blessed encoding for colour. Integer types
 * have a fixed declared range; floating-point RGB has two real conventions,
 * selected for the whole RGB buffer by `normalizePlyColors` below:
 *
 *   - `uchar`/`uint8` (and the signed `char`/`int8`, treated the same): the
 *     overwhelming majority convention, 0..255 → divide by 255.
 *   - `ushort`/`uint16`: 0..65535, the 16-bit-colour convention used by
 *     many Leica/FARO scanner exports and CloudCompare's 16-bit RGB option
 *     → divide by 65535. Dividing these by 255 instead saturates every
 *     channel to 1.0 (a scan renders solid white).
 *   - `float`/`float32`/`double`/`float64`: either normalized 0..1 or
 *     byte-range 0..255. A finite channel above 1 selects byte-range for all
 *     float channels in that file; otherwise they pass through unscaled.
 *   - `short`/`int16`: no documented PLY convention places signed 16-bit
 *     colour in the wild; treated the same as `ushort` (÷32767, its
 *     positive range) since a colour channel is never meant to go
 *     negative — chosen over ÷65535 because for a *signed* type the
 *     positive half is the whole usable range.
 *   - `int`/`uint`/`int32`/`uint32`: no documented convention exists for
 *     32-bit-typed PLY colour either; rather than guess a bit width we
 *     fall back to the 0..255 rule (`uchar`'s convention) since some
 *     writers do emit tiny int-typed colour values that fit in a byte.
 *     Values that are genuinely wider than a byte will clamp to 1.0 here
 *     — no worse than the pre-existing behaviour for every other type.
 */
export function normalizeColorChannel(value: number, type: string, floatUsesByteRange: boolean = false): number {
  // Keep hostile/non-standard float input out of the renderer's colour
  // buffer. `clamp01(NaN)` would return NaN because both comparisons fail.
  if (!Number.isFinite(value)) return 0;
  switch (type) {
    case 'float':
    case 'float32':
    case 'double':
    case 'float64':
      return clamp01(value / (floatUsesByteRange ? 255 : 1));
    case 'ushort':
    case 'uint16':
      return clamp01(value / 65535);
    case 'short':
    case 'int16':
      return clamp01(value / 32767);
    default:
      // uchar/uint8/char/int8, and the undocumented int/uint/int32/uint32
      // fallback described above.
      return clamp01(value / 255);
  }
}

/**
 * Normalize a complete PLY RGB buffer in place.
 *
 * Float PLY colours are ambiguous in the wild: both [0, 1] and [0, 255]
 * occur under the same `float` declaration. Decide ONCE for every float
 * channel in the file: any finite float channel above 1 selects the byte
 * convention for all float channels. Per-value detection would turn a dark
 * float-255 colour such as `(1, 0.5, 0)` into white-ish `(1, .5, 0)` while
 * its brighter neighbours are divided by 255.
 *
 * Values outside the selected range are clamped after normalization;
 * non-finite values become black. Integer properties retain their declared
 * type's fixed divisor regardless of neighbouring float channels.
 */
export function normalizePlyColors(
  colors: Float32Array,
  types: readonly [string, string, string],
): void {
  const floatUsesByteRange = colors.some(
    (value, index) => isFloatColorType(types[index % 3]) && Number.isFinite(value) && value > 1,
  );
  for (let index = 0; index < colors.length; index++) {
    colors[index] = normalizeColorChannel(colors[index], types[index % 3], floatUsesByteRange);
  }
}
