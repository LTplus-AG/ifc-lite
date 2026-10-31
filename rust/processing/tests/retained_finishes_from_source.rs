// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 item 4: the retained session joins authored finishes over the scan it already did.
//!
//! `ModelFinishes::from_content` scans the whole file again and builds a second entity index (one hash
//! entry per entity: ~100-200 MB of browser heap on a large model). `ModelFinishes::from_source` takes the
//! styled-item spans of the candidate scan (`canonical_element_jobs_and_styled_items`) and the
//! `SourceBundle`'s own index, so it must (1) answer exactly what the rescan answered and (2) allocate
//! nothing proportional to the entity count.

use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::canonical_element_jobs_and_styled_items;
use ifc_lite_processing::style::ModelFinishes;
use ifc_lite_processing::{process, MeshData, ProcessingRequest, ProcessingSink};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Live and peak heap bytes, so a test can bracket one construction.
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new = System.realloc(ptr, layout, new_size);
        if !new.is_null() {
            let live = if new_size >= layout.size() {
                LIVE.fetch_add(new_size - layout.size(), Ordering::Relaxed) + (new_size - layout.size())
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed) - (layout.size() - new_size)
            };
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        new
    }
}
#[global_allocator]
static ALLOC: Counting = Counting;

/// Heap this closure leaves allocated, and the most it held at once, both above the heap before it ran.
fn heap<T>(build: impl FnOnce() -> T) -> (T, usize, usize) {
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let value = build();
    let retained = LIVE.load(Ordering::Relaxed).saturating_sub(before);
    (value, retained, PEAK.load(Ordering::Relaxed).saturating_sub(before))
}

#[derive(Default)]
struct Collect(Vec<MeshData>);
impl ProcessingSink for Collect {
    fn on_batch(&mut self, meshes: &[MeshData], _: usize, _: usize) {
        self.0.extend_from_slice(meshes);
    }
}

/// A glossy occurrence on a #957 type map (no item id) and on a styled item, plus `filler` entities that
/// carry no style: the file's size is all index.
fn model(filler: usize) -> String {
    let mut text = String::from(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('7955'),'2;1');
FILE_NAME('t.ifc','2026-10-31T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#43=IFCBOILERTYPE('2n5ASfQfT84eP9h$zLLJ4A',$,'Boiler',$,$,$,(#44),$,$,.NOTDEFINED.);
#44=IFCREPRESENTATIONMAP(#45,#46);
#45=IFCAXIS2PLACEMENT3D(#4,$,$);
#46=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#48));
#48=IFCTRIANGULATEDFACESET(#49,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#49=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#50=IFCSTYLEDITEM(#48,(#52),$);
#52=IFCSURFACESTYLE($,.POSITIVE.,(#54));
#54=IFCSURFACESTYLERENDERING(#56,$,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.METAL.);
#56=IFCCOLOURRGB($,0.6,0.5,0.4);
#100=IFCBUILDINGELEMENTPROXY('1occurrenceMapped0000',$,'Occ',$,$,#101,#102,$,.NOTDEFINED.);
#101=IFCLOCALPLACEMENT($,#5);
#102=IFCPRODUCTDEFINITIONSHAPE($,$,(#103));
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#104));
#104=IFCMAPPEDITEM(#44,#105);
#105=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);
#110=IFCSTYLEDITEM(#104,(#52),$);
"#,
    );
    for n in 0..filler {
        text.push_str(&format!("#{}=IFCCARTESIANPOINT(({n}.,0.,0.));\n", 1000 + n));
    }
    text.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    text
}

#[test]
fn from_source_equals_the_rescan_and_allocates_no_second_index() {
    let content = model(200_000);
    let meshes = {
        let mut sink = Collect::default();
        process(content.as_bytes(), &ProcessingRequest::full_pass(), &mut sink);
        sink.0
    };
    assert!(!meshes.is_empty(), "the fixture meshes");

    let source = SourceBundle::new(content.clone().into_bytes());
    let (_, styled_items) = canonical_element_jobs_and_styled_items(&source);
    assert_eq!(styled_items.len(), 2, "the candidate scan collected both styled items");

    // Build both joins, then compare what they say.
    let (mut rescan, rescan_retained, rescan_peak) = heap(|| ModelFinishes::from_content(content.as_bytes()));
    let (mut shared, shared_retained, shared_peak) = heap(|| ModelFinishes::from_source(&source, &styled_items));
    let expected: Vec<_> = meshes.iter().map(|mesh| rescan.finish_for_mesh(mesh)).collect();
    let actual: Vec<_> = meshes.iter().map(|mesh| shared.finish_for_mesh(mesh)).collect();
    assert_eq!(actual, expected, "from_source joins the same finish as the rescan, mesh by mesh");
    assert!(actual.iter().any(|finish| finish.is_some_and(|f| f.metallic == Some(1.0))), "the fixture authors a finish");

    // 200 000 entities: a second index is megabytes. The shared join holds the two styled records and a
    // handful of maps, so it stays under a tenth of it however the allocator rounds.
    eprintln!(
        "ModelFinishes heap, 200 000 entities: from_content retained {rescan_retained} B (peak {rescan_peak} B); \
         from_source retained {shared_retained} B (peak {shared_peak} B)"
    );
    assert!(rescan_retained > 1_000_000, "the rescan builds a second per-entity index ({rescan_retained} B)");
    assert!(
        shared_retained < rescan_retained / 10 && shared_peak < rescan_peak / 10,
        "from_source allocates nothing per entity: retained {shared_retained} B, peak {shared_peak} B \
         against the rescan's {rescan_retained} B / {rescan_peak} B"
    );
}

/// The browser session (wasm32 + `retained-browser` only, so not built here) must keep joining finishes
/// through `from_source`: a `from_content` call there is the second scan returning.
#[test]
fn the_browser_session_joins_finishes_without_scanning_the_file_again() {
    let session = include_str!("../../wasm-bindings/src/api/retained_session.rs");
    assert!(!session.contains("from_content"), "the retained session rescans the file for finishes");
    assert!(session.contains("ModelFinishes::from_source"), "the retained session joins finishes from its own scan");
}

/// Real authoring-tool files, small to a 177 MB tower. The join must agree with the rescan on every mesh of the
/// ones small enough to mesh here, and on every file hold less heap than the rescan did (the numbers are what
/// the PR reports). Absent fixtures skip; `pnpm fixtures` provides them.
#[test]
fn from_source_on_real_models_agrees_and_holds_less_heap() {
    const MESHED: &[&str] = &["ara3d/AC20-FZK-Haus.ifc", "ara3d/duplex.ifc", "ara3d/advanced_model.ifc"];
    const SCANNED: &[&str] = &[
        "ara3d/AC20-FZK-Haus.ifc",
        "ara3d/duplex.ifc",
        "ara3d/advanced_model.ifc",
        "ara3d/schependomlaan.ifc",
        "ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc",
        "ara3d/ISSUE_053_20181220Holter_Tower_10.ifc",
    ];
    let mut checked = 0;
    for rel in SCANNED {
        let Some(content) = ifc_lite_testkit::fixture_bytes(rel) else {
            eprintln!("skip {rel}: absent (run `pnpm fixtures`)");
            continue;
        };
        let bytes = content.len();
        let source = SourceBundle::new(content.clone());
        let (_, styled_items) = canonical_element_jobs_and_styled_items(&source);
        let started = std::time::Instant::now();
        let (mut rescan, rescan_retained, rescan_peak) = heap(|| ModelFinishes::from_content(&content));
        let rescan_ms = started.elapsed().as_secs_f64() * 1e3;
        let started = std::time::Instant::now();
        let (mut shared, shared_retained, shared_peak) = heap(|| ModelFinishes::from_source(&source, &styled_items));
        let shared_ms = started.elapsed().as_secs_f64() * 1e3;
        eprintln!(
            "REAL {rel} ({} MB, {} styled items): from_content retained {rescan_retained} B peak {rescan_peak} B {rescan_ms:.1} ms; \
             from_source retained {shared_retained} B peak {shared_peak} B {shared_ms:.1} ms",
            bytes / 1_000_000,
            styled_items.len()
        );
        assert!(shared_retained < rescan_retained && shared_peak < rescan_peak, "{rel}: no saving");
        if MESHED.contains(rel) {
            let mut sink = Collect::default();
            process(&content, &ProcessingRequest::full_pass(), &mut sink);
            for mesh in &sink.0 {
                assert_eq!(shared.finish_for_mesh(mesh), rescan.finish_for_mesh(mesh), "{rel} #{}", mesh.express_id);
            }
            eprintln!("REAL {rel}: {} meshes agree", sink.0.len());
        }
        checked += 1;
    }
    eprintln!("{checked} real models checked");
}
