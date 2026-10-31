// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{canonical_bytes, sort_key, Address, AddressError, CanonicalWriter, ADDRESS_ALGORITHM};

#[test]
fn tagged_form_round_trips() {
    let address = Address::of(b"hello");
    let tagged = address.tagged();
    assert!(tagged.starts_with("blake3:"));
    assert_eq!(tagged.len(), "blake3:".len() + 64);
    assert_eq!(Address::parse(&tagged).expect("round trip"), address);
}

#[test]
fn equal_bytes_give_equal_addresses() {
    assert_eq!(Address::of(b"a"), Address::of(b"a"));
    assert_ne!(Address::of(b"a"), Address::of(b"b"));
}

#[test]
fn a_different_algorithm_is_refused_rather_than_guessed() {
    // A format migration must read as a migration, not as corruption.
    let err = Address::parse(&format!("sha256:{}", "0".repeat(64))).expect_err("must refuse");
    assert_eq!(err, AddressError::Algorithm("sha256".to_owned()));
}

#[test]
fn malformed_addresses_are_refused() {
    assert_eq!(
        Address::parse("nocolon").unwrap_err(),
        AddressError::Untagged
    );
    assert_eq!(
        Address::parse("blake3:abc").unwrap_err(),
        AddressError::Length(3)
    );
    assert_eq!(
        Address::parse(&format!("blake3:{}", "z".repeat(64))).unwrap_err(),
        AddressError::NotHex
    );
}

#[test]
fn algorithm_tag_is_the_one_we_mint() {
    assert_eq!(ADDRESS_ALGORITHM, "blake3");
    assert!(Address::of(b"x").tagged().starts_with(ADDRESS_ALGORITHM));
}

#[test]
fn header_participates_in_the_address() {
    // A kind tag is hashed, so two objects with identical payloads but
    // different kinds cannot collide. If this ever passed, every kind would
    // share an address space.
    let (left, _) = CanonicalWriter::new(b"IGN1", 1, 0).finish();
    let (right, _) = CanonicalWriter::new(b"IGN1", 2, 0).finish();
    assert_ne!(left, right);

    let (other_magic, _) = CanonicalWriter::new(b"IGT1", 1, 0).finish();
    assert_ne!(left, other_magic, "magic must participate too");
}

#[test]
fn length_prefixing_stops_field_confusion() {
    // Two strings concatenated must not encode like one longer string. A
    // delimiter-based encoding has exactly this collision.
    let mut a = CanonicalWriter::new(b"IGN1", 1, 0);
    a.string("ab").string("c");
    let mut b = CanonicalWriter::new(b"IGN1", 1, 0);
    b.string("a").string("bc");
    assert_ne!(a.finish().0, b.finish().0);
}

#[test]
fn absent_and_empty_strings_are_distinguishable() {
    let mut absent = CanonicalWriter::new(b"IGN1", 1, 0);
    absent.optional_string(None);
    let mut empty = CanonicalWriter::new(b"IGN1", 1, 0);
    empty.optional_string(Some(""));
    assert_ne!(
        absent.finish().0,
        empty.finish().0,
        "an absent value must not hash like an empty one"
    );
}

/// The rule this crate got wrong in an earlier draft, now pinned.
#[test]
fn strings_are_nfc_normalized_before_hashing() {
    // `Pset_Béton` precomposed and decomposed is one string canonically and
    // two byte sequences rawly: `...c3a9...` versus `...65cc81...`. Without
    // normalization the two hash differently, so the same property set read
    // from two authoring tools would look like a change.
    let nfc = "Pset_B\u{e9}ton";
    let nfd = "Pset_Be\u{301}ton";
    assert_ne!(
        nfc.as_bytes(),
        nfd.as_bytes(),
        "raw bytes differ, as the premise requires"
    );
    assert_eq!(canonical_bytes(nfc), canonical_bytes(nfd));

    let mut a = CanonicalWriter::new(b"IGN1", 1, 0);
    a.string(nfc);
    let mut b = CanonicalWriter::new(b"IGN1", 1, 0);
    b.string(nfd);
    assert_eq!(
        a.finish().0,
        b.finish().0,
        "spelling must not reach the hash"
    );
}

#[test]
fn sorting_uses_the_same_normalized_bytes_as_encoding() {
    // The dual the spec calls "worse than a collision for a verifier": sorting
    // raw while encoding normalized lets the spelling pick the order, so one
    // canonical set yields two hashes. Both spellings must sort identically
    // against a neighbour.
    let nfc = "Pset_B\u{e9}ton";
    let nfd = "Pset_Be\u{301}ton";
    // The neighbour has to be one the comparison actually reaches the accent
    // on. Against `Pset_Z` both spellings resolve at `B` vs `Z` and agree, so
    // that choice would have made this test vacuous.
    let other = "Pset_Bzton";
    let order = |a: &str| sort_key(a) < sort_key(other);
    assert_eq!(order(nfc), order(nfd), "the two spellings must order alike");

    // Raw UTF-8 would NOT agree -- this is the bug being guarded.
    assert_ne!(
        nfc.as_bytes() < other.as_bytes(),
        nfd.as_bytes() < other.as_bytes(),
        "raw-byte ordering disagrees, which is why normalization comes first"
    );
}

#[test]
fn sort_key_is_utf8_byte_order_not_utf16_code_unit_order() {
    // Deliberately the opposite of `rust/diff`'s rule. That crate sorts by
    // UTF-16 code unit to reproduce V8's `JSON.stringify`; this one follows
    // node-hash v0, which sorts normalized UTF-8 bytes. The two disagree above
    // the BMP, so the choice has to be explicit rather than assumed.
    let private_use = "\u{E000}";
    let astral = "\u{10000}";
    assert!(sort_key(private_use) < sort_key(astral), "UTF-8 byte order");
    let utf16 = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    assert!(
        utf16(private_use) > utf16(astral),
        "UTF-16 order is the reverse"
    );
}

#[test]
fn sort_key_orders_ascii_conventionally() {
    assert!(sort_key("A") < sort_key("a"));
    assert!(sort_key("ab") < sort_key("abc"));
    assert_eq!(sort_key("abc"), sort_key("abc"));
}

// Review on #8265: `u8::from_str_radix` accepts a leading sign and uppercase
// digits, so one address had several accepted spellings.
#[test]
fn parse_rejects_a_signed_digit_pair() {
    let tagged = format!("{}:{}", super::ADDRESS_ALGORITHM, "+f".repeat(32));
    assert_eq!(Address::parse(&tagged), Err(AddressError::NotHex));
}

#[test]
fn parse_rejects_uppercase_hex_so_one_address_has_one_spelling() {
    let lower = format!("{}:{}", super::ADDRESS_ALGORITHM, "ab".repeat(32));
    let upper = format!("{}:{}", super::ADDRESS_ALGORITHM, "AB".repeat(32));
    let parsed = Address::parse(&lower).expect("lowercase parses");
    assert_eq!(parsed.tagged(), lower, "round trip is byte-identical");
    assert_eq!(Address::parse(&upper), Err(AddressError::NotHex));
}
