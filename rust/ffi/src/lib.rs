// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C FFI bindings for ifc-lite.
//!
//! Exports functions for use via P/Invoke from C#:
//! - `ifc_lite_parse`: parse an IFC file and return JSON bytes
//! - `ifc_lite_parse_ex`: parse with configurable opening filter
//! - `ifc_lite_free`: free a buffer previously returned by parse functions
//!
//! Build: `cargo build --profile server-release -p ifc-lite-ffi`
//! Output: `target/server-release/ifc_lite_ffi.dll`
//!
//! The `server-release` profile is mandatory, not a convenience: the workspace
//! default `release` profile sets `panic = 'abort'`, which turns the
//! `catch_unwind` guards below into no-ops. Built that way, a parser panic
//! aborts the entire host CAD process instead of returning error code `3`.
//! `server-release` inherits `release` but restores `panic = "unwind"`.

// Keep this declaration before every other item-level attribute. The revert
// oracle maps the sibling test module from here; placing it later in this long
// file can make an unrelated `#[cfg(...)]` look like its owner.
#[cfg(test)]
mod tests;

// Native global allocator (#1623): the platform system heap's global lock was
// ~70% of native geometry self-time and capped rayon scaling to ~1.8x on
// IfcMappedItem-heavy models; mimalloc's per-thread heaps lifted an all-cores
// geometry pass on a 462MB metering-station model 35s -> 16.7s (2.1x). Rust-only
// — the DLL's Rust allocations route through mimalloc; the host process's own
// malloc/free are untouched.
#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use ifc_lite_processing::{process_geometry_filtered, OpeningFilterMode, ParseResponse};
use panic_log::{ensure_panic_logging, InFlightPath};
use std::slice;
use std::sync::OnceLock;

mod panic_log;

/// Stack size for the geometry worker threads (256 MiB).
///
/// IFC geometry processing recurses deeply: BSP-tree CSG (via `csgrs`) and chains of nested
/// boolean clipping (e.g. a wall with hundreds of openings) build call stacks far past the
/// default ~1 MiB worker stack. Overflowing it hits the guard page and aborts the whole host
/// process (Rhino) with `STACK_OVERFLOW` (0xC00000FD) — no panic, no unwind, nothing
/// `catch_unwind` can intercept. A large stack gives that recursion room to complete.
const PARSE_STACK_SIZE: usize = 256 * 1024 * 1024;

/// Dedicated rayon pool whose worker threads have a large stack (see [`PARSE_STACK_SIZE`]).
///
/// The actual per-element geometry work runs inside `process_geometry` via
/// `par_iter` on rayon workers, so the recursion lives on *their* stacks — not the caller's.
/// Running the parse through `pool.install(..)` makes both the entry closure and every nested
/// `par_iter` use these large-stack workers. Built once and reused.
///
/// `None` when the pool cannot be built (the OS refused to spawn its threads).
/// That is error code `3` for the caller, never an `expect`: this runs on the
/// `extern "C"` path, and a panic unwinding out of an `extern "C"` function
/// aborts the host process. A failed build is not cached, so a later call
/// retries; two first calls racing may each build a pool, and the loser is
/// dropped.
fn parse_pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    if let Some(pool) = POOL.get() {
        return Some(pool);
    }
    let pool = build_parse_pool(PARSE_STACK_SIZE).ok()?;
    Some(POOL.get_or_init(|| pool))
}

fn build_parse_pool(stack_size: usize) -> Result<rayon::ThreadPool, rayon::ThreadPoolBuildError> {
    rayon::ThreadPoolBuilder::new()
        .stack_size(stack_size)
        .thread_name(|i| format!("ifc-lite-parse-{i}"))
        .build()
}

/// Run `work` on the large-stack pool with `path_str` registered as an
/// [`InFlightPath`] for the whole call, so a panic on any pool worker is logged
/// against this file.
///
/// One `catch_unwind` around the registration, the pool acquisition and all
/// of `work`: a panic anywhere in there is error code `3` instead of an unwind
/// out of the `extern "C"` function, which aborts the host. `install` carries
/// a worker's panic back to this thread, so the guard sits outside it.
fn run_in_pool<T: Send>(
    path_str: &str,
    work: impl FnOnce() -> Result<T, i32> + Send,
) -> Result<T, i32> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _in_flight = InFlightPath::register(path_str);
        parse_pool().ok_or(3)?.install(work)
    }))
    .unwrap_or(Err(3))
}

/// Shared body of both parse entry points: read the file, then on the
/// large-stack pool and under [`run_in_pool`]'s `catch_unwind` run geometry
/// processing and serialize the response to JSON bytes. The mesh frame comes
/// from the pipeline's one selector (#4643); nothing here re-anchors it.
///
/// Returns the JSON buffer on success, or one of the FFI error codes on failure
/// (`2` read, `3` panic or no pool, `4` serialization) — `0`/`1` are decided by
/// the wrappers, which own pointer validation.
fn parse_impl(path_str: &str, mode: OpeningFilterMode) -> Result<Vec<u8>, i32> {
    let content = std::fs::read_to_string(path_str).map_err(|_| 2)?;

    run_in_pool(path_str, move || {
        let result = process_geometry_filtered(&content, mode);
        // The source text is not needed past geometry; free it before the
        // JSON buffer is built next to the meshes.
        drop(content);

        let response = ParseResponse {
            cache_key: String::new(),
            meshes: result.meshes,
            mesh_coordinate_space: Some(result.mesh_coordinate_space),
            site_transform: result.site_transform,
            building_transform: result.building_transform,
            metadata: result.metadata,
            stats: result.stats,
            // This fork's `ParseResponse` carries 2D symbol data; the FFI parse path
            // is geometry-only, so emit an empty (default) set. `ProcessingResult`
            // has no `symbolic_data` to forward here.
            symbolic_data: Default::default(),
        };

        serde_json::to_vec(&response).map_err(|_| 4)
    })
}

/// Validate the path bytes and out-pointers, run [`parse_impl`], and write the
/// resulting buffer through the out-parameters. Shared by both exported
/// functions so the null checks and contract live in exactly one place.
///
/// # Safety
/// The caller upholds the contract stated on [`ifc_lite_parse`].
unsafe fn run_parse(
    path_ptr: *const u8,
    path_len: usize,
    mode: OpeningFilterMode,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    ensure_panic_logging();

    // Every return leaves each non-null out-parameter defined, so a host that
    // reuses the variables never sees a previous call's freed buffer.
    if !out_ptr.is_null() {
        *out_ptr = std::ptr::null_mut();
    }
    if !out_len.is_null() {
        *out_len = 0;
    }

    // Defensive null checks: a C#/P-Invoke marshalling slip would otherwise be
    // undefined behavior in `from_raw_parts` / the result writes below.
    if path_ptr.is_null() || out_ptr.is_null() || out_len.is_null() {
        return 1;
    }

    let path_bytes = slice::from_raw_parts(path_ptr, path_len);
    let path_str = match std::str::from_utf8(path_bytes) {
        Ok(s) => s,
        Err(_) => return 1,
    };

    let json_bytes = match parse_impl(path_str, mode) {
        Ok(b) => b,
        Err(code) => return code,
    };

    let len = json_bytes.len();
    let ptr = Box::into_raw(json_bytes.into_boxed_slice()) as *mut u8;

    *out_ptr = ptr;
    *out_len = len;

    0
}

/// Parse an IFC file and return JSON bytes.
///
/// # Arguments
/// - `path_ptr` / `path_len`: UTF-8 encoded file path
/// - `out_ptr`: receives pointer to allocated JSON bytes
/// - `out_len`: receives length of allocated JSON bytes
///
/// # Returns
/// - `0` on success
/// - `1` if a pointer is null or the path is invalid UTF-8
/// - `2` if the file cannot be read
/// - `3` if parsing panics or the worker pool cannot be started (a panic is
///   only recoverable in an unwinding build such as `server-release`; see the
///   module header)
/// - `4` if JSON serialization fails
///
/// On `0`, `*out_ptr` / `*out_len` describe the buffer. On every other code,
/// each of them that is non-null is set to null / 0, so a host may free on
/// "non-null" without re-zeroing between calls (`ifc_lite_free(NULL, 0)` is a
/// no-op).
///
/// # Safety
/// - `path_ptr` must be valid for reads of `path_len` bytes, all inside one
///   allocation, and `path_len` must not exceed `isize::MAX`. `path_len` is a
///   count of UTF-8 bytes: passing a UTF-16 length (a .NET `string.Length`)
///   for a non-ASCII path reads past the buffer. Only a null `path_ptr` is
///   detected; a wrong length is undefined behaviour, not error `1`.
/// - `out_ptr` and `out_len` must each be null or valid for writes and
///   properly aligned. Their storage must not overlap each other or the
///   allocation behind `path_ptr`: both are written before the path is read.
/// - A buffer returned on `0` must be freed exactly once, with
///   `ifc_lite_free` and the same `*out_len`.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_parse(
    path_ptr: *const u8,
    path_len: usize,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    run_parse(path_ptr, path_len, OpeningFilterMode::Default, out_ptr, out_len)
}

/// Parse an IFC file with a configurable opening filter and return JSON bytes.
///
/// # Arguments
/// - `path_ptr` / `path_len`: UTF-8 encoded file path
/// - `opening_filter_mode`: 0 = Default, 1 = IgnoreAll, 2 = IgnoreOpaque
/// - `out_ptr`: receives pointer to allocated JSON bytes
/// - `out_len`: receives length of allocated JSON bytes
///
/// # Returns
/// Same error codes and out-parameter states as `ifc_lite_parse`. An
/// unrecognised `opening_filter_mode` is treated as `0`.
///
/// # Safety
/// Same contract as `ifc_lite_parse`.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_parse_ex(
    path_ptr: *const u8,
    path_len: usize,
    opening_filter_mode: i32,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    let mode = match opening_filter_mode {
        1 => OpeningFilterMode::IgnoreAll,
        2 => OpeningFilterMode::IgnoreOpaque,
        _ => OpeningFilterMode::Default,
    };

    run_parse(path_ptr, path_len, mode, out_ptr, out_len)
}

/// Free a buffer previously returned by `ifc_lite_parse` or `ifc_lite_parse_ex`.
///
/// # Safety
/// `ptr` and `len` must be exactly a pointer and length written by a parse
/// function that returned `0`; any other length deallocates with the wrong
/// layout. Must not be called more than once for the same buffer. A null
/// `ptr` or a `len` of 0 is a no-op.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        let _ = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len));
    }
}
