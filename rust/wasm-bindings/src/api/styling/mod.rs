// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Styling, color extraction, and building rotation for IFC-Lite API

mod color;
mod prepass;

pub(crate) use color::resolve_element_color;
pub(crate) use prepass::{
    build_instantiated_type_ids, build_referenced_representation_maps, collect_type_geometry_jobs,
    combined_pre_pass, extract_building_rotation_from_site,
};
