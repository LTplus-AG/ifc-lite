/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ifc_lite_landxml::{
    classify_landxml_version, parse_landxml_tin_with_cancel, LandXmlCancellation,
    LandXmlCancellationFlag, LandXmlCapabilityDiagnosticCode, LandXmlCrossSectionPointDataFormat,
    LandXmlDiagnosticCode, LandXmlLimits, LandXmlProfileKind, LandXmlSurface,
    LandXmlTerrainDiagnosticCode, LandXmlTopologyOrigin, LandXmlVersionCapability,
    LandXmlVerticalCurveKind, LANDXML_10_NAMESPACE, LANDXML_11_NAMESPACE, LANDXML_12_NAMESPACE,
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CancelsAfterPolls {
    cancel_after: usize,
    polls: AtomicUsize,
}

fn faceless_tin(boundaries: &str, breaklines: &str, faces: &str) -> String {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 10 0</P><P id="3">10 10 0</P><P id="4">10 0 0</P></Pnts>{faces}{boundaries}{breaklines}</Definition></Surface></Surfaces></LandXML>"#
    )
}

fn generated_area(surface: &LandXmlSurface) -> f64 {
    let points: std::collections::HashMap<_, _> = surface
        .points
        .iter()
        .map(|point| (point.id.as_str(), point))
        .collect();
    surface
        .faces
        .iter()
        .map(|face| {
            let [a, b, c] = [
                points[face[0].as_str()],
                points[face[1].as_str()],
                points[face[2].as_str()],
            ];
            ((b.northing - a.northing) * (c.easting - a.easting)
                - (b.easting - a.easting) * (c.northing - a.northing))
                .abs()
                * 0.5
        })
        .sum()
}

fn has_generated_edge(surface: &LandXmlSurface, a: [f64; 2], b: [f64; 2]) -> bool {
    let points: std::collections::HashMap<_, _> = surface
        .points
        .iter()
        .map(|point| (point.id.as_str(), point))
        .collect();
    surface.faces.iter().any(|face| {
        (0..3).any(|index| {
            let first = points[face[index].as_str()];
            let second = points[face[(index + 1) % 3].as_str()];
            ([first.northing, first.easting] == a && [second.northing, second.easting] == b)
                || ([first.northing, first.easting] == b && [second.northing, second.easting] == a)
        })
    })
}

#[test]
fn issue_5043_triangulates_faceless_tin_with_holes_breaklines_and_triangle_provenance(
) -> Result<(), Box<dyn std::error::Error>> {
    let boundaries = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary><Boundary bndType="hole"><PntList3D>4 4 0 4 6 0 6 6 0 6 4 0</PntList3D></Boundary></Boundaries>"#;
    let breaklines = r#"<Breaklines><Breakline brkType="standard"><PntList3D>0 2 0 10 2 0</PntList3D></Breakline></Breaklines>"#;
    let parsed = parse(faceless_tin(boundaries, breaklines, "").as_bytes())?;
    let surface = &parsed.surfaces[0];
    assert_eq!(
        surface.topology_origin,
        LandXmlTopologyOrigin::ConstrainedTriangulation
    );
    assert_eq!(
        surface.render_state,
        ifc_lite_landxml::LandXmlRenderState::Rendered
    );
    assert!(!surface.faces.is_empty());
    assert_eq!(surface.faces.len(), surface.face_source_ids.len());
    assert!(surface
        .face_source_ids
        .iter()
        .all(|id| id.0.contains(":triangle:")));
    let point_by_id: std::collections::HashMap<_, _> = surface
        .points
        .iter()
        .map(|point| (point.id.as_str(), point))
        .collect();
    for face in &surface.faces {
        let points = [
            point_by_id[face[0].as_str()],
            point_by_id[face[1].as_str()],
            point_by_id[face[2].as_str()],
        ];
        let northing = (points[0].northing + points[1].northing + points[2].northing) / 3.0;
        let easting = (points[0].easting + points[1].easting + points[2].easting) / 3.0;
        assert!(
            !(4.0 < northing && northing < 6.0 && 4.0 < easting && easting < 6.0),
            "triangle centroid is in the hole"
        );
    }
    let constrained_breakline = [
        surface
            .points
            .iter()
            .find(|point| point.northing == 0.0 && point.easting == 2.0)
            .expect("breakline start")
            .id
            .as_str(),
        surface
            .points
            .iter()
            .find(|point| point.northing == 10.0 && point.easting == 2.0)
            .expect("breakline end")
            .id
            .as_str(),
    ];
    assert!(
        surface.faces.iter().any(|face| {
            (0..3).any(|index| {
                let edge = [&face[index][..], &face[(index + 1) % 3][..]];
                edge == constrained_breakline
                    || edge == [constrained_breakline[1], constrained_breakline[0]]
            })
        }),
        "the generated mesh must retain the standard breakline as a constraint edge"
    );
    // Exact plan area proves the hole was excluded without overlap or a gap;
    // all outer, hole, and breakline rules must be actual mesh edges, so no
    // emitted face can cut across a declared constraint (#5043).
    assert!((generated_area(surface) - 96.0).abs() < 1e-9);
    for (a, b) in [
        ([0.0, 0.0], [0.0, 2.0]),
        ([0.0, 2.0], [0.0, 10.0]),
        ([0.0, 10.0], [10.0, 10.0]),
        ([10.0, 10.0], [10.0, 2.0]),
        ([10.0, 2.0], [10.0, 0.0]),
        ([10.0, 0.0], [0.0, 0.0]),
        ([4.0, 4.0], [4.0, 6.0]),
        ([4.0, 6.0], [6.0, 6.0]),
        ([6.0, 6.0], [6.0, 4.0]),
        ([6.0, 4.0], [4.0, 4.0]),
        ([0.0, 2.0], [10.0, 2.0]),
    ] {
        assert!(
            has_generated_edge(surface, a, b),
            "missing constrained edge {a:?}–{b:?}"
        );
    }
    Ok(())
}

#[test]
fn issue_5043_triangulates_disconnected_outers_and_recovers_split_boundary_breaklines(
) -> Result<(), Box<dyn std::error::Error>> {
    let disconnected = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 2 0 2 2 0 2 0 0</PntList3D></Boundary><Boundary bndType="outer"><PntList3D>10 10 0 10 12 0 12 12 0 12 10 0</PntList3D></Boundary></Boundaries>"#;
    let parsed = parse(faceless_tin(disconnected, "", "").as_bytes())?;
    let surface = &parsed.surfaces[0];
    assert_eq!(
        surface.topology_origin,
        LandXmlTopologyOrigin::ConstrainedTriangulation
    );
    assert!(
        (generated_area(surface) - 8.0).abs() < 1e-9,
        "two 2 m² islands only"
    );

    let outer = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries>"#;
    let split = r#"<Breaklines><Breakline brkType="standard"><PntList3D>0 5 0 10 5 0</PntList3D></Breakline></Breaklines>"#;
    let parsed = parse(faceless_tin(outer, split, "").as_bytes())?;
    let surface = &parsed.surfaces[0];
    for (a, b) in [
        ([0.0, 0.0], [0.0, 5.0]),
        ([0.0, 5.0], [0.0, 10.0]),
        ([0.0, 5.0], [10.0, 5.0]),
        ([10.0, 0.0], [10.0, 5.0]),
        ([10.0, 5.0], [10.0, 10.0]),
    ] {
        assert!(
            has_generated_edge(surface, a, b),
            "split constraint edge {a:?}–{b:?}"
        );
    }
    assert!((generated_area(surface) - 100.0).abs() < 1e-9);
    Ok(())
}

#[test]
fn issue_5043_preserves_positive_near_collinear_slope_faces_and_repeat_determinism(
) -> Result<(), Box<dyn std::error::Error>> {
    let outer = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 20 10 10 30 10 0 10</PntList3D></Boundary></Boundaries>"#;
    let near_collinear = r#"<Breaklines><Breakline brkType="standard"><PntList3D>0 5 10 5 5.000000000001 15.000000000002 10 5 20</PntList3D></Breakline></Breaklines>"#;
    let source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="slope"><Definition surfType="TIN">{outer}{near_collinear}</Definition></Surface></Surfaces></LandXML>"#
    );
    let first = parse(source.as_bytes())?;
    let second = parse(source.as_bytes())?;
    assert_eq!(
        first, second,
        "identical source has deterministic generated topology"
    );
    let surface = &first.surfaces[0];
    assert!((generated_area(surface) - 100.0).abs() < 1e-9);
    let points: std::collections::HashMap<_, _> = surface
        .points
        .iter()
        .map(|point| (point.id.as_str(), point))
        .collect();
    for face in &surface.faces {
        let vertices = [
            points[face[0].as_str()],
            points[face[1].as_str()],
            points[face[2].as_str()],
        ];
        let signed_area = (vertices[1].northing - vertices[0].northing)
            * (vertices[2].easting - vertices[0].easting)
            - (vertices[1].easting - vertices[0].easting)
                * (vertices[2].northing - vertices[0].northing);
        assert!(
            signed_area.abs() > 1e-12,
            "near-collinear face remains non-degenerate"
        );
        // Barycentric interpolation over the known z = northing + 2·easting
        // plane must reproduce the same height for every generated triangle.
        let weights = [0.2, 0.3, 0.5];
        let northing = weights
            .iter()
            .zip(vertices)
            .map(|(weight, point)| weight * point.northing)
            .sum::<f64>();
        let easting = weights
            .iter()
            .zip(vertices)
            .map(|(weight, point)| weight * point.easting)
            .sum::<f64>();
        let elevation = weights
            .iter()
            .zip(vertices)
            .map(|(weight, point)| weight * point.elevation)
            .sum::<f64>();
        assert!((elevation - (northing + 2.0 * easting)).abs() < 1e-9);
    }
    Ok(())
}

#[test]
fn issue_5043_accepts_affine_split_elevation_rounding_on_exact_constraints(
) -> Result<(), Box<dyn std::error::Error>> {
    // On z = easting, the endpoint at easting 1 is a collinear split of the
    // 49 m boundary edge. Its mathematically exact Z is 1, while the affine
    // interpolation happens to round to 0.9999999999999999 in binary64.
    let source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="affine"><Definition surfType="TIN"><Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 49 49 10 49 49 10 0 0</PntList3D></Boundary></Boundaries><Breaklines><Breakline brkType="standard"><PntList3D>0 1 1 10 1 1</PntList3D></Breakline></Breaklines></Definition></Surface></Surfaces></LandXML>"#
    );
    let parsed = parse(source.as_bytes())?;
    let surface = &parsed.surfaces[0];
    assert_eq!(
        surface.topology_origin,
        LandXmlTopologyOrigin::ConstrainedTriangulation
    );
    assert_eq!(surface.terrain_diagnostic, None);
    assert!(has_generated_edge(surface, [0.0, 1.0], [10.0, 1.0]));
    assert!((generated_area(surface) - 490.0).abs() < 1e-9);
    Ok(())
}

#[test]
fn issue_5043_preserves_faceless_tin_on_conflicting_elevation_or_crossing_constraints(
) -> Result<(), Box<dyn std::error::Error>> {
    let boundary = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries>"#;
    let conflicting = r#"<Breaklines><Breakline brkType="standard"><PntList3D>0 0 2 10 10 2</PntList3D></Breakline></Breaklines>"#;
    let parsed = parse(faceless_tin(boundary, conflicting, "").as_bytes())?;
    assert_eq!(
        parsed.surfaces[0].topology_origin,
        LandXmlTopologyOrigin::PreservedOnly
    );
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::ConflictingElevation)
    );
    let crossing = r#"<Breaklines><Breakline brkType="standard"><PntList3D>0 0 0 10 10 0</PntList3D></Breakline><Breakline brkType="standard"><PntList3D>0 10 0 10 0 0</PntList3D></Breakline></Breaklines>"#;
    let parsed = parse(faceless_tin(boundary, crossing, "").as_bytes())?;
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::IntersectingConstraints)
    );
    Ok(())
}

#[test]
fn issue_5043_never_retriangulates_authored_faces_and_bounds_faceless_work(
) -> Result<(), Box<dyn std::error::Error>> {
    let unsupported = r#"<Boundaries><Boundary bndType="mystery"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries>"#;
    let authored = r#"<Faces><F>1 2 3</F></Faces>"#;
    let parsed = parse(faceless_tin(unsupported, "", authored).as_bytes())?;
    assert_eq!(
        parsed.surfaces[0].topology_origin,
        LandXmlTopologyOrigin::AuthoredFaces
    );
    assert_eq!(
        parsed.surfaces[0].faces,
        vec![["1".to_owned(), "2".to_owned(), "3".to_owned()]]
    );
    let outer = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries>"#;
    let many_breaklines = format!(
        "<Breaklines>{}</Breaklines>",
        (0..40)
            .map(|index| format!(
                "<Breakline brkType=\"standard\"><PntList3D>0 {} 0 10 {} 0</PntList3D></Breakline>",
                index + 20,
                index + 20
            ))
            .collect::<String>()
    );
    let limits = LandXmlLimits {
        max_work: 1_000,
        ..LandXmlLimits::default()
    };
    let parsed = parse_landxml_tin_with_cancel(
        faceless_tin(outer, &many_breaklines, "").as_bytes(),
        &limits,
        None,
    )?;
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::WorkLimitExceeded)
    );
    Ok(())
}

#[test]
fn issue_5043_refuses_collinear_elevation_conflicts_and_overlapping_breaklines(
) -> Result<(), Box<dyn std::error::Error>> {
    let outer = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries>"#;
    let inconsistent = r#"<Breaklines><Breakline brkType="standard"><PntList3D>0 5 1 10 5 1</PntList3D></Breakline></Breaklines>"#;
    let parsed = parse(faceless_tin(outer, inconsistent, "").as_bytes())?;
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::ConflictingElevation)
    );
    let repeated = r#"<Breaklines><Breakline brkType="standard"><PntList3D>0 3 0 10 3 0</PntList3D></Breakline><Breakline brkType="standard"><PntList3D>10 3 0 0 3 0</PntList3D></Breakline></Breaklines>"#;
    let parsed = parse(faceless_tin(outer, repeated, "").as_bytes())?;
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::IntersectingConstraints)
    );
    Ok(())
}

#[test]
fn issue_5043_refuses_pinched_and_bow_tie_outer_rings() -> Result<(), Box<dyn std::error::Error>> {
    let pinched = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 0 10 0 10 0 0</PntList3D></Boundary></Boundaries>"#;
    let parsed = parse(faceless_tin(pinched, "", "").as_bytes())?;
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::DegenerateConstraints)
    );
    let bow_tie = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 10 10 0 0 10 0 10 0 0</PntList3D></Boundary></Boundaries>"#;
    let parsed = parse(faceless_tin(bow_tie, "", "").as_bytes())?;
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::IntersectingConstraints)
    );
    Ok(())
}

#[test]
fn issue_5043_refuses_a_boundary_vertex_touching_a_nonadjacent_edge(
) -> Result<(), Box<dyn std::error::Error>> {
    let touching = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 4 0 4 4 0 0 2 0 4 0 0</PntList3D></Boundary></Boundaries>"#;
    let parsed = parse(faceless_tin(touching, "", "").as_bytes())?;
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::DegenerateConstraints),
    );
    Ok(())
}

#[test]
fn issue_5043_keeps_source_data_vertices_resolvable_by_generated_faces(
) -> Result<(), Box<dyn std::error::Error>> {
    let source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries></Definition><SourceData><DataPoints><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></DataPoints></SourceData></Surface></Surfaces></LandXML>"#
    );
    let parsed = parse(source.as_bytes())?;
    let surface = &parsed.surfaces[0];
    let ids: std::collections::HashSet<_> = surface
        .points
        .iter()
        .map(|point| point.id.as_str())
        .collect();
    assert!(surface
        .faces
        .iter()
        .flatten()
        .all(|id| ids.contains(id.as_str())));
    assert!(surface.points.iter().any(|point| point
        .id
        .starts_with("terrain:landxml:surface:1:source-point:")));
    Ok(())
}

#[test]
fn issue_5043_keeps_coincident_source_records_and_maps_them_to_one_vertex(
) -> Result<(), Box<dyn std::error::Error>> {
    let source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 0 0</P><P id="3">0 10 0</P><P id="4">10 10 0</P><P id="5">10 0 0</P></Pnts><Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries></Definition></Surface></Surfaces></LandXML>"#
    );
    let parsed = parse(source.as_bytes())?;
    let surface = &parsed.surfaces[0];
    assert!(surface.points.iter().any(|point| point.id == "1"));
    assert!(surface.points.iter().any(|point| point.id == "2"));
    let canonical = surface
        .canonical_vertices
        .iter()
        .find(|vertex| vertex.northing == 0.0 && vertex.easting == 0.0)
        .expect("coincident source vertex maps to a canonical vertex");
    assert!(canonical
        .contributor_source_ids
        .iter()
        .any(|id| id.0.ends_with(":point:1")));
    assert!(canonical
        .contributor_source_ids
        .iter()
        .any(|id| id.0.ends_with(":point:2")));
    Ok(())
}

#[test]
fn issue_5043_enforces_document_wide_generated_face_and_reference_limits() {
    let outer = r#"<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries>"#;
    let source = faceless_tin(outer, "", "");
    for limits in [
        LandXmlLimits {
            max_faces: 0,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_references: 5,
            ..LandXmlLimits::default()
        },
    ] {
        assert_eq!(
            parse_landxml_tin_with_cancel(source.as_bytes(), &limits, None)
                .unwrap_err()
                .code,
            LandXmlDiagnosticCode::LimitExceeded
        );
    }
    let surface_xml = source
        .split("<Surfaces>")
        .nth(1)
        .and_then(|value| value.split("</Surfaces>").next())
        .expect("surface XML");
    let twice = source.replacen(surface_xml, &format!("{surface_xml}{surface_xml}"), 1);
    let limits = LandXmlLimits {
        max_faces: 3,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(twice.as_bytes(), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
}

#[test]
fn issue_5043_rejects_unaffordable_split_elevation_work_before_the_quadratic_scan() {
    // 9,001 vertices × 9,000 constrained segments is more than 81 million
    // elevation comparisons. A two-million-work budget must decline this at
    // the preflight estimate, not spend seconds in the uncharged scan before
    // the CDT can observe its work callback.
    let points = (0..9_001)
        .map(|index| format!("<P id=\"{}\">{index} 0 0</P>", index + 1))
        .collect::<String>();
    let breaklines = (0..9_000)
        .map(|index| {
            format!(
            "<Breakline brkType=\"standard\"><PntList3D>{index} 0 0 {} 0 0</PntList3D></Breakline>",
            index + 1,
        )
        })
        .collect::<String>();
    let source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts>{points}</Pnts><Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries><Breaklines>{breaklines}</Breaklines></Definition></Surface></Surfaces></LandXML>"#,
    );
    let parsed = parse_landxml_tin_with_cancel(
        source.as_bytes(),
        &LandXmlLimits {
            max_work: 2_000_000,
            ..LandXmlLimits::default()
        },
        None,
    )
    .expect("preflight work refusal preserves the source document");
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::WorkLimitExceeded),
    );
}

#[test]
fn issue_5043_rejects_unaffordable_simple_ring_work_before_pairwise_topology_checks() {
    // A malformed 601-vertex boundary needs ~180k edge-pair checks.  The
    // parser must decline it from the topology preflight instead of entering
    // an uninterruptible quadratic simple-ring validation pass.
    let ring = (0..=600)
        .map(|index| format!("{index} 0 0"))
        .collect::<Vec<_>>()
        .join(" ");
    let boundary = format!(
        "<Boundaries><Boundary bndType=\"outer\"><PntList3D>{ring}</PntList3D></Boundary></Boundaries>"
    );
    let parsed = parse_landxml_tin_with_cancel(
        faceless_tin(&boundary, "", "").as_bytes(),
        &LandXmlLimits {
            max_work: 10_000,
            ..LandXmlLimits::default()
        },
        None,
    )
    .expect("optional terrain refusal preserves the source record");
    assert_eq!(
        parsed.surfaces[0]
            .terrain_diagnostic
            .as_ref()
            .map(|value| value.code),
        Some(LandXmlTerrainDiagnosticCode::WorkLimitExceeded),
    );
}

impl CancelsAfterPolls {
    fn new(cancel_after: usize) -> Self {
        Self {
            cancel_after,
            polls: AtomicUsize::new(0),
        }
    }
    fn polls(&self) -> usize {
        self.polls.load(Ordering::Relaxed)
    }
}

impl LandXmlCancellation for CancelsAfterPolls {
    fn is_cancelled(&self) -> bool {
        self.polls.fetch_add(1, Ordering::Relaxed) >= self.cancel_after
    }
}

fn document(surface_name: &str) -> Vec<u8> {
    format!(r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="{surface_name}"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#).into_bytes()
}

fn road_document() -> Vec<u8> {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="terrain"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces><Alignments><Alignment name="A" length="300" staStart="100"><CoordGeom/><Profile><ProfAlign name="design"><PVI>100 20</PVI><ParaCurve length="40">140 21</ParaCurve><CircCurve length="30" radius="250">180 23</CircCurve><UnsymParaCurve lengthIn="10" lengthOut="20">220 24</UnsymParaCurve></ProfAlign><ProfSurf name="ground"><PntList2D>100 19 150 20</PntList2D><PntList2D>200 22 250 23</PntList2D></ProfSurf><ProfSurf name="survey"><PntList2D>100 18 300 25</PntList2D></ProfSurf></Profile><CrossSects><CrossSect sta="140"><CrossSectSurf name="existing"><PntList2D>-5 19 0 20 5 19</PntList2D><PntList2D>10 18 15 17</PntList2D></CrossSectSurf><DesignCrossSectSurf name="pavement"><CrossSectPnt alignRef="A">-4 20</CrossSectPnt><CrossSectPnt>4 20.5</CrossSectPnt></DesignCrossSectSurf></CrossSect></CrossSects></Alignment></Alignments><Roadways><Roadway name="Route 1" alignmentRefs="A missing" surfaceRefs="terrain absent" gradeModelRefs="grade"/><Roadway name="Route 2" alignmentRefs="A"><Lanes/></Roadway></Roadways></LandXML>"#
    )
    .into_bytes()
}

fn cross_section_document(points: &str) -> Vec<u8> {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Alignments><Alignment name="A" length="300" staStart="100"><CoordGeom/><CrossSects><CrossSect sta="140"><DesignCrossSectSurf name="pavement">{points}</DesignCrossSectSurf></CrossSect></CrossSects></Alignment></Alignments></LandXML>"#
    )
    .into_bytes()
}

fn extension_document() -> Vec<u8> {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:ext="urn:vendor" version="1.2"><Units><Metric linearUnit="meter"/></Units><Alignments><Alignment name="A" length="1" staStart="0"><CoordGeom/></Alignment></Alignments><Roadways><Roadway name="Route" alignmentRefs="A"><Lanes/><ext:Corridor/><ext:StringLine/></Roadway></Roadways></LandXML>"#
    )
    .into_bytes()
}

fn utf16_document(little_endian: bool) -> Vec<u8> {
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-16"?><LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    let mut bytes = if little_endian {
        vec![0xff, 0xfe]
    } else {
        vec![0xfe, 0xff]
    };
    for unit in document.encode_utf16() {
        let pair = if little_endian {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        };
        bytes.extend(pair);
    }
    bytes
}

fn utf16_le(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xfe];
    for unit in text.encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    bytes
}

fn padded_document(padding_bytes: usize) -> String {
    let document = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    format!("<!--{}-->{document}", "x".repeat(padding_bytes))
}

fn parse(
    bytes: &[u8],
) -> Result<ifc_lite_landxml::LandXmlTinDocument, ifc_lite_landxml::LandXmlError> {
    parse_landxml_tin_with_cancel(bytes, &LandXmlLimits::default(), None)
}

#[test]
fn parses_raw_bytes_into_durable_semantic_source_records() -> Result<(), Box<dyn std::error::Error>>
{
    let parsed = parse(&document("grade"))?;
    assert_eq!(parsed.version, "1.2");
    assert_eq!(
        parsed
            .units
            .as_ref()
            .expect("fixture has units")
            .linear_scale_to_meters,
        1.0
    );
    assert_eq!(parsed.surfaces.len(), 1);
    assert_eq!(parsed.surfaces[0].source_id.0, "landxml:surface:1");
    assert_eq!(
        parsed.surfaces[0].faces,
        vec![["1".to_owned(), "2".to_owned(), "3".to_owned()]]
    );
    Ok(())
}

#[test]
fn retains_source_terrain_records_without_guessing_grid_topology(
) -> Result<(), Box<dyn std::error::Error>> {
    let xml = format!(
        r#"
<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:vendor="urn:survey-vendor" version="1.2">
  <Units><Metric linearUnit="meter"/></Units>
  <Surfaces>
    <Surface name="EG"><Definition surfType="TIN"><Pnts>
      <P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P>
    </Pnts><Faces><F>1 2 3</F><F i="true">1 3 2</F></Faces>
    </Definition><SourceData><DataPoints><PntList3D>0 0 0 0 1 0</PntList3D></DataPoints>
    <Boundaries><Boundary name="Outer" bndType="outer" edgeTrim="true"><PntList3D>0 0 0 0 1 0</PntList3D></Boundary></Boundaries>
    <Breaklines><Breakline name="Crown" brkType="standard"><PntList2D>0 0 1 1</PntList2D></Breakline></Breaklines>
    <Contours><Contour name="Index" contType="major"><PntList3D>0 0 0 1 0 0</PntList3D></Contour></Contours>
    </SourceData></Surface>
    <Surface name="Grid"><Definition surfType="GRID"/></Surface>
  </Surfaces>
  <vendor:ProducerSetting value="kept-as-a-record"/>
</LandXML>"#
    );
    let parsed = parse(xml.as_bytes())?;
    let tin = &parsed.surfaces[0];
    assert_eq!(tin.source_id.0, "landxml:surface:1");
    assert_eq!(tin.ordinal, 1);
    assert_eq!(tin.source_path, "LandXML/Surfaces/Surface[1]");
    assert_eq!(tin.properties.get("name").map(String::as_str), Some("EG"));
    assert_eq!(
        tin.definition_properties
            .get("surfType")
            .map(String::as_str),
        Some("TIN")
    );
    assert_eq!(tin.points[0].source_id.0, "landxml:surface:1:point:1");
    assert_eq!(tin.face_source_ids[0].0, "landxml:surface:1:face:1");
    assert_eq!(tin.hidden_face_count, 1);
    assert_eq!(tin.face_visibility, vec![true, false]);
    assert_eq!(tin.source_data_points.len(), 2);
    assert_eq!(
        tin.source_data_points[0].source_id.0,
        "landxml:surface:1:source-point:1"
    );
    assert_eq!(
        tin.boundaries[0].source_id.0,
        "landxml:surface:1:boundary:1"
    );
    assert_eq!(tin.boundaries[0].name.as_deref(), Some("Outer"));
    assert_eq!(tin.boundaries[0].kind.as_deref(), Some("outer"));
    assert_eq!(
        tin.boundaries[0]
            .properties
            .get("edgeTrim")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(
        tin.breaklines[0].source_id.0,
        "landxml:surface:1:breakline:1"
    );
    assert_eq!(tin.breaklines[0].name.as_deref(), Some("Crown"));
    assert_eq!(tin.breaklines[0].coordinate_dimension, 2);
    assert_eq!(
        tin.breaklines[0].point_source_ids[0].0,
        "landxml:surface:1:breakline:1:point:1"
    );
    assert_eq!(tin.contours[0].source_id.0, "landxml:surface:1:contour:1");
    assert_eq!(tin.contours[0].kind.as_deref(), Some("major"));
    assert_eq!(
        parsed.surfaces[1].render_state,
        ifc_lite_landxml::LandXmlRenderState::PreservedOnly
    );
    assert_eq!(parsed.extensions[0].namespace, "urn:survey-vendor");
    assert_eq!(parsed.extensions[0].path, "LandXML/ProducerSetting");
    assert!(parsed
        .warnings
        .iter()
        .any(|warning| warning.contains("1 unknown vendor extension")));
    assert!(parsed.capabilities.renderable_tin);
    assert_eq!(parsed.capabilities.preserved_only_surfaces, 1);
    Ok(())
}

#[test]
fn retains_geometry_free_documents_as_honest_source_records(
) -> Result<(), Box<dyn std::error::Error>> {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Surfaces><Surface name="survey-only"><Definition surfType="VOLUME"/></Surface></Surfaces></LandXML>"#
    );
    let parsed = parse(xml.as_bytes())?;
    assert!(parsed.units.is_none());
    assert_eq!(parsed.surfaces.len(), 1);
    assert_eq!(
        parsed.surfaces[0].render_state,
        ifc_lite_landxml::LandXmlRenderState::PreservedOnly
    );
    Ok(())
}

#[test]
fn bounds_preserved_vendor_extension_roots() {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:v="urn:vendor" version="1.2"><Units><Metric linearUnit="meter"/></Units><v:One/><v:Two/></LandXML>"#
    );
    let limits = LandXmlLimits {
        max_extensions: 1,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(xml.as_bytes(), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded,
    );
}

#[test]
fn bounds_source_data_and_overlay_vertices_with_the_global_point_limit() {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Surfaces><Surface name="survey"><Definition surfType="VOLUME"/><SourceData><DataPoints><PntList3D>0 0 0 1 1 1</PntList3D></DataPoints><Breaklines><Breakline><PntList2D>0 0 1 1</PntList2D></Breakline></Breaklines></SourceData></Surface></Surfaces></LandXML>"#
    );
    for max_points in [1, 2, 3] {
        let error = parse_landxml_tin_with_cancel(
            xml.as_bytes(),
            &LandXmlLimits {
                max_points,
                ..LandXmlLimits::default()
            },
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, LandXmlDiagnosticCode::LimitExceeded);
    }
}

#[test]
fn requires_exact_namespace_and_version() {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    assert_eq!(
        parse(valid.replace(LANDXML_12_NAMESPACE, "urn:vendor").as_bytes())
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::UnsupportedNamespace
    );
    assert_eq!(
        parse(
            valid
                .replace("version=\"1.2\"", "version=\"1.1\"")
                .as_bytes()
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::UnsupportedVersion
    );
    assert_eq!(
        parse(valid.replace(" version=\"1.2\"", "").as_bytes())
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::UnsupportedVersion
    );
}

#[test]
fn classifies_known_versions_but_keeps_12_as_the_only_ingest_capability() {
    assert_eq!(
        classify_landxml_version(Some(LANDXML_10_NAMESPACE), Some("1.0")),
        LandXmlVersionCapability::LandXml10Unsupported
    );
    assert_eq!(
        classify_landxml_version(Some(LANDXML_11_NAMESPACE), Some("1.1")),
        LandXmlVersionCapability::LandXml11Unsupported
    );
    assert_eq!(
        classify_landxml_version(Some(LANDXML_12_NAMESPACE), Some("1.2")),
        LandXmlVersionCapability::LandXml12Tin
    );
    assert_eq!(
        classify_landxml_version(Some(LANDXML_12_NAMESPACE), Some("1.1")),
        LandXmlVersionCapability::LandXml12VersionMismatch
    );
    assert_eq!(
        classify_landxml_version(Some("urn:vendor"), Some("1.2")),
        LandXmlVersionCapability::NotLandXml
    );
    assert!(LandXmlVersionCapability::LandXml12Tin.supports_tin_ingestion());
    assert!(!LandXmlVersionCapability::LandXml11Unsupported.supports_tin_ingestion());

    for (namespace, version) in [(LANDXML_10_NAMESPACE, "1.0"), (LANDXML_11_NAMESPACE, "1.1")] {
        let input = String::from_utf8(document("grade"))
            .expect("fixture is UTF-8")
            .replace(LANDXML_12_NAMESPACE, namespace)
            .replace("version=\"1.2\"", &format!("version=\"{version}\""));
        assert_eq!(
            parse(input.as_bytes()).unwrap_err().code,
            LandXmlDiagnosticCode::UnsupportedVersion
        );
    }
}

#[test]
fn refuses_dtd_and_entity_expansion_before_xml_parse() {
    let dtd = br#"<!DOCTYPE LandXML [<!ENTITY boom "x">]><LandXML/>"#;
    assert_eq!(
        parse(dtd).unwrap_err().code,
        LandXmlDiagnosticCode::DtdForbidden
    );
    let entity = parse(&document("grade &amp; survey")).expect("predefined entity is legal");
    assert_eq!(entity.surfaces[0].name, "grade & survey");
    let custom_entity = document("grade &custom; survey");
    assert_eq!(
        parse(&custom_entity).unwrap_err().code,
        LandXmlDiagnosticCode::EntityForbidden
    );
    let limits = LandXmlLimits {
        max_character_references: 0,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(&document("grade &amp; survey"), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
}

#[test]
fn allows_dtd_words_inside_comments_and_cdata() -> Result<(), Box<dyn std::error::Error>> {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    let input = valid.replace(
        "<Units>",
        "<!-- literal <!DOCTYPE LandXML> is not a declaration --><![CDATA[<!ENTITY safe 'text'>]]><Units>",
    );
    assert_eq!(parse(input.as_bytes())?.surfaces[0].name, "grade");
    Ok(())
}

#[test]
fn allows_an_xml_stylesheet_processing_instruction_before_the_root() {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    let input = format!("<?xml-stylesheet type=\"text/xsl\" href=\"terrain.xsl\"?>{valid}");
    assert_eq!(parse(input.as_bytes()).unwrap().surfaces.len(), 1);
}

#[test]
fn issue_5084_refuses_multiple_roots_and_non_whitespace_outside_the_root() {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    for (index, input) in [
        format!("{valid}{valid}"),
        format!("outside-before{valid}"),
        format!("{valid}outside-after"),
        format!("\u{a0}{valid}"),
        format!("&#32;{valid}"),
        format!("{valid}<![CDATA[ ]]>"),
    ]
    .into_iter()
    .enumerate()
    {
        let error = parse(input.as_bytes()).expect_err(&format!("input {index}: {input}"));
        assert_eq!(error.code, LandXmlDiagnosticCode::InvalidXml);
    }
    let misc = format!(" \n<?xml-stylesheet type=\"text/xsl\" href=\"terrain.xsl\"?>{valid}<!-- legal misc after root --><?post-root ok?>\t");
    assert_eq!(parse(misc.as_bytes()).unwrap().surfaces.len(), 1);
}

#[test]
fn issue_5084_keeps_cdata_literal_in_numeric_captures() {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    let literal_reference = valid.replace(
        r#"<P id="1">0 0 0</P>"#,
        r#"<P id="1"><![CDATA[&#49; 2 3]]></P>"#,
    );
    // Treating CDATA as ordinary text would expand `&#49;` and incorrectly
    // accept this as coordinates. CDATA itself is intentionally literal.
    assert_eq!(
        parse(literal_reference.as_bytes()).unwrap_err().code,
        LandXmlDiagnosticCode::InvalidSemantic,
    );
}

#[test]
fn issue_5084_ignores_foreign_ancestors_with_landxml_named_coordinate_lists(
) -> Result<(), Box<dyn std::error::Error>> {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:v="urn:vendor" version="1.2"><Surfaces><Surface name="survey"><Definition surfType="VOLUME"/><v:SourceData><DataPoints><PntList3D>0 0 0 1 1 1</PntList3D><PntList2D>2 2 3 3</PntList2D></DataPoints><Boundaries><Boundary><PntList3D>0 0 0 1 1 1</PntList3D></Boundary></Boundaries><Breaklines><Breakline><PntList2D>0 0 1 1</PntList2D></Breakline></Breaklines><Contours><Contour><PntList3D>0 0 0 1 1 1</PntList3D></Contour></Contours></v:SourceData></Surface></Surfaces></LandXML>"#
    );
    let parsed = parse(xml.as_bytes())?;
    let surface = &parsed.surfaces[0];
    assert!(
        surface.source_data_points.is_empty(),
        "foreign SourceData must not supply PntList3D or PntList2D"
    );
    assert!(
        surface.boundaries.is_empty(),
        "foreign Boundaries must not become terrain rings"
    );
    assert!(
        surface.breaklines.is_empty(),
        "foreign Breaklines must not become terrain lines"
    );
    assert!(
        surface.contours.is_empty(),
        "foreign Contours must not become terrain contours"
    );
    Ok(())
}

#[test]
fn issue_5084_refuses_foreign_descendant_text_for_point_and_face_captures() {
    let point_from_foreign_descendant = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:v="urn:vendor" version="1.2"><Surfaces><Surface name="survey"><Definition surfType="TIN"><Pnts><P id="1"><v:coords>0 0 0</v:coords></P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    assert_eq!(
        parse(point_from_foreign_descendant.as_bytes())
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::InvalidSemantic,
    );
    let face_from_foreign_descendant = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:v="urn:vendor" version="1.2"><Surfaces><Surface name="survey"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F><v:refs>1 2 3</v:refs></F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    assert_eq!(
        parse(face_from_foreign_descendant.as_bytes())
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::InvalidSemantic,
    );
}

#[test]
fn issue_5084_coordinate_list_paths_include_every_sibling_ancestor(
) -> Result<(), Box<dyn std::error::Error>> {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Surfaces><Surface name="first"><Definition surfType="VOLUME"/><SourceData><DataPoints><PntList3D>0 0 0</PntList3D><PntList3D>1 1 1</PntList3D></DataPoints><Boundaries><Boundary><PntList3D>0 0 0 1 1 1</PntList3D></Boundary></Boundaries><Boundaries><Boundary><PntList3D>2 2 2 3 3 3</PntList3D></Boundary></Boundaries></SourceData><SourceData><DataPoints><PntList3D>2 2 2</PntList3D></DataPoints></SourceData></Surface><Surface name="second"><Definition surfType="VOLUME"/><SourceData><DataPoints><PntList3D>3 3 3</PntList3D></DataPoints></SourceData></Surface></Surfaces></LandXML>"#
    );
    let parsed = parse(xml.as_bytes())?;
    let source_paths: Vec<&str> = parsed.surfaces[0]
        .source_data_points
        .iter()
        .map(|point| point.source_path.as_str())
        .collect();
    assert_eq!(
        source_paths,
        vec![
            "LandXML/Surfaces[1]/Surface[1]/SourceData[1]/DataPoints[1]/PntList3D[1]",
            "LandXML/Surfaces[1]/Surface[1]/SourceData[1]/DataPoints[1]/PntList3D[2]",
            "LandXML/Surfaces[1]/Surface[1]/SourceData[2]/DataPoints[1]/PntList3D[1]",
        ],
    );
    let boundary_paths: Vec<&str> = parsed.surfaces[0]
        .boundaries
        .iter()
        .map(|line| line.source_path.as_str())
        .collect();
    assert_eq!(
        boundary_paths,
        vec![
            "LandXML/Surfaces[1]/Surface[1]/SourceData[1]/Boundaries[1]/Boundary[1]/PntList3D[1]",
            "LandXML/Surfaces[1]/Surface[1]/SourceData[1]/Boundaries[2]/Boundary[1]/PntList3D[1]",
        ],
    );
    assert_eq!(
        parsed.surfaces[1].source_data_points[0].source_path,
        "LandXML/Surfaces[1]/Surface[2]/SourceData[1]/DataPoints[1]/PntList3D[1]",
    );
    Ok(())
}

#[test]
fn parses_utf16_le_and_be_raw_bytes() -> Result<(), Box<dyn std::error::Error>> {
    for little_endian in [true, false] {
        let parsed = parse(&utf16_document(little_endian))?;
        assert_eq!(parsed.surfaces[0].name, "grade");
        assert_eq!(parsed.surfaces[0].faces.len(), 1);
    }
    Ok(())
}

#[test]
fn enforces_limits_and_cancellation() {
    let input = document("grade");
    let limits = LandXmlLimits {
        max_points: 2,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(&input, &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    let cancelled = LandXmlCancellationFlag::new();
    cancelled.cancel();
    assert_eq!(
        parse_landxml_tin_with_cancel(&input, &LandXmlLimits::default(), Some(&cancelled))
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::Cancelled
    );
}

#[test]
fn cancels_mid_normalization_of_a_large_utf8_source() {
    // The cancellation fires on the fourth poll: after three full 4 KiB
    // chunks, while the UTF-8 normalizer is still copying/validating input.
    let cancelled = CancelsAfterPolls::new(3);
    let input = padded_document(32 * 1024);
    assert_eq!(
        parse_landxml_tin_with_cancel(
            input.as_bytes(),
            &LandXmlLimits::default(),
            Some(&cancelled)
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::Cancelled
    );
    assert_eq!(cancelled.polls(), 4);
}

#[test]
fn rejects_a_continuation_byte_run_at_a_utf8_chunk_boundary() {
    // The normalizer must not rewind an entire 4 KiB chunk and then retry the
    // same empty slice forever when untrusted input is all continuation bytes.
    let input = vec![0x80; 4 * 1024 + 1];
    assert_eq!(
        parse(&input).unwrap_err().code,
        LandXmlDiagnosticCode::InvalidXml
    );
}

#[test]
fn cancels_mid_preflight_scan_of_a_large_utf16_source() {
    // UTF-16 decoding consumes eight 4 KiB raw chunks first. The next poll is
    // the scanner's initial guard and the following one is inside its long
    // comment, proving that pre-quick-xml scanning is also interruptible.
    let cancelled = CancelsAfterPolls::new(10);
    let input = utf16_le(&padded_document(16 * 1024));
    assert_eq!(
        parse_landxml_tin_with_cancel(&input, &LandXmlLimits::default(), Some(&cancelled))
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::Cancelled
    );
    assert_eq!(cancelled.polls(), 11);
}

#[test]
fn applies_structural_and_semantic_resource_limits() {
    let input = document("grade");
    for limits in [
        LandXmlLimits {
            max_bytes: 8,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_depth: 1,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_name_bytes: 3,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_attributes: 1,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_attribute_bytes: 2,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_text_bytes: 2,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_surfaces: 0,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_faces: 0,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_references: 2,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_work: 1,
            ..LandXmlLimits::default()
        },
    ] {
        let error = parse_landxml_tin_with_cancel(&input, &limits, None).unwrap_err();
        assert!(matches!(
            error.code,
            LandXmlDiagnosticCode::InputTooLarge | LandXmlDiagnosticCode::LimitExceeded
        ));
    }
}

#[test]
fn applies_record_limits_across_all_surfaces_before_output_growth() {
    let valid = String::from_utf8(document("first")).expect("fixture is UTF-8");
    let second = valid
        .split_once("<Surfaces>")
        .and_then(|(_, remainder)| remainder.split_once("</Surfaces>"))
        .map(|(surface, _)| surface.replace("name=\"first\"", "name=\"second\""))
        .expect("fixture has one Surfaces container");
    let two_surfaces = valid.replace("</Surfaces>", &format!("{second}</Surfaces>"));

    for limits in [
        LandXmlLimits {
            max_surfaces: 1,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_points: 5,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_faces: 1,
            ..LandXmlLimits::default()
        },
    ] {
        assert_eq!(
            parse_landxml_tin_with_cancel(two_surfaces.as_bytes(), &limits, None)
                .unwrap_err()
                .code,
            LandXmlDiagnosticCode::LimitExceeded
        );
    }
}

#[test]
fn ignores_extension_elements_with_landxml_local_names() -> Result<(), Box<dyn std::error::Error>> {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:vendor="urn:vendor" version="1.2"><Units><Metric linearUnit="meter"/></Units><vendor:Surface name="wrong"><Definition surfType="TIN"/></vendor:Surface><Surfaces><Surface name="right"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    assert_eq!(parse(xml.as_bytes())?.surfaces[0].name, "right");
    Ok(())
}

#[test]
fn ignores_same_namespace_geometry_outside_tin_structure() -> Result<(), Box<dyn std::error::Error>>
{
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Other><Surface name="wrong"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P></Pnts></Definition></Surface></Other><Surfaces><Surface name="right"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    assert_eq!(parse(xml.as_bytes())?.surfaces[0].name, "right");
    Ok(())
}

#[test]
fn rejects_repeated_or_mixed_unit_declarations() {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    let mixed = valid.replace(
        "<Metric linearUnit=\"meter\"/>",
        "<Metric linearUnit=\"meter\"/><Imperial linearUnit=\"foot\"/>",
    );
    assert_eq!(
        parse(mixed.as_bytes()).unwrap_err().code,
        LandXmlDiagnosticCode::InvalidSemantic
    );
}

#[test]
fn issue_5042_uses_the_schema_default_for_omitted_elevation_units() {
    let source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Imperial linearUnit="foot"/></Units></LandXML>"#
    );
    let document = parse(source.as_bytes()).expect("valid LandXML");
    let units = document.units.expect("units");

    assert_eq!(units.linear_unit, "foot");
    assert_eq!(units.linear_scale_to_meters, 0.3048);
    assert_eq!(units.elevation_unit, "meter");
    assert_eq!(units.elevation_scale_to_meters, 1.0);
}

#[test]
fn issue_5042_rejects_empty_or_whitespace_only_documents() {
    for input in [b"".as_slice(), b" \n\t".as_slice()] {
        assert_eq!(
            parse(input).unwrap_err().code,
            LandXmlDiagnosticCode::InvalidXml
        );
    }
}

#[test]
fn preserves_distinct_profiles_curves_sections_and_roadway_associations(
) -> Result<(), Box<dyn std::error::Error>> {
    let parsed = parse(&road_document())?;
    assert_eq!(parsed.alignments.len(), 1);
    let alignment = &parsed.alignments[0];
    assert_eq!(alignment.name, "A");
    assert_eq!(alignment.sta_start, 100.0);
    assert_eq!(
        alignment.profile_source_ids.len(),
        3,
        "multiple profiles stay attached to one alignment"
    );
    assert_eq!(parsed.profiles.len(), 3);
    assert_eq!(parsed.profiles[0].kind, LandXmlProfileKind::Design);
    assert_eq!(parsed.profiles[1].kind, LandXmlProfileKind::Sampled);
    assert_eq!(parsed.profiles[2].kind, LandXmlProfileKind::Sampled);
    assert_eq!(parsed.profiles[0].pvis.len(), 4);
    assert_eq!(parsed.profiles[0].vertical_curves.len(), 3);
    assert_eq!(
        parsed.profiles[0].vertical_curves[0].kind,
        LandXmlVerticalCurveKind::Parabolic
    );
    assert_eq!(parsed.profiles[0].vertical_curves[0].station, 140.0);
    assert_eq!(parsed.profiles[0].vertical_curves[0].length, Some(40.0));
    assert_eq!(
        parsed.profiles[0].vertical_curves[1].kind,
        LandXmlVerticalCurveKind::Circular
    );
    assert_eq!(parsed.profiles[0].vertical_curves[1].radius, Some(250.0));
    assert_eq!(
        parsed.profiles[0].vertical_curves[2].kind,
        LandXmlVerticalCurveKind::UnsymmetricalParabolic
    );
    assert_eq!(parsed.profiles[0].vertical_curves[2].length_in, Some(10.0));
    assert_eq!(parsed.profiles[1].grade_lines.len(), 2);
    assert_eq!(parsed.cross_sections.len(), 1);
    assert_eq!(parsed.cross_sections[0].station, 140.0);
    assert_eq!(
        parsed.cross_sections[0].parent_alignment_source_id,
        alignment.source_id
    );
    assert_eq!(parsed.cross_section_surfaces.len(), 2);
    assert_eq!(
        parsed.cross_section_surfaces[0].segments.len(),
        2,
        "section gaps remain split"
    );
    assert_eq!(
        parsed.cross_section_surfaces[1].points[0].offset,
        Some(-4.0)
    );
    assert_eq!(
        parsed.cross_section_surfaces[1].points[0].elevation,
        Some(20.0)
    );
    assert_eq!(
        parsed.cross_section_surfaces[1].points[0].alignment_source_id,
        Some(alignment.source_id.clone())
    );
    assert_eq!(parsed.roadways.len(), 2);
    assert_eq!(
        parsed.roadways[0].alignment_source_ids,
        vec![alignment.source_id.clone()]
    );
    assert_eq!(
        parsed.roadways[0].surface_source_ids,
        vec![parsed.surfaces[0].source_id.clone()]
    );
    assert!(parsed
        .capability_diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == LandXmlCapabilityDiagnosticCode::MissingReference));
    assert!(
        parsed.preserved_only_extensions.is_empty(),
        "core CoordGeom and ordinary Roadway children are not corridor/stringline extensions"
    );
    assert!(
        parsed
            .capability_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code
                == LandXmlCapabilityDiagnosticCode::SectionDiscontinuity)
    );
    Ok(())
}

#[test]
fn records_missing_elevation_without_fabricating_zero() -> Result<(), Box<dyn std::error::Error>> {
    let source = String::from_utf8(road_document())?
        .replace("<PVI>100 20</PVI>", "<PVI>100</PVI>")
        .replace(
            "<CrossSectPnt alignRef=\"A\">-4 20</CrossSectPnt>",
            "<CrossSectPnt alignRef=\"A\">-4</CrossSectPnt>",
        );
    let parsed = parse(source.as_bytes())?;
    assert_eq!(parsed.profiles[0].pvis[0].elevation, None);
    assert_eq!(parsed.cross_section_surfaces[1].points[0].elevation, None);
    assert_eq!(
        parsed
            .capability_diagnostics
            .iter()
            .filter(
                |diagnostic| diagnostic.code == LandXmlCapabilityDiagnosticCode::MissingElevation
            )
            .count(),
        2
    );
    Ok(())
}

#[test]
fn preserves_profile_review_data_when_no_tin_surface_is_present(
) -> Result<(), Box<dyn std::error::Error>> {
    let source = String::from_utf8(road_document())?;
    let without_tin = source.replace(
        "<Surfaces><Surface name=\"terrain\"><Definition surfType=\"TIN\"><Pnts><P id=\"1\">0 0 0</P><P id=\"2\">0 1 0</P><P id=\"3\">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces>",
        "",
    );
    let parsed = parse(without_tin.as_bytes())?;
    assert!(parsed.surfaces.is_empty());
    assert_eq!(parsed.profiles.len(), 3);
    assert_eq!(parsed.cross_sections.len(), 1);
    assert_eq!(parsed.roadways.len(), 2);
    Ok(())
}

#[test]
fn applies_profile_section_and_roadway_limits_before_output_growth() {
    for limits in [
        LandXmlLimits {
            max_profiles: 0,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_vertical_curves: 0,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_cross_sections: 0,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_cross_section_points: 1,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_roadways: 1,
            ..LandXmlLimits::default()
        },
    ] {
        assert_eq!(
            parse_landxml_tin_with_cancel(&road_document(), &limits, None)
                .unwrap_err()
                .code,
            LandXmlDiagnosticCode::LimitExceeded
        );
    }
}

#[test]
fn issue_5045_cross_section_point_retains_slope_references_and_coordinate_precedence(
) -> Result<(), Box<dyn std::error::Error>> {
    let parsed = parse(&cross_section_document(
        r#"<CrossSectPnt dataFormat="Slope Distance" pntRef="survey-1" alignRef="A" alignRefStation="123.5" planFeatureRef="pf-1" planFeatureRefStation="124" parcelRef="parcel-1" parcelRefStation="125">0.035 12</CrossSectPnt><CrossSectPnt pntRef="survey-only" alignRef="A" alignRefStation="126"/><CrossSectPnt pntRef="fallback">-4 20</CrossSectPnt>"#,
    ))?;
    let points = &parsed.cross_section_surfaces[0].points;
    let slope = &points[0];
    assert_eq!(
        slope.data_format,
        LandXmlCrossSectionPointDataFormat::SlopeDistance
    );
    assert_eq!(slope.slope, Some(0.035));
    assert_eq!(slope.distance, Some(12.0));
    assert_eq!(slope.offset, None);
    assert_eq!(slope.align_ref_station, Some(123.5));
    assert_eq!(
        slope.alignment_source_id,
        Some(parsed.alignments[0].source_id.clone())
    );
    assert_eq!(slope.plan_feature_ref.as_deref(), Some("pf-1"));
    assert_eq!(slope.plan_feature_ref_station, Some(124.0));
    assert_eq!(slope.parcel_ref.as_deref(), Some("parcel-1"));
    assert_eq!(slope.parcel_ref_station, Some(125.0));

    let reference_only = &points[1];
    assert_eq!(reference_only.pnt_ref.as_deref(), Some("survey-only"));
    assert_eq!(reference_only.offset, None);
    assert_eq!(reference_only.elevation, None);
    assert_eq!(reference_only.align_ref_station, Some(126.0));

    let coordinates_win = &points[2];
    assert_eq!(coordinates_win.pnt_ref.as_deref(), Some("fallback"));
    assert_eq!(coordinates_win.offset, Some(-4.0));
    assert_eq!(coordinates_win.elevation, Some(20.0));
    assert!(parsed.capability_diagnostics.iter().any(|diagnostic| {
        diagnostic.code == LandXmlCapabilityDiagnosticCode::UnsupportedSlopeDistance
    }));
    assert!(parsed.capability_diagnostics.iter().any(|diagnostic| {
        diagnostic.code == LandXmlCapabilityDiagnosticCode::UnresolvedPointReference
            && diagnostic.source_id == Some(reference_only.source_id.clone())
    }));
    assert!(parsed.capability_diagnostics.iter().any(|diagnostic| {
        diagnostic.code == LandXmlCapabilityDiagnosticCode::UnsupportedPlanFeatureReference
    }));
    assert!(parsed.capability_diagnostics.iter().any(|diagnostic| {
        diagnostic.code == LandXmlCapabilityDiagnosticCode::UnsupportedParcelReference
    }));
    assert!(!parsed.capability_diagnostics.iter().any(|diagnostic| {
        diagnostic.code == LandXmlCapabilityDiagnosticCode::MissingElevation
            && diagnostic.source_id == Some(reference_only.source_id.clone())
    }));
    Ok(())
}

#[test]
fn issue_5045_only_actual_corridor_and_stringline_extensions_are_preserved(
) -> Result<(), Box<dyn std::error::Error>> {
    let parsed = parse(&extension_document())?;
    assert_eq!(parsed.preserved_only_extensions.len(), 2);
    assert_eq!(
        parsed.preserved_only_extensions[0].kind,
        ifc_lite_landxml::LandXmlPreservedOnlyExtensionKind::Corridor
    );
    assert_eq!(
        parsed.preserved_only_extensions[1].kind,
        ifc_lite_landxml::LandXmlPreservedOnlyExtensionKind::StringLine
    );
    assert!(parsed
        .preserved_only_extensions
        .iter()
        .all(|extension| extension.local_name != "CoordGeom" && extension.local_name != "Lanes"));
    let limits = LandXmlLimits {
        max_preserved_only_extensions: 0,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(&extension_document(), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    Ok(())
}

#[test]
fn issue_5045_preflights_profile_and_section_point_counts_before_point_vectors_grow() {
    let profile = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Alignments><Alignment name="A" length="1" staStart="0"><Profile><ProfSurf name="ground"><PntList2D>0 0 1 1</PntList2D></ProfSurf></Profile></Alignment></Alignments></LandXML>"#
    );
    let profile_limits = LandXmlLimits {
        max_profile_points: 1,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(profile.as_bytes(), &profile_limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    let section_limits = LandXmlLimits {
        max_cross_section_points: 1,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(
            &cross_section_document(
                "<CrossSectPnt>0 0</CrossSectPnt><CrossSectPnt>1 1</CrossSectPnt>"
            ),
            &section_limits,
            None,
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
}

#[test]
fn issue_5045_bounds_and_cancels_missing_grade_diagnostics() {
    let source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Alignments><Alignment name="A" length="1" staStart="0"><Profile><ProfSurf name="ground"><PntList2D>{}</PntList2D></ProfSurf></Profile></Alignment></Alignments></LandXML>"#,
        "0"
    );
    let limits = LandXmlLimits {
        max_capability_diagnostics: 0,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(source.as_bytes(), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    let cancellable_source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Alignments><Alignment name="A" length="1" staStart="0"><Profile><ProfAlign name="design">{}</ProfAlign></Profile></Alignment></Alignments></LandXML>"#,
        "<PVI>0</PVI>".repeat(2_000)
    );
    let cancellation = CancelsAfterPolls::new(20);
    assert_eq!(
        parse_landxml_tin_with_cancel(
            cancellable_source.as_bytes(),
            &LandXmlLimits::default(),
            Some(&cancellation)
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::Cancelled
    );
}

#[test]
fn issue_5045_charges_roadway_and_section_reference_attributes() {
    let roadway = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Roadways><Roadway name="route" alignmentRefs="a" surfaceRefs="ground" gradeModelRefs="grade"/></Roadways></LandXML>"#
    );
    let limits = LandXmlLimits {
        max_references: 2,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(roadway.as_bytes(), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    let section =
        cross_section_document(r#"<CrossSectPnt pntRef="p" alignRef="A">0 1</CrossSectPnt>"#);
    let limits = LandXmlLimits {
        max_references: 1,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(&section, &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
}

#[test]
fn issue_5045_refuses_roadway_diagnostics_at_the_configured_low_budget() {
    let source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Roadways><Roadway name="route" alignmentRefs="missing-a missing-b" surfaceRefs="missing-s" gradeModelRefs="missing-grade"/></Roadways></LandXML>"#
    );
    for max_capability_diagnostics in [0, 1] {
        let cancellation = CancelsAfterPolls::new(200);
        let limits = LandXmlLimits {
            max_capability_diagnostics,
            ..LandXmlLimits::default()
        };
        assert_eq!(
            parse_landxml_tin_with_cancel(source.as_bytes(), &limits, Some(&cancellation))
                .unwrap_err()
                .code,
            LandXmlDiagnosticCode::LimitExceeded,
            "diagnostic budget {max_capability_diagnostics} must reject while finalizing the first excess reference"
        );
    }
}

#[test]
fn issue_5045_evaluates_grade_parabolic_and_circular_vertical_geometry() {
    use ifc_lite_landxml::{
        LandXmlProfile, LandXmlProfilePoint, LandXmlSourceId, LandXmlVerticalCurve,
    };

    let points = |outgoing_elevation| {
        vec![
            LandXmlProfilePoint {
                source_id: LandXmlSourceId("before".to_owned()),
                station: 0.0,
                elevation: Some(0.0),
            },
            LandXmlProfilePoint {
                source_id: LandXmlSourceId("pvi".to_owned()),
                station: 50.0,
                elevation: Some(0.0),
            },
            LandXmlProfilePoint {
                source_id: LandXmlSourceId("after".to_owned()),
                station: 100.0,
                elevation: Some(outgoing_elevation),
            },
        ]
    };
    let profile = |kind, radius, outgoing_elevation| LandXmlProfile {
        source_id: LandXmlSourceId("profile".to_owned()),
        parent_alignment_source_id: LandXmlSourceId("alignment".to_owned()),
        ordinal: 1,
        name: "design".to_owned(),
        kind: LandXmlProfileKind::Design,
        pvis: points(outgoing_elevation),
        grade_lines: Vec::new(),
        vertical_curves: vec![LandXmlVerticalCurve {
            source_id: LandXmlSourceId("curve".to_owned()),
            parent_profile_source_id: LandXmlSourceId("profile".to_owned()),
            kind,
            station: 50.0,
            elevation: Some(0.0),
            length: Some(20.0),
            length_in: None,
            length_out: None,
            radius,
        }],
    };

    let parabolic = profile(LandXmlVerticalCurveKind::Parabolic, None, 20.0);
    assert_eq!(
        parabolic.evaluate_elevation_at(20.0).unwrap(),
        Some(0.0),
        "plain PVI grade is linear away from the curve"
    );
    assert!((parabolic.evaluate_elevation_at(50.0).unwrap().unwrap() - 1.0).abs() < 1.0e-12);

    // Independent circular probe from a circle tangent to both PVI lines.
    // The PVI lies off the midpoint for the grade change; the evaluator must
    // derive those tangent bounds instead of assuming 10 m either side.
    let circular = profile(
        LandXmlVerticalCurveKind::Circular,
        Some(100.0),
        10.0 / 0.96_f64.sqrt(),
    );
    let outgoing_grade = 10.0 / (50.0 * 0.96_f64.sqrt());
    let tangent_start = (100.0 - 9_600.0_f64.sqrt() - outgoing_grade * 20.0) / outgoing_grade;
    let local_station = -tangent_start;
    let expected = 100.0 - (10_000.0 - local_station * local_station).sqrt();
    let actual = circular.evaluate_elevation_at(50.0).unwrap().unwrap();
    assert!(
        (actual - expected).abs() < 1.0e-10,
        "actual={actual}, expected={expected}"
    );
}

#[test]
fn issue_5045_unsymmetrical_parabolas_preserve_both_tangents_and_c1_join() {
    use ifc_lite_landxml::{
        LandXmlProfile, LandXmlProfilePoint, LandXmlSourceId, LandXmlVerticalCurve,
    };

    let profile = |pvi_elevation, after_elevation| LandXmlProfile {
        source_id: LandXmlSourceId("profile".to_owned()),
        parent_alignment_source_id: LandXmlSourceId("alignment".to_owned()),
        ordinal: 1,
        name: "design".to_owned(),
        kind: LandXmlProfileKind::Design,
        pvis: vec![
            LandXmlProfilePoint {
                source_id: LandXmlSourceId("before".to_owned()),
                station: 0.0,
                elevation: Some(0.0),
            },
            LandXmlProfilePoint {
                source_id: LandXmlSourceId("pvi".to_owned()),
                station: 50.0,
                elevation: Some(pvi_elevation),
            },
            LandXmlProfilePoint {
                source_id: LandXmlSourceId("after".to_owned()),
                station: 100.0,
                elevation: Some(after_elevation),
            },
        ],
        grade_lines: Vec::new(),
        vertical_curves: vec![LandXmlVerticalCurve {
            source_id: LandXmlSourceId("curve".to_owned()),
            parent_profile_source_id: LandXmlSourceId("profile".to_owned()),
            kind: LandXmlVerticalCurveKind::UnsymmetricalParabolic,
            station: 50.0,
            elevation: Some(pvi_elevation),
            length: None,
            length_in: Some(20.0),
            length_out: Some(40.0),
            radius: None,
        }],
    };
    for (pvi_elevation, after_elevation, incoming_grade, outgoing_grade) in
        [(5.0, 0.0, 0.1, -0.1), (-5.0, 0.0, -0.1, 0.1)]
    {
        let curve = profile(pvi_elevation, after_elevation);
        let elevation = |station| curve.evaluate_elevation_at(station).unwrap().unwrap();
        assert!((elevation(30.0) - (pvi_elevation - incoming_grade * 20.0)).abs() < 1.0e-12);
        assert!((elevation(90.0) - (pvi_elevation + outgoing_grade * 40.0)).abs() < 1.0e-12);
        let epsilon = 1.0e-5;
        let left_slope = (elevation(50.0) - elevation(50.0 - epsilon)) / epsilon;
        let right_slope = (elevation(50.0 + epsilon) - elevation(50.0)) / epsilon;
        assert!((left_slope - right_slope).abs() < 1.0e-7);
        let start_slope = (elevation(30.0 + epsilon) - elevation(30.0)) / epsilon;
        let end_slope = (elevation(90.0) - elevation(90.0 - epsilon)) / epsilon;
        assert!((start_slope - incoming_grade).abs() < 1.0e-7);
        assert!((end_slope - outgoing_grade).abs() < 1.0e-7);
    }
}

#[test]
fn issue_5045_circular_curves_use_tangent_bounds_and_reject_inconsistent_inputs() {
    use ifc_lite_landxml::{
        LandXmlProfile, LandXmlProfileEvaluationError, LandXmlProfilePoint, LandXmlSourceId,
        LandXmlVerticalCurve,
    };

    let circular = |length, radius| LandXmlProfile {
        source_id: LandXmlSourceId("profile".to_owned()),
        parent_alignment_source_id: LandXmlSourceId("alignment".to_owned()),
        ordinal: 1,
        name: "design".to_owned(),
        kind: LandXmlProfileKind::Design,
        pvis: vec![
            LandXmlProfilePoint {
                source_id: LandXmlSourceId("before".to_owned()),
                station: 0.0,
                elevation: Some(0.0),
            },
            LandXmlProfilePoint {
                source_id: LandXmlSourceId("pvi".to_owned()),
                station: 50.0,
                elevation: Some(0.0),
            },
            LandXmlProfilePoint {
                source_id: LandXmlSourceId("after".to_owned()),
                station: 100.0,
                elevation: Some(10.0 / 0.96_f64.sqrt()),
            },
        ],
        grade_lines: Vec::new(),
        vertical_curves: vec![LandXmlVerticalCurve {
            source_id: LandXmlSourceId("curve".to_owned()),
            parent_profile_source_id: LandXmlSourceId("profile".to_owned()),
            kind: LandXmlVerticalCurveKind::Circular,
            station: 50.0,
            elevation: Some(0.0),
            length: Some(length),
            length_in: None,
            length_out: None,
            radius: Some(radius),
        }],
    };
    let curve = circular(20.0, 100.0);
    let elevation = |station| curve.evaluate_elevation_at(station).unwrap().unwrap();
    let outgoing_grade = 10.0 / (50.0 * 0.96_f64.sqrt());
    let start = 50.0 + ((100.0 - 9_600.0_f64.sqrt() - outgoing_grade * 20.0) / outgoing_grade);
    let end = start + 20.0;
    assert!(elevation(start).abs() < 1.0e-10);
    assert!((elevation(end) - outgoing_grade * (end - 50.0)).abs() < 1.0e-10);
    let epsilon = 1.0e-5;
    let start_slope = (elevation(start + epsilon) - elevation(start)) / epsilon;
    let end_slope = (elevation(end) - elevation(end - epsilon)) / epsilon;
    assert!(start_slope.abs() < 1.0e-7);
    assert!((end_slope - outgoing_grade).abs() < 1.0e-7);
    assert_eq!(
        circular(19.0, 100.0).evaluate_elevation_at(50.0),
        Err(LandXmlProfileEvaluationError::InconsistentCircularCurve),
    );
}

#[test]
fn issue_5045_parsed_circular_curves_validate_length_units_and_large_scale_endpoints(
) -> Result<(), Box<dyn std::error::Error>> {
    use ifc_lite_landxml::LandXmlProfileEvaluationError;

    let source = |radius: f64| {
        format!(
            r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Alignments><Alignment name="A" length="20000" staStart="0"><Profile><ProfAlign name="design"><PVI>0 0</PVI><CircCurve length="10000" radius="{radius:.12}">10000 0</CircCurve><PVI>20000 1000</PVI></ProfAlign></Profile></Alignment></Alignments></LandXML>"#,
        )
    };
    let invalid = parse(source(100_480.0).as_bytes())?;
    assert_eq!(
        invalid.profiles[0].evaluate_elevation_at(10_000.0),
        Err(LandXmlProfileEvaluationError::InconsistentCircularCurve),
        "sine residuals must be converted to length before tolerancing",
    );

    let outgoing_grade = 0.1_f64;
    let sine_out = outgoing_grade.atan().sin();
    let radius = 10_000.0 / sine_out;
    let valid = parse(source(radius).as_bytes())?;
    let profile = &valid.profiles[0];
    let rise = radius * (1.0 - (1.0 - sine_out * sine_out).sqrt());
    let end = 10_000.0 + (rise - outgoing_grade * 10_000.0) / outgoing_grade + 10_000.0;
    let elevation = |station| profile.evaluate_elevation_at(station).unwrap().unwrap();
    let at_end = elevation(end);
    assert!((at_end - outgoing_grade * (end - 10_000.0)).abs() < 1.0e-8);
    let epsilon = 1.0e-4;
    let incoming_slope = (at_end - elevation(end - epsilon)) / epsilon;
    let outgoing_slope = (elevation(end + epsilon) - at_end) / epsilon;
    assert!(
        (incoming_slope - outgoing_slope).abs() < 1.0e-7,
        "endpoint tangent slopes differ: {incoming_slope} vs {outgoing_slope}"
    );
    Ok(())
}

#[test]
fn issue_5045_parsed_circular_curves_stay_stable_for_shallow_and_near_parallel_grades(
) -> Result<(), Box<dyn std::error::Error>> {
    let source_at = |station: f64, before: f64, after: f64, length: f64, radius: f64| {
        format!(
            r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Alignments><Alignment name="A" length="{alignment_length:.17e}" staStart="0"><Profile><ProfAlign name="design"><PVI>0 {before:.17e}</PVI><CircCurve length="{length:.17e}" radius="{radius:.17e}">{station:.17e} 0</CircCurve><PVI>{alignment_length:.17e} {after:.17e}</PVI></ProfAlign></Profile></Alignment></Alignments></LandXML>"#,
            alignment_length = station * 2.0,
        )
    };
    let source = |before: f64, after: f64, length: f64, radius: f64| {
        source_at(1000.0, before, after, length, radius)
    };
    let shallow = parse(source(-0.000001, 0.000002, 10.0, 1.0e10).as_bytes())?;
    let shallow_profile = &shallow.profiles[0];
    let shallow_elevation = |station| {
        shallow_profile
            .evaluate_elevation_at(station)
            .unwrap()
            .unwrap()
    };
    assert!(shallow_elevation(1000.0).is_finite());
    assert!((shallow_elevation(995.0) + 5.0e-9).abs() < 1.0e-12);
    assert!((shallow_elevation(1005.0) - 1.0e-8).abs() < 1.0e-12);

    let extreme = parse(source(-100.0, 100.00000000000003, 27.34438611211513, 1.0e18).as_bytes())?;
    let extreme_profile = &extreme.profiles[0];
    let extreme_elevation = |station| {
        extreme_profile
            .evaluate_elevation_at(station)
            .unwrap()
            .unwrap()
    };
    assert!((extreme_elevation(999.0) + 0.1).abs() < 1.0e-9);
    assert!(extreme_elevation(1000.0).abs() < 1.0e-10);
    assert!((extreme_elevation(1001.0) - 0.1).abs() < 1.0e-9);
    let epsilon = 1.0e-4;
    let left_slope = (extreme_elevation(1000.0) - extreme_elevation(1000.0 - epsilon)) / epsilon;
    let right_slope = (extreme_elevation(1000.0 + epsilon) - extreme_elevation(1000.0)) / epsilon;
    assert!((left_slope - right_slope).abs() < 1.0e-9);
    let incoming_grade = 0.1_f64;
    let outgoing_grade = 0.10000000000000003_f64;
    let half_angle =
        (outgoing_grade - incoming_grade).atan2(1.0 + incoming_grade * outgoing_grade) / 2.0;
    let tangent_length = half_angle.tan() * 1.0e18;
    let start = 1000.0 - tangent_length / incoming_grade.hypot(1.0);
    let end = 1000.0 + tangent_length / outgoing_grade.hypot(1.0);
    let start_slope = (extreme_elevation(start + epsilon) - extreme_elevation(start)) / epsilon;
    let end_slope = (extreme_elevation(end) - extreme_elevation(end - epsilon)) / epsilon;
    assert!((start_slope - incoming_grade).abs() < 1.0e-8);
    assert!((end_slope - outgoing_grade).abs() < 1.0e-8);
    for length in [0.001_f64, 1.0, 20.0, 25.0, 30.0, 35.0, 60.0, 70.0] {
        let inconsistent_extreme =
            parse(source(-100.0, 100.00000000000003, length, 1.0e18).as_bytes())?;
        assert_eq!(
            inconsistent_extreme.profiles[0].evaluate_elevation_at(1000.0),
            Err(ifc_lite_landxml::LandXmlProfileEvaluationError::InconsistentCircularCurve),
        );
    }

    let steep = parse(source(-1.0e11, 2.0e11, 37.5, 1.0e18).as_bytes())?;
    assert!(steep.profiles[0].evaluate_elevation_at(1000.0)?.is_some());

    let opposing = parse(source(1.0e19, 1.0e19, 2.0, 1.0).as_bytes())?;
    let opposing_elevation = opposing.profiles[0]
        .evaluate_elevation_at(1000.0)?
        .expect("opposing steep curve evaluates at its PVI");
    assert!((opposing_elevation / 1.0e16 - 1.0).abs() < 1.0e-12);

    let same_sign_overflow = parse(source_at(1.0, -1.0e154, 2.0e154, 0.375, 1.0e308).as_bytes())?;
    assert!(same_sign_overflow.profiles[0]
        .evaluate_elevation_at(1.0)?
        .is_some());
    let opposing_overflow = parse(source_at(1.0, 1.0e308, 1.0e308, 0.2, 0.1).as_bytes())?;
    assert!(opposing_overflow.profiles[0]
        .evaluate_elevation_at(1.0)?
        .is_some());
    let reversed_same_sign = parse(source_at(1.0, 1.0e154, -2.0e154, 0.375, 1.0e308).as_bytes())?;
    assert!(reversed_same_sign.profiles[0]
        .evaluate_elevation_at(1.0)?
        .is_some());
    let reversed_opposing = parse(source_at(1.0, -1.0e308, -1.0e308, 0.2, 0.1).as_bytes())?;
    assert!(reversed_opposing.profiles[0]
        .evaluate_elevation_at(1.0)?
        .is_some());

    let tiny = parse(source_at(1.0e-12, 0.0, 1.0e-15, 9.99999500000375e-16, 1.0e-12).as_bytes())?;
    assert!(tiny.profiles[0].evaluate_elevation_at(1.0e-12)?.is_some());
    let invalid_tiny = parse(source_at(1.0e-12, 0.0, 1.0e-15, 7.0e-15, 1.0e-12).as_bytes())?;
    assert_eq!(
        invalid_tiny.profiles[0].evaluate_elevation_at(1.0e-12),
        Err(ifc_lite_landxml::LandXmlProfileEvaluationError::InconsistentCircularCurve),
    );

    let centered = |before: f64, after: f64, length: f64, radius: f64| {
        format!(
            r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Alignments><Alignment name="A" length="2" staStart="-1"><Profile><ProfAlign name="design"><PVI>-1 {before:.17e}</PVI><CircCurve length="{length:.17e}" radius="{radius:.17e}">0 0</CircCurve><PVI>1 {after:.17e}</PVI></ProfAlign></Profile></Alignment></Alignments></LandXML>"#,
        )
    };
    let subnormal = parse(centered(0.0, 1.0, 7.071067811865473e-309, 1.0e-308).as_bytes())?;
    for station in [-4.0e-309, 0.0, 4.0e-309] {
        assert!(subnormal.profiles[0]
            .evaluate_elevation_at(station)?
            .is_some());
    }
    let invalid_subnormal = parse(centered(0.0, 1.0, 7.0e-309, 1.0e-308).as_bytes())?;
    assert_eq!(
        invalid_subnormal.profiles[0].evaluate_elevation_at(0.0),
        Err(ifc_lite_landxml::LandXmlProfileEvaluationError::InconsistentCircularCurve)
    );

    let rise_extreme = parse(centered(-1.0e200, 2.0e200, 3.75e-93, 1.0e308).as_bytes())?;
    let elevation = |station| {
        rise_extreme.profiles[0]
            .evaluate_elevation_at(station)
            .unwrap()
            .unwrap()
    };
    assert!((elevation(0.0) / 4.28932188134525e106 - 1.0).abs() < 1.0e-12);
    let end = 1.25e-93;
    let left = elevation(1.24e-93);
    let at_end = elevation(end);
    let right = elevation(1.26e-93);
    assert!((left - at_end).abs() < 3.0e105);
    assert!((right - at_end).abs() < 3.0e105);

    let adjacent = 1.0e307_f64.next_up();
    let adjacent_curve = parse(centered(-1.0e307, adjacent, 1.24e-322, 1.0e308).as_bytes())?;
    assert!(adjacent_curve.profiles[0]
        .evaluate_elevation_at(0.0)?
        .is_some());

    // #5045: the scaled root includes a finite `2 * grade * u` term even
    // though `2 * grade` itself overflows. These are parsed source f64s,
    // rather than an internal synthetic geometry, to cover the declaration
    // validation and the PVI placement together.
    let root_length = 1.527_777_777_777_78e-309;
    let forward_root = parse(centered(-1.0e308, 1.2e308, root_length, 1.0e308).as_bytes())?;
    let forward_at_pvi = forward_root.profiles[0]
        .evaluate_elevation_at(0.0)?
        .expect("forward overflow-root curve evaluates at its PVI");
    assert!((forward_at_pvi / 0.003_795_737_491_389_808 - 1.0).abs() < 2.0e-12);
    let forward_start = -8.333_333_333_333e-310;
    let forward_end = 6.944_444_444_444e-310;
    let forward_elevation = |station| {
        forward_root.profiles[0]
            .evaluate_elevation_at(station)
            .unwrap()
            .unwrap()
    };
    // The endpoints meet the finite tangent lines and the interior does not
    // collapse to either tangent when the horizontal spans are subnormal.
    assert!((forward_elevation(forward_start) + 0.083_333_333_333).abs() < 2.0e-10);
    assert!((forward_elevation(forward_end) - 0.083_333_333_333).abs() < 2.0e-10);
    assert!(forward_elevation(-4.0e-310) < forward_at_pvi);
    assert!(forward_elevation(4.0e-310) > forward_at_pvi);
    let reverse_root = parse(centered(-1.2e308, 1.0e308, root_length, 1.0e308).as_bytes())?;
    let reverse_at_pvi = reverse_root.profiles[0]
        .evaluate_elevation_at(0.0)?
        .expect("reverse overflow-root curve evaluates at its PVI");
    assert!((reverse_at_pvi / -0.003_795_737_491_389_808 - 1.0).abs() < 2.0e-12);
    let reverse_elevation = |station| {
        reverse_root.profiles[0]
            .evaluate_elevation_at(station)
            .unwrap()
            .unwrap()
    };
    assert!((reverse_elevation(-6.944_444_444_444e-310) + 0.083_333_333_333).abs() < 2.0e-10);
    assert!((reverse_elevation(8.333_333_333_333e-310) - 0.083_333_333_333).abs() < 2.0e-10);
    assert!(reverse_elevation(-4.0e-310) < reverse_at_pvi);
    assert!(reverse_elevation(4.0e-310) > reverse_at_pvi);

    // #5045: signed factors pass through the exponent-aware ratio unchanged.
    // This descending circle used to receive the magnitude of the rise and
    // jump from the curve end to its outgoing tangent.
    let descending = parse(source(100.0, -200.0, 20.0, 207.012_729_872_537_2).as_bytes())?;
    let descending_elevation = |station| {
        descending.profiles[0]
            .evaluate_elevation_at(station)
            .unwrap()
            .unwrap()
    };
    assert!((descending_elevation(1000.0) + 0.250_139_238_895_676_7).abs() < 2.0e-13);
    let descending_end = 1_009.926_825_350_344_4;
    assert!((descending_elevation(descending_end) + 1.985_365_070_068_875_4).abs() < 2.0e-12);
    assert!(
        (descending_elevation(descending_end + 1.0e-6)
            - (-0.2 * (descending_end + 1.0e-6 - 1000.0)))
            .abs()
            < 2.0e-12
    );
    assert!(descending_elevation(995.0) > descending_elevation(1000.0));
    assert!(descending_elevation(1005.0) < descending_elevation(1000.0));

    let negative_mirror = parse(centered(1.0e308, -1.2e308, root_length, 1.0e308).as_bytes())?;
    let negative_mirror_elevation = |station| {
        negative_mirror.profiles[0]
            .evaluate_elevation_at(station)
            .unwrap()
            .unwrap()
    };
    assert!((negative_mirror_elevation(0.0) / -0.003_795_737_491_389_808 - 1.0).abs() < 2.0e-12);
    assert!(negative_mirror_elevation(-4.0e-310) > negative_mirror_elevation(0.0));
    assert!(negative_mirror_elevation(4.0e-310) < negative_mirror_elevation(0.0));

    let near_parallel = parse(source(-100.0, 100.000001, 98.51853225045078, 1.0e11).as_bytes())?;
    assert!(near_parallel.profiles[0]
        .evaluate_elevation_at(1000.0)?
        .is_some());

    for (incoming_grade, outgoing_grade) in [
        (0.1_f64, 0.2_f64),
        (0.2_f64, 0.1_f64),
        (-0.2_f64, -0.1_f64),
        (-0.1_f64, -0.2_f64),
    ] {
        let sine_change = outgoing_grade.atan().sin() - incoming_grade.atan().sin();
        let radius = 20.0 / sine_change.abs();
        let profile = parse(
            source(
                -1000.0 * incoming_grade,
                1000.0 * outgoing_grade,
                20.0,
                radius,
            )
            .as_bytes(),
        )?;
        assert!(profile.profiles[0].evaluate_elevation_at(1000.0)?.is_some());
    }
    Ok(())
}

#[test]
fn issue_5045_refuses_nonfinite_profile_results_and_invalid_curve_extents(
) -> Result<(), Box<dyn std::error::Error>> {
    use ifc_lite_landxml::LandXmlProfileEvaluationError;

    let source = |profile: &str| {
        format!(
            r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Alignments><Alignment name="A" length="100" staStart="0"><Profile><ProfAlign name="design">{profile}</ProfAlign></Profile></Alignment></Alignments></LandXML>"#,
        )
    };
    let overflow = parse(source("<PVI>0 -1e308</PVI><PVI>1 1e308</PVI>").as_bytes())?;
    assert_eq!(
        overflow.profiles[0].evaluate_elevation_at(0.5),
        Err(LandXmlProfileEvaluationError::NonFiniteEvaluation),
        "finite source values must never leak an infinite elevation",
    );
    let overlapping = parse(source("<PVI>0 0</PVI><ParaCurve length=\"80\">40 4</ParaCurve><ParaCurve length=\"80\">60 0</ParaCurve><PVI>100 4</PVI>").as_bytes())?;
    assert_eq!(
        overlapping.profiles[0].evaluate_elevation_at(80.0),
        Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration),
        "overlapping vertical-curve extents are not a continuous alignment",
    );
    let overlong = parse(
        source("<PVI>0 0</PVI><ParaCurve length=\"1000\">50 5</ParaCurve><PVI>100 0</PVI>")
            .as_bytes(),
    )?;
    assert_eq!(
        overlong.profiles[0].evaluate_elevation_at(-100.0),
        Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration),
        "curve extents must stay between their adjacent tangent PVIs",
    );
    Ok(())
}
