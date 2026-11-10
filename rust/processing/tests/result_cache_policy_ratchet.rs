// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Result-cache policy ratchet (PR #9614 review, finding 1).
//!
//! The native result cache keys on the EFFECTIVE output policy
//! (`ifc_lite_geometry::output_policy::effective_output_policy` plus the
//! processing crate's degenerate backstop). An `IFC_LITE_*` / `IFCLITE_*`
//! variable read anywhere in the core, geometry or processing sources must be
//! classified below: either covered by that policy, or proven not to change
//! output. An unclassified one fails here, because a cache hit could otherwise
//! replay output computed under a different setting.
//!
//! Names alone are a lexical check that a non-`IFC_LITE_` name or a
//! `concat!`-built one slips past (PR #9614 review 2, R2-4). So the second test
//! counts every environment ACCESS SITE (`env::var`, `var_os`, `vars`,
//! `vars_os`, `use std::env`, `env!`, `option_env!`) per file: a new read
//! anywhere in the three crates, under any name, fails until a reviewer adds
//! it here, after making it an `output_policy` accessor or showing it cannot
//! change output. Stated holes: reads in other crates (dependencies), raw
//! `libc::getenv`, and macro-generated code. New programmatic setters and
//! thread-local policy are not lexically detectable; `output_policy`'s docs
//! and the generation counter own those.

mod common;
use common::source_walk::{production_sources, repo_root};
use std::collections::BTreeSet;

const GATE: &str = "result-cache policy ratchet";

/// Read through an accessor that `effective_output_policy` (or the
/// processing backstop accessor) also calls.
const KEYED_BY_POLICY: &[&str] = &[
    "IFC_LITE_RECT_FAST",
    "IFC_LITE_RECT_PARAM",
    "IFC_LITE_LOCAL_FRAME",
    "IFC_LITE_VOID_UNION",
    "IFC_LITE_VOID_2D",
    "IFC_LITE_PRISM_CUT",
    "IFC_LITE_DEDUP_EXTRA",
    "IFC_LITE_HALFSPACE_CAP_OFF",
    "IFC_LITE_FAST_CUT_RATIO",
    "IFC_LITE_CSG_BUDGET",
    "IFC_LITE_CSG_ELEMENT_BUDGET",
    "IFCLITE_TRIANGULATION_ALT",
    "IFC_LITE_DISABLE_DEGENERATE_BACKSTOP",
];

/// Named in these crates but cannot change a processing result. Each entry
/// says why; nothing is excluded merely for being absent from the scan.
const NOT_OUTPUT: &[&str] = &[
    // Read only by `result_cache::default_directory` to choose WHERE entries
    // are stored; never by the pipeline.
    "IFC_LITE_CACHE_DIR",
    // Not a runtime variable: a compile-time `env!` that build.rs sets to the
    // engine's build digest, which is itself hashed into every key.
    "IFC_LITE_ENGINE_BUILD_DIGEST",
];

fn names_in(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for prefix in ["\"IFC_LITE_", "\"IFCLITE_"] {
        for (at, _) in text.match_indices(prefix) {
            let rest = &text[at + 1..];
            let name: String = rest.chars().take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_').collect();
            if rest[name.len()..].starts_with('"') {
                out.insert(name);
            }
        }
    }
    out
}

#[test]
fn every_environment_knob_is_classified_for_the_result_cache() {
    let Some(root) = repo_root() else {
        common::refuse_to_skip_in_ci(GATE);
        eprintln!("repo root not found (packaged context) - skipping {GATE}");
        return;
    };
    let mut found = BTreeSet::new();
    for (rel, path) in production_sources(GATE, &root) {
        let in_scope = ["rust/core/src/", "rust/geometry/src/", "rust/processing/src/"].iter().any(|p| rel.starts_with(p));
        if in_scope {
            let text = std::fs::read_to_string(&path).expect("readable source");
            for name in names_in(&text) {
                found.insert((name, rel.clone()));
            }
        }
    }
    let classified: BTreeSet<&str> = KEYED_BY_POLICY.iter().chain(NOT_OUTPUT).copied().collect();
    let unclassified: Vec<_> = found.iter().filter(|(name, _)| !classified.contains(name.as_str())).collect();
    assert!(
        unclassified.is_empty(),
        "unclassified environment knobs (key them in output_policy or list them as NOT_OUTPUT): {unclassified:?}"
    );
    // Each keyed knob is still read somewhere; a stale row is a classification
    // nobody re-checked.
    for name in KEYED_BY_POLICY {
        assert!(found.iter().any(|(n, _)| n == name), "{name} is no longer read; drop its row");
    }
}

#[test]
fn the_scanner_finds_quoted_names_only() {
    let names = names_in(r#"std::env::var("IFC_LITE_X1") // `IFC_LITE_Y` "IFCLITE_Z" "IFC_LITE_partial"#);
    assert_eq!(names.into_iter().collect::<Vec<_>>(), ["IFCLITE_Z", "IFC_LITE_X1"]);
}

/// Reviewed environment access sites per file. Each is an `output_policy`
/// accessor's one read, the cache's own location, or the compile-time build
/// identity. Counts include doc comments naming `std::env::var`.
const ACCESS_SITES: &[(&str, usize)] = &[
    ("rust/geometry/src/kernel/budget.rs", 2),
    ("rust/geometry/src/processors/boolean/cut_heuristics.rs", 1),
    ("rust/geometry/src/processors/boolean/halfspace_cap.rs", 1),
    ("rust/geometry/src/rect_fast.rs", 3),
    ("rust/geometry/src/router/mod.rs", 1),
    ("rust/geometry/src/router/transforms/mod.rs", 1),
    ("rust/geometry/src/router/voids/bool2d_path.rs", 1),
    ("rust/geometry/src/router/voids/coaxial_union.rs", 1),
    ("rust/geometry/src/router/voids/prism_cut.rs", 1),
    ("rust/geometry/src/triangulation/alt_oracle.rs", 1),
    ("rust/processing/src/element_degenerate.rs", 1),
    ("rust/processing/src/result_cache/config.rs", 1),
    ("rust/processing/src/result_cache/key.rs", 1),
];

fn access_sites(text: &str) -> usize {
    let patterns = ["env::var(", "env::var_os(", "env::vars(", "env::vars_os(", "env::var`", "use std::env", "std::env::{", "env!(", "option_env!("];
    // `option_env!(` also contains `env!(`; count it once.
    patterns.iter().map(|p| text.matches(p).count()).sum::<usize>() - text.matches("option_env!(").count()
}

#[test]
fn every_environment_access_site_is_reviewed() {
    let Some(root) = repo_root() else {
        common::refuse_to_skip_in_ci(GATE);
        eprintln!("repo root not found (packaged context) - skipping {GATE}");
        return;
    };
    let mut found = Vec::new();
    for (rel, path) in production_sources(GATE, &root) {
        let in_scope = ["rust/core/src/", "rust/geometry/src/", "rust/processing/src/"].iter().any(|p| rel.starts_with(p));
        if in_scope {
            let sites = access_sites(&std::fs::read_to_string(&path).expect("readable source"));
            if sites > 0 {
                found.push((rel, sites));
            }
        }
    }
    let expected: Vec<(String, usize)> = ACCESS_SITES.iter().map(|(f, n)| (f.to_string(), *n)).collect();
    assert_eq!(found, expected, "environment access sites changed: review each new read for the result cache key");
}

#[test]
fn access_site_counting_sees_aliases_and_built_names() {
    let hostile = r#"std::env::var("GEOMETRY_TOLERANCE"); std::env::var(concat!("IFC_", "LITE_X")); use std::env::var_os as v;"#;
    assert_eq!(access_sites(hostile), 3);
    assert_eq!(access_sites(r#"option_env!("A"); env!("B")"#), 2);
}

/// PR #9614 review thread: a router built with an explicit `local_frame`
/// (`RouterConfig::local_frame = Some(_)`, `with_scale_and_local_frame`)
/// ignores the process-global fallback the key records. No router on the
/// cached `process()` path may set one: every one is built from
/// `RouterConfig::default()` plus keyed request fields (`jobs.rs` job_router,
/// `diagnostics.rs` unit_router). Appearance authoring sets it explicitly, but
/// `ResultCache::process` never reaches it. A new explicit frame policy in
/// these files fails here until it is keyed through `ProcessingRequest`.
#[test]
fn the_cached_pass_never_pins_a_router_frame_policy() {
    let Some(root) = repo_root() else {
        common::refuse_to_skip_in_ci(GATE);
        eprintln!("repo root not found (packaged context) - skipping {GATE}");
        return;
    };
    let on_path = |rel: &str| {
        rel.starts_with("rust/processing/src/processor/")
            || rel.starts_with("rust/processing/src/element/")
            || rel == "rust/processing/src/execution.rs"
            || rel == "rust/processing/src/element.rs"
    };
    let mut pinned = Vec::new();
    for (rel, path) in production_sources(GATE, &root) {
        if on_path(&rel) {
            let text = std::fs::read_to_string(&path).expect("readable source");
            for needle in ["local_frame:", ".local_frame =", "with_scale_and_local_frame", "local_frame_set_enabled_override"] {
                if text.contains(needle) {
                    pinned.push(format!("{rel}: {needle}"));
                }
            }
        }
    }
    assert!(pinned.is_empty(), "the cached pass pins a frame policy the key does not record: {pinned:?}");
}
