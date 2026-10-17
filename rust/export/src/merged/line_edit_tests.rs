// SPDX-License-Identifier: MPL-2.0
//! Tests for `line_edit.rs`, split out under the house pattern (AGENTS.md):
//! the production module stays under the module-size ratchet, and this file is
//! exempt via the `_tests.rs` suffix.

use super::*;

fn dropped(ids: &[u32]) -> HashSet<u32> {
    ids.iter().copied().collect()
}

#[test]
fn rewrite_refs_offsets_and_redirects() {
    let mut remap = std::collections::HashMap::new();
    remap.insert(2u32, 100u32);
    let out = rewrite_refs(
        b"#3=IFCRELAGGREGATES('r #2',$,$,$,#1,(#2));",
        10,
        &|n| remap.get(&n).copied(),
    );
    // #1 offset by 10 → #11; #2 redirected → #100; '#2' in the string untouched.
    assert!(out.contains("#11,(#100))"));
    assert!(out.contains("'r #2'"));
}

#[test]
fn classifies_single_list_and_nested_references() {
    let line = "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3));";
    let slots = classify_refs(line).expect("parseable line");
    assert_eq!(slots[0], (1, RefSlot::Single));
    assert_eq!(slots[1], (2, RefSlot::ListElement));
    assert_eq!(slots[2], (3, RefSlot::ListElement));
    // A reference one level deeper is neither removable nor line-fatal.
    let nested = classify_refs("#9=IFCX('g',((#4)),#5);").expect("parseable line");
    assert!(nested.contains(&(4, RefSlot::Nested)));
    assert!(nested.contains(&(5, RefSlot::Single)));
}

#[test]
fn an_unparseable_line_classifies_as_none_rather_than_as_empty() {
    // "no argument list" must be distinguishable from "names nothing": the drop
    // analysis blocks on the first and would happily drop on the second.
    assert!(classify_refs("#9=IFCRELAGGREGATES;").is_none());
    assert!(classify_refs("#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2)").is_none());
}

#[test]
fn a_hash_inside_a_string_is_not_a_reference() {
    let slots = classify_refs("#9=IFCSITE('g',$,'Site #7',$,$,$,$,$,$);").expect("parseable line");
    assert!(slots.is_empty());
    let mut refs = Vec::new();
    arg_refs(b"#9=IFCSITE('g',$,'Site #7',$,$,$,$,$,$);", &mut refs);
    assert!(refs.is_empty(), "quoted text is not a reference: {refs:?}");
}

#[test]
fn arg_refs_skips_the_line_s_own_id() {
    let mut refs = Vec::new();
    arg_refs(b"#12=IFCRELAGGREGATES('g',$,$,$,#1,(#2));", &mut refs);
    assert_eq!(refs, vec![1, 2]);
}

#[test]
fn keeps_a_line_that_names_nothing_dropped() {
    let line = "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3));";
    assert!(matches!(decide_line(line, &dropped(&[7])), LineDecision::Keep));
}

#[test]
fn strips_a_dropped_list_element_and_keeps_the_rest() {
    let line = "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3));";
    let LineDecision::Rewrite(out) = decide_line(line, &dropped(&[2])) else {
        panic!("expected a rewrite");
    };
    assert_eq!(out, "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#3));");
}

#[test]
fn drops_the_line_when_a_list_empties() {
    let line = "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3));";
    assert!(matches!(decide_line(line, &dropped(&[2, 3])), LineDecision::Skip));
}

#[test]
fn drops_the_line_when_a_single_valued_reference_goes() {
    // Relating object dropped: the relationship has no subject left to name.
    let line = "#9=IFCRELCONTAINEDINSPATIALSTRUCTURE('g',$,$,$,(#2),#1);";
    assert!(matches!(decide_line(line, &dropped(&[1])), LineDecision::Skip));
}

#[test]
fn rewriting_preserves_every_other_attribute_verbatim() {
    // Commas, parentheses and hashes inside quoted text must survive untouched.
    let line = "#9=IFCRELDEFINESBYPROPERTIES('g',$,'A, (b) #2',$,(#2,#3),#4);";
    let LineDecision::Rewrite(out) = decide_line(line, &dropped(&[2])) else {
        panic!("expected a rewrite");
    };
    assert_eq!(out, "#9=IFCRELDEFINESBYPROPERTIES('g',$,'A, (b) #2',$,(#3),#4);");
}

/// #3421, both directions of the express-id bound in `rewrite_refs`.
///
/// #3740 migrated this crate's other reference reader (`step_text::refs_in_line`)
/// off wrapping arithmetic and left this one, which had been given a different
/// third policy: saturate (CR #2952). Saturating removed the wrap but clamped to
/// `u32::MAX`, which is itself a legal express id and goes through `remap` and
/// `offset` like any other — the same collision with a real entity, moved onto
/// the sentinel.
#[test]
fn an_oversized_reference_is_neither_wrapped_nor_clamped_onto_a_real_id() {
    let mut remap = std::collections::HashMap::new();
    remap.insert(2u32, 100u32);
    remap.insert(u32::MAX, 200u32);
    let out = rewrite_refs(
        b"#3=IFCRELAGGREGATES('g',$,$,$,#4294967298,(#1));",
        10,
        &|n| remap.get(&n).copied(),
    );
    assert!(
        !out.contains("#100"),
        "wrapping 2^32+2 to #2 puts the reference through #2's remap: {out}"
    );
    assert!(
        !out.contains("#200"),
        "clamping to u32::MAX puts the reference through u32::MAX's remap: {out}"
    );
    assert!(
        out.contains("#4294967298"),
        "the digits must survive as authored, so the reference stays exactly \
         as dangling as it was: {out}"
    );
    assert!(out.contains("(#11)"), "real references still shift: {out}");

    // The other half of the saturating path, which the remap above shadows:
    // with NOTHING mapped for u32::MAX the clamp fell through to `offset`, and
    // `u32::MAX.saturating_add(offset)` is still u32::MAX — a legal express id
    // another model in the merge may really hold.
    let unmapped = rewrite_refs(b"#3=IFCX(#4294967298);", 10, &|_| None);
    assert_eq!(
        unmapped, "#13=IFCX(#4294967298);",
        "clamping to u32::MAX and offsetting it lands the reference on a legal \
         express id instead of leaving it dangling"
    );
}

#[test]
fn a_reference_at_exactly_u32_max_is_still_remapped() {
    // The other direction: u32::MAX is a legal express id, so it must still be
    // read as one and go through the remap rather than being dropped.
    let mut remap = std::collections::HashMap::new();
    remap.insert(u32::MAX, 200u32);
    // The line's own id shifts by the offset like any other reference.
    let out = rewrite_refs(b"#3=IFCX(#4294967295);", 10, &|n| remap.get(&n).copied());
    assert_eq!(out, "#13=IFCX(#200);");
}

#[test]
fn classify_refs_holds_the_same_bound_as_the_rewrite() {
    // `parse_ref` shares the bound, so the drop analysis and the rewrite cannot
    // disagree about which digit runs are references at all (#3421).
    let slots = classify_refs("#9=IFCRELAGGREGATES('g',$,$,$,#4294967298,(#4294967297));")
        .expect("parseable line");
    assert!(
        slots.is_empty(),
        "2^32+2 and 2^32+1 must not wrap onto the real #2 and #1, which would \
         let the drop analysis rewrite or delete a line over an entity it never \
         referenced: {slots:?}"
    );

    // And a legal u32::MAX argument is still a reference in the slot it sits in.
    let at_bound = classify_refs("#9=IFCX(#4294967295,(#4294967294));").expect("parseable line");
    assert_eq!(
        at_bound,
        vec![
            (u32::MAX, RefSlot::Single),
            (u32::MAX - 1, RefSlot::ListElement)
        ]
    );
}

/// #7589: `'Para \S\' 5'` is ONE literal (the `\S\` PAGE directive takes the
/// apostrophe as its operand). A rewrite that ended the string there remapped
/// the `#9` in its text and left the real `#4` after it pointing at the source
/// id space.
#[test]
fn rewrite_refs_keeps_a_page_operand_inside_its_string_7589() {
    let out = rewrite_refs(br"#3=IFCWALL('g',#2,'Para \S\' #9 5',$,#4);", 10, &|_| None);
    assert_eq!(out, r"#13=IFCWALL('g',#12,'Para \S\' #9 5',$,#14);");
}

/// #7589: canonical attribute boundaries read a PAGE operand as
/// text, so the reference after the literal is classified in its own slot.
#[test]
fn attribute_edits_keep_a_page_operand_inside_its_string_7589() {
    let line = r"#1=IFCWALL('Para \S\') 5',#2);";
    assert_eq!(classify_refs(line), Some(vec![(2, RefSlot::Single)]));
    let slots = classify_refs(r"#9=IFCRELAGGREGATES('g',$,'Para \S\' #7 5',$,#4,(#5,#6));").expect("parseable line");
    assert_eq!(slots, vec![(4, RefSlot::Single), (5, RefSlot::ListElement), (6, RefSlot::ListElement)]);
}

/// Retained #7891: the comment's `(` cannot become the argument opener.
#[test]
fn trivia_edit_boundaries_preserve_unrelated_bytes_7891() {
    let line = "#10=/* ( */IFCRELDEFINESBYPROPERTIES('g',$,'a ''(,)''',IFCLABEL('x) (y'), /* before */ ( /* lead */ #2 /* tail */ ) /* after */,#5);";
    assert_eq!(classify_refs(line), Some(vec![(2, RefSlot::ListElement), (5, RefSlot::Single)]));
    let expected = line.replace("#2 /* tail */ )", "#2 /* tail */ ,#3)");
    assert_eq!(append_to_list_attr(line, 4, &[3]), Some(expected));
    assert_eq!(append_to_list_attr(line, 4, &[]).as_deref(), Some(line));
    assert!(matches!(decide_line(line, &dropped(&[5])), LineDecision::Skip));
    assert!(matches!(decide_line(line, &dropped(&[2])), LineDecision::Skip));
    let empty = "#10=/* ( */IFCX( /* before */ ( /* empty ( , */ ) /* after */ );";
    assert_eq!(append_to_list_attr(empty, 0, &[3]), Some(empty.replace("/* empty ( , */ )", "/* empty ( , */ #3)")));
}

/// Every deletion position, including consecutive leading/trailing removals,
/// keeps comments/whitespace and gives the same canonical list of survivors.
#[test]
fn trivia_list_removals_keep_layout_and_survivors_7891() {
    let line = "#10=/* ( */IFCX('a ''(,)''', /* outside */ ( /* a */ #1 /* b, */ , /* c */ #2 /* d */ , /* e */ #3 /* f */ ),#9);";
    for mask in 1..8 {
        let ids: Vec<u32> = (1..=3).filter(|id| mask & (1 << (id - 1)) != 0).collect();
        let decision = decide_line(line, &dropped(&ids));
        if mask == 7 {
            assert!(matches!(decision, LineDecision::Skip));
            continue;
        }
        let LineDecision::Rewrite(out) = decision else { panic!("mask {mask}: expected rewrite") };
        let mut refs = Vec::new();
        StepRecord::parse(out.as_bytes()).unwrap().ref_list_at(1, &mut refs).unwrap();
        assert_eq!(refs, (1..=3).filter(|id| !ids.contains(id)).collect::<Vec<_>>());
        let layout = |text: &str| text.replace("#1", "").replace("#2", "").replace("#3", "").replace(',', "");
        assert_eq!(layout(&out), layout(line), "mask {mask}: {out}");
        for unchanged in ["/* ( */", "'a ''(,)'''", "/* b, */", "/* outside */"] {
            assert!(out.contains(unchanged), "mask {mask}: {out}");
        }
        assert_eq!(StepRecord::parse(out.as_bytes()).unwrap().ref_at(2), Some(9));
    }
}

#[test]
fn unreadable_edit_frames_are_conservative_7891() {
    for line in ["#10=/* ( */IFCX((#2),#5", "#10=/* unclosed ( IFCX((#2),#5);", "#10=IFCX((#2), 'unclosed);"] {
        assert!(classify_refs(line).is_none(), "{line}");
        assert!(append_to_list_attr(line, 0, &[3]).is_none(), "{line}");
        assert!(matches!(decide_line(line, &dropped(&[2])), LineDecision::Keep), "{line}");
    }
}

/// F4 M-export-b (CORE-1, CORE-8): a comment is trivia everywhere the scanner
/// looks. An apostrophe in a comment opened a phantom string that hid every
/// later reference; a `#` in one was rewritten as if it were a reference.
#[test]
fn comments_are_skipped_by_the_reference_scanner() {
    let line = "#5=IFCRELX('g',$,/* it's #99 */$,(#1,#2),#3);";
    let mut refs = Vec::new();
    crate::step_text::refs_in_line(line.as_bytes(), &mut refs);
    assert_eq!(refs, vec![5, 1, 2, 3]);
    let out = rewrite_refs(line.as_bytes(), 100, &|_| None);
    assert_eq!(out, "#105=IFCRELX('g',$,/* it's #99 */$,(#101,#102),#103);");
    assert_eq!(crate::step_text::substitute_ref_in_attr("/* #1 */ (#1,#12)", 1, 9).as_deref(), Some("/* #1 */ (#9,#12)"));
    assert_eq!(classify_refs("#5=IFCX(/* ) */ #1,'a)');"), Some(vec![(1, RefSlot::Single)]));
    assert_eq!(classify_refs("#5=IFCX(#1 /* , */,#2);"), Some(vec![(1, RefSlot::Single), (2, RefSlot::Single)]));
}

#[test]
fn argument_references_do_not_start_inside_head_trivia_7891() {
    let line = b"#12 /* = #99 */ = /* ( ' #88 */ IFCX(#1,(#2));";
    let mut refs = Vec::new();
    arg_refs(line, &mut refs);
    assert_eq!(refs, vec![1, 2]);
    // An unreadable tail still protects every reference seen before it.
    refs.clear();
    arg_refs(b"#12 /* = */ = IFCX(#1,(#2", &mut refs);
    assert_eq!(refs, vec![1, 2]);
}

#[test]
fn trivia_in_every_head_gap_uses_the_same_edit_boundaries_7891() {
    for line in [
        "#10 = IFCX ( #2, (#3) );",
        "#10 /* = ( */ = /* ( */ IFCX /* ( */ ( /* #99 */ #2, /* list */ (#3) );",
    ] {
        assert_eq!(classify_refs(line), Some(vec![(2, RefSlot::Single), (3, RefSlot::ListElement)]));
        assert_eq!(append_to_list_attr(line, 1, &[4]), Some(line.replace("(#3)", "(#3,#4)")));
        assert!(matches!(decide_line(line, &dropped(&[2])), LineDecision::Skip));
    }
}
