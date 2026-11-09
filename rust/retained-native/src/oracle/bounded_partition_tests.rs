// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::f64::consts::{FRAC_PI_2, PI, TAU};

fn reversed(edges: &[Edge]) -> Vec<Edge> {
    edges.iter().rev().map(|edge| match *edge {
        Edge::Line(a,b) => Edge::Line(b,a),
        Edge::Arc{c,u,v,a,sweep} => Edge::Arc{c,u,v,a:a+sweep,sweep:-sweep},
    }).collect()
}

#[test]
fn m6_7955_arc_endpoint_crossings_are_orientation_independent() {
    // The first sector is the review's (2,0) -> (0,2) -> (0,0) repro.
    // Rotate it to exercise both crossing directions and both arc endpoints.
    for (a,start,end) in [(0.,[2.,0.],[0.,2.]), (FRAC_PI_2,[0.,2.],[-2.,0.]),
        (PI,[-2.,0.],[0.,-2.]), (-FRAC_PI_2,[0.,-2.],[2.,0.])] {
        let arc=Edge::Arc{c:[0.;2],u:[2.,0.],v:[0.,2.],a,sweep:FRAC_PI_2};
        let edges=vec![arc.clone(),Edge::Line(end,[0.;2]),Edge::Line([0.;2],start)];
        let reverse=reversed(&edges);
        for y in [0.,start[1],end[1]] {
            let p=[-3.,y];
            let forward=inside_distance(&edges,p);
            let backward=inside_distance(&reverse,p);
            assert!(forward<0. && backward<0.,"a={a}, p={p:?}: {forward} vs {backward}");
            assert!((forward-backward).abs()<1e-12);
        }
        let p=[(a+FRAC_PI_2/2.).cos(),(a+FRAC_PI_2/2.).sin()];
        assert!(inside_distance(&edges,p)>0.);
        assert!(inside_distance(&reverse,p)>0.);
    }
}

#[test]
fn m6_7955_full_circle_seam_counts_once_in_both_orientations() {
    for a in [0.,PI] {
        let edges=[Edge::Arc{c:[0.;2],u:[2.,0.],v:[0.,2.],a,sweep:TAU}];
        let reverse=reversed(&edges);
        for p in [[-3.,0.],[0.,0.],[3.,0.],[0.,2.],[0.,-2.]] {
            assert!((inside_distance(&edges,p)-inside_distance(&reverse,p)).abs()<1e-12,"{p:?}");
        }
    }
}

#[test]
fn m6_7955_degenerate_partition_returns_none_without_panicking() {
    for points in [vec![],vec![[0.,0.]],vec![[0.,0.],[1.,0.]]] {
        assert!(triangles(points).is_none());
    }
}
