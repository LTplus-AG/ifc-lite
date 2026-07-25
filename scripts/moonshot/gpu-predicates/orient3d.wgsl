// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// B1.3 spike (M6c) — exact orient3d sign on WebGPU via multi-limb
// sign-magnitude integer arithmetic. See DESIGN.md for the exactness
// argument and the width-budget proof this file's constants come from.
//
// Inputs are pre-shifted onto a shared per-test exponent frame on the CPU
// (reference.mjs::encodeTest) — this shader never sees a floating-point
// value and never performs a rounding operation anywhere.
//
// Three entry points, in increasing order of what they trust:
//   mulSelfTest    - the u32*u32->u64 primitive alone (`mul32`)
//   magMulSelfTest - the 16-limb (512-bit) schoolbook multiply alone
//   main           - the full orient3d pipeline
// The harness runs all three against a JS BigInt oracle before trusting
// the large battery on `main`.

const WORK_LIMBS: u32 = 16u;       // 512-bit sign-magnitude working width
const MAG_IN_LIMBS: u32 = 5u;      // 160-bit input coordinate storage (>= 153-bit worst case)
const WORDS_PER_COORD: u32 = 6u;   // 5 magnitude limbs + 1 sign flag
const WORDS_PER_TEST: u32 = 72u;   // 6 words * 12 coordinates

struct SVal {
  mag: array<u32, 16>,
  neg: u32, // 0 = non-negative, 1 = negative (meaningless when mag is all-zero)
}

// ---- orient3d test buffers -------------------------------------------------
@group(0) @binding(0) var<storage, read> inputWords: array<u32>;
@group(0) @binding(1) var<storage, read_write> outSigns: array<i32>;

// ---- mul32 primitive self-test buffers ------------------------------------
@group(0) @binding(2) var<storage, read> mulTestPairs: array<u32>;   // [a0,b0,a1,b1,...]
@group(0) @binding(3) var<storage, read_write> mulTestOut: array<u32>; // [lo0,hi0,lo1,hi1,...]

// ---- 512-bit schoolbook-multiply self-test buffers ------------------------
@group(0) @binding(4) var<storage, read> magMulIn: array<u32>;   // [a(16 limbs), b(16 limbs)] per case
@group(0) @binding(5) var<storage, read_write> magMulOut: array<u32>; // 16 limbs per case

// ---- u32*u32->u64, split via 16-bit halves (no native u64 in WGSL) --------
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

// ---- fixed-width (WORK_LIMBS) unsigned magnitude helpers ------------------

fn magIsZero(a: array<u32, 16>) -> bool {
  for (var i: u32 = 0u; i < WORK_LIMBS; i = i + 1u) {
    if (a[i] != 0u) {
      return false;
    }
  }
  return true;
}

// -1 / 0 / 1 as a < b / a == b / a > b
fn magCmp(a: array<u32, 16>, b: array<u32, 16>) -> i32 {
  var i: u32 = WORK_LIMBS;
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

fn magAdd(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
  var out: array<u32, 16>;
  var carry: u32 = 0u;
  for (var i: u32 = 0u; i < WORK_LIMBS; i = i + 1u) {
    let s1 = a[i] + b[i];
    let c1 = select(0u, 1u, s1 < a[i]);
    let s2 = s1 + carry;
    let c2 = select(0u, 1u, s2 < s1);
    out[i] = s2;
    carry = select(0u, 1u, c1 != 0u || c2 != 0u);
  }
  // Final carry-out at limb WORK_LIMBS is discarded: DESIGN.md's width-budget
  // proof (section 5) bounds every true sum this shader computes to <= 465
  // bits, strictly under the 512-bit container, so a real, non-truncating
  // carry never reaches here for any test that passed the D_MAX gate.
  return out;
}

// Assumes a >= b (magnitude); caller must have checked via magCmp.
fn magSub(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
  var out: array<u32, 16>;
  var borrow: u32 = 0u;
  for (var i: u32 = 0u; i < WORK_LIMBS; i = i + 1u) {
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

// Adds `value` into acc[pos], propagating carry upward through as many
// limbs as needed. Standard bignum multiply-accumulate primitive.
fn addCarryAt(acc: ptr<function, array<u32, 32>>, startPos: u32, value: u32) {
  var pos = startPos;
  var carry = value;
  loop {
    if (carry == 0u || pos >= 32u) {
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

// 16x16-limb (512x512-bit) unsigned schoolbook multiply, truncated to the
// low 16 limbs. Truncation is exact (not an approximation) for any pair of
// operands produced by this shader's own D_MAX-gated pipeline: DESIGN.md
// section 5 proves the true product never exceeds 512 bits at any stage.
fn magMul(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
  var acc: array<u32, 32>; // zero-initialized per WGSL's default-value rule
  for (var i: u32 = 0u; i < WORK_LIMBS; i = i + 1u) {
    if (a[i] == 0u) {
      continue;
    }
    for (var j: u32 = 0u; j < WORK_LIMBS; j = j + 1u) {
      if (b[j] == 0u) {
        continue;
      }
      let prod = mul32(a[i], b[j]);
      let k = i + j;
      addCarryAt(&acc, k, prod.x);
      if (k + 1u < 32u) {
        addCarryAt(&acc, k + 1u, prod.y);
      }
    }
  }
  var out: array<u32, 16>;
  for (var i: u32 = 0u; i < WORK_LIMBS; i = i + 1u) {
    out[i] = acc[i];
  }
  return out;
}

// ---- signed (sign-magnitude) helpers --------------------------------------

fn sIsZero(x: SVal) -> bool {
  return magIsZero(x.mag);
}

fn sNeg(x: SVal) -> SVal {
  var r: SVal;
  r.mag = x.mag;
  r.neg = select(1u, 0u, x.neg != 0u);
  return r;
}

fn sAdd(x: SVal, y: SVal) -> SVal {
  var r: SVal;
  if (x.neg == y.neg) {
    r.mag = magAdd(x.mag, y.mag);
    r.neg = select(x.neg, 0u, magIsZero(r.mag));
    return r;
  }
  let c = magCmp(x.mag, y.mag);
  if (c == 0) {
    for (var i: u32 = 0u; i < WORK_LIMBS; i = i + 1u) {
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

fn sSub(x: SVal, y: SVal) -> SVal {
  return sAdd(x, sNeg(y));
}

fn sMul(x: SVal, y: SVal) -> SVal {
  var r: SVal;
  r.mag = magMul(x.mag, y.mag);
  let isZero = magIsZero(r.mag);
  r.neg = select(select(0u, 1u, x.neg != y.neg), 0u, isZero);
  return r;
}

// ---- load a shifted input coordinate (5 magnitude limbs + sign flag) -----

fn loadCoord(base: u32) -> SVal {
  var r: SVal;
  for (var i: u32 = 0u; i < WORK_LIMBS; i = i + 1u) {
    r.mag[i] = 0u;
  }
  for (var i: u32 = 0u; i < MAG_IN_LIMBS; i = i + 1u) {
    r.mag[i] = inputWords[base + i];
  }
  r.neg = inputWords[base + MAG_IN_LIMBS];
  return r;
}

// ---- entry point: the real predicate --------------------------------------
//
// orient3d(a,b,c,d) sign, matching reference.mjs::orient3dSignBigInt exactly:
//   r0 = a-d, r1 = b-d, r2 = c-d
//   m0 = r1.y*r2.z - r1.z*r2.y
//   m1 = r1.x*r2.z - r1.z*r2.x
//   m2 = r1.x*r2.y - r1.y*r2.x
//   det = r0.x*m0 - r0.y*m1 + r0.z*m2
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let numTests = arrayLength(&outSigns);
  let idx = gid.x;
  if (idx >= numTests) {
    return;
  }
  let testBase = idx * WORDS_PER_TEST;

  let ax = loadCoord(testBase + 0u * WORDS_PER_COORD);
  let ay = loadCoord(testBase + 1u * WORDS_PER_COORD);
  let az = loadCoord(testBase + 2u * WORDS_PER_COORD);
  let bx = loadCoord(testBase + 3u * WORDS_PER_COORD);
  let by = loadCoord(testBase + 4u * WORDS_PER_COORD);
  let bz = loadCoord(testBase + 5u * WORDS_PER_COORD);
  let cx = loadCoord(testBase + 6u * WORDS_PER_COORD);
  let cy = loadCoord(testBase + 7u * WORDS_PER_COORD);
  let cz = loadCoord(testBase + 8u * WORDS_PER_COORD);
  let dx = loadCoord(testBase + 9u * WORDS_PER_COORD);
  let dy = loadCoord(testBase + 10u * WORDS_PER_COORD);
  let dz = loadCoord(testBase + 11u * WORDS_PER_COORD);

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
  outSigns[idx] = sign;
}

// ---- entry point: mul32 primitive self-test -------------------------------
@compute @workgroup_size(64)
fn mulSelfTest(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = arrayLength(&mulTestOut) / 2u;
  let idx = gid.x;
  if (idx >= n) {
    return;
  }
  let a = mulTestPairs[idx * 2u + 0u];
  let b = mulTestPairs[idx * 2u + 1u];
  let r = mul32(a, b);
  mulTestOut[idx * 2u + 0u] = r.x;
  mulTestOut[idx * 2u + 1u] = r.y;
}

// ---- entry point: 512-bit schoolbook multiply self-test -------------------
@compute @workgroup_size(64)
fn magMulSelfTest(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = arrayLength(&magMulOut) / WORK_LIMBS;
  let idx = gid.x;
  if (idx >= n) {
    return;
  }
  var a: array<u32, 16>;
  var b: array<u32, 16>;
  let inBase = idx * (WORK_LIMBS * 2u);
  for (var i: u32 = 0u; i < WORK_LIMBS; i = i + 1u) {
    a[i] = magMulIn[inBase + i];
    b[i] = magMulIn[inBase + WORK_LIMBS + i];
  }
  let r = magMul(a, b);
  let outBase = idx * WORK_LIMBS;
  for (var i: u32 = 0u; i < WORK_LIMBS; i = i + 1u) {
    magMulOut[outBase + i] = r[i];
  }
}
