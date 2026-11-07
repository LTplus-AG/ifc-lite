// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Styling, color extraction, and building rotation for IFC-Lite API

mod prepass;

pub(crate) use ifc_lite_processing::style::resolve_element_color;
pub(crate) use prepass::combined_pre_pass;
