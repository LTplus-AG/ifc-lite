// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The [`GeometryProcessor`] trait: one IFC representation-item family in,
//! one mesh out, plus the diagnostics a processor accumulated while doing it.
//!
//! Split out of `router/mod.rs` so the drain hook below has room to carry its
//! own rationale (module-size ratchet).

use crate::tessellation::TessellationQuality;
use crate::{BoolFailure, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

/// Geometry processor trait
/// Each processor handles one type of IFC representation
pub trait GeometryProcessor {
    /// Process entity into mesh.
    ///
    /// `quality` selects tessellation detail; processors that approximate
    /// curves derive their segment counts from it via
    /// [`crate::tessellation::scale_segments`]. Processors with no curved
    /// geometry ignore it. [`TessellationQuality::Medium`] reproduces the
    /// engine's historical hardcoded behavior.
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh>;

    /// Process a raw-coordinate item in an element-local RTC frame.
    ///
    /// `rtc_file_units` is the relative-to-center offset in the file's own
    /// length unit, already expressed in the item's coordinate frame; a
    /// processor that reads its coordinates as `f64` subtracts it BEFORE
    /// narrowing to `f32`, returns the rebased mesh and sets
    /// `Mesh::rtc_applied`. Default `None`: the processor has no such hook,
    /// and the router falls back to [`Self::process`], leaving RTC to the
    /// final f64 world transform — which cannot recover detail its f32 output
    /// already lost at national-grid magnitudes (#5026 review). Every
    /// built-in raw-coordinate processor implements this (faces, faceted
    /// Brep, tessellated face sets and surface models, #5698); a registered
    /// override that handles large coordinates must too.
    fn process_in_rtc_frame(
        &self,
        _entity: &DecodedEntity,
        _decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
        _rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        None
    }

    /// Get supported IFC types
    fn supported_types(&self) -> Vec<IfcType>;

    /// Drain the boolean / CSG failures this processor recorded while meshing.
    ///
    /// Default: none — most processors record nothing. Overridden by
    /// [`crate::processors::BooleanClippingProcessor`], whose failure log had
    /// no route out of the router at all before #3821: `take_failures` was
    /// called from tests only, so an unsupported operand, an
    /// `EmptyOperand` cutter and an unknown operator were recorded into a
    /// buffer that nothing ever read, and the pipeline reported a clean load.
    ///
    /// Drained by `GeometryRouter::drain_processor_failures`, which
    /// `take_csg_failures` calls, so every consumer of the router's CSG
    /// diagnostics — the native pipeline and the wasm batch path alike — sees
    /// these without a second opt-in.
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        Vec::new()
    }

    /// Number of `BoolFailure` records currently buffered (without draining).
    /// #4083 (double-count half): lets [`crate::GeometryRouter::process_representation_item`]
    /// snapshot a before/after delta around ONE item's uncached build, so a CSG
    /// diagnostic can be attributed to that item's `item_dedup_key`. Default:
    /// 0 — matches [`Self::take_bool_failures`]'s "most processors record
    /// nothing" default. Overridden by
    /// [`crate::processors::BooleanClippingProcessor`].
    fn bool_failure_count(&self) -> usize {
        0
    }

    /// Discard every `BoolFailure` recorded after index `since` (a prior
    /// [`Self::bool_failure_count`]). #4083 (double-count half): the router
    /// calls this when a racing sibling router already claimed this item's
    /// `item_dedup_key` for its own diagnostic, so THIS router's redundant
    /// record of the same logical operation never reaches
    /// [`Self::take_bool_failures`]. Default: no-op, matching the 0 default
    /// above (nothing buffered, nothing to discard).
    fn truncate_bool_failures_to(&self, _since: usize) {}
}

// The RTC-hook regression lives beside the trait on purpose: a test-only
// override implementing `process_in_rtc_frame` cannot compile against a tree
// where the hook does not exist, so a whole-file production revert (the CI
// revert oracle) must take this test with it rather than break the build.
#[cfg(test)]
mod rtc_hook_tests {
    use super::GeometryProcessor;
    use crate::router::structural_tests::surface_member;
    use crate::router::GeometryRouter;
    use crate::{Mesh, Result, TessellationQuality};
    use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

    /// An override that reads its coordinates in f64 and rebases through the
    /// router's RTC hook, so sub-ULP detail at national-grid magnitude survives.
    struct RtcAwareFace;

    impl GeometryProcessor for RtcAwareFace {
        fn process(
            &self,
            entity: &DecodedEntity,
            decoder: &mut EntityDecoder,
            schema: &IfcSchema,
            quality: TessellationQuality,
        ) -> Result<Mesh> {
            crate::router::structural_tests::RegisteredFace
                .process(entity, decoder, schema, quality)
        }

        fn process_in_rtc_frame(
            &self,
            _entity: &DecodedEntity,
            _decoder: &mut EntityDecoder,
            _schema: &IfcSchema,
            _quality: TessellationQuality,
            rtc_file_units: (f64, f64, f64),
        ) -> Option<Result<Mesh>> {
            // A 0.125 m triangle at (5,000,000 + 0.0625, 5,000,000): only
            // representable once the offset is removed in f64.
            let corners: [[f64; 3]; 3] = [
                [5_000_000.062_5, 5_000_000.0, 0.0],
                [5_000_000.187_5, 5_000_000.0, 0.0],
                [5_000_000.062_5, 5_000_000.125, 0.0],
            ];
            let mut mesh = Mesh::new();
            for corner in corners {
                mesh.positions.push((corner[0] - rtc_file_units.0) as f32);
                mesh.positions.push((corner[1] - rtc_file_units.1) as f32);
                mesh.positions.push((corner[2] - rtc_file_units.2) as f32);
            }
            mesh.indices = vec![0, 1, 2];
            mesh.rtc_applied = true;
            Some(Ok(mesh))
        }

        fn supported_types(&self) -> Vec<IfcType> {
            vec![IfcType::IfcFaceSurface, IfcType::IfcAdvancedFace]
        }
    }

    #[test]
    fn registered_face_override_rebases_in_f64_through_the_rtc_hook() {
        let source = format!(
        "{}{}",
        surface_member(true, false)
            .replace("(0.,0.,0.)", "(5000000.,5000000.,0.)")
            .replace("(10.,0.,0.)", "(5000001.,5000000.,0.)")
            .replace("(10.,10.,0.)", "(5000001.,5000001.,0.)")
            .replace("(0.,10.,0.)", "(5000000.,5000001.,0.)")
            .replace("$,$,#17", "$,#33,#17"),
        "#30=IFCCARTESIANPOINT((0.,0.,0.));#31=IFCDIRECTION((0.,0.,1.));         #32=IFCDIRECTION((0.,1.,0.));#34=IFCAXIS2PLACEMENT3D(#30,#31,#32);         #33=IFCLOCALPLACEMENT($,#34);"
    );
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(18).unwrap();
        let mut router = GeometryRouter::with_rtc((-5_000_000.0, 5_000_000.0, 0.0));
        router.register(Box::new(RtcAwareFace));
        let mesh = router.process_element(&entity, &mut decoder).unwrap();

        // The narrowing to f32 happened AFTER the rebase, so the 0.125 m extent
        // survives (a plain `process` override would have collapsed all three
        // corners onto 5,000,000.0 and the router could only subtract from that).
        let xs: Vec<f32> = mesh.positions.chunks_exact(3).map(|p| p[0]).collect();
        let ys: Vec<f32> = mesh.positions.chunks_exact(3).map(|p| p[1]).collect();
        assert!(
            (xs.iter().cloned().fold(f32::MIN, f32::max)
                - xs.iter().cloned().fold(f32::MAX, f32::min)
                - 0.125)
                .abs()
                < 1e-6
                || (ys.iter().cloned().fold(f32::MIN, f32::max)
                    - ys.iter().cloned().fold(f32::MAX, f32::min)
                    - 0.125)
                    .abs()
                    < 1e-6,
            "sub-ULP extent must survive an RTC-aware override: {:?}",
            mesh.positions
        );
        assert_eq!(mesh.indices, vec![0, 1, 2]);
    }
}
