/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PLY vertex-colour normalization.
 *
 * Split out of `ply.ts` (which decodes the rest of the file) because the
 * per-type colour rule carries a long documented rationale and the two
 * ascii/binary decoders that call it live in `ply.ts` itself.
 */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Normalize a decoded RGB channel value to 0..1.
 *
 * The PLY format has no single blessed encoding for colour, so the divisor
 * is picked from the property's own declared type rather than sniffed from
 * the value (magnitude sniffing is exactly what caused the original bug —
 * see git history):
 *
 *   - `uchar`/`uint8` (and the signed `char`/`int8`, treated the same): the
 *     overwhelming majority convention, 0..255 → divide by 255.
 *   - `ushort`/`uint16`: 0..65535, the 16-bit-colour convention used by
 *     many Leica/FARO scanner exports and CloudCompare's 16-bit RGB option
 *     → divide by 65535. Dividing these by 255 instead saturates every
 *     channel to 1.0 (a scan renders solid white).
 *   - `float`/`float32`/`double`/`float64`: already 0..1 (CloudCompare,
 *     some photogrammetry exporters) → pass through unscaled.
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
export function normalizeColorChannel(value: number, type: string): number {
  switch (type) {
    case 'float':
    case 'float32':
    case 'double':
    case 'float64':
      return clamp01(value);
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
