// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #856 — `EntityScanner::next_entity` must
//! not lock onto a `#<digits>` token unless it's followed by an `=`
//! (with optional whitespace).
//!
//! Reproduction: the user's fixture `construction-scheduling-task.ifc`
//! has section banners like
//!
//!   /* Standard case walls #1 with axis and body geometry … */
//!   #356= IFCWALL('26tmERtwL8G8UQn5BoglEh',…);
//!
//! Pre-fix the scanner found `#1` inside the comment, walked forward
//! to the next `=` (the one on `#356= IFCWALL`), and returned a line
//! range starting at `#1` and ending after `IFCWALL(…)`. The decoder
//! tried to parse `#1 with axis … */ … #356= IFCWALL(…)` as a single
//! entity and aborted with a Parse error — `stats.decode_failed += 1`
//! per affected wall, so the user saw "decode failed: 4" in console
//! and all four walls were silently dropped from the viewer.

use ifc_lite_core::{EntityDecoder, EntityScanner};

const FIXTURE_WITH_COMMENTS: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView_V1.0]'),'2;1');
FILE_NAME('test.ifc','2024-06-11T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('xxxxxxxxxxxxxxxxxxxxx1',$,'Project',$,$,$,$,$,$);
/* Standard case walls #1 with axis and body geometry */
#2= IFCWALL('xxxxxxxxxxxxxxxxxxxxx2',$,'Wall #1',$,$,$,$,$,.NOTDEFINED.);
/* Another comment with #5 and #99 inside */
#3= IFCWALL('xxxxxxxxxxxxxxxxxxxxx3',$,'Wall #2',$,$,$,$,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn scanner_skips_in_comment_hashes() {
    let mut scanner = EntityScanner::new(FIXTURE_WITH_COMMENTS);
    let mut seen_ids = Vec::new();
    while let Some((id, name, _start, _end)) = scanner.next_entity() {
        seen_ids.push((id, name.to_string()));
    }
    assert_eq!(
        seen_ids,
        vec![
            (1, "IFCPROJECT".to_string()),
            (2, "IFCWALL".to_string()),
            (3, "IFCWALL".to_string()),
        ],
        "scanner picked up bogus entities from inside `/* … */` comments",
    );
}

#[test]
fn scanner_skips_definition_shaped_tokens_in_comments() {
    // PR #865 follow-up review (chatgpt-codex P2): the original
    // `#N=` shape check still false-positived on `/* #12= IFCWALL */`
    // because the comment body genuinely contains the `#N=` pattern.
    // The full fix has to skip `/* … */` regions, not just shape-
    // check the candidate.
    const FIXTURE: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'),'2;1');
FILE_NAME('','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
/* previous version had a typo: #12= IFCWALL('bad',$,'Bad',$,$,$,$,$,.NOTDEFINED.); */
#1= IFCPROJECT('xxxxxxxxxxxxxxxxxxxxx1',$,'Project',$,$,$,$,$,$);
/* #99 = IFCSLAB('also-bad',$,'Bad Slab',$,$,$,$,$,$); */
#2= IFCWALL('xxxxxxxxxxxxxxxxxxxxx2',$,'Wall A',$,$,$,$,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;
";
    let mut scanner = EntityScanner::new(FIXTURE);
    let mut seen_ids = Vec::new();
    while let Some((id, name, _start, _end)) = scanner.next_entity() {
        seen_ids.push((id, name.to_string()));
    }
    assert_eq!(
        seen_ids,
        vec![
            (1, "IFCPROJECT".to_string()),
            (2, "IFCWALL".to_string()),
        ],
        "scanner picked up bogus #N= entities from inside a /* … */ \
         comment despite the shape-check guard — the comment-skipping \
         layer is required to fully fix this class of bug",
    );
}

#[test]
fn decoder_can_parse_all_walls_after_scanner_fix() {
    let mut scanner = EntityScanner::new(FIXTURE_WITH_COMMENTS);
    let mut decoder = EntityDecoder::new(FIXTURE_WITH_COMMENTS);
    let mut decoded_walls = 0;
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name != "IFCWALL" {
            continue;
        }
        let entity = decoder
            .decode_at_with_id(id, start, end)
            .unwrap_or_else(|e| panic!("decode #{id} failed: {e}"));
        assert_eq!(entity.ifc_type.name(), "IfcWall");
        decoded_walls += 1;
    }
    assert_eq!(
        decoded_walls, 2,
        "expected to decode both walls; pre-fix every wall failed with a parse error",
    );
}
