// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C9a-0 (#7784): the pull-vs-stream differential oracle.
//!
//! Pull and stream are one parser fed two ways, but they were four parser
//! copies with two front ends, and they drifted (the EDGE-LXPARSE-1 class).
//! `tests/fuzz/differential.rs` compares them on arbitrary bytes. This file
//! replays it over every committed fuzz seed, the golden corpus and a table
//! of single-fault documents, and holds the named scenario table: the divergences
//! that are still open, and those fixed since.
//!
//! Scenario rule: a row names a divergence and a function that reports
//! whether pull and stream still disagree on it. An open row must keep
//! diverging (`scenarios_hold_their_status` fails when it stops, so the fixing
//! PR has to flip it), and a fixed row must keep agreeing. A divergence that
//! has no row fails the agreement tests, so none can be forgotten either.

#[path = "../../export/src/test_support.rs"]
#[allow(dead_code, unused_macros)] // shared with the export unit tests; this file uses `fixture_opt` only
mod test_support;

use std::path::Path;

include!("fuzz/exercise.rs");

const LANDXML_12: &str = "http://www.landxml.org/schema/LandXML-1.2";

/// A valid document touching every family.
fn all_families() -> String {
    format!(
        r#"<LandXML xmlns="{LANDXML_12}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0.5 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces><CgPoints><CgPoint name="control">1.25 2 3</CgPoint></CgPoints><Alignments><Alignment name="a" length="1" staStart="0"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line></CoordGeom></Alignment></Alignments><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>0 1 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>"#
    )
}

fn assert_agree(name: &str, data: &[u8], limits: &LandXmlLimits) {
    if let Err(divergence) = differential_landxml(data, limits) {
        panic!("{name}: pull and stream diverge: {divergence:?}");
    }
}

fn fuzz_seeds() -> Vec<(String, Vec<u8>)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fuzz/corpus/parse_landxml");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("read {dir:?}: {error}"))
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no fuzz seeds found at {dir:?}");
    files
        .into_iter()
        .map(|path| (path.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(&path).unwrap()))
        .collect()
}

/// The `landxml_golden.rs` corpus: in-tree files always, catalogued ones when
/// the fixture cache is present.
fn golden_corpus() -> Vec<(String, Vec<u8>)> {
    const FIXTURES: &[&str] = &[
        "apps/viewer/public/samples/terrain-tin-metric.xml",
        "rust/landxml/tests/fixtures/storm-pipe-network.xml",
        "landxml/federation/bonsai-topo-control-v1/terrain.xml",
        "landxml/producers/autodesk-civil3d-2020-international-foot-tin.xml",
        "landxml/producers/3d-win-6.6.4-m3-rockbed-terrain.xml",
        "landxml/producers/3d-win-6.6.4-m3-road-alignment.xml",
        "landxml/producers/3d-win-6.6.4-m3-lighting-cgpoints.xml",
        "landxml/producers/aplitop-mdt-8.0-alignment.xml",
        "landxml/producers/bentley-openroads-designer-10.09-us-survey-foot-alignment.xml",
        "landxml/producers/trimble-novapoint-21.354-drainage.xml",
    ];
    FIXTURES
        .iter()
        .filter_map(|path| {
            let bytes = if path.starts_with("apps/") || path.starts_with("rust/") {
                let abs = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
                Some(std::fs::read(&abs).unwrap_or_else(|e| panic!("in-tree fixture {abs}: {e}")))
            } else {
                test_support::fixture_opt(path)
            };
            bytes.map(|bytes| ((*path).to_owned(), bytes))
        })
        .collect()
}

#[test]
fn fuzz_seeds_agree() {
    for (name, data) in fuzz_seeds() {
        assert_agree(&name, &data, &LandXmlLimits::default());
    }
}

/// Corpus files that hit an open allowlist row, by fixture path.
const KNOWN_FIXTURES: &[(&str, &str)] = &[];

#[test]
fn golden_corpus_agrees() {
    let corpus = golden_corpus();
    assert!(corpus.iter().any(|(name, _)| name.starts_with("rust/")), "in-tree fixtures are always present");
    for (name, data) in corpus {
        if KNOWN_FIXTURES.iter().any(|(path, _)| *path == name) {
            continue;
        }
        assert_agree(&name, &data, &LandXmlLimits::default());
    }
}

#[test]
fn known_fixture_divergences_still_diverge() {
    for (name, data) in golden_corpus() {
        let Some((_, id)) = KNOWN_FIXTURES.iter().find(|(path, _)| *path == name) else { continue };
        assert!(SCENARIOS.iter().any(|row| row.id == *id), "{name}: no allowlist row {id}");
        assert!(
            differential_landxml(&data, &LandXmlLimits::default()).is_err(),
            "{name} no longer diverges ({id}): flip its scenario and delete it from KNOWN_FIXTURES"
        );
    }
}

/// Single-fault documents: every XML-level refusal must carry one code on
/// both paths.
#[test]
fn single_fault_documents_agree() {
    let ok = all_families();
    let cases: Vec<(&str, String)> = vec![
        ("valid", ok.clone()),
        ("empty", String::new()),
        ("whitespace only", "  \n".to_owned()),
        ("not LandXML", "<Other/>".to_owned()),
        ("unknown namespace", ok.replace(LANDXML_12, "urn:other")),
        ("unsupported version", ok.replace("version=\"1.2\"", "version=\"9.9\"")),
        ("version mismatch", ok.replace("version=\"1.2\"", "version=\"1.1\"")),
        ("unclosed", ok.replace("</LandXML>", "")),
        ("multiple roots", format!("{ok}{ok}")),
        ("mismatched end", ok.replace("</Units>", "</Unit>")),
        ("doctype", format!("<!DOCTYPE LandXML>{ok}")),
        ("undeclared entity", ok.replace("0.5 0 0", "0&custom;5 0 0")),
        ("text after root", format!("{ok}x")),
        ("text before root", format!("x{ok}")),
        ("reference after root", format!("{ok}&#32;")),
        ("cdata after root", format!("{ok}<![CDATA[x]]>")),
        ("units twice", ok.replace("</Units>", "<Imperial linearUnit=\"foot\"/></Units>")),
        ("unterminated comment", format!("{ok}<!-- x")),
        ("bad attribute", ok.replace("name=\"grade\"", "name=grade")),
        ("comment and PI around the root", format!("<?xml version=\"1.0\"?><!-- a -->{ok}<!-- b --><?pi x?>")),
        ("valid comment with dashes", ok.replace("<Units>", "<!-- -- --><Units>")),
    ];
    for (name, xml) in cases {
        assert_agree(name, xml.as_bytes(), &LandXmlLimits::default());
    }
}

/// Every cap refuses with `LimitExceeded` on both paths.
#[test]
fn tight_limits_agree() {
    let xml = all_families();
    let default = LandXmlLimits::default();
    let tight: Vec<(&str, LandXmlLimits)> = vec![
        ("depth", LandXmlLimits { max_depth: 2, ..default.clone() }),
        ("attributes", LandXmlLimits { max_attributes: 0, ..default.clone() }),
        ("surfaces", LandXmlLimits { max_surfaces: 0, ..default.clone() }),
        ("pipes", LandXmlLimits { max_pipes: 0, ..default.clone() }),
        ("points", LandXmlLimits { max_points: 1, ..default.clone() }),
        ("faces", LandXmlLimits { max_faces: 0, ..default.clone() }),
        ("text", LandXmlLimits { max_text_bytes: 3, ..default.clone() }),
        ("character references", LandXmlLimits { max_character_references: 0, ..default.clone() }),
        ("diagnostics", LandXmlLimits { max_capability_diagnostics: 0, ..default }),
    ];
    for (name, limits) in tight {
        assert_agree(name, xml.as_bytes(), &limits);
    }
    // A reference-bearing document at and below its reference cap.
    let referenced = xml.replace("0.5 0 0", "0&#46;5 0 0");
    for cap in [0, 1, 2] {
        let limits = LandXmlLimits { max_character_references: cap, ..LandXmlLimits::default() };
        assert_agree("reference cap", referenced.as_bytes(), &limits);
    }
}

// ---------------------------------------------------------------------------
// The allowlist.
// ---------------------------------------------------------------------------

enum Status {
    /// Pull and stream still disagree; the string names the work package
    /// that closes it. The scenario must keep diverging until that lands.
    #[allow(dead_code)] // every open scenario is closed (C9a-3b); the next drift adds one
    Open(&'static str),
    /// Fixed: the scenario is now a regression test that both paths agree.
    Agreed,
    /// An accepted, documented difference that never closes.
    Accepted(&'static str),
}

struct Scenario {
    /// Stable name. The fixing PR flips `Open` to `Agreed`; it never deletes
    /// the row, so the scenario stays pinned.
    id: &'static str,
    status: Status,
    /// `Err` while pull and stream disagree.
    probe: fn() -> Result<(), Divergence>,
}

const SCENARIOS: &[Scenario] = &[
    Scenario { id: "drift-1-work-charge", status: Status::Agreed, probe: work_boundary },
    Scenario { id: "drift-10-empty-comment-opener", status: Status::Agreed, probe: empty_comment_opener },
    Scenario { id: "drift-12-double-fault-outside-root", status: Status::Agreed, probe: double_fault_outside_root },
    Scenario { id: "drift-12-double-fault-encoding", status: Status::Agreed, probe: double_fault_encoding },
    Scenario { id: "d78-late-units-after-assumed-header", status: Status::Accepted("D78"), probe: late_units_after_assumed_header },
];

/// Smallest `max_work` the predicate accepts (it is monotone).
fn smallest_work(accepts: impl Fn(&LandXmlLimits) -> bool) -> usize {
    let at = |max_work| accepts(&LandXmlLimits { max_work, ..LandXmlLimits::default() });
    let (mut refused, mut accepted) = (0, 1_000_000);
    assert!(!at(refused) && at(accepted), "bounds must bracket the boundary");
    while accepted - refused > 1 {
        let middle = refused + (accepted - refused) / 2;
        if at(middle) { accepted = middle } else { refused = middle }
    }
    accepted
}

/// Drift 1: a document must cost the same work on both paths, or one
/// `max_work` accepts it through the stream and refuses it through the API.
fn work_boundary() -> Result<(), Divergence> {
    // The pipe family charges more than the others, so it would hide the
    // terrain and alignment copies behind its own maximum.
    let all = all_families();
    let xml = format!("{}{}", &all[..all.find("<PipeNetworks>").unwrap()], "</LandXML>");
    let pull = smallest_work(|limits| Pull::run(xml.as_bytes(), limits).codes().is_empty());
    for chunk in DIFFERENTIAL_CHUNKS {
        let stream = smallest_work(|limits| stream_accepts(xml.as_bytes(), chunk, limits));
        if stream != pull {
            return Err(Divergence {
                kind: DivergenceKind::Outcome,
                detail: format!("chunk {chunk}: pull needs max_work {pull}, stream needs {stream}"),
            });
        }
    }
    Ok(())
}

/// Drift 10: `<!-->x-->` is a comment whose content is `>x`.
fn empty_comment_opener() -> Result<(), Divergence> {
    let xml = all_families().replace("<Units>", "<!-->x--><Units>");
    differential_landxml(xml.as_bytes(), &LandXmlLimits::default())
}

/// Drift 12: a semantic fault in the document and content after the root.
/// The pull preflight used to read the whole document first and report the
/// content; both paths now stop at the first fault in source order (C9a-3b).
fn double_fault_outside_root() -> Result<(), Divergence> {
    let xml = format!("{}x", all_families().replace("<Surface name=\"grade\">", "<Surface>"));
    differential_landxml(xml.as_bytes(), &LandXmlLimits::default())
}

/// Drift 12, encoding variant: both paths judge the declared encoding as soon
/// as the XML declaration is complete (C9a-3a), ahead of any later fault. The
/// four producer files that declare ISO-8859-1 over an unknown namespace were
/// the corpus witnesses.
fn double_fault_encoding() -> Result<(), Divergence> {
    let xml = format!("<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?>{}", all_families().replace(LANDXML_12, "urn:other"));
    differential_landxml(xml.as_bytes(), &LandXmlLimits::default())
}

/// D78: a declared `<Units>` that arrives after the stream header committed
/// to an assumed unit is refused by the stream (#7753) because the surfaces
/// already drained were scaled by the assumption. Pull has read the whole
/// document first, so it uses the declared units and warns. Permanent.
fn late_units_after_assumed_header() -> Result<(), Divergence> {
    // The unit-less preflight guard of a header needs a surface that draws
    // to scale before `<Units>`.
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12}" version="1.2"><Surfaces><Surface name="s"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces><Units><Metric linearUnit="meter"/></Units></LandXML>"#
    );
    let limits = LandXmlLimits { assumed_linear_unit: Some("foot".to_owned()), ..LandXmlLimits::default() };
    differential_landxml(xml.as_bytes(), &limits)
}

#[test]
fn scenarios_hold_their_status() {
    let mut ids: Vec<_> = SCENARIOS.iter().map(|row| row.id).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), SCENARIOS.len(), "duplicate scenario ids");
    for row in SCENARIOS {
        let result = (row.probe)();
        match &row.status {
            Status::Open(by) | Status::Accepted(by) => assert!(
                result.is_err(),
                "{} (closed by {by}) no longer diverges: flip its status to Status::Agreed",
                row.id
            ),
            Status::Agreed => assert!(result.is_ok(), "{} regressed: {:?}", row.id, result),
        }
    }
}
