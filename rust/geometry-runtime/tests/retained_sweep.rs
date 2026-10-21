// SPDX-License-Identifier: MPL-2.0
//! Retained authored sources executed by an actual SMLib worker and published
//! through the GeometryDocument retained -> display boundary. Every oracle is
//! an independent analytic value of the authored source, never the SDK's own.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::analytic::{
    extract_analytic_extrusion, extract_swept_disk, with_source_capture, AnalyticStatus,
};
use ifc_lite_geometry::document::{
    GeometryDocument, RegionQualification, RetainedDisplayContract, RetainedExtrusion,
    RetainedRequest, RetainedSweptDisk,
};
use ifc_lite_geometry_runtime::{MeshLimits, RetainedRealization, SmlibWorker, WorkerError};
use std::f64::consts::{PI, SQRT_2};

const IDENTITY: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!(
            "SKIP actual retained sweep: build native/smlib-adapter and set IFCLITE_SMLIB_WORKER"
        );
        return None;
    };
    Some(SmlibWorker::spawn(path).expect("configured worker must start"))
}

fn decoder(data: &str) -> EntityDecoder<'_> {
    EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()))
}

/// One profile `#4`, extruded 3 m along +Z from the origin, in metres.
fn extrusion(profile: &str) -> RetainedExtrusion {
    let data = format!(
        "{profile}\n#90=IFCCARTESIANPOINT((0.,0.,0.));\n#91=IFCAXIS2PLACEMENT3D(#90,$,$);\n\
#92=IFCDIRECTION((0.,0.,1.));\n#93=IFCEXTRUDEDAREASOLID(#4,#91,#92,3.);"
    );
    let mut decoder = decoder(&data);
    let entity = decoder.decode_by_id(93).unwrap();
    let source = with_source_capture(|| extract_analytic_extrusion(&entity, &mut decoder));
    assert_eq!(source.status, AnalyticStatus::Complete, "{profile}");
    RetainedExtrusion {
        source,
        length_unit_scale: 1.,
    }
}

fn circle_profile() -> String {
    "#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);\
#4=IFCCIRCLEPROFILEDEF(.AREA.,$,#2,2.);"
        .into()
}

/// A full circle with a rotated seam (0.37 rad), either normal and either
/// composite traversal: one kind-2 curve whatever the authored frame.
fn seam_circle(normal: f64, sense: &str) -> String {
    let (x, y) = (0.37f64.cos(), 0.37f64.sin());
    format!(
        "#20=IFCCARTESIANPOINT((0.,0.,0.));#21=IFCDIRECTION((0.,0.,{normal:?}));\
#22=IFCDIRECTION(({x:?},{y:?},0.));#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);\
#24=IFCCIRCLE(#23,2.);#25=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.{sense}.,#24);\
#26=IFCCOMPOSITECURVE((#25),.F.);#4=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#26);"
    )
}

fn annulus() -> String {
    "#20=IFCCARTESIANPOINT((0.,0.));#21=IFCAXIS2PLACEMENT2D(#20,$);#22=IFCCIRCLE(#21,2.);\
#23=IFCCIRCLE(#21,1.);#24=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#22);\
#25=IFCCOMPOSITECURVE((#24),.F.);#4=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#25,(#23));"
        .into()
}

/// A 270 degree trim from 0.75pi to 2.25pi, closed by its chord. The range
/// crosses the circle's parameter seam; its complement is the 90 degree cap.
fn major_arc(normal: f64, sense: &str) -> String {
    let point = |t: f64| (2. * t.cos(), 2. * normal * t.sin());
    let ((sx, sy), (ex, ey)) = (point(0.75 * PI), point(2.25 * PI));
    let (t1, t2) = (0.75 * PI, 2.25 * PI);
    format!(
        "#20=IFCCARTESIANPOINT((0.,0.,0.));#21=IFCDIRECTION((0.,0.,{normal:?}));\
#22=IFCDIRECTION((1.,0.,0.));#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);#24=IFCCIRCLE(#23,2.);\
#25=IFCCARTESIANPOINT(({sx:?},{sy:?},0.));#26=IFCCARTESIANPOINT(({ex:?},{ey:?},0.));\
#27=IFCTRIMMEDCURVE(#24,(IFCPARAMETERVALUE({t1:?}),#25),(IFCPARAMETERVALUE({t2:?}),#26),.T.,.PARAMETER.);\
#28=IFCPOLYLINE((#26,#25));#29=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#27);\
#30=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#28);#31=IFCCOMPOSITECURVE((#29,#30),.F.);\
#33=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.{sense}.,#31);#34=IFCCOMPOSITECURVE((#33),.F.);\
#4=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#34);"
    )
}

fn disk(data: &str) -> RetainedSweptDisk {
    let mut decoder = decoder(data);
    let entity = decoder.decode_by_id(9).unwrap();
    let source = with_source_capture(|| extract_swept_disk(&entity, &mut decoder)).unwrap();
    RetainedSweptDisk {
        solid_id: 9,
        source,
        length_unit_scale: 1.,
    }
}

/// Unequal weights make the rational line's speed nonuniform.
fn rational_line(knots: &str, trim: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((0.,0.,5.));\
#3=IFCRATIONALBSPLINECURVEWITHKNOTS(1,(#1,#2),.UNSPECIFIED.,.F.,.F.,(2,2),({knots}),.UNSPECIFIED.,(2.,3.));\
#9=IFCSWEPTDISKSOLID(#3,0.25,$,{trim});"
    )
}

const RATIONAL_QUARTER: &str = "#1=IFCCARTESIANPOINT((4.,0.,0.));#2=IFCCARTESIANPOINT((4.,4.,0.));\
#4=IFCCARTESIANPOINT((0.,4.,0.));\
#3=IFCRATIONALBSPLINECURVEWITHKNOTS(2,(#1,#2,#4),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.),.UNSPECIFIED.,(1.,0.7071067811865476,1.));\
#9=IFCSWEPTDISKSOLID(#3,0.25,$,$,$);";

fn prepared(
    retain: impl FnOnce(
        &mut GeometryDocument,
    ) -> Result<
        ifc_lite_geometry::document::RetainedDefinitionHandle,
        ifc_lite_geometry::document::RetainedRefusal,
    >,
    worker: &SmlibWorker,
) -> (GeometryDocument, RetainedRequest) {
    let mut document = GeometryDocument::new();
    let definition = retain(&mut document).unwrap();
    let request = document
        .prepare_retained(definition, worker.incarnation())
        .unwrap();
    (document, request)
}

/// Bounds in the authored solid frame (file units = metres here).
fn source_bounds(realization: &RetainedRealization) -> ([f64; 3], [f64; 3]) {
    let packet = realization.completion();
    let m = packet.source_from_evaluation;
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for p in packet.tessellation.positions.chunks_exact(3) {
        for (axis, (lo, hi)) in low.iter_mut().zip(high.iter_mut()).enumerate() {
            let value = m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + m[12 + axis];
            *lo = lo.min(value);
            *hi = hi.max(value);
        }
    }
    (low, high)
}

/// Publish through the only retained -> display contract, then release.
fn publish_and_release(
    document: &mut GeometryDocument,
    realization: RetainedRealization,
    worker: &mut SmlibWorker,
) {
    let packet = realization.completion();
    let (definition, occurrences) = document
        .publish_retained_display(
            packet,
            worker.incarnation(),
            RetainedDisplayContract::UnstyledFlatSourceOnly,
            &[(31, IDENTITY)],
        )
        .unwrap();
    assert_eq!(occurrences.len(), 1);
    let mesh = document.mesh(definition).unwrap();
    // Flat corners are expanded, never welded or smoothed.
    assert_eq!(mesh.indices.len(), packet.tessellation.indices.len());
    worker.release(realization.solid()).unwrap();
    assert!(realization.validate_live().is_err());
}

#[test]
fn actual_sdk_curved_regions_need_this_incarnations_witness_and_keep_exact_domains() {
    let Some(mut worker) = worker() else { return };
    let incarnation = worker.incarnation();
    let (_, gated) = prepared(
        |d| d.add_retained_extrusion(extrusion(&circle_profile())),
        &worker,
    );
    assert_eq!(
        gated.payload().qualification,
        RegionQualification::OrderedRegion
    );
    assert!(matches!(
        worker.evaluate_retained(gated, 0.001, 5., MeshLimits::default()),
        Err(WorkerError::Unqualified(_))
    ));
    assert_eq!(
        worker.incarnation(),
        incarnation,
        "a refused gate keeps the session"
    );
    let report = worker.qualify_ordered_regions().unwrap();
    assert_eq!((report.worker_incarnation, report.cases), (incarnation, 6));

    let q = SQRT_2;
    // (name, source, area, faces, low xy, high xy): faces are the caps plus
    // one side per authored curve, so a split or lost seam changes the count.
    let mut cases = vec![
        ("circle", circle_profile(), 4. * PI, 3, [-2., -2.], [2., 2.]),
        ("annulus", annulus(), 3. * PI, 4, [-2., -2.], [2., 2.]),
    ];
    for normal in [1., -1.] {
        for sense in ["T", "F"] {
            cases.push((
                "seam-circle",
                seam_circle(normal, sense),
                4. * PI,
                3,
                [-2., -2.],
                [2., 2.],
            ));
            let (low, high) = if normal > 0. { (-2., q) } else { (-q, 2.) };
            cases.push((
                "major-arc",
                major_arc(normal, sense),
                3. * PI + 2.,
                4,
                [-2., low],
                [2., high],
            ));
        }
    }
    for (name, profile, area, faces, low, high) in cases {
        let (mut document, request) =
            prepared(|d| d.add_retained_extrusion(extrusion(&profile)), &worker);
        assert_eq!(
            request.payload().qualification,
            RegionQualification::OrderedRegion
        );
        let realization = worker
            .evaluate_retained(request, 0.001, 5., MeshLimits::default())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        realization.validate_live().unwrap();
        let volume = worker.volume(realization.solid(), 1e-8).unwrap();
        assert!(
            (volume - 3. * area).abs() < 3. * area * 1e-6,
            "{name}: {volume}"
        );
        assert!(worker.is_manifold(realization.solid()).unwrap(), "{name}");
        let tessellation = &realization.completion().tessellation;
        assert_eq!(tessellation.source_face_count, faces, "{name} surfaces");
        assert_eq!(
            (tessellation.boundary_edges, tessellation.spine_edges),
            (0, 0)
        );
        let (lo, hi) = source_bounds(&realization);
        for (axis, (expected_lo, expected_hi)) in [(low[0], high[0]), (low[1], high[1]), (0., 3.)]
            .into_iter()
            .enumerate()
        {
            assert!(
                (lo[axis] - expected_lo).abs() < 2e-3,
                "{name} axis {axis} low {lo:?}"
            );
            assert!(
                (hi[axis] - expected_hi).abs() < 2e-3,
                "{name} axis {axis} high {hi:?}"
            );
        }
        publish_and_release(&mut document, realization, &mut worker);
    }

    // Qualification belongs to one process: a replacement starts closed.
    let mut replacement = self::worker().unwrap();
    let (_, request) = prepared(
        |d| d.add_retained_extrusion(extrusion(&circle_profile())),
        &replacement,
    );
    assert!(matches!(
        replacement.evaluate_retained(request, 0.001, 5., MeshLimits::default()),
        Err(WorkerError::Unqualified(_))
    ));
}

#[test]
fn actual_sdk_rational_disks_keep_weights_and_trims_behind_their_own_witness() {
    let Some(mut worker) = worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    let straight = rational_line("0.,1.", "$,$");
    let (_, gated) = prepared(|d| d.add_retained_swept_disk(disk(&straight)), &worker);
    assert_eq!(
        gated.payload().qualification,
        RegionQualification::RationalDisk
    );
    assert!(
        matches!(
            worker.evaluate_retained(gated, 0.001, 5., MeshLimits::default()),
            Err(WorkerError::Unqualified(_))
        ),
        "region witnesses never open the disk route"
    );
    assert_eq!(worker.qualify_rational_disks().unwrap().len(), 2);
    let section = PI * 0.25 * 0.25;
    // Trimmed weighted line: knots 2..6, active 3..5. Position fraction is
    // 3s/(2+s) with s=(u-2)/4, so the swept length is 5*(9/11-1/3)=80/33.
    for (name, data, length) in [
        ("rational-line", straight, 5.),
        ("rational-quarter", RATIONAL_QUARTER.to_owned(), 2. * PI),
        (
            "trimmed-weighted-line",
            rational_line("2.,6.", "3.,5."),
            80. / 33.,
        ),
    ] {
        let (mut document, request) = prepared(|d| d.add_retained_swept_disk(disk(&data)), &worker);
        assert_eq!(request.payload().format, 2, "{name}");
        let realization = worker
            .evaluate_retained(request, 0.001, 5., MeshLimits::default())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let volume = worker.volume(realization.solid(), 1e-8).unwrap();
        let expected = section * length;
        assert!(
            (volume - expected).abs() < expected * 1e-4,
            "{name}: {volume} != {expected}"
        );
        assert!(worker.is_manifold(realization.solid()).unwrap(), "{name}");
        if name == "rational-quarter" {
            // Every vertex lies on the swept tube around the radius-4 arc.
            let (lo, hi) = source_bounds(&realization);
            assert!(
                (hi[0] - 4.25).abs() < 2e-3 && (hi[1] - 4.25).abs() < 2e-3,
                "{hi:?}"
            );
            assert!(
                (lo[2] + 0.25).abs() < 2e-3 && (hi[2] - 0.25).abs() < 2e-3,
                "{lo:?}"
            );
        }
        publish_and_release(&mut document, realization, &mut worker);
    }
}

#[test]
fn actual_sdk_receipt_binds_exact_completion_and_its_live_owner() {
    let Some(mut worker) = worker() else { return };
    let rectangle = "#1=IFCCARTESIANPOINT((1.,2.));#2=IFCAXIS2PLACEMENT2D(#1,$);\
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,4.);";
    let (mut document, request) =
        prepared(|d| d.add_retained_extrusion(extrusion(rectangle)), &worker);
    assert_eq!(
        request.payload().qualification,
        RegionQualification::Rectangle
    );
    // Axis-aligned rectangles need no curved witness.
    let receipt = worker
        .evaluate_retained(request, 0.001, 15., MeshLimits::default())
        .unwrap();
    receipt.validate_live().unwrap();
    assert!((worker.volume(receipt.solid(), 1e-8).unwrap() - 24.).abs() < 1e-6);
    assert_eq!(receipt.completion().tessellation.source_face_count, 6);
    let (lo, hi) = source_bounds(&receipt);
    for (axis, (l, h)) in [(0., 2.), (0., 4.), (0., 3.)].into_iter().enumerate() {
        assert!((lo[axis] - l).abs() < 1e-9 && (hi[axis] - h).abs() < 1e-9);
    }
    let owner = receipt.owner().clone();
    let pid = worker.process_id();
    owner.retire();
    assert_eq!(worker.incarnation(), 0);
    assert!(receipt.validate_live().is_err());
    assert!(document
        .publish_retained_display(
            receipt.completion(),
            owner.incarnation().unwrap_or(0),
            RetainedDisplayContract::UnstyledFlatSourceOnly,
            &[(31, IDENTITY)],
        )
        .is_err());
    #[cfg(target_os = "linux")]
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    // The owned buffers stay available for rejection diagnostics.
    assert!(!receipt.completion().tessellation.positions.is_empty());
}

#[test]
fn actual_sdk_retained_limit_error_releases_the_unpublished_solid() {
    let Some(mut worker) = worker() else { return };
    let rectangle = "#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);\
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,4.);";
    let (_, request) = prepared(|d| d.add_retained_extrusion(extrusion(rectangle)), &worker);
    let incarnation = worker.incarnation();
    assert!(matches!(
        worker.evaluate_retained(request, 0.001, 15., MeshLimits { max_bytes: 0 }),
        Err(WorkerError::ResourceLimit(_))
    ));
    assert_eq!(worker.incarnation(), incarnation);
    let solid = worker.create_box([0.; 3], [2.; 3]).unwrap();
    assert!((worker.volume(solid, 1e-8).unwrap() - 8.).abs() < 1e-6);
    worker.release(solid).unwrap();
}

/// Protocol-peer admission witness: it can only prove nothing was uploaded.
#[cfg(unix)]
#[test]
fn stale_or_unqualified_requests_are_refused_before_any_upload() {
    let mut worker = SmlibWorker::spawn(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/retained-gate-peer.py"),
    )
    .unwrap();
    let incarnation = worker.incarnation();
    let mut document = GeometryDocument::new();
    let circle = document
        .add_retained_extrusion(extrusion(&circle_profile()))
        .unwrap();
    let disk = document
        .add_retained_swept_disk(disk(&rational_line("0.,1.", "$,$")))
        .unwrap();
    for definition in [circle, disk] {
        let request = document.prepare_retained(definition, incarnation).unwrap();
        assert!(matches!(
            worker.evaluate_retained(request, 0.001, 5., MeshLimits::default()),
            Err(WorkerError::Unqualified(_))
        ));
        let stale = document
            .prepare_retained(definition, incarnation + 1)
            .unwrap();
        assert!(matches!(
            worker.evaluate_retained(stale, 0.001, 5., MeshLimits::default()),
            Err(WorkerError::WrongWorker)
        ));
    }
    // The peer exits on any upload opcode, so a live process proves none ran.
    assert_eq!(worker.incarnation(), incarnation);
}
