// SPDX-License-Identifier: MPL-2.0
//! The common item program: selected callbacks, linear tickets and owners.
use super::*;
use crate::processors::{BlockProcessor, TriangulatedFaceSetProcessor};
use crate::program::OwnedConstructor;
use crate::{GeometryProcessor, TessellationQuality};
use ifc_lite_core::{IfcSchema, IfcType};
use std::{cell::RefCell, rc::Rc};

const BLOCK: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#10=IFCBLOCK(#2,1.,2.,3.);";
const SURVEY_FACES: &str = "#1=IFCCARTESIANPOINTLIST3D(((5000000.,0.,0.),(5000001.,0.,0.),(5000000.,1.,0.)),$);\
    #2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);";

fn drain(program: &mut GeometryProgram, router: &GeometryRouter, decoder: &mut EntityDecoder) {
    while let Some(request) = program.request().unwrap() {
        let reply = program.execute(request, router, decoder).unwrap();
        program.accept(reply, router).ok().unwrap();
    }
}

/// Run until the next request at `stage`, leaving it outstanding.
fn advance_to(program: &mut GeometryProgram, stage: ProgramStage, router: &GeometryRouter,
    decoder: &mut EntityDecoder) -> ProgramRequest {
    loop {
        let request = program.request().unwrap().expect("stage before completion");
        if request.stage() == stage {
            return request;
        }
        let reply = program.execute(request, router, decoder).unwrap();
        program.accept(reply, router).ok().unwrap();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Call { Lower(bool), RtcHook, Process }

/// A registered face set that records each callback the router selects.
struct Recording { calls: Rc<RefCell<Vec<Call>>>, lowers_rtc: bool, panics: bool }
impl GeometryProcessor for Recording {
    fn process(&self, item: &DecodedEntity, decoder: &mut EntityDecoder, schema: &IfcSchema,
        quality: TessellationQuality) -> Result<Mesh> {
        self.calls.borrow_mut().push(Call::Process);
        if self.panics {
            panic!("selected extension interrupted");
        }
        TriangulatedFaceSetProcessor::new().process(item, decoder, schema, quality)
    }
    fn process_in_rtc_frame(&self, _: &DecodedEntity, _: &mut EntityDecoder, _: &IfcSchema,
        _: TessellationQuality, _: (f64, f64, f64)) -> Option<Result<Mesh>> {
        self.calls.borrow_mut().push(Call::RtcHook);
        None
    }
    fn lower_owned(&self, item: &DecodedEntity, decoder: &mut EntityDecoder, quality: TessellationQuality,
        rtc: Option<(f64, f64, f64)>) -> Option<Result<OwnedConstructor>> {
        self.calls.borrow_mut().push(Call::Lower(rtc.is_some()));
        if !(self.lowers_rtc && rtc.is_some()) {
            return None;
        }
        TriangulatedFaceSetProcessor::new().lower_owned(item, decoder, quality, rtc)
    }
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcTriangulatedFaceSet] }
}

fn recording_router(rtc: bool, lowers_rtc: bool, panics: bool) -> (GeometryRouter, Rc<RefCell<Vec<Call>>>) {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
    if rtc {
        router.set_rtc_offset((5_000_000., 0., 0.));
    }
    router.register(Box::new(Recording { calls: Rc::clone(&calls), lowers_rtc, panics }));
    (router, calls)
}

#[test]
fn gateway_reaches_the_selected_custom_callbacks_in_historical_order() {
    let mut decoder = EntityDecoder::new(SURVEY_FACES);
    let item = decoder.decode_by_id(2).unwrap();
    let cases = [
        (true, false, vec![Call::Lower(true), Call::RtcHook, Call::Lower(false), Call::Process]),
        (true, true, vec![Call::Lower(true)]),
        (false, false, vec![Call::Lower(false), Call::Process]),
    ];
    for (rtc, lowers_rtc, expected) in cases {
        let (router, calls) = recording_router(rtc, lowers_rtc, false);
        let mesh = router.process_representation_item(&item, &mut decoder).unwrap();
        assert_eq!(*calls.borrow(), expected, "rtc={rtc} lowers_rtc={lowers_rtc}");
        assert_eq!(mesh.indices, [0, 1, 2]);
        // An admitted RTC recipe evaluates rebased and publishes object-frame bounds.
        assert_eq!(mesh.rtc_applied, lowers_rtc);
        assert_eq!(mesh.local_bounds.is_some(), lowers_rtc);
        if lowers_rtc {
            assert_eq!(mesh.positions[..3], [0., 0., 0.]);
        }
    }
}

#[test]
fn builtin_item_program_matches_the_processor_callback_bytes() {
    let mut decoder = EntityDecoder::new(BLOCK);
    let item = decoder.decode_by_id(10).unwrap();
    let mut router = GeometryRouter::with_scale(0.001);
    router.disable_content_dedup();
    let mesh = GeometryProgram::item(&item, (0., 0., 0.)).drain(&router, &mut decoder).unwrap();
    let mut expected = BlockProcessor::new()
        .process(&item, &mut decoder, router.schema(), TessellationQuality::Medium).unwrap();
    expected.validate_indices();
    crate::router::item::scale_positions(&mut expected, 0.001);
    assert_eq!(mesh.positions, expected.positions);
    assert_eq!(mesh.normals, expected.normals);
    assert_eq!(mesh.indices, expected.indices);
}

#[test]
fn copied_ticket_is_linear_and_a_foreign_reply_survives_rejection() {
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(BLOCK);
    let item = decoder.decode_by_id(10).unwrap();
    let mut first = GeometryProgram::item(&item, (0., 0., 0.));
    let mut second = GeometryProgram::item(&item, (0., 0., 0.));
    let request = first.request().unwrap().unwrap();
    assert_eq!(first.request().err(), Some(ProgramError::Outstanding));
    let reply = first.execute(request, &router, &mut decoder).unwrap();
    assert_eq!(first.execute(request, &router, &mut decoder).err(), Some(ProgramError::AlreadyExecuted));
    let rejected = *second.accept(reply, &router).err().unwrap();
    assert_eq!(rejected.error, ProgramError::StaleRequest);
    let foreign = *first.accept(rejected.reply, &GeometryRouter::new()).err().unwrap();
    assert_eq!(foreign.error, ProgramError::WrongOwner);
    first.accept(foreign.reply, &router).ok().unwrap();
    drain(&mut first, &router, &mut decoder);
    let mesh = first.finish().unwrap();
    let (min, max) = mesh.bounds();
    assert_eq!([max.x - min.x, max.y - min.y, max.z - min.z], [1., 2., 3.]);
    drain(&mut second, &router, &mut decoder);
    assert_eq!(second.finish().unwrap().indices, mesh.indices);
}

#[test]
fn panicking_selected_extension_consumes_its_ticket_before_unwind() {
    let (router, calls) = recording_router(false, false, true);
    let mut decoder = EntityDecoder::new(SURVEY_FACES);
    let item = decoder.decode_by_id(2).unwrap();
    let mut program = GeometryProgram::item(&item, (0., 0., 0.));
    let request = advance_to(&mut program, ProgramStage::Extension, &router, &mut decoder);
    assert_eq!(*calls.borrow(), [Call::Lower(false)]);
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        program.execute(request, &router, &mut decoder)
    }));
    let payload = unwind.err().expect("the original extension panic must propagate");
    assert_eq!(payload.downcast_ref::<&str>(), Some(&"selected extension interrupted"));
    assert_eq!(program.execute(request, &router, &mut decoder).err(), Some(ProgramError::AlreadyExecuted));
    assert_eq!(program.request().err(), Some(ProgramError::Outstanding));
    assert_eq!(*calls.borrow(), [Call::Lower(false), Call::Process], "no replay after unwind");
    assert!(program.finish().is_err(), "an interrupted program never publishes geometry");
}

#[test]
fn foreign_owners_are_refused_before_the_recipe_is_taken() {
    let (router, calls) = recording_router(false, false, false);
    let mut decoder = EntityDecoder::new(SURVEY_FACES);
    let mut foreign_decoder = EntityDecoder::new(SURVEY_FACES);
    let item = decoder.decode_by_id(2).unwrap();
    let mut program = GeometryProgram::item(&item, (0., 0., 0.));
    let request = advance_to(&mut program, ProgramStage::Extension, &router, &mut decoder);
    assert_eq!(program.execute(request, &router, &mut foreign_decoder).err(), Some(ProgramError::WrongOwner),
        "equal source bytes do not authorize a different live decoder");
    let (other_router, other_calls) = recording_router(false, false, false);
    assert_eq!(program.execute(request, &other_router, &mut decoder).err(), Some(ProgramError::WrongOwner));
    assert_eq!(*calls.borrow(), [Call::Lower(false)]);
    assert!(other_calls.borrow().is_empty());
    let reply = program.execute(request, &router, &mut decoder).unwrap();
    program.accept(reply, &router).ok().unwrap();
    assert_eq!(program.finish().unwrap().indices, [0, 1, 2]);
    assert_eq!(*calls.borrow(), [Call::Lower(false), Call::Process]);

    // A numerical recipe survives a refused owner, and reconfiguring the
    // router invalidates its pending work.
    let mut decoder = EntityDecoder::new(BLOCK);
    let item = decoder.decode_by_id(10).unwrap();
    let mut router = GeometryRouter::new();
    let mut program = GeometryProgram::item(&item, (0., 0., 0.));
    let request = advance_to(&mut program, ProgramStage::Numerical, &router, &mut decoder);
    assert_eq!(program.execute(request, &router, &mut foreign_decoder).err(), Some(ProgramError::WrongOwner));
    let reply = program.execute(request, &router, &mut decoder).unwrap();
    router.set_tessellation_quality(TessellationQuality::High);
    let rejected = *program.accept(reply, &router).err().unwrap();
    assert_eq!(rejected.error, ProgramError::WrongOwner);
}

#[test]
fn program_and_reply_have_a_bounded_inline_footprint() {
    // These values cross nested protocol calls per item; keep the 4 KiB
    // ceiling that kept every inactive controller layout off worker stacks.
    for (name, bytes) in [
        ("program", std::mem::size_of::<GeometryProgram>()),
        ("reply", std::mem::size_of::<ProgramReply>()),
    ] {
        assert!(bytes <= 4096, "{name} occupies {bytes} inline bytes");
    }
}
