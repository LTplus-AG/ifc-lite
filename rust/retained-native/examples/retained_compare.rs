// SPDX-License-Identifier: MPL-2.0
//! Native M1 coverage and independent numerical comparison. Never repairs meshes.
#[path = "compare/metrics.rs"]
mod metrics;
#[path = "compare/options.rs"]
mod options;
#[path = "compare/report.rs"]
mod report;
#[path = "compare/source.rs"]
mod source;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::canonical_element_jobs;
use ifc_lite_retained_native::{run_model_native_timed, ModelOptions, ProductOutcome};
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
    let mut report = report::Report::default();
    for path in &options.models {
        if !path.exists() {
            report
                .skipped
                .push(format!("{}: absent; run pnpm fixtures", path.display()));
            continue;
        }
        compare(path, &options, &tolerances, &mut report)?;
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
    std::fs::write(options.out.join("products.tsv"),format!("model\tid\ttype\tstatus\tcode\torigin_cause\tcurved\tsrc_vol_rel\texact_vol_rel\texact_area_rel\tbbox_dev_m\tclosed\tms\tvolume_m3\tobligationsUnmet\n{}\n",report.rows.join("\n")))?;
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
    options: &options::Options,
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
    for mesh in &exact.meshes {
        let points: Vec<_> = mesh
            .positions
            .chunks_exact(3)
            .map(|p| {
                exact
                    .frame
                    .to_world([p[0] as f64, p[1] as f64, p[2] as f64])
            })
            .collect();
        let measurement = exact_metrics.entry(mesh.express_id).or_default();
        let mut kernel_mesh = ifc_lite_geometry::Mesh::new();
        kernel_mesh.positions.clone_from(&mesh.positions);
        kernel_mesh.indices.clone_from(&mesh.indices);
        let volume =
            measurement.volume + ifc_lite_geometry::mesh_check::signed_volume(&kernel_mesh).abs();
        measurement.add_mesh(&points, &mesh.indices)?;
        measurement.volume = volume;
    }
    let source = SourceBundle::new(bytes.clone());
    let candidates: BTreeSet<_> = canonical_element_jobs(&source)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(&bytes, None);
    let mut seen = BTreeSet::new();
    let mut last = Instant::now();
    let (summary, timings) = run_model_native_timed(
        source,
        &options.worker,
        &ModelOptions::default(),
        |outcome| {
            let ms = last.elapsed().as_secs_f64() * 1000.;
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
                    report.published(
                        &model,
                        &shape,
                        &actual,
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
                    ..
                } => {
                    let code = refusal.code();
                    *report.histogram.entry(code.into()).or_default() += 1;
                    if code == "contract_breach" {
                        report
                            .violations
                            .push(format!("{model}:{id}: contract_breach"));
                    }
                    report.rows.push(format!(
                        "{model}\t{id}\t{}\trefused\t{code}\t{}\t\t\t\t\t\t\t{ms}\t\t",
                        ifc_type.name(),
                        origin.map_or("", |o| o.cause)
                    ));
                    report
                        .coverage
                        .push(format!("{model}\t{id}\trefused\t{code}"));
                }
            }
            last = Instant::now();
        },
    )?;
    let retained_ms = timings.total_ms;
    report.retained_ms += retained_ms;
    if candidates != seen {
        report
            .universe_mismatch
            .push(format!("{model}: scheduler/outcome universe differs"));
    }
    report.models.push(json!({"model":model,"exact":{"milliseconds":exact_ms,"processMaxRssKiB":exact_rss,"phases":exact.stats},
        "retained":{"milliseconds":retained_ms,"phasesMs":{"startupAndQualification":timings.startup_and_qualification_ms,"construction":timings.construction_ms,"affine":timings.affine_ms,"boolean":timings.boolean_ms,"controllerAndPublication":timings.controller_and_publication_ms},"processMaxRssKiB":report::rss(false)?,"childrenMaxRssKiB":report::rss(true)?,"restarts":summary.restarts},
        "memorySemantics":"getrusage process lifetime high-water marks; children includes reaped workers"}));
    Ok(())
}
