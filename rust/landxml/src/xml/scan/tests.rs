/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;
use crate::LandXmlLimits;

type Tokens = Vec<(TokenKind, Vec<u8>)>;

/// Every token (kind and bytes) and the final verdict, fed in `chunk`-byte pieces.
fn scan(input: &[u8], chunk: usize, limits: &LandXmlLimits) -> (Tokens, Result<()>) {
    let mut scanner = TokenScanner::new(limits, true).unwrap();
    let mut tokens = Vec::new();
    for piece in input.chunks(chunk) {
        let mut rest = piece;
        while !rest.is_empty() {
            match scanner.next(rest) {
                Ok(step) => {
                    rest = &rest[step.consumed..];
                    if let Some(kind) = step.token {
                        tokens.push((kind, scanner.take_token()));
                    }
                }
                Err(fault) => return (tokens, Err(fault)),
            }
        }
    }
    match scanner.finish() {
        Ok(Some(kind)) => tokens.push((kind, scanner.take_token())),
        Ok(None) => {}
        Err(fault) => return (tokens, Err(fault)),
    }
    (tokens, Ok(()))
}

fn kinds(input: &str) -> Vec<(TokenKind, String)> {
    let (tokens, verdict) = scan(input.as_bytes(), input.len().max(1), &LandXmlLimits::default());
    verdict.unwrap();
    tokens.into_iter().map(|(kind, bytes)| (kind, String::from_utf8(bytes).unwrap())).collect()
}

const DOCUMENTS: &[&str] = &[
    "<a b=\"1>2\" c='x\"y'><!-- c --><![CDATA[<>]]>text &amp; more<?pi x?><b/></a>",
    "<?xml version=\"1.0\"?>\n<a>\n  <b />\n</a>\n",
    "<a><!-->x--><!--->y--><!----><![CDATA[]]><?>z<??></a>",
    "<!x><a></a  ><b></b>",
];

#[test]
fn tokens_do_not_depend_on_where_the_input_is_cut() {
    for document in DOCUMENTS {
        let whole = scan(document.as_bytes(), document.len(), &LandXmlLimits::default());
        for chunk in 1..document.len() {
            let cut = scan(document.as_bytes(), chunk, &LandXmlLimits::default());
            assert_eq!(whole.0, cut.0, "{document} cut every {chunk}");
            assert_eq!(whole.1.is_ok(), cut.1.is_ok(), "{document} cut every {chunk}");
        }
    }
}

#[test]
fn tokens_are_framed_with_their_bytes() {
    let kinds = kinds("<?xml v?>\n<a b=\"1>2\">t<!--c--><![CDATA[<>]]><b/></a>");
    let expected = [
        (TokenKind::Pi, "<?xml v?>"),
        (TokenKind::Text, "\n"),
        (TokenKind::Markup, "<a b=\"1>2\">"),
        (TokenKind::Text, "t"),
        (TokenKind::Comment, "<!--c-->"),
        (TokenKind::CData, "<![CDATA[<>]]>"),
        (TokenKind::Markup, "<b/>"),
        (TokenKind::Markup, "</a>"),
    ];
    assert_eq!(kinds, expected.map(|(kind, bytes)| (kind, bytes.to_owned())));
}

#[test]
fn a_terminator_is_searched_after_its_opener() {
    // `<!-->` and `<!--->` are not complete comments (the old lexers disagreed).
    let tokens = kinds("<a><!-->x--></a>");
    assert_eq!(tokens[1], (TokenKind::Comment, "<!-->x-->".to_owned()));
    let tokens = kinds("<a><!--->y--></a>");
    assert_eq!(tokens[1], (TokenKind::Comment, "<!--->y-->".to_owned()));
    let tokens = kinds("<a><!----></a>");
    assert_eq!(tokens[1], (TokenKind::Comment, "<!---->".to_owned()));
    assert_eq!(kinds("<a><?>z<??></a>")[1], (TokenKind::Pi, "<?>".to_owned()));
}

#[test]
fn a_comment_that_never_closes_is_unterminated() {
    let (_, verdict) = scan(b"<a><!-->x", 3, &LandXmlLimits::default());
    assert_eq!(verdict.unwrap_err().message, "unterminated XML token");
    let (_, verdict) = scan(b"<a b=\"1>", 2, &LandXmlLimits::default());
    assert_eq!(verdict.unwrap_err().message, "unterminated XML markup");
}

#[test]
fn only_s_and_no_cdata_outside_the_root() {
    for (document, message) in [
        ("x<a/>", "LandXML document has non-whitespace content before its root element"),
        ("<a/>x", "LandXML document has non-whitespace content after its root element"),
        ("<a/>&#32;", "LandXML document has non-whitespace content after its root element"),
        ("<a/><![CDATA[ ]]>", "LandXML document has CDATA after its root element"),
        ("<![CDATA[x]]><a/>", "LandXML document has CDATA before its root element"),
    ] {
        for chunk in [1, 3, 64] {
            let (_, verdict) = scan(document.as_bytes(), chunk, &LandXmlLimits::default());
            assert_eq!(verdict.unwrap_err().message, message, "{document} cut every {chunk}");
        }
    }
    kinds(" \t\r\n<a/> \n<!-- c --><?pi?>\n");
}

#[test]
fn doctype_is_refused_and_a_lowercase_one_is_left_to_quick_xml() {
    let (_, verdict) = scan(b"<!DOCTYPE a><a/>", 4, &LandXmlLimits::default());
    assert_eq!(verdict.unwrap_err().code, Code::DtdForbidden);
    assert_eq!(kinds("<!doctype a><a/>")[0].0, TokenKind::Markup);
}

#[test]
fn caps_are_per_kind_and_independent_of_the_cut() {
    let limits = LandXmlLimits { max_text_bytes: 8, ..LandXmlLimits::default() };
    for (document, message) in [
        ("<a>123456789</a>", "text limit exceeded"),
        ("<a><!-- 1234 --></a>", "XML token limit exceeded"),
        ("<a><![CDATA[12]]></a>", "XML token limit exceeded"),
    ] {
        for chunk in [1, 5, 64] {
            let (_, verdict) = scan(document.as_bytes(), chunk, &limits);
            let refusal = verdict.unwrap_err();
            assert_eq!((refusal.code, refusal.message.as_str()), (Code::LimitExceeded, message), "{document}");
        }
    }
    let markup = LandXmlLimits { max_attributes: 0, max_name_bytes: 2, ..LandXmlLimits::default() };
    let (_, verdict) = scan(b"<a><bcdefghijklmnopqrstuv/></a>", 1, &markup);
    assert_eq!(verdict.unwrap_err().message, "markup limit exceeded");
}

#[test]
fn the_first_offending_byte_decides_between_the_cap_and_the_root_rule() {
    let limits = LandXmlLimits { max_text_bytes: 4, ..LandXmlLimits::default() };
    for (document, message) in [
        ("  x <a/>", "LandXML document has non-whitespace content before its root element"),
        ("      x<a/>", "text limit exceeded"),
    ] {
        for chunk in [1, 2, 64] {
            let (_, verdict) = scan(document.as_bytes(), chunk, &limits);
            assert_eq!(verdict.unwrap_err().message, message, "{document} cut every {chunk}");
        }
    }
}

#[test]
fn a_fault_reports_where_its_token_starts() {
    let mut scanner = TokenScanner::new(&LandXmlLimits::default(), false).unwrap();
    let input = b"<a><b/>text<!DOCTYPE x></a>";
    let mut at = 0;
    while at < input.len() {
        match scanner.next(&input[at..]) {
            Ok(step) => at += step.consumed,
            Err(_) => break,
        }
    }
    assert_eq!(scanner.token_start(), input.iter().position(|byte| *byte == b'!').unwrap() - 1);
}
