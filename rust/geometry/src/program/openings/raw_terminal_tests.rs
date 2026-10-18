// SPDX-License-Identifier: MPL-2.0
//! Actual RTC-selected callbacks must stop before ordinary geometry recovery.
use crate::processors::TriangulatedFaceSetProcessor;
use crate::resource::{self, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use crate::{Error, GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::{cell::Cell, rc::Rc};

#[derive(Clone, Copy)]
enum Reply { Typed, Mesh, Missing }
struct RawStop { calls: Rc<Cell<usize>>, ordinary: Rc<Cell<usize>>, reply: Reply }
impl GeometryProcessor for RawStop {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcTriangulatedFaceSet] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        self.ordinary.set(self.ordinary.get() + 1);
        TriangulatedFaceSetProcessor::new().process(entity, decoder, schema, quality)
    }
    fn process_in_rtc_frame(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality, rtc: (f64, f64, f64)) -> Option<Result<Mesh>> {
        self.calls.set(self.calls.get() + 1);
        match self.reply {
            Reply::Typed => Some(Err(Error::ProgramStopped(ProgramStop::Cancelled))),
            Reply::Mesh => {
                let mesh = TriangulatedFaceSetProcessor::new()
                    .process_in_rtc_frame(entity, decoder, schema, quality, rtc);
                resource::stop(ProgramStop::Cancelled);
                mesh
            },
            Reply::Missing => { resource::stop(ProgramStop::Cancelled); None },
        }
    }
}

#[test]
fn terminal_port_raw_selected_callback_stops_before_ordinary_recovery_or_next_item() {
    let source = "#1=IFCCARTESIANPOINTLIST3D(((5000000.,5000000.,0.),(5000001.,5000000.,0.),(5000000.,5000001.,0.)),$);
#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);
#3=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#2,#2));
#4=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#5=IFCOPENINGELEMENT('opening',$,$,$,$,$,#4,$);";
    for reply in [Reply::Typed, Reply::Mesh, Reply::Missing] {
        let calls = Rc::new(Cell::new(0));
        let ordinary = Rc::new(Cell::new(0));
        let mut router = GeometryRouter::with_rtc((5_000_000., 5_000_000., 0.));
        router.register(Box::new(RawStop { calls: calls.clone(), ordinary: ordinary.clone(), reply }));
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        account.scope(|| {
            let mut decoder = EntityDecoder::new(source);
            let opening = decoder.decode_by_id(5).unwrap();
            let result = router.get_opening_item_meshes_world(&opening, &mut decoder);
            assert!(matches!(result, Err(Error::ProgramStopped(ProgramStop::Cancelled))));
            assert_eq!(calls.get(), 1, "only the first reached raw callback runs");
            assert_eq!(ordinary.get(), 0, "terminal Option miss cannot trigger the ordinary callback");
        });
    }
}
