// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! UTF-16 code-unit ordering and the 64-bit FNV-1a content hash.
//!
//! Both exist because the TypeScript engine this crate ports
//! (`packages/diff/src/fingerprint.ts`) is specified in terms of JavaScript
//! strings, which are sequences of UTF-16 code units. Rust strings are UTF-8,
//! and the two disagree in ways that move a hash:
//!
//! - **Ordering.** `str`'s `Ord` compares UTF-8 bytes, which agrees with
//!   codepoint order. UTF-16 code-unit order does not, above the BMP: a
//!   surrogate pair's units (`D800 DC00`) sort below `E000`, while its
//!   codepoint (`U+10000`) sorts above it. Measured against V8:
//!   `"" < "\u{10000}"` is `false` in JavaScript and `true` in Rust.
//!   Every sort in the fingerprint module feeds a `JSON.stringify` that is
//!   then hashed, so using Rust's natural order silently reorders any
//!   collection holding an astral character and the fingerprint moves.
//! - **Hashing.** The digest consumes one 16-bit code unit per step, not one
//!   UTF-8 byte. `ifc_lite_core`'s FNV-1a twin hashes bytes; the two agree on
//!   constants and mixing but not on output for a given string, so this is a
//!   deliberate second implementation rather than a reuse. The comment in
//!   `fingerprint.ts` says the same thing from the other side.

use std::cmp::Ordering;

/// FNV-1a 64-bit offset basis.
const FNV_OFFSET_BASIS_64: u64 = 0xcbf2_9ce4_8422_2325;
/// FNV-1a 64-bit prime.
const FNV_PRIME_64: u64 = 0x0000_0100_0000_01b3;

/// Compare two strings by UTF-16 code unit, the ordering JavaScript's `<` and
/// `Array.prototype.sort` use.
///
/// Never `localeCompare`, and never Rust's `Ord`: see the module docs. A
/// locale-sensitive comparison would make the fingerprint depend on the
/// machine that computed it, in a hash whose whole purpose is cross-machine
/// identity; Rust's `Ord` would differ above the BMP.
pub fn cmp_code_units(a: &str, b: &str) -> Ordering {
    let mut lhs = a.encode_utf16();
    let mut rhs = b.encode_utf16();
    loop {
        match (lhs.next(), rhs.next()) {
            (Some(x), Some(y)) => match x.cmp(&y) {
                Ordering::Equal => continue,
                other => return other,
            },
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        }
    }
}

/// 64-bit FNV-1a over the string's UTF-16 code units, rendered as 16 lowercase
/// hex digits, zero-padded.
///
/// Byte-exact with `stableHash` in `packages/diff/src/fingerprint.ts`. Not a
/// cryptographic hash: it is chosen for non-adversarial drift catching and
/// content matching, and the callers in the diff pass guard a residual
/// collision by bucketing on `ifcType` and requiring component agreement.
/// The 64-bit width replaced a 32-bit one that was demonstrably too narrow
/// (upstream issue #1962).
pub fn stable_hash(value: &str) -> String {
    let mut hash = FNV_OFFSET_BASIS_64;
    for unit in value.encode_utf16() {
        hash = (hash ^ u64::from(unit)).wrapping_mul(FNV_PRIME_64);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
#[path = "utf16_tests.rs"]
mod tests;
