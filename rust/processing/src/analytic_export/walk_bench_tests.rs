// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6442: opt-in, fresh-process analytic measurement. The uncached control
// remains in cfg(test); no production API or runtime switch is introduced.
use std::time::Instant;

const BASE: &str = include_str!("../../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
const BODY: &str = "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));";

fn many_instances() -> String {
    let mut items = vec!["#47".to_owned()];
    let mut added = String::new();
    for index in 1..1024 {
        let point = 2000 + index * 3;
        let operator = point + 1;
        let mapped = point + 2;
        added.push_str(&format!(
            "#{point}=IFCCARTESIANPOINT(({},0.,0.));\n\
             #{operator}=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#{point},$,$);\n\
             #{mapped}=IFCMAPPEDITEM(#45,#{operator});\n", index * 100,
        ));
        items.push(format!("#{mapped}"));
    }
    let replacement = format!("{added}#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',({}));", items.join(","));
    assert!(BASE.contains(BODY));
    BASE.replace(BODY, &replacement)
}

fn nested_reflected_scaled() -> String {
    let source = BASE.replace(BODY,
        "#1000=IFCCARTESIANPOINT((5000.,0.,0.));\n\
         #1001=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1000,2.,$);\n\
         #1002=IFCMAPPEDITEM(#45,#1001);\n\
         #48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47,#1002));")
        .replace("#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));",
        "#1003=IFCDIRECTION((0.,-1.,0.));\n\
         #1004=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#12,#1003,#10,$,$);\n\
         #1005=IFCREPRESENTATIONMAP(#13,#48);\n\
         #1006=IFCMAPPEDITEM(#1005,#1004);\n\
         #1007=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,3.,$);\n\
         #1008=IFCMAPPEDITEM(#1005,#1007);\n\
         #1011=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#1006,#1008));\n\
         #49=IFCPRODUCTDEFINITIONSHAPE($,$,(#1011));");
    assert_ne!(source, BASE);
    source
}

fn rss_kib() -> usize {
    let status = std::fs::read_to_string("/proc/self/status").expect("Linux /proc/self/status");
    status.lines().find_map(|line| line.strip_prefix("VmRSS:")
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse().ok())).expect("VmRSS in proc status")
}

struct StopSampler<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for StopSampler<'_> {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Run by scripts/perf/analytic-cache-ab.py. Each invocation is one fresh
/// test process, and only the extraction call is timed. The IFC is read before
/// timing; serialization happens after timing. VmRSS is sampled during the call.
#[test]
#[ignore = "opt-in #6442 measurement; use scripts/perf/analytic-cache-ab.py"]
fn issue_6442_analytic_cache_process_measurement() {
    let fixture = std::env::var("IFC_LITE_ANALYTIC_FIXTURE").expect("fixture name");
    let mode = std::env::var("IFC_LITE_ANALYTIC_MODE").expect("cache or control");
    let output_path = std::env::var("IFC_LITE_ANALYTIC_OUTPUT").expect("output path");
    let content = match fixture.as_str() {
        "snowdon" => std::fs::read(std::env::var("IFC_LITE_ANALYTIC_SNOWDON")
            .expect("Snowdon path; run pnpm fixtures")).expect("read Snowdon fixture"),
        "many" => many_instances().into_bytes(),
        "nested" => nested_reflected_scaled().into_bytes(),
        _ => panic!("unknown fixture: {fixture}"),
    };
    let baseline_rss_kib = rss_kib();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let peak = std::sync::atomic::AtomicUsize::new(baseline_rss_kib);
    let mut cache = MappedSourceCache::new();
    cache.enabled = match mode.as_str() {
        "cache" => true,
        "control" => false,
        _ => panic!("unknown mode: {mode}"),
    };
    let (result, elapsed_ns) = std::thread::scope(|scope| {
        let _stop_on_exit = StopSampler(&stop);
        scope.spawn(|| {
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                peak.fetch_max(rss_kib(), std::sync::atomic::Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        });
        let started = Instant::now();
        let result = extract_with_source_cache(&content, None, true, true, true, &mut cache);
        let elapsed_ns = started.elapsed().as_nanos();
        (result, elapsed_ns)
    });
    let peak_rss_kib = peak.load(std::sync::atomic::Ordering::Relaxed).max(rss_kib());
    // This separate index-only sample is outside the analytic call. It is a
    // parse-cost reference, not a partition of the measured call.
    let index_started = Instant::now();
    std::hint::black_box(ifc_lite_core::build_entity_index(&content));
    let standalone_index_ns = index_started.elapsed().as_nanos();
    let payload = serde_json::to_vec(&serde_json::json!({
        "descriptions": result.descriptions,
        "definitions": result.definitions,
        "extrusions": result.extrusions,
    })).expect("serialize complete ordered analytic result");
    std::fs::write(&output_path, &payload).expect("write analytic result");
    println!("ANALYTIC_CACHE_MEASURE {}", serde_json::json!({
        "fixture": fixture, "mode": mode, "elapsed_ns": elapsed_ns,
        "standalone_index_ns": standalone_index_ns,
        "baseline_rss_kib": baseline_rss_kib,
        "peak_rss_kib": peak_rss_kib,
        "source_loads": cache.loads, "cache_hits": cache.hits,
        "output_bytes": payload.len(),
        "description_products": result.descriptions.elements.len(),
        "description_occurrences": result.descriptions.elements.values().map(Vec::len).sum::<usize>(),
        "disk_sources": result.definitions.as_ref().map_or(0, |view| view.sources.len()),
        "disk_products": result.definitions.as_ref().map_or(0, |view| view.instances.len()),
        "disk_occurrences": result.definitions.as_ref().map_or(0, |view| view.instances.values().map(Vec::len).sum::<usize>()),
        "extrusion_sources": result.extrusions.as_ref().map_or(0, |view| view.sources.len()),
        "extrusion_products": result.extrusions.as_ref().map_or(0, |view| view.instances.len()),
        "extrusion_occurrences": result.extrusions.as_ref().map_or(0, |view| view.instances.values().map(Vec::len).sum::<usize>()),
        "diagnostics": result.descriptions.diagnostics.len(),
    }));
}
