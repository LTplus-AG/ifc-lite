// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact-sign local topology checks for a proposed contour shortcut.
//! This changes no weld/noise threshold and does not charge the CSG budget:
//! consolidation runs after that budget's caller check. Scans are over finite
//! supplied contours; the added worst-case work is not a performance claim.
use nalgebra::Point2;
use crate::geom2d::{orientation, on_segment, segments_intersect};
type P = Point2<f64>;
fn xy(p:P)->[f64;2] {[p.x,p.y]}
fn finite(p:P)->bool {p.x.is_finite()&&p.y.is_finite()}
fn inside(a:P,b:P,c:P,p:P,w:i32)->bool {
    [(a,b),(b,c),(c,a)].into_iter().all(|(u,v)|{let s=orientation(xy(u),xy(v),xy(p));s==0||s==w})
}
fn live_winding(ring:&[P],keep:&[bool],skip:usize)->i32 {
    let live=|i:usize|keep[i]&&i!=skip;
    let Some(i)=(0..ring.len()).filter(|&i|live(i)).min_by(|&i,&j|
        crate::cmp_f64_nan_last(ring[i].x,ring[j].x).then(crate::cmp_f64_nan_last(ring[i].y,ring[j].y)))else{return 0};
    let n=ring.len();
    let prev=(1..n).map(|k|(i+n-k)%n).find(|&j|live(j));
    let next=(1..n).map(|k|(i+k)%n).find(|&j|live(j));
    match(prev,next){(Some(a),Some(b))if a!=b=>orientation(xy(ring[a]),xy(ring[i]),xy(ring[b])),_=>0}
}
fn chord_conflict(a:P,c:P,u:P,v:P)->bool {
    if !segments_intersect(xy(a),xy(c),xy(u),xy(v)){return false;}
    // An incident edge may meet the new chord ONLY at its expected endpoint.
    // Merely skipping incident edges would miss collinear overlap/backtracking.
    if u==a||u==c {
        return on_segment(xy(a),xy(c),xy(v)) ||
            (on_segment(xy(u),xy(v),xy(a))&&u!=a) ||
            (on_segment(xy(u),xy(v),xy(c))&&u!=c);
    }
    if v==a||v==c {return chord_conflict(a,c,v,u);}
    true
}

/// `other` contains every current contour in the SAME plane bucket, including
/// other outers/islands and holes, plus immutable welded source footprints. The current ring is supplied separately with
/// its live mask so earlier accepted removals participate in this check.
pub(super) fn admissible(
    ring:&[P],keep:&[bool],prev:usize,i:usize,next:usize,live:usize,
    other:impl Iterator<Item=impl AsRef<[P]>>,
)->bool {
    // Called only for an angular-qualified removal from an initially >=4 ring.
    // Preserve the existing terminal collapse/noise policy; initial triangles
    // never enter this callback. Topology guards apply to surviving contours.
    if live<=3{return true;}
    let(a,b,c)=(ring[prev],ring[i],ring[next]);
    if !finite(a)||!finite(b)||!finite(c)||a==c{return false;}
    let w=orientation(xy(a),xy(b),xy(c));
    if w==0&&on_segment(xy(a),xy(c),xy(b)) {return true;}
    if w==0{return false;} // Collinear reversal is not a path-equivalent deletion.
    if ring.iter().zip(keep).any(|(&p,&live)|live&&!finite(p)){return false;}
    let old=live_winding(ring,keep,usize::MAX);
    if old==0||live_winding(ring,keep,i)!=old{return false;}
    for k in 0..ring.len() {
        if !keep[k]||k==i {continue;}
        if k!=prev&&k!=next&&(!finite(ring[k])||inside(a,b,c,ring[k],w)){return false;}
        let Some(j)=(1..ring.len()).map(|d|(k+d)%ring.len()).find(|&j|keep[j])else{return false};
        if k==prev||k==i {continue;} // Only old a-b and b-c are replaced.
        if chord_conflict(a,c,ring[k],ring[j]){return false;}
    }
    for contour in other {
        let contour=contour.as_ref();
        for k in 0..contour.len() {
            let p=contour[k];let q=contour[(k+1)%contour.len()];
            // A whole hole inside the swept ear can be swallowed without ever
            // intersecting the replacement chord; vertex containment is needed.
            if !finite(p)||!finite(q)||inside(a,b,c,p,w)||
                segments_intersect(xy(a),xy(c),xy(p),xy(q)){return false;}
        }
    }
    true
}

#[cfg(test)]
#[path = "ring_guard_tests.rs"]
mod tests;
