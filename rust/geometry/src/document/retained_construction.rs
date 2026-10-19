// SPDX-License-Identifier: MPL-2.0
//! One owned request boundary for supported authored construction families.
use super::{retained_sweep::{self, SweepPayload}, RetainedExtrusion, RetainedRefusal};
use crate::analytic::AnalyticSweptDisk;

#[derive(Debug, Clone)]
pub struct RetainedSweptDisk {
    pub solid_id: u32,
    pub source: AnalyticSweptDisk,
    pub length_unit_scale: f64,
    pub source_epoch: u64,
    pub source_revision: u64,
}
#[derive(Debug, Clone)]
pub enum RetainedConstruction {
    Extrusion(Box<RetainedExtrusion>),
    SweptDisk(Box<RetainedSweptDisk>),
}
impl RetainedConstruction {
    pub fn extrusion(&self) -> Option<&RetainedExtrusion> {
        match self { Self::Extrusion(value) => Some(value), _ => None }
    }
    pub fn lower(&self) -> Result<SweepPayload, RetainedRefusal> {
        match self {
            Self::Extrusion(value) => retained_sweep::lower(value),
            Self::SweptDisk(value) => super::retained_disk::lower(value),
        }
    }
    pub fn solid_id(&self) -> u32 {
        match self { Self::Extrusion(v) => v.source.solid_id, Self::SweptDisk(v) => v.solid_id }
    }
    pub(super) fn revision(&self) -> (u64, u64) {
        match self {
            Self::Extrusion(v) => (v.source_epoch, v.source_revision),
            Self::SweptDisk(v) => (v.source_epoch, v.source_revision),
        }
    }
}
