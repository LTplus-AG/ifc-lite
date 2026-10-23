// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The source-tree walk shared by the source-walking gates (`module_size_ratchet`,
//! `function_length_ratchet`, `styling_parity`): where the repo root is, how `.rs` files are
//! collected, and which of them the size rules do not bind.
//!
//! One implementation on purpose: two copies of the exemption list are two
//! chances to loosen one gate and not the other. The hard-error behaviour on a
//! missing or unreadable directory is the #3200 anti-vacuity hardening; see the
//! module docs of `module_size_ratchet`.

use std::path::{Path, PathBuf};

/// Repo root = first ancestor holding both `rust/` and `apps/`. `None` in a
/// packaged/standalone context (the gate then skips, see
/// [`super::refuse_to_skip_in_ci`]).
pub fn repo_root() -> Option<PathBuf> {
    let mut dir = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    loop {
        if dir.join("rust").is_dir() && dir.join("apps").is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Walk `dir`, collecting every `.rs` file underneath it.
///
/// A directory this cannot list is a hard error, and the two reasons are told
/// apart: a missing directory means the walk roots are wrong, an unreadable one
/// means the environment is. Neither means there are no offenders (#3200).
/// `gate` names the calling ratchet in the message.
pub fn collect_rs_files(gate: &str, dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => panic!(
            "{gate}: {} does not exist. Refusing to treat a missing \
             directory as one holding no .rs files - a walk root that is not \
             there means this gate is looking in the wrong place, not that the \
             tree is clean.",
            dir.display()
        ),
        Err(err) => panic!(
            "{gate}: {} could not be read ({err}). Refusing to treat \
             an unreadable directory as one holding no .rs files.",
            dir.display()
        ),
    };
    for entry in entries {
        let entry = entry.unwrap_or_else(|err| {
            panic!(
                "{gate}: an entry of {} could not be read ({err}). \
                 Refusing to walk past a file this gate could not classify.",
                dir.display()
            )
        });
        let path = entry.path();
        if path.is_dir() {
            let skip = matches!(
                path.file_name().and_then(|n| n.to_str()),
                Some("target" | "node_modules" | ".git" | "dist" | "build")
            );
            if !skip {
                collect_rs_files(gate, &path, out);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// Generated code and test/support files are not subject to the size rules.
pub fn is_exempt(rel: &str) -> bool {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    rel.contains("/generated/")
        || rel.contains("/tests/")
        || rel.contains("/examples/")
        || rel.contains("/benches/")
        || rel.contains("/fuzz/")
        // `#[cfg(test)]` module files embedded in src/ are test code, not
        // production modules subject to the split rule (e.g. src/tests.rs,
        // foo_tests.rs, foo_test.rs).
        || base == "tests.rs"
        || base.ends_with("_tests.rs")
        || base.ends_with("_test.rs")
}

/// Every non-exempt `.rs` file under `rust/` and `apps/` as
/// `(repo-relative path with '/', absolute path)`, sorted by path.
pub fn production_sources(gate: &str, root: &Path) -> Vec<(String, PathBuf)> {
    let mut paths = Vec::new();
    for top in ["rust", "apps"] {
        collect_rs_files(gate, &root.join(top), &mut paths);
    }
    let mut files: Vec<(String, PathBuf)> = paths
        .into_iter()
        .map(|p| {
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            (rel, p)
        })
        .filter(|(rel, _)| !is_exempt(rel))
        .collect();
    files.sort();
    files
}
