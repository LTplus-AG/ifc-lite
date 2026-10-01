// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{ProfileProcessor, TrimSelect};
use crate::processors::ExtrudedAreaSolidProcessor;
use crate::{GeometryProcessor, Point2, Point3, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};
use std::f64::consts::PI;

// #6597: parameter travel must follow Axis cross RefDirection, including
// Cartesian trim inversion, rotated placements, circles and ellipses.
#[test]
fn issue_6597_conic_trim_bounds_and_travel_follow_the_placement_frame() {
    for normal in [1.0, -1.0] {
        for rotated in [false, true] {
            for ellipse in [false, true] {
                for cartesian in [false, true] {
                    for sense in [false, true] {
                        let (dx, dy) = if rotated { (0.0, 1.0) } else { (1.0, 0.0) };
                        let radius = if ellipse { 2.0 } else { 1.0 };
                        let curve = if ellipse {
                            "IFCELLIPSE(#4,2.,1.)"
                        } else {
                            "IFCCIRCLE(#4,1.)"
                        };
                        let content = format!("#1=IFCCARTESIANPOINT((10.,20.,0.));\n#2=IFCDIRECTION((0.,0.,{normal}));\n#3=IFCDIRECTION(({dx},{dy},0.));\n#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);\n#5={curve};");
                        let world = |angle: f64| {
                            let x = radius * angle.cos();
                            let y = normal * angle.sin();
                            Point2::new(10.0 + dx * x - dy * y, 20.0 + dy * x + dx * y)
                        };
                        let bound = |angle: f64| {
                            if cartesian {
                                TrimSelect::Cartesian(world(angle))
                            } else {
                                TrimSelect::Parameter(angle)
                            }
                        };
                        let mut decoder = EntityDecoder::new(&content);
                        let basis = decoder.decode_by_id(5).unwrap();
                        let processor = ProfileProcessor::new(IfcSchema::new());
                        let points = processor
                            .process_trimmed_conic(
                                &basis,
                                Some(bound(PI / 4.0)),
                                Some(bound(3.0 * PI / 4.0)),
                                sense,
                                &mut decoder,
                            )
                            .unwrap();
                        let close = |a: &Point2<f64>, b: Point2<f64>| {
                            assert!((a - b).norm() < 1e-9, "normal={normal} rotated={rotated} ellipse={ellipse} cartesian={cartesian} sense={sense}: {a:?} vs {b:?}");
                        };
                        close(points.first().unwrap(), world(PI / 4.0));
                        close(points.last().unwrap(), world(3.0 * PI / 4.0));
                        // Every interior sample follows the expected short positive
                        // arc or long negative arc, rather than its mirror.
                        let sweep = if sense { PI / 2.0 } else { -3.0 * PI / 2.0 };
                        for (i, point) in points.iter().enumerate() {
                            close(
                                point,
                                world(PI / 4.0 + sweep * i as f64 / (points.len() - 1) as f64),
                            );
                        }
                    }
                }
            }
        }
    }
}

// Adapted from christof2304/ifc-lite@2cf6747b: a lower-half-disc profile
// extrudes to a closed half-cylinder, not its reflection above the chord.
#[test]
fn issue_6597_downward_axis_composite_profile_extrudes_below_its_chord() {
    let content = include_str!("../../tests/fixtures/downward_axis_half_cylinder.ifc");
    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let entity = decoder.decode_by_id(16).unwrap();
    let mesh = ExtrudedAreaSolidProcessor::new(schema.clone())
        .process(&entity, &mut decoder, &schema, TessellationQuality::Medium)
        .unwrap();
    assert!(!mesh.is_empty());
    let (min, max) = mesh.bounds();
    assert!(max.y < 0.01, "profile mirrored above chord: {max:?}");
    assert!(
        (min.y + 1.0).abs() < 0.01,
        "profile misses lower arc: {min:?}"
    );
    let mut area = 0.0;
    let mut signed_volume = 0.0;
    let interior = Point3::new(0.0, -4.0 / (3.0 * PI), 0.5);
    for t in mesh.indices.chunks_exact(3) {
        let position = |i: u32| {
            let k = i as usize * 3;
            Point3::new(
                mesh.positions[k] as f64,
                mesh.positions[k + 1] as f64,
                mesh.positions[k + 2] as f64,
            )
        };
        let a = position(t[0]);
        let b = position(t[1]);
        let c = position(t[2]);
        let normal = (b - a).cross(&(c - a));
        area += normal.norm() / 2.0;
        signed_volume += a.coords.dot(&b.coords.cross(&c.coords)) / 6.0;
        let face_center = Point3::from((a.coords + b.coords + c.coords) / 3.0);
        assert!(
            normal.dot(&(face_center - interior)) > 0.0,
            "triangle points into the convex half-cylinder"
        );
        for i in t {
            let k = *i as usize * 3;
            let stored = crate::Vector3::new(
                mesh.normals[k] as f64,
                mesh.normals[k + 1] as f64,
                mesh.normals[k + 2] as f64,
            );
            assert!(
                normal.dot(&stored) > 0.0,
                "stored normal opposes the face winding"
            );
        }
    }
    assert!(
        (signed_volume - PI / 2.0).abs() < 0.02,
        "half-cylinder signed volume: {signed_volume}"
    );
    assert!(
        (area - (2.0 * PI + 2.0)).abs() < 0.05,
        "closed half-cylinder surface area: {area}"
    );
}
