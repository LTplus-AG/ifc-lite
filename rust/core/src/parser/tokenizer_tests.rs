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
        (number, b"42", Token::Integer(42)),
        (number, b"-42", Token::Integer(-42)),
        (number, b"0", Token::Integer(0)),
        (number, b"3.14", Token::Float(3.14)),
        (number, b"-3.14", Token::Float(-3.14)),
        (number, b"1.5E-10", Token::Float(1.5e-10)),
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
/// same shape `nth_attribute_is_present`'s tests cover at the scanner layer.
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

/// A typed value's `(` may be separated from its type name by whitespace,
/// including a CRLF line wrap - not just adjacent as in `IFCBOOLEAN(.T.)`.
#[test]
fn test_typed_value_tolerates_crlf_before_paren() {
    let result = typed_value_at_depth(b"IFCPOSITIVELENGTHMEASURE\r\n(1.);", 0);
    assert!(result.is_ok(), "Failed to parse: {:?}", result);
    let (rest, token) = result.unwrap();
    assert_eq!(rest, b";");
    match token {
        Token::TypedValue(type_name, args) => {
            assert_eq!(type_name, b"IFCPOSITIVELENGTHMEASURE");
            assert_eq!(args, vec![Token::Float(1.0)]);
        }
        _ => panic!("Expected TypedValue token"),
    }
}

/// Synthetic reproduction of the Allplan/Allright IFC2X3 export pattern
/// that motivated this fix: `IFCSURFACESTYLERENDERING` line-wraps with
/// `\r\n` right between a typed value's type name and its `(`. Before the
/// fix, `char('(')` saw `\r` and the whole entity failed to parse - which
/// every full-file walk treats as a silent skip, not a decode error the
/// caller sees.
#[test]
fn test_parse_entity_typed_value_wrapped_with_crlf() {
    let input = "#42=IFCSURFACESTYLERENDERING($,IFCPOSITIVELENGTHMEASURE\r\n(1.),$,$,$,$,$,$,.NOTDEFINED.);";
    let result = parse_entity(input);
    assert!(result.is_ok(), "Failed to parse: {:?}", result);
    let (id, ifc_type, args) = result.unwrap();
    assert_eq!(id, 42);
    assert_eq!(ifc_type, IfcType::IfcSurfaceStyleRendering);
    assert_eq!(args.len(), 9);
    match &args[1] {
        Token::TypedValue(type_name, inner) => {
            assert_eq!(*type_name, b"IFCPOSITIVELENGTHMEASURE");
            assert_eq!(*inner, vec![Token::Float(1.0)]);
        }
        other => panic!("Expected TypedValue token, got {:?}", other),
    }
}

/// An entity with an EMPTY argument list separated from `)` by whitespace
/// (#3789: `separated_list0` consumes nothing on zero items, so a bare
/// `char(')')` never advanced past the trailing `\r\n`).
#[test]
fn test_parse_entity_empty_args_with_whitespace() {
    let input = "#1=IFCX(\r\n);";
    let result = parse_entity(input);
    assert!(result.is_ok(), "Failed to parse: {:?}", result);
    let (id, _ifc_type, args) = result.unwrap();
    assert_eq!(id, 1);
    assert_eq!(args.len(), 0);
}

/// A nested EMPTY list argument separated from its own `)` by a single
/// space (#3789), inside an otherwise-normal entity.
#[test]
fn test_parse_entity_nested_empty_list_with_whitespace() {
    let input = "#1=IFCTABLE('a',( ));";
    let result = parse_entity(input);
    assert!(result.is_ok(), "Failed to parse: {:?}", result);
    let (id, _ifc_type, args) = result.unwrap();
    assert_eq!(id, 1);
    assert_eq!(args.len(), 2);
    match &args[1] {
        Token::List(items) => assert_eq!(items.len(), 0),
        other => panic!("Expected empty List token, got {:?}", other),
    }
}

/// A typed value with an EMPTY argument list wrapped across whitespace
/// before its `)` (#3789).
#[test]
fn test_parse_entity_nested_typed_value_empty_args_with_whitespace() {
    let input = "#1=IFCX(IFCLABEL(\r\n));";
    let result = parse_entity(input);
    assert!(result.is_ok(), "Failed to parse: {:?}", result);
    let (id, _ifc_type, args) = result.unwrap();
    assert_eq!(id, 1);
    assert_eq!(args.len(), 1);
    match &args[0] {
        Token::TypedValue(type_name, inner) => {
            assert_eq!(*type_name, b"IFCLABEL");
            assert_eq!(inner.len(), 0);
        }
        other => panic!("Expected TypedValue token, got {:?}", other),
    }
}

/// A bare empty list containing only a STEP comment (#3789): `ws` (which
/// already skips `/* ... */` per #3205) must be consulted on both sides of
/// the empty `separated_list0`, not just before `(`.
#[test]
fn test_list_empty_with_comment_only() {
    let result = list(b"(/* empty */)");
    assert!(result.is_ok(), "Failed to parse: {:?}", result);
    let (rest, token) = result.unwrap();
    assert_eq!(rest, b"");
    match token {
        Token::List(items) => assert_eq!(items.len(), 0),
        other => panic!("Expected empty List token, got {:?}", other),
    }
}

/// Two-way rule: a widened parser must not become permissive about
/// non-whitespace, non-comment junk between the parens. An unclosed
/// paren-content mismatch (stray `x`) must still fail, not silently
/// swallow the invalid byte as if it were trivia.
#[test]
fn test_list_rejects_junk_where_only_whitespace_is_allowed() {
    // `x` is not `ws`/comment, and no token rule in this grammar accepts a
    // bare identifier, so the widened `ws` around the empty
    // `separated_list0` must not let it through: `(x)` is rejected outright.
    assert!(
        list(b"(x)").is_err(),
        "`(x)` must be rejected: `x` is neither STEP trivia nor a token"
    );
}

/// ISO 10303-21 writes `INTEGER` and `REAL` as `[ SIGN ] ...` with
/// `SIGN = '+' | '-'`, so a leading `+` is exactly as legal as a leading `-`.
/// Both parsers took `opt(char('-'))` only, and the cost was not the one
/// attribute: every caller of `parse_entity` throws the record away when
/// tokenizing fails (`let Ok(..) = .. else { continue }`), so one `+1.` inside
/// a coordinate list deleted the whole `IfcCartesianPoint`.
///
/// The exponent sign already accepted both, `fast_float2::parse_partial` (the
/// fast reader on the other decode path) accepts `+`, and the TypeScript half
/// reads through `parseFloat`, so the file below decoded in the browser and
/// not in wasm.
/// Regression for #4577.
#[test]
fn plus_is_a_legal_sign_on_integer_and_real() {
    let empty: &[u8] = b"";
    assert_eq!(number(b"+42"), Ok((empty, Token::Integer(42))));
    assert_eq!(number(b"+0"), Ok((empty, Token::Integer(0))));
    assert_eq!(number(b"+3.14"), Ok((empty, Token::Float(3.14))));
    // "0." with no fraction digits, and an exponent that also carries a sign.
    assert_eq!(number(b"+1."), Ok((empty, Token::Float(1.0))));
    assert_eq!(number(b"+1.5E+10"), Ok((empty, Token::Float(1.5e10))));
    // The minus arm keeps working; a sign is optional, not required.
    assert_eq!(number(b"-42"), Ok((empty, Token::Integer(-42))));
    assert_eq!(number(b"-3.14"), Ok((empty, Token::Float(-3.14))));

    // The whole entity, which is what was actually lost.
    let (id, ifc_type, args) = parse_entity("#1=IFCCARTESIANPOINT((+1.,2.,-3.));")
        .expect("a '+'-signed REAL is legal 10303-21");
    assert_eq!(id, 1);
    assert_eq!(ifc_type, IfcType::IfcCartesianPoint);
    assert_eq!(
        args,
        vec![Token::List(vec![
            Token::Float(1.0),
            Token::Float(2.0),
            Token::Float(-3.0),
        ])]
    );
    let (_, _, args) = parse_entity("#2=IFCINTEGER(+7);").expect("a '+'-signed INTEGER too");
    assert_eq!(args, vec![Token::Integer(7)]);
}

/// #7678 (S6a): the nom tokenizer applies the same admission rule as
/// `parse_step_numeric`. An overflowing REAL no longer decodes to an infinity:
/// it becomes a typed `UnrepresentableReal` carrying its raw text, so the
/// decoder can refuse it for geometry and keep it for the data model. The
/// record itself still tokenizes; an overflowing INTEGER still does not.
#[test]
fn an_overflowing_real_is_a_typed_token_carrying_its_raw_text() {
    for (record, raw) in [
        ("#1=IFCCARTESIANPOINT((1.E400,0.,0.));", &b"1.E400"[..]),
        ("#1=IFCCARTESIANPOINT((0.,-1.0E400,0.));", b"-1.0E400"),
        ("#1=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(1.E309),$);", b"1.E309"),
        ("#1=IFCEXTRUDEDAREASOLID(#2,#3,#4,9.E999);", b"9.E999"),
    ] {
        let (_, _, args) = parse_entity(record).unwrap_or_else(|e| panic!("{record}: {e}"));
        fn find<'a>(tokens: &'a [Token<'a>]) -> Option<&'a [u8]> {
            tokens.iter().find_map(|t| match t {
                Token::UnrepresentableReal(raw) => Some(*raw),
                Token::List(items) | Token::TypedValue(_, items) => find(items),
                _ => None,
            })
        }
        assert_eq!(find(&args), Some(raw), "{record}");
        assert!(
            !format!("{args:?}").contains("inf"),
            "{record}: no Float(inf) token may remain: {args:?}"
        );
    }
    assert_eq!(number(b"1.E400"), Ok((&b""[..], Token::UnrepresentableReal(b"1.E400"))));
    // The pre-existing precedent: an INTEGER lexical_core cannot hold.
    assert!(parse_entity("#1=IFCINTEGERCOUNTRATEMEASURE(99999999999999999999);").is_err());
}

/// The admission rule refuses only overflow: `-0.` decodes to `-0.0` with its
/// sign bit, an underflowing literal to zero, and `f64::MAX` to itself.
#[test]
fn negative_zero_underflow_and_max_reals_still_decode() {
    let (_, _, args) = parse_entity("#1=IFCCARTESIANPOINT((-0.,1.E-400,1.7976931348623157E308));")
        .expect("finite reals decode");
    let Token::List(coords) = &args[0] else { panic!("{args:?}") };
    let values: Vec<f64> = coords
        .iter()
        .map(|t| match t {
            Token::Float(f) => *f,
            other => panic!("{other:?}"),
        })
        .collect();
    assert!(values[0] == 0.0 && values[0].is_sign_negative(), "{values:?}");
    assert_eq!(values[1], 0.0);
    assert_eq!(values[2], f64::MAX);
}

/// F4-1 (CORE-6): the tokenizer's number branch is `read_step_number`, so
/// every shared vector tokenizes the way the byte readers read it. `.5` and
/// `1E5` used to fail the WHOLE entity.
#[test]
fn every_shared_numeric_vector_tokenizes_like_the_byte_readers() {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../tests/fixtures/step_numeric_vectors.json")).unwrap();
    for row in rows {
        let text = row["text"].as_str().unwrap();
        let record = format!("#1=IFCX(({text},{text}),{text});");
        let parsed = parse_entity(&record);
        let (kind, bits) = (row["kind"].as_str().unwrap(), &row["bits"]);
        let token_ok = |t: &Token| match (kind, t) {
            ("integer", Token::Integer(i)) => i.to_string() == row["value"].as_str().unwrap(),
            ("real", Token::Float(f)) => {
                format!("0x{:016x}", f.to_bits()) == bits.as_str().unwrap()
            }
            ("unrepresentable", Token::UnrepresentableReal(raw)) => *raw == text.as_bytes(),
            _ => false,
        };
        if kind == "refused" {
            assert!(parsed.is_err(), "{record}");
            continue;
        }
        let (_, _, args) = parsed.unwrap_or_else(|e| panic!("{record}: {e}"));
        let Token::List(inner) = &args[0] else { panic!("{args:?}") };
        assert!(token_ok(&args[1]) && inner.iter().all(token_ok), "{record}: {args:?}");
    }
}

/// F4-1 (CORE-32): `"..."` is a binary, not a string. The token borrows the
/// content between the quotes; hex is case-insensitive and nothing is decoded.
#[test]
fn a_double_quoted_literal_is_a_binary_token() {
    let (_, _, args) = parse_entity("#1=IFCX(\"0Ff0\",\"0\",\"3AB\");").unwrap();
    assert_eq!(
        args,
        vec![Token::Binary(b"0Ff0"), Token::Binary(b"0"), Token::Binary(b"3AB")]
    );
}

/// A malformed binary fails the token like any other malformed token: the
/// unused-bits digit is required and at most `3`, the rest is hex, and `""`
/// is no escape.
#[test]
fn a_malformed_binary_fails_the_token() {
    for bad in ["\"\"", "\"4FF\"", "\"0G\"", "\"0F\"\"F\"", "\"0FF", "\"zz\"", "\"0 F\""] {
        let record = format!("#1=IFCX({bad});");
        assert!(parse_entity(&record).is_err(), "{record}");
    }
    // Two adjacent binaries are two tokens, never one `""`-doubled string.
    assert!(parse_entity("#1=IFCX(\"0F\",\"0A\");").is_ok());
}

/// An express id beyond `u32` fails the token (it was `lexical_core`'s job).
#[test]
fn an_express_id_beyond_u32_fails_the_token() {
    assert!(parse_entity("#4294967296=IFCX();").is_err());
    assert!(parse_entity("#1=IFCX(#4294967296);").is_err());
    assert_eq!(parse_entity("#4294967295=IFCX(#4294967295);").unwrap().0, u32::MAX);
}

/// D17 (F4-1): a binary literal is `AttributeValue::Binary` holding the raw
/// hex, never a `String`.
#[test]
fn a_binary_literal_decodes_to_the_binary_variant() {
    use crate::AttributeValue;
    let value = AttributeValue::from_token(&Token::Binary(b"0FF1"));
    assert!(matches!(&value, AttributeValue::Binary(hex) if hex == "0FF1"));
    assert_eq!(value.as_binary_hex(), Some("0FF1"));
    assert_eq!(value.as_string(), None);
    assert_eq!(AttributeValue::String("0FF1".into()).as_binary_hex(), None);
}
