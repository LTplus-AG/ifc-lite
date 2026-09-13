// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Smoke tests for the FFI boundary itself — pointer validation, error codes,
//! the parse→serialize→free round trip, and the `opening_filter_mode` mapping.
//! Geometry correctness is covered by the `geometry`/`processing` crates; here
//! we only assert the C ABI contract documented on the exported functions.

use super::*;
use std::ptr;

/// A self-contained, well-formed IFC4 file (no external fixture coupling).
/// Project-only: it parses successfully and yields an empty mesh set, which
/// still exercises the full read → process → serialize → allocate path.
const MINIMAL_IFC: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('minimal.ifc','2026-01-01T00:00:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Smoke Test',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
";

/// Unique temp path per test, so parallel runs don't collide.
fn temp_path(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("ifc_lite_ffi_smoke_{}_{tag}.ifc", std::process::id()))
}

#[test]
fn null_pointers_return_code_1() {
    let mut out_ptr: *mut u8 = ptr::null_mut();
    let mut out_len: usize = 0;
    let path = b"/nonexistent/whatever.ifc";

    unsafe {
        // null path pointer
        assert_eq!(
            ifc_lite_parse(ptr::null(), 0, &mut out_ptr, &mut out_len),
            1
        );
        // null out_ptr
        assert_eq!(
            ifc_lite_parse(path.as_ptr(), path.len(), ptr::null_mut(), &mut out_len),
            1
        );
        // null out_len
        assert_eq!(
            ifc_lite_parse(path.as_ptr(), path.len(), &mut out_ptr, ptr::null_mut()),
            1
        );
    }
}

#[test]
fn invalid_utf8_path_returns_code_1() {
    let bad = [0xff_u8, 0xfe, 0xfd];
    let mut out_ptr: *mut u8 = ptr::null_mut();
    let mut out_len: usize = 0;
    unsafe {
        assert_eq!(
            ifc_lite_parse(bad.as_ptr(), bad.len(), &mut out_ptr, &mut out_len),
            1
        );
    }
}

#[test]
fn nonexistent_file_returns_code_2() {
    let path = temp_path("does_not_exist");
    let _ = std::fs::remove_file(&path);
    let path_str = path.to_str().unwrap();
    let mut out_ptr: *mut u8 = ptr::null_mut();
    let mut out_len: usize = 0;
    unsafe {
        assert_eq!(
            ifc_lite_parse(path_str.as_ptr(), path_str.len(), &mut out_ptr, &mut out_len),
            2
        );
    }
}

#[test]
fn parses_minimal_ifc_then_frees() {
    let path = temp_path("minimal");
    std::fs::write(&path, MINIMAL_IFC).unwrap();
    let path_str = path.to_str().unwrap();

    let mut out_ptr: *mut u8 = ptr::null_mut();
    let mut out_len: usize = 0;
    let code = unsafe {
        ifc_lite_parse(path_str.as_ptr(), path_str.len(), &mut out_ptr, &mut out_len)
    };
    let _ = std::fs::remove_file(&path);

    assert_eq!(code, 0, "well-formed minimal IFC should parse");
    assert!(!out_ptr.is_null(), "success must hand back a buffer");
    assert!(out_len > 0, "buffer must be non-empty");

    // The documented contract is JSON bytes; confirm it decodes.
    let json = unsafe { slice::from_raw_parts(out_ptr, out_len) };
    let parsed: serde_json::Value = serde_json::from_slice(json).unwrap();
    assert!(parsed.is_object(), "response must be a JSON object");

    unsafe { ifc_lite_free(out_ptr, out_len) };
}

#[test]
fn parse_ex_maps_every_filter_mode() {
    let path = temp_path("ex");
    std::fs::write(&path, MINIMAL_IFC).unwrap();
    let path_str = path.to_str().unwrap();

    // 0/1/2 are the documented modes; an out-of-range value falls back to
    // Default rather than erroring.
    for mode in [0_i32, 1, 2, 99] {
        let mut out_ptr: *mut u8 = ptr::null_mut();
        let mut out_len: usize = 0;
        let code = unsafe {
            ifc_lite_parse_ex(
                path_str.as_ptr(),
                path_str.len(),
                mode,
                &mut out_ptr,
                &mut out_len,
            )
        };
        assert_eq!(code, 0, "opening_filter_mode {mode} should parse");
        assert!(!out_ptr.is_null());
        unsafe { ifc_lite_free(out_ptr, out_len) };
    }

    let _ = std::fs::remove_file(&path);
}

#[test]
fn free_tolerates_null_and_zero_len() {
    // Must be a no-op, never a double-free or segfault.
    unsafe {
        ifc_lite_free(ptr::null_mut(), 0);
        ifc_lite_free(ptr::null_mut(), 16);
    }
}

/// This crate pins `mimalloc` as the global allocator by default (#1623): the
/// platform system heap's global lock dominated native geometry self-time (~70%)
/// and capped rayon scaling. Guard that the geometry pipeline stays SOUND and
/// run-to-run DETERMINISTIC under the swapped allocator — a corrupt or racy
/// allocator would surface as empty/garbled meshes, or as two runs of the same
/// input disagreeing. The whole test binary runs under the crate's global
/// allocator (mimalloc unless built `--no-default-features`), so this doubles as
/// the guard that the allocator swap never alters geometry output.
#[test]
fn geometry_is_sound_and_deterministic_under_the_global_allocator() {
    let fixture = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../geometry/tests/fixtures/bath_csg_solid.ifc"
    );
    // Committed in-tree fixture (not a fetched `tests/models/` model), so it is
    // always present in a normal checkout — a read failure is a real error, not a
    // skip. Silently skipping would let this guard "pass" without exercising the
    // allocator at all.
    let ifc = std::fs::read_to_string(fixture)
        .unwrap_or_else(|e| panic!("read committed fixture {fixture}: {e}"));

    let a = ifc_lite_processing::process_geometry(&ifc);
    let b = ifc_lite_processing::process_geometry(&ifc);

    let tris: usize = a.meshes.iter().map(|m| m.indices.len() / 3).sum();
    assert!(tris > 0, "fixture must produce geometry under the global allocator");
    assert_eq!(a.meshes.len(), b.meshes.len(), "mesh count must be stable run-to-run");
    for (x, y) in a.meshes.iter().zip(&b.meshes) {
        assert_eq!(x.positions, y.positions, "positions must be deterministic");
        assert_eq!(x.indices, y.indices, "indices must be deterministic");
    }
}
