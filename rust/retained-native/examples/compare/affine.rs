// SPDX-License-Identifier: MPL-2.0
//! M10 signed volume and source-derived mapped centroids, never abs-only evidence.
use ifc_lite_retained_native::{oracle::affine, ShapeOnlyProduct};
use serde_json::{json,Value};
use super::report::Report;

/// Winding rows and violations of one published product; `None` when it is rigid.
/// A mapped body the oracle cannot classify fails closed, like M6's
/// `bounded_chain_unmodelled`: a mirror must never publish unchecked.
pub fn winding_gate(id:u32, class:&affine::Classification, winding:&[bool]) -> Option<(Vec<Value>,Vec<String>)> {
    match class {
        affine::Classification::Rigid=>None,
        affine::Classification::Unmodelled(reason)=>Some((
            vec![json!({"family":"affineClassUnmodelled","pass":false,"gated":true,"reason":reason})],
            vec![format!("{id}: affine_class_unmodelled: {reason}")])),
        affine::Classification::Affine=>Some((
            winding.iter().enumerate().map(|(index,&pass)|json!({"family":"affineSignedVolume","part":index,"pass":pass,"gated":true})).collect(),
            winding.iter().enumerate().filter(|(_,&pass)|!pass).map(|(index,_)|format!("{id} part {index}: affine signed-volume invariant")).collect())),
    }
}
pub fn record(report:&mut Report, oracle:&mut affine::AffineOracle<'_>, product:&ShapeOnlyProduct, tolerances:&Value) {
    let class=oracle.classify(product.product_id);
    let Some((results,violations))=winding_gate(product.product_id,&class,&affine::winding_positive(product)) else {return};
    report.violations.extend(violations);
    if class!=affine::Classification::Affine {append(report,results);return}
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
    use affine::Classification;
    // #7955: the real-kernel winding witnesses live in tests/m10_native.rs; these pin the glue.
    #[test]
    fn reversed_winding_is_a_gated_violation() {
        let (rows,violations)=winding_gate(7,&Classification::Affine,&[true,false]).unwrap();
        assert_eq!(violations,["7 part 1: affine signed-volume invariant"]);
        assert!(rows.iter().all(|r|r["family"]=="affineSignedVolume"&&r["gated"]==true));
        assert_eq!(rows[1]["pass"],false);
        assert!(winding_gate(7,&Classification::Rigid,&[false]).is_none());
    }
    #[test]
    fn unclassifiable_mapped_body_fails_closed() {
        let (rows,violations)=winding_gate(9,&Classification::Unmodelled("grid placement".into()),&[true]).unwrap();
        assert_eq!(violations.len(),1);
        assert!(violations[0].contains("affine_class_unmodelled")&&violations[0].contains("grid placement"));
        assert_eq!((rows[0]["family"].as_str(),rows[0]["gated"].as_bool(),rows[0]["pass"].as_bool()),
            (Some("affineClassUnmodelled"),Some(true),Some(false)));
    }
}
