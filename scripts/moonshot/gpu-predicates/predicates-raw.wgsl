// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// B2.5 (M6c follow-up) - raw-f64-bits GPU predicate kernels.
//
// Differences from the B1.3 spike kernel (orient3d.wgsl):
//
//  1. INPUT IS RAW IEEE-754 BITS. Each coordinate is uploaded as its two
//     u32 halves (lo word first, little-endian host assumed) with ZERO
//     CPU-side arithmetic - the caller just reinterprets its Float64Array
//     as a Uint32Array. The frexp-style decomposition, the per-test shared
//     exponent frame (eMin), the D_MAX gate, and the mantissa shift all
//     happen HERE, in integer WGSL. This removes the CPU encode step that
//     capped the B1.3 spike at 1.3-1.4x end-to-end.
//
//  2. THE D_MAX GATE IS GPU-SIDE. A lane whose test has NaN/Inf inputs or
//     exponent spread D > D_MAX writes the sentinel sign value 2
//     (FALLBACK) instead of a sign. Sentinel, never a wrong sign: the gate
//     is checked before any arithmetic runs. The caller scans the sign
//     buffer for 2s and reroutes those tests to the CPU exact path.
//
//  3. LENGTH-AWARE SCHOOLBOOK MULTIPLY. magMul first scans both operands
//     for their true limb length and only loops over that, instead of the
//     full fixed-width square. Typical real inputs (small per-test D) have
//     2-3 significant limbs after differencing, so this skips most of the
//     worst-case work. Lanes in a warp diverge only as far as their limb
//     lengths differ, which for magnitude-coherent batches is barely at
//     all. Correctness is unaffected: limbs beyond the scanned length are
//     exactly zero and contribute nothing to the product.
//
//  4. WORKING WIDTH IS 20 LIMBS (640 bits), shared by both predicates.
//     Width budget at D_MAX = 100 (magnitudes strictly below 2^k):
//       input coordinate     2^153   (53-bit mantissa << at most 100)
//       difference           2^154
//       orient3d 2x2 minor   2^309   (154+154, +1 for the subtract)
//       orient3d triple term 2^463 -> det < 2^465
//       incircle square      2^308
//       incircle lift        2^309   (sum of two squares)
//       incircle row term    2^618   (154 + 463+1, or 309 + 309)
//       incircle det         2^620   (three terms)
//     620 < 640, so truncating every product/sum to 20 limbs is exact for
//     any test that passed the D_MAX gate (same argument as DESIGN.md
//     section 5, re-run for the degree-4 incircle polynomial).
//
// Entry points:
//   mulVarSelfTest - length-aware 20-limb multiply vs BigInt (mod 2^640)
//   decodeSelfTest - GPU decode+frame+shift vs the CPU encoder's words
//   orient3dRaw    - full orient3d from raw f64 bits
//   incircleRaw    - full incircle from raw f64 bits

const WIDTH: u32 = 20u;          // 640-bit sign-magnitude working width
const ACC: u32 = 40u;            // schoolbook accumulator width (2x WIDTH)
const D_MAX_GATE: i32 = 100;     // same input-domain cap as the B1.3 spike
const FALLBACK: i32 = 2;         // sentinel sign: CPU fallback required
const O3D_WORDS_PER_TEST: u32 = 24u;   // 12 coords x 2 raw u32 halves
const IC_WORDS_PER_TEST: u32 = 16u;    // 8 coords x 2 raw u32 halves
const DEC_OUT_STRIDE: u32 = 74u;       // decodeSelfTest: valid + eMin + 12*(5 limbs + sign)

struct SV {
  mag: array<u32, 20>,
  neg: u32, // 0 = non-negative, 1 = negative (meaningless when mag is zero)
}

// ---- orient3d raw buffers --------------------------------------------------
@group(0) @binding(0) var<storage, read> o3dRaw: array<u32>;
@group(0) @binding(1) var<storage, read_write> o3dSigns: array<i32>;

// ---- incircle raw buffers --------------------------------------------------
@group(0) @binding(2) var<storage, read> icRaw: array<u32>;
@group(0) @binding(3) var<storage, read_write> icSigns: array<i32>;

// ---- length-aware-multiply self-test buffers -------------------------------
@group(0) @binding(4) var<storage, read> mulVarIn: array<u32>;   // [a(20), b(20)] per case
@group(0) @binding(5) var<storage, read_write> mulVarOut: array<u32>; // 20 limbs per case

// ---- decode self-test buffers ----------------------------------------------
@group(0) @binding(6) var<storage, read> decRaw: array<u32>;     // 24 raw u32 per test
@group(0) @binding(7) var<storage, read_write> decOut: array<u32>; // DEC_OUT_STRIDE per test

// ---- u32*u32->u64 primitive (identical to the B1.3 spike's, self-tested
// there against BigInt; re-exercised here transitively by every battery) ----
fn mul32(a: u32, b: u32) -> vec2<u32> {
  let a_lo = a & 0xffffu;
  let a_hi = a >> 16u;
  let b_lo = b & 0xffffu;
  let b_hi = b >> 16u;

  let p0 = a_lo * b_lo;
  let p1 = a_lo * b_hi;
  let p2 = a_hi * b_lo;
  let p3 = a_hi * b_hi;

  let p0_lo = p0 & 0xffffu;
  let p0_hi = p0 >> 16u;

  let mid = p0_hi + (p1 & 0xffffu) + (p2 & 0xffffu);
  let mid_lo = mid & 0xffffu;
  let mid_carry = mid >> 16u;

  let lo = (mid_lo << 16u) | p0_lo;
  let hi = p3 + (p1 >> 16u) + (p2 >> 16u) + mid_carry;

  return vec2<u32>(lo, hi);
}

// ---- fixed-width (WIDTH) unsigned magnitude helpers ------------------------

fn magIsZero(a: array<u32, 20>) -> bool {
  for (var i: u32 = 0u; i < WIDTH; i = i + 1u) {
    if (a[i] != 0u) {
      return false;
    }
  }
  return true;
}

// -1 / 0 / 1 as a < b / a == b / a > b
fn magCmp(a: array<u32, 20>, b: array<u32, 20>) -> i32 {
  var i: u32 = WIDTH;
  loop {
    if (i == 0u) {
      break;
    }
    i = i - 1u;
    if (a[i] != b[i]) {
      return select(-1, 1, a[i] > b[i]);
    }
  }
  return 0;
}

fn magAdd(a: array<u32, 20>, b: array<u32, 20>) -> array<u32, 20> {
  var out: array<u32, 20>;
  var carry: u32 = 0u;
  for (var i: u32 = 0u; i < WIDTH; i = i + 1u) {
    let s1 = a[i] + b[i];
    let c1 = select(0u, 1u, s1 < a[i]);
    let s2 = s1 + carry;
    let c2 = select(0u, 1u, s2 < s1);
    out[i] = s2;
    carry = select(0u, 1u, c1 != 0u || c2 != 0u);
  }
  // Final carry-out is discarded; the width budget above proves every true
  // sum is < 2^620 < 2^640 for gated inputs, so it is always zero.
  return out;
}

// Assumes a >= b (magnitude); caller must have checked via magCmp.
fn magSub(a: array<u32, 20>, b: array<u32, 20>) -> array<u32, 20> {
  var out: array<u32, 20>;
  var borrow: u32 = 0u;
  for (var i: u32 = 0u; i < WIDTH; i = i + 1u) {
    let ai = a[i];
    let bi = b[i];
    let d1 = ai - bi;
    let borrow1 = select(0u, 1u, ai < bi);
    let d2 = d1 - borrow;
    let borrow2 = select(0u, 1u, d1 < borrow);
    out[i] = d2;
    borrow = select(0u, 1u, borrow1 != 0u || borrow2 != 0u);
  }
  return out;
}

// Adds `value` into acc[pos], propagating carry upward as far as needed.
fn addCarryAt(acc: ptr<function, array<u32, 40>>, startPos: u32, value: u32) {
  var pos = startPos;
  var carry = value;
  loop {
    if (carry == 0u || pos >= ACC) {
      break;
    }
    let prev = (*acc)[pos];
    let sum = prev + carry;
    let overflowed = sum < prev;
    (*acc)[pos] = sum;
    carry = select(0u, 1u, overflowed);
    pos = pos + 1u;
  }
}

// Length-aware schoolbook multiply, truncated to the low WIDTH limbs.
// Scans both operands for their true significant length first and only
// loops over that. Truncation is exact for gated inputs (width budget).
fn magMul(a: array<u32, 20>, b: array<u32, 20>) -> array<u32, 20> {
  var acc: array<u32, 40>; // zero-initialized per WGSL default-value rule
  var la: u32 = WIDTH;
  loop {
    if (la == 0u) { break; }
    if (a[la - 1u] != 0u) { break; }
    la = la - 1u;
  }
  var lb: u32 = WIDTH;
  loop {
    if (lb == 0u) { break; }
    if (b[lb - 1u] != 0u) { break; }
    lb = lb - 1u;
  }
  for (var i: u32 = 0u; i < la; i = i + 1u) {
    if (a[i] == 0u) {
      continue;
    }
    for (var j: u32 = 0u; j < lb; j = j + 1u) {
      if (b[j] == 0u) {
        continue;
      }
      let prod = mul32(a[i], b[j]);
      let k = i + j;
      addCarryAt(&acc, k, prod.x);
      addCarryAt(&acc, k + 1u, prod.y);
    }
  }
  var out: array<u32, 20>;
  for (var i: u32 = 0u; i < WIDTH; i = i + 1u) {
    out[i] = acc[i];
  }
  return out;
}

// ---- signed (sign-magnitude) helpers ---------------------------------------

fn sIsZero(x: SV) -> bool {
  return magIsZero(x.mag);
}

fn sNeg(x: SV) -> SV {
  var r: SV;
  r.mag = x.mag;
  r.neg = select(1u, 0u, x.neg != 0u);
  return r;
}

fn sAdd(x: SV, y: SV) -> SV {
  var r: SV;
  if (x.neg == y.neg) {
    r.mag = magAdd(x.mag, y.mag);
    r.neg = select(x.neg, 0u, magIsZero(r.mag));
    return r;
  }
  let c = magCmp(x.mag, y.mag);
  if (c == 0) {
    for (var i: u32 = 0u; i < WIDTH; i = i + 1u) {
      r.mag[i] = 0u;
    }
    r.neg = 0u;
    return r;
  } else if (c > 0) {
    r.mag = magSub(x.mag, y.mag);
    r.neg = x.neg;
  } else {
    r.mag = magSub(y.mag, x.mag);
    r.neg = y.neg;
  }
  return r;
}

fn sSub(x: SV, y: SV) -> SV {
  return sAdd(x, sNeg(y));
}

fn sMul(x: SV, y: SV) -> SV {
  var r: SV;
  r.mag = magMul(x.mag, y.mag);
  let isZero = magIsZero(r.mag);
  r.neg = select(select(0u, 1u, x.neg != y.neg), 0u, isZero);
  return r;
}

// ---- IEEE-754 decode (GPU-side; this is what B1.3 did on the CPU) ---------

struct CoordDec {
  mantLo: u32,   // low 32 mantissa bits
  mantHi: u32,   // high 21 mantissa bits (implicit bit restored for normals)
  exp: i32,      // power-of-two exponent: value = mant * 2^exp
  neg: u32,
  zero: u32,     // 1 = exact zero (either sign)
  invalid: u32,  // 1 = NaN or Infinity
}

fn decodeCoord(lo: u32, hi: u32) -> CoordDec {
  var r: CoordDec;
  let be = (hi >> 20u) & 0x7ffu;
  let mHi = hi & 0xfffffu;
  r.mantLo = lo;
  r.neg = hi >> 31u;
  r.zero = 0u;
  r.invalid = 0u;
  if (be == 0x7ffu) {
    r.invalid = 1u;
    r.mantHi = 0u;
    r.exp = 0;
    return r;
  }
  if (be == 0u) {
    if (mHi == 0u && lo == 0u) {
      r.zero = 1u;
      r.neg = 0u; // -0 normalizes to +0, matching the CPU encoder
      r.mantHi = 0u;
      r.exp = 0;
      return r;
    }
    r.exp = -1074; // subnormal: no implicit bit
    r.mantHi = mHi;
  } else {
    r.mantHi = mHi | 0x100000u;
    r.exp = i32(be) - 1075;
  }
  return r;
}

// Shift the 53-bit mantissa left by (exp - eMin) into a WIDTH-limb value.
// shift <= D_MAX_GATE = 100, so word shift <= 3 and the top partial limb
// lands at index <= 5 - always inside the array; no masking games needed.
// NB: WGSL masks shift amounts mod 32, so the bs == 0 case must not be
// expressed as `x >> (32 - 0)` (that would be `x >> 0` = x, not 0); the
// explicit branch below avoids the masked-shift trap.
fn shiftedVal(d: CoordDec, eMin: i32) -> SV {
  var r: SV; // mag zero-initialized
  r.neg = 0u;
  if (d.zero != 0u) {
    return r;
  }
  r.neg = d.neg;
  let shift = u32(d.exp - eMin);
  let ws = shift >> 5u;
  let bs = shift & 31u;
  if (bs == 0u) {
    r.mag[ws] = d.mantLo;
    r.mag[ws + 1u] = d.mantHi;
  } else {
    r.mag[ws] = d.mantLo << bs;
    r.mag[ws + 1u] = (d.mantHi << bs) | (d.mantLo >> (32u - bs));
    r.mag[ws + 2u] = d.mantHi >> (32u - bs);
  }
  return r;
}

// ---- entry point: orient3d from raw f64 bits -------------------------------
//
// Same determinant as the B1.3 kernel and reference.mjs::orient3dSignBigInt:
//   r0 = a-d, r1 = b-d, r2 = c-d
//   det = r0.x*(r1.y*r2.z - r1.z*r2.y)
//       - r0.y*(r1.x*r2.z - r1.z*r2.x)
//       + r0.z*(r1.x*r2.y - r1.y*r2.x)
@compute @workgroup_size(64)
fn orient3dRaw(@builtin(global_invocation_id) gid: vec3<u32>) {
  let numTests = arrayLength(&o3dSigns);
  let idx = gid.x;
  if (idx >= numTests) {
    return;
  }
  let base = idx * O3D_WORDS_PER_TEST;

  var decs: array<CoordDec, 12>;
  var eMin: i32 = 2147483647;
  var eMax: i32 = -2147483648;
  var any = false;
  var invalid = false;
  for (var i: u32 = 0u; i < 12u; i = i + 1u) {
    let d = decodeCoord(o3dRaw[base + i * 2u], o3dRaw[base + i * 2u + 1u]);
    decs[i] = d;
    if (d.invalid != 0u) {
      invalid = true;
    } else if (d.zero == 0u) {
      any = true;
      eMin = min(eMin, d.exp);
      eMax = max(eMax, d.exp);
    }
  }
  if (invalid) {
    o3dSigns[idx] = FALLBACK;
    return;
  }
  if (!any) {
    o3dSigns[idx] = 0;
    return;
  }
  if (eMax - eMin > D_MAX_GATE) {
    o3dSigns[idx] = FALLBACK;
    return;
  }

  let ax = shiftedVal(decs[0], eMin);
  let ay = shiftedVal(decs[1], eMin);
  let az = shiftedVal(decs[2], eMin);
  let bx = shiftedVal(decs[3], eMin);
  let by = shiftedVal(decs[4], eMin);
  let bz = shiftedVal(decs[5], eMin);
  let cx = shiftedVal(decs[6], eMin);
  let cy = shiftedVal(decs[7], eMin);
  let cz = shiftedVal(decs[8], eMin);
  let dx = shiftedVal(decs[9], eMin);
  let dy = shiftedVal(decs[10], eMin);
  let dz = shiftedVal(decs[11], eMin);

  let r0x = sSub(ax, dx);
  let r0y = sSub(ay, dy);
  let r0z = sSub(az, dz);
  let r1x = sSub(bx, dx);
  let r1y = sSub(by, dy);
  let r1z = sSub(bz, dz);
  let r2x = sSub(cx, dx);
  let r2y = sSub(cy, dy);
  let r2z = sSub(cz, dz);

  let m0 = sSub(sMul(r1y, r2z), sMul(r1z, r2y));
  let m1 = sSub(sMul(r1x, r2z), sMul(r1z, r2x));
  let m2 = sSub(sMul(r1x, r2y), sMul(r1y, r2x));

  let t0 = sMul(r0x, m0);
  let t1 = sMul(r0y, m1);
  let t2 = sMul(r0z, m2);

  let det = sAdd(sSub(t0, t1), t2);

  var sign: i32 = 0;
  if (!sIsZero(det)) {
    sign = select(1, -1, det.neg != 0u);
  }
  o3dSigns[idx] = sign;
}

// ---- entry point: incircle from raw f64 bits -------------------------------
//
// Matches reference.mjs::incircleSignBigInt:
//   adx = ax-dx, ... ; alift = adx^2 + ady^2, ...
//   det = adx*(bdy*clift - blift*cdy)
//       - ady*(bdx*clift - blift*cdx)
//       + alift*(bdx*cdy - bdy*cdx)
@compute @workgroup_size(64)
fn incircleRaw(@builtin(global_invocation_id) gid: vec3<u32>) {
  let numTests = arrayLength(&icSigns);
  let idx = gid.x;
  if (idx >= numTests) {
    return;
  }
  let base = idx * IC_WORDS_PER_TEST;

  var decs: array<CoordDec, 8>;
  var eMin: i32 = 2147483647;
  var eMax: i32 = -2147483648;
  var any = false;
  var invalid = false;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let d = decodeCoord(icRaw[base + i * 2u], icRaw[base + i * 2u + 1u]);
    decs[i] = d;
    if (d.invalid != 0u) {
      invalid = true;
    } else if (d.zero == 0u) {
      any = true;
      eMin = min(eMin, d.exp);
      eMax = max(eMax, d.exp);
    }
  }
  if (invalid) {
    icSigns[idx] = FALLBACK;
    return;
  }
  if (!any) {
    icSigns[idx] = 0;
    return;
  }
  if (eMax - eMin > D_MAX_GATE) {
    icSigns[idx] = FALLBACK;
    return;
  }

  let ax = shiftedVal(decs[0], eMin);
  let ay = shiftedVal(decs[1], eMin);
  let bx = shiftedVal(decs[2], eMin);
  let by = shiftedVal(decs[3], eMin);
  let cx = shiftedVal(decs[4], eMin);
  let cy = shiftedVal(decs[5], eMin);
  let dx = shiftedVal(decs[6], eMin);
  let dy = shiftedVal(decs[7], eMin);

  let adx = sSub(ax, dx);
  let ady = sSub(ay, dy);
  let bdx = sSub(bx, dx);
  let bdy = sSub(by, dy);
  let cdx = sSub(cx, dx);
  let cdy = sSub(cy, dy);

  let alift = sAdd(sMul(adx, adx), sMul(ady, ady));
  let blift = sAdd(sMul(bdx, bdx), sMul(bdy, bdy));
  let clift = sAdd(sMul(cdx, cdx), sMul(cdy, cdy));

  let t0 = sMul(adx, sSub(sMul(bdy, clift), sMul(blift, cdy)));
  let t1 = sMul(ady, sSub(sMul(bdx, clift), sMul(blift, cdx)));
  let t2 = sMul(alift, sSub(sMul(bdx, cdy), sMul(bdy, cdx)));

  let det = sAdd(sSub(t0, t1), t2);

  var sign: i32 = 0;
  if (!sIsZero(det)) {
    sign = select(1, -1, det.neg != 0u);
  }
  icSigns[idx] = sign;
}

// ---- entry point: length-aware multiply self-test --------------------------
@compute @workgroup_size(64)
fn mulVarSelfTest(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = arrayLength(&mulVarOut) / WIDTH;
  let idx = gid.x;
  if (idx >= n) {
    return;
  }
  var a: array<u32, 20>;
  var b: array<u32, 20>;
  let inBase = idx * (WIDTH * 2u);
  for (var i: u32 = 0u; i < WIDTH; i = i + 1u) {
    a[i] = mulVarIn[inBase + i];
    b[i] = mulVarIn[inBase + WIDTH + i];
  }
  let r = magMul(a, b);
  let outBase = idx * WIDTH;
  for (var i: u32 = 0u; i < WIDTH; i = i + 1u) {
    mulVarOut[outBase + i] = r[i];
  }
}

// ---- entry point: decode self-test -----------------------------------------
//
// For each 12-coordinate test given as raw f64 bits, reproduces exactly what
// the CPU encoder (reference.mjs::encodeTest) produces: the valid flag, eMin,
// and per-coordinate 5-limb shifted magnitude + sign flag. The harness
// compares word-for-word. This isolates the decode/frame/shift stage from
// the big-integer arithmetic stage.
@compute @workgroup_size(64)
fn decodeSelfTest(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = arrayLength(&decOut) / DEC_OUT_STRIDE;
  let idx = gid.x;
  if (idx >= n) {
    return;
  }
  let base = idx * 24u;
  let outBase = idx * DEC_OUT_STRIDE;

  var decs: array<CoordDec, 12>;
  var eMin: i32 = 2147483647;
  var eMax: i32 = -2147483648;
  var any = false;
  var invalid = false;
  for (var i: u32 = 0u; i < 12u; i = i + 1u) {
    let d = decodeCoord(decRaw[base + i * 2u], decRaw[base + i * 2u + 1u]);
    decs[i] = d;
    if (d.invalid != 0u) {
      invalid = true;
    } else if (d.zero == 0u) {
      any = true;
      eMin = min(eMin, d.exp);
      eMax = max(eMax, d.exp);
    }
  }
  if (!any) {
    eMin = 0;
    eMax = 0;
  }
  if (invalid || eMax - eMin > D_MAX_GATE) {
    decOut[outBase] = 0u; // invalid: rest of the record is not compared
    return;
  }
  decOut[outBase] = 1u;
  decOut[outBase + 1u] = bitcast<u32>(eMin);
  for (var i: u32 = 0u; i < 12u; i = i + 1u) {
    let v = shiftedVal(decs[i], eMin);
    let cBase = outBase + 2u + i * 6u;
    for (var j: u32 = 0u; j < 5u; j = j + 1u) {
      decOut[cBase + j] = v.mag[j];
    }
    decOut[cBase + 5u] = v.neg;
  }
}
