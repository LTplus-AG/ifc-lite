//! Smoke tests for the FFI boundary itself — pointer validation, error codes,
//! the parse→serialize→free round trip, and the `opening_filter_mode` mapping.
//! Geometry correctness is covered by the `geometry`/`processing` crates; here
//! we only assert the C ABI contract documented on the exported functions.

use super::*;
use ifc_lite_processing::{MeshData, ModelMetadata, ProcessingStats};
use std::ptr;

/// Builds a minimal [`ProcessingResult`] carrying two meshes with distinct,
/// easy-to-check positions, tagged with the given coordinate space and
/// (optional) column-major 4x4 site transform.
fn processing_result(
    mesh_coordinate_space: Option<&str>,
    site_transform: Option<[f64; 16]>,
) -> ProcessingResult {
    let mesh_a = MeshData::new(
        1,
        "IfcWall".to_string(),
        vec![0.0, 0.0, 0.0, 1.0, 2.0, 3.0],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![0, 1, 0],
        [1.0, 1.0, 1.0, 1.0],
    );
    let mesh_b = MeshData::new(
        2,
        "IfcSlab".to_string(),
        vec![10.0, -5.0, 2.5],
        vec![0.0, 0.0, 1.0],
        vec![0],
        [0.5, 0.5, 0.5, 1.0],
    );

    ProcessingResult {
        meshes: vec![mesh_a, mesh_b],
        mesh_coordinate_space: mesh_coordinate_space.map(str::to_string),
        site_transform: site_transform.map(|m| m.to_vec()),
        building_transform: None,
        metadata: ModelMetadata::default(),
        stats: ProcessingStats::default(),
    }
}

/// A column-major identity 4x4 with the translation column (indices 12/13/14)
/// overridden — the layout `normalize_to_site_local` reads.
fn transform_with_translation(tx: f64, ty: f64, tz: f64) -> [f64; 16] {
    let mut m = [0.0; 16];
    m[0] = 1.0;
    m[5] = 1.0;
    m[10] = 1.0;
    m[15] = 1.0;
    m[12] = tx;
    m[13] = ty;
    m[14] = tz;
    m
}

/// `raw_ifc` + a site translation past `LARGE_COORD_THRESHOLD` must subtract
/// that translation from every mesh's positions and relabel the result as
/// `site_local` (see `normalize_to_site_local` doc comment, lib.rs:~110-135).
#[test]
fn raw_ifc_with_large_site_translation_shifts_all_meshes_and_relabels() {
    let (tx, ty, tz) = (123456.0, -7000.5, 2000.0);
    let mut result = processing_result(
        Some(RAW_IFC_MESH_COORDINATE_SPACE),
        Some(transform_with_translation(tx, ty, tz)),
    );

    normalize_to_site_local(&mut result);

    assert_eq!(
        result.mesh_coordinate_space.as_deref(),
        Some(SITE_LOCAL_MESH_COORDINATE_SPACE),
        "raw_ifc meshes shifted by the site translation must be relabeled site_local"
    );

    // mesh_a: two vertices, each shifted by (tx, ty, tz).
    let expected_a = [
        (0.0 - tx) as f32,
        (0.0 - ty) as f32,
        (0.0 - tz) as f32,
        (1.0 - tx) as f32,
        (2.0 - ty) as f32,
        (3.0 - tz) as f32,
    ];
    assert_eq!(result.meshes[0].positions, expected_a);

    // mesh_b: one vertex, same shift.
    let expected_b = [(10.0 - tx) as f32, (-5.0 - ty) as f32, (2.5 - tz) as f32];
    assert_eq!(result.meshes[1].positions, expected_b);
}

/// `raw_ifc` with a site translation *inside* `LARGE_COORD_THRESHOLD` (near
/// the origin) has nothing worth subtracting: positions and the coordinate
/// space label must both be left exactly as they came in.
#[test]
fn raw_ifc_with_near_origin_site_translation_is_left_untouched() {
    let original = processing_result(
        Some(RAW_IFC_MESH_COORDINATE_SPACE),
        Some(transform_with_translation(1.0, -2.0, 0.5)),
    );
    let original_positions_a = original.meshes[0].positions.clone();
    let original_positions_b = original.meshes[1].positions.clone();

    let mut result = original;
    normalize_to_site_local(&mut result);

    assert_eq!(
        result.mesh_coordinate_space.as_deref(),
        Some(RAW_IFC_MESH_COORDINATE_SPACE),
        "a near-origin site translation must not be relabeled"
    );
    assert_eq!(result.meshes[0].positions, original_positions_a);
    assert_eq!(result.meshes[1].positions, original_positions_b);
}

/// `site_local`, `model_rtc`, and `None` are all coordinate spaces the
/// pipeline has already anchored upstream (or declined to tag). Even with a
/// far-from-origin site transform present, `normalize_to_site_local` must
/// never touch mesh positions for these — subtracting again would
/// double-offset geometry that's already anchored (the exact bug the
/// function's doc comment warns about for `model_rtc`).
#[test]
fn non_raw_ifc_spaces_are_never_shifted_even_with_a_far_site_transform() {
    let far_transform = Some(transform_with_translation(500_000.0, 500_000.0, 500_000.0));

    for space in [
        Some(SITE_LOCAL_MESH_COORDINATE_SPACE),
        Some("model_rtc"),
        None,
    ] {
        let original = processing_result(space, far_transform);
        let original_positions_a = original.meshes[0].positions.clone();
        let original_positions_b = original.meshes[1].positions.clone();
        let original_space = original.mesh_coordinate_space.clone();

        let mut result = original;
        normalize_to_site_local(&mut result);

        assert_eq!(
            result.mesh_coordinate_space, original_space,
            "coordinate space {space:?} must not be relabeled"
        );
        assert_eq!(result.meshes[0].positions, original_positions_a);
        assert_eq!(result.meshes[1].positions, original_positions_b);
    }
}

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
