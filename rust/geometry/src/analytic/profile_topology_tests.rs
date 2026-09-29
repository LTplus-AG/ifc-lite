// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6316: stated Jordan-region invariants and the real Revit reproduction.
use super::*;
use crate::analytic::{extract_analytic_extrusion, AnalyticStatus, ProfileLoopKind};
use ifc_lite_core::{build_entity_index, EntityDecoder};
use std::f64::consts::{PI, TAU};

fn boundary(segments: Vec<AnalyticCurveSegment>) -> AnalyticProfileLoop {
    AnalyticProfileLoop { kind: ProfileLoopKind::Outer, segments, signed_area: 1.0, perimeter: 1.0 }
}
fn polygon(points: &[[f64; 2]]) -> AnalyticProfileLoop {
    let mut result = boundary((0..points.len()).map(|i| {
        let a = points[i]; let b = points[(i + 1) % points.len()];
        AnalyticCurveSegment::Line { start: [a[0], a[1], 0.0], end: [b[0], b[1], 0.0] }
    }).collect());
    result.signed_area = (0..points.len()).map(|i| {
        let a = points[i]; let b = points[(i+1)%points.len()];
        (a[0]*b[1]-a[1]*b[0])*0.5
    }).sum();
    result.perimeter = result.segments.iter().map(|segment| segment.length().unwrap()).sum();
    result
}
fn square(x: f64, y: f64, half: f64) -> AnalyticProfileLoop {
    polygon(&[[x-half,y-half],[x+half,y-half],[x+half,y+half],[x-half,y+half]])
}
fn arc(center: [f64; 2], radius: f64, start: f64, sweep: f64) -> AnalyticCurveSegment {
    AnalyticCurveSegment::Arc { center: [center[0],center[1],0.0], normal: [0.0,0.0,1.0],
        x_axis: [1.0,0.0,0.0], radius, start_angle: start, sweep_angle: sweep }
}
fn circle(x: f64, y: f64, radius: f64) -> AnalyticProfileLoop {
    boundary(vec![arc([x,y],radius,0.0,TAU)])
}

#[test]
fn issue_6316_valid_line_and_arc_regions() {
    for loops in [vec![square(0.0,0.0,4.0), square(0.0,0.0,1.0)],
        vec![circle(0.0,0.0,4.0), circle(0.0,0.0,1.0)],
        vec![square(0.0,0.0,4.0), circle(0.0,0.0,1.0)],
        vec![circle(0.0,0.0,4.0), square(0.0,0.0,1.0)],
        vec![circle(0.0,0.0,4.0), circle(-1.5,0.0,0.5), circle(1.5,0.0,0.5)]] {
        assert!(validate(&loops,1e-9,1e-9).is_ok(), "{:?}", validate(&loops,1e-9,1e-9));
    }
}

#[test]
fn issue_6316_holes_must_be_inside_and_pairwise_disjoint() {
    for holes in [vec![square(5.0,0.0,0.5)], vec![square(4.0,0.0,0.5)],
        vec![square(3.5,0.0,0.5)], vec![square(0.0,0.0,2.0),square(0.0,0.0,0.5)],
        vec![square(0.0,0.0,1.0),square(0.0,0.0,1.0)],
        vec![square(-0.5,0.0,1.0),square(0.5,0.0,1.0)]] {
        let loops: Vec<_> = std::iter::once(square(0.0,0.0,4.0)).chain(holes).collect();
        assert!(validate(&loops,1e-9,1e-9).is_err());
    }
}

#[test]
fn issue_6316_arc_contacts_crossings_and_nesting_are_unsupported() {
    for loops in [vec![circle(0.0,0.0,4.0), circle(3.0,0.0,1.0)],
        vec![circle(0.0,0.0,4.0), circle(3.5,0.0,1.0)],
        vec![square(0.0,0.0,4.0), circle(3.0,0.0,1.0)],
        vec![circle(0.0,0.0,4.0),circle(-1.0,0.0,1.0),circle(1.0,0.0,1.0)],
        vec![circle(0.0,0.0,4.0),circle(0.0,0.0,2.0),circle(0.0,0.0,1.0)],
        vec![circle(0.0,0.0,4.0),circle(0.0,0.0,1.0),circle(0.0,0.0,1.0)]] {
        assert!(validate(&loops,1e-9,1e-9).is_err());
    }
}

#[test]
fn issue_6316_self_crossings_and_backtracking_are_not_simple() {
    for points in [vec![[-2.0,-1.0],[2.0,1.0],[-2.0,1.0],[1.0,-1.0]],
        vec![[0.0,0.0],[2.0,0.0],[1.0,0.0],[1.0,2.0],[0.0,2.0]],
        vec![[0.0,0.0],[2.0,0.0],[1.0,1.0],[2.0,2.0],[0.0,2.0],[1.0,1.0]]] {
        assert!(validate(&[polygon(&points)],1e-9,1e-9).is_err());
    }
}

#[test]
fn issue_6316_two_piece_semicircle_has_two_legal_shared_endpoints() {
    let half = boundary(vec![arc([0.0,0.0],1.0,0.0,PI),
        AnalyticCurveSegment::Line { start: [-1.0,0.0,0.0], end: [1.0,0.0,0.0] }]);
    assert!(validate(&[half],1e-9,1e-9).is_ok());
}

#[test]
fn issue_6316_adjacent_coincident_arcs_do_not_bypass_validation() {
    let doubled = boundary(vec![arc([0.0,0.0],1.0,0.0,PI), arc([0.0,0.0],1.0,PI,-PI)]);
    assert!(validate(&[doubled],1e-9,1e-9).is_err());
    let crossing = boundary(vec![arc([0.0,0.0],2.0,0.0,PI),
        AnalyticCurveSegment::Line { start: [-2.0,0.0,0.0],end: [0.0,3.0,0.0] },
        AnalyticCurveSegment::Line { start: [0.0,3.0,0.0],end: [2.0,0.0,0.0] }]);
    assert!(validate(&[crossing],1e-9,1e-9).is_err());
}

#[test]
fn issue_6316_near_join_does_not_hide_remote_nearly_parallel_crossing() {
    // The endpoints differ by less than closure precision, but the outgoing
    // lines cross ~5e-6 away. A shared-endpoint exemption would miss this.
    let a = AnalyticCurveSegment::Line { start: [-1.0,0.0,0.0],end: [0.0,0.0,0.0] };
    let b = AnalyticCurveSegment::Line { start: [0.0,-5e-10,0.0],end: [-1.0,1e-4,0.0] };
    let a = Curve::new(&a,[0.0,0.0]).unwrap();
    let b = Curve::new(&b,[0.0,0.0]).unwrap();
    assert!(separate(&a,&b,&[(1.0,0.0)],1e-9,1e-9,&mut Budget(MAX_WORK)).is_err());
}

#[test]
fn issue_6316_rotated_clockwise_arcs_and_quadrant_joins_remain_valid() {
    let mut segments: Vec<_> = (0..4).map(|i| arc([0.0,0.0],4.0,i as f64*PI/2.0,PI/2.0)).collect();
    for segment in &mut segments {
        if let AnalyticCurveSegment::Arc { normal, x_axis, .. } = segment {
            *normal = [0.0,0.0,-1.0];
            *x_axis = [0.0,1.0,0.0];
        }
    }
    assert!(validate(&[boundary(segments),circle(0.0,0.0,1.0)],1e-9,1e-9).is_ok());
}

#[test]
fn issue_6316_major_arc_and_chord_is_simple() {
    let loops = [boundary(vec![arc([0.0,0.0],2.0,0.0,1.5*PI),
        AnalyticCurveSegment::Line { start: [0.0,-2.0,0.0],end: [2.0,0.0,0.0] }])];
    assert!(validate(&loops,1e-9,1e-9).is_ok());
}

#[test]
fn issue_6316_degenerate_or_uncertifiable_arc_never_becomes_complete() {
    for segment in [arc([0.0,0.0],1.0,0.0,2.0*TAU),
        arc([0.0,0.0],1.0,100.0,TAU),arc([0.0,0.0],f64::MAX,0.0,TAU)] {
        assert!(validate(&[boundary(vec![segment]),circle(0.0,0.0,0.1)],1e-9,1e-9).is_err());
    }
}

#[test]
fn issue_6316_concave_profile_and_reversed_winding_remain_valid() {
    let outer = polygon(&[[0.0,0.0],[5.0,0.0],[5.0,1.0],[1.0,1.0],[1.0,5.0],[0.0,5.0]]);
    let mut loops = vec![outer, square(0.5,2.0,0.2)];
    assert!(validate(&loops,1e-9,1e-9).is_ok());
    for item in &mut loops {
        item.segments = item.segments.iter().rev().map(AnalyticCurveSegment::reversed).collect();
    }
    assert!(validate(&loops,1e-9,1e-9).is_ok());
}

#[test]
fn issue_6316_precision_clearance_and_unit_scaling() {
    for scale in [1.0,1000.0] {
        let loops = [square(0.0,0.0,4.0*scale),square(2.9999*scale,0.0,scale)];
        assert!(validate(&loops,0.00001*scale,1e-9*scale).is_ok());
        assert!(validate(&loops,0.001*scale,1e-9*scale).is_err());
    }
}

#[test]
fn issue_6316_material_region_must_be_resolved_at_precision() {
    assert!(validate(&[polygon(&[[0.0,0.0],[1.0,0.0],[0.0,1.0]])],2.0,1e-9).is_err());
    assert!(validate(&[polygon(&[[0.0,0.0],[1.0,0.0],[0.0,1.0]])],1e-3,1e-9).is_ok());
    assert!(validate(&[polygon(&[[0.0,0.0],[10.0,0.0],[5.0,1e-6]])],1e-3,1e-9).is_err());
}

#[test]
fn issue_6316_loose_clearance_does_not_loosen_tight_context_join() {
    let delta = 1e-11;
    let mut shape = polygon(&[[0.0,0.0],[1.0,0.0],[1.0-delta,1.0],[0.0,1.0]]);
    if let AnalyticCurveSegment::Line { start, .. } = &mut shape.segments[1] {
        *start = [1.0-delta,-delta,0.0];
    }
    // At loose point-identity tolerance this is one adjacent topological join.
    assert!(validate(&[shape.clone()],1e-9,1e-9).is_ok());
    // The same contact lies outside a tighter context's equivalent endpoint.
    assert!(validate(&[shape],1e-9,1e-12).is_err());
}

#[test]
fn issue_6316_translation_does_not_erase_local_arc_geometry() {
    for x in [0.0,2_600_000.0] {
        assert!(validate(&[circle(x,0.0,4.0),circle(x,0.0,1.0)],1e-9,1e-9).is_ok());
    }
}

#[test]
fn issue_6316_work_exhaustion_reports_unsupported() {
    let loops = [square(0.0,0.0,4.0),circle(0.0,0.0,1.0)];
    assert!(validate_bounded(&loops,1e-9,1e-9,1).unwrap_err().contains("work budget"));
    assert!(validate_bounded(&loops,1e-9,1e-9,MAX_WORK).is_ok());
}

#[test]
fn issue_6316_declared_context_precision_controls_public_extraction() {
    // Two exact rectangles, with a 1e-4 gap between the inner right edge and
    // outer right edge. Change only context Precision, not source geometry.
    let source = "ISO-10303-21;DATA;
#1=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);
#2=IFCCARTESIANPOINTLIST2D(((-4.,-4.),(4.,-4.),(4.,4.),(-4.,4.),(-4.,-4.)));
#3=IFCINDEXEDPOLYCURVE(#2,$,.F.);
#4=IFCCARTESIANPOINTLIST2D(((1.9999,-1.),(3.9999,-1.),(3.9999,1.),(1.9999,1.),(1.9999,-1.)));
#5=IFCINDEXEDPOLYCURVE(#4,$,.F.);
#6=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#3,(#5));
ENDSEC;END-ISO-10303-21;";
    let read = |bytes: &[u8]| {
        let mut decoder = EntityDecoder::new(bytes);
        let profile = decoder.decode_by_id(6).unwrap();
        crate::analytic::extract_analytic_profile(&profile,&mut decoder)
    };
    assert_eq!(read(source.as_bytes()).status,AnalyticStatus::Complete);
    let coarse = source.replace("1.E-5","1.E-3");
    assert!(matches!(read(coarse.as_bytes()).status,AnalyticStatus::Unsupported(_)));
}

#[test]
fn issue_6316_revit_outside_hole_propagates_to_source_status() {
    let bytes = include_bytes!("../../tests/fixtures/issue_098_wall_W.ifc");
    let read = |source: &[u8]| {
        let mut decoder = EntityDecoder::with_index(source,build_entity_index(source));
        let solid = decoder.decode_by_id(338107).unwrap();
        extract_analytic_extrusion(&solid,&mut decoder)
    };
    let valid = read(bytes);
    assert_eq!(valid.status,AnalyticStatus::Complete);
    let profile = valid.profile.unwrap();
    // Authored outer 2.5 x 0.8, inner 2.41 x 0.71 (file metres).
    assert!((profile.loops[0].signed_area.abs()-profile.loops[1].signed_area.abs()
        -(2.5*0.8-2.41*0.71)).abs()<1e-10);
    let mut source = String::from_utf8(bytes.to_vec()).unwrap();
    for (id, coords) in [(338092,"10.1,-0.1"),(338094,"9.9,-0.1"),(338096,"9.9,0.1"),(338098,"10.1,0.1")] {
        let prefix = format!("#{id}=");
        let start = source.find(&prefix).unwrap();
        let end = start + source[start..].find(';').unwrap()+1;
        source.replace_range(start..end,&format!("#{id}=IFCCARTESIANPOINT(({coords}));"));
    }
    let invalid = read(source.as_bytes());
    assert!(matches!(invalid.status,AnalyticStatus::Unsupported(_)));
    let invalid_profile = invalid.profile.unwrap();
    assert!(matches!(invalid_profile.status,AnalyticStatus::Unsupported(_)));
    assert!(invalid_profile.loops.is_empty());
}
