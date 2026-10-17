// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C9a-3b (#7784): the pull-vs-stream differential over mutated documents.
//!
//! `landxml_differential.rs` checks hand-written single faults. This walks a
//! deterministic stream of small edits (a flipped byte, an inserted `<`,
//! `-->`, `]]>`, quote or reference, a deleted span, a truncation) of the fuzz
//! seeds and a document that touches every family, and requires pull and
//! stream to agree on Ok versus Err and on every accepted value, at chunk
//! sizes 1, 7 and 4096. It is the stable-toolchain stand-in for a long fuzz
//! run; `MUTATION_ITERATIONS` raises the count.
//!
//! Error *codes* are not required to agree here. Two classes of double-fault
//! document still differ and are tracked, not hidden: bytes that are not
//! valid UTF-8 or UTF-16 (pull refuses the whole input before reading, the
//! stream refuses the chunk that holds them), and a numeric TIN surface
//! without `<Units>` (pull checks at the end of the document, the stream when
//! the surface completes).

use std::path::Path;

include!("fuzz/exercise.rs");

const SEED_DOCUMENT: &str = r#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0.5 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces><CgPoints><CgPoint name="c">1 2 3</CgPoint></CgPoints><PipeNetworks><PipeNetwork name="n" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct></Structs></PipeNetwork></PipeNetworks></LandXML>"#;

const FRAGMENTS: [&[u8]; 16] = [
    b"<", b">", b"<!--", b"-->", b"&", b"]]>", b"\"", b"'", b"<![CDATA[", b"<?", b"?>", b"</", b"/>",
    b"<!DOCTYPE", b"&#32;", b" ",
];

fn next(state: &mut u64) -> usize {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state as usize
}

fn mutate(state: &mut u64, seeds: &[Vec<u8>]) -> Vec<u8> {
    let mut data = seeds[next(state) % seeds.len()].clone();
    data.truncate(6000);
    for _ in 0..1 + next(state) % 3 {
        if data.is_empty() {
            break;
        }
        let at = next(state) % data.len();
        let fragment = FRAGMENTS[next(state) % FRAGMENTS.len()];
        let end = (at + 1 + next(state) % 30).min(data.len());
        match next(state) % 5 {
            0 => data[at] = next(state) as u8,
            1 => drop(data.splice(at..at, fragment.iter().copied())),
            2 => drop(data.drain(at..end)),
            3 => data.truncate(at),
            _ => drop(data.splice(at..end.min(at + 4), fragment.iter().copied())),
        }
    }
    data
}

#[test]
fn mutated_documents_agree_on_outcome_and_output() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fuzz/corpus/parse_landxml");
    let mut seeds: Vec<Vec<u8>> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("read {dir:?}: {error}"))
        .flatten()
        .map(|entry| std::fs::read(entry.path()).unwrap())
        .collect();
    seeds.push(SEED_DOCUMENT.as_bytes().to_vec());
    let iterations: usize =
        std::env::var("MUTATION_ITERATIONS").ok().and_then(|value| value.parse().ok()).unwrap_or(1500);
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    for index in 0..iterations {
        let data = mutate(&mut state, &seeds);
        if let Err(divergence) = differential_landxml(&data, &LandXmlLimits::default()) {
            assert!(
                divergence.kind == DivergenceKind::Code,
                "mutation {index} diverges: {divergence:?}\n{}",
                String::from_utf8_lossy(&data)
            );
        }
    }
}
