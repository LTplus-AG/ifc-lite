// SPDX-License-Identifier: MPL-2.0
//! #7781: state shared by coaxial, batched and sequential exact passes.
use crate::Mesh;
use rustc_hash::FxHashMap;
mod batch_plan;
mod batch;

pub(in crate::router::voids) struct ExactTail {
    pub consumed: Vec<bool>,
    pub groups: Vec<Vec<(usize, Mesh)>>,
    pub group_of: FxHashMap<usize, usize>,
    /// Admission-time cutters are reusable only before the first host mutation.
    pub host_mutated: bool,
}

impl ExactTail {
    pub(in crate::router::voids) fn new(opening_count: usize) -> Self {
        Self {
            consumed: vec![false; opening_count],
            groups: Vec::new(),
            group_of: FxHashMap::default(),
            host_mutated: false,
        }
    }
}
