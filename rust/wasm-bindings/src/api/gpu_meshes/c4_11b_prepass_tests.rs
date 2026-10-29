// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::EntityScanner;

// #7782 C4-11b: metadata must share the live table, then release its lease so
// scanning can resume. A duplicate AFTER meta must win in the exported columns.
#[test]
fn c4_11b_metadata_shares_index_and_scan_resumes_with_complete_last_record_wins() {
    let source = b"DATA;#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCDIRECTION((1.,0.,0.));#1=IFCCARTESIANPOINT((2.,0.,0.));ENDSEC;";
    let mut index = SerialIndex::new(5_000_000);
    let mut scanner = EntityScanner::new(source);
    let (id, _, start, end) = scanner.next_entity().unwrap();
    index.insert(id, start, end);
    {
        let mut decoder = index.decoder(source);
        assert_eq!(
            Arc::strong_count(&index.0),
            2,
            "metadata must lease the scan's table"
        );
        assert!(decoder.decode_by_id(1).is_ok());
    }
    while let Some((id, _, start, end)) = scanner.next_entity() {
        index.insert(id, start, end);
    }
    let actual = index.into_columns().unwrap();
    let expected = ColumnarEntityIndex::from_scan(source).unwrap();
    assert_eq!(actual.ids(), &[1, 2]);
    assert_eq!(actual.ids(), expected.ids());
    assert_eq!(actual.starts(), expected.starts());
    assert_eq!(actual.lengths(), expected.lengths());
    let last = source.windows(4).rposition(|s| s == b"#1=I").unwrap();
    assert_eq!(actual.starts()[0] as usize, last);
}

// #7782: observe the actual scan callback, not just the trigger helper. A
// large scan must emit with a genuinely partial index; a small scan emits
// once with the complete index. Both must finish with every tail record.
#[test]
fn c4_11b_mid_scan_meta_leases_a_partial_index_and_tail_meta_a_complete_one() {
    use ifc_lite_processing::stream_meta::MetaMode;
    for jobs in [10, 61] {
        let mut source = String::from("DATA;\n");
        for id in 1..=jobs {
            source.push_str(&format!("#{id}=IFCWALL('wall',$,$,$,$,$,#9998,$,$);\n"));
        }
        source.push_str("#9999=IFCDIRECTION((1.,0.,0.));ENDSEC;");
        let bytes = source.as_bytes();
        let mut calls = 0;
        let scan = super::super::prepass_scan::scan_serial(
            bytes,
            &Default::default(),
            |discovery, decoder, mode| {
                calls += 1;
                if jobs > 50 {
                    assert!(matches!(mode, MetaMode::StreamingPartial { .. }));
                    assert_eq!(discovery.buffered_jobs.len(), 50);
                    assert!(
                        decoder.decode_by_id(9999).is_err(),
                        "tail cannot already be scanned"
                    );
                } else {
                    assert!(matches!(mode, MetaMode::SmallFileSingle));
                    assert!(decoder.decode_by_id(9999).is_ok());
                }
                Ok(1.0)
            },
        )
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(scan.discovery.total_jobs, jobs);
        let expected = ColumnarEntityIndex::from_scan(bytes).unwrap();
        assert_eq!(scan.index.ids(), expected.ids());
        assert_eq!(scan.index.starts(), expected.starts());
        assert_eq!(scan.index.lengths(), expected.lengths());
    }
}

// Native allocation measurement for the exact old/new metadata-index handoff.
// This is NOT an end-to-end timing or browser peak-memory benchmark.
#[cfg(not(target_arch = "wasm32"))]
mod allocations {
    use super::*;
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    thread_local! { static COUNTS: Cell<Option<(usize, usize)>> = const { Cell::new(None) }; }
    struct Counting;
    #[global_allocator]
    static ALLOCATOR: Counting = Counting;
    fn record(bytes: usize) {
        let _ = COUNTS.try_with(|c| {
            if let Some((n, size)) = c.get() {
                c.set(Some((n + 1, size + bytes)));
            }
        });
    }
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record(layout.size());
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            record(size);
            unsafe { System.realloc(ptr, layout, size) }
        }
    }
    fn measured<T>(f: impl FnOnce() -> T) -> (T, (usize, usize)) {
        COUNTS.with(|c| c.set(Some((0, 0))));
        let result = f();
        let counts = COUNTS.with(|c| c.replace(None).unwrap());
        (result, counts)
    }
    fn compare(name: &str, source: &[u8]) {
        let mut index = SerialIndex::new(source.len());
        let mut scanner = EntityScanner::new(source);
        while let Some((id, _, start, end)) = scanner.next_entity() {
            index.insert(id, start, end);
        }
        // C4-11a/#8259 copied only populated rows, not reserved capacity.
        let (old, before) = measured(|| {
            let snapshot = index.0.iter().map(|(&id, &span)| (id, span)).collect();
            EntityDecoder::with_index(source, snapshot)
        });
        let (new, after) = measured(|| index.decoder(source));
        assert!(after.0 < before.0 && after.1 < before.1);
        println!(
            "C4_11B_ALLOC {name} rows={} before={before:?} after={after:?}",
            index.0.len()
        );
        drop((old, new));
        let actual = index.into_columns().unwrap();
        let expected = ColumnarEntityIndex::from_scan(source).unwrap();
        assert_eq!(actual.ids(), expected.ids());
        assert_eq!(actual.starts(), expected.starts());
        assert_eq!(actual.lengths(), expected.lengths());
    }
    #[test]
    fn c4_11b_metadata_handoff_allocations() {
        compare(
            "bare-type-map",
            include_bytes!("../../../../processing/tests/fixtures/c4_bare_type_map_7782.ifc"),
        );
        compare(
            "list-type-map",
            include_bytes!("../../../../processing/tests/fixtures/c4_type_geometry_modes_7782.ifc"),
        );
        for name in ["AC20-FZK-Haus.ifc", "duplex.ifc"] {
            if let Some(bytes) = ifc_lite_testkit::fixture_bytes(&format!("ara3d/{name}")) {
                compare(name, &bytes);
            }
        }
    }
}
