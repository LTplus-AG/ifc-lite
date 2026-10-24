// SPDX-License-Identifier: MPL-2.0
//! A rayon worker waiting inside one product (faceted-brep triangulation's
//! nested `par_iter`, or a processor's own rayon wait) can run an unrelated
//! element job on its own thread. That element is not on the waiting
//! product's source-owner chain: neither product's stop may reach the other.
//!
//! A one-thread pool makes the schedule deterministic: `join` queues the
//! unrelated element on the waiting thread, and `yield_local` runs it there,
//! exactly as a nested wait does. A FIFO one-thread pool lets the shipped
//! faceted triangulation's own `par_iter` join run it instead.
use super::session_tests::{assert_same, canonical, leaked_job, options, router, Context, SOURCE};
use super::*;
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::resource::{self, ProgramStop};
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::cell::Cell;
use std::fmt::Write as _;
use std::sync::OnceLock;

/// Stops its product first if asked, then waits on rayon once inside `process`.
struct WaitsOnRayon {
    stop_first: bool,
    detach: bool,
    waited: Cell<bool>,
}
impl GeometryProcessor for WaitsOnRayon {
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
        if !self.waited.replace(true) {
            if self.stop_first {
                let _swallowed = resource::stop(ProgramStop::Cancelled);
            }
            let wait = || assert!(matches!(rayon::yield_local(), Some(rayon::Yield::Executed)));
            if self.detach { resource::detached(wait) } else { wait() }
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}

/// A legacy extension that stops its own product and still returns geometry.
struct StopsItself;
impl GeometryProcessor for StopsItself {
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
        let _swallowed = resource::stop(ProgramStop::Cancelled);
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}

/// One element job as the native pipeline runs it: its own decoder and router.
fn produce(id: u32, processor: Option<Box<dyn GeometryProcessor>>) -> ProducedElementMeshes {
    produce_in(SOURCE, id, processor)
}
fn produce_in(
    source: &'static str,
    id: u32,
    processor: Option<Box<dyn GeometryProcessor>>,
) -> ProducedElementMeshes {
    let mut decoder = EntityDecoder::new(source);
    let mut router = router(&mut decoder);
    if let Some(processor) = processor {
        router.register(processor);
    }
    let job = leaked_job(&mut decoder, id);
    produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router)
}

/// The wall waits on rayon; the slab is the unrelated queued element.
/// Returns each product's published mesh count.
fn wall_waits_while_slab_runs(
    stop_first: bool,
    detach: bool,
    slab: impl FnOnce() -> Option<Box<dyn GeometryProcessor>> + Send,
) -> (usize, usize) {
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
    pool.install(|| {
        rayon::join(
            || {
                let waits = WaitsOnRayon { stop_first, detach, waited: Cell::new(false) };
                produce(10, Some(Box::new(waits))).meshes.len()
            },
            || produce(20, slab()).meshes.len(),
        )
    })
}

#[test]
fn a_stopped_waiting_product_never_empties_an_element_run_during_its_wait() {
    let (wall, slab) = wall_waits_while_slab_runs(true, true, || None);
    assert_eq!(wall, 0, "the waiting product stopped itself");
    assert_eq!(slab, canonical(20, false).meshes.len(), "the unrelated element publishes canonically");
    // Control: the same schedule without detaching leaks the waiting
    // product's stop into the unrelated element.
    assert_eq!(wall_waits_while_slab_runs(true, false, || None), (0, 0));
}

#[test]
fn an_element_run_during_a_wait_never_stops_the_waiting_product() {
    let stops = || Some(Box::new(StopsItself) as Box<dyn GeometryProcessor>);
    let (wall, slab) = wall_waits_while_slab_runs(false, true, stops);
    assert_eq!(slab, 0, "the unrelated element stopped itself");
    assert_eq!(wall, canonical(10, false).meshes.len(), "the waiting product publishes canonically");
    // Control: without detaching, the unrelated element's stop, reported to
    // its caller's domain on return, stops the product that was waiting.
    assert_eq!(wall_waits_while_slab_runs(false, false, stops), (0, 0));
}

/// The shared fixture plus #100, a wall whose body is a 66-face faceted brep
/// (a 64-gon prism): enough faces for the shipped parallel triangulation.
fn faceted_source() -> &'static str {
    static FACETED: OnceLock<String> = OnceLock::new();
    FACETED.get_or_init(|| {
        const SIDES: u32 = 64;
        let (bottom, top) = (|i: u32| 1000 + i % SIDES, |i: u32| 1000 + SIDES + i % SIDES);
        let mut data = String::from(
            "#100=IFCWALL('f',$,'Faceted',$,$,#9,#101,$,$);#101=IFCPRODUCTDEFINITIONSHAPE($,$,(#102));\n\
             #102=IFCSHAPEREPRESENTATION(#2,'Body','Brep',(#103));#103=IFCFACETEDBREP(#104);\n",
        );
        for i in 0..SIDES {
            let angle = f64::from(i) * std::f64::consts::TAU / f64::from(SIDES);
            let (x, y) = (angle.cos(), angle.sin());
            writeln!(data, "#{}=IFCCARTESIANPOINT(({x:?},{y:?},0.));", bottom(i)).unwrap();
            writeln!(data, "#{}=IFCCARTESIANPOINT(({x:?},{y:?},3.));", top(i)).unwrap();
        }
        let mut loops: Vec<Vec<u32>> =
            (0..SIDES).map(|i| vec![bottom(i), bottom(i + 1), top(i + 1), top(i)]).collect();
        loops.push((0..SIDES).rev().map(bottom).collect());
        loops.push((0..SIDES).map(top).collect());
        let mut faces = Vec::new();
        for (k, points) in (3000u32..).step_by(3).zip(&loops) {
            let points: Vec<String> = points.iter().map(|p| format!("#{p}")).collect();
            writeln!(data, "#{k}=IFCPOLYLOOP(({}));", points.join(",")).unwrap();
            writeln!(data, "#{}=IFCFACEOUTERBOUND(#{k},.T.);#{}=IFCFACE((#{}));", k + 1, k + 2, k + 1).unwrap();
            faces.push(format!("#{}", k + 2));
        }
        writeln!(data, "#104=IFCCLOSEDSHELL(({}));", faces.join(",")).unwrap();
        SOURCE.replacen("ENDSEC;END-ISO", &format!("{data}ENDSEC;END-ISO"), 1)
    })
}

#[test]
fn an_element_run_during_faceted_triangulation_never_stops_the_waiting_product() {
    // `breadth_first` makes the one worker's deque FIFO, so the shipped
    // triangulation's `par_iter` join pops the queued slab before its own
    // second half: the slab runs on the wall's thread, inside the real wait.
    #[allow(deprecated)]
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).breadth_first().build().unwrap();
    let source = faceted_source();
    let (wall, slab) = pool.install(|| {
        rayon::join(
            || produce_in(source, 100, None),
            || produce_in(source, 20, Some(Box::new(StopsItself))).meshes.len(),
        )
    });
    assert_eq!(slab, 0, "the unrelated element stopped itself");
    assert_same(&wall, &produce_in(source, 100, None));
}
