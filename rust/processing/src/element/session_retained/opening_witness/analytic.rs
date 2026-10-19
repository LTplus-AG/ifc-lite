// SPDX-License-Identifier: MPL-2.0
//! Independent dyadic-source geometry; no SDK, display mesh, or result constants.
use num_rational::BigRational as R;
use num_traits::{Signed, ToPrimitive, Zero};
pub(super) type Point = [R; 2];
#[derive(Clone)]
pub(super) struct Prism { pub polygon: Vec<Point>, pub lo: R, pub hi: R }
pub(super) fn q(v: f64) -> R { assert!(v.is_finite()); R::from_float(v).unwrap() }
fn cross(a: &Point, b: &Point) -> R { &a[0]*&b[1]-&a[1]*&b[0] }
fn sub(a: &Point, b: &Point) -> Point { [&a[0]-&b[0], &a[1]-&b[1]] }
fn edges(p: &[Point]) -> impl Iterator<Item = (&Point, &Point)> {
    p.iter().zip(p.iter().cycle().skip(1)).take(p.len())
}
fn clip(mut p: Vec<Point>, boundary: &[Point]) -> Vec<Point> {
    for (a,b) in edges(boundary) {
        let mut out=Vec::new();
        for (x,y) in edges(&p) {
            let dx=cross(&sub(b,a),&sub(x,a)); let dy=cross(&sub(b,a),&sub(y,a));
            if dx>=R::zero() {out.push(x.clone());}
            if (dx<R::zero()) != (dy<R::zero()) {
                let t=&dx/(&dx-&dy);
                out.push([&x[0]+&t*(&y[0]-&x[0]),&x[1]+&t*(&y[1]-&x[1])]);
            }
        }
        p=out; if p.is_empty() {break;}
    }
    p
}
fn area(p: &[Point]) -> R {
    edges(p).map(|(a,b)|cross(a,b)).sum::<R>().abs()/q(2.)
}
pub(super) fn remaining(host: &Prism, cuts: &[Prism]) -> f64 {
    assert!(cuts.len()<=4,"fixture-only bounded inclusion-exclusion");
    let mut result=area(&host.polygon)*(&host.hi-&host.lo);
    for mask in 1usize..(1<<cuts.len()) {
        let mut p=host.polygon.clone(); let mut lo=host.lo.clone(); let mut hi=host.hi.clone();
        for (i,c) in cuts.iter().enumerate() {
            if mask&(1<<i)!=0 {p=clip(p,&c.polygon);lo=lo.max(c.lo.clone());hi=hi.min(c.hi.clone());}
        }
        let v=area(&p)*(hi-lo).max(R::zero());
        if mask.count_ones()%2==1 {result-=v;} else {result+=v;}
    }
    result.to_f64().unwrap()
}
fn interval(p: &[Point], y: &R) -> (R,R) {
    let mut xs=Vec::new();
    for (a,b) in edges(p) {
        if (&a[1]<=y && y<&b[1]) || (&b[1]<=y && y<&a[1]) {
            xs.push(&a[0]+(y-&a[1])*(&b[0]-&a[0])/(&b[1]-&a[1]));
        }
    }
    xs.sort(); assert_eq!(xs.len(),2); (xs[0].clone(),xs[1].clone())
}
/// Signed occupied interval endpoints: entering material (-X normal), leaving (+X).
pub(super) fn section(host: &Prism, cuts: &[Prism], y: f64, z: f64) -> Vec<(f64,i8)> {
    let y=q(y); let z=q(z); let (lo,hi)=interval(&host.polygon,&y);
    let mut removed:Vec<_>=cuts.iter().filter(|c|c.lo<z && z<c.hi)
        .map(|c|interval(&c.polygon,&y)).map(|(a,b)|(a.max(lo.clone()),b.min(hi.clone())))
        .filter(|(a,b)|a<b).collect();
    removed.sort(); let mut merged:Vec<(R,R)>=Vec::new();
    for (a,b) in removed {
        if let Some(last)=merged.last_mut() {if a<=last.1 {last.1=last.1.clone().max(b);continue;}}
        merged.push((a,b));
    }
    let mut out=Vec::new();let mut cursor=lo;
    for (a,b) in merged {
        if cursor<a {out.push((cursor.to_f64().unwrap(),-1));out.push((a.to_f64().unwrap(),1));}
        cursor=b;
    }
    if cursor<hi {out.push((cursor.to_f64().unwrap(),-1));out.push((hi.to_f64().unwrap(),1));}
    out
}
pub(in super::super) struct Oracle {
    pub stages: Vec<f64>, pub total: f64, pub sections: Vec<(f64,Vec<(f64,i8)>)>,
    pub bounds: [f64;6], pub y: f64,
}
