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

/// Patch the 4-byte little-endian "uncompressed size" field in both the
/// local file header (offset 22 from `PK\x03\x04`) and the central directory
/// record (offset 24 from `PK\x01\x02`) of a single-entry Stored archive, so
/// the archive's DECLARED size disagrees with the ACTUAL bytes on disk. Real
/// callers do not need this — it exists to isolate the two independent
/// guards in `unwrap_ifczip`: the up-front reject on `entry.size()` (the
/// declared, central-directory value, checked before any decompression) and
/// the belt-and-braces reject on the actual decompressed byte count.
fn lie_about_uncompressed_size(mut zip: Vec<u8>, declared_size: u32) -> Vec<u8> {
    let local_sig = [0x50, 0x4b, 0x03, 0x04];
    let central_sig = [0x50, 0x4b, 0x01, 0x02];
    let local_pos = zip
        .windows(4)
        .position(|w| w == local_sig)
        .expect("local file header signature");
    let central_pos = zip
        .windows(4)
        .position(|w| w == central_sig)
        .expect("central directory signature");
    zip[local_pos + 22..local_pos + 26].copy_from_slice(&declared_size.to_le_bytes());
    zip[central_pos + 24..central_pos + 28].copy_from_slice(&declared_size.to_le_bytes());
    zip
}

/// The declared-size guard (`entry.size() > max_bytes`, before decompressing)
/// and the belt-and-braces post-decompression guard are two INDEPENDENT
/// checks — `rejects_an_entry_over_the_size_ceiling` above cannot tell them
/// apart because a well-formed archive's declared and actual sizes always
/// agree, so either guard alone rejects it. This isolates the declared-size
/// guard: the header LIES that the entry is huge while the actual Stored
/// bytes are tiny, so only the declared-size check can catch it — the
/// post-decompression guard sees a small `model.len()` and would admit it.
///
/// Coverage gap found via mutation testing: disabling the `entry.size() >
/// max_bytes` check (replacing its condition with `false`) left the entire
/// `ifczip_tests` module green (7/7 passed) because every other test's
/// declared and actual sizes coincide.
#[test]
fn declared_size_guard_fires_even_when_actual_bytes_are_small() {
    let content = "tiny"; // 4 actual bytes
    let zip = make_zip(&[("model.ifc", content)]);
    let lying_zip = lie_about_uncompressed_size(zip, 5_000_000);

    // Sanity: the lie took — an ordinary archive of this content is nowhere
    // near the ceiling used below, so a pass here would mean the guard never
    // engaged at all rather than the lie failing to apply.
    let honest_zip = make_zip(&[("model.ifc", content)]);
    unwrap_ifczip(&honest_zip, 1_000, 1).expect("an honest 4-byte entry is admitted");

    let err = unwrap_ifczip(&lying_zip, 1_000, 1).unwrap_err();
    assert!(
        matches!(err, ApiError::FileTooLarge { max_mb: 1 }),
        "the declared (lying) size must be rejected before decompression, got {err:?}"
    );
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
