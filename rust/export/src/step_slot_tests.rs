// SPDX-License-Identifier: MPL-2.0
//! Tests for `step_slot.rs`, split out under the house pattern (AGENTS.md) so
//! the production module stays under the module-size ratchet.

use super::*;

#[test]
fn split_top_level_args_respects_nesting() {
    let args = "'a',$,(#1,#2,#3),IFCBOOLEAN(.T.),#9";
    let parts = split_top_level_args(args).expect("a well-formed argument list");
    assert_eq!(parts.len(), 5);
    assert_eq!(parts[2], "(#1,#2,#3)");
    assert_eq!(parts[3], "IFCBOOLEAN(.T.)");
}

/// Accepted input must be reassemblable byte for byte, or a caller replacing
/// one slot silently rewrites the ones it did not touch.
#[test]
fn accepted_parts_rejoin_to_the_input() {
    for input in [
        "'a',$,(#1,#2,#3),IFCBOOLEAN(.T.),#9",
        "'g', $ ,'Name',*",
        "'g',,$",
        "\"0F3A\",$",
        "'it''s',$",
        "IFCLABEL ( 'x' ),$",
        "'g',/* c */$,'b'",
        "'g',$ /* trailing */,'b'",
        "'g',IFCLABEL /* c */ ('x'),'b'",
        "'g',/* has , and ( and ' */$,'b'",
    ] {
        let parts = split_top_level_args(input)
            .unwrap_or_else(|| panic!("expected {input:?} to be accepted"));
        assert_eq!(parts.join(","), input, "round-trip for {input:?}");
    }
}

/// The empty argument list of a record with no attributes, which is not the
/// same thing as one empty slot.
#[test]
fn an_empty_input_is_no_slots_at_all() {
    assert_eq!(split_top_level_args(""), Some(Vec::new()));
    assert_eq!(split_top_level_args("   "), Some(Vec::new()));
}

/// A `/* ... */` comment is legal ISO 10303-21 and this repo has met it in real
/// files (#3789, #4162). Refusing a slot that carries one is not a tightening,
/// it is a refusal to read a legal record: every by-index write on it drops, and
/// `attribute_of` returning `None` makes `step_cow::candidate` refuse the whole
/// copy-on-write when the REFERRER line carries the comment.
///
/// The exact expected parts are written out, not just `is_some()`: the comment's
/// bytes must stay INSIDE the slot they were written in, which is what the
/// export twin does (`splitTopLevelStepArguments`, measured 2026-09-09) and what
/// keeps a caller's replacement of one slot from moving another slot's bytes.
///
/// These live here rather than in the shared fixture because that fixture is
/// refuse-only by design — the splitters in this repo accept different things on
/// purpose, and pinning an accept would freeze a divergence as agreement.
#[test]
fn accepts_a_slot_carrying_a_comment() {
    assert_eq!(
        split_top_level_args("'g',/* c */$,'b'"),
        Some(vec![
            "'g'".to_string(),
            "/* c */$".to_string(),
            "'b'".to_string(),
        ]),
    );
    assert_eq!(
        split_top_level_args("'g',$ /* trailing */,'b'"),
        Some(vec![
            "'g'".to_string(),
            "$ /* trailing */".to_string(),
            "'b'".to_string(),
        ]),
    );
}

/// A comment's content is unrestricted text, so the delimiters STEP cares about
/// can appear inside one. The scan must step over the region atomically rather
/// than read those bytes as structure — otherwise the comma below splits one
/// slot into two and the apostrophe opens a phantom string that swallows the
/// rest of the record.
#[test]
fn a_comment_does_not_supply_structure() {
    assert_eq!(
        split_top_level_args("'g',/* a, b ( c ' d */$,'b'"),
        Some(vec![
            "'g'".to_string(),
            "/* a, b ( c ' d */$".to_string(),
            "'b'".to_string(),
        ]),
    );
}

/// The other half of the comment rule, and the reason it is not simply
/// "comments are ignored": a comment is not a VALUE. A slot holding nothing else
/// is one more part than the record has attributes, so every index after it
/// names the wrong one. Also the third and fourth shared refuse vectors; kept
/// here beside the accepts because the pair is the whole contract.
#[test]
fn refuses_a_slot_that_is_only_a_comment() {
    assert_eq!(split_top_level_args("'guid',$,'Name',/* c */,$"), None);
    assert_eq!(split_top_level_args("$,/* renamed */,$"), None);
}

/// #4125: two undoubled apostrophes leave quote parity EVEN and paren depth at
/// ZERO, so every scan-state check passes on a split that is not the record's
/// slots. Only the per-part grammar rule sees it.
///
/// Also the first case in the shared fixture below, and kept here anyway: it is
/// the record the issue is about, and a named test says which refusal is the
/// point of the module. The other hand-written refusal cases were deleted once
/// the fixture covered them, since a sweep that fails names the vector.
#[test]
fn refuses_the_two_apostrophe_phantom() {
    let attrs = "'g',$,IFCLABEL('a's'),$,IFCLABEL('b's'),#5,#6,'T',.SOLIDWALL.";
    assert_eq!(split_top_level_args(attrs), None);
}

/// The Rust half of the cross-language REFUSE parity pin (#4125).
///
/// The TypeScript twin (`packages/export/src/step-argument-parser.ts`'s
/// `splitTopLevelStepArguments`, via
/// `packages/export/src/step-refuse.parity.test.ts`) is held to the SAME file,
/// so the two cannot drift apart silently — the arrangement
/// `step_escape_vectors.json` gives the two STEP escapers (#3300), for the same
/// reason: two implementations that cannot share code were held together only
/// by each describing the other in prose.
///
/// The fixture lives in `tests/fixtures/` because that is where this repo's
/// other shared vector files live; `include_str!` resolves it relative to this
/// source file. NOT guarded by an existence check: a missing fixture means the
/// pin is not being enforced, and that must fail loudly.
#[test]
fn refuses_every_shared_cross_language_vector() {
    let raw = include_str!("../tests/fixtures/step_refuse_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases is an array");
    assert!(
        cases.len() >= 8,
        "an empty or near-empty vector list proves nothing; got {}",
        cases.len()
    );

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = case["input"].as_str().expect("input is a string");
        assert_eq!(
            split_top_level_args(input),
            None,
            "vector `{name}`: {input:?} must be refused"
        );
    }
}

