// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// #7675: the TypeScript twin spells these literally, so their values
/// are pinned here as well as by the shared vector.
#[test]
fn complex_property_budget_is_the_documented_policy() {
    assert_eq!((MAX_COMPLEX_PROPERTY_DEPTH, MAX_COMPLEX_PROPERTY_MEMBERS), (8, 1024));
    assert_eq!(COMPLEX_PROPERTY_OUTPUT_BYTES, 1 << 20);
    assert_eq!((COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE, COMPLEX_PROPERTY_MEMBER_BYTES), (16, 16));
    assert_eq!(complex_property_output_budget(10), 1 << 20, "the floor");
    assert_eq!(complex_property_output_budget(1 << 20), 16 << 20, "per input byte");
    assert_eq!(complex_property_output_budget(usize::MAX), usize::MAX, "saturates");

    let mut budget = ComplexPropertyBudget::new(10);
    assert!((0..MAX_COMPLEX_PROPERTY_MEMBERS).all(|_| budget.admit_member()));
    assert!(!budget.admit_member(), "visit 1025 of one property");
    budget.start_property();
    assert!(budget.admit_member(), "visits restart per property");
    assert_eq!(budget.member_part("", ""), None, "no display, no part");
    assert!(!budget.admit_member(), "the entry alone spent the 10 bytes, across properties");
}

/// The charge positions every walk shares: an entry per read member, its
/// part, and the joined level, but never a bare marker (#7675 review: the
/// exporter charged it, so it cut a different property than TS).
#[test]
fn complex_property_budget_charges_parts_and_levels_not_bare_markers() {
    let mut budget = ComplexPropertyBudget::new(1000);
    let part = budget.member_part("P", "v").expect("a display is a part");
    assert_eq!(part, "P: v");
    assert_eq!(budget.bytes_left, 1000 - (COMPLEX_PROPERTY_MEMBER_BYTES + 2) - 4);
    let before = budget.bytes_left;
    assert_eq!(budget.level_value(&[], true).as_deref(), Some(COMPLEX_PROPERTY_BUDGET_MARKER));
    assert_eq!(budget.bytes_left, before, "a bare marker is not charged");
    assert_eq!(budget.level_value(&[], false), None, "nothing resolved: the caller's usage name");
    let value = budget.level_value(&[part.clone(), part], true).expect("parts");
    assert_eq!(value, format!("P: v, P: v {COMPLEX_PROPERTY_BUDGET_MARKER}"));
    assert_eq!(budget.bytes_left, before - value.len());
    assert_eq!(budget.cuts(), 2, "both cut levels are counted");
}

/// A repeat listing of one complex property id reuses the first value and is
/// charged only what it keeps; once the budget is spent it reads as a counted
/// cut (#7718 round-3 review: charging every repeat as a fresh walk cut 1 639
/// of 3 000 listings of one shared 20-member property).
#[test]
fn a_repeat_listing_is_charged_what_it_keeps_not_a_fresh_walk() {
    let mut budget = ComplexPropertyBudget::new(1000);
    let mut memo: HashMap<u32, (String, usize)> = HashMap::new();
    let walks = std::cell::Cell::new(0);
    let mut walk = |b: &mut ComplexPropertyBudget| {
        walks.set(walks.get() + 1);
        b.start_property();
        assert!(b.admit_member());
        let part = b.member_part("P", "v").expect("a part");
        let value = b.level_value(&[part], false).expect("a value");
        let bytes = complex_property_listing_bytes(&value, &["v"]);
        (value, bytes)
    };
    let first = budget.listing(&mut memo, 7, &mut walk, || "spent".into());
    assert_eq!(first, "P: v");
    let after_walk = budget.bytes_left;
    assert_eq!(after_walk, 1000 - (COMPLEX_PROPERTY_MEMBER_BYTES + 2) - 4 - 4, "entry, part, level");
    let again = budget.listing(&mut memo, 7, &mut walk, || "spent".into());
    assert_eq!(again, first);
    assert_eq!(walks.get(), 1, "one walk per id");
    assert_eq!(after_walk - budget.bytes_left, 4 + COMPLEX_PROPERTY_MEMBER_BYTES + 1, "the value, one entry and its text");
    assert_eq!(complex_property_listing_bytes::<&str>("", &[]), 0);

    budget.charge(usize::MAX);
    assert_eq!(budget.listing(&mut memo, 7, &mut walk, || "spent".into()), "spent");
    assert_eq!(budget.cuts(), 1, "a refused repeat is a counted cut");
}
