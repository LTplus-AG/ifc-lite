// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `.ifcZIP` container unwrapping (issue #1494).

use super::*;
use std::io::Write;
use zip::write::{SimpleFileOptions, ZipWriter};

const STEP: &str = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
// Deliberately larger than the raw/gzip max the server would apply, so
// callers can pass a real ceiling.
const BIG: usize = 512 * 1024 * 1024;

/// Build an in-memory zip from `(name, content)` pairs (Stored so declared
/// uncompressed sizes are exact for the zip-bomb test).
fn make_zip(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, content) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buf.into_inner()
}

#[test]
fn extracts_the_single_model_entry() {
    let zip = make_zip(&[("model.ifc", STEP)]);
    let out = unwrap_ifczip(&zip, BIG, 512).unwrap();
    assert_eq!(String::from_utf8(out.to_vec()).unwrap(), STEP);
}

#[test]
fn matches_ifcxml_case_insensitively_from_a_nested_path() {
    let zip = make_zip(&[("nested/dir/Model.IFCXML", "<ifcXML/>")]);
    let out = unwrap_ifczip(&zip, BIG, 512).unwrap();
    assert_eq!(String::from_utf8(out.to_vec()).unwrap(), "<ifcXML/>");
}

#[test]
fn ignores_referenced_resources_alongside_the_model() {
    let zip = make_zip(&[("model.ifc", STEP), ("resources/texture.png", "not-a-png")]);
    let out = unwrap_ifczip(&zip, BIG, 512).unwrap();
    assert_eq!(String::from_utf8(out.to_vec()).unwrap(), STEP);
}

#[test]
fn rejects_an_archive_with_no_model_entry() {
    let zip = make_zip(&[("readme.txt", "hello")]);
    let err = unwrap_ifczip(&zip, BIG, 512).unwrap_err();
    assert!(matches!(err, ApiError::BadRequest(m) if m.contains("no .ifc/.ifcxml entry")));
}

#[test]
fn rejects_an_archive_with_multiple_model_entries() {
    let zip = make_zip(&[("a.ifc", STEP), ("b.ifc", STEP)]);
    let err = unwrap_ifczip(&zip, BIG, 512).unwrap_err();
    assert!(matches!(err, ApiError::BadRequest(m) if m.contains("expected exactly one")));
}

#[test]
fn rejects_an_entry_over_the_size_ceiling() {
    // model.ifc is ~60 bytes; a 10-byte ceiling trips the zip-bomb guard
    // on the declared uncompressed size before decompressing.
    let zip = make_zip(&[("model.ifc", STEP)]);
    let err = unwrap_ifczip(&zip, 10, 1).unwrap_err();
    assert!(matches!(err, ApiError::FileTooLarge { max_mb: 1 }));
}

#[test]
fn extracts_a_deflate_compressed_model_entry() {
    // Real buildingSMART .ifcZIP containers are DEFLATE-compressed, not
    // Stored. This exercises the actual `deflate` feature path so a
    // mis-wired Cargo.toml feature fails here instead of only in production
    // (UnsupportedArchive at decode time).
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("model.ifc", opts).unwrap();
        zip.write_all(STEP.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    let zip = buf.into_inner();
    let out = unwrap_ifczip(&zip, BIG, 512).unwrap();
    assert_eq!(String::from_utf8(out.to_vec()).unwrap(), STEP);
}
