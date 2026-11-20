// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: real SDK, all committed published products, independent source normals.
mod support;
#[path = "support/m11_n_exact.rs"]
mod exact_report;
#[path = "support/m11_n_fi.rs"]
mod fi;
#[path = "support/m11_n_sides.rs"]
mod sides;
use ifc_lite_retained_native::{oracle::normals, ProductOutcome};
use ifc_lite_processing::element::retained_runtime::ModelOptions;
use ifc_lite_geometry::program::transactions::Requirement;
use std::{collections::BTreeMap, path::Path};
use serde_json::json;

fn universe(root: &Path) -> BTreeMap<String,BTreeMap<u32,String>> {
    let mut paths = vec![root.join("tests/manifests/cli-retained-coverage.tsv")];
    paths.extend(std::fs::read_dir(root.join("tests/manifests/cli-retained-coverage.d")).unwrap()
        .map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|s| s=="tsv")));
    let mut models: BTreeMap<String,BTreeMap<u32,String>> = BTreeMap::new();
    for path in paths {
        for line in std::fs::read_to_string(path).unwrap().lines().filter(|s| !s.is_empty() && !s.starts_with('#') && !s.starts_with("model\t")) {
            let fields: Vec<_> = line.split('\t').collect();
            let status = if fields[2] == "refused" {format!("refused:{}",fields[3])} else {fields[2].into()};
            assert!(models.entry(fields[0].into()).or_default().insert(fields[1].parse().unwrap(), status).is_none());
        }
    }
    // Ruling A (#7955): (e) has an upstream multi-segment directrix refusal.
    // This assertion must flag when that route lands so its bend gate is enabled.
    assert!(models.insert(fi::MODEL.into(),[(425,"published".into()),(507,"refused:operation_unsupported".into())].into_iter().collect()).is_none());
    models
}

/// One published m11-n reference row; shared with the determinism test so both
/// serialize exactly the bytes the browser lanes read.
fn published_row(product: &ifc_lite_retained_native::ShapeOnlyProduct, source: &[normals::Surface]) -> serde_json::Value {
    json!({"id":product.product_id,"status":"published","sourceSurfaces":source,"parts":product.parts.iter().map(|p|
        json!({"normals":p.normals,"positions":p.positions,"indices":p.indices,"frame":p.world_from_object,
            "revisionLocalFaces":p.revision_local_faces,
            "surfaceIndices":normals::check_mesh(&p.positions,&p.indices,&p.world_from_object,
                p.normals.as_ref().unwrap(),source).unwrap().surface_indices}))
        .collect::<Vec<_>>() })
}

/// The m11-n reference rows of one model, as the corpus test writes them.
fn reference_rows(root: &Path, model: &str, worker: &std::ffi::OsStr) -> Vec<serde_json::Value> {
    let ids = (model == fi::MODEL).then_some(fi::IDS.to_vec());
    let options = ModelOptions {ids:ids.as_ref().map(|v| v.iter().copied().collect()),..Default::default()};
    let bytes = std::fs::read(root.join(model)).unwrap();
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(&bytes,None);
    let mut rows = Vec::new();
    ifc_lite_retained_native::run_model_native(ifc_lite_core::SourceBundle::new(bytes.clone()),worker,&options,|outcome| match outcome {
        ProductOutcome::Published(product) => {
            let source = normals::surfaces(&bytes,&sources,product.product_id).unwrap();
            rows.push(published_row(&product,&source));
        }
        ProductOutcome::Refused {product_id,refusal,..} =>
            rows.push(json!({"id":product_id,"status":"refused","code":refusal.code()})),
    }).unwrap();
    rows
}

/// The SDK enumerates Boolean results in heap-address order. The adapter's
/// canonical mesh form must make the reference byte-identical whatever the
/// worker's address layout: run every model with a published product under two
/// ordinary (ASLR) workers and, where the kernel allows it, one with ASLR off,
/// and compare bytes.
///
/// The canonical form does not cover every case: a planar face of more than
/// two triangles, a curved face other than a cylinder, and a cylinder pair the
/// diagonal normalization skips (its alignment or chord guard) keep the SDK's
/// triangulation, and coordinate order follows exact f64 bits. The committed
/// corpus has none of those that vary (6 ordinary runs, 1 ASLR-off run and two
/// CI runs collapsed to one form on 2026-11-19). If this test ever flakes, the
/// failing rows name such a face: extend mesh_canonical.cpp to cover it, or
/// make the consumer compare it order-insensitively. Never retry until green.
#[test]
fn m11_n_reference_is_independent_of_worker_address_layout() {
    let Some(worker) = support::worker_path() else {return;};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut workers = vec![worker.clone(),worker.clone()];
    let directory = std::env::temp_dir().join(format!("m11-n-layout-{}",std::process::id()));
    // Probe the personality flag itself: setarch can exist while a sandbox
    // (e.g. Docker's default seccomp profile) refuses ADDR_NO_RANDOMIZE.
    let aslr_off = std::process::Command::new("setarch")
        .args([std::env::consts::ARCH,"-R","true"]).output().is_ok_and(|o| o.status.success());
    if aslr_off {
        std::fs::create_dir_all(&directory).unwrap();
        let fixed = directory.join("worker-no-aslr");
        let worker_path = std::fs::canonicalize(&worker).unwrap();
        std::fs::write(&fixed,format!("#!/bin/sh\nexec setarch \"$(uname -m)\" -R '{}' \"$@\"\n",worker_path.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fixed,std::fs::Permissions::from_mode(0o755)).unwrap();
        workers.push(fixed.into_os_string());
    } else {
        eprintln!("SKIP the ASLR-off worker: `setarch -R true` failed (no setarch, or the personality flag is refused); comparing 2 ordinary ASLR workers only");
    }
    let mut models = 0;
    let mut differing = Vec::new();
    for (model, expected) in universe(&root) {
        if !expected.values().any(|status| status == "published") {continue;}
        models += 1;
        let runs: Vec<Vec<u8>> = workers.iter().map(|w| serde_json::to_vec(&reference_rows(&root,&model,w)).unwrap()).collect();
        if runs.iter().any(|run| run != &runs[0]) {
            let ids: Vec<_> = runs.iter().map(|run| serde_json::from_slice::<Vec<serde_json::Value>>(run).unwrap()).collect();
            let rows = ids[0].iter().enumerate().filter(|(i,row)| ids.iter().any(|other| other.get(*i) != Some(row)))
                .map(|(_,row)| row["id"].clone()).collect::<Vec<_>>();
            differing.push(format!("{model}: rows {rows:?}"));
        }
    }
    let _ = std::fs::remove_dir_all(&directory);
    assert!(models >= 30,"must cover the committed published corpus, got {models} models");
    assert!(differing.is_empty(),"m11-n reference bytes depend on the worker address layout:\n{}",differing.join("\n"));
    println!("M11-N layout determinism: {models} models byte-identical across 2 ASLR workers{}",
        if aslr_off {" and 1 ASLR-off worker"} else {" (ASLR-off worker skipped)"});
    println!("sdk witness executed: m11_n_worker_layout_determinism");
}

#[test]
fn m11_n_7955_committed_corpus_source_normals() {
    let Some(worker) = support::worker_path() else {return;};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let tolerances: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m11-n.json")).unwrap();
    let mut references = Vec::new();
    let mut published = 0;
    let mut refused = 0;
    let mut arc_corners = 0;
    let mut planar_fallbacks = 0;
    let mut violations = Vec::new();
    let mut coverage_errors = Vec::new();
    for (model, expected) in universe(&root) {
        let ids = (model == fi::MODEL).then_some(fi::IDS.to_vec());
        let options = ModelOptions {ids:ids.as_ref().map(|v| v.iter().copied().collect()),..Default::default()};
        let bytes = std::fs::read(root.join(&model)).unwrap();
        let sources = ifc_lite_processing::extract_analytic_quantity_sources(&bytes,None);
        let exact = ifc_lite_processing::process_geometry(&bytes);
        let mut rows = Vec::new();
        let mut actual = BTreeMap::new();
        ifc_lite_retained_native::run_model_native(ifc_lite_core::SourceBundle::new(bytes.clone()),&worker,
            &options, |outcome| {
                match outcome {
                    ProductOutcome::Published(product) => {
                        actual.insert(product.product_id,"published".to_string());
                        published += 1;
                        planar_fallbacks += product.normal_planar_fallbacks;
                        assert!(!product.obligations.0.contains(&Requirement::SurfaceNormals));
                        let source = normals::surfaces(&bytes,&sources,product.product_id).unwrap_or_else(|e| panic!("{model}:{}: {e}",product.product_id));
                        let check = normals::check(&product,&source).unwrap();
                        let histogram = exact_report::histogram(&exact,product.product_id,&source);
                        if check.unattributed != 0 || check.planar_radians > tolerances["normalPlanarRadians"].as_f64().unwrap()
                            || check.curved_radians > tolerances["normalCurvedRadians"].as_f64().unwrap()
                            || check.unit_error > tolerances["normalUnitAbsolute"].as_f64().unwrap() {
                            violations.push(format!("{model}:{} {check:?}",product.product_id));
                            println!("normal gate source surfaces {model}:{} {source:?}",product.product_id);
                        }
                        if model.ends_with("f-a-curved.ifc") && check.curved > 0 {
                            sides::check(&product,&source,tolerances["normalCurvedRadians"].as_f64().unwrap());
                            arc_corners += check.curved;
                        }
                        if model == fi::MODEL {
                            if let Err(error) = fi::check(&product,tolerances["normalPlanarRadians"].as_f64().unwrap(),
                                tolerances["normalCurvedRadians"].as_f64().unwrap()) {
                                violations.push(format!("{model}:{} {error}",product.product_id));
                            }
                        }
                        rows.push(published_row(&product,&source));
                        println!("normal source witness {model}:{} {check:?}; exact/source angle histogram (report-only): {histogram:?}",product.product_id);
                    }
                    ProductOutcome::Refused {product_id,refusal,..} => {
                        refused += 1;
                        if model == fi::MODEL {
                            println!("f-i refusal #{product_id}: {refusal:?}");
                            assert_eq!(product_id,507,"only the upstream bend may refuse");
                            assert_eq!(refusal.code(),"operation_unsupported");
                            println!("sdk witness executed: m11_n_fi_bend_upstream_refusal");
                        }
                        actual.insert(product_id,format!("refused:{}",refusal.code()));
                        rows.push(json!({"id":product_id,"status":"refused","code":refusal.code()}));
                    }
                }
            }).unwrap();
        if actual != expected {
            coverage_errors.push(format!("{model}: actual {actual:?}; expected {expected:?}"));
        }
        references.push(json!({"model":model,"source":String::from_utf8(bytes).unwrap(),"rows":rows,"ids":ids}));
    }
    assert!(published >= 131,"must execute the full committed universe");
    assert!(arc_corners > 0,"f-a-curved radial source oracle must execute");
    if let Ok(path) = std::env::var("IFCLITE_M11_N_REFERENCE") {
        std::fs::write(path,serde_json::to_vec(&references).unwrap()).unwrap();
    }
    println!("M11-N outcomes: {published} published, {refused} refused, {} models; normalPlanarFallbacks={planar_fallbacks}",references.len());
    assert!(violations.is_empty() && coverage_errors.is_empty(),
        "{} normal gate violations:\n{}\n{} coverage violations:\n{}",
        violations.len(),violations.join("\n"),coverage_errors.len(),coverage_errors.join("\n"));
    println!("sdk witness executed: m11_n_corpus_normals");
}
