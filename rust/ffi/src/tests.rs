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

/// Every failing return leaves `*out_ptr` / `*out_len` as null / 0, never as
/// the host's previous values: the error paths used to skip the writes, so a
/// host that frees on "ptr is non-null" freed an old buffer twice (#4614). The
/// variables start stale and non-null, as a reused pair would after a
/// successful call. Mutation that fails this test: delete the two
/// out-parameter writes at the top of `run_parse`.
#[test]
fn error_returns_write_null_and_zero_through_the_out_parameters() {
    let mut stale_buffer = [0u8; 4];
    let missing = temp_path("out_params_missing");
    let _ = std::fs::remove_file(&missing);
    let missing_str = missing.to_str().unwrap();
    let bad_utf8 = [0xff_u8, 0xfe];

    // (code, path pointer, path length) for each error path a host can reach
    // with valid out-pointers.
    let cases: [(i32, *const u8, usize); 3] = [
        (2, missing_str.as_ptr(), missing_str.len()),
        (1, bad_utf8.as_ptr(), bad_utf8.len()),
        (1, ptr::null(), 0),
    ];
    for (expected_code, path_ptr, path_len) in cases {
        for extended in [false, true] {
            let mut out_ptr: *mut u8 = stale_buffer.as_mut_ptr();
            let mut out_len: usize = stale_buffer.len();
            let code = unsafe {
                if extended {
                    ifc_lite_parse_ex(path_ptr, path_len, 0, &mut out_ptr, &mut out_len)
                } else {
                    ifc_lite_parse(path_ptr, path_len, &mut out_ptr, &mut out_len)
                }
            };
            assert_eq!(code, expected_code, "extended={extended}");
            assert!(out_ptr.is_null(), "code {code} (extended={extended}) must null *out_ptr");
            assert_eq!(out_len, 0, "code {code} (extended={extended}) must zero *out_len");
        }
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

/// The panic log must name the file whose parse panicked. The panic hook runs
/// on the pool worker that panicked, and the path used to live in a
/// thread-local written on the caller's thread, so every entry said
/// `file: <unknown>` (#4614). Mutation that fails this test: drop the
/// `InFlightPath::register` call in `run_in_pool`.
#[test]
fn panic_log_names_the_file_when_the_panic_happens_on_a_pool_worker() {
    ensure_panic_logging();
    // A tag no other test or earlier run could have written: process id plus
    // a wall-clock nanosecond stamp, so the assertion reads THIS entry.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let probe_path = format!("hook_probe_{}_{stamp}.ifc", std::process::id());

    let outcome = run_in_pool::<()>(&probe_path, || panic!("hook probe"));
    assert_eq!(outcome, Err(3), "a panic on the pool is error code 3");

    let log = std::fs::read_to_string(std::env::temp_dir().join("ifc_lite_panic.log"))
        .expect("the panic hook must have written the log");
    // Other tests parse concurrently on the shared pool, so the entry may list
    // their paths beside this one; the probe must be among them.
    assert!(
        log.lines().any(|l| l.starts_with("file: ") && l.contains(&probe_path)),
        "no `file:` line in the panic log names {probe_path:?}"
    );

    // The registration is scoped to the call (its guard drops during the
    // unwind), so a later unrelated panic must not be blamed on this file.
    // Other tests parse concurrently, so only this path's absence is asserted.
    assert!(!crate::panic_log::in_flight_paths_for_log().contains(&probe_path));
}

/// `run_in_pool` is the one `catch_unwind` on the parse path, and
/// `parse_impl` hands it geometry, normalisation and serialisation as one
/// closure (a panic in any of them used to unwind out of the `extern "C"`
/// function and abort the host, #4614). A panic there is code 3 (pinned by
/// the test above); the closure's own code and value pass through.
#[test]
fn run_in_pool_passes_the_closure_outcome_through() {
    assert_eq!(run_in_pool::<()>("code_probe.ifc", || Err(4)), Err(4));
    assert_eq!(run_in_pool("ok_probe.ifc", || Ok(7)), Ok(7));
}

/// Building the large-stack pool used to `.expect` on the `extern "C"` path
/// (#4614). A 2^62-byte stack, past any 64-bit address space, makes the thread
/// spawn fail for real; the build must be an `Err`, which the caller maps to
/// code 3. Mutation that fails this test: panic on the build error inside
/// `build_parse_pool`, as the old `.expect` did.
#[cfg(target_pointer_width = "64")]
#[test]
fn a_pool_that_cannot_spawn_its_threads_is_an_error_not_a_panic() {
    assert!(build_parse_pool(1 << 62).is_err());
}

/// Panic records appended from many threads at once come out whole and none
/// is lost (#4642). Mutation that fails this test: remove the `LOG_WRITE`
/// lock in `append_record`.
#[test]
fn concurrent_panic_records_do_not_interleave() {
    let log = temp_path("panic_interleave_log");
    let _ = std::fs::remove_file(&log);
    std::thread::scope(|scope| {
        for t in 0..8 {
            let log = &log;
            scope.spawn(move || {
                for r in 0..200 {
                    let id = format!("t{t}r{r}");
                    crate::panic_log::append_record(log, &id, &id, &id);
                }
            });
        }
    });
    let text = std::fs::read_to_string(&log).expect("records were written");
    let _ = std::fs::remove_file(&log);
    let mut records: Vec<&str> = text.split("==== ifc-lite panic ====\n").skip(1).collect();
    let mut expected: Vec<String> = (0..8)
        .flat_map(|t| (0..200).map(move |r| format!("t{t}r{r}")))
        .map(|id| format!("file: {id}\n{id}\nbacktrace:\n{id}\n\n"))
        .collect();
    records.sort_unstable();
    expected.sort_unstable();
    assert!(records == expected, "panic records interleaved, went missing or were duplicated");
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
