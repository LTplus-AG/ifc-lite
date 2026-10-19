// SPDX-License-Identifier: MPL-2.0
//! Contract-disjoint styled values in the canonical submesh walk.
use crate::{resource, Result, SubMeshCollection};
use crate::program::retained::{LogicalRetainedValue, RetainedPlacementStage};
use crate::program::retained_presentation::RetainedPresentation;
use super::values::MappedValues;
use nalgebra::Matrix4;

pub(crate) enum StyledValues { Mesh(SubMeshCollection), Retained(Vec<LogicalRetainedValue>) }
impl Default for StyledValues { fn default() -> Self { Self::Mesh(SubMeshCollection::new()) } }
impl StyledValues {
    pub(super) fn new(retained: bool) -> Self { if retained { Self::Retained(Vec::new()) } else { Self::default() } }
    pub(super) fn len(&self) -> usize { match self {Self::Mesh(v)=>v.len(),Self::Retained(v)=>v.len()} }
    pub(super) fn take(&mut self) -> Self { let empty=Self::new(matches!(self,Self::Retained(_))); std::mem::replace(self,empty) }
    pub(super) fn nonempty(&self,start:usize) -> bool {match self {
        Self::Mesh(v)=>v.sub_meshes[start..].iter().any(|s|!s.mesh.is_empty()),
        Self::Retained(v)=>!v[start..].is_empty(),
    }}
    pub(super) fn append(mut self, incoming: Self, rtc: Option<(f64,f64,f64)>) -> Result<Self> {
        resource::check_current()?;
        match (&mut self,incoming) {
            (Self::Mesh(v), Self::Mesh(mut incoming))=> {
                if let Some(rtc)=rtc {for sub in &mut incoming.sub_meshes {super::keep_rebase_in_origin(&mut sub.mesh,rtc)}}
                resource::reserve_headers(&mut v.sub_meshes,incoming.len())?.retain();
                v.sub_meshes.append(&mut incoming.sub_meshes);
            }
            (Self::Retained(v), Self::Retained(mut incoming))=> {
                resource::charge(resource::Cost {work:incoming.len() as u64,..Default::default()})?.retain();
                resource::reserve_headers(v,incoming.len())?.retain(); v.append(&mut incoming);
            }
            _=>return Err(crate::Error::geometry("styled mapped contract mismatch")),
        }
        resource::check_current()?; Ok(self)
    }
    pub(super) fn retained_range(&mut self,start:usize,transform:Option<Matrix4<f64>>,
        program:u64,source:u32,binding:Option<RetainedPresentation>) -> Result<()> {
        let Self::Retained(values)=self else {return Err(crate::Error::geometry("retained range requires retained values"))};
        // Replace each edge independently. No global id deduplication and no SDK
        // receipt cloning; admission precedes every output occurrence/history.
        for value in &mut values[start..] {
            value.place_in_place(&transform.unwrap_or_else(Matrix4::identity),program,
                RetainedPlacementStage::Mapping {source_id:source})?;
            if let Some(binding)=&binding {value.present(binding.clone())?;}
        }
        Ok(())
    }
    pub(super) fn from_parts(parts:MappedValues)->Result<Self> { match parts {
        MappedValues::Retained(v)=>Ok(Self::Retained(v)),
        _=>Err(crate::Error::geometry("retained placeholder requires source definitions")),
    }}
}
