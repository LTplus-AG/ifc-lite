// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins the Rust CRC32 type-ID hash to the CRC-32/ISO-HDLC specification.
//!
//! `crc32_hash` lives in the generated `rust/core/src/generated/schema.rs` and
//! is private, so it is pinned here *indirectly* through the public API that
//! is its only caller: `IfcType::from_str` returns `Unknown(crc32_hash(&upper))`
//! for any name that is not a known entity. Hashing an unknown name therefore
//! exercises the same function without touching generated code.
//!
//! Why this matters: these IDs cross a language boundary. The TypeScript table
//! in `packages/parser/src/generated/type-ids.ts` is produced by
//! `packages/codegen/src/crc32.ts`, and Rust re-derives the hash here for names
//! outside the table. A wrong-but-self-consistent CRC32 on either side yields
//! two internally coherent tables that disagree with each other, and neither
//! suite notices, because each validates against itself. The same vectors are
//! pinned on the TypeScript side in `packages/codegen/test/crc32.test.ts`.

use ifc_lite_core::IfcType;

/// Hash `name` with the generated `crc32_hash`, via the only public route to it.
fn unknown_hash(name: &str) -> u32 {
    match IfcType::from_str(name) {
        IfcType::Unknown(hash) => hash,
        known => panic!(
            "{name:?} was expected to be an unknown type (so that it reaches \
             crc32_hash), but it parsed as {known:?}"
        ),
    }
}

/// Independent, bit-at-a-time reference implementation of CRC-32/ISO-HDLC,
/// written from the algorithm's parameters rather than from the generated code:
///
/// ```text
/// width=32  poly=0x04C11DB7  init=0xFFFFFFFF
/// refin=true  refout=true  xorout=0xFFFFFFFF  check=0xCBF43926
/// ```
///
/// It shares no code and no constants with the implementation under test: the
/// generated `crc32_hash` is table-driven over the *reflected* polynomial
/// 0xEDB88320 with right shifts, while this one is table-free over the
/// *unreflected* polynomial 0x04C11DB7 with left shifts, reflecting each input
/// byte on the way in and the register on the way out.
fn crc32_reference(input: &str) -> u32 {
    let mut reg: u32 = 0xFFFF_FFFF;
    for byte in input.as_bytes() {
        reg ^= u32::from(byte.reverse_bits()) << 24;
        for _ in 0..8 {
            reg = if reg & 0x8000_0000 != 0 {
                (reg << 1) ^ 0x04C1_1DB7
            } else {
                reg << 1
            };
        }
    }
    reg.reverse_bits() ^ 0xFFFF_FFFF
}

#[test]
fn crc32_hash_matches_the_standard_check_value() {
    // "check" is defined by the CRC-32/ISO-HDLC specification as the CRC of the
    // nine ASCII bytes "123456789". `from_str` uppercases its input first, but
    // digits are unaffected by case, so the vector applies unchanged.
    assert_eq!(
        unknown_hash("123456789"),
        0xCBF4_3926,
        "Rust crc32_hash is not CRC-32/ISO-HDLC; the type IDs it derives will \
         disagree with the TypeScript table"
    );
}

#[test]
fn crc32_hash_of_the_empty_string_is_the_xorout_identity() {
    // With no input the register never leaves init=0xFFFFFFFF, so the result is
    // init ^ xorout = 0xFFFFFFFF ^ 0xFFFFFFFF = 0.
    assert_eq!(unknown_hash(""), 0x0000_0000);
}

#[test]
fn reference_implementation_is_anchored_to_the_specification() {
    // Anchor the oracle to the published check value before trusting it below.
    assert_eq!(crc32_reference("123456789"), 0xCBF4_3926);
    assert_eq!(crc32_reference(""), 0x0000_0000);
}

#[test]
fn crc32_hash_agrees_with_the_independent_reference() {
    // Names deliberately absent from the IFC entity set so that `from_str`
    // falls through to `Unknown(crc32_hash(..))`.
    let names = [
        "IFCNOTATYPE",
        "IFCWALLISH",
        "IFCDEFINITELYNOTANENTITY",
        "A",
        "AB",
        "ABC",
        "123456789",
        "SOME_VENDOR_EXTENSION",
    ];
    for name in names {
        assert_eq!(
            unknown_hash(name),
            crc32_reference(&name.to_uppercase()),
            "crc32_hash disagrees with the CRC-32/ISO-HDLC reference for {name:?}"
        );
    }
}

/// The cross-language pin: the exact same spec vectors are asserted in
/// `packages/codegen/test/crc32.test.ts`, so the two implementations cannot
/// drift into two self-consistent but mutually incompatible tables.
#[test]
fn spec_vectors_are_the_same_ones_pinned_in_typescript() {
    assert_eq!(unknown_hash("123456789"), 0xCBF4_3926);
    assert_eq!(unknown_hash(""), 0x0000_0000);
}
