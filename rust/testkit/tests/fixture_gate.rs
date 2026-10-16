// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `IFC_LITE_REQUIRE_FIXTURES` policy, asserted in both directions
//! (issue #2802): an absent fixture skips when the gate is off and FAILS when
//! it is on. The pure decision is tested directly; the environment wiring is
//! tested end to end by re-running this binary with the variable set.

use ifc_lite_testkit::fixtures::{require_fixtures_from, resolve_bytes};
use std::env::VarError;
use std::ffi::OsString;
use std::io::{Error, ErrorKind};
use std::process::Command;

fn not_found() -> std::io::Result<Vec<u8>> {
    Err(Error::from(ErrorKind::NotFound))
}

fn lfs_pointer() -> Vec<u8> {
    format!("version {}{}v1\noid sha256:00\nsize 1\n", "https://git-lfs.github.com/", "spec/")
        .into_bytes()
}

#[test]
fn missing_fixture_skips_when_gate_off_and_panics_when_on() {
    assert_eq!(resolve_bytes("x.ifc", not_found(), false), None);
    let r = std::panic::catch_unwind(|| resolve_bytes("x.ifc", not_found(), true));
    assert!(r.is_err(), "gate on: a missing fixture must panic");
}

#[test]
fn lfs_pointer_skips_when_gate_off_and_panics_when_on() {
    assert_eq!(resolve_bytes("x.ifc", Ok(lfs_pointer()), false), None);
    let r = std::panic::catch_unwind(|| resolve_bytes("x.ifc", Ok(lfs_pointer()), true));
    assert!(r.is_err(), "gate on: an LFS pointer must panic");
}

#[test]
fn other_io_errors_always_panic() {
    for gate in [false, true] {
        let r = std::panic::catch_unwind(|| {
            resolve_bytes("x.ifc", Err(Error::from(ErrorKind::PermissionDenied)), gate)
        });
        assert!(r.is_err(), "gate {gate}: an unreadable fixture is a setup error");
    }
}

#[test]
fn present_fixture_is_returned_in_both_modes() {
    for gate in [false, true] {
        assert_eq!(resolve_bytes("x.ifc", Ok(b"ISO".to_vec()), gate), Some(b"ISO".to_vec()));
    }
}

#[test]
fn gate_parsing_is_strict_in_both_directions() {
    assert!(!require_fixtures_from(Err(VarError::NotPresent)));
    assert!(!require_fixtures_from(Ok(String::new())));
    assert!(!require_fixtures_from(Ok("0".into())));
    assert!(require_fixtures_from(Ok("1".into())));
    for bad in [Ok("true".to_string()), Err(VarError::NotUnicode(OsString::from("\u{FFFD}")))] {
        assert!(std::panic::catch_unwind(|| require_fixtures_from(bad)).is_err());
    }
}

#[test]
fn repo_root_holds_the_fixture_manifest() {
    assert!(ifc_lite_testkit::fixture_path("manifest.json").is_file());
}

/// Child entry point: a migrated test's shape (`fixture_text_or_skip!` on a
/// fixture that does not exist). Only run by the parent tests below.
#[test]
#[ignore = "child of the env-wiring tests; run via --ignored --exact"]
fn child_skips_a_fixture_that_does_not_exist() {
    let _ = ifc_lite_testkit::fixture_text_or_skip!("nonexistent/never-fetched.ifc");
}

fn run_child(gate: &str) -> std::process::Output {
    Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "child_skips_a_fixture_that_does_not_exist"])
        .env("IFC_LITE_REQUIRE_FIXTURES", gate)
        .output()
        .expect("spawn child test binary")
}

#[test]
fn env_gate_off_lets_a_missing_fixture_skip() {
    assert!(run_child("0").status.success(), "gate off: the skip must pass");
}

#[test]
fn env_gate_on_fails_a_test_whose_fixture_is_missing() {
    let out = run_child("1");
    assert!(!out.status.success(), "gate on: a missing fixture must FAIL the test, not skip it");
    let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    assert!(text.contains("IFC_LITE_REQUIRE_FIXTURES=1"), "failure must name the gate: {text}");
}
