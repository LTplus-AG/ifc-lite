// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `extract_symbolic_data` golden hashes (#7671, charter #7670 §2 T3, gate G8).
//!
//! The symbol stream's serde JSON is what the server's `symbolic_data` field
//! and `GET /api/v1/parse/symbolic/{key}` carry; the per-feature tests assert
//! shapes, and nothing pinned the whole stream byte for byte over real
//! models. Pinned per fixture in `golden/symbolic-data.json`. The hash, the
//! file format and the re-pin rule are shared with the export corpus
//! (`rust/export/tests/support/golden.rs`), and the fixture rule with the
//! export unit tests (`IFC_LITE_REQUIRE_FIXTURES`).

#[path = "../../export/src/test_support.rs"]
#[allow(dead_code, unused_macros)] // shared with the export unit tests; this file uses `fixture_opt` only
mod test_support;
#[path = "../../export/tests/support/golden.rs"]
mod golden;

use std::path::Path;

use golden::Golden;
use ifc_lite_processing::extract_symbolic_data;

/// `(key, path)`: models whose symbol streams are non-trivial (annotations,
/// grids, plan/footprint representations). Catalogued paths are under
/// `tests/models/`; the in-tree one is repo-relative and always present.
const FIXTURES: &[(&str, &str)] = &[
    ("AC20-FZK-Haus", "ara3d/AC20-FZK-Haus.ifc"),
    ("duplex", "ara3d/duplex.ifc"),
    ("Mini-Project-grids", "ara3d/ISSUE_021_Mini Project.ifc"),
    ("wall_roof_plan_reps", "rust/geometry/tests/fixtures/issue_4560_wall_roof_polygonal_cutters.ifc"),
];

#[test]
fn symbolic_data() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let mut g = Golden::new(
        &dir,
        "symbolic-data",
        "cargo test -p ifc-lite-processing --test symbolic_golden -- --exact symbolic_data",
    );
    for (key, path) in FIXTURES {
        let bytes = if path.starts_with("rust/") {
            let abs = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
            std::fs::read(&abs).unwrap_or_else(|e| panic!("in-tree fixture {abs}: {e}"))
        } else {
            match test_support::fixture_opt(path) {
                Some(bytes) => bytes,
                None => continue,
            }
        };
        let json = serde_json::to_vec(&extract_symbolic_data(&bytes).expect("symbolic extraction must complete")).expect("SymbolicData serialises");
        g.record(*key, &json);
    }
    g.finish(&FIXTURES.iter().map(|(k, _)| k.to_string()).collect::<Vec<_>>());
}
