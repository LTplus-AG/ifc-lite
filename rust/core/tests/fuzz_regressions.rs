// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Corpus-replay gate for the `rust/core/fuzz` STEP-grammar targets (G7,
//! #7778, CORE-30).
//!
//! `cargo fuzz` needs nightly and only runs on a schedule
//! (`.github/workflows/fuzz.yml`, non-blocking). This replays the committed
//! corpus under `fuzz/corpus/<target>/` through the SAME assertions the
//! targets run (`tests/support/grammar_oracle.rs`, included by both), on
//! stable `cargo test`, so it runs in the required `rust-tests` lane. A crash
//! a scheduled run finds gets its minimized input committed there, and this
//! test pins the fix.
//!
//! The corpus is synthetic seeds: every input of the shared grammar fixtures
//! plus the repros of the findings F4 closed (`.5` in a coordinate list, a
//! comment holding a `(`, `DATA ;`, a run of unterminated `\X2\`). Each seed
//! is also mutated a fixed number of times with a fixed-seed generator, which
//! is the cheap stable stand-in for a coverage-guided run: byte flips,
//! insertions, deletions and splices around the grammar's delimiters.

#[path = "support/grammar_oracle.rs"]
mod oracle;

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};

const MUTATIONS_PER_SEED: usize = 60;

fn corpus(target: &str) -> Vec<(String, Vec<u8>)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fuzz/corpus").join(target);
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read {dir:?}: {e}"))
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no corpus files at {dir:?}: the replay gate found nothing to replay");
    paths
        .into_iter()
        .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()))
        .collect()
}

/// xorshift64*: deterministic, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

const TOKENS: &[&[u8]] = &[
    b"'", b"''", b"\\S\\", b"\\X2\\", b"\\X0\\", b"/*", b"*/", b"(", b")", b",", b"$", b"*", b"#",
    b".", b"E", b"+", b"-", b"\"", b";", b"=", b" ", b"\x0b", b"1", b"#1", b".T.", b"IFCX(",
];

fn mutate(seed: &[u8], rng: &mut Rng) -> Vec<u8> {
    let mut out = seed.to_vec();
    for _ in 0..1 + rng.below(3) {
        match rng.below(4) {
            0 if !out.is_empty() => {
                let at = rng.below(out.len());
                out[at] = rng.next() as u8;
            }
            1 => {
                let at = rng.below(out.len() + 1);
                let token = TOKENS[rng.below(TOKENS.len())];
                out.splice(at..at, token.iter().copied());
            }
            2 if !out.is_empty() => {
                let at = rng.below(out.len());
                let len = 1 + rng.below(4);
                out.drain(at..(at + len).min(out.len()));
            }
            _ => {
                let at = rng.below(out.len() + 1);
                let from = rng.below(out.len() + 1);
                let chunk: Vec<u8> = out[from..(from + 8).min(out.len())].to_vec();
                out.splice(at..at, chunk);
            }
        }
    }
    out
}

/// Run `check` over every corpus file and its mutations; collect the inputs
/// that panicked so one bad file does not hide the rest.
fn replay(target: &str, check: fn(&[u8])) {
    let mut failures = Vec::new();
    for (index, (name, seed)) in corpus(target).into_iter().enumerate() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ ((index as u64 + 1) << 20));
        let inputs = std::iter::once(seed.clone())
            .chain((0..MUTATIONS_PER_SEED).map(|_| mutate(&seed, &mut rng)));
        for input in inputs {
            if std::panic::catch_unwind(AssertUnwindSafe(|| check(&input))).is_err() {
                failures.push(format!("{name}: {:?}", String::from_utf8_lossy(&input).chars().take(120).collect::<String>()));
                break;
            }
        }
    }
    assert!(failures.is_empty(), "{target}: the oracle failed on\n{}", failures.join("\n"));
}

#[test]
fn grammar_differential_corpus_holds_the_oracle() {
    replay("grammar_differential", oracle::check_all);
}

#[test]
fn scan_file_corpus_is_total() {
    replay("scan_file", oracle::scan);
}

#[test]
fn decode_string_corpus_is_total() {
    replay("decode_string", oracle::decode_string);
}
