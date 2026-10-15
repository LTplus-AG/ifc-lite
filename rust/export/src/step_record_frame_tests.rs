// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[derive(serde::Deserialize)]
struct Framed {
    text: String,
    args: String,
}

#[derive(serde::Deserialize)]
struct Vectors {
    framed: Vec<Framed>,
    refused: Vec<String>,
    unframed: Vec<String>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("../tests/fixtures/step_record_frame_vectors.json")).expect("vectors parse")
}

/// EXPORT-STEP-1 (#7682): valid Part 21 trivia between the `)` and the `;`
/// (and around the `=` and before the `(`) frames the same argument list as
/// the bare spelling. Shared with the TypeScript twin.
#[test]
fn shared_vectors_frame_the_argument_list() {
    let v = vectors();
    assert!(!v.framed.is_empty());
    for case in &v.framed {
        let frame = record_frame(&case.text).unwrap_or_else(|| panic!("no frame for {:?}", case.text));
        assert_eq!(frame.args(&case.text), case.args, "{:?}", case.text);
    }
}

#[test]
fn shared_vectors_refuse_what_is_not_one_whole_record() {
    let v = vectors();
    assert!(!v.refused.is_empty());
    for text in &v.refused {
        assert_eq!(record_frame(text), None, "{text:?}");
    }
}

/// #7682 review: a line that declares an instance but has no frame opens a
/// record all the same, so an edit on it is reported as unreadable.
#[test]
fn shared_vectors_unframed_lines_still_open_a_record() {
    let v = vectors();
    assert!(!v.unframed.is_empty());
    for text in &v.unframed {
        assert_eq!(record_frame(text), None, "{text:?}");
        assert!(opens_record(text), "{text:?}");
    }
    // U+0085 and U+FEFF are not STEP whitespace, and a comment that never closes hides the `=`.
    for text in ["", "IFCWALL($);", "#=IFCWALL($);", "ENDSEC;", "#2/* c =IFCWALL($);", "\u{85}#2=IFCWALL($);", "#2\u{feff}=IFCWALL($);"] {
        assert!(!opens_record(text), "{text:?}");
    }
}

#[test]
fn head_reads_the_type_keyword_past_trivia() {
    let text = "#12 /* =x */ = IFCDOOR\x0b(1);";
    let head = record_head(text).expect("a record head");
    assert_eq!(head.type_name(text), "IFCDOOR");
    assert_eq!(&text[head.eq..=head.eq], "=");
    assert_eq!(&text[head.open..=head.open], "(");
}

#[test]
fn with_args_keeps_every_other_byte() {
    let text = "#5 = IFCWALL ('a',$) /* c */ ;";
    let frame = record_frame(text).unwrap();
    assert_eq!(frame.with_args(text, "'b',#1"), "#5 = IFCWALL ('b',#1) /* c */ ;");
}
