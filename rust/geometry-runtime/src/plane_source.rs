// SPDX-License-Identifier: MPL-2.0
//! Frozen source-domain wire structure. Native proves geometry; these records
//! are output-only observations of the actual input face inventory, not UV authority.
use super::{floats, CylinderDomain};

/// Raw boundary evidence. Float values are never normalized or reconstructed.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceRectangleEdge {
    flags: u32, start_corner: u32, end_corner: u32,
    controls: [f64;8], knots: [f64;4], interval: [f64;2],
    start: [f64;3], end: [f64;3], line_origin: [f64;3], line_axis: [f64;3],
    step: [f64;2], scale: f64,
}
impl SourceRectangleEdge {
    pub fn flags(&self) -> u32 { self.flags }
    pub fn start_corner(&self) -> u32 { self.start_corner }
    pub fn end_corner(&self) -> u32 { self.end_corner }
    pub fn controls(&self) -> &[f64;8] { &self.controls }
    pub fn knots(&self) -> &[f64;4] { &self.knots }
    pub fn interval(&self) -> &[f64;2] { &self.interval }
    pub fn start(&self) -> &[f64;3] { &self.start }
    pub fn end(&self) -> &[f64;3] { &self.end }
    pub fn line_origin(&self) -> &[f64;3] { &self.line_origin }
    pub fn line_axis(&self) -> &[f64;3] { &self.line_axis }
    pub fn step(&self) -> &[f64;2] { &self.step }
    pub fn scale(&self) -> f64 { self.scale }
}
/// Immutable source coefficients and symbolic inverse; no authored UV claim.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceRectangleDomain {
    version: u32, source_face: u32, axes: [u32;3],
    controls: [f64;16], u: [f64;4], v: [f64;4], bounds: [f64;6],
    uv_hull: [f64;4], inverse: [f64;8], edges: [SourceRectangleEdge;4],
}
impl SourceRectangleDomain {
    pub fn version(&self) -> u32 { self.version }
    pub fn source_face(&self) -> u32 { self.source_face }
    pub fn axes(&self) -> &[u32;3] { &self.axes }
    pub fn controls(&self) -> &[f64;16] { &self.controls }
    pub fn u(&self) -> &[f64;4] { &self.u }
    pub fn v(&self) -> &[f64;4] { &self.v }
    pub fn bounds(&self) -> &[f64;6] { &self.bounds }
    pub fn uv_hull(&self) -> &[f64;4] { &self.uv_hull }
    pub fn inverse(&self) -> &[f64;8] { &self.inverse }
    pub fn edges(&self) -> &[SourceRectangleEdge;4] { &self.edges }
    pub fn loops(&self) -> u32 { 1 }
    pub fn holes(&self) -> u32 { 0 }
    pub fn edge_count(&self) -> u32 { 4 }
    pub fn control_count(&self) -> u32 { 12 }
    pub fn flags(&self) -> u32 { 0 }
}
fn u(b: &[u8], i: usize) -> u32 { u32::from_le_bytes(b[i..i+4].try_into().expect("four bytes")) }
fn knots(k: &[f64;4]) -> bool { k[0]==k[1] && k[2]==k[3] && k[0]<k[3] }
fn weights(c: &[f64]) -> bool { c.chunks_exact(4).all(|p| p[3]==1. || p[3]==-f64::MAX) }
fn bits(a: &[f64], b: &[f64]) -> bool { a.iter().zip(b).all(|(x,y)| x.to_bits()==y.to_bits()) }

pub(super) fn decode(b: &[u8], version: u32, method: u32, faces: u32, edges: u32,
    coefficients: u32, cylinders: &[CylinderDomain]) -> Result<Vec<SourceRectangleDomain>, &'static str>
{
    if version==1 {
        return if b.is_empty() && method&8==0 { Ok(Vec::new()) } else { Err("unexpected source extension") };
    }
    if b.len()<16 || method&8==0 { return Err("missing source extension"); }
    let count=u(b,0) as usize;
    if !(1..=16).contains(&count) || u(b,4)!=1376 || u(b,8)!=248 || u(b,12)!=0 ||
        b.len()!=16+1376*count || count+cylinders.len()>faces as usize ||
        coefficients<12*count as u32 || edges<4 {
        return Err("invalid source extension layout/budget");
    }
    let mut records=Vec::with_capacity(count);
    for b in b[16..].chunks_exact(1376) {
        let r=record(b)?;
        if r.source_face>=faces || cylinders.iter().any(|c|c.source_face()==r.source_face) ||
            records.iter().any(|p: &SourceRectangleDomain|p.source_face==r.source_face) {
            return Err("duplicate or foreign source face inventory index");
        }
        records.push(r);
    }
    Ok(records)
}
fn record(b: &[u8]) -> Result<SourceRectangleDomain, &'static str> {
    let axes=[u(b,8),u(b,12),u(b,16)];
    if u(b,0)!=1 || axes.iter().any(|a|*a>2) || axes[0]==axes[1] || axes[0]==axes[2] || axes[1]==axes[2] ||
        u(b,20)!=1 || u(b,24)!=0 || u(b,28)!=4 || u(b,32)!=12 || (36..48).step_by(4).any(|i|u(b,i)!=0) {
        return Err("invalid source rectangle header");
    }
    let controls=floats::<16>(b,48)?; let uk=floats::<4>(b,176)?; let vk=floats::<4>(b,208)?;
    let bounds=floats::<6>(b,240)?; let uv_hull=floats::<4>(b,288)?; let inverse=floats::<8>(b,320)?;
    let ua=axes[0] as usize; let va=axes[1] as usize; let na=axes[2] as usize;
    let expected=[uk[0],uk[3],controls[ua],controls[8+ua],vk[0],vk[3],controls[va],controls[4+va]];
    if !weights(&controls) || !knots(&uk) || !knots(&vk) || !bits(&inverse,&expected) ||
        !bits(&uv_hull,&[uk[0],vk[0],uk[3],vk[3]]) ||
        bounds[ua]>=bounds[ua+3] || bounds[va]>=bounds[va+3] || bounds[na]!=bounds[na+3] ||
        controls[ua]==controls[8+ua] || controls[va]==controls[4+va] {
        return Err("invalid source rectangle coefficient structure");
    }
    for d in 0..3 {
        if (0..4).any(|i|controls[4*i+d]<bounds[d] || controls[4*i+d]>bounds[d+3]) ||
            controls[d].min(controls[12+d])!=bounds[d] || controls[d].max(controls[12+d])!=bounds[d+3] ||
            (d==ua && (controls[d]!=controls[4+d] || controls[8+d]!=controls[12+d])) ||
            (d==va && (controls[d]!=controls[8+d] || controls[4+d]!=controls[12+d])) {
            return Err("invalid source rectangle control net");
        }
    }
    let mut boundary=Vec::with_capacity(4); let mut seen=0u32;
    for b in b[384..].chunks_exact(248) {
        let e=edge(b)?;
        if seen&(1<<e.start_corner)!=0 { return Err("duplicate rectangle boundary corner"); }
        seen|=1<<e.start_corner; boundary.push(e);
    }
    boundary_structure(&boundary,&controls,&bounds,ua,va)?;
    Ok(SourceRectangleDomain {version:1,source_face:u(b,4),axes,controls,u:uk,v:vk,bounds,uv_hull,inverse,
        edges:boundary.try_into().expect("four edges")})
}
fn edge(b: &[u8]) -> Result<SourceRectangleEdge, &'static str> {
    let flags=u(b,0); let start_corner=u(b,4); let end_corner=u(b,8);
    if flags>3 || (flags&1==0 && flags!=0) || start_corner>3 || end_corner>3 ||
        [1,3,0,2][start_corner as usize]!=end_corner || u(b,12)!=0 {
        return Err("invalid rectangle boundary header");
    }
    let controls=floats::<8>(b,16)?; let knots=floats::<4>(b,80)?; let interval=floats::<2>(b,112)?;
    let start=floats::<3>(b,128)?; let end=floats::<3>(b,152)?;
    let line_origin=floats::<3>(b,176)?; let line_axis=floats::<3>(b,200)?;
    let step=floats::<2>(b,224)?; let scale=floats::<1>(b,240)?[0];
    if !weights(&controls) || !self::knots(&knots) || interval[0]>=interval[1] ||
        interval[0]<knots[0] || interval[1]>knots[3] || start==end ||
        (flags&1!=0 && (scale<=0. || step[0]>=step[1] ||
            line_axis.iter().any(|v|![-1.,0.,1.].contains(v)) || line_axis.iter().filter(|v|**v!=0.).count()!=1)) ||
        (flags&1==0 && line_origin.iter().chain(&line_axis).chain(&step).chain([&scale]).any(|v|*v!=0.)) {
        return Err("invalid rectangle boundary coefficient structure");
    }
    Ok(SourceRectangleEdge {flags,start_corner,end_corner,controls,knots,interval,start,end,line_origin,line_axis,step,scale})
}

fn boundary_structure(edges: &[SourceRectangleEdge], controls: &[f64;16], bounds: &[f64;6], ua: usize, va: usize)
    -> Result<(), &'static str>
{
    let mut low=[f64::INFINITY;3]; let mut high=[f64::NEG_INFINITY;3];
    for e in edges {
        for p in [&e.start,&e.end] {
            for d in 0..3 {
                if p[d]<bounds[d] || p[d]>bounds[d+3] { return Err("boundary endpoint outside source support"); }
                low[d]=low[d].min(p[d]); high[d]=high[d].max(p[d]);
            }
        }
        for d in 0..3 {
            if [e.controls[d],e.controls[4+d]].iter().any(|v|*v<bounds[d] || *v>bounds[d+3]) ||
                (e.start[d]==e.end[d] && (e.controls[d]!=e.start[d] || e.controls[4+d]!=e.start[d])) {
                return Err("boundary control hull outside rectangle side/support");
            }
        }
    }
    if low[ua]>=high[ua] || low[va]>=high[va] { return Err("collapsed rectangle boundary"); }
    let corner=|p: &[f64;3]| -> Option<u32> {
        let mut code=0;
        for (a,d) in [ua,va].into_iter().enumerate() {
            if p[d]!=low[d] && p[d]!=high[d] { return None; }
            let forward=controls[if a==0 {8+d} else {4+d}]>controls[d];
            if if forward {p[d]==high[d]} else {p[d]==low[d]} { code|=1<<a; }
        }
        Some(code)
    };
    for e in edges {
        let pair=(corner(&e.start),corner(&e.end));
        if pair!=(Some(e.start_corner),Some(e.end_corner)) && pair!=(Some(e.end_corner),Some(e.start_corner)) {
            return Err("boundary endpoint/corner structure mismatch");
        }
    }
    Ok(())
}
