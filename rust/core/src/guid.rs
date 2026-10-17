// SPDX-License-Identifier: MPL-2.0
//! The IfcGloballyUniqueId (22-char GlobalId) home: alphabet, validators, the
//! leading-GlobalId reader and the two deterministic minters.
//!
//! Two notions on purpose, NOT interchangeable (#7777): [`is_global_id_shaped`]
//! (length + alphabet) decides whether a token is RECOGNISED as a GlobalId, so
//! the merge sees every collision real files produce (some exporters write a
//! first character outside `0..=3`); [`is_valid_global_id`] additionally
//! enforces the 128-bit packing rule and gates what we WRITE or trust
//! (appearance). Strictness must never decide whether a collision is seen.

/// buildingSMART base64 alphabet (64 chars) used by IfcGloballyUniqueId.
pub const ALPHABET: &[u8; 64] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/// A GlobalId is the first attribute, so it always starts well inside this many
/// bytes of a STEP line; the scan never looks further.
const LEADING_WINDOW: usize = 128;

/// True for a 22-char token drawn entirely from [`ALPHABET`]
/// (`^[0-9A-Za-z_$]{22}$`). Does not check the first-character range.
pub fn is_global_id_shaped(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
}

/// [`is_global_id_shaped`] plus the spec rule that the first character carries
/// only 2 bits (`'0'..='3'`), since 22 chars hold `2 + 21 * 6 = 128` bits.
pub fn is_valid_global_id(s: &str) -> bool {
    is_global_id_shaped(s) && (b'0'..=b'3').contains(&s.as_bytes()[0])
}

/// The first `'...'` string of a STEP entity line, when it is GlobalId-shaped.
/// Only the first 128 bytes are inspected. Rootedness (whether the entity type
/// has a GlobalId at all) is the caller's decision.
pub fn leading_global_id(line: &[u8]) -> Option<&str> {
    let window = &line[..line.len().min(LEADING_WINDOW)];
    let open = window.iter().position(|&b| b == b'(')?;
    let mut i = open + 1;
    while i < window.len() && window[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= window.len() || window[i] != b'\'' {
        return None;
    }
    let start = i + 1;
    let close = window[start..].iter().position(|&b| b == b'\'')? + start;
    let inner = std::str::from_utf8(&window[start..close]).ok()?;
    is_global_id_shaped(inner).then_some(inner)
}

/// Rendered-line reader used by the merge's collision bookkeeping: the first
/// `'...'` after the first `(`, anywhere in the text (no window), when it is
/// GlobalId-SHAPED. Deliberately the lenient [`is_global_id_shaped`] test, not
/// [`is_valid_global_id`]: whether a collision is SEEN must never depend on
/// validity, or two entities sharing a non-conforming id are silently kept.
pub fn read_leading_global_id(text: &str) -> Option<&str> {
    let span = rendered_first_string(text)?;
    let inner = &text[span.clone()];
    is_global_id_shaped(inner).then_some(inner)
}

/// `text` with the string read by [`read_leading_global_id`]'s scan replaced by
/// `new_guid`; unchanged when the line has no quoted first attribute.
pub fn replace_rendered_global_id(text: &str, new_guid: &str) -> String {
    let Some(span) = rendered_first_string(text) else {
        return text.to_string();
    };
    let mut out = String::with_capacity(text.len() + new_guid.len());
    out.push_str(&text[..span.start]);
    out.push_str(new_guid);
    out.push_str(&text[span.end..]);
    out
}

fn rendered_first_string(text: &str) -> Option<std::ops::Range<usize>> {
    let b = text.as_bytes();
    let open = b.iter().position(|&c| c == b'(')?;
    let q1 = b[open..].iter().position(|&c| c == b'\'')? + open;
    let q2 = b[q1 + 1..].iter().position(|&c| c == b'\'')? + q1 + 1;
    Some(q1 + 1..q2)
}

/// Deterministic 22-char GlobalId from an arbitrary seed. A faithful port of
/// `@ifc-lite/parser`'s `deterministicGlobalId` (four independent 32-bit rolling
/// hashes cross-mixed into a 128-bit state, stamped MSB-first as `2 + 21*6`
/// bits), pinned by `rust/export/tests/fixtures/deterministic_global_id_vectors.json`.
///
/// The input is iterated as UTF-16 code units to match JavaScript's `charCodeAt`.
pub fn deterministic(seed: &str) -> String {
    let mut h0: u32 = 0x811c_9dc5;
    let mut h1: u32 = 0x9e37_79b9;
    let mut h2: u32 = 0x6c07_8965;
    let mut h3: u32 = 0xb529_7a4d;
    for unit in seed.encode_utf16() {
        let c = unit as u32;
        h0 = (h0 ^ c).wrapping_mul(0x0100_0193);
        h1 = (h1 ^ c ^ (h1 >> 11)).wrapping_mul(0x85eb_ca6b);
        h2 = h2.wrapping_add(c).wrapping_add(h2 >> 7).wrapping_mul(0xc2b2_ae35);
        h3 = (h3 ^ ((c << 3) | (c >> 5)) ^ (h3 >> 13)).wrapping_mul(0x27d4_eb2f);
    }
    let mix = |x: u32, y: u32| -> u32 {
        ((x ^ y).wrapping_add((x >> 7) | (y << 25))).wrapping_mul(0x85eb_ca6b)
    };
    let m0 = mix(h0, h2);
    let m1 = mix(h1, h3);
    let m2 = mix(h2, m1);
    let m3 = mix(h3, m0);
    let words = [m0, m1, m2, m3];

    // Read the 128-bit state as a plain MSB-first bit string.
    let bit = |idx: usize| -> u32 {
        let word = words[idx / 32];
        let shift = 31 - (idx % 32);
        (word >> shift) & 1
    };
    let mut out = String::with_capacity(22);
    out.push(ALPHABET[((bit(0) << 1) | bit(1)) as usize] as char);
    for i in 0..21 {
        let mut v = 0u32;
        for b in 0..6 {
            v = (v << 1) | bit(2 + i * 6 + b);
        }
        out.push(ALPHABET[v as usize] as char);
    }
    out
}

/// Deterministic 22-char GlobalId-shaped placeholder derived from an express id
/// (right-aligned base-64 of `id + 0x1000_0000`, zero-padded). Intentionally
/// NOT the TypeScript mint: schema conversion pins this divergence
/// (`schema_convert_tests.rs`).
pub fn placeholder(id: u32) -> String {
    let mut n = id as u64 + 0x1000_0000;
    let mut s = [b'0'; 22];
    let mut i = 22;
    while i > 0 && n > 0 {
        i -= 1;
        s[i] = ALPHABET[(n % 64) as usize];
        n /= 64;
    }
    s.iter().map(|&b| b as char).collect()
}

#[cfg(test)]
#[path = "guid_tests.rs"]
mod tests;

