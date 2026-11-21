// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn sample(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/viewer/public/samples").join(name);
    fs::read(&path).unwrap_or_else(|error| panic!("committed sample {}: {error}", path.display()))
}

/// A fresh, empty directory per test.
fn scratch(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ifc-lite-cache-{test}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn build(source: &[u8], output: &Path, limits: Limits, batch_jobs: usize) -> Result<CacheStats, CacheError> {
    build_to_path(source, output, &CacheOptions::default(), limits, batch_jobs)
}

#[test]
fn streamed_bytes_do_not_depend_on_the_job_chunk_size() {
    let dir = scratch("chunk-size");
    for name in ["hello-wall.ifc", "building-architecture.ifc"] {
        let source = sample(name);
        let (expected, expected_stats) = crate::build_cache(&source, CacheOptions::default()).unwrap();
        for batch_jobs in [1, 7, BATCH_JOBS] {
            let output = dir.join(format!("{name}.{batch_jobs}.ifclite"));
            let stats = build(&source, &output, Limits::FORMAT, batch_jobs).unwrap();
            assert!(fs::read(&output).unwrap() == expected, "{name}: {batch_jobs}-job chunks differ from in-memory");
            assert_eq!(stats, expected_stats, "{name}: {batch_jobs}-job chunks");
        }
    }
    assert!(listing(&dir).iter().all(|name| name.ends_with(".ifclite")), "no staging file left");
    fs::remove_dir_all(dir).unwrap();
}

/// #9584: atomic finalize. A failure part-way through the geometry, after
/// chunks are already spooled, leaves neither the output, the temporary file
/// nor the spool, and an existing output is untouched.
#[test]
fn issue_9584_an_injected_mid_geometry_failure_leaves_no_output_temp_or_spool() {
    let source = sample("building-architecture.ifc");
    let (_, stats) = crate::build_cache(&source, CacheOptions::default()).unwrap();
    assert!(stats.chunk_count >= 2, "the failure must land after a chunk is spooled");
    let dir = scratch("injected-failure");
    let failing = Limits { fail_at_chunk: Some(1), ..Limits::FORMAT };

    let fresh = dir.join("fresh.ifclite");
    match build(&source, &fresh, failing, 7) {
        Err(CacheError::Io { source, .. }) => assert_eq!(source.to_string(), "injected failure"),
        other => panic!("expected the injected failure, got {other:?}"),
    }
    assert_eq!(listing(&dir), Vec::<String>::new(), "no output, temp or spool");

    let existing = dir.join("existing.ifclite");
    fs::write(&existing, b"previous cache").unwrap();
    assert!(build(&source, &existing, failing, 7).is_err());
    assert_eq!(listing(&dir), vec!["existing.ifclite".to_owned()]);
    assert_eq!(fs::read(&existing).unwrap(), b"previous cache", "the old output survives intact");

    // And the same build without the fault replaces it.
    build(&source, &existing, Limits::FORMAT, 7).unwrap();
    assert_eq!(fs::read(&existing).unwrap(), crate::build_cache(&source, CacheOptions::default()).unwrap().0);
    assert_eq!(listing(&dir), vec!["existing.ifclite".to_owned()]);
    fs::remove_dir_all(dir).unwrap();
}

/// #9584: atomic finalize, the other half. A failure inside the commit, after
/// the temporary file is fully written, removes that file too. A directory at
/// the output path makes the final rename fail; the mid-geometry case above
/// fails before any temporary file exists, so it cannot observe this.
#[test]
fn issue_9584_a_failed_rename_removes_the_written_temp_file() {
    let source = sample("hello-wall.ifc");
    let dir = scratch("failed-rename");
    let output = dir.join("model.ifclite");
    fs::create_dir(&output).unwrap();
    match build(&source, &output, Limits::FORMAT, 7) {
        Err(CacheError::Io { context, .. }) => assert!(context.starts_with("rename "), "failed at {context}"),
        other => panic!("expected the rename to fail, got {other:?}"),
    }
    assert_eq!(listing(&dir), vec!["model.ifclite".to_owned()], "only the blocking directory is left");
    assert!(output.is_dir());
    fs::remove_dir_all(dir).unwrap();
}

/// #9584: staging only removes what it created. When a staging name is
/// already taken (another process in a different PID namespace can produce
/// the same pid and sequence in a shared directory), creation fails and the
/// existing file is left for its owner.
#[test]
fn issue_9584_a_taken_staging_name_is_not_removed() {
    let dir = scratch("taken-staging");
    let theirs = dir.join(".model.ifclite.1.0.spool");
    fs::write(&theirs, b"another build's spool").unwrap();
    match Staging::create_named(&dir, "model.ifclite", "1.0") {
        Err(CacheError::Io { context, .. }) => assert!(context.starts_with("create spool "), "failed at {context}"),
        Err(other) => panic!("expected the taken spool name to fail, got {other:?}"),
        Ok(_) => panic!("a taken spool name must not be reused"),
    }
    assert_eq!(fs::read(&theirs).unwrap(), b"another build's spool", "the other build's spool survives");
    assert_eq!(listing(&dir), vec![".model.ifclite.1.0.spool".to_owned()]);
    fs::remove_dir_all(dir).unwrap();
}

/// #9584 review: a killed build runs no destructor, so its staging files
/// stay. With a fixed PID (a container) the next build would choose the same
/// names; it moves on to the next sequence instead, leaves the leftovers
/// alone, and gives up only after `STAGING_ATTEMPTS` taken names.
#[test]
fn issue_9584_a_leftover_staging_name_is_skipped_not_fatal() {
    let dir = scratch("leftover-staging");
    fs::write(dir.join(".model.ifclite.1.0.spool"), b"killed build").unwrap();
    fs::write(dir.join(".model.ifclite.1.1.tmp"), b"killed build").unwrap();
    let mut sequence = 0..;
    let next = || format!("1.{}", sequence.next().unwrap());
    let (staging, spool) = Staging::create_unused(&dir, "model.ifclite", next).unwrap();
    assert_eq!(staging.spool, dir.join(".model.ifclite.1.2.spool"), "the first free sequence");
    // Close the spool before the staging guard removes it: Windows keeps an
    // open file's directory entry until its last handle closes.
    drop(spool);
    drop(staging);
    let leftovers = vec![".model.ifclite.1.0.spool".to_owned(), ".model.ifclite.1.1.tmp".to_owned()];
    assert_eq!(listing(&dir), leftovers, "the leftovers are not ours to remove; ours are gone");

    match Staging::create_unused(&dir, "model.ifclite", || "1.0".to_owned()) {
        Err(CacheError::Io { source, .. }) => assert_eq!(source.kind(), io::ErrorKind::AlreadyExists),
        other => panic!("expected the attempts to run out, got {:?}", other.err()),
    }
    assert_eq!(listing(&dir), leftovers);
    fs::remove_dir_all(dir).unwrap();
}

/// #9584: the u32 bound, end to end through the streaming writer, with an
/// injected limit instead of a 4 GiB model: refused with `TooLarge`, and
/// cleaned up like any other failure.
#[test]
fn issue_9584_a_cache_past_the_limit_is_refused_and_leaves_nothing() {
    let source = sample("building-architecture.ifc");
    let (bytes, _) = crate::build_cache(&source, CacheOptions::default()).unwrap();
    let dir = scratch("too-large");
    let output = dir.join("model.ifclite");
    for max_bytes in [bytes.len() as u64 / 2, bytes.len() as u64 - 1] {
        match build(&source, &output, Limits { max_bytes, ..Limits::FORMAT }, 7) {
            Err(CacheError::TooLarge(at_least)) => assert!(at_least > max_bytes),
            other => panic!("limit {max_bytes}: expected TooLarge, got {other:?}"),
        }
        assert_eq!(listing(&dir), Vec::<String>::new());
    }
    let exact = Limits { max_bytes: bytes.len() as u64, ..Limits::FORMAT };
    assert_eq!(build(&source, &output, exact, 7).unwrap().cache_bytes, bytes.len() as u64);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_missing_output_directory_is_an_error_and_creates_nothing() {
    let dir = scratch("missing-dir");
    let output = dir.join("absent").join("model.ifclite");
    let result = build(&sample("hello-wall.ifc"), &output, Limits::FORMAT, BATCH_JOBS);
    assert!(matches!(result, Err(CacheError::Io { .. })), "{result:?}");
    assert_eq!(listing(&dir), Vec::<String>::new());
    fs::remove_dir_all(dir).unwrap();
}
