// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Allocation sized by untrusted input in the LandXML TIN parser (#7675).

use ifc_lite_landxml::{parse_landxml_tin, LandXmlDiagnosticCode, LANDXML_12_NAMESPACE};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

/// Counts this thread's live heap bytes and their peak, so a test can measure
/// what one parse retains without the other tests' threads in the number.
struct ThreadPeak;

thread_local! {
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for ThreadPeak {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.with(|l| l.get()) + layout.size();
        LIVE.with(|l| l.set(live));
        PEAK.with(|p| p.set(p.get().max(live)));
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.with(|l| l.set(l.get().saturating_sub(layout.size())));
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOC: ThreadPeak = ThreadPeak;

/// Peak heap bytes this thread held while running `f`, above what it held before.
fn peak_during(f: impl FnOnce()) -> usize {
    let before = LIVE.with(|l| l.get());
    PEAK.with(|p| p.set(before));
    f();
    PEAK.with(|p| p.get()) - before
}

const UNITS: &str = r#"<Units><Metric linearUnit="meter"/></Units>"#;

/// `depth` nested target-namespace elements with 256-byte names (the name
/// limit) around `inner`: the longest ancestor path the limits allow.
fn deep(depth: usize, inner: &str) -> String {
    let name = "b".repeat(256);
    let mut xml = format!(r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:x="urn:x" version="1.2">{UNITS}"#);
    xml.push_str(&format!("<{name}>").repeat(depth));
    xml.push_str(inner);
    xml.push_str(&format!("</{name}>").repeat(depth));
    xml.push_str("</LandXML>");
    xml
}

/// EDGE-LXPARSE-4: each foreign-namespace child of a target element keeps its
/// full joined ancestor path, ~16 KB at the depth and name limits, so 44 KB
/// of input retained 32 MB of paths (and 100 000 roots, the extension limit,
/// ~1.6 GB). Retained path bytes are charged to a budget.
#[test]
fn edge_lxparse_4_extension_root_paths_are_charged_to_a_budget() {
    let xml = deep(62, &"<x:a/>".repeat(2_000));
    let Err(error) = parse_landxml_tin(xml.as_bytes()) else { panic!("32 MB of paths from 44 KB of input parsed") };
    assert_eq!(error.code, LandXmlDiagnosticCode::LimitExceeded, "{error:?}");
    assert!(error.message.contains("path"), "{error:?}");
}

/// The same amplification through the preserved-only corridor/stringline
/// records, which keep the path twice (the record and its diagnostic) and
/// have a 1 000 000-record limit of their own.
#[test]
fn edge_lxparse_4_preserved_only_paths_share_the_budget() {
    let xml = deep(61, &format!("<x:wrap>{}</x:wrap>", "<x:Corridor/>".repeat(1_000)));
    let Err(error) = parse_landxml_tin(xml.as_bytes()) else { panic!("31 MB of paths from 30 KB of input parsed") };
    assert_eq!(error.code, LandXmlDiagnosticCode::LimitExceeded, "{error:?}");
}

/// The budget binds hostile depth, not real extensions.
#[test]
fn edge_lxparse_4_ordinary_extensions_still_parse() {
    let doc = parse_landxml_tin(deep(2, &"<x:a/><x:Corridor/>".repeat(1_000)).as_bytes()).expect("parses");
    assert_eq!(doc.extensions.len(), 2_000);
    assert_eq!(doc.preserved_only_extensions.len(), 1_000);
}

/// EDGE-LXPARSE-17: every element inserted its name into its parent's sibling
/// ordinal map, which lives as long as the parent, so a root with N distinct
/// child names held N map entries. Ordinals are read only by the TIN
/// coordinate-list paths, so only those names need one.
#[test]
fn edge_lxparse_17_distinct_child_names_do_not_accumulate() {
    let children: String = (0..100_000).map(|i| format!("<a{i:06}/>")).collect();
    let xml = format!(r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2">{UNITS}{children}</LandXML>"#);
    let mut parsed = None;
    let peak = peak_during(|| parsed = Some(parse_landxml_tin(xml.as_bytes())));
    parsed.expect("ran").expect("parses");
    // The parse copies the input once (encoding normalisation); everything
    // else it needs for this document is a few frames.
    assert!(peak < 3 * xml.len(), "peak {peak} bytes for {} bytes of input", xml.len());
}

/// EDGE-LXPARSE-24: each repeated root `<CoordinateSystem/>` (19 bytes)
/// pushed an ~85-byte warning, so 64 MB of them was ~3.5 M warnings. One
/// warning, with the count.
#[test]
fn edge_lxparse_24_repeated_coordinate_systems_warn_once_with_a_count() {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2">{UNITS}{}</LandXML>"#,
        "<CoordinateSystem/>".repeat(10_000)
    );
    let doc = parse_landxml_tin(xml.as_bytes()).expect("parses");
    let warnings: Vec<_> = doc.warnings.iter().filter(|w| w.contains("CoordinateSystem")).collect();
    assert_eq!(warnings.len(), 1, "{} CoordinateSystem warnings", warnings.len());
    assert!(warnings[0].contains("10000"), "{warnings:?}");
}
