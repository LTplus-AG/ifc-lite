// SPDX-License-Identifier: MPL-2.0
//! An unwind out of a product's work restores the caller's exact-work budget
//! and degenerate tally and releases both owners. Pending-report delivery on
//! unwind is the `PendingDiagnosticState` contract the session installs; its
//! thread-local channels have no producer or reader outside the geometry
//! crate, which pins it in `pending_diagnostics_tests.rs`
//! (`error_and_panic_retain_work_evidence_and_restore_the_callers_reports`).
use super::session_tests::{assert_same, canonical, leaked_job, options, router, Context, SOURCE};
use super::*;
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::kernel::budget;
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::{cell::Cell, rc::Rc};

fn collapsed_mesh() -> Mesh {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0., 0., 0., 1., 0., 0., 1., 0., 0.];
    mesh.normals = vec![0., 0., 1., 0., 0., 1., 0., 0., 1.];
    mesh.indices = vec![0, 1, 2];
    mesh
}

struct Interrupted {
    panic: Rc<Cell<bool>>,
}
impl GeometryProcessor for Interrupted {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> ifc_lite_geometry::Result<Mesh> {
        if self.panic.get() {
            // Product-owned effects, all reached inside its work epoch.
            for _ in 0..5 {
                budget::note_escalation();
            }
            degenerate::clean(&mut collapsed_mesh());
            panic!("registered constructor interrupted after reaching product state");
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}

#[test]
fn unwind_restores_the_callers_budget_and_degenerate_tally_and_releases_owners() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = router(&mut decoder);
    let panic = Rc::new(Cell::new(true));
    router.register(Box::new(Interrupted { panic: panic.clone() }));
    // Ambient caller state: its own budget and one dropped triangle.
    let _budget = budget::enter_element();
    let _degenerate = degenerate::begin_element();
    for _ in 0..3 {
        budget::note_escalation();
    }
    degenerate::clean(&mut collapsed_mesh());
    let (ambient_budget, ambient_dropped) = (budget::element_count(), degenerate::dropped_this_element());
    assert_eq!((ambient_budget, ambient_dropped), (3, 1));

    let job = leaked_job(&mut decoder, 10);
    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router)
    }));
    assert!(unwound.is_err(), "the real constructor panic reaches the caller");
    assert_eq!(budget::element_count(), ambient_budget, "the product's escalations never reach the caller budget");
    assert_eq!(degenerate::dropped_this_element(), ambient_dropped, "the product's dropped triangle stays its own");
    assert!(decoder.try_execution_lease().is_ok() && router.try_execution_lease().is_ok());

    // The same warm owners produce the canonical product afterwards.
    panic.set(false);
    let produced = produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router);
    assert_same(&produced, &canonical(10, false));
    assert_eq!(budget::element_count(), ambient_budget);
}
