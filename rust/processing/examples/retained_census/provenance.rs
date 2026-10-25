// SPDX-License-Identifier: MPL-2.0
//! Compilation identity is a trusted build input, never runtime checkout HEAD.
use serde::Serialize;
use std::process::Command;

// Set only by a clean source-pinned build command (see docs/guide/geometry.md).
// Cargo tracks option_env! in rustc dep-info and rebuilds when this input changes.
// Runtime environment variables cannot supply or replace the embedded value.
const BUILD_COMMIT: Option<&str> = option_env!("IFC_RETAINED_BUILD_COMMIT");

pub(in crate::logic) fn implementation_commit() -> Option<&'static str> {
    BUILD_COMMIT.filter(|value| valid_commit(value))
}

fn valid_commit(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Serialize)]
pub struct Provenance {
    pub implementation_commit: Option<&'static str>,
    pub binding: &'static str,
    // Observations about the invocation directory, explicitly not build inputs.
    pub runtime_checkout_commit: Option<String>,
    pub runtime_checkout_clean: Option<bool>,
}

pub(in crate::logic) fn current() -> Provenance {
    let implementation_commit = implementation_commit();
    Provenance {
        implementation_commit,
        binding: if implementation_commit.is_some() { "compile_time_source_pin" } else { "unbound" },
        runtime_checkout_commit: git(&["rev-parse", "HEAD"]).filter(|value| valid_commit(value)),
        runtime_checkout_clean: git(&["status", "--porcelain", "--untracked-files=normal"]).map(|value| value.is_empty()),
    }
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() { return None; }
    String::from_utf8(output.stdout).ok().map(|value| value.trim().into())
}

#[cfg(test)]
#[path = "provenance_tests.rs"]
mod tests;
