// SPDX-License-Identifier: MPL-2.0
//! M10 signed volume and source-derived mapped centroids, never abs-only evidence.
use ifc_lite_retained_native::{oracle::affine, ShapeOnlyProduct, ShapePart};
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
    record_parts(report,oracle,product.product_id,product.cuts,&product.parts,tolerances)
}
/// `record` on the fields it reads, so its whole path (classification, winding gate,
/// report row, and for a product with no cuts the source comparison) runs without a
/// published product or an SDK worker.
pub fn record_parts(report:&mut Report, oracle:&mut affine::AffineOracle<'_>, id:u32, cuts:u64, parts:&[ShapePart], tolerances:&Value) {
    let class=oracle.classify(id);
    let Some((mut results,violations))=winding_gate(id,&class,&affine::winding_positive(parts)) else {return};
    report.violations.extend(violations);
    if class!=affine::Classification::Affine {append(report,results);return}
    // Opening Booleans still require outward winding for every resulting part.
    if cuts!=0 {append(report,results);return}
    // Winding is mandatory even when the analytic source family is unsupported.
    let Some(expected)=oracle.expected(id) else {append(report,results);return};
    if expected.len()!=parts.len() {
        report.violations.push(format!("{id}: affine source part count"));
        append(report,results);return;
    }
    for (index,(part,e)) in parts.iter().zip(expected).enumerate() {
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
        if !pass {report.violations.push(format!("{id} part {index}: affine source oracle"));}
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
    // Hosted review of #8360: `record` itself, end to end (classification -> winding gate ->
    // report row), without a published product. The real-kernel witnesses are in tests/m10_native.rs.
    const SOURCE:&str=include_str!("../../../../tests/fixtures/synthetic-retained/f-h-affine-finals.ifc");
    const CUBE:[f64;24]=[0.,0.,0., 1.,0.,0., 1.,1.,0., 0.,1.,0., 0.,0.,1., 1.,0.,1., 1.,1.,1., 0.,1.,1.];
    const OUTWARD:[u32;36]=[0,2,1,0,3,2, 4,5,6,4,6,7, 0,1,5,0,5,4, 1,2,6,1,6,5, 2,3,7,2,7,6, 3,0,4,3,4,7];
    // A baked mirror, as production publishes it: reflected positions, winding swapped so the
    // signed volume stays positive, and a proper-rigid (translation-only) frame.
    fn part(reversed:bool)->ShapePart {
        let mut indices=OUTWARD.to_vec();
        if !reversed {for t in indices.chunks_exact_mut(3) {t.swap(1,2);}}
        let mut positions=CUBE.to_vec();
        for p in positions.chunks_exact_mut(3) {p[0]=-p[0];}
        ShapePart {layer:None,capped_volume_m3:None,positions,indices,
            world_from_object:[1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 2.,3.,4.,1.],curved:false,halfspace_clipped:false,
            revision_local_faces:vec![],normals:None,appearance:None,faces:None,instance_key:None}
    }
    /// `record` on product `id` of `text`; `cuts` != 0 skips the analytic source comparison.
    fn recorded(text:&str,id:u32,reversed:bool)->(Report,Vec<Value>) {recorded_cuts(text,id,reversed,1,&Value::Null)}
    fn recorded_cuts(text:&str,id:u32,reversed:bool,cuts:u64,tolerances:&Value)->(Report,Vec<Value>) {
        let source=ifc_lite_core::SourceBundle::new(text.as_bytes().to_vec());
        let mut oracle=affine::AffineOracle::new(&source);
        let mut report=Report {rows:vec!["row\t[]".into()],..Default::default()};
        record_parts(&mut report,&mut oracle,id,cuts,&[part(reversed)],tolerances);
        let rows=serde_json::from_str(report.rows[0].split('\t').next_back().unwrap()).unwrap();
        (report,rows)
    }
    #[test]
    fn record_gates_a_mirrored_map_with_outward_winding() {
        let (report,rows)=recorded(SOURCE,42,false);
        assert!(report.violations.is_empty(),"{:?}",report.violations);
        assert_eq!(rows.len(),1);
        assert_eq!((rows[0]["family"].as_str(),rows[0]["gated"].as_bool(),rows[0]["pass"].as_bool()),
            (Some("affineSignedVolume"),Some(true),Some(true)));
    }
    #[test]
    fn record_compares_the_source_only_when_there_are_no_cuts() {
        // The fixture cube is not product 42's analytic body, so with no cuts the source
        // comparison must flag it; the same product with an opening cut skips that comparison.
        let kind=json!({"linear":1e-9,"curved":1e-9});
        let metres=json!({"linear":{"absolute":1e-9,"extentFactor":0.},"curved":{"absolute":1e-9,"extentFactor":0.}});
        let tolerances=json!({"affineFinalVolumeRelative":kind,"affineFinalCentroidMetres":metres,
            "affineFinalBboxMetres":{"absolute":1e-9,"extentFactor":0.}});
        let (report,rows)=recorded_cuts(SOURCE,42,false,0,&tolerances);
        assert_eq!(report.violations,["42 part 0: affine source oracle"]);
        assert_eq!(rows.iter().map(|r|r["family"].as_str().unwrap()).collect::<Vec<_>>(),["affineSignedVolume","affineFinal"]);
        assert_eq!(rows[1]["pass"].as_bool(),Some(false));
        let (cut,rows)=recorded_cuts(SOURCE,42,false,1,&tolerances);
        assert!(cut.violations.is_empty()&&rows.len()==1,"{:?}",cut.violations);
    }
    #[test]
    fn record_reports_reversed_winding_of_a_mirrored_map() {
        let (report,rows)=recorded(SOURCE,42,true);
        assert_eq!(report.violations,["42 part 0: affine signed-volume invariant"]);
        assert_eq!((rows[0]["family"].as_str(),rows[0]["pass"].as_bool()),(Some("affineSignedVolume"),Some(false)));
    }
    #[test]
    fn record_fails_closed_on_an_unclassifiable_mapped_body() {
        let text=SOURCE.replace("#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#35,#36,#37,1.,#3);",
            "#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#35,#36,$,1.,#3);");
        assert_ne!(text,SOURCE);
        // Even with the winding outward, an unclassifiable mapped body is a violation.
        let (report,rows)=recorded(&text,42,false);
        assert_eq!(report.violations.len(),1);
        assert!(report.violations[0].starts_with("42: affine_class_unmodelled:"),"{:?}",report.violations);
        assert_eq!((rows[0]["family"].as_str(),rows[0]["gated"].as_bool(),rows[0]["pass"].as_bool()),
            (Some("affineClassUnmodelled"),Some(true),Some(false)));
    }
    #[test]
    fn record_leaves_a_rigid_product_alone() {
        let (report,rows)=recorded(SOURCE,34,true);
        assert!(report.violations.is_empty()&&rows.is_empty(),"{:?}",report.violations);
    }
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
