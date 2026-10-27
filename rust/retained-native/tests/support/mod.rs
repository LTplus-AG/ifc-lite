// SPDX-License-Identifier: MPL-2.0
#![allow(dead_code)]
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use ifc_lite_retained_native::{block_on, run_model_native};
use std::{cell::Cell, rc::Rc};
pub const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCAXIS2PLACEMENT3D(#8,$,$);#8=IFCCARTESIANPOINT((10.,20.,30.));
#9=IFCLOCALPLACEMENT($,#7);#10=IFCWALL('w',$,'Wall',$,$,#9,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#15=IFCDIRECTION((0.,0.,1.));
#17=IFCAXIS2PLACEMENT3D(#18,$,$);#18=IFCCARTESIANPOINT((-4.,3.,2.));
#19=IFCLOCALPLACEMENT($,#17);#20=IFCSLAB('s',$,'Slab',$,$,#19,#21,$,.FLOOR.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));
#23=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5);
#50=IFCALIGNMENT('a',$,'Road',$,$,$,$,#53);
#51=IFCCARTESIANPOINT((0.,0.,0.));#52=IFCCARTESIANPOINT((10.,0.,0.));#53=IFCPOLYLINE((#51,#52));
#60=IFCBOILERTYPE('t',$,'Library',$,$,$,(#61,#71),$,$,.NOTDEFINED.);
#61=IFCREPRESENTATIONMAP(#7,#12);#71=IFCREPRESENTATIONMAP(#17,#22);
ENDSEC;END-ISO-10303-21;";
pub const BOX: &str =
    include_str!("../../../../tests/fixtures/synthetic-retained/f-c-extrusion.ifc");
#[derive(Clone)]
pub struct Domain(pub Rc<Cell<bool>>);
impl ReceiptDomain for Domain {
    fn incarnation(&self) -> Option<u64> {
        self.0.get().then_some(1)
    }
    fn retire(&self) {
        self.0.set(false);
    }
    fn same_domain(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}
pub enum Never {}
impl NumericalReceipt for Never {
    type Object = ();
    type Domain = Domain;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 {
        0
    }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> {
        match *self {}
    }
    fn object(&self) {
        match *self {}
    }
    fn evidence(&self) -> ReceiptEvidence<'_, ()> {
        match *self {}
    }
    fn domain(&self) -> &Domain {
        match *self {}
    }
    fn validate_live(&self) -> Result<(), RuntimeFault> {
        match *self {}
    }
}
pub struct Peer {
    pub domain: Domain,
    pub suspend: bool,
    pub contract: bool,
    pub calls: Rc<Cell<usize>>,
}
impl RetainedRuntime for Peer {
    type Receipt = Never;
    fn domain(&self) -> Domain {
        self.domain.clone()
    }
    fn incarnation(&self) -> u64 {
        // Match SmlibWorker: retirement invalidates both the domain and the
        // incarnation passed into GeometryDocument::prepare_retained.
        self.domain.incarnation().unwrap_or(0)
    }
}
impl AsyncRetainedExecutor for Peer {
    async fn invoke(
        &mut self,
        call: Invocation<'_, Never>,
        _: NumericalLimits,
    ) -> Result<Never, RuntimeFault> {
        assert!(matches!(call, Invocation::Construction(_)));
        assert!(
            ifc_lite_geometry::resource::current_account().is_none(),
            "resource scope crossed await"
        );
        self.calls.set(self.calls.get() + 1);
        if self.suspend {
            std::future::pending::<()>().await;
        }
        if self.contract {
            return Err(RuntimeFault::contract("inert contract refusal"));
        }
        Err(RuntimeFault::transport("inert peer closed"))
    }
}
pub fn peer() -> Peer {
    Peer {
        domain: Domain(Rc::new(Cell::new(true))),
        suspend: false,
        contract: false,
        calls: Rc::new(Cell::new(0)),
    }
}
pub fn inert(text: &str, options: &ModelOptions) -> (ModelSummary, Vec<ProductOutcome>) {
    let mut outcomes = Vec::new();
    let summary = block_on(run_model(
        SourceBundle::new(text.as_bytes().to_vec()),
        options,
        || Ok(peer()),
        |o| outcomes.push(o),
    ))
    .unwrap();
    (summary, outcomes)
}
pub fn native(text: &str) -> Option<Vec<ProductOutcome>> {
    let worker = worker_path()?;
    let mut outcomes = Vec::new();
    run_model_native(
        SourceBundle::new(text.as_bytes().to_vec()),
        std::path::Path::new(&worker),
        &ModelOptions::default(),
        |o| outcomes.push(o),
    )
    .unwrap();
    Some(outcomes)
}
pub fn shape(outcomes: &[ProductOutcome], id: u32) -> &ShapeOnlyProduct {
    outcomes
        .iter()
        .find_map(|o| match o {
            ProductOutcome::Published(s) if s.product_id == id => Some(s),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing {id}: {outcomes:?}"))
}
pub fn refusal(outcomes: &[ProductOutcome], id: u32) -> RetainedProductRefusal {
    outcomes
        .iter()
        .find_map(|o| match o {
            ProductOutcome::Refused {
                product_id,
                refusal,
                ..
            } if *product_id == id => Some(*refusal),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing refusal {id}: {outcomes:?}"))
}

pub fn worker_path() -> Option<std::ffi::OsString> {
    let path = std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(
            std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(),
            "real SMLib is required but IFCLITE_SMLIB_WORKER is unset"
        );
        eprintln!("SKIP real retained executor: set IFCLITE_SMLIB_WORKER");
    }
    path
}
