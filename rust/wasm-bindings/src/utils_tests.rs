// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`] (panic-location sanitisation). Split into a
//! `*_tests.rs` file (module-size-ratchet exempt) and attached via `#[path]`.
//!
//! `sanitize_panic_path` feeds the `__ifclite_wasm_panic` stash that the
//! viewer's analytics scrub attaches to a wasm trap's exception event
//! (issues #1196 / #2527), so its contract is privacy-critical: whatever it
//! returns may leave the browser. No build-machine prefix — and in particular
//! no username — may survive.

use super::sanitize_panic_path;

#[test]
fn workspace_relative_path_passes_through() {
    // The common case: cargo compiles workspace members with workspace-relative
    // paths, which carry nothing about the build machine.
    assert_eq!(
        sanitize_panic_path("wasm-bindings/src/lib.rs"),
        "wasm-bindings/src/lib.rs"
    );
    assert_eq!(
        sanitize_panic_path("geometry/src/mesh_weld.rs"),
        "geometry/src/mesh_weld.rs"
    );
}

#[test]
fn registry_dependency_keeps_crate_and_version_only() {
    // A dependency panic reports the absolute cargo-registry path of the build
    // machine; everything through the registry index segment goes, the
    // `<crate>-<version>/…` tail (the useful identity) stays.
    assert_eq!(
        sanitize_panic_path(
            "/Users/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/serde-1.0.219/src/de/mod.rs"
        ),
        "serde-1.0.219/src/de/mod.rs"
    );
}

#[test]
fn absolute_workspace_path_is_cut_at_the_rust_root() {
    // CI checkouts can surface absolute paths; the deepest `rust/` segment is
    // the workspace root, so the tail from there is the stable identity.
    assert_eq!(
        sanitize_panic_path("/home/runner/work/ifc-lite/ifc-lite/rust/geometry/src/csg/mesh.rs"),
        "rust/geometry/src/csg/mesh.rs"
    );
}

#[test]
fn rustc_std_path_keeps_a_short_tail() {
    // A panic attributed inside std reports the rustc source mapping; the last
    // few segments identify it, the hash prefix is noise.
    let out = sanitize_panic_path("/rustc/07dca489ac2d933c78d3c5158e3f43beefeb02ce/library/core/src/slice/index.rs");
    assert_eq!(out, "core/src/slice/index.rs");
}

#[test]
fn windows_separators_are_unified_and_cut() {
    assert_eq!(
        sanitize_panic_path(r"C:\build\ifc-lite\rust\core\src\decode.rs"),
        "rust/core/src/decode.rs"
    );
}

#[test]
fn a_local_username_never_survives() {
    // A shallow local build path must not leak the account name even through
    // the generic keep-a-tail fallback.
    let out = sanitize_panic_path("/Users/petesmith/scratch/lib.rs");
    assert!(!out.contains("petesmith"), "username leaked: {out}");
    let home = sanitize_panic_path("/home/petesmith/scratch/lib.rs");
    assert!(!home.contains("petesmith"), "username leaked: {home}");
}

#[test]
fn unrecognised_absolute_path_keeps_at_most_a_short_tail() {
    let out = sanitize_panic_path("/opt/some/very/deep/build/tree/crate/src/lib.rs");
    assert_eq!(out, "tree/crate/src/lib.rs");
}
