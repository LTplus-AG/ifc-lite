// SPDX-License-Identifier: MPL-2.0
//! Contract-disjoint values in the existing merged walk. No SDK ownership.
use crate::{Mesh, Result};
use crate::program::retained::{LogicalRetainedValue, copy_values};
use crate::router::frame_parts::SourceParts;

pub(crate) enum MappedValues { Mesh(Vec<Mesh>), Retained(Vec<LogicalRetainedValue>) }
pub(crate) enum Accumulator { Mesh(SourceParts), Retained(Vec<LogicalRetainedValue>) }
impl Default for Accumulator { fn default() -> Self { Self::Mesh(SourceParts::default()) } }
impl Accumulator {
    pub(super) fn new(retained: bool) -> Self {
        if retained { Self::Retained(Vec::new()) } else { Self::default() }
    }
    pub(super) fn merge(mut self, incoming: MappedValues, rtc: Option<(f64,f64,f64)>) -> Result<Self> {
        crate::resource::check_current()?;
        match (&mut self, incoming) {
            (Self::Mesh(parts), MappedValues::Mesh(incoming)) => for mut mesh in incoming {
                if let Some(rtc) = rtc { super::keep_rebase_in_origin(&mut mesh, rtc); }
                parts.merge(&mesh);
                crate::resource::check_current()?;
            },
            (Self::Retained(parts), MappedValues::Retained(mut incoming)) => {
                crate::resource::charge(crate::resource::Cost { work: incoming.len() as u64,
                    ..Default::default() })?.retain();
                crate::resource::reserve_headers(parts, incoming.len())?.retain();
                parts.append(&mut incoming);
            }
            _ => return Err(crate::Error::geometry("mapped value contract mismatch")),
        }
        Ok(self)
    }
    pub(super) fn finish(self) -> Result<MappedValues> {
        crate::resource::check_current()?;
        let values=match self { Self::Mesh(parts) => MappedValues::Mesh(parts.into_parts()),
            Self::Retained(values) => MappedValues::Retained(values) };
        // SourceParts preserves its historical infallible API and records a
        // header reservation stop before returning an empty Vec. Detached Ready
        // completion must propagate that stop, not report a successful empty.
        crate::resource::check_current()?;
        Ok(values)
    }
}
pub(crate) type SharedRetainedCache = std::sync::Arc<std::sync::Mutex<RetainedCache>>;

/// Source-local templates, scoped to one validated walk/decoder/router owner.
/// Never populated from the exact mesh cache or shared across source revisions.
#[derive(Default)]
pub(crate) struct RetainedCache {
    entries: Vec<(u32,Vec<LogicalRetainedValue>)>,
    styled_entries: Vec<(u32,Vec<LogicalRetainedValue>)>,
    pub(super) styled_claims: std::sync::Arc<std::sync::Mutex<Vec<u32>>>,
    provenance: Option<(ifc_lite_core::execution_owner::ExecutionIdentity,
        ifc_lite_core::execution_owner::ExecutionIdentity, crate::program::retained::RetainedContract)>,
}
impl RetainedCache {
    pub(super) fn admit(&mut self,router:&crate::GeometryRouter,
        decoder:&ifc_lite_core::EntityDecoder<'_>,contract:crate::program::retained::RetainedContract) -> Result<()> {
        let current=(router.execution_identity(),decoder.execution_identity(),contract);
        match self.provenance {
            Some(original) if original!=current=>Err(crate::Error::geometry("stale retained cache source/configuration provenance")),
            Some(_)=>Ok(()),
            None=>{self.provenance=Some(current);Ok(())}
        }
    }
    pub(crate) fn get(&self, id: u32) -> Result<Option<Vec<LogicalRetainedValue>>> {
        for (key,values) in &self.entries {
            crate::resource::charge(crate::resource::Cost {work:1,..Default::default()})?.retain();
            if *key==id {return copy_values(values).map(Some)}
        }
        Ok(None)
    }
    pub(crate) fn get_styled(&self, id: u32) -> Result<Option<Vec<LogicalRetainedValue>>> {
        for (key,values) in &self.styled_entries {
            crate::resource::charge(crate::resource::Cost {work:1,..Default::default()})?.retain();
            if *key==id {return copy_values(values).map(Some)}
        }
        Ok(None)
    }
    pub(super) fn publish(&mut self, id: u32, values: &[LogicalRetainedValue]) -> Result<()> {
        for (key,_) in &self.entries {
            crate::resource::charge(crate::resource::Cost {work:1,..Default::default()})?.retain();
            if *key==id {return Ok(())}
        }
        let values = copy_values(values)?;
        crate::resource::reserve_headers(&mut self.entries, 1)?.retain();
        self.entries.push((id, values));
        Ok(())
    }
    pub(super) fn publish_styled(&mut self, id: u32, values: &[LogicalRetainedValue]) -> Result<()> {
        for (key,_) in &self.styled_entries {
            crate::resource::charge(crate::resource::Cost {work:1,..Default::default()})?.retain();
            if *key==id {return Ok(())}
        }
        let values = copy_values(values)?;
        crate::resource::reserve_headers(&mut self.styled_entries, 1)?.retain();
        self.styled_entries.push((id, values));
        Ok(())
    }
}
