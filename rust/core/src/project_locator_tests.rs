// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `project_locator.rs`. The single-id cases moved here verbatim
//! from `ifc-lite-processing`'s prepass tests when the locator moved to core.

use super::*;

#[test]
fn find_project_id_late_in_file() {
    let ifc = b"ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\n#999123=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\nENDSEC;\n";
    assert_eq!(find_project_id(ifc), Some(999123));
}

#[test]
fn find_project_id_absent() {
    let ifc = b"ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\nENDSEC;\n";
    assert_eq!(find_project_id(ifc), None);
}

#[test]
fn find_project_id_skips_string_decoys() {
    let ifc = b"DATA;\n#5=IFCWALL('decoy =IFCPROJECT( in a name',$);\n#7=IFCPROJECT('g',$);\n";
    assert_eq!(find_project_id(ifc), Some(7));
}

#[test]
fn find_project_id_handles_whitespace_around_equals() {
    // Revit/EDM exporters write `#id= IFCPROJECT(` with a space after `=`;
    // the old `=IFCPROJECT(` literal never matched → the whole unit chain
    // defaulted to metres + radians (issue #1367, arched openings → circles).
    let space_after = b"DATA;\n#1=IFCWALL('x',$);\n#1593796= IFCPROJECT('g',$,'P',$,$,$,$,$,$);\n";
    assert_eq!(find_project_id(space_after), Some(1593796));

    let space_both = b"DATA;\n#42 = IFCPROJECT('g',$);\n";
    assert_eq!(find_project_id(space_both), Some(42));

    // IFCPROJECTEDCRS must not be mistaken for IFCPROJECT.
    let crs_only = b"DATA;\n#9= IFCPROJECTEDCRS('EPSG:32632',$,'WGS84',$,'UTM','32N',$);\n";
    assert_eq!(find_project_id(crs_only), None);
}

/// Control: an ordinary express id is found unchanged (issue #3421).
#[test]
fn find_project_id_ordinary_id_is_unaffected() {
    let ifc = b"DATA;\n#42=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\n";
    assert_eq!(find_project_id(ifc), Some(42));
}

/// Boundary: an id at exactly `u32::MAX` is not refused (issue #3421).
#[test]
fn find_project_id_accepts_a_ref_at_exactly_u32_max() {
    let ifc = b"DATA;\n#4294967295=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\n";
    assert_eq!(find_project_id(ifc), Some(u32::MAX));
}

/// Issue #4497: `scan_projects`'s `memchr::memmem::find` against
/// the literal `b"IFCPROJECT("` was case-sensitive, so this — this exact
/// resolver, the fallback `UnitScales::resolve` falls back to when no
/// project-id hint is available — silently returned `None` on a lowercase
/// STEP file, which is the exact "no project" branch that then defaults
/// length/angle scale to 1.0.
#[test]
fn find_project_id_lowercase_keyword() {
    let ifc = b"DATA;\n#1=ifcwall('x',$,$,$,$,$,$,$,$);\n#7=ifcproject('g',$,'P',$,$,$,$,$,$);\n";
    assert_eq!(find_project_id(ifc), Some(7));
}

/// The realistic case per #4497: CamelCase keywords from some exporters.
#[test]
fn find_project_id_mixed_case_keyword() {
    let ifc = b"DATA;\n#7=IfcProject('g',$,'P',$,$,$,$,$,$);\n";
    assert_eq!(find_project_id(ifc), Some(7));
}

/// Lowercase must still respect whitespace-around-`=` and the
/// IFCPROJECTEDCRS non-collision, exactly like the uppercase cases above.
#[test]
fn find_project_id_lowercase_handles_whitespace_and_crs_collision() {
    let space_after = b"DATA;\n#1=ifcwall('x',$);\n#1593796= ifcproject('g',$,'P',$,$,$,$,$,$);\n";
    assert_eq!(find_project_id(space_after), Some(1593796));

    let crs_only = b"DATA;\n#9= ifcprojectedcrs('EPSG:32632',$,'WGS84',$,'UTM','32N',$);\n";
    assert_eq!(find_project_id(crs_only), None);
}

/// RED for issue #3421: `find_project_id` used to accumulate the express
/// id with `wrapping_mul`/`wrapping_add`, so `#4294967297=IFCPROJECT(...)`
/// wrapped onto id 1 instead of refusing. A real `#1=IFCWALL(...)` earlier in
/// the same file proves the wrap would have misidentified the wall as the
/// project were parse_express_id not used; this asserts the oversized
/// IFCPROJECT is skipped (refused) and the search keeps going, finding
/// nothing (there is no other IFCPROJECT).
#[test]
fn find_project_id_refuses_a_ref_above_u32_max_instead_of_wrapping_onto_a_real_entity() {
    let ifc = b"DATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\n#4294967297=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\nENDSEC;\n";
    assert_eq!(
        find_project_id(ifc),
        None,
        "an oversized IFCPROJECT id must be refused, never aliased onto id 1 (the IFCWALL)"
    );
}

/// A `#<id>=IFCPROJECT(` sequence embedded in a STEP string literal is not a
/// record definition, so the scan must not return its id and must not stop:
/// the real project follows it. The old case-sensitive scan could only be
/// fooled by an uppercase decoy; matching `ifcproject(` too widens the
/// hazard to ordinary lowercase prose in a comment or a description.
///
/// The consequence of a false positive is the exact symptom issue #4497
/// exists to remove: `extract_length_unit_scale` rejects the wrong id on its
/// `IFCPROJECT` type guard and the caller's `unwrap_or(1.0)` defaults a
/// millimetre model to metres.
#[test]
fn find_project_id_skips_a_full_record_decoy_inside_a_string() {
    let ifc = b"DATA;\n#5=IFCWALL('note: #9=ifcproject( in the source',$);\n#7=IFCPROJECT('g',$);\n";
    assert_eq!(find_project_id(ifc), Some(7));

    let upper = b"DATA;\n#5=IFCWALL('note: #9=IFCPROJECT( in the source',$);\n#7=IFCPROJECT('g',$);\n";
    assert_eq!(find_project_id(upper), Some(7));
}

/// The record-start guard must not refuse a real declaration that a
/// 10303-21 comment separates from the previous record's `;` — a comment is
/// legal wherever whitespace is, and the entity scanner accepts it (see
/// `skip_step_trivia` in `rust/core/src/parser/lexical.rs`). A false
/// negative here is the same silent 1.0 default as a miss.
#[test]
fn find_project_id_accepts_a_record_behind_a_step_comment() {
    let ifc = b"DATA;\n#1=IFCWALL('x',$); /* was #9 */ #7=IFCPROJECT('g',$);\n";
    assert_eq!(find_project_id(ifc), Some(7));

    let two = b"DATA;\n#1=IFCWALL('x',$);/**//* b */#7=IFCPROJECT('g',$);\n";
    assert_eq!(find_project_id(two), Some(7));
}

/// A project declared at byte 0, with no preceding `;` at all, is still a
/// record start.
#[test]
fn find_project_id_accepts_a_record_at_the_start_of_input() {
    assert_eq!(find_project_id(b"#7=IFCPROJECT('g',$);\n"), Some(7));
}

/// `find_project_keyword` is `find_keyword` anchored on `J` rather than
/// the lead `I` (a ~20x scan win on a project-less file, since every IFC
/// keyword starts with `I`). The offset arithmetic that buys it — candidate
/// start is `j - 6`, with the first six bytes skipped and `from` applied by
/// slicing — is exactly where such a rewrite goes wrong, so pin it against a
/// naive reference over every offset of adversarial and pseudo-random buffers.
#[test]
fn find_project_keyword_matches_a_naive_reference_at_every_offset() {
    const KEYWORD: &[u8] = b"IFCPROJECT(";
    fn naive(content: &[u8], from: usize) -> Option<usize> {
        if content.len() < KEYWORD.len() {
            return None;
        }
        (from..=content.len() - KEYWORD.len())
            .find(|&i| content[i..i + KEYWORD.len()].eq_ignore_ascii_case(KEYWORD))
    }

    let mut cases: Vec<Vec<u8>> = vec![
        b"".to_vec(),
        b"J".to_vec(),
        b"j(".to_vec(),
        b"IFCPROJECT(".to_vec(),
        b"ifcproject(".to_vec(),
        b"IfcProject(".to_vec(),
        b"IFCPROJECTEDCRS(".to_vec(),
        b"IFCPROJECT".to_vec(),
        b"XXXXXXIFCPROJECT(".to_vec(),
        b"IFCPROJECT(IFCPROJECT(".to_vec(),
        b"ifcprojectIFCPROJECT(".to_vec(),
        b"JIFCPROJECT(".to_vec(),
        b"#9=ifcproject( #7=IFCPROJECT(".to_vec(),
        b"AAJAA".to_vec(),
    ];

    // xorshift64 over an alphabet dense in the keyword's own bytes, so near
    // misses are common rather than astronomically rare.
    let alphabet = b"IiFfCcPpRrOoJjEeTt(#=; \n'";
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..400 {
        let len = (next() % 48) as usize;
        cases.push(
            (0..len)
                .map(|_| alphabet[(next() as usize) % alphabet.len()])
                .collect(),
        );
    }

    let mut checked = 0usize;
    for case in &cases {
        for from in 0..=case.len() {
            assert_eq!(
                find_project_keyword(case, from),
                naive(case, from),
                "from={from} in {:?}",
                String::from_utf8_lossy(case)
            );
            checked += 1;
        }
    }
    // Anti-vacuity: an empty or tiny case list would pass silently.
    assert!(
        checked > 5_000,
        "only {checked} (buffer, offset) pairs checked"
    );
}


/// F3a (#7775): a federated file declares several projects, and the locator
/// returns every one in file order, the first being the model's project.
#[test]
fn find_project_ids_returns_every_project_in_file_order() {
    let ifc = b"DATA;\n#30=IFCPROJECT('b',$);\n#5=IFCWALL('x',$);\n#7= ifcproject('c',$);\n\
        #9=IFCPROJECTEDCRS('n',$);\n#2=IFCWALL('note: #8=IFCPROJECT( in a string',$);\n#40=IfcProject('d',$);\n";
    assert_eq!(find_project_ids(ifc), vec![30, 7, 40]);
    assert_eq!(find_project_id(ifc), Some(30), "the model's project is the first in file order");
}

#[test]
fn find_project_ids_is_empty_without_a_project_and_skips_oversized_ids() {
    assert!(find_project_ids(b"DATA;\n#1=IFCWALL('x',$);\n").is_empty());
    let ifc = b"DATA;\n#4294967297=IFCPROJECT('a',$);\n#8=IFCPROJECT('b',$);\n";
    assert_eq!(find_project_ids(ifc), vec![8], "an oversized id is refused, not wrapped, and the search goes on");
}
