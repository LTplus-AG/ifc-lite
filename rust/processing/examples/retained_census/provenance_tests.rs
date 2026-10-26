// SPDX-License-Identifier: MPL-2.0
//! #7955 C6: the same executable observes two clean runtime revisions without
//! relabelling its embedded source pin. This is metadata, not geometry evidence.
use super::*;
use std::path::Path;

const CHILD: &str = "logic::controller::provenance::tests::issue_7955_provenance_child";

#[test]
fn issue_7955_provenance_child() {
    if std::env::var_os("IFC_RETAINED_PROVENANCE_CHILD").is_none() { return; }
    // Exercise the actual census metadata and public column selection, not a
    // helper accepting a caller-supplied implementation identity.
    let report = crate::logic::census_paths(Vec::new()).unwrap();
    let bytes = crate::logic::tests::model("");
    let fixture = crate::logic::census_bytes(bytes.as_bytes());
    println!("CUT_C_PROVENANCE={}", serde_json::json!({
        "metadata": report.controller_provenance,
        "binary": report.controller_executable_sha256,
        "column": fixture.products[&13].controller,
    }));
}

fn git_at(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git").args(args).current_dir(path)
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .output().unwrap();
    assert!(output.status.success(), "git fixture: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn run_existing_binary(path: &Path, runtime_stamp: &str) -> serde_json::Value {
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", CHILD, "--nocapture"]).current_dir(path)
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env("IFC_RETAINED_PROVENANCE_CHILD", "1")
        .env("IFC_RETAINED_BUILD_COMMIT", runtime_stamp).output().unwrap();
    assert!(output.status.success(), "child: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let rows: Vec<_> = stdout.lines().filter_map(|line| line.split_once("CUT_C_PROVENANCE=")).collect();
    assert_eq!(rows.len(), 1, "one actual child witness must run: {stdout}");
    serde_json::from_str(rows[0].1).unwrap()
}

#[test]
fn issue_7955_prebuilt_identity_survives_runtime_checkout_switch_and_environment() {
    let path = std::env::temp_dir().join(format!("ifc-c6-provenance-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir(&path).unwrap();
    git_at(&path, &["init", "--quiet"]);
    let mut observations = Vec::new();
    for content in ["runtime checkout A", "runtime checkout B"] {
        std::fs::write(path.join("fixture"), content).unwrap();
        git_at(&path, &["add", "fixture"]);
        git_at(&path, &["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", content]);
        let revision = git_at(&path, &["rev-parse", "HEAD"]);
        let observed = run_existing_binary(&path, &revision);
        assert_eq!(observed["metadata"]["runtime_checkout_commit"], revision);
        assert_eq!(observed["metadata"]["runtime_checkout_clean"], true);
        assert_eq!(observed["metadata"]["implementation_commit"], serde_json::json!(implementation_commit()));
        if let Some(compiled) = implementation_commit() {
            assert_eq!(observed["column"]["implementationCommit"], compiled);
            assert_eq!(observed["column"]["outcome"]["kind"], "requires_numerical_evaluation");
        } else {
            assert_eq!(observed["column"]["kind"], "uninspected");
            assert_eq!(observed["column"]["reason"], "implementation_unbound");
        }
        observations.push(observed);
    }
    assert_ne!(observations[0]["metadata"]["runtime_checkout_commit"], observations[1]["metadata"]["runtime_checkout_commit"]);
    assert_eq!(observations[0]["metadata"]["implementation_commit"], observations[1]["metadata"]["implementation_commit"]);
    assert!(observations[0]["binary"].as_str().is_some_and(|hash| hash.len() == 64));
    assert_eq!(observations[0]["binary"], observations[1]["binary"]);
    std::fs::remove_dir_all(path).unwrap();
}
