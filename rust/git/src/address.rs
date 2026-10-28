// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Content addresses, and the canonical writer every object is hashed through.
//!
//! An address is `blake3:<64 hex>`. The tagged spelling is the repo's existing
//! convention — `computeLayerId` and `computeStackHash` in
//! `packages/ifcx/src/canonical.ts` emit the same shape — so an address is
//! self-describing and a future algorithm change is visible rather than silent.
//!
//! BLAKE3 over SHA-256 for throughput at model scale, and over the faster
//! non-cryptographic options because a content address must be
//! collision-resistant: an attacker-supplied IFC must not be able to forge a
//! node id that collides with one already in the store.

use std::fmt;

/// Algorithm tag carried by every address this crate mints.
pub const ADDRESS_ALGORITHM: &str = "blake3";

/// A content address: the digest of an object's canonical encoding.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Address([u8; 32]);

impl Address {
    /// Hash a canonical byte stream.
    pub fn of(bytes: &[u8]) -> Self {
        Address(*blake3::hash(bytes).as_bytes())
    }

    /// The raw digest.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// `blake3:<64 hex>`, the form that goes on the wire and into a manifest.
    pub fn tagged(&self) -> String {
        let mut out = String::with_capacity(ADDRESS_ALGORITHM.len() + 1 + 64);
        out.push_str(ADDRESS_ALGORITHM);
        out.push(':');
        for byte in self.0 {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    /// Parse a tagged address. Rejects a different algorithm rather than
    /// guessing, so a format migration cannot read as a corrupt digest.
    pub fn parse(tagged: &str) -> Result<Self, AddressError> {
        let (algorithm, hex) = tagged.split_once(':').ok_or(AddressError::Untagged)?;
        if algorithm != ADDRESS_ALGORITHM {
            return Err(AddressError::Algorithm(algorithm.to_owned()));
        }
        if hex.len() != 64 {
            return Err(AddressError::Length(hex.len()));
        }
        let mut bytes = [0u8; 32];
        for (index, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
            let text = std::str::from_utf8(pair).map_err(|_| AddressError::NotHex)?;
            bytes[index] = u8::from_str_radix(text, 16).map_err(|_| AddressError::NotHex)?;
        }
        Ok(Address(bytes))
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.tagged())
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.tagged())
    }
}

/// Why a tagged address could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddressError {
    /// No `<algorithm>:` prefix.
    Untagged,
    /// A tag this crate does not mint.
    Algorithm(String),
    /// Wrong number of hex digits.
    Length(usize),
    /// A digit outside `0-9a-f`.
    NotHex,
}

impl fmt::Display for AddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AddressError::Untagged => write!(f, "address is missing an `<algorithm>:` prefix"),
            AddressError::Algorithm(found) => {
                write!(
                    f,
                    "address algorithm {found:?} is not {ADDRESS_ALGORITHM:?}"
                )
            }
            AddressError::Length(found) => {
                write!(f, "address needs 64 hex digits, found {found}")
            }
            AddressError::NotHex => write!(f, "address contains a non-hex digit"),
        }
    }
}

impl std::error::Error for AddressError {}

/// The canonical byte writer.
///
/// Every object kind is encoded through this, so the framing rules live in one
/// place:
///
/// - **A fixed 6-byte header**: 4-byte ASCII magic, 1-byte kind tag, 1-byte
///   format version. A format change mints a new magic rather than reusing
///   this one, which is how `node-hash-v0` says a successor must announce
///   itself.
/// - **Counts precede members**, so a truncated stream cannot be mistaken for
///   a shorter valid one.
/// - **Strings are length-prefixed**, never terminated, so a string containing
///   any byte — a separator included — cannot be read as two fields. A
///   delimiter-based encoding has exactly this collision, and it is the defect
///   class tracked for the TypeScript side in #8088.
#[derive(Debug, Default)]
pub struct CanonicalWriter {
    buffer: Vec<u8>,
}

impl CanonicalWriter {
    /// Start an object: magic, kind tag, format version.
    pub fn new(magic: &[u8; 4], kind: u8, format_version: u8) -> Self {
        let mut buffer = Vec::with_capacity(64);
        buffer.extend_from_slice(magic);
        buffer.push(kind);
        buffer.push(format_version);
        CanonicalWriter { buffer }
    }

    /// An NFC-normalized UTF-8 string, length-prefixed with its byte length.
    ///
    /// Normalization happens here, in the one place every string passes
    /// through, so no caller can encode a raw spelling by forgetting to.
    pub fn string(&mut self, value: &str) -> &mut Self {
        let bytes = canonical_bytes(value);
        self.u32(bytes.len() as u32);
        self.buffer.extend_from_slice(&bytes);
        self
    }

    /// An optional string. Absent and empty are **distinct**: absent writes a
    /// `0` tag and no payload, empty writes a `1` tag and a zero length.
    pub fn optional_string(&mut self, value: Option<&str>) -> &mut Self {
        match value {
            None => {
                self.buffer.push(0);
            }
            Some(text) => {
                self.buffer.push(1);
                self.string(text);
            }
        }
        self
    }

    /// A member count. Always written before the members it counts.
    pub fn u32(&mut self, value: u32) -> &mut Self {
        self.buffer.extend_from_slice(&value.to_le_bytes());
        self
    }

    /// An `f64` as its raw IEEE-754 bit pattern, little-endian.
    ///
    /// v0's rule, and it avoids a decision rather than making one: encoding a
    /// float as text means choosing a rendering, and two renderings of one
    /// value hash differently. Bits have no such choice. `NaN` payloads are
    /// the one residual — a signalling and a quiet `NaN` differ in bits while
    /// comparing equal — so callers normalise a non-finite value before it
    /// reaches here, as the fingerprint layer does.
    pub fn f64_bits(&mut self, value: f64) -> &mut Self {
        self.buffer
            .extend_from_slice(&value.to_bits().to_le_bytes());
        self
    }

    /// A 64-bit integer, for timestamps.
    pub fn i64(&mut self, value: i64) -> &mut Self {
        self.buffer.extend_from_slice(&value.to_le_bytes());
        self
    }

    /// A child address, by its raw digest rather than its tagged string: the
    /// Merkle rule is over bytes, and the tag is presentation.
    pub fn address(&mut self, value: &Address) -> &mut Self {
        self.buffer.extend_from_slice(value.as_bytes());
        self
    }

    /// Finish, returning the object's address and its canonical bytes.
    pub fn finish(self) -> (Address, Vec<u8>) {
        (Address::of(&self.buffer), self.buffer)
    }
}

/// NFC-normalized UTF-8 bytes: the sort key, and the bytes the encoder writes.
///
/// This is v0's rule, and following it is a correctness requirement rather than
/// a compatibility nicety. `packages/provenance/SPEC.md` §3 normalizes every
/// string before hashing and sorts sets by **those same normalized bytes**,
/// with the reason stated: sorting raw while encoding normalized lets the
/// producer's *spelling* pick the order. `Pset_Béton` spelled NFC
/// (`…c3a9…`) and NFD (`…65cc81…`) is one string canonically and two byte
/// sequences rawly, so a raw sort against `Pset_Z` orders the same set two ways
/// and one canonical input yields two hashes — "worse than a collision for a
/// verifier", since recompute-and-compare then fails on honest data.
///
/// An earlier draft of this crate sorted by UTF-16 code unit and normalized
/// nothing, on the mistaken belief that it was inheriting v0's rule. It was
/// inheriting `rust/diff`'s, which is a different compatibility format: that
/// one exists to reproduce V8's `JSON.stringify` byte for byte and has no
/// bearing here.
pub fn canonical_bytes(value: &str) -> Vec<u8> {
    use unicode_normalization::UnicodeNormalization;
    value.nfc().collect::<String>().into_bytes()
}

/// Sort key over [`canonical_bytes`]. Named separately because the call sites
/// read better, and because sorting and encoding must demonstrably use one
/// function — that identity is the whole point of the rule above.
pub fn sort_key(value: &str) -> Vec<u8> {
    canonical_bytes(value)
}

#[cfg(test)]
#[path = "address_tests.rs"]
mod tests;
