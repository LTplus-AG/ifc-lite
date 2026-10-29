// SPDX-License-Identifier: MPL-2.0
//! Source gates never consume the retained cutter recipe.
use ifc_lite_retained_native::oracle::bounded::Expectation;
use super::OracleResult;
pub(super) fn check(product:&super::ShapeOnlyProduct,e:Option<&Expectation>,t:&serde_json::Value)->Vec<OracleResult> {
    let Some(e)=e else{return Vec::new();};
    let mut m=crate::metrics::Metrics::default();let mut outside=0f64;
    for part in &product.parts {
        let points=part.positions.chunks_exact(3).map(|p|crate::metrics::transform(&part.world_from_object,[p[0],p[1],p[2]])).collect::<Vec<_>>();
        for &p in &points {outside=outside.max(e.removed_clearance(p));}
        if m.add_mesh(&points,&part.indices).is_err(){return vec![row("bounded_measurement",f64::INFINITY,0.)];}
    }
    let key=if e.curved{"curved"}else{"linear"};
    let extent=(0..3).map(|i|m.bbox[i+3]-m.bbox[i]).fold(0.,f64::max);
    let mut rows=vec![
        row("bounded_outside_material",outside,t["boundedOutsideMaterialMetres"]["absolute"].as_f64().unwrap()+extent*t["boundedOutsideMaterialMetres"]["extentFactor"].as_f64().unwrap()),
        row("bounded_volume_bounds",(-m.volume).max(m.volume-e.host_volume).max(0.)/e.host_volume,t["boundedVolumeBoundsRelative"][key].as_f64().unwrap()),
        row("bounded_closure",m.defects as f64,0.),
    ];
    if let Some(volume)=e.section_volume {rows.push(row("bounded_section_volume",crate::metrics::relative(m.volume,volume),t["boundedSectionVolumeRelative"][key].as_f64().unwrap()));}
    rows
}
fn row(family:&'static str,value:f64,limit:f64)->OracleResult {OracleResult{family,value,limit,pass:value.is_finite()&&value<=limit,gated:true,..Default::default()}}
