// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7292 through the canonical native producer, including model placement,
//! millimetre units and per-mesh origins. The reporter's public generated
//! fixture is shared with the geometry-level reproduction rather than copied.
//! Its stated oracle (IfcOpenShell and web-ifc) leaves only the 25 mm strip.

use ifc_lite_processing::process_geometry;

const FIXTURE: &str = include_str!(
    "../../geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc"
);
// The ALT oracle selector is process-global. Serialize every producer case
// in this integration-test binary; helper-only distance controls need no lock.
static PRODUCER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn default_producer_guard() -> std::sync::MutexGuard<'static, ()> {
    let guard = PRODUCER_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    #[cfg(feature = "triangulation-alt")]
    ifc_lite_geometry::set_alt_triangulator(false);
    guard
}

const POSITION_TOLERANCE: f64 = 1.0e-4; // 0.1 mm, including f32 and kernel snap

fn surface_face(triangle: [[f64; 3]; 3], slope: f64, length_y: f64) -> (usize, f64) {
    let edge_a = [0, 1, 2].map(|k| triangle[1][k] - triangle[0][k]);
    let edge_b = [0, 1, 2].map(|k| triangle[2][k] - triangle[0][k]);
    let cross = [
        edge_a[1] * edge_b[2] - edge_a[2] * edge_b[1],
        edge_a[2] * edge_b[0] - edge_a[0] * edge_b[2],
        edge_a[0] * edge_b[1] - edge_a[1] * edge_b[0],
    ];
    let normal_length = (1.0 + slope * slope).sqrt();
    // Each entry is a unit normal and its plane offset. The six analytic
    // faces follow from the 25 mm remainder and the rotated extrusion.
    let faces = [
        ([1.0, 0.0, 0.0], -3.025),
        ([1.0, 0.0, 0.0], -3.000),
        ([0.0, 1.0, 0.0], 0.0),
        ([0.0, 1.0, 0.0], length_y),
        ([0.0, -slope / normal_length, 1.0 / normal_length], 4.548 / normal_length),
        ([0.0, -slope / normal_length, 1.0 / normal_length], 4.602 / normal_length),
    ];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    // Tiny triangles next to an edge can fit two planes within tolerance;
    // their normal selects the face with the greatest projected area.
    let mut best: Option<(usize, f64)> = None;
    for (face, (normal, offset)) in faces.into_iter().enumerate() {
        if triangle.iter().all(|&vertex| (dot(normal, vertex) - offset).abs() <= POSITION_TOLERANCE) {
            let projected_area = dot(normal, cross).abs() * 0.5;
            if best.is_none_or(|(_, area)| projected_area > area) {
                best = Some((face, projected_area));
            }
        }
    }
    best.unwrap_or_else(|| panic!("#7292: triangle {triangle:?} is not on any strip boundary"))
}


// Squared distance to a CLOSED FINITE triangle. Checking every vertex of a
// convex witness cell against ONE triangle + a Euclidean tolerance ball
// certifies the entire cell, because that Minkowski sum is convex.
fn triangle_distance_squared(p: [f64; 3], t: [[f64; 3]; 3]) -> f64 {
    let sub = |a: [f64; 3], b: [f64; 3]| [0, 1, 2].map(|k| a[k] - b[k]);
    let dot = |a: [f64; 3], b: [f64; 3]| a.into_iter().zip(b).map(|(x,y)| x*y).sum::<f64>();
    let ab = sub(t[1], t[0]); let ac = sub(t[2], t[0]); let ap = sub(p, t[0]);
    let cross = [ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
    if dot(cross,cross) == 0.0 {
        // The closed convex hull is a segment or point. Minimize over all
        // three closed edges; avoid 0/0 in the triangle Voronoi formulas.
        return (0..3).map(|i| {
            let a = t[i]; let edge = sub(t[(i+1)%3],a); let length = dot(edge,edge);
            let v = if length == 0.0 { 0.0 } else { (dot(sub(p,a),edge)/length).clamp(0.0,1.0) };
            let q = [0,1,2].map(|k| a[k]+v*edge[k]); let d = sub(p,q); dot(d,d)
        }).fold(f64::INFINITY,f64::min);
    }
    let (d1,d2) = (dot(ab,ap),dot(ac,ap));
    if d1 <= 0.0 && d2 <= 0.0 { return dot(ap,ap); }
    let bp = sub(p,t[1]); let (d3,d4) = (dot(ab,bp),dot(ac,bp));
    if d3 >= 0.0 && d4 <= d3 { return dot(bp,bp); }
    let vc = d1*d4-d3*d2;
    let closest = if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1/(d1-d3); [0,1,2].map(|k| t[0][k]+v*ab[k])
    } else {
        let cp = sub(p,t[2]); let (d5,d6) = (dot(ab,cp),dot(ac,cp));
        if d6 >= 0.0 && d5 <= d6 { return dot(cp,cp); }
        let vb = d5*d2-d1*d6;
        if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
            let w = d2/(d2-d6); [0,1,2].map(|k| t[0][k]+w*ac[k])
        } else {
            let va = d3*d6-d5*d4;
            if va <= 0.0 && d4-d3 >= 0.0 && d5-d6 >= 0.0 {
                let w = (d4-d3)/((d4-d3)+(d5-d6));
                [0,1,2].map(|k| t[1][k]+w*(t[2][k]-t[1][k]))
            } else {
                let inverse = 1.0/(va+vb+vc);
                let (v,w) = (vb*inverse,vc*inverse);
                [0,1,2].map(|k| t[0][k]+ab[k]*v+ac[k]*w)
            }
        }
    };
    let delta = sub(p,closest); dot(delta,delta)
}

fn covers_bottom_cell(triangle: [[f64; 3]; 3], slope: f64) -> bool {
    // A real 2 x 2 micrometre cell, wholly inside the analytic bottom face.
    // It targets the historical missing triangular patch; it is not a
    // claim of complete six-face coverage or exact closedness.
    [-1.0e-6,1.0e-6].into_iter().all(|dx| {
        [-1.0e-6,1.0e-6].into_iter().all(|dy| {
            let y = 0.004+dy;
            triangle_distance_squared([-3.005+dx,y,4.548+slope*y],triangle)
                <= POSITION_TOLERANCE * POSITION_TOLERANCE
        })
    })
}

fn assert_strip(bytes: &[u8], slope: f64) {
    let result = process_geometry(bytes);
    let (mut minimum, mut maximum) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let mut referenced_vertices = 0;
    let length_y = 1.1 / (1.0 + slope * slope).sqrt();
    let mut surface_areas = [0.0; 6];
    let mut bottom_cell_covered = false;
    let mut signed_volume = 0.0;
    for mesh in result.meshes.iter().filter(|mesh| mesh.express_id == 107) {
        for &index in &mesh.indices {
            let world = [0, 1, 2].map(|k| {
                mesh.positions[index as usize * 3 + k] as f64 + mesh.origin[k]
            });
            for k in 0..3 {
                minimum[k] = minimum[k].min(world[k]);
                maximum[k] = maximum[k].max(world[k]);
            }
            // The extrusion direction becomes vertical after its tilted
            // placement. Every retained vertex must lie between the sloped
            // bottom and the top exactly 54 mm above it.
            let height_above_bottom = world[2] - (4.548 + slope * world[1]);
            assert!(
                (-1.0e-4..=0.054 + 1.0e-4).contains(&height_above_bottom),
                "#7292: vertex {world:?} lies outside the 54 mm sloped layer"
            );
            referenced_vertices += 1;
        }
        assert_eq!(mesh.indices.len() % 3, 0, "triangle index buffer");
        for indices in mesh.indices.chunks_exact(3) {
            let triangle = [0, 1, 2].map(|vertex| [0, 1, 2].map(|axis| {
                mesh.positions[indices[vertex] as usize * 3 + axis] as f64 + mesh.origin[axis]
            }));
            let (face, area) = surface_face(triangle, slope, length_y);
            surface_areas[face] += area;
            bottom_cell_covered |= covers_bottom_cell(triangle, slope);
            // Translate to a nearby analytic corner before the determinant;
            // no large world-coordinate cancellation or triangle-count pin.
            let p = triangle.map(|v| [v[0]+3.025,v[1],v[2]-4.548]);
            signed_volume += (p[0][0]*(p[1][1]*p[2][2]-p[1][2]*p[2][1])
                -p[0][1]*(p[1][0]*p[2][2]-p[1][2]*p[2][0])
                +p[0][2]*(p[1][0]*p[2][1]-p[1][1]*p[2][0]))/6.0;
        }
    }
    assert!(referenced_vertices > 0, "the 25 mm strip must remain");
    assert!(bottom_cell_covered, "#7292: entire finite bottom witness cell must be covered within 100 micrometres");
    let expected_volume = 0.025 * 0.054 * length_y;
    let analytic_surface_area = 2.0*(0.054*length_y+0.025*0.054+0.025*1.1);
    let volume_tolerance = analytic_surface_area * POSITION_TOLERANCE;
    assert!(signed_volume > 0.0 && (signed_volume-expected_volume).abs() <= volume_tolerance,
        "#7292: oriented surface integral {signed_volume}, expected strip volume {expected_volume} +/- {volume_tolerance}");
    // 0.1 mm covers f32 storage and the kernel snap. Unreferenced vertices
    // do not contribute: the issue specifically reports indexed world bounds.
    // Sloped bounds agree with the independent IfcOpenShell replay. The
    // flat control follows directly from its unchanged 1100 mm footprint.
    let expected_lo = [-3.025, 0.0, 4.548];
    let expected_hi = [-3.000, length_y, 4.602 + slope * length_y];
    for k in 0..3 {
        assert!(
            (minimum[k] - expected_lo[k]).abs() < 1.0e-4
                && (maximum[k] - expected_hi[k]).abs() < 1.0e-4,
            "#7292: axis {k} bounds [{}, {}], expected [{}, {}]",
            minimum[k], maximum[k], expected_lo[k], expected_hi[k]
        );
    }
    // Sum projected triangle area on each boundary independently of its
    // triangulation. Side x faces are y-z parallelograms; side y faces are
    // 25 x 54 mm rectangles; the tilted caps are 25 x 1100 mm rectangles.
    // Area tolerance comes from a 0.1 mm boundary displacement times each
    // face perimeter, plus a one-part-per-million summation allowance.
    let expected_areas = [0.054 * length_y, 0.054 * length_y,
        0.025 * 0.054, 0.025 * 0.054, 0.025 * 1.1, 0.025 * 1.1];
    let perimeters = [2.0 * (1.1 + 0.054), 2.0 * (1.1 + 0.054),
        2.0 * (0.025 + 0.054), 2.0 * (0.025 + 0.054),
        2.0 * (0.025 + 1.1), 2.0 * (0.025 + 1.1)];
    for face in 0..6 {
        let tolerance = perimeters[face] * POSITION_TOLERANCE + expected_areas[face] * 1.0e-6;
        assert!(
            (surface_areas[face] - expected_areas[face]).abs() <= tolerance,
            "#7292: face {face} area {} m², expected {} m² ± {tolerance}",
            surface_areas[face], expected_areas[face]
        );
    }
}

#[test]
fn issue_7292_shared_producer_leaves_only_the_25mm_strip() {
    let _producer = default_producer_guard();
    assert_strip(FIXTURE.as_bytes(), 0.02);
}

/// Change only the reporter's operand slope: A's placement/extrusion axes
/// and B's cap heights. Footprints, layer depths and model placement stay
/// fixed. The 2% regression above always uses the original fixture verbatim.
fn fixture_at_slope(slope: f64) -> String {
    let normal_length = (1.0 + slope * slope).sqrt();
    let axis_y = slope / normal_length;
    let axis_z = 1.0 / normal_length;
    let mut fixture = String::new();
    for line in FIXTURE.lines() {
        let entity_id = line.split_once('=').and_then(|(id, _)| {
            id.strip_prefix('#').and_then(|id| id.parse::<u32>().ok())
        });
        let replacement = match entity_id {
            Some(37) => format!("#37=IFCDIRECTION((0.000000000000000,{:.15},{axis_z:.15}));", -axis_y),
            Some(41) => format!("#41=IFCDIRECTION((0.000000000000000,{axis_y:.15},{axis_z:.15}));"),
            Some(id @ 43..=62) => {
                let (_, coordinates) = line.split_once("((").expect("committed prism point");
                let coordinates = coordinates.strip_suffix("));").expect("point terminator");
                let coordinates: Vec<f64> = coordinates.split(',')
                    .map(|value| value.parse().expect("numeric prism point coordinate")).collect();
                assert_eq!(coordinates.len(), 3, "prism point has three coordinates");
                let base_z = if (id - 43) % 2 == 0 { 48.0 } else { 128.9 };
                let z = base_z + slope * coordinates[1];
                format!("#{id}=IFCCARTESIANPOINT(({:.4},{:.4},{z:.4}));", coordinates[0], coordinates[1])
            }
            _ => line.to_owned(),
        };
        fixture.push_str(&replacement);
        fixture.push('\n');
    }
    fixture
}

#[test]
fn issue_7292_flat_difference_positive_control_leaves_the_strip() {
    let _producer = default_producer_guard();
    let flat = fixture_at_slope(0.0);
    assert_strip(flat.as_bytes(), 0.0);
}

#[test]
fn issue_7292_five_percent_difference_preserves_the_complete_strip() {
    let _producer = default_producer_guard();
    // The reporter's 5% variation had correct bounds but extra triangles.
    // Assert six-face coverage without pinning a particular triangulation.
    let sloped = fixture_at_slope(0.05);
    assert_strip(sloped.as_bytes(), 0.05);
}

/// Partition the reporter's 80.9 mm cutter into five adjacent 16.18 mm
/// prisms. A \ (B0 union ... union B4) equals ((((A \ B0) \ B1) ... \ B4).
/// Unlike repeated identical subtraction, the first four slices each remove
/// a distinct part of the 54 mm host layer. The last lies above the layer.
fn five_stacked_slices(fixture: &str, slope: f64) -> String {
    const BODY: &str = "#102=IFCSHAPEREPRESENTATION(#7,'Body','CSG',(#101));";
    const DATA_END: &str = "\nENDSEC;\nEND-ISO-10303-21;";
    const HEIGHT: f64 = 16.18;
    assert_eq!(fixture.matches(BODY).count(), 1, "reporter Body marker");
    assert_eq!(fixture.matches(DATA_END).count(), 1, "reporter DATA terminator");
    assert_eq!(fixture.matches("#101=IFCBOOLEANRESULT(.DIFFERENCE.,#42,#100);").count(), 1,
        "reporter first difference must keep its original host/cutter references");
    let entity_id = |line: &str| line.split_once('=').and_then(|(id, _)| {
        id.strip_prefix('#').and_then(|id| id.parse::<u32>().ok())
    });
    let template: Vec<_> = fixture.lines().filter_map(|line| {
        entity_id(line).filter(|id| (43..=100).contains(id)).map(|id| (id, line))
    }).collect();
    assert_eq!(template.len(), 58, "complete reporter faceted-prism entity block");
    for (offset, &(id, _)) in template.iter().enumerate() {
        assert_eq!(id, 43 + offset as u32, "prism block must be contiguous and ordered");
    }
    for id in 200..=435 {
        assert!(!fixture.lines().any(|line| entity_id(line) == Some(id)),
            "stacked slice/BooleanResult id {id} must be unused");
    }
    let slice_line = |id: u32, line: &str, slice: u32, first_id: u32| {
        // Remap every # reference, including the entity definition. All
        // topology references in this self-contained block stay in 43..100.
        let mut remapped = String::new();
        for (i, part) in line.split('#').enumerate() {
            if i == 0 { remapped.push_str(part); continue; }
            let digits = part.bytes().take_while(u8::is_ascii_digit).count();
            assert!(digits > 0, "prism reference must have an entity id");
            let referenced: u32 = part[..digits].parse().expect("numeric prism reference");
            assert!((43..=100).contains(&referenced), "prism block must be self-contained");
            remapped.push_str(&format!("#{}{}", first_id + referenced - 43, &part[digits..]));
        }
        if (43..=62).contains(&id) {
            let (_, coordinates) = line.split_once("((").expect("prism point");
            let coordinates = coordinates.strip_suffix("));").expect("point terminator");
            let coordinates: Vec<f64> = coordinates.split(',')
                .map(|value| value.parse().expect("numeric prism coordinate")).collect();
            assert_eq!(coordinates.len(), 3, "prism point has three coordinates");
            let level = slice + (id - 43) % 2;
            let z = 48.0 + HEIGHT * level as f64 + slope * coordinates[1];
            format!("#{}=IFCCARTESIANPOINT(({:.4},{:.4},{z:.4}));",
                first_id + id - 43, coordinates[0], coordinates[1])
        } else {
            remapped
        }
    };
    let mut result = String::new();
    for line in fixture.lines() {
        let replacement = match entity_id(line) {
            Some(id @ 43..=100) => slice_line(id, line, 0, 43),
            Some(102) => "#102=IFCSHAPEREPRESENTATION(#7,'Body','CSG',(#435));".to_owned(),
            _ => line.to_owned(),
        };
        result.push_str(&replacement);
        result.push('\n');
    }
    let mut extra = String::new();
    for slice in 1..=4 {
        let first_id = 200 + (slice - 1) * 58;
        for &(id, line) in &template {
            extra.push('\n');
            extra.push_str(&slice_line(id, line, slice, first_id));
        }
    }
    for (id, cutter) in [(432, 257), (433, 315), (434, 373), (435, 431)] {
        let previous = if id == 432 { 101 } else { id - 1 };
        extra.push_str(&format!("\n#{id}=IFCBOOLEANRESULT(.DIFFERENCE.,#{previous},#{cutter});"));
    }
    result.replace(DATA_END, &format!("{extra}{DATA_END}"))
}

#[test]
fn issue_7292_five_stacked_two_percent_slices_preserve_the_strip() {
    let _producer = default_producer_guard();
    // The original reporter remains immutable; only the in-memory cutter
    // blocks and Body item differ. Reuse every strip invariant at both slopes.
    let reporter_series = five_stacked_slices(FIXTURE, 0.02);
    assert_strip(reporter_series.as_bytes(), 0.02);
}

#[test]
fn issue_7292_five_stacked_five_percent_slices_preserve_the_strip() {
    let _producer = default_producer_guard();
    let five_percent = five_stacked_slices(&fixture_at_slope(0.05), 0.05);
    assert_strip(five_percent.as_bytes(), 0.05);
}

#[test]
fn issue_7292_finite_triangle_distance_has_analytic_controls() {
    let triangle = [[0.0,0.0,0.0],[2.0,0.0,0.0],[0.0,2.0,0.0]];
    // Interior perpendicular projection, finite edge, and finite vertex.
    for (point, expected) in [([0.5,0.5,3.0],9.0),([1.0,-2.0,0.0],4.0),([2.0,2.0,0.0],2.0),([-1.0,-2.0,0.0],5.0)] {
        assert_eq!(triangle_distance_squared(point,triangle),expected);
        assert_eq!(triangle_distance_squared(point,[triangle[2],triangle[1],triangle[0]]),expected,
            "#7292: finite distance is independent of winding");
    }
    assert_eq!(triangle_distance_squared([1.0,3.0,0.0],[[0.0,0.0,0.0],[2.0,0.0,0.0],[1.0,0.0,0.0]]),9.0,
        "#7292: degenerate triangle retains its finite segment");
    assert_eq!(triangle_distance_squared([1.0,2.0,2.0],[[0.0,0.0,0.0];3]),9.0,
        "#7292: degenerate triangle retains its point");
}

#[cfg(feature = "triangulation-alt")]
#[test]
fn issue_7292_actual_alt_policy_preserves_all_five_reporter_cases() {
    let _producer = default_producer_guard();
    struct ResetAlt;
    impl Drop for ResetAlt {
        fn drop(&mut self) { ifc_lite_geometry::set_alt_triangulator(false); }
    }
    let _reset = ResetAlt;
    ifc_lite_geometry::set_alt_triangulator(true);
    // Call the shared invariant directly, avoiding nested mutex acquisition.
    assert_strip(FIXTURE.as_bytes(), 0.02);
    assert_strip(fixture_at_slope(0.0).as_bytes(), 0.0);
    assert_strip(fixture_at_slope(0.05).as_bytes(), 0.05);
    assert_strip(five_stacked_slices(FIXTURE,0.02).as_bytes(),0.02);
    assert_strip(five_stacked_slices(&fixture_at_slope(0.05),0.05).as_bytes(),0.05);
}
