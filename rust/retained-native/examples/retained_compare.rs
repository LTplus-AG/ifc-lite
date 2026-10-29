// SPDX-License-Identifier: MPL-2.0
//! Native M1 coverage and independent numerical comparison. Never repairs meshes.
#[path = "compare/affine.rs"]
mod affine;
#[path = "compare/metrics.rs"]
mod metrics;
#[path = "compare/openings.rs"]
mod openings;
#[path = "compare/options.rs"]
mod options;
#[path = "compare/precision.rs"]
mod precision;
#[path = "compare/report.rs"]
mod report;
#[path = "compare/layer_report.rs"]
mod layer_report;
#[path = "compare/source.rs"]
mod source;
#[path = "compare/tolerances.rs"]
mod tolerances;
#[path = "compare/registry.rs"]
mod registry;
#[path = "compare/checks/mod.rs"]
mod checks;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{canonical_element_jobs, canonical_type_maps};
use ifc_lite_processing::element::retained_runtime::RetainedProductRefusal;
use ifc_lite_retained_native::{ModelOptions, NativeModelDriver, ProductOutcome};
use metrics::{transform, Metrics};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::Instant,
};
type Error = Box<dyn std::error::Error>;

fn main() -> Result<(), Error> {
    let options = options::options()?;
    let tolerances = tolerances::registered()?;
    // Fail before reporting coverage if no qualified numerical engine exists.
    let startup = Instant::now();
    let qualified = ifc_lite_retained_native::NativeWorker::spawn(&options.worker)
        .map_err(|error| format!("native engine startup/qualification failed: {error}"))?;
    let mut report = report::Report {
        startup_ms: startup.elapsed().as_secs_f64() * 1000.,
        ..Default::default()
    };
    let mut driver = NativeModelDriver::with_worker(&options.worker, qualified);
    for path in &options.models {
        if !path.exists() {
            report
                .skipped
                .push(format!("{}: absent; run pnpm fixtures", path.display()));
            continue;
        }
        compare(path, &mut driver, &tolerances, &mut report)?;
        write_report(&options, &mut report, false)?;
    }
    report.rows.sort();
    report.coverage.sort();
    if options.bless && (!report.violations.is_empty() || !report.universe_mismatch.is_empty() || !report.skipped.is_empty()) {
        return Err("refusing to bless a run with violations, universe mismatch or missing fixtures".into());
    }
    registry::coverage(&report.coverage, options.bless, options.gate, &mut report.violations)?;
    write_report(&options, &mut report, true)?;
    if options.gate
        && (!report.violations.is_empty()
            || !report.universe_mismatch.is_empty()
            || !report.skipped.is_empty())
    {
        return Err("native comparison gate failed; see summary.json".into());
    }
    Ok(())
}
// Checkpoint completed models so a corpus interruption preserves honest partial evidence.
fn write_report(
    options: &options::Options,
    report: &mut report::Report,
    complete: bool,
) -> Result<(), Error> {
    report.rows.sort();
    std::fs::create_dir_all(&options.out)?;
    std::fs::write(options.out.join("products.tsv"),format!("model\tid\ttype\tstatus\tcode\torigin_cause\tcurved\tsrc_vol_rel\texact_vol_rel\texact_area_rel\texact_bbox_dev_m\tclosed\tms\tvolume_m3\tobligationsUnmet\tscope\tsrc_bbox_dev_m\tkernel_status\torigin_site\torigin_entity\tmessage\tcuts\tcutMs\tconsumedParts\tsrc_cut_vol_rel\tsrc_oracle\n{}\n",report.rows.join("\n")))?;
    let mut summary = report.summary();
    summary["complete"] = json!(complete);
    summary["modelsRequested"] = json!(options.models.len());
    std::fs::write(
        options.out.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    Ok(())
}
fn compare(
    path: &Path,
    driver: &mut NativeModelDriver,
    tolerances: &serde_json::Value,
    report: &mut report::Report,
) -> Result<(), Error> {
    let bytes = std::fs::read(path)?;
    let model = path.to_string_lossy();
    let start = Instant::now();
    let exact = ifc_lite_processing::process_geometry(&bytes);
    let exact_ms = start.elapsed().as_secs_f64() * 1000.;
    report.exact_ms += exact_ms;
    let exact_rss = report::rss(false)?;
    let mut exact_origins: BTreeMap<u32, Vec<[f64; 3]>> = BTreeMap::new();
    let mut exact_items: BTreeMap<u32, (BTreeSet<u32>, bool)> = BTreeMap::new();
    let layer_candidates = layer_report::candidates(&bytes);
    let exact_metrics = measure_exact(&exact)?;
    for mesh in &exact.meshes {
        let items = exact_items.entry(mesh.express_id).or_default();
        match mesh.geometry_item_id { Some(item) => { items.0.insert(item); } None => items.1 = true }
        exact_origins
            .entry(mesh.express_id)
            .or_default()
            .push(mesh.origin);
    }
    let source = SourceBundle::new(bytes.clone());
    let candidates: BTreeSet<_> = canonical_element_jobs(&source)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let mut decoder = source.decoder();
    for (&id, metrics) in &exact_metrics {
        let entity = decoder.decode_by_id(id)?;
        if !candidates.contains(&id) && entity
            .ifc_type
            .is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct)
        {
            report
                .exact_only_type_products
                .push(json!({"model":model,"id":id,"scope":"unexpected exact-only type product"}));
            report.universe_mismatch.push(format!("{model}:{id}: exact type mesh omitted from canonical candidates"));
            report.rows.push(format!("{model}\t{id}\t{}\texact_only_type_product\t\t\t\t\t\t\t\t\t\t{}\t\tunexpected exact-only type product\t\t\t\t\t", entity.ifc_type.name(), metrics.volume));
            report.rows.last_mut().unwrap().push_str("\t\t\t\t\t");
        } else if !candidates.contains(&id) {
            report.universe_mismatch.push(format!(
                "{model}:{id}: exact mesh omitted from canonical candidates"
            ));
        }
    }
    drop(decoder);
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(&bytes, None);
    let type_maps = canonical_type_maps(&source);
    report.type_candidates += type_maps.len();
    let type_expectations: BTreeMap<_, _> = type_maps.iter().map(|(&id, maps)| {
        ifc_lite_retained_native::oracle::type_maps::expected(&bytes, &sources, maps).map(|value| (id, value))
    }).collect::<Result<_, _>>()?;
    let retraced = source::retraced(path, &sources, &mut source.decoder(), tolerances)?;
    let mut opening_expectations = openings::expectations(&bytes, &sources)?;
    let retraced_opening = source::retraced_opening(path, &sources, &mut source.decoder(), tolerances)?;
    let has_retraced_opening = retraced_opening.is_some();
    if let Some(expected) = retraced_opening {
        opening_expectations.insert(72209, Some(expected));
    }
    let opening_inventory = ifc_lite_retained_native::oracle::inventory::opening_inventory(&bytes, &sources);
    let mut seen = BTreeSet::new();
    let oracle_source = source.clone();
    let mut affine_oracle = ifc_lite_retained_native::oracle::affine::AffineOracle::new(&oracle_source);
    let clip_oracle = ifc_lite_retained_native::oracle::clips::ClipOracle::new(&oracle_source, &sources);
    let (summary, timings) = driver.run_model(
        source,
        &ModelOptions::default(),
        |outcome, ms| {
            let id = match &outcome {
                ProductOutcome::Published(s) => s.product_id,
                ProductOutcome::Refused { product_id, .. } => *product_id,
            };
            if !seen.insert(id) {
                report
                    .universe_mismatch
                    .push(format!("{model}:{id}: duplicate outcome"));
            }
            report.candidates += 1;
            match outcome {
                ProductOutcome::Published(shape) => {
                    report.layers.outcome(&layer_candidates, id, "published");
                    if let Err(error) = report.layers.published(&model, &shape, &exact) {
                        report.violations.push(format!("{model}:{id}: layer report: {error}"));
                    }
                    let layered = shape.parts.iter().any(|p| p.layer.is_some());
                    let mut actual = if layered { Metrics::assembly() } else { Metrics::default() };
                    for part in &shape.parts {
                        let points: Vec<_> = part
                            .positions
                            .chunks_exact(3)
                            .map(|p| transform(&part.world_from_object, [p[0], p[1], p[2]]))
                            .collect();
                        if let Err(e) = actual.add_mesh(&points, &part.indices) {
                            report.violations.push(format!("{model}:{id}: {e}"));
                        }
                    }
                    let rounded = exact_origins.get(&id).and_then(|origins| {
                        match precision::measure(&shape, exact.frame, origins) {
                            Ok(metrics) => Some(metrics),
                            Err(error) => { report.violations.push(format!("{model}:{id}: {error}")); None }
                        }
                    });
                    let retraced = (shape.product_id == 72245).then_some(retraced).flatten();
                    let expectation = if let Some(value) = type_expectations.get(&id) {
                        if value.as_ref().is_none_or(|v| v.parts != shape.parts.len()) {
                            report.violations.push(format!("{model}:{id}: missing or incomplete type source oracle"));
                        }
                        value.as_ref().map(|v| (v.volume, v.bbox))
                    } else {
                        // Bands partition one admitted source host.
                        retraced.or_else(|| source::expected(&sources, id, if layered { 1 } else { shape.parts.len() }))
                    };
                    report.published(
                        &model,
                        &shape,
                        &actual,
                        rounded.as_ref(),
                        exact_metrics.get(&id),
                        expectation,
                        tolerances,
                        ms,
                        opening_expectations.get(&id),
                        &checks::SourceContext { product_id: id, analytic: &sources, clips: &clip_oracle },
                        retraced.is_some() || (id == 72209 && has_retraced_opening),
                        &bytes,
                    );
                    affine::record(report, &mut affine_oracle, &shape, tolerances);
                    report.face_projection.push(checks::faces::exact_projection(&model, &shape, exact_items.get(&id)));
                }
                ProductOutcome::Refused {
                    ifc_type,
                    refusal,
                    origin,
                    message,
                    cut_times_ms,
                    ..
                } => {
                    let code = refusal.code();
                    report.layers.outcome(&layer_candidates, id, code);
                    let cuts = cut_times_ms.len();
                    let cut_ms = cut_times_ms.iter().sum::<f64>();
                    report.cuts += cuts as u64;
                    report.cut_times_ms.extend_from_slice(&cut_times_ms);
                    *report.histogram.entry(code.into()).or_default() += 1;
                    if code == "contract_breach" {
                        report
                            .violations
                            .push(format!("{model}:{id}: contract_breach"));
                    }
                    let status = match refusal {
                        RetainedProductRefusal::KernelFailure { status } => status.to_string(),
                        _ => String::new(),
                    };
                    // A refused product carries no consumed-part count: leave the
                    // column empty rather than report 0 for a consumed host.
                    let message = message.replace(['\t', '\n', '\r'], " ");
                    report.rows.push(format!(
                        "{model}\t{id}\t{}\trefused\t{code}\t{}\t\t\t\t\t\t\t{ms}\t\t\tM1\t\t{status}\t{}\t{}\t{message}\t{cuts}\t{cut_ms}\t\t\t",
                        ifc_type.name(), origin.map_or("", |o| o.cause),
                        origin.map_or("", |o| o.site),
                        origin.and_then(|o| o.entity).map(|id| id.to_string()).unwrap_or_default(),
                    ));
                    affine::refusal(report, &mut affine_oracle, id, code);
                    report
                        .coverage
                        .push(format!("{model}\t{id}\trefused\t{code}"));
                }
            }
        },
    )?;
    let retained_ms = timings.total_ms;
    report.retained_ms += retained_ms;
    report.startup_ms += timings.startup_and_qualification_ms;
    report.product_ms += timings.product_ms;
    if candidates != seen {
        report
            .universe_mismatch
            .push(format!("{model}: scheduler/outcome universe differs"));
    }
    report.models.push(json!({"model":model,"exact":{"milliseconds":exact_ms,"processMaxRssKiB":exact_rss,"phases":exact.stats},
        "retained":{"milliseconds":retained_ms,"productMilliseconds":timings.product_ms,"acquireMilliseconds":summary.acquire_ms,"phasesMs":{"startupAndQualification":timings.startup_and_qualification_ms,"construction":timings.construction_ms,"affine":timings.affine_ms,"boolean":timings.boolean_ms,"controllerAndPublication":timings.controller_and_publication_ms},"processMaxRssKiB":report::rss(false)?,"childrenMaxRssKiB":report::rss(true)?,"restarts":summary.restarts},
        "openingSources":{"supportedExtrusions":opening_inventory.supported_extrusions,"noAnalyticQuantities":opening_inventory.no_analytic_quantities},
        "openingCounters":"M3-A: cuts/cutMs include attempted cuts of refused products; any consumed part refuses the whole product",
        "memorySemantics":"getrusage process lifetime high-water marks; children includes reaped workers"}));
    Ok(())
}

// Exact's layer meshes are individually closed, including their interface caps.
// Only retained's open bands share an assembly edge ledger.
fn measure_exact(exact: &ifc_lite_processing::ProcessingResult) -> Result<BTreeMap<u32, Metrics>, String> {
    let mut measured: BTreeMap<u32, Metrics> = BTreeMap::new();
    for mesh in &exact.meshes {
        let points: Vec<_> = mesh.positions.chunks_exact(3).map(|p| {
            exact.frame.to_world(std::array::from_fn(|i| mesh.origin[i] + f64::from(p[i])))
        }).collect();
        measured.entry(mesh.express_id).or_default().add_mesh(&points, &mesh.indices)?;
    }
    Ok(measured)
}

// #7955 / PR #8324: shared interface edges between closed exact bands are not defects.
#[test]
fn exact_closed_layer_meshes_have_zero_closure_defects() {
    let text = include_str!("../../../tests/fixtures/synthetic-retained/m4-band-appearance.ifc");
    let exact = ifc_lite_processing::process_geometry(text.as_bytes());
    assert_eq!(exact.meshes.iter().filter(|mesh| mesh.express_id == 22).count(), 3);
    let measured = measure_exact(&exact).unwrap();
    let wall = measured.get(&22).unwrap();
    assert_eq!(wall.defects, 0);
    assert!((wall.volume - 3.6).abs() < 1e-6);
    // Demonstrate why assembly counting is wrong for these closed solids.
    let mut assembly = Metrics::assembly();
    for mesh in exact.meshes.iter().filter(|mesh| mesh.express_id == 22) {
        let points: Vec<_> = mesh.positions.chunks_exact(3).map(|p| {
            exact.frame.to_world(std::array::from_fn(|i| mesh.origin[i] + f64::from(p[i])))
        }).collect();
        assembly.add_mesh(&points, &mesh.indices).unwrap();
    }
    assert!(assembly.defects > 0, "old assembly metric falsely reports shared cap edges");
    assert!((assembly.volume - wall.volume).abs() < 1e-6);
    assert_eq!(assembly.area, wall.area);
    assert_eq!(assembly.bbox, wall.bbox);
}
