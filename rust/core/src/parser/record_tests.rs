// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn head(record: &str) -> Option<(u32, &str)> {
    let record = StepRecord::parse(record.as_bytes())?;
    Some((record.id()?, record.keyword()?))
}

/// The head is `#id = KEYWORD (` with trivia wherever STEP allows it. The
/// spaced forms are why this matters: buildingSMART's
/// `column-straight-rectangle-tessellation.ifc` writes `#71= IFCCOLUMN(` on
/// every entity line, and `extract_entity_type_name` once returned
/// `" IFCCOLUMN"` for it (#3179).
#[test]
fn the_head_is_read_with_trivia_and_refuses_what_has_no_single_keyword() {
    for (record, expected) in [
        ("#12=IFCCOLUMN('g');", Some((12, "IFCCOLUMN"))),
        ("#12= IFCCOLUMN('g');", Some((12, "IFCCOLUMN"))),
        ("#12 =\tIFCCOLUMN ('g');", Some((12, "IFCCOLUMN"))),
        ("#12=\x0bIFCCOLUMN\x0c('g');", Some((12, "IFCCOLUMN"))),
        ("#12=\tIFCCOLUMN\t('g');", Some((12, "IFCCOLUMN"))),
        ("#12 /* a = b */ = IFCCOLUMN /* ( */ ('g');", Some((12, "IFCCOLUMN"))),
        ("#12=IFCWALL/* x */(1.);", Some((12, "IFCWALL"))),
        ("#12=IfcWall(1.);", Some((12, "IfcWall"))),
        (" \n#12=IFCWALL(1.);", Some((12, "IFCWALL"))),
        ("#4294967295=IFCWALL();", Some((u32::MAX, "IFCWALL"))),
        // Refused: an empty keyword, a complex instance, no `(`, no `=`, no
        // id, an id above u32::MAX, an open head comment, a keyword
        // with a foreign byte.
        ("#12=();", None),
        ("#12= (  );", None),
        ("#12=(IFCA(1.)IFCB(2.));", None),
        ("#12=IFCCOLUMN", None),
        ("#12=IFCCOLUMN;", None),
        ("IFCCOLUMN('g');", None),
        ("#12 IFCCOLUMN('g');", None),
        ("#=IFCCOLUMN('g');", None),
        ("#4294967296=IFCWALL();", None),
        ("#12=IFCWALL /* never closes (", None),
        ("#12=IFC WALL(1.);", None),
        ("#12=IFC.WALL(1.);", None),
        ("", None),
    ] {
        assert_eq!(head(record), expected, "{record:?}");
    }
}

fn rec(record: &str) -> StepRecord<'_> {
    StepRecord::parse(record.as_bytes()).expect(record)
}

fn point(record: &str) -> Option<(f64, f64, f64)> {
    rec(record).point_at(0)
}

/// CORE-1: the accessors read the attribute the record has, not the bytes
/// that look like it. Each row is a read that moved before F4-3.
#[test]
fn a_comment_or_a_literal_never_moves_a_read() {
    // The second `(` found by a byte scan was the one INSIDE the comment.
    assert_eq!(point("#5=IFCCARTESIANPOINT(/* (9.) */(1.,2.,3.));"), Some((1., 2., 3.)));
    assert_eq!(point("#5=IFCCARTESIANPOINT((1.,/* , */2.,3.));"), Some((1., 2., 3.)));
    // The first `#` after the `(` was the one in the comment, or in the string.
    assert_eq!(rec("#9=IFCFACETEDBREP(/*#9*/#5);").ref_at(0), Some(5));
    assert_eq!(rec("#9=IFCSOMETHING('a#12',#5);").ref_at(0), None);
    assert_eq!(rec("#9=IFCSOMETHING('a#12',#5);").ref_at(1), Some(5));
    // A `$` first attribute is nothing, never the next attribute's reference.
    assert_eq!(rec("#9=IFCSOMETHING($,#5);").first_ref_at(0), None);
    assert_eq!(rec("#9=IFCSOMETHING($,#5);").ref_at(0), None);
    // `first_ref_at` reads a reference, or the first item of a list.
    assert_eq!(rec("#9=IFCSOMETHING(#5);").first_ref_at(0), Some(5));
    assert_eq!(rec("#9=IFCSOMETHING((#6,#7));").first_ref_at(0), Some(6));
    assert_eq!(rec("#9=IFCSOMETHING(('#6',#7));").first_ref_at(0), None);
    assert_eq!(rec("#9=IFCSOMETHING(());").first_ref_at(0), None);
    // Attribute counting follows the structure.
    let r = rec("#9=IFCX('a,b',(1,2),/* , */3.,$);");
    assert_eq!(r.attrs().collect::<Vec<_>>(), [&b"'a,b'"[..], b"(1,2)", b"3.", b"$"]);
    assert_eq!(r.attr(2), Some(&b"3."[..]));
    assert_eq!(r.attr(4), None);
}

/// A reference is `#` and digits and nothing else; D3 for the lists.
#[test]
fn references_are_exact_and_a_list_with_one_bad_item_is_refused() {
    for (item, expected) in [
        ("#5", Some(5)),
        ("#0", Some(0)),
        ("#4294967295", Some(u32::MAX)),
        ("#4294967297", None),
        ("#+5", None),
        ("#12abc", None),
        ("# 5", None),
        ("#", None),
        ("5", None),
        ("", None),
        ("#5 ", None),
    ] {
        assert_eq!(parse_ref(item.as_bytes()), expected, "{item:?}");
    }
    let mut out = vec![99];
    let list = |record: &str, out: &mut Vec<u32>| rec(record).ref_list_at(0, out);
    assert_eq!(list("#1=IFCX((#2,#3 , /* #9 */ #4));", &mut out), Some(()));
    assert_eq!(out, [2, 3, 4]);
    assert_eq!(list("#1=IFCX(());", &mut out), Some(()));
    assert!(out.is_empty());
    for refused in [
        "#1=IFCX((#2,#4294967297,#4));",
        "#1=IFCX((#2,3,#4));",
        "#1=IFCX((#2,(#3),#4));",
        "#1=IFCX((#2,$,#4));",
        "#1=IFCX((#2,'#3'));",
        "#1=IFCX((#2,#3",
        "#1=IFCX(#2);",
        "#1=IFCX($);",
    ] {
        assert_eq!(list(refused, &mut out), None, "{refused}");
        assert!(out.is_empty(), "{refused}: no partial list is exposed");
    }
}

#[test]
fn values_are_read_as_the_full_decode_reads_them() {
    let r = rec("#1=IFCX('O''Brien',.F.,2.5,1.E400,$,*,'\\X2\\00FC\\X0\\',.TRUE.,'a'/*c*/);");
    assert_eq!(r.string_at(0).as_deref(), Some("O'Brien"));
    assert_eq!(r.string_at(6).as_deref(), Some("\u{FC}"));
    assert_eq!(r.string_at(8).as_deref(), Some("a"));
    assert!(matches!(rec("#1=IFCX('plain');").string_at(0), Some(Cow::Borrowed("plain"))));
    assert_eq!((r.string_at(4), r.string_at(5), r.string_at(2)), (None, None, None));
    assert_eq!(r.enum_at(1), Some(&b"F"[..]));
    assert_eq!(r.enum_at(7), Some(&b"TRUE"[..]));
    assert_eq!((r.enum_at(0), r.enum_at(2), r.enum_at(4)), (None, None, None));
    assert_eq!(r.real_at(2), Some(2.5));
    // An overflowing REAL is refused, and so is anything that is not one literal.
    assert_eq!((r.real_at(3), r.real_at(0), r.real_at(4)), (None, None, None));
    assert_eq!(rec("#1=IFCX(.5,1E5,+1,1.,-0.);").real_at(0), Some(0.5));
    assert_eq!(rec("#1=IFCX(.5,1E5,+1,1.,-0.);").real_at(1), Some(1e5));
    assert!(rec("#1=IFCX(.5,1E5,+1,1.,-0.);").real_at(4).unwrap().is_sign_negative());
    assert_eq!(rec("#1=IFCX(inf,nan,1..2);").real_at(0), None);
    assert_eq!(rec("#1=IFCX(inf,nan,1..2);").real_at(1), None);
    assert_eq!(rec("#1=IFCX(inf,nan,1..2);").real_at(2), None);
}

#[test]
fn a_point_is_two_or_three_step_numbers() {
    assert_eq!(point("#1=IFCCARTESIANPOINT((1.,2.));"), Some((1., 2., 0.)));
    assert_eq!(point("#1=IFCCARTESIANPOINT((.5,1E1,-0.));").map(|p| (p.0, p.1)), Some((0.5, 10.)));
    for refused in [
        "#1=IFCCARTESIANPOINT((1.,2.,3.,4.));",
        "#1=IFCCARTESIANPOINT((1.52.3,4.));",
        "#1=IFCCARTESIANPOINT((inf,1.,1.));",
        "#1=IFCCARTESIANPOINT((1.E400,1.,1.));",
        "#1=IFCCARTESIANPOINT($);",
        "#1=IFCCARTESIANPOINT(1.,2.,3.);",
        "#1=IFCCARTESIANPOINT((1.,2.,3.);",
    ] {
        assert_eq!(point(refused), None, "{refused}");
    }
}

#[test]
fn presence_matches_the_scanner_rule() {
    for (record, i, expected) in [
        ("#1=IFCX($,#2,,'a');", 0, false),
        ("#1=IFCX($,#2,,'a');", 1, true),
        ("#1=IFCX($,#2,,'a');", 2, false),
        ("#1=IFCX($,#2,,'a');", 3, true),
        ("#1=IFCX($,#2,,'a');", 4, false),
        ("#1=IFCX(/* c */ #2);", 0, true),
        ("#1=IFCX(#2", 0, false),
    ] {
        assert_eq!(rec(record).is_present(i), expected, "{record} {i}");
        assert_eq!(
            crate::parser::nth_attribute_is_present(record.as_bytes(), i),
            expected,
            "{record} {i}"
        );
    }
}

#[test]
fn keyword_is_matches_a_whole_identifier_without_scanning_the_head() {
    let is = |record: &str, kw: &str| rec(record).keyword_is(kw.as_bytes());
    assert!(is("#1=IFCFACEOUTERBOUND(#2,.T.);", "IFCFACEOUTERBOUND"));
    assert!(is("#1= IfcFaceOuterBound (#2,.T.);", "IFCFACEOUTERBOUND"));
    assert!(is("#1=IFCFACEOUTERBOUND/* c */(#2,.T.);", "IFCFACEOUTERBOUND"));
    assert!(is("#1 /* ( */ = IFCFACEOUTERBOUND (#2,.T.);", "IFCFACEOUTERBOUND"));
    assert!(!is("#1=IFCFACEBOUND/* IFCFACEOUTERBOUND */(#2,.T.);", "IFCFACEOUTERBOUND"));
    assert!(!is("#1=IFCFACEBOUND(#2,.T.);", "IFCFACEOUTERBOUND"));
    assert!(!is("#1=XIFCFACEOUTERBOUND(#2,.T.);", "IFCFACEOUTERBOUND"));
    assert!(!is("#1=OUTERBOUND(#2,.T.);", "IFCFACEOUTERBOUND"));
}
