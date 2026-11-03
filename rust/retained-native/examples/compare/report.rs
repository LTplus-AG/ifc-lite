// SPDX-License-Identifier: MPL-2.0
use super::metrics::{bbox_deviation, relative, Metrics};
use ifc_lite_retained_native::ShapeOnlyProduct;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Report {
    pub layers: super::layer_report::LayerReport,
    pub candidates: usize,
    pub published: usize,
    pub normal_planar_fallbacks: usize,
    pub type_candidates: usize,
    pub type_published: usize,
    pub histogram: BTreeMap<String, usize>,
    pub violations: Vec<String>,
    pub exact_defects: Vec<Value>,
    pub exact_waivers: Vec<Value>,
    pub universe_mismatch: Vec<String>,
    pub skipped: Vec<String>,
    pub maxima: [f64; 4],
    pub cuts: u64,
    pub layered_products: usize,
    pub bands: usize,
    pub band_ms: f64,
    pub cap_ms: f64,
    pub cut_times_ms: Vec<f64>,
    pub oracle_maxima: BTreeMap<String, f64>,
    pub exact_ms: f64,
    pub exact_unrounded_ms: f64,
    pub retained_ms: f64,
    pub startup_ms: f64,
    pub product_ms: f64,
    pub rows: Vec<String>,
    pub coverage: Vec<String>,
    pub models: Vec<Value>,
    pub exact_only_type_products: Vec<Value>,
    /// M11-F report-only projection rows (`checks::faces::exact_projection`).
    pub face_projection: Vec<Value>,
    /// #7955 F3: products whose source authors only open face sets, with the closed-solid
    /// measurements (closure, exact volume/area) that were reported instead of gated.
    pub authored_open: Vec<Value>,
    /// #7955 ruling 3: missing face keys allowed as kernel-merged collinear sides.
    pub face_merges: Vec<Value>,
    /// #7955: published products an independent oracle could not check. A gated row
    /// stays in `violations` too; this only counts them by family and reason.
    pub unverified: Vec<Value>,
    /// This model's voided hosts without a complete source cut expectation, and why.
    pub opening_gaps: BTreeMap<u32, String>,
    /// #7955: closed-solid checks that failed on face sets whose source rows are themselves open.
    pub closure_on_open_source: Vec<Value>,
    pub area_authorities: super::exact_area::ExactAreaAuthorities,
    /// How the product being measured counts as open, for its `authoredOpenFaceSets` row.
    pub open_classification: Option<String>,
    /// Ruling 13: closure defects the product's authored zero-area rows explain, one by one.
    pub zero_area_closure_edges: Option<f64>,
    /// Which ruling (13 or 20) names the closure defects of the product being measured.
    pub closure_classification: Option<&'static str>,
    /// #7955 rulings 13 and 20: the named closure outcomes, by product.
    pub zero_area_row_closure: Vec<Value>,
    /// The source's area for the product being measured, when an authority has one.
    pub source_area: Option<f64>,
}
#[path = "unverified.rs"]
mod unverified;
use unverified::{face_set_closure_summary, says_unverified, unverified_summary};
impl Report {
    // One comparison row combines both independently measured sides and source expectations.
    #[allow(clippy::too_many_arguments)]
    pub fn published(
        &mut self,
        model: &str,
        shape: &ShapeOnlyProduct,
        actual: &Metrics,
        compared: Option<&Metrics>,
        exact: Option<&Metrics>,
        source: Option<(f64, Option<[f64; 6]>)>,
        tolerances: &Value,
        ms: f64,
        opening: Option<&Option<ifc_lite_retained_native::oracle::openings::OpeningExpectation>>,
        sources: &super::checks::SourceContext<'_>,
        exact_report_only: bool,
        bounded: Option<&ifc_lite_retained_native::oracle::bounded::Expectation>,
    ) {
        self.published += 1;
        let bands=shape.parts.iter().filter(|p|p.layer.is_some()).count();
        self.layered_products+=usize::from(bands>0); self.bands+=bands;
        self.band_ms+=shape.band_ms; self.cap_ms+=shape.cap_ms;
        self.normal_planar_fallbacks += shape.normal_planar_fallbacks;
        self.cuts += shape.cuts;
        self.cut_times_ms.extend_from_slice(&shape.cut_times_ms);
        let type_product = shape.ifc_type.is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct);
        self.type_published += usize::from(type_product);
        let curved = shape.parts.iter().any(|p| p.curved);
        let results = super::checks::check(shape, sources, tolerances, bounded);
        let authorities: Vec<_> = results.iter().filter_map(|r| r.authority).collect();
        let authority = authorities.first();
        if authorities.iter().any(|a| authority.is_some_and(|first|
            a.volume != first.volume || a.bbox != first.bbox || a.curved != first.curved)) {
            self.violations.push(format!("{model}:{}: conflicting source authorities", shape.product_id));
        }
        let open_marker = results.iter().find(|r| r.family == super::checks::face_sets::AUTHORED_OPEN);
        let open = open_marker.is_some();
        self.open_classification = open_marker.and_then(|r| r.reason.clone());
        let named_closure = results.iter().find(|r| matches!(r.family, super::checks::face_sets::ZERO_AREA_ROW_EDGES | super::checks::face_sets::DROPPED_TRIANGLE_EDGES));
        self.zero_area_closure_edges = named_closure.map(|r| r.value);
        self.closure_classification = named_closure.map(|r| if r.family == super::checks::face_sets::ZERO_AREA_ROW_EDGES { "zero_area_row_closure" } else { "dropped_triangle_closure" });
        // Analytic faces of an uncut, unbanded product, or a preregistered hand area.
        self.source_area = self.area_authorities.get(model, shape.product_id).or_else(|| (shape.cuts == 0 && bands == 0)
            .then(|| ifc_lite_retained_native::oracle::faces::uncut(sources.analytic, shape.product_id)).flatten()
            .map(|faces| faces.values().map(|face| face.area_m2).sum()));
        let [source_rel, vol, area, bbox, source_bbox] = self.check_measurements(
            open,
            &format!("{model}:{}", shape.product_id),
            authority.map_or(curved || opening.is_some() || bounded.is_some(), |a| a.curved),
            type_product,
            actual,
            compared,
            exact,
            authority.map(|a| (a.volume, a.bbox)).or(if opening.is_some() { None } else { source }),
            tolerances,
            exact_report_only,
        );
        let cut_rel = opening.filter(|_| bounded.is_none()).and_then(|e| {
            if let Some(authority) = authority { return Some(relative(actual.volume, authority.volume)); }
            super::openings::check_opened(
                &format!("{model}:{}", shape.product_id),
                actual,
                e.as_ref(),
                tolerances,
                &mut self.violations,
            )
        });
        let product_label = format!("{model}:{}", shape.product_id);
        // A voided host checked by neither a section authority nor the bounded oracle.
        if bounded.is_none() && authority.is_none() {
            match opening {
                Some(None) | Some(Some(ifc_lite_retained_native::oracle::openings::OpeningExpectation { result_volume: None, .. })) => {
                    let family = if matches!(opening, Some(None)) { "openingSourceExpectation" } else { "openingResultVolume" };
                    let reason = self.opening_gaps.get(&shape.product_id).cloned();
                    self.unverified.push(json!({"product": product_label, "family": family, "gated": family == "openingSourceExpectation", "reason": reason}));
                }
                _ => {}
            }
        }
        for result in results.iter().filter(|r| says_unverified(r.family, &results)) {
            self.unverified.push(json!({"product": product_label, "family": result.family, "gated": result.gated, "reason": result.reason}));
        }
        if actual.defects > 0 && !open && !results.iter().any(|r| matches!(r.family, super::checks::face_sets::ZERO_AREA_ROW_EDGES | super::checks::face_sets::DROPPED_TRIANGLE_EDGES) && r.value == actual.defects as f64) {
            if let Some(edges) = results.iter().find(|r| r.family == super::checks::face_sets::SOURCE_OPEN_EDGES) {
                self.closure_on_open_source.push(json!({"product": product_label, "meshDefects": actual.defects, "sourceOpenEdges": edges.value, "closed": edges.reason}));
            }
        }
        let format = |v: Option<f64>| v.map(|v| v.to_string()).unwrap_or_default();
        self.rows.push(format!(
            "{model}\t{}\t{}\tpublished\t\t\t{curved}\t{}\t{}\t{}\t{}\t{}\t{ms}\t{}\t{:?}\tM1\t{}\t\t\t\t\t{}\t{}\t{}\t{}",
            shape.product_id,
            shape.ifc_type.name(),
            format(source_rel),
            format(vol),
            format(area),
            format(bbox),
            actual.defects == 0,
            actual.volume,
            shape.obligations.0,
            format(source_bbox),
            shape.cuts, shape.cut_times_ms.iter().sum::<f64>(), shape.consumed_parts,
            format(cut_rel)
        ));
        for result in results.iter().filter(|r| r.family == "faceKeysKernelMerged") {
            self.face_merges.push(json!({"product": format!("{model}:{}", shape.product_id), "keys": result.value, "merged": result.reason}));
        }
        for result in &results {
            let maximum = self.oracle_maxima.entry(result.family.into()).or_default();
            *maximum = maximum.max(if result.value.is_finite() { result.value } else { f64::INFINITY });
            if result.gated && (!result.pass || !result.value.is_finite() || !result.limit.is_finite()) {
                self.violations.push(format!("{model}:{}: {} source oracle failed", shape.product_id, result.family)+&result.reason.as_ref().map(|r|format!(": {r}")).unwrap_or_default());
            }
        }
        self.rows.last_mut().unwrap().push_str(&format!("\t{}", serde_json::to_string(&results.iter().map(|r| json!({"family":r.family,"reason":r.reason,"value":r.value,"limit":r.limit,"pass":r.pass,"gated":r.gated,"sourceCurved":r.clip_part.as_ref().map(|p|p.curved).or(r.authority.map(|a|a.curved)),"part":r.clip_part.as_ref().map(|p|p.index),"clipExecuted":r.clip_part.as_ref().map(|p|p.executed)})).collect::<Vec<_>>()).expect("oracle results serialize")));
        self.coverage
            .push(format!("{model}\t{}\tpublished\t", shape.product_id));
    }
    // Keep numerical gate decisions independent of publication ownership, so
    // hostile measurements can be exercised without fabricating a witness.
    //
    /// #7955 F3 (orchestrator ruling, 2026-11-01): a face set its source authors open is
    /// not a closed solid, so closure and the exact volume/area it implies do not apply.
    /// `open` comes only from the source's `Closed = FALSE` (`checks::face_sets`); each
    /// skipped value is listed in `authoredOpenFaceSets`, and row, corner, bbox, source
    /// and finite-measurement checks still gate.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn check_measurements(
        &mut self,
        open: bool,
        label: &str,
        curved: bool,
        type_product: bool,
        actual: &Metrics,
        compared: Option<&Metrics>,
        exact: Option<&Metrics>,
        source: Option<(f64, Option<[f64; 6]>)>,
        tolerances: &Value,
        exact_report_only: bool,
    ) -> [Option<f64>; 5] {
        let source_rel = source.as_ref().map(|(v, _)| relative(actual.volume, *v));
        let exact_source_rel = exact.zip(source).map(|(e, (v, _))| relative(e.volume, v));
        let vol = exact
            .zip(compared)
            .map(|(e, a)| relative(a.volume, e.volume));
        let area = exact.zip(compared).map(|(e, a)| relative(a.area, e.area));
        let bbox = exact
            .zip(compared)
            .map(|(e, a)| bbox_deviation(&a.bbox, &e.bbox));
        let source_bbox = source
            .as_ref()
            .and_then(|(_, b)| b.as_ref())
            .map(|b| bbox_deviation(&actual.bbox, b));
        // Finite positions can still overflow area/volume arithmetic. Reject
        // invalid measurements even when no source expectation is available.
        for (name, measured) in [
            ("retained", Some(actual)),
            ("compared retained", compared),
            ("exact", exact),
        ] {
            if measured.is_some_and(|m| {
                [m.volume, m.area]
                    .iter()
                    .chain(&m.bbox)
                    .any(|v| !v.is_finite())
            }) {
                self.violations
                    .push(format!("{label}: nonfinite {name} measurement"));
            }
        }
        // NaN fails every `> tolerance` comparison; exact curved metrics are
        // report-only for finite deviations, never for invalid arithmetic.
        for (name, value) in [
            ("source volume", source_rel),
            ("exact source volume", exact_source_rel),
            ("exact volume", vol.filter(|_| !open)),
            ("exact area", area.filter(|_| !open)),
            ("exact bbox", bbox),
            ("source bbox", source_bbox),
        ] {
            if value.is_some_and(|v| !v.is_finite()) {
                self.violations
                    .push(format!("{label}: nonfinite {name} deviation"));
            }
        }
        if open {
            let classification = self.open_classification.take().unwrap_or_else(|| "authored_open_face_set".into());
            self.authored_open.push(json!({"classification": classification, "product": label,
                "closureDefects": actual.defects, "exactVolumeRelative": vol.map(finite), "exactAreaRelative": area.map(finite)}));
        }
        let gated = |v: Option<f64>| v.filter(|_| !open);
        for (i, value) in [source_rel, gated(vol), gated(area), bbox].into_iter().enumerate() {
            if let Some(value) = value {
                self.maxima[i] = self.maxima[i].max(if value.is_finite() {
                    value
                } else {
                    f64::INFINITY
                });
            }
        }
        let zero_rows = self.zero_area_closure_edges.take();
        if actual.defects > 0 && !open {
            // The exact counts must meet: a defect of any other origin keeps this red.
            if zero_rows == Some(actual.defects as f64) {
                let classification = self.closure_classification.take().unwrap_or("zero_area_row_closure");
                self.zero_area_row_closure.push(json!({"classification": classification, "product": label, "edges": actual.defects}));
            } else {
                self.violations.push(format!("{label}: {} closure defects", actual.defects));
            }
        }
        if exact.is_none() {
            self.universe_mismatch
                .push(format!("{label}: retained published but exact has no mesh"));
        }
        if let Some(value) = source_rel {
            let key = if curved { "curved" } else { "linear" };
            if value
                > super::openings::tolerance(
                    tolerances,
                    if type_product { "typeProductSourceVolumeRelative" } else { "sourceVolumeRelative" },
                    key,
                )
            {
                self.violations
                    .push(format!("{label}: source volume deviation {value}"));
            }
        }
        if let Some((_, Some(bounds))) = source {
            let extent = (0..3).map(|i| bounds[i + 3] - bounds[i]).fold(0., f64::max);
            // A missing or renamed preregistered key panics, never reads as 0.
            let bbox_key = if type_product { "typeProductSourceWorldBboxMetres" } else { "sourceWorldBboxMetres" };
            let limit = super::openings::tolerance(tolerances, bbox_key, "absolute")
                + extent * super::openings::tolerance(tolerances, bbox_key, "extentFactor");
            let deviation = bbox_deviation(&actual.bbox, &bounds);
            if deviation > limit {
                self.violations
                    .push(format!("{label}: source bbox deviation {deviation}"));
            }
        }
        // #7955, CUT-0 Round 3 orchestrator ruling (2026-10-27): the
        // independent source oracle outranks an exact mesh that it disproves.
        // Source, closure and finite-arithmetic checks above remain mandatory.
        let source_limit = tolerances["sourceVolumeRelative"][if curved { "curved" } else { "linear" }]
            .as_f64().unwrap_or(0.);
        let exact_limit = tolerances["exactLinear"]["volumeRelative"].as_f64().unwrap_or(0.);
        let exact_defect = !curved && source_rel.zip(exact_source_rel).is_some_and(|(r, e)| {
            r.is_finite() && e.is_finite() && r <= source_limit && e > exact_limit
        });
        if exact_defect {
            self.exact_defects.push(json!({
                "classification": "exact_defect", "product": label,
                "sourceVolumeM3": source.map(|(v, _)| v),
                "retainedVolumeM3": actual.volume, "exactVolumeM3": exact.map(|e| e.volume),
                "retainedVsSourceVolumeRelative": source_rel,
                "exactVsSourceVolumeRelative": exact_source_rel,
                "retainedVsExact": {"volumeRelative": vol, "areaRelative": area, "bboxMetres": bbox},
                "sourceVolumeRelativeLimit": source_limit, "exactVolumeRelativeLimit": exact_limit,
            }));
        }
        // The waiver is audit-visible: which products skipped the exact gate and
        // by how much they deviated, so it cannot hide a regression.
        if exact_report_only && !curved && !type_product && !exact_defect {
            self.exact_waivers.push(json!({
                "classification": "exact_report_only", "product": label,
                "retainedVsExact": {"volumeRelative": vol, "areaRelative": area, "bboxMetres": bbox},
            }));
        }
        // The same precedence for area (#7955): retained equals the source's area within the
        // frozen face limit and exact does not within its own, so exact is the wrong side.
        let source_area = self.source_area.take();
        // Only a gated area can be named: a waived or authored-open product's never was.
        let exact_area_defect = !curved && !exact_defect && !exact_report_only && !open && !type_product && source_area.zip(exact).is_some_and(|(s, e)| {
            // A missing or renamed preregistered key panics, never reads as 0.
            relative(actual.area, s) <= super::openings::tolerance(tolerances, "faceAreaRelative", "linear")
                && relative(e.area, s) > super::openings::tolerance(tolerances, "exactLinear", "areaRelative")
        });
        if exact_area_defect {
            self.exact_defects.push(json!({
                "classification": "exact_defect", "kind": "area", "product": label,
                "sourceAreaM2": source_area, "retainedAreaM2": actual.area, "exactAreaM2": exact.map(|e| e.area),
                "retainedVsExact": {"volumeRelative": vol, "areaRelative": area, "bboxMetres": bbox},
            }));
        }
        if !curved && !type_product && !exact_defect && !exact_report_only {
            for (value, key) in [
                (gated(vol), "volumeRelative"),
                (gated(area).filter(|_| !exact_area_defect), "areaRelative"),
                (bbox, "bboxMetres"),
            ] {
                if value.is_some_and(|v| v > tolerances["exactLinear"][key].as_f64().unwrap_or(0.))
                {
                    self.violations
                        .push(format!("{label}: exact {key} deviation {value:?}"));
                }
            }
        }
        [source_rel, vol, area, bbox, source_bbox]
    }
    pub fn summary(&self) -> Value {
        json!({"schema":"ifc-lite.native-retained-comparison/1", "candidates":self.candidates,
            "typeProducts":{"candidates":self.type_candidates,"published":self.type_published},
            "published":self.published,"layeredProducts":self.layered_products,"bands":self.bands,"bandMs":self.band_ms,"capMs":self.cap_ms, "normalPlanarFallbacks":self.normal_planar_fallbacks, "coveragePercent":if self.candidates == 0 { 0. } else { 100.*self.published as f64/self.candidates as f64 },
            "byCode":self.histogram, "cuts":self.cuts, "cutTimesMs":self.cut_times_ms, "maximumDeviations":{"sourceVolumeRelative":finite(self.maxima[0]),
                "exactVolumeRelative":finite(self.maxima[1]),"exactAreaRelative":finite(self.maxima[2]),"bboxMetres":finite(self.maxima[3])},
            "sourceOracleMaxima":self.oracle_maxima.iter().map(|(k,v)| (k.clone(),finite(*v))).collect::<BTreeMap<_,_>>(),
            "layers":self.layers.summary(), "violations":self.violations,"exact_defect":self.exact_defects,"exact_report_only":self.exact_waivers,"universeMismatch":self.universe_mismatch,"skipped":self.skipped,
            "exact":{"milliseconds":self.exact_ms,"beforeF32RoundingMilliseconds":self.exact_unrounded_ms},"retained":{"milliseconds":self.retained_ms,"startupAndQualificationMilliseconds":self.startup_ms,"productMilliseconds":self.product_ms,"exactComparisonPrecision":super::precision::COMPARISON_PRECISION},"models":self.models, "faceExactItemProjection":super::checks::faces::projection_summary(&self.face_projection), "authoredOpenFaceSets":{"count":self.authored_open.len(),"gated":false,"unsetRowsOpen":self.authored_open.iter().filter(|r| r["classification"]=="unset_rows_open_face_set").count(),"products":self.authored_open},
            "zeroAreaRowClosure":closure_class(&self.zero_area_row_closure,"zero_area_row_closure"),
            "droppedTriangleClosure":closure_class(&self.zero_area_row_closure,"dropped_triangle_closure"),
            "unverified":unverified_summary(&self.unverified), "closureDefectsOnFaceSets":face_set_closure_summary(&self.closure_on_open_source),
            "faceKeysKernelMerged":{"gated":false,"keys":self.face_merges.iter().filter_map(|r| r["keys"].as_f64()).sum::<f64>(),"products":self.face_merges.len(),"rows":self.face_merges}, "exact_only_type_products":self.exact_only_type_products.len(), "exact_only_type_product_ids":self.exact_only_type_products})
    }
}
fn finite(v: f64) -> Value {
    if v.is_finite() {
        json!(v)
    } else {
        json!("infinite")
    }
}

pub fn rss(children: bool) -> Result<i64, std::io::Error> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // getrusage initializes the entire output on success. Linux ru_maxrss is KiB.
    let result = unsafe {
        libc::getrusage(
            if children {
                libc::RUSAGE_CHILDREN
            } else {
                libc::RUSAGE_SELF
            },
            usage.as_mut_ptr(),
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let usage = unsafe { usage.assume_init() };
    Ok(usage.ru_maxrss)
}

#[cfg(test)]
#[path = "report_tests.rs"]
mod tests;
/// One named closure outcome's rows, so its count is always its own products' length.
fn closure_class(rows: &[Value], classification: &str) -> Value {
    let products: Vec<&Value> = rows.iter().filter(|r| r["classification"] == classification).collect();
    json!({"count": products.len(), "gated": false, "products": products})
}
