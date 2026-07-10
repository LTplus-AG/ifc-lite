//! Validation crate for the Plato-generated clash math.
//!
//! - `plato`: the generated file, verbatim.
//! - `reference`: verbatim copies of the hand-written vec3/aabb/triangle modules
//!   (only the `use crate::vec3` module path was rewritten to compile standalone).
//! - `adapter`: the reference API shapes ([f64; 3], Aabb) implemented ONLY via `plato`.

pub mod adapter;
pub mod plato;
pub mod reference;
