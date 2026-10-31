// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
#[path="support/m6_halfspaces.rs"]
mod fixture;
use fixture::{walk,SOURCE};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{document::PrismSegment,program::transactions::TransactionFailureKind};
#[test]
fn issue_7955_m6_oblique_projection_is_along_position_z() {
    let (trace,result)=walk(SOURCE,1001);result.unwrap();assert_eq!(trace.prisms.len(),1);
    let p=&trace.prisms[0];let cutter=nalgebra::Matrix4::from_column_slice(&p.frame);
    let host=nalgebra::Matrix4::from_column_slice(&trace.frame.unwrap());
    let slope=35f64.to_radians().tan();
    for (segment,[x,y]) in p.loops[0].segments.iter().zip([[0.5,0.5],[2.5,0.5],[2.5,2.5],[0.5,2.5]]) {
        let PrismSegment::Line{start,..}=segment else{panic!("line")};
        let actual=host.transform_point(&cutter.transform_point(&nalgebra::Point3::new(start[0],start[1],0.)));
        for (a,b) in actual.coords.iter().zip([x,y,2.+slope*x]) {
            assert!((*a-b).abs()<=4.*f64::EPSILON*b.abs().max(1.),"projection {actual:?}, expected {:?}", [x,y,2.+slope*x]);
        }
    }
    let axis=cutter.transform_vector(&nalgebra::Vector3::from(p.direction));
    assert!((axis-nalgebra::Vector3::z()).norm()<=4.*f64::EPSILON);
    let r=nalgebra::Vector3::new(p.frame[8],p.frame[9],p.frame[10]);
    let origin=nalgebra::Vector3::new(p.frame[12],p.frame[13],p.frame[14]);
    let b=trace.bounds.unwrap();let h=(0..8).map(|j|r.dot(&(nalgebra::Vector3::from(std::array::from_fn::<_,3,_>(|i|b[i+if j&(1<<i)==0{0}else{3}]))-origin))).fold(f64::NEG_INFINITY,f64::max);
    let diagonal=((b[3]-b[0]).powi(2)+(b[4]-b[1]).powi(2)+(b[5]-b[2]).powi(2)).sqrt();
    assert_eq!(p.depth,(h+0.01f64.max(0.05*diagonal))/r.z.abs());
    let (opposite,result)=walk(SOURCE,1015);result.unwrap();
    let p=&opposite.prisms[0];let axis=nalgebra::Matrix4::from_column_slice(&p.frame).transform_vector(&nalgebra::Vector3::from(p.direction));
    assert!((axis+nalgebra::Vector3::z()).norm()<=4.*f64::EPSILON);
}
#[test]
fn issue_7955_m6_nonconvex_chain_arc_and_skip() {
    let (l,r)=walk(SOURCE,1002);r.unwrap();assert_eq!(l.prisms[0].loops[0].segments.len(),6);
    let (chain,r)=walk(SOURCE,1003);r.unwrap();assert_eq!(chain.order,["host","prism","difference","prism","difference"]);
    let (arc,r)=walk(SOURCE,1005);r.unwrap();let payload=arc.prisms[0].lower().unwrap();
    assert!(payload.bytes[56..].chunks_exact(104).any(|s|u32::from_le_bytes(s[..4].try_into().unwrap())==3));
    let (skip,r)=walk(SOURCE,1010);r.unwrap();assert_eq!(skip.order,["host"]);
}
#[test]
fn issue_7955_m6_refusals_precede_cutter_construction() {
    for id in [1006,1012,1013] {
        let (trace,result)=walk(SOURCE,id);let error=result.unwrap_err();
        assert_eq!(error.kind(),TransactionFailureKind::OperationUnsupported,"#{id}: {error:?}");
        assert_eq!(trace.order,["host"]);
    }
    // The invalid boundary must remain unread when the axis is parallel.
    let source=SourceBundle::new(SOURCE.as_bytes().to_vec());let mut decoder=source.decoder();
    let parallel=decoder.decode_by_id(1013).unwrap();assert_eq!(parallel.id,1013);
    let text=SOURCE.lines().map(|line|if line.contains("IFCPOLYGONALBOUNDEDHALFSPACE") {
        let mut parts:Vec<_>=line.split(',').collect();parts[3]="#999999);";parts.join(",")
    }else{line.to_string()}).collect::<Vec<_>>().join("\n");
    let (trace,result)=walk(&text,1013);assert_eq!(result.unwrap_err().kind(),TransactionFailureKind::OperationUnsupported);assert_eq!(trace.order,["host"]);
}
#[test]
fn issue_7955_m6_boxed_delegates_outcomes_without_enclosure() {
    let (_,plain)=walk(SOURCE,1008);
    for id in [1007,1009] {
        let (trace,boxed)=walk(SOURCE,id);
        let source=SourceBundle::new(SOURCE.as_bytes().to_vec());let mut decoder=source.decoder();
        for line in SOURCE.lines().filter(|l|l.contains("IFCBOXEDHALFSPACE(")) {
            let entity_id=line[1..line.find('=').unwrap()].parse().unwrap();
            let enclosure=decoder.decode_by_id(entity_id).unwrap().get_ref(2).unwrap();
            assert!(!trace.decoded.contains(&enclosure),"Enclosure #{enclosure} was decoded");
        }
        assert_eq!(boxed.as_ref().err().map(|e|e.kind()),plain.as_ref().err().map(|e|e.kind()));
    }
    let text=SOURCE.lines().filter(|l|!l.contains("IFCBOUNDINGBOX(")).collect::<Vec<_>>().join("\n");
    let (_,missing)=walk(&text,1007);
    assert_eq!(missing.as_ref().err().map(|e|e.kind()),plain.as_ref().err().map(|e|e.kind()));
}
#[test]
fn issue_7955_m6_boolean_operator_and_malformed_source_precedence() {
    for operator in ["UNION","INTERSECTION"] {
        let text=SOURCE.replace("IFCBOOLEANRESULT(.DIFFERENCE.",&format!("IFCBOOLEANRESULT(.{operator}."));
        let (trace,result)=walk(&text,1001);assert_eq!(result.unwrap_err().kind(),TransactionFailureKind::OperationUnsupported);
        assert_eq!(trace.order,["host"]);
    }
    let text=SOURCE.lines().map(|line|if line.contains("IFCPOLYGONALBOUNDEDHALFSPACE(") {
            line.replace(",.F.,",",$,")
        }else{line.to_string()}).collect::<Vec<_>>().join("\n");
    let (trace,result)=walk(&text,1001);assert_eq!(result.unwrap_err().kind(),TransactionFailureKind::Source);assert_eq!(trace.order,["host"]);
}

#[test]
fn issue_7955_m6_full_circle_uses_the_prism_circle_wire() {
    let text=SOURCE.replace("#36=IFCINDEXEDPOLYCURVE(#35,(IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,4,1))),.F.);","#36=IFCCIRCLE(#9036,0.5);\n#9036=IFCAXIS2PLACEMENT2D(#9037,$);\n#9037=IFCCARTESIANPOINT((1.,1.));");
    let (trace,result)=walk(&text,1005);result.unwrap();
    assert_eq!(trace.prisms.len(),1);assert_eq!(trace.prisms[0].loops[0].segments.len(),1);
    assert!(matches!(trace.prisms[0].loops[0].segments[0],PrismSegment::Circle{radius,..} if radius==0.5));
}

#[test]
fn issue_7955_m6_admits_exactly_256_boundary_vertices() {
    // Remove one distinct point from the 257-gon, preserving its closure.
    let text=SOURCE.replace(",#295,#39));",",#39));");
    let (trace,result)=walk(&text,1012);result.unwrap();
    assert_eq!(trace.order,["host","prism","difference"]);
    assert_eq!(trace.prisms[0].loops[0].segments.len(),256);
    trace.prisms[0].lower().unwrap();
}
