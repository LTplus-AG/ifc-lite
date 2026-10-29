// SPDX-License-Identifier: MPL-2.0
//! Independent source oracles for diagnostic harnesses, not production geometry.
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
mod sections_source;
pub mod layers;
pub mod clips;
pub mod bounded;
pub mod type_maps;
pub mod faces;
pub mod face_bands;
