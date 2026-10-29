// SPDX-License-Identifier: MPL-2.0
//! M10 signed volume and source-derived mapped centroids, never abs-only evidence.
use ifc_lite_retained_native::{oracle::affine, ShapeOnlyProduct};
use serde_json::{json,Value};
use super::super::report::Report;

pub fn record(report:&mut Report, bytes:&[u8], product:&ShapeOnlyProduct, tolerances:&Value) {
    let mut results=Vec::new();
    for (index,part) in product.parts.iter().enumerate() {
        let signed=affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).map(|v|v.0);
        let pass=signed.is_some_and(|v|v>0.);
        if !pass {report.violations.push(format!("{} part {index}: affine signed-volume invariant",product.product_id));}
        results.push(json!({"family":"affineSignedVolume","part":index,"pass":pass,"gated":true}));
    }
    if product.cuts==0 {
        if let Some(expected)=affine::expected(bytes,product.product_id).filter(|e|e.len()==product.parts.len()) {
            for (index,(part,e)) in product.parts.iter().zip(expected).enumerate() {
                let Some((volume,centroid))=affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object) else {continue};
                let kind=if e.radius==0. {"linear"} else {"curved"};
                let volume_error=(volume-e.volume).abs()/e.volume;
                let volume_limit=tolerances["affineFinalVolumeRelative"][kind].as_f64().unwrap_or(f64::NAN);
                let mut pass=volume_error<=volume_limit;
                let mut centroid_error=0f64;
                let mut centroid_limit=None;
                if let Some(b)=e.bbox {
                    let extent=(0..3).map(|i|b[i+3]-b[i]).fold(0.,f64::max);
                    let tolerance=&tolerances["affineFinalCentroidMetres"]["linear"];
                    let limit=tolerance["absolute"].as_f64().unwrap_or(f64::NAN)+extent*tolerance["extentFactor"].as_f64().unwrap_or(f64::NAN);
                    centroid_error=centroid.iter().zip(e.centroid).map(|(a,b)|(a-b).abs()).fold(0.,f64::max);
                    centroid_limit=Some(limit);pass &= centroid_error<=limit;
                    let mut actual=[f64::INFINITY,f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY];
                    for p in part.positions.chunks_exact(3) {let m=part.world_from_object;for i in 0..3 {
                        let v=m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12];actual[i]=actual[i].min(v);actual[i+3]=actual[i+3].max(v);
                    }}
                    let bbox_error=actual.iter().zip(b).map(|(a,b)|(a-b).abs()).fold(0.,f64::max);
                    let t=&tolerances["affineFinalBboxMetres"];
                    pass &= bbox_error<=t["absolute"].as_f64().unwrap_or(f64::NAN)+extent*t["extentFactor"].as_f64().unwrap_or(f64::NAN);
                }
                if !pass {report.violations.push(format!("{} part {index}: affine source oracle",product.product_id));}
                results.push(json!({"family":"affineFinal","part":index,"volumeRelative":volume_error,"limit":volume_limit,
                    "centroidMetres":centroid_error,"centroidLimit":centroid_limit,"affine_kappa":e.kappa,"pass":pass,"gated":true}));
            }
        }
    }
    // Extend the registry's existing per-product JSON column, without another TSV schema.
    if let Some(row)=report.rows.last_mut() {
        if let Some(at)=row.rfind('\t') {
            if let Ok(mut existing)=serde_json::from_str::<Vec<Value>>(&row[at+1..]) {
                existing.extend(results);row.truncate(at+1);row.push_str(&serde_json::to_string(&existing).expect("finite oracle JSON"));
            }
        }
    }
}
