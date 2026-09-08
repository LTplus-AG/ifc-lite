// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Baseline parity lock for the styling unification (issue #913, Phase 0).
//!
//! This test does NOT exercise the full mesh pipeline yet — the shared
//! decoder-driven resolver arrives in Phase 2, and the end-to-end golden
//! fixtures (browser vs backend on real IFC files) land alongside it. What
//! it locks today is the **default-color table**, the only shared styling
//! surface that exists so far.
//!
//! It snapshots the two historical tables (`wasm-bindings`
//! `get_default_color_for_type` and `processing` `get_default_color`,
//! captured 2026-06) and asserts that the new canonical
//! `default_color_for_type`:
//!   1. agrees with BOTH old tables on every type they already shared, and
//!   2. resolves the four contested types to the agreed union (plan §8.1).
//!
//! When Phase 1 deletes the old table bodies, this file is the proof that
//! the only behavioral change is the four documented entries.
//!
//! ANTI-VACUITY (#3200): the two source-grep guards at the bottom conclude from
//! an ABSENCE - no second table, no second extractor - so a scan that examined
//! nothing used to pass them, silently, over an empty directory and over a
//! directory that does not exist alike. Four guards now stand in the way: a
//! missing or unreadable scan root is a hard error rather than an empty result
//! (and the two are told apart), a file that cannot be read is a hard error
//! rather than a skip, the walk must reach `SCANNED_FLOOR` files, and the
//! detectors themselves are exercised against known-positive inputs - a file
//! count shows the walk is alive, not that the detector still detects. A fifth
//! now closes the way around all four: under CI the no-repo-root skip at the
//! top of each guard is refused outright (`common::refuse_to_skip_in_ci`).

mod common;

use ifc_lite_core::IfcType;
use ifc_lite_processing::default_color_for_type;

const NEUTRAL_GRAY: [f32; 4] = [0.8, 0.8, 0.8, 1.0];

/// Snapshot of the historical `wasm-bindings` table
/// (`rust/wasm-bindings/src/api/styling.rs:970`, 2026-06).
/// `None` => the type fell through to the neutral-gray default.
fn wasm_default(t: IfcType) -> [f32; 4] {
    match t {
        IfcType::IfcWall | IfcType::IfcWallStandardCase => [0.85, 0.85, 0.85, 1.0],
        IfcType::IfcSlab => [0.7, 0.7, 0.7, 1.0],
        IfcType::IfcRoof => [0.6, 0.5, 0.4, 1.0],
        IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember => [0.6, 0.65, 0.7, 1.0],
        IfcType::IfcWindow => [0.6, 0.8, 1.0, 0.4],
        IfcType::IfcDoor => [0.6, 0.45, 0.3, 1.0],
        IfcType::IfcStair => [0.75, 0.75, 0.75, 1.0],
        IfcType::IfcRailing => [0.4, 0.4, 0.45, 1.0],
        IfcType::IfcPlate | IfcType::IfcCovering => [0.8, 0.8, 0.8, 1.0],
        IfcType::IfcCurtainWall => [0.5, 0.7, 0.9, 0.5],
        IfcType::IfcFurnishingElement => [0.7, 0.55, 0.4, 1.0],
        IfcType::IfcSpace => [0.2, 0.85, 1.0, 0.3],
        IfcType::IfcOpeningElement => [1.0, 0.42, 0.29, 0.4],
        IfcType::IfcSite => [0.4, 0.8, 0.3, 1.0],
        // NOTE: wasm lacked IfcStairFlight and IfcBuildingElementProxy.
        _ => NEUTRAL_GRAY,
    }
}

/// Snapshot of the historical `processing` table
/// (`rust/processing/src/processor.rs:2140`, 2026-06).
fn processing_default(t: IfcType) -> [f32; 4] {
    match t {
        IfcType::IfcWall | IfcType::IfcWallStandardCase => [0.85, 0.85, 0.85, 1.0],
        IfcType::IfcSlab => [0.7, 0.7, 0.7, 1.0],
        IfcType::IfcRoof => [0.6, 0.5, 0.4, 1.0],
        IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember => [0.6, 0.65, 0.7, 1.0],
        IfcType::IfcWindow => [0.6, 0.8, 1.0, 0.4],
        IfcType::IfcDoor => [0.6, 0.45, 0.3, 1.0],
        IfcType::IfcStair | IfcType::IfcStairFlight => [0.75, 0.75, 0.75, 1.0],
        IfcType::IfcRailing => [0.4, 0.4, 0.45, 1.0],
        IfcType::IfcPlate | IfcType::IfcCovering => [0.8, 0.8, 0.8, 1.0],
        IfcType::IfcFurnishingElement => [0.5, 0.35, 0.2, 1.0],
        IfcType::IfcSpace => [0.2, 0.85, 1.0, 0.3],
        IfcType::IfcOpeningElement => [1.0, 0.42, 0.29, 0.4],
        IfcType::IfcSite => [0.4, 0.8, 0.3, 1.0],
        IfcType::IfcBuildingElementProxy => [0.6, 0.6, 0.6, 1.0],
        // NOTE: processing lacked IfcCurtainWall.
        _ => NEUTRAL_GRAY,
    }
}

/// Every type that either historical table mapped explicitly.
const MAPPED_TYPES: &[IfcType] = &[
    IfcType::IfcWall,
    IfcType::IfcWallStandardCase,
    IfcType::IfcSlab,
    IfcType::IfcRoof,
    IfcType::IfcColumn,
    IfcType::IfcBeam,
    IfcType::IfcMember,
    IfcType::IfcWindow,
    IfcType::IfcDoor,
    IfcType::IfcStair,
    IfcType::IfcStairFlight,
    IfcType::IfcRailing,
    IfcType::IfcPlate,
    IfcType::IfcCovering,
    IfcType::IfcCurtainWall,
    IfcType::IfcFurnishingElement,
    IfcType::IfcSpace,
    IfcType::IfcOpeningElement,
    IfcType::IfcSite,
    IfcType::IfcBuildingElementProxy,
];

/// The four types whose values diverged between the tables (plan §2.2/§8.1).
const CONTESTED: &[IfcType] = &[
    IfcType::IfcStairFlight,
    IfcType::IfcCurtainWall,
    IfcType::IfcFurnishingElement,
    IfcType::IfcBuildingElementProxy,
];

fn is_contested(t: IfcType) -> bool {
    CONTESTED.contains(&t)
}

#[test]
fn union_agrees_with_both_tables_on_uncontested_types() {
    for &t in MAPPED_TYPES {
        if is_contested(t) {
            continue;
        }
        let canonical = default_color_for_type(t).to_array();
        assert_eq!(
            canonical,
            wasm_default(t),
            "{t:?}: canonical must match the wasm table on uncontested types"
        );
        assert_eq!(
            canonical,
            processing_default(t),
            "{t:?}: canonical must match the processing table on uncontested types"
        );
    }
}

#[test]
fn union_picks_the_documented_winner_for_contested_types() {
    // Exactly the four contested types, exactly these values, sourced as §8.1 decided.
    let cases = [
        // (type, canonical, came_from_wasm)
        (IfcType::IfcStairFlight, [0.75, 0.75, 0.75, 1.0], false), // processing
        (IfcType::IfcCurtainWall, [0.5, 0.7, 0.9, 0.5], true),     // wasm
        (IfcType::IfcFurnishingElement, [0.7, 0.55, 0.4, 1.0], true), // wasm (light wood)
        (IfcType::IfcBuildingElementProxy, [0.6, 0.6, 0.6, 1.0], false), // processing
    ];

    for (t, expected, from_wasm) in cases {
        let canonical = default_color_for_type(t).to_array();
        assert_eq!(canonical, expected, "{t:?}: unexpected canonical value");

        let winner = if from_wasm {
            wasm_default(t)
        } else {
            processing_default(t)
        };
        assert_eq!(canonical, winner, "{t:?}: canonical must equal the chosen source table");
    }

    // FurnishingElement specifically must NOT keep processing's darker brown.
    assert_ne!(
        default_color_for_type(IfcType::IfcFurnishingElement).to_array(),
        processing_default(IfcType::IfcFurnishingElement),
        "furnishing must change away from processing's [0.5,0.35,0.2,1]"
    );
}

#[test]
fn exactly_four_types_change_per_table() {
    // Guard rail: the migration must touch ONLY the four contested types.
    let wasm_deltas: Vec<IfcType> = MAPPED_TYPES
        .iter()
        .copied()
        .filter(|&t| default_color_for_type(t).to_array() != wasm_default(t))
        .collect();
    let processing_deltas: Vec<IfcType> = MAPPED_TYPES
        .iter()
        .copied()
        .filter(|&t| default_color_for_type(t).to_array() != processing_default(t))
        .collect();

    // vs wasm: StairFlight + BuildingElementProxy gain a non-default value.
    assert_eq!(
        wasm_deltas,
        vec![IfcType::IfcStairFlight, IfcType::IfcBuildingElementProxy],
        "unexpected changes relative to the wasm table"
    );
    // vs processing: CurtainWall gains glass blue, FurnishingElement lightens.
    assert_eq!(
        processing_deltas,
        vec![IfcType::IfcCurtainWall, IfcType::IfcFurnishingElement],
        "unexpected changes relative to the processing table"
    );
}

// ---------------------------------------------------------------------------
// "No second table" guard (plan §6.3).
//
// Fails the build if a per-consumer IFC-type → color table reappears anywhere
// in the Rust sources. The canonical table is `style::default_color_for_type`;
// the historical copies were all named `fn get_default_color[...]`, so that is
// the signature we forbid outside the allowlist. This is the tripwire that
// would have caught the server and desktop copies the day they were added.
// ---------------------------------------------------------------------------

/// Repo root = the first ancestor of this crate that holds both `rust/` and
/// `apps/`. Returns `None` in a packaged/standalone context (test then skips).
fn repo_root() -> Option<std::path::PathBuf> {
    let mut dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    loop {
        if dir.join("rust").is_dir() && dir.join("apps").is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Lower bound on how many `.rs` files the two source-grep guards below must
/// reach before an empty offender list means anything.
///
/// Both guards conclude from an ABSENCE, so a walk that reaches nothing proves
/// nothing and passes anyway - which is what they did before #3200, over an
/// empty directory and over a directory that does not exist alike.
///
/// MEASURED, not guessed: the walk over `rust/` + `apps/` reaches
/// 659 `.rs` files on a healthy tree (raise the floor and
/// run the test to see the real figure in the failure message). The floor sits
/// at roughly two thirds of that. It only has to separate "the walk works" from
/// "the walk went blind", and every way it can go blind - a wrong scan root, a
/// `read_dir` that fails, a crate tree that moved - takes the count to zero or
/// to a handful, never to a plausible-looking fraction.
const SCANNED_FLOOR: usize = 440;

/// Walk `dir`, collecting every `.rs` file underneath it.
///
/// A directory this cannot list is a hard error, and the two reasons are told
/// apart. The previous `let Ok(entries) = read_dir(dir) else { return; };` made
/// "the scan root is not there" and "the scan root cannot be opened" produce
/// the same result as "this directory holds no Rust files", which for an
/// absence guard reads as a clean bill of health (#3200). A missing directory
/// means the walk roots are wrong; an unreadable one means the environment is.
fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => panic!(
            "styling parity: {} does not exist. Refusing to treat a missing \
             directory as one holding no .rs files - these guards conclude from \
             an absence, so a scan root that is not there would read as clean.",
            dir.display()
        ),
        Err(err) => panic!(
            "styling parity: {} could not be read ({err}). Refusing to treat an \
             unreadable directory as one holding no .rs files.",
            dir.display()
        ),
    };
    for entry in entries {
        let entry = entry.unwrap_or_else(|err| {
            panic!(
                "styling parity: an entry of {} could not be read ({err}). \
                 Refusing to walk past a file these guards could not classify.",
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
                collect_rs_files(&path, out);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// Read one walked file. Unreadable is a hard error, not a skip: `continue`
/// removed the file from an absence guard's evidence without removing it from
/// the tree, so a copy of the forbidden table sitting in a file these guards
/// could not open would have read as "not found".
fn read_walked(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|err| {
        panic!(
            "styling parity: {} could not be read ({err}). Refusing to skip a \
             file this guard could not examine - these guards prove an absence, \
             and an unread file is not an absence.",
            path.display()
        )
    })
}

/// Does `src` declare a per-consumer default-color table?
///
/// Matches actual function declarations only, not prose or strings that happen
/// to mention the name (e.g. this file's own doc comments). Split out from the
/// guard so it can be exercised against a known-positive input - a file count
/// alone shows the walk is alive, not that the detector still detects.
fn declares_default_color_table(src: &str) -> bool {
    src.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("fn get_default_color")
            || line.starts_with("pub fn get_default_color")
            || line.starts_with("pub(crate) fn get_default_color")
    })
}

/// Does `src` declare a second surface-style colour extractor? Same reasoning
/// as `declares_default_color_table`.
fn declares_surface_style_extractor(src: &str) -> bool {
    src.lines().any(|line| {
        let line = line.trim_start();
        ["fn ", "pub fn ", "pub(crate) fn "].iter().any(|p| {
            line.starts_with(&format!("{p}extract_color_from_rendering"))
                || line.starts_with(&format!("{p}extract_color_rgb"))
        })
    })
}

/// Positive control for both detectors: a file count proves the walk reaches
/// files, and nothing more. If the detectors themselves stopped matching - a
/// rename, an edited prefix list, a `trim_start` that went away - the offender
/// lists would empty out and both guards would go green over a tree full of
/// violations. These synthetic inputs fail the moment that happens.
#[test]
fn the_detectors_still_fire_on_a_known_violation() {
    assert!(
        declares_default_color_table("    pub fn get_default_color(t: IfcType) -> Color {\n"),
        "the default-color-table detector stopped matching a declaration it must catch"
    );
    assert!(
        declares_default_color_table("fn get_default_color_for_type(t: IfcType) -> Color {\n"),
        "the default-color-table detector must match the wasm-side name too"
    );
    assert!(
        declares_surface_style_extractor(
            "    fn extract_color_from_rendering(id: u32) -> Color {\n"
        ),
        "the surface-style detector stopped matching a declaration it must catch"
    );
    assert!(
        declares_surface_style_extractor("pub(crate) fn extract_color_rgb(id: u32) -> Color {\n"),
        "the surface-style detector stopped matching `extract_color_rgb`"
    );

    // And it must stay a DECLARATION detector: prose and call sites are not
    // second tables, and a detector that fired on them would be turned off.
    assert!(
        !declares_default_color_table(
            "// the historical copies were named `fn get_default_color`\n"
        ),
        "the default-color-table detector must not fire on prose"
    );
    assert!(
        !declares_surface_style_extractor("        let c = extract_color_rgb(id, decoder)?;\n"),
        "the surface-style detector must not fire on a call site"
    );
}

#[test]
fn no_duplicate_default_color_tables() {
    let Some(root) = repo_root() else {
        common::refuse_to_skip_in_ci("styling parity guard");
        eprintln!("repo root not found (packaged context) — skipping guard");
        return;
    };

    // Paths allowed to still contain a `fn get_default_color*`:
    //  - this guard test itself (it names the pattern in prose/snapshots).
    let allow = |rel: &str| rel.ends_with("rust/processing/tests/styling_parity.rs");

    let mut files = Vec::new();
    collect_rs_files(&root.join("rust"), &mut files);
    collect_rs_files(&root.join("apps"), &mut files);

    // Anti-vacuity (#3200): this guard concludes from an empty `offenders`, so
    // the walk having reached a real tree is part of its evidence, not a
    // precondition someone else checks.
    assert!(
        files.len() >= SCANNED_FLOOR,
        "styling parity walked rust/ and apps/ and reached only {} .rs file(s); \
         the floor is {SCANNED_FLOOR}. Refusing a vacuous pass: this guard \
         concludes that no second default-color table exists, and a scan that \
         examined this little has established no such thing.",
        files.len()
    );

    let mut offenders = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if allow(&rel) {
            continue;
        }
        if declares_default_color_table(&read_walked(&path)) {
            offenders.push(rel);
        }
    }

    assert!(
        offenders.is_empty(),
        "found per-consumer default-color table(s) outside the canonical \
         `processing::style` — use `default_color_for_type` instead (issue #913): {offenders:?}"
    );
}

// ---------------------------------------------------------------------------
// "No second surface-style colour extractor" guard.
//
// The `IfcSurfaceStyle → IfcSurfaceStyleRendering → IfcColourRgb` leaf has one
// home: `ifc_lite_processing::style::extract_surface_style_colors`. The browser
// `wasm-bindings` used to carry its own copy (`extract_color_from_rendering` /
// `extract_color_rgb`), which silently disagreed with the server on
// SurfaceColour-vs-DiffuseColour precedence (#859/#871). Forbid those function
// names from reappearing so the two pipelines can't re-fork. (The 2D drafting
// palette in `symbolic.rs` uses differently-named `extract_color_from_*`
// helpers and is unaffected.)
// ---------------------------------------------------------------------------

#[test]
fn no_duplicate_surface_style_color_extraction() {
    let Some(root) = repo_root() else {
        common::refuse_to_skip_in_ci("styling parity guard");
        eprintln!("repo root not found (packaged context) — skipping guard");
        return;
    };

    let allow = |rel: &str| {
        rel.ends_with("rust/processing/tests/styling_parity.rs")
            // Standalone debug examples can't depend on the downstream
            // `processing` crate, so they carry their own ad-hoc extraction.
            // They are not a production pipeline and don't affect server/viewer
            // parity, so they're exempt from this guard.
            || rel.starts_with("rust/geometry/examples/")
    };

    let mut files = Vec::new();
    collect_rs_files(&root.join("rust"), &mut files);
    collect_rs_files(&root.join("apps"), &mut files);

    assert!(
        files.len() >= SCANNED_FLOOR,
        "styling parity walked rust/ and apps/ and reached only {} .rs file(s); \
         the floor is {SCANNED_FLOOR}. Refusing a vacuous pass: this guard \
         concludes that no second surface-style colour extractor exists, and a \
         scan that examined this little has established no such thing.",
        files.len()
    );

    let scanned = files.len();
    let mut offenders = Vec::new();
    // END-TO-END positive control, one step beyond the synthetic one above:
    // count the exempt files the detector DOES match. The allowlist exists for
    // `rust/geometry/examples/`, which really does carry its own
    // `fn extract_color_from_rendering`, so a healthy run always finds at
    // least one. Zero means the walk and the detector never met a real
    // declaration, whatever the file count says.
    let mut allowed_hits = 0usize;
    for path in files {
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let declares = declares_surface_style_extractor(&read_walked(&path));
        if allow(&rel) {
            if declares {
                allowed_hits += 1;
            }
            continue;
        }
        if declares {
            offenders.push(rel);
        }
    }

    assert!(
        allowed_hits >= 1,
        "the surface-style detector matched nothing at all across {scanned} walked \
         file(s), not even the exempt `rust/geometry/examples/` copy it is \
         allowed to find. An absence guard that cannot find a declaration it \
         KNOWS is there has stopped detecting, so its empty offender list means \
         nothing. If that example was deliberately removed, retire this control \
         in the same commit."
    );

    assert!(
        offenders.is_empty(),
        "surface-style colour extraction must live only in \
         `ifc_lite_processing::style::extract_surface_style_colors`; found a per-pipeline \
         copy in: {offenders:?}"
    );
}
