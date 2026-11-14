// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Hostile entries: every one must be rejected (or, for a self-consistent
//! forgery, decode to something that still passes the invariants) without a
//! panic or an unbounded allocation.

use super::super::envelope::{encode_entry, validate_entry, BODY_START, HEADER_LEN};
use super::super::CodecError;
use super::{decode, full_result, identity, reseal_directory, seal, sections};

fn entry() -> Vec<u8> {
    encode_entry(&full_result(), &identity()).unwrap()
}

#[test]
fn truncation_anywhere_is_rejected() {
    let bytes = entry();
    let boundaries: Vec<usize> = {
        let mut at = vec![0, 8, 12, HEADER_LEN, BODY_START];
        let mut offset = BODY_START;
        for (payload, _) in sections(&bytes) {
            offset += payload.len();
            at.push(offset);
        }
        at
    };
    assert_eq!(*boundaries.last().unwrap(), bytes.len());
    for cut in (0..bytes.len()).chain(boundaries.iter().map(|b| b.saturating_sub(1))) {
        assert!(decode(&bytes[..cut]).is_err(), "accepted a prefix of {cut} bytes");
    }
    let mut longer = bytes.clone();
    longer.push(0);
    assert!(decode(&longer).is_err(), "accepted a trailing byte");
}

#[test]
fn every_flipped_byte_is_rejected() {
    let bytes = entry();
    for at in 0..bytes.len() {
        for mask in [0x01u8, 0x80, 0xff] {
            let mut flipped = bytes.clone();
            flipped[at] ^= mask;
            assert!(decode(&flipped).is_err(), "accepted a flip of byte {at} by {mask:#x}");
        }
    }
}

#[test]
fn identity_and_version_mismatches_are_named() {
    let bytes = entry();
    let mut other = identity();
    other.source_sha256[0] ^= 1;
    assert!(matches!(validate_entry(&bytes, &other), Err(CodecError::IdentityMismatch)));
    other = identity();
    other.engine_digest[31] ^= 1;
    assert!(matches!(validate_entry(&bytes, &other), Err(CodecError::IdentityMismatch)));
    let mut newer = bytes.clone();
    newer[8] = 2;
    assert!(matches!(decode(&newer), Err(CodecError::Unsupported(2))));
    assert!(matches!(decode(b"not an entry at all"), Err(CodecError::BadMagic)));
}

fn put_u64(buf: &mut [u8], at: usize, v: u64) {
    buf[at..at + 8].copy_from_slice(&v.to_le_bytes());
}

#[test]
fn overflowing_counts_and_lengths_are_rejected_after_the_checksums_pass() {
    let bytes = entry();
    for (section, offset) in [(1usize, 0usize), (2, 0), (3, 0), (2, 4 + 8)] {
        for huge in [u64::MAX, u64::MAX / 4 + 1, 1 << 40] {
            let mut parts = sections(&bytes);
            // (2, 12): the first mesh's ifc_type string length.
            put_u64(&mut parts[section].0, offset, huge);
            let forged = seal(&bytes, &parts);
            assert!(decode(&forged).is_err(), "section {section} offset {offset} accepted {huge}");
        }
    }
    let mut parts = sections(&bytes);
    parts[2].1 = u64::MAX;
    assert!(decode(&seal(&bytes, &parts)).is_err(), "directory mesh count overflow accepted");
}

#[test]
fn overlapping_gapped_or_reordered_sections_are_rejected() {
    let bytes = entry();
    let dir = |i: usize, field: usize| HEADER_LEN + i * 64 + field;
    let read = |b: &[u8], at: usize| u64::from_le_bytes(b[at..at + 8].try_into().unwrap());
    type Forge = fn(&mut Vec<u8>, &dyn Fn(usize, usize) -> usize);
    let cases: [(&str, Forge); 4] = [
        ("overlap", |b, dir| {
            let at = dir(2, 8);
            let v = u64::from_le_bytes(b[at..at + 8].try_into().unwrap()) - 1;
            b[at..at + 8].copy_from_slice(&v.to_le_bytes());
        }),
        ("past the end", |b, dir| {
            let at = dir(3, 16);
            b[at..at + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        }),
        ("offset wraps", |b, dir| {
            let at = dir(3, 8);
            b[at..at + 8].copy_from_slice(&(u64::MAX - 3).to_le_bytes());
        }),
        ("reordered", |b, dir| {
            b.copy_within(dir(1, 0)..dir(1, 4), dir(0, 0));
        }),
    ];
    for (name, forge) in cases {
        let mut forged = bytes.clone();
        forge(&mut forged, &dir);
        reseal_directory(&mut forged);
        assert!(decode(&forged).is_err(), "{name} accepted");
    }
    assert!(read(&bytes, dir(0, 8)) == BODY_START as u64);
}

#[test]
fn dangling_cross_references_are_rejected() {
    let bytes = entry();
    // An empty texture table leaves the meshes' texture index dangling.
    let mut parts = sections(&bytes);
    parts[1] = (0u64.to_le_bytes().to_vec(), 0);
    assert!(decode(&seal(&bytes, &parts)).is_err(), "dangling texture index accepted");
    // An instance whose template is not a mesh.
    let mut parts = sections(&bytes);
    let at = parts[3].0.len() - 1 - 4 - 64 - 16 - 4;
    parts[3].0[at..at + 4].copy_from_slice(&999u32.to_le_bytes());
    assert!(decode(&seal(&bytes, &parts)).is_err(), "dangling instance template accepted");
}

/// Seeded mutation fuzzing past the checksums: flips, truncations, insertions
/// and overwritten words in one section, re-sealed. Every outcome is either a
/// rejection or a result that passes the invariants; none may panic.
#[test]
fn resealed_mutations_never_panic() {
    let bytes = entry();
    let base = sections(&bytes);
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let (mut rejected, mut accepted) = (0, 0);
    for _ in 0..4000 {
        let mut parts = base.clone();
        let section = (next() % 4) as usize;
        let payload = &mut parts[section].0;
        let len = payload.len().max(1);
        let at = (next() as usize) % len;
        match next() % 5 {
            0 if !payload.is_empty() => payload[at] ^= 1 << (next() % 8),
            1 => payload.truncate(at),
            2 => payload.insert(at.min(payload.len()), next() as u8),
            3 if payload.len() >= at + 8 => payload[at..at + 8].copy_from_slice(&next().to_le_bytes()),
            _ => parts[section].1 = next() % 8,
        }
        match decode(&seal(&bytes, &parts)) {
            Ok(_) => accepted += 1,
            Err(_) => rejected += 1,
        }
    }
    assert!(rejected > 2000, "most mutations must be rejected (rejected {rejected}, accepted {accepted})");
}
