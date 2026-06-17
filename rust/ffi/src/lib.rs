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
//! Build: `cargo build --release -p ifc-lite-ffi`
//! Output: `target/release/ifc_lite_ffi.dll`

use ifc_lite_processing::{
    process_geometry, process_geometry_filtered, OpeningFilterMode, ParseResponse, ProcessingResult,
};
use std::backtrace::Backtrace;
use std::cell::RefCell;
use std::io::Write;
use std::slice;
use std::sync::{Once, OnceLock};

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
fn parse_pool() -> &'static rayon::ThreadPool {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .stack_size(PARSE_STACK_SIZE)
            .thread_name(|i| format!("ifc-lite-parse-{i}"))
            .build()
            .expect("failed to build ifc-lite parse thread pool")
    })
}

thread_local! {
    /// Path of the IFC file currently being parsed on this thread, so the panic hook
    /// can name the offending file. Empty when no parse is in flight.
    static CURRENT_IFC_PATH: RefCell<String> = const { RefCell::new(String::new()) };
}

static PANIC_HOOK_INIT: Once = Once::new();

/// Installs a process-wide panic hook exactly once.
///
/// The hook appends the IFC path being parsed, the panic message/location and a
/// captured backtrace to `%TEMP%/ifc_lite_panic.log`, then chains to the previous
/// hook (preserving the default stderr output). Panic hooks run *before* the runtime
/// unwinds or aborts, so this leaves a breadcrumb identifying the file even in a
/// `panic = "abort"` build where `catch_unwind` cannot recover.
fn ensure_panic_logging() {
    PANIC_HOOK_INIT.call_once(|| {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let path = CURRENT_IFC_PATH.with(|p| p.borrow().clone());
            let backtrace = Backtrace::force_capture();
            let log_path = std::env::temp_dir().join("ifc_lite_panic.log");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                let _ = writeln!(
                    file,
                    "==== ifc-lite panic ====\nfile: {}\n{info}\nbacktrace:\n{backtrace}\n",
                    if path.is_empty() { "<unknown>" } else { &path },
                );
            }

            previous_hook(info);
        }));
    });
}

/// Threshold in meters. If a mesh's first vertex exceeds this magnitude,
/// the mesh is still in world-space and needs the site translation subtracted.
/// Meshes already in site-local space will have coordinates well below this.
const LARGE_COORD_THRESHOLD: f64 = 1000.0;

/// Post-process meshes to ensure all positions are in uniform site-local coordinates.
///
/// With the site-translation-as-RTC approach, most meshes are already site-local
/// after `transform_mesh`. This catches any stragglers whose placement/vertices
/// didn't trigger the RTC path (e.g. meshes with small local coords and identity
/// placement that were already site-local in the IFC file).
fn normalize_to_site_local(result: &mut ProcessingResult) {
    let site_tx: f64;
    let site_ty: f64;
    let site_tz: f64;

    if let Some(ref st) = result.site_transform {
        if st.len() >= 16 {
            // Column-major 4x4: translation at indices 12, 13, 14
            site_tx = st[12];
            site_ty = st[13];
            site_tz = st[14];
        } else {
            return;
        }
    } else {
        return;
    }

    // If site translation is near zero, nothing to normalize
    if site_tx.abs() < LARGE_COORD_THRESHOLD
        && site_ty.abs() < LARGE_COORD_THRESHOLD
        && site_tz.abs() < LARGE_COORD_THRESHOLD
    {
        return;
    }

    for mesh in &mut result.meshes {
        if mesh.positions.len() < 3 {
            continue;
        }

        // Check first vertex to detect coordinate space
        let vx = mesh.positions[0].abs() as f64;
        let vy = mesh.positions[1].abs() as f64;
        let vz = mesh.positions[2].abs() as f64;
        let mag = vx.max(vy).max(vz);

        if mag <= LARGE_COORD_THRESHOLD {
            // Already in site-local space (RTC was applied by upstream pipeline)
            continue;
        }

        // Still in world-space — subtract site translation with f64 precision
        for chunk in mesh.positions.chunks_exact_mut(3) {
            chunk[0] = (chunk[0] as f64 - site_tx) as f32;
            chunk[1] = (chunk[1] as f64 - site_ty) as f32;
            chunk[2] = (chunk[2] as f64 - site_tz) as f32;
        }
    }
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
/// - `1` if the path is invalid UTF-8
/// - `2` if the file cannot be read
/// - `3` if geometry processing fails
/// - `4` if JSON serialization fails
///
/// # Safety
/// Caller must free the returned buffer with `ifc_lite_free`.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_parse(
    path_ptr: *const u8,
    path_len: usize,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    ensure_panic_logging();

    let path_bytes = slice::from_raw_parts(path_ptr, path_len);
    let path_str = match std::str::from_utf8(path_bytes) {
        Ok(s) => s,
        Err(_) => return 1,
    };

    let content = match std::fs::read_to_string(path_str) {
        Ok(c) => c,
        Err(_) => return 2,
    };

    CURRENT_IFC_PATH.with(|p| *p.borrow_mut() = path_str.to_string());

    let result = parse_pool().install(|| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| process_geometry(&content)))
    });

    CURRENT_IFC_PATH.with(|p| p.borrow_mut().clear());

    let mut result = match result {
        Ok(r) => r,
        Err(_) => return 3,
    };

    // Normalize all meshes to uniform site-local coordinates
    normalize_to_site_local(&mut result);

    let response = ParseResponse {
        cache_key: String::new(),
        meshes: result.meshes,
        mesh_coordinate_space: result.mesh_coordinate_space,
        site_transform: result.site_transform,
        building_transform: result.building_transform,
        metadata: result.metadata,
        stats: result.stats,
        // This fork's `ParseResponse` carries 2D symbol data; the FFI parse path
        // is geometry-only, so emit an empty (default) set. `ProcessingResult`
        // has no `symbolic_data` to forward here.
        symbolic_data: Default::default(),
    };

    let json_bytes = match serde_json::to_vec(&response) {
        Ok(b) => b,
        Err(_) => return 4,
    };

    let len = json_bytes.len();
    let ptr = Box::into_raw(json_bytes.into_boxed_slice()) as *mut u8;

    *out_ptr = ptr;
    *out_len = len;

    0
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
/// Same error codes as `ifc_lite_parse`.
///
/// # Safety
/// Caller must free the returned buffer with `ifc_lite_free`.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_parse_ex(
    path_ptr: *const u8,
    path_len: usize,
    opening_filter_mode: i32,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    ensure_panic_logging();

    let path_bytes = slice::from_raw_parts(path_ptr, path_len);
    let path_str = match std::str::from_utf8(path_bytes) {
        Ok(s) => s,
        Err(_) => return 1,
    };

    let content = match std::fs::read_to_string(path_str) {
        Ok(c) => c,
        Err(_) => return 2,
    };

    let mode = match opening_filter_mode {
        1 => OpeningFilterMode::IgnoreAll,
        2 => OpeningFilterMode::IgnoreOpaque,
        _ => OpeningFilterMode::Default,
    };

    CURRENT_IFC_PATH.with(|p| *p.borrow_mut() = path_str.to_string());

    let result = parse_pool().install(|| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            process_geometry_filtered(&content, mode)
        }))
    });

    CURRENT_IFC_PATH.with(|p| p.borrow_mut().clear());

    let mut result = match result {
        Ok(r) => r,
        Err(_) => return 3,
    };

    // Normalize all meshes to uniform site-local coordinates
    normalize_to_site_local(&mut result);

    let response = ParseResponse {
        cache_key: String::new(),
        meshes: result.meshes,
        mesh_coordinate_space: result.mesh_coordinate_space,
        site_transform: result.site_transform,
        building_transform: result.building_transform,
        metadata: result.metadata,
        stats: result.stats,
        // See `ifc_lite_parse`: geometry-only path, emit empty symbol data.
        symbolic_data: Default::default(),
    };

    let json_bytes = match serde_json::to_vec(&response) {
        Ok(b) => b,
        Err(_) => return 4,
    };

    let len = json_bytes.len();
    let ptr = Box::into_raw(json_bytes.into_boxed_slice()) as *mut u8;

    *out_ptr = ptr;
    *out_len = len;

    0
}

/// Free a buffer previously returned by `ifc_lite_parse` or `ifc_lite_parse_ex`.
///
/// # Safety
/// `ptr` and `len` must match a previous return from a parse function.
/// Must not be called more than once for the same buffer.
#[no_mangle]
pub unsafe extern "C" fn ifc_lite_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        let _ = Box::from_raw(slice::from_raw_parts_mut(ptr, len));
    }
}
