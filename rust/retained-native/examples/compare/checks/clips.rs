// SPDX-License-Identifier: MPL-2.0
//! M5: source plane constraints and section integrals, independent of cutters.
use super::{OracleResult, ShapeOnlyProduct, SourceAuthority, SourceContext};
use crate::metrics::{Metrics, relative, transform};
use ifc_lite_retained_native::oracle::{clips, openings::volume_bounds_relative};
use serde_json::Value;
fn result(family: &'static str, value: f64, limit: f64) -> OracleResult {
    OracleResult {family,value,limit,pass:value.is_finite()&&limit.is_finite()&&value<=limit,gated:true,authority:None}
}
fn tolerance(t: &Value, family: &str, key: &str) -> f64 {
    t[family][key].as_f64().unwrap_or_else(||panic!("missing preregistered {family}.{key}"))
}
pub(super) fn check(product: &ShapeOnlyProduct, context: &SourceContext<'_>, t: &Value) -> Vec<OracleResult> {
    let expectation = match clips::expected(context.model,context.analytic,context.product_id) {
        Ok(Some(e))=>e, Ok(None)=>return Vec::new(),
        Err(_)=>return vec![result("clipSourceReadable",f64::INFINITY,0.)],
    };
    if expectation.parts.len()!=product.parts.len() { return vec![result("clipPartCoverage",f64::INFINITY,0.)]; }
    let mut measured = Metrics::default(); let mut excess=0f64;
    for (part,expected) in product.parts.iter().zip(&expectation.parts) {
        let points:Vec<_>=part.positions.chunks_exact(3).map(|p|transform(&part.world_from_object,[p[0],p[1],p[2]])).collect();
        for p in &points { for plane in &expected.planes { excess=excess.max(plane.excess(*p)); } }
        if measured.add_mesh(&points,&part.indices).is_err() {return vec![result("clipFiniteMesh",f64::INFINITY,0.)];}
    }
    let extent=(0..3).map(|i|measured.bbox[i+3]-measured.bbox[i]).fold(0.,f64::max);
    let key=if expectation.curved(){"curved"}else{"linear"};
    let mut results=vec![result("clipKeptSideMetres",excess,tolerance(t,"clipKeptSideMetres","absolute")
        +extent*tolerance(t,"clipKeptSideMetres","extentFactor")),result("clipClosure",measured.defects as f64,0.)];
    let bounds=expectation.host_volume().map(|v|volume_bounds_relative(measured.volume,[0.,v])).unwrap_or(f64::INFINITY);
    results.push(result("clipVolumeBoundsRelative",bounds,tolerance(t,"clipVolumeBoundsRelative",key)));
    if let Some(volume)=expectation.section_volume() {
        let mut r=result("clipSectionVolumeRelative",relative(measured.volume,volume),tolerance(t,"clipSectionVolumeRelative",key));
        r.authority=Some(SourceAuthority{volume,bbox:None,curved:expectation.curved()});results.push(r);
    } else if expectation.parts.iter().any(|p|!p.mixed) {
        results.push(result("clipSectionAvailable",f64::INFINITY,0.));
    }
    results
}
