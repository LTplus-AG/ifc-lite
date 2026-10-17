/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

fn limits() -> LandXmlLimits {
    LandXmlLimits::default()
}

fn utf16(text: &str, big_endian: bool, bom: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    if bom {
        bytes.extend(if big_endian { [0xfe, 0xff] } else { [0xff, 0xfe] });
    }
    for unit in text.encode_utf16() {
        bytes.extend(if big_endian { unit.to_be_bytes() } else { unit.to_le_bytes() });
    }
    bytes
}

fn one_byte_at_a_time(input: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = Decoder::new(&limits())?;
    let mut out = Vec::new();
    for byte in input {
        decoder.push_into(std::slice::from_ref(byte), &mut out)?;
    }
    out.extend(decoder.finish()?);
    Ok(out)
}

#[test]
fn every_split_decodes_like_the_whole_input() {
    let text = "<a>\u{e9}\u{1f600}</a>";
    let mut with_bom = vec![0xef, 0xbb, 0xbf];
    with_bom.extend(text.as_bytes());
    for input in [
        text.as_bytes().to_vec(),
        with_bom,
        utf16(text, false, true),
        utf16(text, true, true),
        utf16(text, false, false),
        utf16(text, true, false),
    ] {
        let whole = normalize_encoding(&input, &limits(), None).unwrap();
        assert_eq!(whole, text.as_bytes());
        assert_eq!(one_byte_at_a_time(&input).unwrap(), whole);
    }
}

#[test]
fn a_truncated_byte_order_mark_is_content_and_invalid_utf8_on_both_paths() {
    for input in [&[0xef][..], &[0xef, 0xbb], &[0xff], &[0xfe]] {
        let pull = normalize_encoding(input, &limits(), None).unwrap_err();
        let stream = one_byte_at_a_time(input).unwrap_err();
        assert_eq!(pull.message, "input is not valid UTF-8");
        assert_eq!(stream.message, pull.message);
    }
}

#[test]
fn truncated_utf16_is_refused_on_both_paths() {
    let odd = &utf16("<a/>", false, true)[..7];
    assert_eq!(normalize_encoding(odd, &limits(), None).unwrap_err().message, "UTF-16 input has an odd byte length");
    assert_eq!(one_byte_at_a_time(odd).unwrap_err().message, "UTF-16 input has an odd byte length");
    let lone_high = [0xff, 0xfe, 0x00, 0xd8];
    assert_eq!(normalize_encoding(&lone_high, &limits(), None).unwrap_err().message, "input is not valid UTF-16");
    assert_eq!(one_byte_at_a_time(&lone_high).unwrap_err().message, "input is not valid UTF-16");
}

#[test]
fn the_declaration_window_is_checked_once_for_both_paths() {
    let input = b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><a/>";
    for result in [normalize_encoding(input, &limits(), None), one_byte_at_a_time(input)] {
        assert_eq!(result.unwrap_err().message, "unsupported XML encoding declaration");
    }
}

#[test]
fn a_bad_declaration_is_judged_before_a_later_fault_and_output_waits_for_it() {
    let later_fault = b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><a>\xff</a>";
    assert_eq!(one_byte_at_a_time(later_fault).unwrap_err().message, "unsupported XML encoding declaration");
    let mut decoder = Decoder::new(&limits()).unwrap();
    let mut out = Vec::new();
    decoder.push_into(b"<?xml version=\"1.0\"", &mut out).unwrap();
    assert!(out.is_empty(), "nothing is released while the declaration is open");
    decoder.push_into(b"?><a/>", &mut out).unwrap();
    assert_eq!(out, b"<?xml version=\"1.0\"?><a/>");
}

#[test]
fn finishing_releases_a_withheld_prefix_once() {
    let mut decoder = Decoder::new(&limits()).unwrap();
    let mut out = Vec::new();
    decoder.push_into(b"<?xm", &mut out).unwrap();
    assert!(out.is_empty());
    out.extend(decoder.finish().unwrap());
    assert_eq!(out, b"<?xm");
    assert!(decoder.finish().unwrap().is_empty());
}
