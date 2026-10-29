// SPDX-License-Identifier: MPL-2.0
//! M10 signed volume and source-derived mapped centroids, never abs-only evidence.
use ifc_lite_retained_native::{oracle::affine, ShapeOnlyProduct};
use serde_json::{json,Value};
use super::report::Report;

pub fn record(report:&mut Report, oracle:&mut affine::AffineOracle<'_>, product:&ShapeOnlyProduct, tolerances:&Value) {
    if !oracle.is_affine_final(product.product_id) {return}
    let mut results=Vec::new();
    for (index,part) in product.parts.iter().enumerate() {
        let signed=affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).map(|v|v.0);
        let pass=signed.is_some_and(|v|v>0.);
        if !pass {report.violations.push(format!("{} part {index}: affine signed-volume invariant",product.product_id));}
        results.push(json!({"family":"affineSignedVolume","part":index,"pass":pass,"gated":true}));
    }
    // Opening Booleans still require outward winding for every resulting part.
    if product.cuts!=0 {append(report,results);return}
    // Winding is mandatory even when the analytic source family is unsupported.
    let Some(expected)=oracle.expected(product.product_id) else {append(report,results);return};
    if expected.len()!=product.parts.len() {
        report.violations.push(format!("{}: affine source part count",product.product_id));
        append(report,results);return;
    }
    for (index,(part,e)) in product.parts.iter().zip(expected).enumerate() {
        let Some((volume,centroid))=affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object) else {continue};
        let kind=if e.radius==0. {"linear"} else {"curved"};
        let volume_error=(volume-e.volume).abs()/e.volume;
        let volume_limit=tolerances["affineFinalVolumeRelative"][kind].as_f64().unwrap_or(f64::NAN);
        let mut pass=volume_error<=volume_limit && e.admitted();
        let centroid_error=centroid.iter().zip(e.centroid).map(|(a,b)|(a-b).abs()).fold(0.,f64::max);
        let t=&tolerances["affineFinalCentroidMetres"][kind];
        let centroid_limit=t["absolute"].as_f64().unwrap_or(0.)+e.extent*t["extentFactor"].as_f64().unwrap_or(f64::NAN);
        pass &= centroid_error<=centroid_limit;
        if let Some(b)=e.bbox {
            let extent=(0..3).map(|i|b[i+3]-b[i]).fold(0.,f64::max);
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
    append(report,results);
}
fn append(report:&mut Report,results:Vec<Value>) {
    // Extend the registry's existing per-product JSON column, without another TSV schema.
    if let Some(row)=report.rows.last_mut() {
        if let Some(at)=row.rfind('\t') {
            if let Ok(mut existing)=serde_json::from_str::<Vec<Value>>(&row[at+1..]) {
                existing.extend(results);row.truncate(at+1);row.push_str(&serde_json::to_string(&existing).expect("finite oracle JSON"));
            }
        }
    }
}

/// Check the source chord/surface-class prediction only at its refusal stage:
/// earlier typed refusals (layers, unsupported items) keep their precedence, and
/// a predicted refusal must never surface as a kernel failure.
pub fn refusal(report:&mut Report,oracle:&mut affine::AffineOracle<'_>,id:u32,code:&str) {
    let Some(expected)=oracle.expected(id).filter(|e|e.iter().any(|p|p.affine_final)) else {return};
    let admitted=expected.iter().all(|e|e.admitted());
    let pass=match code {"incomplete"=>!admitted,"kernel_failure"=>admitted,_=>true};
    if !pass {report.violations.push(format!("{id}: {code} affine final contradicts source chord/surface prediction"));}
    let results=expected.iter().enumerate().map(|(part,e)|json!({"family":"affineChord","part":part,
        "affine_kappa":e.kappa,"sourceAdmitted":admitted,"surfaceCertified":e.surface_certified,"pass":pass,
        "gated":matches!(code,"incomplete"|"kernel_failure")})).collect();
    // Refusal rows have an empty oracle column until this family contributes.
    if let Some(row)=report.rows.last_mut() {row.push_str("[]");}
    append(report,results);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ifc_lite_retained_native::{ModelOptions,ProductOutcome};
    // #7955: an unsupported analytic family must still gate EVERY part's winding.
    #[test]
    fn affine_boolean_without_source_volume_still_gates_signed_volume() {
        let text=include_str!("../../../../tests/fixtures/synthetic-retained/f-h-affine-finals.ifc")
            .replace("#24=IFCEXTRUDEDAREASOLID(#23,#2,#3,2.);",
                "#900001=IFCEXTRUDEDAREASOLID(#23,#2,#3,2.);\n#24=IFCBOOLEANRESULT(.UNION.,#900001,#900001);")
            .replace("#25=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid'", "#25=IFCSHAPEREPRESENTATION(#4,'Body','CSG'");
        let source=ifc_lite_core::SourceBundle::new(text.into_bytes());
        let mut oracle=affine::AffineOracle::new(&source);
        assert!(oracle.is_affine_final(42));
        assert!(oracle.expected(42).is_none());
        assert_winding_gate(&source,42,false);
    }
    // #7955: opening cuts must not bypass the per-part winding gate (#130/#133/#145/#146).
    #[test]
    fn voided_affine_product_still_gates_every_part_signed_volume() {
        let source=ifc_lite_core::SourceBundle::new(include_bytes!(
            "../../../../tests/fixtures/synthetic-retained/f-h-affine-finals.ifc").to_vec());
        assert_winding_gate(&source,242,true);
    }
    fn assert_winding_gate(source:&std::sync::Arc<ifc_lite_core::SourceBundle>,id:u32,with_cuts:bool) {
        let mut oracle=affine::AffineOracle::new(source);
        assert!(oracle.is_affine_final(id));
        let Some(worker)=std::env::var_os("IFCLITE_SMLIB_WORKER") else {
            assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(),"real SDK required");
            eprintln!("SKIP M10 affine winding reporter: real SDK missing");return;
        };
        let mut shapes=Vec::new();
        ifc_lite_retained_native::run_model_native(source.clone(),worker,
            &ModelOptions {ids:Some([id].into_iter().collect()),..Default::default()},|o|shapes.push(o)).unwrap();
        let ProductOutcome::Published(mut shape)=shapes.remove(0) else {panic!("expected mirrored Boolean publication")};
        assert_eq!(shape.cuts>0,with_cuts);
        let mut report=Report {rows:vec!["test\t[]".into()],..Default::default()};
        record(&mut report,&mut oracle,&shape,&Value::Null);
        assert!(report.violations.is_empty());
        let results:Vec<Value>=serde_json::from_str(report.rows[0].split('\t').next_back().unwrap()).unwrap();
        assert_eq!(results.len(),shape.parts.len());
        assert!(results.iter().all(|r|r["family"]=="affineSignedVolume"&&r["gated"]==true&&r["pass"]==true));
        for t in shape.parts[0].indices.chunks_exact_mut(3) {t.swap(1,2);}
        record(&mut report,&mut oracle,&shape,&Value::Null);
        assert!(report.violations.iter().any(|v|v.contains("signed-volume invariant")));
    }
}
