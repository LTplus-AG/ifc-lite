// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Corpus-replay gate for the `rust/landxml/fuzz` target (#7680, G7).
//!
//! `cargo fuzz` needs nightly and `cargo-fuzz` and runs only on a schedule
//! (`.github/workflows/fuzz.yml`, non-blocking). This test replays the corpus
//! committed under `fuzz/corpus/parse_landxml/` through the same
//! `exercise_landxml` the fuzz target runs (one shared file, `include!`d by
//! both), on stable, so it runs in the required `cargo test --workspace`
//! lane. A crash a scheduled run finds gets its minimized input committed
//! there, and the fix stays proven.

use std::{panic::AssertUnwindSafe, path::Path};

include!("fuzz/exercise.rs");

#[test]
fn parse_landxml_corpus_never_panics() {
    let dir = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fuzz/corpus/parse_landxml"
    ));
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("read {dir:?}: {error}"))
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    files.sort();
    // The corpus must be found and non-empty, or a moved directory would
    // make this gate pass while replaying nothing.
    assert!(!files.is_empty(), "no corpus files found at {dir:?}");
    let panicked: Vec<_> = files
        .iter()
        .filter(|path| {
            let data = std::fs::read(path).unwrap_or_else(|error| panic!("{path:?}: {error}"));
            std::panic::catch_unwind(AssertUnwindSafe(|| exercise_landxml(&data))).is_err()
        })
        .collect();
    assert!(
        panicked.is_empty(),
        "LandXML ingestion panicked on committed corpus file(s): {panicked:?}"
    );
}
