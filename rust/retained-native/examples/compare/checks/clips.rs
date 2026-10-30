// SPDX-License-Identifier: MPL-2.0
//! M5: source plane constraints and section integrals, independent of cutters.
use super::{ClipPartEvidence, OracleResult, ShapeOnlyProduct, SourceAuthority, SourceContext};
use crate::metrics::{Metrics, relative, transform};
use ifc_lite_retained_native::oracle::openings::volume_bounds_relative;
use serde_json::Value;
fn result(family: &'static str, value: f64, limit: f64) -> OracleResult {
    OracleResult {family,value,limit,pass:value.is_finite()&&limit.is_finite()&&value<=limit,gated:true,authority:None,clip_part:None}
}
fn tolerance(t: &Value, family: &str, key: &str) -> f64 {
    t[family][key].as_f64().unwrap_or_else(||panic!("missing preregistered {family}.{key}"))
}
fn unavailable(family: &'static str) -> OracleResult {
    let mut r=result(family,f64::INFINITY,0.);r.gated=false;r
}
pub(super) fn check(product: &ShapeOnlyProduct, context: &SourceContext<'_>, t: &Value) -> Vec<OracleResult> {
    let expectation = match context.clips.expected(context.product_id) {
        Ok(Some(e))=>e, Ok(None)=>return Vec::new(),
        Err(_)=>return vec![result("clipSourceReadable",f64::INFINITY,0.)],
    };
    let layered = product.parts.iter().any(|p| p.layer.is_some());
    let groups: Vec<Vec<_>> = if layered { vec![product.parts.iter().collect()] }
        else { product.parts.iter().map(|p| vec![p]).collect() };
    if expectation.parts.len()!=groups.len() { return vec![result("clipPartCoverage",f64::INFINITY,0.)]; }
    let mut results=Vec::new();
    for (index,(parts,expected)) in groups.iter().zip(&expectation.parts).enumerate() {
        let executed = parts.iter().all(|p| p.halfspace_clipped);
        let mut marker=result("clipPart",0.,0.);marker.gated=false;
        marker.clip_part=Some(ClipPartEvidence {index,curved:expected.curved,executed});
        results.push(marker);
        if expected.planes.is_empty() { continue; }
        let mut measured=if layered { Metrics::assembly() } else { Metrics::default() };
        let mut excess=0f64;
        for part in parts {
            let points:Vec<_>=part.positions.chunks_exact(3).map(|p|transform(&part.world_from_object,[p[0],p[1],p[2]])).collect();
            for p in &points { for plane in &expected.planes { excess=excess.max(plane.excess(*p)); } }
            if measured.add_mesh(&points,&part.indices).is_err() {return vec![result("clipFiniteMesh",f64::INFINITY,0.)];}
        }
        let extent=(0..3).map(|i|measured.bbox[i+3]-measured.bbox[i]).fold(0.,f64::max);
        let key=if expected.curved && executed {"curved"}else{"linear"};
        results.push(result("clipKeptSideMetres",excess,tolerance(t,"clipKeptSideMetres","absolute")
            +extent*tolerance(t,"clipKeptSideMetres","extentFactor")));
        results.push(result("clipClosure",measured.defects as f64,0.));
        if let Some(volume)=expected.host_volume {
            results.push(result("clipVolumeBoundsRelative",volume_bounds_relative(measured.volume,[0.,volume]),tolerance(t,"clipVolumeBoundsRelative",key)));
        } else {
            results.push(unavailable("clipVolumeBoundsUnavailable"));
        }
        // A skipped clip has no clip triangulation error; its nominal curved
        // tessellation is checked by the ordinary source oracle, not M5's gate.
        if !executed {
            results.push(unavailable("clipSectionNotExecuted"));
        } else if let Some(volume)=expected.section_volume {
            results.push(result("clipSectionVolumeRelative",relative(measured.volume,volume),tolerance(t,"clipSectionVolumeRelative",key)));
        } else if expected.mixed {
            results.push(unavailable("clipSectionMixedSubtree"));
        } else {
            results.push(result("clipSectionAvailable",f64::INFINITY,0.));
        }
    }
    if let Some(volume)=expectation.section_volume() {
        let mut authority=result("clipSourceVolume",0.,0.);authority.gated=false;
        authority.authority=Some(SourceAuthority {volume,bbox:None,curved:expectation.parts.iter().any(|p|p.curved)});
        results.push(authority);
    }
    results
}
