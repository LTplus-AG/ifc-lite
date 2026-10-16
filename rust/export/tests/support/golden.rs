// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Golden-hash oracle for byte outputs (#7671, charter #7670 §2 T3, gate G8).
//!
//! An output is pinned as its FNV-1a 64 hash plus its byte length, one JSON
//! file per output kind (`<dir>/<kind>.json`), keyed by case. FNV-1a 64 is the
//! hash `perf_probe --fingerprint` and `mesh_determinism` already report, so a
//! pin here reads the same as the fingerprint baselines. It is a change
//! detector, not a security digest.
//!
//! On a mismatch the failure names every `(kind, case)` that moved and prints
//! the re-pin command. Re-pinning is `IFC_LITE_REPIN_GOLDEN=1`, parsed as
//! strictly as `IFC_LITE_REQUIRE_FIXTURES`: only `"1"` is on, only
//! unset/empty/`"0"` is off, anything else panics. A re-pin rewrites the
//! entries of the cases it computed and keeps the others, so a run without the
//! catalogued fixtures cannot delete their pins. It refuses to run under `CI`,
//! where a leaked re-pin would make the gate pass by rewriting itself.
//!
//! Shared by path (`#[path]`) with the other crates' golden tests, so there is
//! one copy of the hash, the file format and the re-pin rule.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The environment variable that rewrites the pins instead of comparing.
pub const REPIN_ENV: &str = "IFC_LITE_REPIN_GOLDEN";

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64 over `bytes`.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV_OFFSET_BASIS, |h, &b| (h ^ u64::from(b)).wrapping_mul(FNV_PRIME))
}

/// One pinned output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin {
    pub fnv1a64: String,
    pub bytes: usize,
}

impl Pin {
    pub fn of(bytes: &[u8]) -> Self {
        Pin { fnv1a64: format!("{:016x}", fnv1a64(bytes)), bytes: bytes.len() }
    }
}

/// `<dir>/<kind>.json`: the cases, sorted, so a re-pin diff is one line per case.
#[derive(Debug, Default, Serialize, Deserialize)]
struct GoldenFile {
    about: String,
    repin: String,
    cases: BTreeMap<String, Pin>,
}

/// Parse `IFC_LITE_REPIN_GOLDEN`, failing closed on an unrecognised value.
fn repin_requested() -> bool {
    match std::env::var(REPIN_ENV) {
        Err(std::env::VarError::NotPresent) => false,
        Ok(v) if v.is_empty() || v == "0" => false,
        Ok(v) if v == "1" => true,
        other => panic!("{REPIN_ENV}={other:?} is not recognised (use \"1\" or \"0\")"),
    }
}

/// The pins of one output kind, compared or re-pinned in one call.
pub struct Golden {
    kind: String,
    path: PathBuf,
    repin_cmd: String,
    actual: BTreeMap<String, Pin>,
}

impl Golden {
    /// `dir` holds the pin files; `repin_cmd` is the `cargo test` invocation
    /// that reruns this test (the env var is prefixed for the reader).
    pub fn new(dir: &Path, kind: &str, repin_cmd: &str) -> Self {
        Golden {
            kind: kind.to_string(),
            path: dir.join(format!("{kind}.json")),
            repin_cmd: format!("{REPIN_ENV}=1 {repin_cmd}"),
            actual: BTreeMap::new(),
        }
    }

    /// Record `case`'s output.
    pub fn record(&mut self, case: impl Into<String>, output: &[u8]) {
        let case = case.into();
        let previous = self.actual.insert(case.clone(), Pin::of(output));
        assert!(previous.is_none(), "{}: case {case} recorded twice", self.kind);
    }

    /// Compare every recorded case with its pin, or rewrite the pins under
    /// `IFC_LITE_REPIN_GOLDEN=1`. `expected_cases` is every case this test can
    /// produce when all fixtures are present; a pin outside it is stale.
    pub fn finish(self, expected_cases: &[String]) {
        let report = self.check(expected_cases);
        assert!(report.is_empty(), "{report}");
    }

    /// [`Self::finish`] without the panic: the failure text, empty when every
    /// pin holds (or after a re-pin). For a test that pins several kinds and
    /// must name every one that moved, not only the first.
    pub fn check(self, expected_cases: &[String]) -> String {
        let pinned: GoldenFile = match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{} does not parse: {e}", self.path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => GoldenFile::default(),
            Err(e) => panic!("{} exists but could not be read: {e}", self.path.display()),
        };
        if repin_requested() {
            assert!(
                std::env::var_os("CI").is_none(),
                "{REPIN_ENV}=1 under CI: refusing to rewrite {} from the run it gates",
                self.path.display()
            );
            self.write(pinned, expected_cases);
            return String::new();
        }
        let mut report = String::new();
        for (case, pin) in &self.actual {
            match pinned.cases.get(case) {
                Some(want) if want == pin => {}
                Some(want) => writeln!(
                    report,
                    "  ({}, {case}) MOVED: pinned {} ({} bytes), got {} ({} bytes)",
                    self.kind, want.fnv1a64, want.bytes, pin.fnv1a64, pin.bytes
                )
                .unwrap(),
                None => writeln!(report, "  ({}, {case}) has no pin: got {} ({} bytes)", self.kind, pin.fnv1a64, pin.bytes)
                    .unwrap(),
            }
        }
        for case in pinned.cases.keys().filter(|c| !expected_cases.contains(c)) {
            writeln!(report, "  ({}, {case}) is pinned but no longer produced (stale pin)", self.kind).unwrap();
        }
        if report.is_empty() {
            return report;
        }
        format!(
            "\n{} output moved against {}:\n{report}\nIf the change is intended, re-pin ONLY this format and \
             justify each moved case in the PR (charter #7670 §1.2, class X):\n  {}\n",
            self.kind,
            self.path.display(),
            self.repin_cmd
        )
    }

    fn write(self, pinned: GoldenFile, expected_cases: &[String]) {
        let mut cases: BTreeMap<String, Pin> =
            pinned.cases.into_iter().filter(|(c, _)| expected_cases.contains(c)).collect();
        cases.extend(self.actual);
        let file = GoldenFile {
            about: format!(
                "FNV-1a 64 and byte length of each {} output, keyed by case. Written by {}, never by hand.",
                self.kind,
                env!("CARGO_PKG_NAME")
            ),
            repin: self.repin_cmd,
            cases,
        };
        let mut text = serde_json::to_string_pretty(&file).expect("golden file serialises");
        text.push('\n');
        std::fs::create_dir_all(self.path.parent().expect("golden path has a parent")).expect("golden dir");
        std::fs::write(&self.path, text).unwrap_or_else(|e| panic!("writing {}: {e}", self.path.display()));
        eprintln!("re-pinned {}", self.path.display());
    }
}

#[test]
fn fnv1a64_matches_the_published_vectors() {
    assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
}
