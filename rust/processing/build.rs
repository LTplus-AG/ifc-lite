// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Build identity for the native result cache (`src/result_cache`).
//!
//! A cached processing result is only valid for the exact engine that wrote
//! it. No hand-bumped revision constant can be trusted to change with every
//! geometry edit, so this script digests what the output can depend on:
//! the source of the three crates the pipeline is built from (core, geometry,
//! processing), the workspace lock file, the compiler, the target, the profile
//! and the rustc flags. Any change misses the cache. The digest reaches the
//! crate as `IFC_LITE_ENGINE_BUILD_DIGEST`.
//!
//! Skipped (digest `"none"`) when the `native-result-cache` feature is off or
//! the target is wasm32: no code reads it there. A packaged build without the
//! sibling crates digests the package version and toolchain only; crates.io
//! versions are immutable, so that stays a sound identity.

use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let enabled = env::var_os("CARGO_FEATURE_NATIVE_RESULT_CACHE").is_some()
        && env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32");
    let digest = if enabled { build_digest() } else { "none".to_string() };
    println!("cargo:rustc-env=IFC_LITE_ENGINE_BUILD_DIGEST={digest}");
}

fn build_digest() -> String {
    let mut hash = Sha256::new();
    let mut field = |name: &str, value: &[u8]| {
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value);
    };
    field("domain", b"ifc-lite-engine-build-v1");
    for var in [
        "CARGO_PKG_VERSION",
        "TARGET",
        "HOST",
        "PROFILE",
        "OPT_LEVEL",
        "DEBUG",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_CFG_TARGET_FEATURE",
        "CARGO_CFG_OVERFLOW_CHECKS",
        "CARGO_CFG_DEBUG_ASSERTIONS",
        "CARGO_CFG_PANIC",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
        field(var, env::var(var).unwrap_or_default().as_bytes());
    }
    let mut features: Vec<String> = env::vars().map(|(k, _)| k).filter(|k| k.starts_with("CARGO_FEATURE_")).collect();
    features.sort();
    field("features", features.join(",").as_bytes());
    field("rustc", &rustc_version());

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let rust_dir = manifest.parent().map(Path::to_path_buf).unwrap_or_default();
    let workspace = rust_dir.parent().map(Path::to_path_buf).unwrap_or_default();
    for krate in ["core", "geometry", "processing"] {
        let root = rust_dir.join(krate);
        let mut files = Vec::new();
        collect_files(&root.join("src"), &mut files);
        files.push(root.join("Cargo.toml"));
        files.sort();
        println!("cargo:rerun-if-changed={}", root.join("src").display());
        for file in files {
            let Ok(bytes) = fs::read(&file) else { continue };
            println!("cargo:rerun-if-changed={}", file.display());
            let rel = file.strip_prefix(&rust_dir).unwrap_or(&file);
            field(&rel.to_string_lossy(), &bytes);
        }
    }
    for name in ["Cargo.lock", "Cargo.toml"] {
        let path = workspace.join(name);
        if let Ok(bytes) = fs::read(&path) {
            println!("cargo:rerun-if-changed={}", path.display());
            field(name, &bytes);
        }
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn rustc_version() -> Vec<u8> {
    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    Command::new(rustc).arg("-vV").output().map(|out| out.stdout).unwrap_or_default()
}

/// Every regular file under `dir`, recursively; symlinks are not followed.
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            collect_files(&entry.path(), out);
        } else if kind.is_file() {
            out.push(entry.path());
        }
    }
}
