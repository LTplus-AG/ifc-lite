// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `parser/tokenizer.rs`.
//!
//! Split out per the repo convention for modules whose bulk is test code
//! (see `rust/core/src/columnar_index.rs` / `columnar_index_tests.rs`, and
//! `parser/scanner.rs` / `scanner_tests.rs`), which also keeps `tokenizer.rs`
//! inside its module-size ratchet budget.

use super::*;

/// Table-driven basic token parsing: (parser, input, expected token).
#[test]
#[allow(clippy::approx_constant)]
fn test_basic_tokens() {
    type Parser = for<'a> fn(&'a [u8]) -> IResult<&'a [u8], Token<'a>>;
    let cases: &[(Parser, &[u8], Token)] = &[
        (entity_ref, b"#123", Token::EntityRef(123)),
        (entity_ref, b"#0", Token::EntityRef(0)),
        (string_literal, b"'hello'", Token::String(b"hello")),
        (
            string_literal,
            b"'with spaces'",
            Token::String(b"with spaces"),
        ),
        (integer, b"42", Token::Integer(42)),
        (integer, b"-42", Token::Integer(-42)),
        (integer, b"0", Token::Integer(0)),
        (float, b"3.14", Token::Float(3.14)),
        (float, b"-3.14", Token::Float(-3.14)),
        (float, b"1.5E-10", Token::Float(1.5e-10)),
        (enum_value, b".TRUE.", Token::Enum(b"TRUE")),
        (enum_value, b".FALSE.", Token::Enum(b"FALSE")),
        (enum_value, b".ELEMENT.", Token::Enum(b"ELEMENT")),
    ];
    for (parse, input, expected) in cases {
        assert_eq!(
            parse(input),
            Ok((&b""[..], expected.clone())),
            "tokenizing {input:?}"
        );
    }
}

#[test]
fn test_list() {
    let result = list(b"(1,2,3)");
    assert!(result.is_ok());
    let (_, token) = result.unwrap();
    match token {
        Token::List(items) => {
            assert_eq!(items.len(), 3);
            assert_eq!(items[0], Token::Integer(1));
            assert_eq!(items[1], Token::Integer(2));
            assert_eq!(items[2], Token::Integer(3));
        }
        _ => panic!("Expected List token"),
    }
}

#[test]
fn test_nested_list() {
    let result = list(b"(1,(2,3),4)");
    assert!(result.is_ok());
    let (_, token) = result.unwrap();
    match token {
        Token::List(items) => {
            assert_eq!(items.len(), 3);
            assert_eq!(items[0], Token::Integer(1));
            match &items[1] {
                Token::List(inner) => {
                    assert_eq!(inner.len(), 2);
                    assert_eq!(inner[0], Token::Integer(2));
                    assert_eq!(inner[1], Token::Integer(3));
                }
                _ => panic!("Expected nested List"),
            }
            assert_eq!(items[2], Token::Integer(4));
        }
        _ => panic!("Expected List token"),
    }
}

#[test]
fn test_parse_entity() {
    let input = "#123=IFCWALL('guid','owner',$,$,'name',$,$,$);";
    let result = parse_entity(input);
    assert!(result.is_ok());
    let (id, ifc_type, args) = result.unwrap();
    assert_eq!(id, 123);
    assert_eq!(ifc_type, IfcType::IfcWall);
    assert_eq!(args.len(), 8);
}

#[test]
fn test_parse_entity_with_nested_list() {
    // First test: simple list (should work)
    let simple = "(0.,0.,1.)";
    println!("Testing simple list: {}", simple);
    let simple_result = list(simple.as_bytes());
    println!("Simple list result: {:?}", simple_result);

    // Second test: nested in entity (what's failing)
    let input = "#9=IFCDIRECTION((0.,0.,1.));";
    println!("\nTesting full entity: {}", input);
    let result = parse_entity(input);

    if let Err(ref e) = result {
        println!("Parse error: {:?}", e);

        // Try parsing just the arguments part
        println!("\nTrying to parse just arguments: ((0.,0.,1.))");
        let args_input = "((0.,0.,1.))";
        let args_result = list(args_input.as_bytes());
        println!("Args list result: {:?}", args_result);
    }

    assert!(result.is_ok(), "Failed to parse: {:?}", result);
    let (id, _ifc_type, args) = result.unwrap();
    assert_eq!(id, 9);
    assert_eq!(args.len(), 1);
    // First arg should be a list containing 3 floats
    if let Token::List(inner) = &args[0] {
        assert_eq!(inner.len(), 3);
    } else {
        panic!("Expected Token::List, got {:?}", args[0]);
    }
}

/// Deeply nested list arguments must return an error rather than
/// recursing through the stack until it overflows.
#[test]
fn test_parse_entity_rejects_excessive_nesting() {
    let n = (MAX_NESTING_DEPTH as usize) + 64;
    let mut s = String::from("#1=IFCWALL(");
    for _ in 0..n {
        s.push('(');
    }
    s.push('1');
    for _ in 0..n {
        s.push(')');
    }
    s.push_str(");");
    // Must not panic / overflow; must return Err.
    assert!(parse_entity(&s).is_err());
}

/// Moderate nesting still parses successfully.
#[test]
fn test_parse_entity_accepts_moderate_nesting() {
    let n = 32;
    let mut s = String::from("#1=IFCWALL(");
    for _ in 0..n {
        s.push('(');
    }
    s.push('1');
    for _ in 0..n {
        s.push(')');
    }
    s.push_str(");");
    assert!(parse_entity(&s).is_ok());
}

fn nested(n: usize) -> String {
    let mut s = String::from("#1=IFCWALL(");
    for _ in 0..n {
        s.push('(');
    }
    s.push('1');
    for _ in 0..n {
        s.push(')');
    }
    s.push_str(");");
    s
}

/// Boundary: parsing succeeds exactly at MAX_NESTING_DEPTH.
#[test]
fn test_parse_entity_accepts_exactly_max_nesting() {
    assert!(parse_entity(&nested(MAX_NESTING_DEPTH as usize)).is_ok());
}

/// Boundary: parsing fails at MAX_NESTING_DEPTH + 1.
#[test]
fn test_parse_entity_rejects_one_over_max_nesting() {
    assert!(parse_entity(&nested(MAX_NESTING_DEPTH as usize + 1)).is_err());
}

// -------------------------------------------------------------------
// A comment is trivia at token boundaries too (#3673's follow-up): the
// scanner's byte SPAN is comment-aware (scanner_tests.rs), but decoding
// the attributes inside that span used to read the comment text as part
// of the next value. `ws` (above) now shares `skip_step_trivia` with the
// scanners, so a comment disappears the same way whitespace always did.
// -------------------------------------------------------------------

/// The exact shape from #3673: a comment immediately before a value must
/// not become part of it.
#[test]
fn comment_before_a_value_is_not_part_of_the_value() {
    let input = "#1=IFCWALL('a', /* rev; b */ $);";
    let (_, _, args) = parse_entity(input).expect("comment is trivia, not a parse failure");
    assert_eq!(args, vec![Token::String(b"a"), Token::Null]);
}

/// A comment before the `$` must not make the null slot look non-null --
/// same shape `has_non_null_attribute`'s tests cover at the scanner layer.
#[test]
fn comment_before_dollar_still_decodes_as_null() {
    let input = "#1=IFCWALL(/* c1 */ $);";
    let (_, _, args) = parse_entity(input).unwrap();
    assert_eq!(args, vec![Token::Null]);
}

/// A comma inside a comment must not split the argument list: this is one
/// attribute (`5`), not two.
#[test]
fn comma_inside_a_comment_does_not_separate_attributes() {
    let input = "#1=IFCWALL(/* x, y */ 5);";
    let (_, _, args) = parse_entity(input).unwrap();
    assert_eq!(args, vec![Token::Integer(5)]);
}

/// Composition, the other direction: a `/*` inside a string literal is
/// text, not a comment opener -- unchanged by this fix.
#[test]
fn slash_star_inside_a_string_is_unchanged() {
    let input = "#1=IFCWALL('has /* not a comment */ text');";
    let (_, _, args) = parse_entity(input).unwrap();
    assert_eq!(args, vec![Token::String(b"has /* not a comment */ text")]);
}

/// Control: a comment-free record decodes exactly as before.
#[test]
fn comment_free_entity_decodes_unchanged() {
    let input = "#123=IFCWALL('guid','owner',$,$,'name',$,$,$);";
    let (id, ifc_type, args) = parse_entity(input).unwrap();
    assert_eq!(id, 123);
    assert_eq!(ifc_type, IfcType::IfcWall);
    assert_eq!(args.len(), 8);
}
