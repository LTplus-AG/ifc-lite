// SPDX-License-Identifier: MPL-2.0
//! #7955, SMLib-free: dental_clinic #2510's curved mullion (composite curve
//! #162646) through the real controller. A test peer tessellates the request
//! the lowering actually sent, chording each arc with a chosen count, so the
//! curved volume admission sees a real construction receipt. 8 inner / 16
//! outer is what the pinned SDK did at chord 1 mm (+0.68%); equal counts
//! cancel the concave gain against the convex loss and publish.
#![cfg(feature = "retained-runtime")]
use ifc_lite_geometry::document::{RetainedCompletion, RetainedTessellation};
use ifc_lite_processing::element::retained_runtime::*;
use std::{cell::Cell, future::Future, rc::Rc, task::{Context, Poll, Waker}};

const MULLION: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#3=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);#4=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.01745329251994328),#2);
#5=IFCCONVERSIONBASEDUNIT(#3,.PLANEANGLEUNIT.,'DEGREE',#4);#6=IFCUNITASSIGNMENT((#1,#5));
#7=IFCPROJECT('0000000000000000000000',$,'SYNTHETIC',$,$,$,$,$,#6);
#10=IFCCARTESIANPOINT((-0.1191200550864879,-0.6535333285020208));
#11=IFCCARTESIANPOINT((-0.06912005508648793,-0.6535333285020206));#12=IFCPOLYLINE((#10,#11));
#13=IFCCARTESIANPOINT((4.53857932089166,-0.6535333285020071));#14=IFCDIRECTION((-0.9583864791051044,0.2854739159161845));
#15=IFCAXIS2PLACEMENT2D(#13,#14);#16=IFCCIRCLE(#15,4.607699375978148);
#17=IFCTRIMMEDCURVE(#16,(IFCPARAMETERVALUE(0.4004577362866802)),(IFCPARAMETERVALUE(16.58717889379865)),.T.,.PARAMETER.);
#18=IFCCARTESIANPOINT((0.1135368949550646,0.6309483054852538));
#19=IFCCARTESIANPOINT((0.07470321521791104,0.6761183515188154));#20=IFCPOLYLINE((#18,#19));
#21=IFCCIRCLE(#15,4.657699375978148);
#22=IFCTRIMMEDCURVE(#21,(IFCPARAMETERVALUE(3.562221243239142E-013)),(IFCPARAMETERVALUE(16.58717889379865)),.T.,.PARAMETER.);
#23=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#12);#24=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#17);
#25=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#20);#26=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#22);
#27=IFCCOMPOSITECURVE((#23,#24,#25,#26),.F.);#28=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#27);
#29=IFCCARTESIANPOINT((0.,0.,0.));#30=IFCAXIS2PLACEMENT3D(#29,$,$);#31=IFCDIRECTION((0.,0.,1.));
#32=IFCEXTRUDEDAREASOLID(#28,#30,#31,0.15);
#33=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#32));#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#35=IFCLOCALPLACEMENT($,#30);
#36=IFCMEMBER('0000000000000000000001',$,'SYNTHETIC mullion',$,$,#35,#34,$,$);
ENDSEC;END-ISO-10303-21;";

type P = [f64; 3];
fn sub(a: P, b: P) -> P { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn cross(a: P, b: P) -> P { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }

/// The wire-format-1 boundary (one outer loop) as a closed polygon, each arc
/// chorded with the next of `arcs`, plus the source face of every edge.
fn ring(bytes: &[u8], arcs: [usize; 2]) -> (Vec<P>, Vec<u32>, P, f64) {
    let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let f64_at = |at: usize| f64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    assert_eq!((u32_at(0), u32_at(4)), (1, 1), "format 1, one loop");
    let (direction, depth) = ([f64_at(16), f64_at(24), f64_at(32)], f64_at(40));
    let segments = u32_at(52) as usize;
    let (mut points, mut faces, mut arc) = (Vec::new(), Vec::new(), 0);
    for s in 0..segments {
        let at = 56 + s * 104;
        let v: [f64; 12] = std::array::from_fn(|i| f64_at(at + 8 + i * 8));
        let edge = match u32_at(at) {
            1 => vec![[v[0], v[1], v[2]]],
            3 => {
                let (centre, x) = ([v[0], v[1], v[2]], [v[6], v[7], v[8]]);
                let y = cross([v[3], v[4], v[5]], x);
                let count = arcs[arc];
                arc += 1;
                (0..count).map(|i| {
                    let (sin, cos) = (v[10] + v[11] * i as f64 / count as f64).sin_cos();
                    std::array::from_fn(|k| centre[k] + v[9] * (x[k] * cos + y[k] * sin))
                }).collect()
            }
            kind => panic!("mullion has lines and arcs only, got kind {kind}"),
        };
        faces.extend(std::iter::repeat_n(2 + s as u32, edge.len()));
        points.extend(edge);
    }
    assert_eq!(arc, 2, "two concentric arcs");
    (points, faces, direction, depth)
}

/// Ear clipping of a counter-clockwise simple polygon in the XY plane.
fn ears(ring: &[P]) -> Vec<[u32; 3]> {
    let mut open: Vec<u32> = (0..ring.len() as u32).collect();
    let mut triangles = Vec::new();
    let turn = |a: P, b: P, c: P| cross(sub(b, a), sub(c, a))[2];
    while open.len() > 3 {
        let n = open.len();
        let ear = (0..n).find(|&i| {
            let [a, b, c] = [open[(i + n - 1) % n], open[i], open[(i + 1) % n]].map(|k| ring[k as usize]);
            turn(a, b, c) > 0. && open.iter().map(|&k| ring[k as usize]).filter(|&p| p != a && p != b && p != c)
                .all(|p| turn(a, b, p) < 0. || turn(b, c, p) < 0. || turn(c, a, p) < 0.)
        }).expect("a simple polygon always has an ear");
        triangles.push([open[(ear + n - 1) % n], open[ear], open[(ear + 1) % n]]);
        open.remove(ear);
    }
    triangles.push([open[0], open[1], open[2]]);
    triangles
}

/// A closed, consistently oriented prism over the chorded boundary.
fn prism(bytes: &[u8], arcs: [usize; 2]) -> RetainedTessellation {
    let (bottom, edge_faces, direction, depth) = ring(bytes, arcs);
    let n = bottom.len() as u32;
    let top: Vec<P> = bottom.iter().map(|p| std::array::from_fn(|k| p[k] + direction[k] * depth)).collect();
    let positions: Vec<f64> = bottom.iter().chain(&top).flatten().copied().collect();
    let (mut indices, mut faces) = (Vec::new(), Vec::new());
    for [a, b, c] in ears(&bottom) {
        indices.extend([a, c, b, n + a, n + b, n + c]);
        faces.extend([0, 1]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        indices.extend([i, j, n + j, i, n + j, n + i]);
        faces.extend([edge_faces[i as usize]; 2]);
    }
    let point = |i: u32| -> P { std::array::from_fn(|k| positions[i as usize * 3 + k]) };
    let flat_corner_normals = indices.chunks_exact(3).flat_map(|t| {
        let normal = cross(sub(point(t[1]), point(t[0])), sub(point(t[2]), point(t[0])));
        let length = normal.iter().map(|v| v * v).sum::<f64>().sqrt();
        [0; 3].into_iter().flat_map(move |_| normal.map(|v| v / length))
    }).collect();
    RetainedTessellation {
        positions, indices, flat_corner_normals, revision_local_faces: faces,
        source_face_count: 2 + edge_faces.iter().collect::<std::collections::BTreeSet<_>>().len() as u32,
        boundary_edges: 0, spine_edges: 0,
    }
}

#[derive(Clone)]
struct Domain(Rc<Cell<usize>>);
impl ReceiptDomain for Domain {
    fn incarnation(&self) -> Option<u64> { Some(1) }
    fn retire(&self) { self.0.set(self.0.get() + 1); }
    fn same_domain(&self, other: &Self) -> bool { Rc::ptr_eq(&self.0, &other.0) }
}
struct Receipt(Domain, RetainedCompletion);
impl NumericalReceipt for Receipt {
    type Object = usize;
    type Domain = Domain;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 { std::mem::size_of::<Self>() as u64 }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> {
        let m = &self.1.tessellation;
        Ok((m.positions.len() * 8 + m.indices.len() * 4 + m.flat_corner_normals.len() * 8
            + m.revision_local_faces.len() * 4) as u64)
    }
    fn object(&self) -> usize { 1 }
    fn evidence(&self) -> ReceiptEvidence<'_, usize> { ReceiptEvidence::Construction(&self.1) }
    fn domain(&self) -> &Domain { &self.0 }
    fn validate_live(&self) -> Result<(), RuntimeFault> { Ok(()) }
    fn mesh(&self) -> Option<ReceiptMesh<'_>> {
        let m = &self.1.tessellation;
        Some(ReceiptMesh { positions: &m.positions, indices: &m.indices, faces: &m.revision_local_faces })
    }
}
struct Peer(Domain, [usize; 2]);
impl RetainedRuntime for Peer {
    type Receipt = Receipt;
    fn domain(&self) -> Domain { self.0.clone() }
    fn incarnation(&self) -> u64 { 1 }
}
impl AsyncRetainedExecutor for Peer {
    async fn invoke(&mut self, call: Invocation<'_, Receipt>, _: NumericalLimits) -> Result<Receipt, RuntimeFault> {
        let Invocation::Construction(request) = call else { panic!("only the mullion extrusion is constructed") };
        let frame = request.payload();
        let mesh = prism(&frame.bytes, self.1);
        Ok(Receipt(self.0.clone(), RetainedCompletion::new(request.clone(), mesh,
            frame.source_from_evaluation, frame.evaluation_from_source)))
    }
}

fn ready<T>(future: impl Future<Output = T>) -> T {
    let Poll::Ready(value) = std::pin::pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop()))
        else { panic!("synchronous test peer must settle") };
    value
}

fn run(arcs: [usize; 2]) -> (ProductOutcome, usize) {
    let domain = Domain(Rc::new(Cell::new(0)));
    let mut outcomes = Vec::new();
    ready(run_model(ifc_lite_core::SourceBundle::new(MULLION.as_bytes().to_vec()),
        &ModelOptions { ids: Some([36].into_iter().collect()), ..Default::default() },
        || Ok(Peer(domain.clone(), arcs)), |o| outcomes.push(o))).unwrap();
    assert_eq!(outcomes.len(), 1, "one atomic publication/refusal");
    (outcomes.pop().unwrap(), domain.0.get())
}

#[test]
fn issue_7955_mismatched_arc_counts_refuse_through_the_controller() {
    let (outcome, retired) = run([8, 16]);
    let ProductOutcome::Refused { refusal, origin, .. } = &outcome else {
        panic!("a +0.68% curved mullion must not publish")
    };
    assert_eq!(refusal.code(), "incomplete");
    let origin = origin.expect("typed origin");
    assert_eq!((origin.site, origin.entity, origin.cause), ("chordal_volume", Some(32), "curved_volume_tolerance"));
    assert_eq!(retired, 0, "a settled numerical refusal keeps the worker");
    println!("witness: 8/16 mullion refused {origin:?}");
}

#[test]
fn issue_7955_consistent_arc_counts_publish_through_the_controller() {
    for arcs in [[8, 8], [16, 16]] {
        let (outcome, _) = run(arcs);
        let refused = match &outcome { ProductOutcome::Refused { refusal, origin, .. } => Some((refusal.code(), *origin)), _ => None };
        assert!(matches!(&outcome, ProductOutcome::Published(s) if s.product_id == 36), "{arcs:?} refused: {refused:?}");
    }
}
