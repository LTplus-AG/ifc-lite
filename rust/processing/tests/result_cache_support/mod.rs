// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fresh-process harness for `tests/result_cache.rs`: the parent re-runs this
//! test binary with `RC_TEST_CHILD=<fixture>|<dir>|<mode>|<variant>|<salt>|<policy>`,
//! and the child prints one `RCLINE` with its outcome and fingerprints.

use ifc_lite_processing::result_cache::{CacheMode, ResultCache, ResultCacheConfig};
use ifc_lite_processing::{
    result_fingerprint, Batching, Features, OpeningFilterMode, ProcessingRequest, TessellationQuality,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

const CHILD_ENV: &str = "RC_TEST_CHILD";

/// Every request shape the tests key on; `full` is `ProcessingRequest::full_pass()`.
pub const VARIANTS: &[&str] = &[
    "full",
    "instancing",
    "ignore-all-openings",
    "ignore-opaque-openings",
    "skip-voids",
    "quality-low",
    "quality-high",
    "layer-slicing",
    "streaming-batches",
    "fast-first",
    "no-properties",
    "no-presentation-layers",
    "bootstrap",
    "finishes",
    "ids-empty",
    "ids-one",
];

pub fn request_variant(name: &str) -> ProcessingRequest {
    let full = ProcessingRequest::full_pass();
    let features = Features::default();
    match name {
        "full" => full,
        "instancing" => full.instancing(true),
        "ignore-all-openings" => full.opening_filter(OpeningFilterMode::IgnoreAll),
        "ignore-opaque-openings" => full.opening_filter(OpeningFilterMode::IgnoreOpaque),
        "skip-voids" => full.skip_voids(true),
        "quality-low" => full.quality(TessellationQuality::Low),
        "quality-high" => full.quality(TessellationQuality::High),
        "layer-slicing" => full.layer_slicing(true),
        "streaming-batches" => full.batching(Batching::new(50, 50)),
        "fast-first" => full.batching(Batching::single_chunk().fast_first(true)),
        "no-properties" => full.features(features.properties(false)),
        "no-presentation-layers" => full.features(features.presentation_layers(false)),
        "bootstrap" => full.features(features.quick_metadata_bootstrap(true)),
        "finishes" => full.features(features.finishes(true)),
        "ids-empty" => full.ids(Some(Arc::new(HashSet::new()))),
        "ids-one" => full.ids(Some(Arc::new(HashSet::from([1])))),
        other => panic!("unknown request variant {other}"),
    }
}

pub fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(fixture_path(name)).expect("in-repo fixture")
}

/// Committed fixtures (always present) plus the fetched texture set when on disk.
pub fn in_repo_corpus() -> Vec<(PathBuf, &'static str)> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut out = Vec::new();
    let ifc_files = |dir: PathBuf, prefix: &str| -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        files.retain(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            name.ends_with(".ifc") && name.starts_with(prefix)
        });
        files.sort();
        files
    };
    for path in ifc_files(manifest.join("tests/fixtures"), "") {
        out.push((path, "full"));
    }
    for path in ifc_files(manifest.join("../geometry/tests/fixtures"), "mapped_instances") {
        out.push((path, "instancing"));
    }
    out.push((manifest.join("../../apps/viewer/public/samples/hello-wall.ifc"), "full"));
    let textures = ifc_lite_testkit::fixture_path("buildingsmart/annex_e/tessellated-shape-with-style");
    for path in ifc_files(textures, "tessellation-with") {
        out.push((path, "full"));
    }
    out
}

pub fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("ifc-lite-rc-it-{tag}-{}-{nanos}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// One child's report.
#[derive(Debug, Clone)]
pub struct Child {
    pub outcome: String,
    pub publish: String,
    pub fingerprint: String,
    pub fingerprint_with_timings: String,
    pub line: String,
}

/// Process-global output policy changes a child applies before processing,
/// through the public setters a host could call.
pub fn apply_policy(name: &str) {
    use ifc_lite_geometry::kernel::budget;
    match name {
        "" => {}
        "local-frame-on" => ifc_lite_geometry::local_frame_set_enabled_override(Some(true)),
        "csg-cap-1" => budget::set_cap(Some(1)),
        "csg-cap-none" => budget::set_cap(None),
        "element-cap-1" => budget::set_element_cap(Some(1)),
        "rect-param-off" => ifc_lite_geometry::rect_fast::param_set_enabled_override(Some(false)),
        "dedup-extra-on" => ifc_lite_geometry::GeometryRouter::set_build_dedup_extra_override(Some(true)),
        // Initialise the lazily cached local-frame policy with the variable
        // absent, THEN set it: the pipeline keeps the cached `false`.
        "late-env-local-frame" => {
            assert!(std::env::var_os("IFC_LITE_LOCAL_FRAME").is_none());
            let _ = ifc_lite_geometry::output_policy::effective_output_policy();
            std::env::set_var("IFC_LITE_LOCAL_FRAME", "1");
        }
        other => panic!("unknown policy {other}"),
    }
}

pub fn child_main() {
    let Ok(spec) = std::env::var(CHILD_ENV) else { return };
    let parts: Vec<&str> = spec.split('|').collect();
    let [fixture, dir, mode, variant, salt, policy] = parts[..] else { panic!("bad child spec {spec}") };
    apply_policy(policy);
    let mode = match mode {
        "rw" => CacheMode::ReadWrite,
        "ro" => CacheMode::ReadOnly,
        _ => CacheMode::Off,
    };
    let content = std::fs::read(fixture).expect("child fixture");
    let config = ResultCacheConfig::default().mode(mode).directory(dir).engine_salt(salt.as_bytes());
    let out = ResultCache::new(config).process(&content, &request_variant(variant));
    let w = &out.report.work;
    println!(
        "RCLINE outcome={} publish={:?} fp={} fpt={} meshes={} instances={} hashed={} read={} decoded={} written={}",
        out.report.outcome_label(),
        out.report.publish,
        result_fingerprint(&out.result, false),
        result_fingerprint(&out.result, true),
        out.result.meshes.len(),
        out.result.instances.len(),
        w.bytes_hashed,
        w.entry_bytes_read,
        w.bytes_decoded,
        w.entry_bytes_written,
    );
}

pub fn spawn_child(fixture: &Path, dir: &Path, mode: &str, variant: &str, salt: &str, env: &[(&str, &str)]) -> std::process::Child {
    spawn_child_with_policy(fixture, dir, mode, variant, salt, "", env)
}

pub fn spawn_child_with_policy(
    fixture: &Path,
    dir: &Path,
    mode: &str,
    variant: &str,
    salt: &str,
    policy: &str,
    env: &[(&str, &str)],
) -> std::process::Child {
    let spec = format!("{}|{}|{mode}|{variant}|{salt}|{policy}", fixture.display(), dir.display());
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args(["--exact", "child_process_entry", "--nocapture", "--test-threads", "1"])
        .env(CHILD_ENV, spec)
        .env_remove("IFC_LITE_LOCAL_FRAME")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.spawn().expect("spawn child test process")
}

pub fn wait_child(child: std::process::Child) -> Child {
    let out = child.wait_with_output().expect("child output");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "child failed: {stdout}\n{}", String::from_utf8_lossy(&out.stderr));
    let line = stdout.lines().find_map(|l| l.split_once("RCLINE ").map(|(_, rest)| rest)).unwrap_or_else(|| panic!("no RCLINE in {stdout}"));
    let field = |name: &str| {
        let prefix = format!("{name}=");
        line.split(' ').find_map(|f| f.strip_prefix(prefix.as_str())).unwrap_or_default().to_string()
    };
    let publish = line.split("publish=").nth(1).unwrap_or_default().split(" fp=").next().unwrap_or_default().to_string();
    Child { outcome: field("outcome"), publish, fingerprint: field("fp"), fingerprint_with_timings: field("fpt"), line: line.to_string() }
}

pub fn run_child(fixture: &Path, dir: &Path, mode: &str, variant: &str, salt: &str, env: &[(&str, &str)]) -> Child {
    wait_child(spawn_child(fixture, dir, mode, variant, salt, env))
}

pub fn run_policy_child(fixture: &Path, dir: &Path, mode: &str, policy: &str, env: &[(&str, &str)]) -> Child {
    wait_child(spawn_child_with_policy(fixture, dir, mode, "full", "", policy, env))
}

/// A cold read-write child then a warm read-only child on a fresh directory;
/// asserts miss/published then hit and bit-identical complete results.
pub fn cold_then_warm(path: &Path, variant: &str) -> (Child, Child) {
    let dir = temp_dir("corpus");
    let cold = run_child(path, &dir, "rw", variant, "", &[]);
    let warm = run_child(path, &dir, "ro", variant, "", &[]);
    let _ = std::fs::remove_dir_all(&dir);
    let name = path.display();
    assert_eq!(cold.outcome, "miss", "{name}: {}", cold.line);
    assert!(cold.publish.starts_with("Published"), "{name}: {}", cold.line);
    assert_eq!(warm.outcome, "hit", "{name}: {}", warm.line);
    assert_eq!(warm.fingerprint_with_timings, cold.fingerprint_with_timings, "{name} [{variant}]: warm replay differs from cold");
    (cold, warm)
}
