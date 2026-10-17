// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
fn tetra()->Vec<[[f64;3];3]>{
 let(a,b,c,d)=([0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]);
 vec![[a,c,b],[a,b,d],[a,d,c],[b,c,d]]
}
#[test]
fn issue_7292_strict_incidence_distinguishes_closed_open_and_duplicate_shells(){
 let closed=tetra();assert!(strict_closed(closed.clone()));
 assert!(!strict_closed(closed[..3].iter().copied()));
 assert!(!strict_closed(closed.iter().chain(&closed).copied()),"signed balance cannot admit2forward+2reverse");
 let mut reversed=closed.clone();reversed[0].swap(0,1);assert!(!strict_closed(reversed));
}
#[test]
fn issue_7292_numeric_zero_and_closed_components_preserve_incidence(){
 let mut tris=tetra();tris[0][0][0] = -0.0;assert!(strict_closed(tris.clone()));
 let shifted=tetra().into_iter().map(|t|t.map(|p|p.map(|x|x+3.))).collect::<Vec<_>>();
 assert!(strict_closed(tris.into_iter().chain(shifted)));
}
#[test]
fn issue_7292_invalid_and_geometrically_degenerate_triangles_are_not_closed(){
 assert!(!strict_closed(Vec::<[[f64;3];3]>::new()));
 let mut tris=tetra();tris.push([[0.,0.,0.],[1.,0.,0.],[2.,0.,0.]]);assert!(!strict_closed(tris));
 let mut tris=tetra();tris[0][0][0]=f64::NAN;assert!(!strict_closed(tris));
}
#[test]
fn issue_7292_strict_reader_conservatively_declines_unsplit_tjunction(){
 let mut tris=tetra();let t=tris.remove(0);let mid=std::array::from_fn(|k|(t[0][k]+t[1][k])*0.5);
 tris.push([t[0],mid,t[2]]);tris.push([mid,t[1],t[2]]);
 assert!(!strict_closed(tris),"exactatomicclosure mayhold but strict1f1r doesnot");
}
