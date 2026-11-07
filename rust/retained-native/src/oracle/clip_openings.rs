// SPDX-License-Identifier: MPL-2.0
//! Section-volume inclusion/exclusion for convex polygonal opening extrusions.
use super::*;
use crate::oracle::section_net;
use ifc_lite_core::EntityScanner;
use ifc_lite_processing::prepass::{resolve_prepass,PrepassSpans,ResolveOptions};
use section_net::ConvexCut;

pub(super) fn index(model: &Arc<SourceBundle>) -> std::collections::BTreeMap<u32, Vec<u32>> {
    let mut scanner=EntityScanner::new(model.bytes());let mut spans=PrepassSpans::default();
    while let Some((id,name,start,end))=scanner.next_entity(){spans.stash(name,id,start,end);}
    resolve_prepass(&spans,&mut model.decoder(),ResolveOptions::default()).void_index.into_iter().collect()
}
/// Also whether an opening's arc was polygonised, so its result is judged as curved.
pub(super) fn cutters(model: &Arc<SourceBundle>, sources: &AnalyticQuantitySources, ids: &[u32])
    -> Result<(Vec<Vec<ConvexCut>>,bool),String> {
    let mut decoder=model.decoder();
    let router=ifc_lite_geometry::GeometryRouter::with_scale(sources.extrusion_definitions.length_unit_scale);
    let mut result=Vec::new();let mut curved=false;
    for id in ids {
        if !router.opening_requires_subtraction(*id,&mut decoder){continue;}
        let parts=source_parts(model,sources,*id)?;
        if parts.is_empty(){return Err("opening has no analytic parts".into());}
        for part in parts {
            if part.mixed{return Err("mixed solid opening requires a different source oracle".into());}
            let host=part.host.ok_or("opening extrusion unavailable")?;
            let (pieces,arcs)=section_net::extrusion_cutters(&host).ok_or("opening must be a single-loop extrusion")?;
            curved|=arcs;
            result.push(pieces.into_iter().map(|mut cut|{cut.extend(part.planes.iter().map(Plane::equation));cut}).collect());
        }
    }
    Ok((result,curved))
}
pub(super) fn net_volume(host:&ExtrudedHost,clips:&[Plane],cuts:&[Vec<ConvexCut>])->Option<f64>{
    section_net::net_volume(host,&clips.iter().map(Plane::equation).collect::<Vec<_>>(),cuts)
}
