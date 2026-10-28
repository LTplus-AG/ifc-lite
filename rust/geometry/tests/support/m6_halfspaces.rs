// SPDX-License-Identifier: MPL-2.0
//! #7955 M6 logical plans; no kernel substitute or numerical publication.
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{document::{RetainedPrism, RetainedRecipe, PrismSegment},
    program::transactions::{Traversal, OperationKind, TransactionError, TransactionFailureKind}, GeometryRouter};
pub const SOURCE: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
#[derive(Debug, Default)]
pub struct Trace { pub prisms: Vec<RetainedPrism>, pub order: Vec<&'static str>, pub frame: Option<[f64;16]>, pub bounds: Option<[f64;6]> }
pub fn walk(text: &str, id: u32) -> (Trace, Result<(), TransactionError>) {
    let source=SourceBundle::new(text.as_bytes().to_vec()); let mut decoder=source.decoder();
    let router=GeometryRouter::with_units(text,&mut decoder); let wall=decoder.decode_by_id(id).unwrap();
    let traversal=Traversal::new(1,1); let mut program=traversal.product_parts(&wall); let mut trace=Trace::default();
    let result=(|| {
        while let Some(ticket)=program.request()? {
            let (reply,operations,_)=program.admit(ticket,&router,&mut decoder)?;
            for op in operations {
                match op.kind() {
                    OperationKind::Construction(RetainedRecipe::Prism(p)) => {trace.prisms.push(p.clone());trace.order.push("prism");},
                    OperationKind::Construction(_) => {trace.order.push("host");trace.frame=Some(*op.value().object_frame());trace.bounds=Some(op.value().evaluation_bounds().unwrap().0);},
                    OperationKind::Boolean{..} => trace.order.push("difference"),
                    _ => panic!("unexpected affine"),
                }
                op.bind_numerical_outcome(false).unwrap();
            }
            program.accept(reply,&router).map_err(|e|e.error)?;
        }
        assert_eq!(program.finish()?.values().len(),1); Ok(())
    })();
    (trace,result)
}
