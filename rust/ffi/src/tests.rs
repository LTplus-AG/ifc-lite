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
        instances: Vec::new(),
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
    // A realistic georeferenced placement: easting/northing far from the
    // origin, elevation a normal building height. The Z component must stay
    // *below* `LARGE_COORD_THRESHOLD`, otherwise all three components exceed
    // it and the guard's `&&` is indistinguishable from `||` — the shift
    // happens either way and the conjunction goes untested.
    let (tx, ty, tz) = (123456.0, -7000.5, 2.0);
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

/// Pin the boundary's sharpness on EACH axis independently, *relative to
/// whatever `LARGE_COORD_THRESHOLD` currently is*: a translation just above
/// the constant on any one axis must shift, just below must not. The guard is
/// a three-way conjunction, so one axis proves nothing about the other two.
/// With only the x cases present, the `ty` and `tz` conjuncts could each be
/// deleted outright and all 11 tests still passed (#2936). The other two
/// fixtures straddle it by roughly five orders of magnitude (1.0 vs
/// 123456.0), so any threshold anywhere in between would satisfy them both —
/// this fixture closes that gap for the *boundary behavior*.
///
/// This does **not** pin the constant's *value*: every value used below is
/// derived from `LARGE_COORD_THRESHOLD` itself, so the fixture is green for
/// any value of the constant. The `assert_eq!` immediately below is what
/// actually pins the documented 1 km contract (see `LARGE_COORD_THRESHOLD`'s
/// doc comment on lib.rs) — mutate the constant and this assertion, not the
/// bracketing below, is what fails.
#[test]
fn the_large_coordinate_threshold_is_bracketed_on_both_sides() {
    assert_eq!(
        LARGE_COORD_THRESHOLD, 1000.0,
        "documented contract is 1 km; the bracketing below derives from this constant and would follow it to any value"
    );

    for (translation, should_shift) in [
        ([LARGE_COORD_THRESHOLD + 0.5, 0.0, 0.0], true),
        ([LARGE_COORD_THRESHOLD - 0.5, 0.0, 0.0], false),
        // The "untouched" guard is strictly `<`: a translation sitting
        // exactly on the threshold is NOT `< THRESHOLD`, so it falls through
        // and shifts, same as anything past it. The two brackets above sit
        // half a unit off the boundary in either direction, so neither can
        // tell `<` from `<=` apart — both compile and pass identically
        // either way. This closes that gap.
        ([LARGE_COORD_THRESHOLD, 0.0, 0.0], true),
        // The same three brackets on y and on z: the guard ANDs the three
        // axes, so each conjunct needs its own boundary.
        ([0.0, LARGE_COORD_THRESHOLD + 0.5, 0.0], true),
        ([0.0, LARGE_COORD_THRESHOLD - 0.5, 0.0], false),
        ([0.0, LARGE_COORD_THRESHOLD, 0.0], true),
        ([0.0, 0.0, LARGE_COORD_THRESHOLD + 0.5], true),
        ([0.0, 0.0, LARGE_COORD_THRESHOLD - 0.5], false),
        ([0.0, 0.0, LARGE_COORD_THRESHOLD], true),
    ] {
        let [tx, ty, tz] = translation;
        let original = processing_result(
            Some(RAW_IFC_MESH_COORDINATE_SPACE),
            Some(transform_with_translation(tx, ty, tz)),
        );
        let original_positions_a = original.meshes[0].positions.clone();

        let mut result = original;
        normalize_to_site_local(&mut result);

        if should_shift {
            assert_eq!(
                result.mesh_coordinate_space.as_deref(),
                Some(SITE_LOCAL_MESH_COORDINATE_SPACE),
                "({tx}, {ty}, {tz}) is at or past the threshold and must be shifted"
            );
            let expected_a: Vec<f32> = original_positions_a
                .chunks_exact(3)
                .flat_map(|c| {
                    [
                        (c[0] as f64 - tx) as f32,
                        (c[1] as f64 - ty) as f32,
                        (c[2] as f64 - tz) as f32,
                    ]
                })
                .collect();
            assert_eq!(result.meshes[0].positions, expected_a);
        } else {
            assert_eq!(
                result.mesh_coordinate_space.as_deref(),
                Some(RAW_IFC_MESH_COORDINATE_SPACE),
                "({tx}, {ty}, {tz}) is inside the threshold and must be left alone"
            );
            assert_eq!(result.meshes[0].positions, original_positions_a);
        }
    }
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

/// The `f64` intermediate in `normalize_to_site_local` is load-bearing, and
/// until this test nothing observed it: rewriting all three lines to
/// `chunk[0] = chunk[0] - site_tx as f32` left the whole suite green (#2950).
///
/// Every other fixture in this file uses coordinates (0, 1, 2, 3, 10, -5, 2.5)
/// and translations (1.0, 123456.0, 1000.5) that are all exactly representable
/// in f32. For those, `(v as f64 - t) as f32` and `v - (t as f32)` agree bit
/// for bit, so no assertion could separate the two orderings. The tests were
/// correct and the property was simply invisible to them.
///
/// The magnitude is real: 7_011_526 is a VERTEX northing taken from
/// `tests/models/issues/860_solid_stratum.ifc` (EPSG:28356, MGA94 Zone 56).
/// It is not that file's SITE northing — its `IFCSITE` placement is identity,
/// so that file returns at this function's first guard and its geometry is
/// unaffected either way. The fixture borrows the scale, nothing else.
///
/// At that scale an f32 ULP is 0.5, so rounding the translation to f32 FIRST
/// snaps it onto the same representable value as the vertex and the offset
/// collapses to exactly zero:
///
///   vertex   7_011_526.5   (exact in f32: 14_023_053 / 2, 24 bits)
///   site     7_011_526.3
///   f64 then narrow ->  0.2        (0x3e4ccccd)
///   narrow then f32  ->  0.0        (0x00000000)
///
/// A 200 mm offset becomes no offset at all, silently. That is the whole
/// reason the subtraction widens first.
///
/// REACHABILITY, stated because the test would otherwise imply more than it
/// proves: no fixture reaches this loop today, and arguably nothing can.
/// `processor/mod.rs:1098` picks `raw_ifc` only when the site translation is
/// identity (within 1e-9), and this function returns early unless the space IS
/// `raw_ifc` AND the translation exceeds LARGE_COORD_THRESHOLD (1000.0). Those
/// two conditions contradict, so the combination is not one the pipeline can
/// emit — measured: 113 corpus files parsed, 103 came back `raw_ifc`, 0 reached
/// this loop. This test therefore pins the function's own documented contract,
/// not observable render output, and it is worth having for the day that
/// pipeline branch changes rather than as protection for geometry shipping
/// today.
///
/// Asserted on exact f32 bits rather than an epsilon: an epsilon wide enough
/// to feel safe here is wider than the 0.2 the bug destroys.
#[test]
fn the_subtraction_widens_to_f64_before_narrowing() {
    // A vertex one ULP-ish above the site translation, at georeferenced scale.
    const VERTEX_Y: f32 = 7_011_526.5;
    const SITE_TY: f64 = 7_011_526.3;

    let mesh = MeshData::new(
        1,
        "IfcWall".to_string(),
        vec![0.0, VERTEX_Y, 0.0],
        vec![0.0, 0.0, 1.0],
        vec![0],
        [1.0, 1.0, 1.0, 1.0],
    );
    let mut result = ProcessingResult {
        meshes: vec![mesh],
        instances: Vec::new(),
        mesh_coordinate_space: Some(RAW_IFC_MESH_COORDINATE_SPACE.to_string()),
        site_transform: Some(transform_with_translation(0.0, SITE_TY, 0.0).to_vec()),
        building_transform: None,
        metadata: ModelMetadata::default(),
        stats: ProcessingStats::default(),
    };

    normalize_to_site_local(&mut result);

    let got = result.meshes[0].positions[1];
    // The literal, not a recomputation of the production expression: an oracle
    // that recomputes what it is testing shares any mistake in it.
    let widened = f32::from_bits(0x3e4c_cccd);
    debug_assert_eq!(widened, (VERTEX_Y as f64 - SITE_TY) as f32);
    let narrowed_first = VERTEX_Y - SITE_TY as f32;

    // The control: the two orderings really do differ on this fixture, so the
    // assertion below is capable of failing. Without this, a fixture that
    // cannot distinguish them would make the test vacuous in exactly the way
    // #2950 describes.
    assert_ne!(
        widened.to_bits(),
        narrowed_first.to_bits(),
        "fixture cannot distinguish the two orderings; it proves nothing"
    );
    assert_eq!(
        narrowed_first, 0.0,
        "the f32-first ordering should destroy the offset entirely here"
    );

    assert_eq!(
        got.to_bits(),
        widened.to_bits(),
        "expected the f64-widened result {widened} (0x{:08x}), got {got} (0x{:08x}) \
         — the subtraction narrowed to f32 before subtracting",
        widened.to_bits(),
        got.to_bits()
    );
}
