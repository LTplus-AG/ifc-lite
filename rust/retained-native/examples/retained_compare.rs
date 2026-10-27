// SPDX-License-Identifier: MPL-2.0
//! Native M1 coverage and independent numerical comparison. Never repairs meshes.
#[path = "compare/metrics.rs"]
mod metrics;
#[path = "compare/options.rs"]
mod options;
#[path = "compare/precision.rs"]
mod precision;
#[path = "compare/report.rs"]
mod report;
#[path = "compare/source.rs"]
mod source;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::canonical_element_jobs;
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
    let tolerances: serde_json::Value = serde_json::from_slice(&std::fs::read(
        "tests/fixtures/cli-retained/tolerances.json",
    )?)?;
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
    let coverage = format!(
        "# SPDX-License-Identifier: MPL-2.0\nmodel\tid\tstatus\tcode\n{}\n",
        report.coverage.join("\n")
    );
    let pin = "tests/manifests/cli-retained-coverage.tsv";
    if options.bless {
        if !report.violations.is_empty()
            || !report.universe_mismatch.is_empty()
            || !report.skipped.is_empty()
        {
            return Err(
                "refusing to bless a run with violations, universe mismatch or missing fixtures"
                    .into(),
            );
        }
        std::fs::write(pin, &coverage)?;
    }
    if options.gate && std::fs::read_to_string(pin)? != coverage {
        report
            .violations
            .push("coverage or refusal histogram differs from committed manifest".into());
    }
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
    std::fs::write(options.out.join("products.tsv"),format!("model\tid\ttype\tstatus\tcode\torigin_cause\tcurved\tsrc_vol_rel\texact_vol_rel\texact_area_rel\texact_bbox_dev_m\tclosed\tms\tvolume_m3\tobligationsUnmet\tscope\tsrc_bbox_dev_m\tkernel_status\torigin_site\torigin_entity\tmessage\n{}\n",report.rows.join("\n")))?;
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
    let mut exact_metrics: BTreeMap<u32, Metrics> = BTreeMap::new();
    let mut exact_origins: BTreeMap<u32, Vec<[f64; 3]>> = BTreeMap::new();
    for mesh in &exact.meshes {
        exact_origins
            .entry(mesh.express_id)
            .or_default()
            .push(mesh.origin);
        let points: Vec<_> = mesh
            .positions
            .chunks_exact(3)
            .map(|p| {
                exact.frame.to_world([
                    mesh.origin[0] + p[0] as f64,
                    mesh.origin[1] + p[1] as f64,
                    mesh.origin[2] + p[2] as f64,
                ])
            })
            .collect();
        let measurement = exact_metrics.entry(mesh.express_id).or_default();
        measurement.add_mesh(&points, &mesh.indices)?;
    }
    let source = SourceBundle::new(bytes.clone());
    let candidates: BTreeSet<_> = canonical_element_jobs(&source)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let mut decoder = source.decoder();
    for (&id, metrics) in &exact_metrics {
        let entity = decoder.decode_by_id(id)?;
        if entity
            .ifc_type
            .is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct)
        {
            report
                .exact_only_type_products
                .push(json!({"model":model,"id":id,"scope":"out of M1 scope"}));
            report.rows.push(format!("{model}\t{id}\t{}\texact_only_type_product\t\t\t\t\t\t\t\t\t\t{}\t\tout of M1 scope\t\t\t\t\t", entity.ifc_type.name(), metrics.volume));
        } else if !candidates.contains(&id) {
            report.universe_mismatch.push(format!(
                "{model}:{id}: exact mesh omitted from canonical candidates"
            ));
        }
    }
    drop(decoder);
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(&bytes, None);
    let mut seen = BTreeSet::new();
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
                    let mut actual = Metrics::default();
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
                    report.published(
                        &model,
                        &shape,
                        &actual,
                        rounded.as_ref(),
                        exact_metrics.get(&id),
                        source::expected(&sources, id, shape.parts.len()),
                        tolerances,
                        ms,
                    );
                }
                ProductOutcome::Refused {
                    ifc_type,
                    refusal,
                    origin,
                    message,
                    ..
                } => {
                    let code = refusal.code();
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
                    let message = message.replace(['\t', '\n', '\r'], " ");
                    report.rows.push(format!(
                        "{model}\t{id}\t{}\trefused\t{code}\t{}\t\t\t\t\t\t\t{ms}\t\t\tM1\t\t{status}\t{}\t{}\t{message}",
                        ifc_type.name(), origin.map_or("", |o| o.cause),
                        origin.map_or("", |o| o.site),
                        origin.and_then(|o| o.entity).map(|id| id.to_string()).unwrap_or_default(),
                    ));
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
        "memorySemantics":"getrusage process lifetime high-water marks; children includes reaped workers"}));
    Ok(())
}
