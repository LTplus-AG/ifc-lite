// SPDX-License-Identifier: MPL-2.0
//! Independent source oracles for diagnostic harnesses, not production geometry.
pub mod affine;
mod affine_classify;
mod affine_operator;
mod clipping;
pub mod convex;
pub mod retrace;
pub mod inventory;
mod math;
pub mod openings;
pub mod mapped;
mod prism;
pub mod quantities;

pub mod sections;
mod section_net;
mod sections_source;
pub mod layers;
mod layer_sector;
pub mod clips;
pub mod bounded;
pub mod type_maps;
pub mod faces;
pub mod face_sets;
pub mod face_set_closure;
pub mod face_set_zero_rows;
pub mod face_bands;
pub mod normals;
mod bounded_source;
mod bounded_partition;
mod bounded_trim;
mod bounded_curved;
