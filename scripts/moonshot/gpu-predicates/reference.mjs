// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * B1.3 spike (M6c) — CPU exact reference oracle + shared-exponent-frame
 * encoder for the GPU orient3d kernel. See DESIGN.md for the argument.
 *
 * Two independent jobs live in this one small file, both built on native
 * BigInt (arbitrary precision, no width limit, straightforward to trust):
 *
 *  1. `orient3dSignBigInt` — the CPU exact reference. Every finite double is
 *     re-expressed as an exact BigInt numerator over the SAME universal
 *     denominator 2^-1074 (the smallest possible magnitude step of any
 *     double, subnormals included), so no shared-frame trick or width cap is
 *     needed here at all — BigInt just pays for however many bits the
 *     numerators need (up to ~1127 bits per coordinate in the worst case).
 *     This is the "obviously correct, no cleverness" oracle everything else
 *     is checked against.
 *
 *  2. `encodeTest` — the shared per-test exponent frame the GPU kernel
 *     actually needs, because WGSL has no arbitrary precision arithmetic.
 *     Bounded to a fixed exponent spread (`D_MAX`); anything wider is
 *     flagged `valid: false` (CPU-fallback) rather than truncated.
 */

// ---- IEEE-754 decomposition -----------------------------------------------

/** decomposeDouble(x) -> { zero, invalid, s: 1|-1, mant: bigint, exp: number }
 *
 * x = s * mant * 2^exp, exactly, bit for bit — no rounding. `mant` is the
 * 53-bit significand (52-bit for subnormals) as a non-negative BigInt.
 */
const f64buf = new ArrayBuffer(8);
const f64view = new Float64Array(f64buf);
const u64view = new BigUint64Array(f64buf);

export function decomposeDouble(x) {
  if (x === 0) return { zero: true, invalid: false, s: 1, mant: 0n, exp: 0 };
  if (!Number.isFinite(x)) return { zero: false, invalid: true, s: 1, mant: 0n, exp: 0 };
  f64view[0] = x;
  const bits = u64view[0];
  const signBit = (bits >> 63n) & 1n;
  const biasedExp = Number((bits >> 52n) & 0x7ffn);
  const mantissaBits = bits & 0xfffffffffffffn; // 52 bits
  let mant, exp;
  if (biasedExp === 0) {
    // subnormal (mantissaBits !== 0n here since x !== 0 was handled above)
    mant = mantissaBits;
    exp = -1074;
  } else {
    mant = mantissaBits | (1n << 52n); // restore the implicit leading bit
    exp = biasedExp - 1075;
  }
  return { zero: false, invalid: false, s: signBit === 1n ? -1 : 1, mant, exp };
}

/** Exact signed BigInt numerator of `x` over the universal denominator
 * 2^-1074 (i.e. `x === Number(numerator) * 2^-1074` exactly, ignoring the
 * fact `Number()` can't hold it — the point is the numerator itself is
 * exact). Returns `null` for NaN/Infinity. */
export function universalNumerator(x) {
  const d = decomposeDouble(x);
  if (d.invalid) return null;
  if (d.zero) return 0n;
  const shift = BigInt(d.exp + 1074); // always >= 0 (exp >= -1074 for any finite double)
  const mag = d.mant << shift;
  return d.s < 0 ? -mag : mag;
}

// ---- CPU exact reference: orient3d sign via BigInt determinant -----------

/** orient3dSignBigInt(pts) — pts is [ax,ay,az, bx,by,bz, cx,cy,cz, dx,dy,dz].
 * Returns -1, 0, or 1 exactly, or `null` if any coordinate is NaN/Infinity.
 * This is the CPU exact reference: the "straightforward and trustworthy"
 * oracle everything else is checked against — no shared-frame cap, BigInt
 * carries however many bits are needed. */
export function orient3dSignBigInt(pts) {
  const n = new Array(12);
  for (let i = 0; i < 12; i++) {
    const v = universalNumerator(pts[i]);
    if (v === null) return null;
    n[i] = v;
  }
  const [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz] = n;
  const r0x = ax - dx, r0y = ay - dy, r0z = az - dz;
  const r1x = bx - dx, r1y = by - dy, r1z = bz - dz;
  const r2x = cx - dx, r2y = cy - dy, r2z = cz - dz;
  const m0 = r1y * r2z - r1z * r2y;
  const m1 = r1x * r2z - r1z * r2x;
  const m2 = r1x * r2y - r1y * r2x;
  const det = r0x * m0 - r0y * m1 + r0z * m2;
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}

// ---- shared-exponent-frame encoder for the GPU kernel ---------------------

/** Magnitude budget: 53-bit mantissa + up to D_MAX bits of shift. */
export const D_MAX = 100;
/** u32 limbs used to store one shifted input coordinate (160 bits >= 153-bit worst case). */
export const MAG_IN_LIMBS = 5;
/** u32 limbs of the GPU kernel's internal sign-magnitude working width (512 bits). */
export const WORK_LIMBS = 16;
/** Words per coordinate in the upload buffer: 5 magnitude limbs + 1 sign flag. */
export const WORDS_PER_COORD = MAG_IN_LIMBS + 1;
/** Words per test (12 coordinates). */
export const WORDS_PER_TEST = WORDS_PER_COORD * 12;

/** computeFrame(coords12) -> { valid, eMin, D, decs }
 *
 * NB: builds `decs` with an explicit loop, not `coords12.map(...)`. If
 * `coords12` is a typed array (e.g. a `Float64Array` subarray view, as the
 * harness uses to avoid per-test allocation), `TypedArray.prototype.map`
 * coerces the callback's return value back to a number for storage in a new
 * typed array of the SAME type — silently turning every `decomposeDouble`
 * object result into `NaN`. That bug corrupted an early version of this
 * function into flagging every single test as CPU-fallback (D compared
 * against NaN is always false). Plain indexed iteration works identically
 * for arrays and typed arrays and sidesteps this entirely.
 */
export function computeFrame(coords12) {
  const decs = new Array(12);
  for (let i = 0; i < 12; i++) decs[i] = decomposeDouble(coords12[i]);
  for (let i = 0; i < 12; i++) {
    if (decs[i].invalid) return { valid: false, reason: 'nan_or_inf', decs };
  }
  let eMin = null, eMax = null;
  for (let i = 0; i < 12; i++) {
    const d = decs[i];
    if (d.zero) continue;
    if (eMin === null || d.exp < eMin) eMin = d.exp;
    if (eMax === null || d.exp > eMax) eMax = d.exp;
  }
  if (eMin === null) return { valid: true, eMin: 0, D: 0, decs };
  const D = eMax - eMin;
  return { valid: D <= D_MAX, eMin, D, decs };
}

function magToLimbsLE(mag, nLimbs) {
  const out = new Uint32Array(nLimbs);
  let v = mag;
  const mask = 0xffffffffn;
  for (let i = 0; i < nLimbs; i++) {
    out[i] = Number(v & mask);
    v >>= 32n;
  }
  if (v !== 0n) {
    throw new Error(`magToLimbsLE overflow: value needs more than ${nLimbs * 32} bits`);
  }
  return out;
}

/** encodeTest(coords12) -> { valid, D, eMin, words: Uint32Array(WORDS_PER_TEST) | null }
 *
 * `words` layout per coordinate (repeated 12x, in a/b/c/d, x/y/z order):
 *   [limb0, limb1, limb2, limb3, limb4, signFlag(0|1)]
 * Every value here is exact: the frame shift is a plain BigInt left-shift
 * (never drops a bit), and the limb split is a plain base-2^32 digit split.
 */
export function encodeTest(coords12) {
  const frame = computeFrame(coords12);
  if (!frame.valid) return { valid: false, D: frame.D ?? null, eMin: frame.eMin ?? null, words: null };
  const { eMin, decs } = frame;
  const words = new Uint32Array(WORDS_PER_TEST);
  for (let i = 0; i < 12; i++) {
    const d = decs[i];
    const base = i * WORDS_PER_COORD;
    if (d.zero) {
      // all-zero limbs, sign flag 0 — already the Uint32Array default.
      continue;
    }
    const shift = BigInt(d.exp - eMin);
    const mag = d.mant << shift;
    const limbs = magToLimbsLE(mag, MAG_IN_LIMBS);
    words.set(limbs, base);
    words[base + MAG_IN_LIMBS] = d.s < 0 ? 1 : 0;
  }
  return { valid: true, D: frame.D, eMin, words };
}

// ---- B2.5 additions -------------------------------------------------------
//
// Everything below this line was added by the B2.5 follow-up (encode
// bottleneck attack + incircle). The B1.3 spike surface above is unchanged
// so the original harness.mjs baseline still runs bit-identically.

/** computeFrameN(coords, count) - computeFrame generalized to `count`
 * coordinates (orient3d uses 12, incircle uses 8). Same contract. */
export function computeFrameN(coords, count) {
  const decs = new Array(count);
  for (let i = 0; i < count; i++) decs[i] = decomposeDouble(coords[i]);
  for (let i = 0; i < count; i++) {
    if (decs[i].invalid) return { valid: false, reason: 'nan_or_inf', decs };
  }
  let eMin = null, eMax = null;
  for (let i = 0; i < count; i++) {
    const d = decs[i];
    if (d.zero) continue;
    if (eMin === null || d.exp < eMin) eMin = d.exp;
    if (eMax === null || d.exp > eMax) eMax = d.exp;
  }
  if (eMin === null) return { valid: true, eMin: 0, D: 0, decs };
  const D = eMax - eMin;
  return { valid: D <= D_MAX, eMin, D, decs };
}

// ---- CPU exact reference: incircle sign via BigInt determinant ------------

/** incircleSignBigInt(pts) - pts is [ax,ay, bx,by, cx,cy, dx,dy] (2D).
 * Sign of the standard lifted 3x3 determinant
 *   | adx  ady  adx^2+ady^2 |
 *   | bdx  bdy  bdx^2+bdy^2 |
 *   | cdx  cdy  cdx^2+cdy^2 |
 * (positive iff d is inside the circle through a,b,c when abc is
 * counterclockwise). Returns -1/0/1 exactly, or null on NaN/Infinity.
 * Homogeneous degree 4 in the coordinate differences, so the universal
 * 2^-1074 denominator (and the GPU's shared 2^eMin frame) scales the
 * determinant by a positive 4th power: sign unchanged - the same argument
 * DESIGN.md section 2 makes for orient3d's degree-3 form. */
export function incircleSignBigInt(pts) {
  const n = new Array(8);
  for (let i = 0; i < 8; i++) {
    const v = universalNumerator(pts[i]);
    if (v === null) return null;
    n[i] = v;
  }
  const [ax, ay, bx, by, cx, cy, dx, dy] = n;
  const adx = ax - dx, ady = ay - dy;
  const bdx = bx - dx, bdy = by - dy;
  const cdx = cx - dx, cdy = cy - dy;
  const alift = adx * adx + ady * ady;
  const blift = bdx * bdx + bdy * bdy;
  const clift = cdx * cdx + cdy * cdy;
  const det =
    adx * (bdy * clift - blift * cdy) -
    ady * (bdx * clift - blift * cdx) +
    alift * (bdx * cdy - bdy * cdx);
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}

// ---- BigInt-free fast encoder (B2.5 encode-bottleneck candidate 1) --------
//
// TODO(remove-by: when the B2.5 raw-bits GPU path (predicates-raw.wgsl)
// graduates out of spike status or the spike is archived; owner: moonshot
// M6c workstream, tracked in docs/vision/moonshots-execution-plan.md B2.5):
// this encoder AND the frozen B1.3 surface it mirrors (encodeTest +
// orient3d.wgsl) are kept verbatim so the committed report.b25.*.json and
// report.battery.json artifacts stay reproducible bit-for-bit. Do not edit
// them in place; supersede them.
//
// Produces the exact same `words` as encodeTest, using only 32-bit integer
// ops on the raw IEEE halves - no BigInt allocation per coordinate. The
// mantissa is at most 53 bits (two u32 halves) and the frame shift is at
// most D_MAX=100 bits, so the shifted magnitude spans at most 3 u32 limbs
// starting at word offset shift>>5 (word offset <= 3, so the top limb index
// is <= 5 - and when it would be 5, i.e. outside the 5-limb budget, its
// value is provably zero because the 153-bit worst case tops out inside
// limb 4; the code checks that invariant instead of trusting it).
//
// NB: reads the IEEE halves through a Uint32Array view, which is
// endianness-dependent (little-endian assumed: lo word first). Every target
// this spike runs on (Apple Silicon, x86) is little-endian; a big-endian
// host would need the two words swapped.

const encScratchF64 = new Float64Array(1);
const encScratchU32 = new Uint32Array(encScratchF64.buffer);
const encMantLo = new Uint32Array(12);
const encMantHi = new Uint32Array(12);
const encExp = new Int32Array(12);
const encNeg = new Uint8Array(12);
const encZero = new Uint8Array(12);

export function encodeTestFast(coords12) {
  let eMin = 0x7fffffff;
  let eMax = -0x7fffffff;
  let any = false;
  for (let i = 0; i < 12; i++) {
    encScratchF64[0] = coords12[i];
    const lo = encScratchU32[0];
    const hi = encScratchU32[1];
    const be = (hi >>> 20) & 0x7ff;
    if (be === 0x7ff) return { valid: false, D: null, eMin: null, words: null };
    let mHi = hi & 0xfffff;
    if (be === 0 && mHi === 0 && lo === 0) {
      encZero[i] = 1;
      continue;
    }
    encZero[i] = 0;
    let exp;
    if (be === 0) {
      exp = -1074; // subnormal: no implicit bit
    } else {
      mHi |= 0x100000; // restore the implicit leading bit
      exp = be - 1075;
    }
    encMantLo[i] = lo;
    encMantHi[i] = mHi;
    encExp[i] = exp;
    encNeg[i] = hi >>> 31;
    any = true;
    if (exp < eMin) eMin = exp;
    if (exp > eMax) eMax = exp;
  }
  if (!any) return { valid: true, D: 0, eMin: 0, words: new Uint32Array(WORDS_PER_TEST) };
  const D = eMax - eMin;
  if (D > D_MAX) return { valid: false, D, eMin, words: null };
  const words = new Uint32Array(WORDS_PER_TEST);
  for (let i = 0; i < 12; i++) {
    if (encZero[i]) continue;
    const base = i * WORDS_PER_COORD;
    const shift = encExp[i] - eMin;
    const ws = shift >>> 5;
    const bs = shift & 31;
    const mLo = encMantLo[i];
    const mHi = encMantHi[i];
    if (bs === 0) {
      words[base + ws] = mLo;
      words[base + ws + 1] = mHi;
    } else {
      words[base + ws] = (mLo << bs) >>> 0;
      words[base + ws + 1] = ((mHi << bs) | (mLo >>> (32 - bs))) >>> 0;
      const top = mHi >>> (32 - bs);
      if (top !== 0) {
        if (ws + 2 >= MAG_IN_LIMBS) throw new Error('encodeTestFast: top limb overflow');
        words[base + ws + 2] = top;
      }
    }
    words[base + MAG_IN_LIMBS] = encNeg[i];
  }
  return { valid: true, D, eMin, words };
}

// ---- adjacent-double (1 ulp) helpers, for the adversarial battery --------

/** Smallest representable double strictly greater than `x` (finite, non-NaN). */
export function nextUp(x) {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE; // smallest positive subnormal, for +0 and -0 alike
  f64view[0] = x;
  let bits = u64view[0];
  bits = x > 0 ? bits + 1n : bits - 1n;
  u64view[0] = bits;
  return f64view[0];
}

/** Largest representable double strictly less than `x` (finite, non-NaN). */
export function nextDown(x) {
  if (Number.isNaN(x) || x === -Infinity) return x;
  return -nextUp(-x);
}

// ---- mul32 ground truth, for the WGSL big-multiply primitive self-test ---

/** mul32Ref(a, b) -> { lo, hi } exact 64-bit product of two u32 operands,
 * split into two u32 halves. Ground truth for orient3d.wgsl's `mul32`. */
export function mul32Ref(a, b) {
  const p = BigInt(a >>> 0) * BigInt(b >>> 0);
  return { lo: Number(p & 0xffffffffn) >>> 0, hi: Number(p >> 32n) >>> 0 };
}
