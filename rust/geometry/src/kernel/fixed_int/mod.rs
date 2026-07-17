// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `FixedInt<const K: usize>` — a register-resident fixed-width signed big
//! integer used as the arithmetic backing of the exact predicate tier
//! (`kernel/fixed.rs`).
//!
//! ## Why a local newtype instead of `bnum`
//! The fixed-width predicate cascade (`fixed_impl!`) is the FAST exact tier
//! between the interval filter and the BigRational fallback; every LPI/TPI
//! lambda and determinant runs its inner limb math here. `bnum` 0.14 backs its
//! `Integer` with a `[u8; N]` byte array, so the hot add / sub / mul / neg on
//! the narrow widths pay byte-granular work. `FixedInt` stores `[u64; K]`
//! little-endian two's-complement limbs and hand-rolls the HOT ops as native
//! 64-bit limb arithmetic (carry chains, a conservative-precheck schoolbook
//! multiply, i64/i128 conversions, sign tests) so they stay in registers.
//!
//! ## Correctness contract (this is the whole game)
//! Every operation the cascade relies on is **bit-identical** to the `bnum`
//! type it replaces:
//! - HOT ops are native but validated by an exhaustive differential fuzz
//!   (`mod tests`) against `bnum` across all four widths (K = 4, 8, 16, 32),
//!   every boundary value, and a deterministic LCG stream. `checked_mul` in
//!   particular must agree with `bnum` on BOTH the value AND the `Some`/`None`
//!   overflow verdict — a truncated product escaping as `Some` would silently
//!   flip a predicate sign and corrupt CSG, so its precheck is deliberately
//!   CONSERVATIVE (fast-accept only when the product provably fits, fast-reject
//!   only when it provably overflows, exact wide check in the ambiguous band).
//! - COLD ops (`Div`, `Rem`, `to_f64`, `from_str_radix`) delegate to `bnum`
//!   through a little-endian two's-complement byte round-trip. `FixedInt<K>`'s
//!   `K` u64 limbs are exactly `K*8` bytes, and `bnum::types::I{K*64}` stores
//!   `K*8` bytes in the same little-endian two's-complement layout, so
//!   `to_le_bytes`/`from_le_slice` is a lossless reinterpretation.
//!
//! The newtype is invisible to `fixed.rs`: the `fixed_impl!` macro names the
//! width only through its `$T` type argument (`FixedInt<4/8/16/32>`), so no
//! caller and no macro-body line changes.

use core::cmp::Ordering;
use core::ops::{Add, Div, Mul, Neg, Rem, Sub};
use num_traits::{
    CheckedAdd, CheckedMul, CheckedSub, FromPrimitive, Num, One, Signed, ToPrimitive, Zero,
};

mod mul;
use mul::{mul_full, mul_low};

/// Little-endian, two's-complement fixed-width signed integer with `K` u64
/// limbs (`self.0[0]` is the least-significant limb; the sign bit is bit 63 of
/// `self.0[K-1]`). Instantiated at K ∈ {4, 8, 16, 32} = I256/I512/I1024/I2048.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FixedInt<const K: usize>([u64; K]);

// ── Inherent surface ────────────────────────────────────────────────────────
// `is_zero` / `is_one` / `is_negative` / `is_positive` are provided as INHERENT
// methods (not only via the `Zero`/`One`/`Signed` traits) because `bnum`
// exposes them inherently and `fixed.rs` calls e.g. `x.is_zero()` /
// `d.is_negative()` in scopes that import `Signed` but not `Zero`, or import no
// predicate trait at all (`lambda1024`). Inherent methods take resolution
// priority over trait methods, so these satisfy the macro calls and never
// conflict with the trait impls below (which carry identical semantics).
impl<const K: usize> FixedInt<K> {
    /// Construct directly from little-endian limbs (test-only constructor).
    #[cfg(test)]
    #[inline]
    pub(crate) const fn from_limbs(limbs: [u64; K]) -> Self {
        FixedInt(limbs)
    }

    #[inline]
    pub fn is_zero(&self) -> bool {
        self.0.iter().all(|&l| l == 0)
    }

    #[inline]
    pub fn is_one(&self) -> bool {
        self.0[0] == 1 && self.0[1..].iter().all(|&l| l == 0)
    }

    /// Sign test. Takes `self` by value (mirroring `bnum`'s inherent
    /// `Int::is_negative(self)`): a call on a `&FixedInt` receiver — as in the
    /// `fixed_impl!` macro's `sign_of` — then binds the `Signed` *trait* method
    /// instead, keeping the macro's `use num_traits::Signed` genuinely used,
    /// while calls on an owned value (`lambda1024`) bind this inherent one.
    #[inline]
    pub fn is_negative(self) -> bool {
        self.0[K - 1] >> 63 == 1
    }
}

// ── Native limb helpers (the hot path) ──────────────────────────────────────

#[inline]
fn is_neg<const K: usize>(a: &[u64; K]) -> bool {
    a[K - 1] >> 63 == 1
}

/// Two's-complement negation of the limb array (`!a + 1`). Wraps on `MIN`
/// exactly like `bnum`'s `wrapping_neg`.
#[inline]
fn negate<const K: usize>(a: &[u64; K]) -> [u64; K] {
    let mut out = [0u64; K];
    let mut carry = 1u64;
    for i in 0..K {
        let (v, c) = (!a[i]).overflowing_add(carry);
        out[i] = v;
        carry = c as u64;
    }
    out
}

/// Bit length of an UNSIGNED magnitude limb array (0 for all-zero).
#[inline]
fn bit_length<const K: usize>(a: &[u64; K]) -> usize {
    for i in (0..K).rev() {
        if a[i] != 0 {
            return i * 64 + (64 - a[i].leading_zeros() as usize);
        }
    }
    0
}

/// `(|a|, a<0)`. For `a == MIN`, `negate` returns the `MIN` bit pattern which
/// reads as the correct unsigned magnitude `2^(K*64-1)`.
#[inline]
fn magnitude<const K: usize>(a: &FixedInt<K>) -> ([u64; K], bool) {
    if is_neg(&a.0) {
        (negate(&a.0), true)
    } else {
        (a.0, false)
    }
}


/// Wrapping two's-complement limb addition (drops the final carry). Kept a free
/// function so the carry-combine `|` stays out of the `Add` trait impl, where
/// clippy's `suspicious_arithmetic_impl` would (wrongly) flag it.
#[inline]
fn wrapping_add<const K: usize>(a: &[u64; K], b: &[u64; K]) -> [u64; K] {
    let mut out = [0u64; K];
    let mut carry = 0u64;
    for i in 0..K {
        let (s1, c1) = a[i].overflowing_add(b[i]);
        let (s2, c2) = s1.overflowing_add(carry);
        out[i] = s2;
        // At most one of c1, c2 can be set, so `|` == the true 0/1 carry.
        carry = (c1 as u64) | (c2 as u64);
    }
    out
}

/// Wrapping two's-complement limb subtraction (drops the final borrow).
#[inline]
fn wrapping_sub<const K: usize>(a: &[u64; K], b: &[u64; K]) -> [u64; K] {
    let mut out = [0u64; K];
    let mut borrow = 0u64;
    for i in 0..K {
        let (d1, b1) = a[i].overflowing_sub(b[i]);
        let (d2, b2) = d1.overflowing_sub(borrow);
        out[i] = d2;
        borrow = (b1 as u64) | (b2 as u64);
    }
    out
}

/// Native two's-complement addition with signed-overflow detection.
#[inline]
fn checked_add_limbs<const K: usize>(a: &FixedInt<K>, b: &FixedInt<K>) -> Option<FixedInt<K>> {
    let out = wrapping_add(&a.0, &b.0);
    let sa = a.0[K - 1] >> 63;
    let sb = b.0[K - 1] >> 63;
    let sr = out[K - 1] >> 63;
    // Overflow iff the operands share a sign and the result flips it.
    if sa == sb && sr != sa {
        None
    } else {
        Some(FixedInt(out))
    }
}

/// Native two's-complement subtraction with signed-overflow detection.
#[inline]
fn checked_sub_limbs<const K: usize>(a: &FixedInt<K>, b: &FixedInt<K>) -> Option<FixedInt<K>> {
    let out = wrapping_sub(&a.0, &b.0);
    let sa = a.0[K - 1] >> 63;
    let sb = b.0[K - 1] >> 63;
    let sr = out[K - 1] >> 63;
    // Overflow iff the operands differ in sign and the result flips the minuend.
    if sa != sb && sr != sa {
        None
    } else {
        Some(FixedInt(out))
    }
}

/// Native checked multiply with a CONSERVATIVE bit-length precheck.
///
/// The signed range of a K-limb value is `[-2^(w-1), 2^(w-1)-1]` with
/// `w = K*64`. Let `la = bitlen(|a|)`, `lb = bitlen(|b|)`.
/// - `la + lb <= w-1` ⇒ `|a*b| < 2^(w-1)` ⇒ fits both signs ⇒ fast low-K product.
/// - `la + lb >= w+2` ⇒ `|a*b| >= 2^w > 2^(w-1)` ⇒ overflows both signs ⇒ `None`.
/// - `la + lb ∈ {w, w+1}` (ambiguous, straddles `MIN`): compute the full 2K-limb
///   two's-complement product and narrow it exactly (fits iff the high K limbs
///   are the sign extension of limb `K-1`, which correctly admits exactly `MIN`).
///
/// Both prechecks are one-sided/conservative, so a wrong `Some` is impossible;
/// the differential fuzz pins agreement with `bnum` on value and verdict.
#[inline]
fn checked_mul_limbs<const K: usize>(a: &FixedInt<K>, b: &FixedInt<K>) -> Option<FixedInt<K>> {
    let (ma, sa) = magnitude(a);
    let (mb, sb) = magnitude(b);
    let la = bit_length(&ma);
    let lb = bit_length(&mb);
    if la == 0 || lb == 0 {
        return Some(FixedInt([0u64; K]));
    }
    let neg = sa ^ sb;
    let w = K * 64;

    if la + lb <= w - 1 {
        // Fast-accept: provably fits.
        let lo = mul_low(&ma, &mb);
        let out = if neg { negate(&lo) } else { lo };
        return Some(FixedInt(out));
    }
    if la + lb >= w + 2 {
        // Fast-reject: provably overflows.
        return None;
    }

    // Ambiguous band: full 2K-limb magnitude product, then exact narrowing.
    debug_assert!(K <= 32, "FixedInt checked_mul scratch supports only K <= 32");
    let n2 = 2 * K;
    let mut full = [0u64; 64];
    mul_full(&ma, &mb, &mut full);
    if neg {
        // Two's-complement negate over the low n2 limbs in place.
        let mut c = 1u64;
        for slot in full.iter_mut().take(n2) {
            let (v, cc) = (!*slot).overflowing_add(c);
            *slot = v;
            c = cc as u64;
        }
    }
    // Fits in K limbs iff the upper half is the sign extension of the low half.
    let ext = if full[K - 1] >> 63 == 1 { u64::MAX } else { 0 };
    for &limb in &full[K..n2] {
        if limb != ext {
            return None;
        }
    }
    let mut out = [0u64; K];
    out.copy_from_slice(&full[..K]);
    Some(FixedInt(out))
}

// ── bnum byte-bridge (the cold path) ────────────────────────────────────────

/// Parse error placeholder for [`Num::from_str_radix`]; the predicate cascade
/// never calls it, the impl exists only to satisfy the `Num` trait bound.
#[derive(Debug, PartialEq, Eq)]
pub struct ParseFixedIntError;

/// Serialize the limbs into a fixed 256-byte little-endian scratch buffer
/// (32 limbs = the widest supported width, I2048). Only the first `K*8` bytes
/// are meaningful.
#[inline]
fn to_le_scratch<const K: usize>(x: &FixedInt<K>) -> [u8; 256] {
    debug_assert!(K <= 32, "FixedInt bnum bridge supports only K <= 32");
    let mut buf = [0u8; 256];
    for i in 0..K {
        buf[i * 8..i * 8 + 8].copy_from_slice(&x.0[i].to_le_bytes());
    }
    buf
}

/// Rebuild a `FixedInt<K>` from the first `K*8` little-endian bytes of `buf`.
#[inline]
fn from_le_scratch<const K: usize>(buf: &[u8]) -> FixedInt<K> {
    let mut limbs = [0u64; K];
    for i in 0..K {
        let mut b = [0u8; 8];
        b.copy_from_slice(&buf[i * 8..i * 8 + 8]);
        limbs[i] = u64::from_le_bytes(b);
    }
    FixedInt(limbs)
}

/// Dispatch a binary op on the `bnum` signed type matching the width `K`,
/// round-tripping both operands and the result through little-endian bytes.
/// The `from_le_slice`/`to_le_bytes` layout is bit-identical to `FixedInt`, so
/// the round-trip is lossless; the `unwrap` cannot fail because every canonical
/// `K*8`-byte value is representable in `I{K*64}` (byte-aligned width, no pad).
macro_rules! bnum_binary {
    ($K:expr, $ab:expr, $bb:expr, |$x:ident, $y:ident| $op:expr) => {{
        let nb = $K * 8;
        match $K {
            4 => {
                let $x = bnum::types::I256::from_le_slice(&$ab[..nb]).unwrap();
                let $y = bnum::types::I256::from_le_slice(&$bb[..nb]).unwrap();
                from_le_scratch::<$K>(&($op).to_le_bytes())
            }
            8 => {
                let $x = bnum::types::I512::from_le_slice(&$ab[..nb]).unwrap();
                let $y = bnum::types::I512::from_le_slice(&$bb[..nb]).unwrap();
                from_le_scratch::<$K>(&($op).to_le_bytes())
            }
            16 => {
                let $x = bnum::types::I1024::from_le_slice(&$ab[..nb]).unwrap();
                let $y = bnum::types::I1024::from_le_slice(&$bb[..nb]).unwrap();
                from_le_scratch::<$K>(&($op).to_le_bytes())
            }
            32 => {
                let $x = bnum::types::I2048::from_le_slice(&$ab[..nb]).unwrap();
                let $y = bnum::types::I2048::from_le_slice(&$bb[..nb]).unwrap();
                from_le_scratch::<$K>(&($op).to_le_bytes())
            }
            _ => panic!("FixedInt<{}>: bnum bridge supports only K in {{4,8,16,32}}", $K),
        }
    }};
}

#[inline]
fn bnum_to_f64<const K: usize>(buf: &[u8]) -> Option<f64> {
    let nb = K * 8;
    match K {
        4 => bnum::types::I256::from_le_slice(&buf[..nb]).unwrap().to_f64(),
        8 => bnum::types::I512::from_le_slice(&buf[..nb]).unwrap().to_f64(),
        16 => bnum::types::I1024::from_le_slice(&buf[..nb]).unwrap().to_f64(),
        32 => bnum::types::I2048::from_le_slice(&buf[..nb]).unwrap().to_f64(),
        _ => panic!("FixedInt<{K}>: bnum bridge supports only K in {{4,8,16,32}}"),
    }
}

#[inline]
fn bnum_from_str_radix<const K: usize>(
    s: &str,
    radix: u32,
) -> Result<FixedInt<K>, ParseFixedIntError> {
    match K {
        4 => bnum::types::I256::from_str_radix(s, radix)
            .map(|v| from_le_scratch::<K>(&v.to_le_bytes()))
            .map_err(|_| ParseFixedIntError),
        8 => bnum::types::I512::from_str_radix(s, radix)
            .map(|v| from_le_scratch::<K>(&v.to_le_bytes()))
            .map_err(|_| ParseFixedIntError),
        16 => bnum::types::I1024::from_str_radix(s, radix)
            .map(|v| from_le_scratch::<K>(&v.to_le_bytes()))
            .map_err(|_| ParseFixedIntError),
        32 => bnum::types::I2048::from_str_radix(s, radix)
            .map(|v| from_le_scratch::<K>(&v.to_le_bytes()))
            .map_err(|_| ParseFixedIntError),
        _ => panic!("FixedInt<{K}>: bnum bridge supports only K in {{4,8,16,32}}"),
    }
}

// ── std::ops ────────────────────────────────────────────────────────────────
// Bare `Add`/`Sub`/`Mul` exist to satisfy the `CheckedAdd`/`CheckedSub`/
// `CheckedMul`/`Num`/`One` supertrait bounds; the macro never calls them hot.
// They wrap on overflow (two's complement), matching `bnum`'s `wrapping_*`.

impl<const K: usize> Add for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        FixedInt(wrapping_add(&self.0, &rhs.0))
    }
}

impl<const K: usize> Sub for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        FixedInt(wrapping_sub(&self.0, &rhs.0))
    }
}

impl<const K: usize> Mul for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: Self) -> Self {
        // Low-K limbs of the product agree for the signed and unsigned
        // interpretations, so this is the wrapping signed product.
        FixedInt(mul_low(&self.0, &rhs.0))
    }
}

impl<const K: usize> Neg for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        FixedInt(negate(&self.0))
    }
}

impl<const K: usize> Div for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn div(self, rhs: Self) -> Self {
        let ab = to_le_scratch(&self);
        let bb = to_le_scratch(&rhs);
        bnum_binary!(K, ab, bb, |x, y| x / y)
    }
}

impl<const K: usize> Rem for FixedInt<K> {
    type Output = Self;
    #[inline]
    fn rem(self, rhs: Self) -> Self {
        let ab = to_le_scratch(&self);
        let bb = to_le_scratch(&rhs);
        bnum_binary!(K, ab, bb, |x, y| x % y)
    }
}

// ── num_traits ──────────────────────────────────────────────────────────────

impl<const K: usize> Zero for FixedInt<K> {
    #[inline]
    fn zero() -> Self {
        FixedInt([0u64; K])
    }
    #[inline]
    fn is_zero(&self) -> bool {
        self.0.iter().all(|&l| l == 0)
    }
}

impl<const K: usize> One for FixedInt<K> {
    #[inline]
    fn one() -> Self {
        let mut limbs = [0u64; K];
        limbs[0] = 1;
        FixedInt(limbs)
    }
    #[inline]
    fn is_one(&self) -> bool {
        self.0[0] == 1 && self.0[1..].iter().all(|&l| l == 0)
    }
}

impl<const K: usize> Num for FixedInt<K> {
    type FromStrRadixErr = ParseFixedIntError;
    #[inline]
    fn from_str_radix(s: &str, radix: u32) -> Result<Self, Self::FromStrRadixErr> {
        bnum_from_str_radix::<K>(s, radix)
    }
}

impl<const K: usize> Signed for FixedInt<K> {
    #[inline]
    fn abs(&self) -> Self {
        if is_neg(&self.0) {
            FixedInt(negate(&self.0))
        } else {
            *self
        }
    }
    #[inline]
    fn abs_sub(&self, other: &Self) -> Self {
        if self <= other {
            FixedInt([0u64; K])
        } else {
            *self - *other
        }
    }
    #[inline]
    fn signum(&self) -> Self {
        if is_neg(&self.0) {
            FixedInt([u64::MAX; K]) // -1
        } else if self.is_zero() {
            FixedInt([0u64; K])
        } else {
            <Self as One>::one()
        }
    }
    #[inline]
    fn is_positive(&self) -> bool {
        !is_neg(&self.0) && !self.is_zero()
    }
    #[inline]
    fn is_negative(&self) -> bool {
        is_neg(&self.0)
    }
}

impl<const K: usize> FromPrimitive for FixedInt<K> {
    #[inline]
    fn from_i64(n: i64) -> Option<Self> {
        let mut limbs = if n < 0 { [u64::MAX; K] } else { [0u64; K] };
        limbs[0] = n as u64;
        Some(FixedInt(limbs))
    }
    #[inline]
    fn from_u64(n: u64) -> Option<Self> {
        let mut limbs = [0u64; K];
        limbs[0] = n;
        Some(FixedInt(limbs))
    }
}

impl<const K: usize> ToPrimitive for FixedInt<K> {
    #[inline]
    fn to_i64(&self) -> Option<i64> {
        if is_neg(&self.0) {
            for i in 1..K {
                if self.0[i] != u64::MAX {
                    return None;
                }
            }
            let v = self.0[0];
            if v >> 63 == 1 {
                Some(v as i64)
            } else {
                None
            }
        } else {
            for i in 1..K {
                if self.0[i] != 0 {
                    return None;
                }
            }
            let v = self.0[0];
            if v >> 63 == 0 {
                Some(v as i64)
            } else {
                None
            }
        }
    }
    #[inline]
    fn to_u64(&self) -> Option<u64> {
        if is_neg(&self.0) {
            return None;
        }
        for i in 1..K {
            if self.0[i] != 0 {
                return None;
            }
        }
        Some(self.0[0])
    }
    #[inline]
    fn to_f64(&self) -> Option<f64> {
        // Delegate to bnum: the default `to_f64` routes through `to_i64` and
        // would return `None` for the wide lambda values `point_to_f64` feeds it.
        let buf = to_le_scratch(self);
        bnum_to_f64::<K>(&buf)
    }
}

impl<const K: usize> CheckedAdd for FixedInt<K> {
    #[inline]
    fn checked_add(&self, v: &Self) -> Option<Self> {
        checked_add_limbs(self, v)
    }
}

impl<const K: usize> CheckedSub for FixedInt<K> {
    #[inline]
    fn checked_sub(&self, v: &Self) -> Option<Self> {
        checked_sub_limbs(self, v)
    }
}

impl<const K: usize> CheckedMul for FixedInt<K> {
    #[inline]
    fn checked_mul(&self, v: &Self) -> Option<Self> {
        checked_mul_limbs(self, v)
    }
}

impl<const K: usize> Ord for FixedInt<K> {
    #[inline]
    fn cmp(&self, other: &Self) -> Ordering {
        match (is_neg(&self.0), is_neg(&other.0)) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            // Same sign: unsigned high-to-low limb compare gives signed order.
            _ => {
                for i in (0..K).rev() {
                    match self.0[i].cmp(&other.0[i]) {
                        Ordering::Equal => {}
                        o => return o,
                    }
                }
                Ordering::Equal
            }
        }
    }
}

impl<const K: usize> PartialOrd for FixedInt<K> {
    #[inline]
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// The differential fuzz vs bnum (the correctness oracle) lives in the sibling
// `tests.rs`; it is a child module so it keeps access to the private limbs.
#[cfg(test)]
mod tests;
