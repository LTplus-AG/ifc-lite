// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Length-unit admission for the router (#7678, CORE-15).
//!
//! A declared conversion-based length unit whose factor is not a positive
//! finite number (`IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.E400),…)`) has no
//! right metre scale: meshing against `1.0` draws the model at the wrong size
//! with nothing to show for it, and against `inf` draws non-finite vertices.
//! The router refuses instead. A refused router hands out no processor, so
//! every item it is asked for meshes nothing and is recorded as unsupported,
//! whichever entry point (element, item, mapped source, alignment) asked.
//!
//! `ifc_lite_core::LengthUnit` is the one home of the policy; this module only
//! applies it to the router's own scale.

use ifc_lite_core::{EntityDecoder, IfcType};
use std::rc::Rc;

use super::{GeometryProcessor, GeometryRouter};

impl GeometryRouter {
    /// Set the length scale, refusing one no geometry may be meshed with: a
    /// non-finite or non-positive scale (a refused unit's `NaN` on the wasm
    /// wire, or an overflowing factor's infinity) refuses the router.
    pub(super) fn set_unit_scale(&mut self, unit_scale: f64) {
        self.execution_owner.changed();
        if unit_scale.is_finite() && unit_scale > 0.0 {
            self.unit_scale = unit_scale;
        } else {
            self.unit_scale = 1.0;
            self.length_unit_refused = true;
        }
    }

    /// Refuse to mesh: the model's length unit is unusable (#7678). Callers
    /// that resolve units themselves (`UnitScales::length_unit_refused`,
    /// `StreamMeta::length_unit_refused`) call this on every router they build.
    pub fn refuse_length_unit(&mut self) {
        self.execution_owner.changed();
        self.length_unit_refused = true;
    }

    /// Whether this router refuses to mesh because the length unit is unusable.
    pub fn length_unit_refused(&self) -> bool {
        self.length_unit_refused
    }

    /// Refuse a scaled placement when the length unit is refused: its
    /// translation would read file units as metres, a plausible but wrong
    /// position (export rows, site transform, overlays), where main gave
    /// infinity (#7678).
    pub(super) fn admit_placement_scale(&self) -> crate::Result<()> {
        if self.length_unit_refused {
            return Err(crate::Error::geometry("length unit refused (#7678): no scaled placement"));
        }
        Ok(())
    }

    /// The processor for `ifc_type`, or none when the length unit is refused.
    /// Every registry lookup in the router goes through this.
    pub(crate) fn processor_for(&self, ifc_type: &IfcType) -> Option<&Rc<dyn GeometryProcessor>> {
        if self.length_unit_refused {
            return None;
        }
        self.processors.get(ifc_type, self.schema)
    }

    /// Resolve the first `IFCPROJECT`'s length-unit scale (e.g. `0.001` for
    /// millimetres → metres); `1.0` if none is found. The project comes from
    /// the decoder's cached locator, not a scan of `content`. An unusable
    /// declared factor answers `NaN`, which [`Self::set_unit_scale`] refuses,
    /// and a strict (geometry) decoder counts it.
    pub(super) fn project_unit_scale(decoder: &mut EntityDecoder) -> f64 {
        if let Some(id) = decoder.project_id() {
            if let Ok(unit) = ifc_lite_core::resolve_length_unit(decoder, id) {
                return match unit.unusable_factor {
                    Some(factor) => {
                        if decoder.strict_reals() {
                            let _counted = decoder.refuse_record(factor);
                        }
                        f64::NAN
                    }
                    None => unit.scale,
                };
            }
        }
        1.0
    }
}
