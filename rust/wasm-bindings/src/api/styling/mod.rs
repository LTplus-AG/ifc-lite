// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Styling, color extraction, and building rotation for IFC-Lite API

mod color;
mod prepass;

pub(crate) use color::resolve_element_color;
pub(crate) use prepass::{
    build_instantiated_type_ids, build_instantiated_type_ids_from_spans,
    build_mapped_instance_plan_from_spans, build_referenced_representation_maps,
    build_referenced_representation_maps_from_spans, collect_type_geometry_jobs_from_spans, combined_pre_pass,
};
