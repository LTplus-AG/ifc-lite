// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

    #[test]
    fn test_rectangle_profile() {
        let content = r#"
#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,100.0,200.0);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(1).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 4);
        assert!(!profile.outer.is_empty());
    }

    #[test]
    fn test_circle_profile() {
        let content = r#"
#1=IFCCIRCLEPROFILEDEF(.AREA.,$,$,50.0);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(1).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 36); // Circle with 36 segments
        assert!(!profile.outer.is_empty());
    }

    #[test]
    fn test_i_shape_profile() {
        let content = r#"
#1=IFCISHAPEPROFILEDEF(.AREA.,$,$,200.0,300.0,10.0,15.0,$,$,$,$);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(1).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 12); // I-shape has 12 vertices
        assert!(!profile.outer.is_empty());
    }

    /// Shoelace area of a profile's outer boundary.
    fn outer_area(profile: &Profile2D) -> f64 {
        let p = &profile.outer;
        let n = p.len();
        let mut a = 0.0;
        for i in 0..n {
            let b = p[(i + 1) % n];
            a += p[i].x * b.y - b.x * p[i].y;
        }
        a.abs() * 0.5
    }

    // I-shape FilletRadius rounds the four web↔flange junctions (concave, adds
    // root-fillet material). ISSUE_021 I-beam #4416: W180 D171 tw6 tf9.5,
    // FilletRadius 15. Closed-form area: sharp 4332 + 4·r²(1−π/4) ≈ 4525.1 mm².
    #[test]
    fn test_i_shape_honours_fillet_radius() {
        let sharp = process_content(
            "#1=IFCISHAPEPROFILEDEF(.AREA.,$,$,180.,171.,6.,9.5,$,$,$);\n",
            1,
        );
        let filleted = process_content(
            "#1=IFCISHAPEPROFILEDEF(.AREA.,$,$,180.,171.,6.,9.5,15.,$,$);\n",
            1,
        );
        assert_eq!(sharp.outer.len(), 12, "sharp I should stay 12 points");
        assert!(
            filleted.outer.len() > 12,
            "fillets not generated: {} points",
            filleted.outer.len()
        );
        // Closed-form uses ideal arcs; the 6-segment-per-corner tessellation of
        // four concave fillets over-estimates by ~8 mm² (chords bow outward on a
        // concave fillet). Tolerance absorbs that while still pinning the sign
        // (filleted ≈ 4525, clearly above sharp 4332).
        let k = 1.0 - std::f64::consts::FRAC_PI_4;
        let expected = 4332.0 + 4.0 * 15.0 * 15.0 * k;
        let area = outer_area(&filleted);
        assert!(
            (area - expected).abs() < 15.0 && area > outer_area(&sharp) + 100.0,
            "I fillet area {area:.2} vs expected {expected:.2} (sharp {:.2})",
            outer_area(&sharp)
        );
        // bbox unchanged (fillets are interior).
        let (mnx, mny, mxx, mxy) = outer_bbox(&filleted);
        assert!((mxx - mnx - 180.0).abs() < 1e-6 && (mxy - mny - 171.0).abs() < 1e-6);
    }

    // U-shape (channel): FilletRadius rounds the 2 inner web↔flange junctions
    // (concave, +), EdgeRadius rounds the 2 flange toes (convex, −). Depth 200,
    // FlangeWidth 80, WebThickness 10, FlangeThickness 12, FilletRadius 12,
    // EdgeRadius 6. Sharp 3680 + 2·12²(1−π/4) − 2·6²(1−π/4) ≈ 3726.3 mm².
    #[test]
    fn test_u_shape_honours_radii() {
        let sharp = process_content(
            "#1=IFCUSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,10.,12.,$,$,$,$);\n",
            1,
        );
        let filleted = process_content(
            "#1=IFCUSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,10.,12.,12.,6.,$,$);\n",
            1,
        );
        assert_eq!(sharp.outer.len(), 8);
        assert!(filleted.outer.len() > 8, "U fillets not generated");
        let k = 1.0 - std::f64::consts::FRAC_PI_4;
        let expected = 3680.0 + 2.0 * 144.0 * k - 2.0 * 36.0 * k;
        let area = outer_area(&filleted);
        assert!(
            (area - expected).abs() < 12.0,
            "U area {area:.2} vs expected {expected:.2}"
        );
        // bbox unchanged: FlangeWidth × Depth.
        let (mnx, mny, mxx, mxy) = outer_bbox(&filleted);
        assert!((mxx - mnx - 80.0).abs() < 1e-6 && (mxy - mny - 200.0).abs() < 1e-6);
    }

    // T-shape: FilletRadius at the 2 web↔flange junctions (concave, +),
    // FlangeEdgeRadius at the 2 flange toes and WebEdgeRadius at the 2 web-end
    // corners (convex, −). Depth 100, FlangeWidth 80, WebThickness 10,
    // FlangeThickness 12, FilletRadius 8, FlangeEdgeRadius 4, WebEdgeRadius 3.
    // Sharp 1840 + 2·8²(1−π/4) − 2·4²(1−π/4) − 2·3²(1−π/4) ≈ 1856.8 mm².
    #[test]
    fn test_t_shape_honours_radii() {
        let sharp = process_content(
            "#1=IFCTSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,12.,$,$,$,$,$);\n",
            1,
        );
        let filleted = process_content(
            "#1=IFCTSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,12.,8.,4.,3.,$,$);\n",
            1,
        );
        assert_eq!(sharp.outer.len(), 8);
        assert!(filleted.outer.len() > 8, "T fillets not generated");
        let k = 1.0 - std::f64::consts::FRAC_PI_4;
        let expected = 1840.0 + 2.0 * 64.0 * k - 2.0 * 16.0 * k - 2.0 * 9.0 * k;
        let area = outer_area(&filleted);
        assert!(
            (area - expected).abs() < 10.0,
            "T area {area:.2} vs expected {expected:.2}"
        );
        // bbox unchanged: FlangeWidth × Depth.
        let (mnx, mny, mxx, mxy) = outer_bbox(&filleted);
        assert!((mxx - mnx - 80.0).abs() < 1e-6 && (mxy - mny - 100.0).abs() < 1e-6);
    }

    /// (min_x, min_y, max_x, max_y) of a profile's outer boundary.
    fn outer_bbox(profile: &Profile2D) -> (f64, f64, f64, f64) {
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for p in &profile.outer {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
        (min_x, min_y, max_x, max_y)
    }

    fn process_content(content: &str, id: u32) -> Profile2D {
        process_content_at(content, id, TessellationQuality::Medium)
    }

    fn process_content_at(content: &str, id: u32, quality: TessellationQuality) -> Profile2D {
        let mut decoder = EntityDecoder::new(content);
        let processor = ProfileProcessor::new(IfcSchema::new());
        let entity = decoder.decode_by_id(id).unwrap();
        processor.process(&entity, &mut decoder, quality).unwrap()
    }

    // A U-shape (channel) is centred on its bounding box: X spans
    // -FlangeWidth/2..+FlangeWidth/2, not 0..FlangeWidth. Regression for channels
    // being offset by half the flange width.
    #[test]
    fn test_u_shape_is_centered() {
        // Depth 160, FlangeWidth 64, WebThickness 5, FlangeThickness 8.4
        let profile =
            process_content("#1=IFCUSHAPEPROFILEDEF(.AREA.,$,$,160.,64.,5.,8.4,$,$,$,$);\n", 1);
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((min_x + max_x).abs() < 1e-9, "X not centred: {min_x}..{max_x}");
        assert!((min_y + max_y).abs() < 1e-9, "Y not centred: {min_y}..{max_y}");
        assert!((max_x - min_x - 64.0).abs() < 1e-9, "width should be FlangeWidth");
        assert!((max_y - min_y - 160.0).abs() < 1e-9, "height should be Depth");
    }

    // An L-shape (angle) is centred on its bounding box rather than having its
    // corner at the origin.
    #[test]
    fn test_l_shape_is_centered() {
        // Depth 100, Width 80, Thickness 10
        let profile =
            process_content("#1=IFCLSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,$,$,$,$,$);\n", 1);
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((min_x + max_x).abs() < 1e-9, "X not centred: {min_x}..{max_x}");
        assert!((min_y + max_y).abs() < 1e-9, "Y not centred: {min_y}..{max_y}");
        assert!((max_x - min_x - 80.0).abs() < 1e-9, "width should be Width");
        assert!((max_y - min_y - 100.0).abs() < 1e-9, "height should be Depth");
    }

    // L-shape FilletRadius (inner re-entrant corner, adds material) and
    // EdgeRadius (leg toes, removes material) must be honoured — pre-fix the
    // section was a sharp 6-point polygon (~5% oversized convex hull on steel
    // angles, ISSUE_021 beams). L100/100/10 with FilletRadius=12, EdgeRadius=6.
    #[test]
    fn test_l_shape_honours_fillet_and_edge_radii() {
        let profile = process_content(
            "#1=IFCLSHAPEPROFILEDEF(.AREA.,$,$,100.,100.,10.,12.,6.,$,$,$);\n",
            1,
        );
        // Rounded corners => far more than the 6 sharp vertices.
        assert!(
            profile.outer.len() > 6,
            "fillets not generated: {} points",
            profile.outer.len()
        );
        // bbox is still Width × Depth (radii sit inside the legs).
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((max_x - min_x - 100.0).abs() < 1e-6, "width {}", max_x - min_x);
        assert!((max_y - min_y - 100.0).abs() < 1e-6, "height {}", max_y - min_y);
        // Closed-form area: sharp 1900 + inner fillet r1²(1−π/4) − two toe
        // edges 2·r2²(1−π/4) = 1900 + (144−72)(1−π/4) ≈ 1915.45 mm². The
        // 6-segment arc tessellation introduces a small inscribed-polygon error.
        let k = 1.0 - std::f64::consts::FRAC_PI_4;
        let expected = 1900.0 + (144.0 - 72.0) * k;
        let n = profile.outer.len();
        let mut area = 0.0;
        for i in 0..n {
            let a = profile.outer[i];
            let b = profile.outer[(i + 1) % n];
            area += a.x * b.y - b.x * a.y;
        }
        area = area.abs() * 0.5;
        assert!(
            (area - expected).abs() < 5.0,
            "L fillet area {area:.2} vs expected {expected:.2} — wrong fillet sign/placement"
        );
    }

    // A T-shape is centred on its bounding box: Y spans -Depth/2..+Depth/2,
    // not 0..Depth.
    #[test]
    fn test_t_shape_is_centered() {
        // Depth 100, FlangeWidth 80, WebThickness 10, FlangeThickness 12
        let profile = process_content(
            "#1=IFCTSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,12.,$,$,$,$,$);\n",
            1,
        );
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((min_x + max_x).abs() < 1e-9, "X not centred: {min_x}..{max_x}");
        assert!((min_y + max_y).abs() < 1e-9, "Y not centred: {min_y}..{max_y}");
        assert!((max_x - min_x - 80.0).abs() < 1e-9, "width should be FlangeWidth");
        assert!((max_y - min_y - 100.0).abs() < 1e-9, "height should be Depth");
    }

    // A C-shape (lipped channel) must span its full Width × Depth. Pre-fix
    // `process_c_shape` dropped the Width attribute (4) and used Girth (6) as
    // the X extent, so the channel came out only ~Girth wide.
    #[test]
    fn test_c_shape_spans_width_and_depth() {
        // Depth 200, Width 80, WallThickness 6, Girth 20.
        let profile = process_content(
            "#1=IFCCSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,6.,20.,$);\n",
            1,
        );
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((min_x + max_x).abs() < 1e-9, "X not centred: {min_x}..{max_x}");
        assert!((min_y + max_y).abs() < 1e-9, "Y not centred: {min_y}..{max_y}");
        assert!(
            (max_x - min_x - 80.0).abs() < 1e-9,
            "width should be Width (80), got {}",
            max_x - min_x
        );
        assert!(
            (max_y - min_y - 200.0).abs() < 1e-9,
            "height should be Depth (200), got {}",
            max_y - min_y
        );
    }

    #[test]
    fn test_arbitrary_profile() {
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0));
#2=IFCCARTESIANPOINT((100.0,0.0));
#3=IFCCARTESIANPOINT((100.0,100.0));
#4=IFCCARTESIANPOINT((0.0,100.0));
#5=IFCPOLYLINE((#1,#2,#3,#4,#1));
#6=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#5);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(6).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 5); // 4 corners + closing point
        assert!(!profile.outer.is_empty());
    }

    #[test]
    fn test_derived_profile_applies_translation_rotation_and_scale() {
        let content = r#"
#1=IFCDIRECTION((0.0,1.0));
#2=IFCCARTESIANPOINT((10.0,20.0));
#3=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#1,$,#2,2.0);
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.0,4.0);
#5=IFCDERIVEDPROFILEDEF(.AREA.,$,#4,#3,$);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(5).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 4);
        assert!(profile.outer.contains(&Point2::new(14.0, 18.0)));
        assert!(profile.outer.contains(&Point2::new(14.0, 22.0)));
        assert!(profile.outer.contains(&Point2::new(6.0, 22.0)));
        assert!(profile.outer.contains(&Point2::new(6.0, 18.0)));
    }

    /// An ASYMMETRIC parent, so the mirror is observable at all.
    ///
    /// The previous fixture here mirrored a `2.0 x 4.0` rectangle about its own
    /// Y-axis: the corner SET maps onto itself, and the assertions were
    /// `contains()` (order-blind), so `mirror_profile_about_y_axis` could be
    /// deleted outright and the test still passed. Verified by mutation:
    /// replacing the outer loop's `p.x = -p.x` with `p.x = p.x` and dropping
    /// its `reverse()` left the whole `ifc-lite-geometry` lib suite green, and
    /// `issue_828_sectioned_solid_horizontal` — the only other in-crate
    /// `IfcMirroredProfileDef` coverage — green too. Stated as a property
    /// rather than a pass count on purpose: the count was 718 when first
    /// measured and is 724 today, so a number here goes stale on the next
    /// commit while "no other test observes the mirror" stays checkable.
    ///
    /// This L-shaped outer contour with an off-centre hole pins both halves of
    /// the reflection: every point's x negates, and each contour's winding
    /// reverses so an orientation-reversing reflection still hands the earcut
    /// tessellator a CCW outer loop.
    const L_WITH_HOLE_IFC: &str = r#"
#1=IFCCARTESIANPOINT((0.0,0.0));
#2=IFCCARTESIANPOINT((6.0,0.0));
#3=IFCCARTESIANPOINT((6.0,2.0));
#4=IFCCARTESIANPOINT((2.0,2.0));
#5=IFCCARTESIANPOINT((2.0,5.0));
#6=IFCCARTESIANPOINT((0.0,5.0));
#7=IFCPOLYLINE((#1,#2,#3,#4,#5,#6,#1));
#8=IFCCARTESIANPOINT((3.0,0.5));
#9=IFCCARTESIANPOINT((5.0,0.5));
#10=IFCCARTESIANPOINT((5.0,1.5));
#11=IFCPOLYLINE((#8,#9,#10,#8));
#12=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#7,(#11));
#13=IFCMIRROREDPROFILEDEF(.AREA.,$,#12,$,$);
"#;

    /// Twice the signed area of a closed contour (shoelace). Positive is CCW.
    fn signed_area2(points: &[Point2<f64>]) -> f64 {
        let n = points.len();
        (0..n)
            .map(|i| {
                let a = points[i];
                let b = points[(i + 1) % n];
                a.x * b.y - b.x * a.y
            })
            .sum()
    }

    #[test]
    fn test_mirrored_profile_negates_x_and_reverses_winding() {
        let mut decoder = EntityDecoder::new(L_WITH_HOLE_IFC);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let parent = processor
            .process(
                &decoder.decode_by_id(12).unwrap(),
                &mut decoder,
                TessellationQuality::Medium,
            )
            .unwrap();
        let mirrored = processor
            .process(
                &decoder.decode_by_id(13).unwrap(),
                &mut decoder,
                TessellationQuality::Medium,
            )
            .unwrap();

        // Sanity: the parent really is asymmetric about x, so a dropped
        // negation cannot hide, and it is authored CCW with a hole.
        assert!(
            parent.outer.iter().any(|p| p.x != 0.0),
            "fixture must be off the mirror axis"
        );
        assert!(
            signed_area2(&parent.outer) > 0.0,
            "fixture outer contour must be authored CCW"
        );
        assert_eq!(parent.holes.len(), 1, "fixture must carry a hole");

        // x -> -x, and the point order reverses.
        let n = parent.outer.len();
        assert_eq!(mirrored.outer.len(), n);
        for i in 0..n {
            let src = parent.outer[n - 1 - i];
            let got = mirrored.outer[i];
            assert!(
                (got.x + src.x).abs() < 1e-9 && (got.y - src.y).abs() < 1e-9,
                "outer[{i}]: expected ({}, {}), got ({}, {})",
                -src.x,
                src.y,
                got.x,
                got.y
            );
        }

        // The hole travels with it — same negation, same reversal.
        assert_eq!(mirrored.holes.len(), 1);
        let (ph, mh) = (&parent.holes[0], &mirrored.holes[0]);
        assert_eq!(mh.len(), ph.len());
        for i in 0..ph.len() {
            let src = ph[ph.len() - 1 - i];
            let got = mh[i];
            assert!(
                (got.x + src.x).abs() < 1e-9 && (got.y - src.y).abs() < 1e-9,
                "hole[{i}]: expected ({}, {}), got ({}, {})",
                -src.x,
                src.y,
                got.x,
                got.y
            );
        }

        // The reflection is orientation-reversing; the compensating `reverse()`
        // must hand the tessellator the SAME chirality it started with, or
        // downstream earcut emits inside-out triangles.
        assert!(
            signed_area2(&mirrored.outer) > 0.0,
            "mirrored outer must stay CCW, got area2 {}",
            signed_area2(&mirrored.outer)
        );
        assert!(
            signed_area2(mh).signum() == signed_area2(ph).signum(),
            "mirrored hole must keep the parent's chirality"
        );
    }

    /// `IfcMirroredProfileDef` redeclares `Operator` as derived (`*`) in IFC4,
    /// so `process_derived_with_depth` short-circuits on the subtype and never
    /// reads attribute 3. Pin that with an Operator that WOULD move the profile
    /// if it were applied: the result must be the bare mirror.
    #[test]
    fn test_mirrored_profile_ignores_any_supplied_operator() {
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0));
#2=IFCCARTESIANPOINT((6.0,0.0));
#3=IFCCARTESIANPOINT((6.0,2.0));
#4=IFCCARTESIANPOINT((2.0,2.0));
#5=IFCCARTESIANPOINT((2.0,5.0));
#6=IFCCARTESIANPOINT((0.0,5.0));
#7=IFCPOLYLINE((#1,#2,#3,#4,#5,#6,#1));
#12=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#7);
#14=IFCDIRECTION((0.0,1.0));
#15=IFCCARTESIANPOINT((100.0,200.0));
#16=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#14,$,#15,3.0);
#17=IFCMIRROREDPROFILEDEF(.AREA.,$,#12,#16,$);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let mirrored = processor
            .process(
                &decoder.decode_by_id(17).unwrap(),
                &mut decoder,
                TessellationQuality::Medium,
            )
            .unwrap();

        // Bare mirror of (6,0) is (-6,0). Had the operator (rotate +90 deg,
        // scale 3, translate (100,200)) been applied on top, no point would
        // sit anywhere near it.
        assert!(
            mirrored
                .outer
                .iter()
                .any(|p| (p.x + 6.0).abs() < 1e-9 && p.y.abs() < 1e-9),
            "expected the bare mirror; got {:?}",
            mirrored.outer
        );
        assert!(
            mirrored.outer.iter().all(|p| p.x <= 1e-9 && p.y <= 5.0 + 1e-9),
            "no point may be displaced by the ignored operator; got {:?}",
            mirrored.outer
        );
    }

    // ── trim_polyline / SweptDiskSolid trim-param coverage ────────────────────
    fn approx_eq_p3(a: Point3<f64>, b: Point3<f64>, tol: f64) -> bool {
        (a.x - b.x).abs() < tol && (a.y - b.y).abs() < tol && (a.z - b.z).abs() < tol
    }

    #[test]
    fn test_trim_polyline_full_range() {
        let pts = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
        ];
        let out = trim_polyline(&pts, 0.0, 1.0);
        assert_eq!(out.len(), 3);
        assert!(approx_eq_p3(out[0], pts[0], 1e-9));
        assert!(approx_eq_p3(out[1], pts[1], 1e-9));
        assert!(approx_eq_p3(out[2], pts[2], 1e-9));
    }

    #[test]
    fn test_trim_polyline_halves() {
        // 3 points evenly spaced from x=0 to x=2; trim to [0, 0.5] should give x ∈ [0, 1]
        let pts = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
        ];
        let first_half = trim_polyline(&pts, 0.0, 0.5);
        assert_eq!(first_half.len(), 2);
        assert!(approx_eq_p3(first_half[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(first_half[1], Point3::new(1.0, 0.0, 0.0), 1e-9));

        let second_half = trim_polyline(&pts, 0.5, 1.0);
        assert_eq!(second_half.len(), 2);
        assert!(approx_eq_p3(second_half[0], Point3::new(1.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(second_half[1], Point3::new(2.0, 0.0, 0.0), 1e-9));
    }

    #[test]
    fn test_trim_polyline_strict_interior() {
        // Trim [0.25, 0.75] over 5 evenly-spaced points (params 0, 0.25, 0.5, 0.75, 1)
        // Strict interior: only points at param 0.5 are added; boundaries are lerp'd.
        let pts: Vec<Point3<f64>> = (0..5)
            .map(|i| Point3::new(i as f64, 0.0, 0.0))
            .collect();
        let out = trim_polyline(&pts, 0.25, 0.75);
        // Expected: lerp(0.25)=x=1.0, mid=x=2.0, lerp(0.75)=x=3.0
        assert_eq!(out.len(), 3);
        assert!(approx_eq_p3(out[0], Point3::new(1.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(out[1], Point3::new(2.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(out[2], Point3::new(3.0, 0.0, 0.0), 1e-9));
    }

    #[test]
    fn test_trim_polyline_invalid_range() {
        let pts = vec![Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 0.0, 0.0)];
        // start >= end
        assert!(trim_polyline(&pts, 0.5, 0.5).is_empty());
        assert!(trim_polyline(&pts, 0.6, 0.4).is_empty());
        // too few points
        assert!(trim_polyline(&pts[..1], 0.0, 1.0).is_empty());
    }

    #[test]
    fn test_trim_polyline_two_points_partial() {
        let pts = vec![Point3::new(0.0, 0.0, 0.0), Point3::new(10.0, 0.0, 0.0)];
        let out = trim_polyline(&pts, 0.3, 0.7);
        assert_eq!(out.len(), 2);
        assert!(approx_eq_p3(out[0], Point3::new(3.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(out[1], Point3::new(7.0, 0.0, 0.0), 1e-9));
    }

    #[test]
    fn test_composite_curve_trim_first_segment_only() {
        // 3-segment composite curve along +Y, each segment 2.0 long
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCCARTESIANPOINT((0.0,4.0,0.0));
#4=IFCCARTESIANPOINT((0.0,6.0,0.0));
#5=IFCPOLYLINE((#1,#2));
#6=IFCPOLYLINE((#2,#3));
#7=IFCPOLYLINE((#3,#4));
#8=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);
#9=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#6);
#10=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#7);
#11=IFCCOMPOSITECURVE((#8,#9,#10),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(11).unwrap();

        // [0,1] → first segment only → points (0,0,0) and (0,2,0)
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(1.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 2.0, 0.0), 1e-9));

        // [1,2] → middle segment only
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(1.0), Some(2.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 2.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 4.0, 0.0), 1e-9));

        // [0,3] → all three segments concatenated (4 points after de-dup)
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(3.0))
            .unwrap();
        assert_eq!(pts.len(), 4);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[3], Point3::new(0.0, 6.0, 0.0), 1e-9));
    }

    #[test]
    fn test_composite_curve_trim_clamps_out_of_range() {
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCPOLYLINE((#1,#2));
#4=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#3);
#5=IFCCOMPOSITECURVE((#4),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(5).unwrap();

        // Negative start clamps to 0
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(-5.0), Some(1.0))
            .unwrap();
        assert_eq!(pts.len(), 2);

        // End beyond num_segments clamps to num_segments
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(99.0))
            .unwrap();
        assert_eq!(pts.len(), 2);

        // start == end → empty
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.5), Some(0.5))
            .unwrap();
        assert!(pts.is_empty());

        // start > end → empty
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.8), Some(0.2))
            .unwrap();
        assert!(pts.is_empty());
    }

    #[test]
    fn test_composite_curve_trim_fractional_multi_segment() {
        // 3-seg polyline along Y at 2.0 each; trim [0.5, 2.5] should yield
        // 2nd half of seg 0 + all of seg 1 + 1st half of seg 2:
        //   y = 1.0, 2.0, 4.0, 5.0
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCCARTESIANPOINT((0.0,4.0,0.0));
#4=IFCCARTESIANPOINT((0.0,6.0,0.0));
#5=IFCPOLYLINE((#1,#2));
#6=IFCPOLYLINE((#2,#3));
#7=IFCPOLYLINE((#3,#4));
#8=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);
#9=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#6);
#10=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#7);
#11=IFCCOMPOSITECURVE((#8,#9,#10),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(11).unwrap();

        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.5), Some(2.5))
            .unwrap();
        // Expected: lerp into seg0 at 0.5 → y=1, end of seg0/start of seg1 → y=2 (kept once),
        // end of seg1/start of seg2 → y=4 (kept once), lerp into seg2 at 0.5 → y=5
        let ys: Vec<f64> = pts.iter().map(|p| p.y).collect();
        assert_eq!(ys.len(), 4, "got points: {:?}", pts);
        assert!((ys[0] - 1.0).abs() < 1e-9);
        assert!((ys[1] - 2.0).abs() < 1e-9);
        assert!((ys[2] - 4.0).abs() < 1e-9);
        assert!((ys[3] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn test_polyline_trim_first_segment() {
        // 4-point polyline along Y: (0,0,0)→(0,2,0)→(0,4,0)→(0,6,0)
        // Parameter range is [0, 3]. Trim [0,1] = first segment only.
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCCARTESIANPOINT((0.0,4.0,0.0));
#4=IFCCARTESIANPOINT((0.0,6.0,0.0));
#5=IFCPOLYLINE((#1,#2,#3,#4));
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(5).unwrap();

        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(0.0), Some(1.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 2.0, 0.0), 1e-9));

        // Trim [1, 2] = middle segment
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(1.0), Some(2.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 2.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 4.0, 0.0), 1e-9));

        // Trim [0.5, 2.5] = half + full + half across 3 segments
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(0.5), Some(2.5))
            .unwrap();
        let ys: Vec<f64> = pts.iter().map(|p| p.y).collect();
        assert_eq!(ys.len(), 4, "got points: {:?}", pts);
        assert!((ys[0] - 1.0).abs() < 1e-9);
        assert!((ys[1] - 2.0).abs() < 1e-9);
        assert!((ys[2] - 4.0).abs() < 1e-9);
        assert!((ys[3] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn test_polyline_trim_clamps_and_inverts() {
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCPOLYLINE((#1,#2));
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(3).unwrap();

        // No params → full polyline
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, None, None)
            .unwrap();
        assert_eq!(pts.len(), 2);

        // Inverted → empty
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(0.8), Some(0.2))
            .unwrap();
        assert!(pts.is_empty());

        // Out-of-range clamps
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(-5.0), Some(99.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
    }

    #[test]
    fn test_composite_curve_trim_keeps_non_coincident_junction() {
        // Two segments whose endpoints don't coincide at the boundary
        // (a real-world artefact: model drift, mismatched cartesian points).
        // seg 0: (0,0,0)→(0,2,0); seg 1: (0,2.5,0)→(0,4.5,0).
        // Concatenating segments [0,2] must preserve all 4 distinct points —
        // dropping the first point of seg 1 would erase the gap and bend the
        // directrix.
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCCARTESIANPOINT((0.0,2.5,0.0));
#4=IFCCARTESIANPOINT((0.0,4.5,0.0));
#5=IFCPOLYLINE((#1,#2));
#6=IFCPOLYLINE((#3,#4));
#7=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);
#8=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#6);
#9=IFCCOMPOSITECURVE((#7,#8),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(9).unwrap();

        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(2.0))
            .unwrap();
        assert_eq!(pts.len(), 4, "got points: {:?}", pts);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 2.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[2], Point3::new(0.0, 2.5, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[3], Point3::new(0.0, 4.5, 0.0), 1e-9));
    }

    #[test]
    fn test_composite_curve_trim_same_sense_false() {
        // Single segment with SameSense=F should reverse before trim.
        // Polyline (0,0,0)→(0,10,0) reversed = (0,10,0)→(0,0,0).
        // Trim [0, 0.3] of reversed → first 30% of reversed → from y=10 to y=7.
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,10.0,0.0));
#3=IFCPOLYLINE((#1,#2));
#4=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#3);
#5=IFCCOMPOSITECURVE((#4),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(5).unwrap();

        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(0.3))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 10.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 7.0, 0.0), 1e-9));
    }

    // A negative Thickness / WebThickness on a parametric L/U/T/C/Z profile is
    // schema-invalid (IfcPositiveLengthMeasure) and (for L/U/T) previously panicked
    // f64::clamp (release too) via a negative fillet-radius bound. All are now
    // rejected as an Err at read time (element skipped), never a panic and never
    // mirrored/self-intersecting garbage.
    #[test]
    fn negative_profile_thickness_errors_not_panics() {
        let bad = [
            "#1=IFCLSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,-10.,$,$,$,$,$);\n",
            "#1=IFCUSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,-10.,12.,$,$,$);\n",
            "#1=IFCTSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,-10.,12.,$,$,$,$,$);\n",
            "#1=IFCCSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,-10.,20.,$);\n",
            "#1=IFCZSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,-10.,12.,$,$);\n",
        ];
        for content in bad {
            let mut decoder = EntityDecoder::new(content);
            let processor = ProfileProcessor::new(IfcSchema::new());
            let entity = decoder.decode_by_id(1).unwrap();
            let result = processor.process(&entity, &mut decoder, TessellationQuality::Medium);
            assert!(result.is_err(), "expected Err for malformed profile: {content}");
        }
        // A well-formed L-shape still processes fine (validation is not over-eager).
        let mut decoder = EntityDecoder::new("#1=IFCLSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,$,$,$,$,$);\n");
        let processor = ProfileProcessor::new(IfcSchema::new());
        let entity = decoder.decode_by_id(1).unwrap();
        assert!(processor
            .process(&entity, &mut decoder, TessellationQuality::Medium)
            .is_ok());
    }

    // Issue #1809: at Low/Lowest the parametric steel-section fillet and edge
    // radii collapse to sharp corners — a filleted I-section costs the same 12
    // outline vertices as an unfilleted one, cutting the cross-section triangle
    // count on slender members where the root fillet is sub-pixel anyway.
    #[test]
    fn steel_fillets_drop_to_sharp_corners_below_medium() {
        // ISSUE_021 W180 I-beam with FilletRadius 15 (same fixture as
        // `test_i_shape_honours_fillet_radius`).
        const I_BEAM: &str = "#1=IFCISHAPEPROFILEDEF(.AREA.,$,$,180.,171.,6.,9.5,15.,$,$);\n";
        for q in [TessellationQuality::Low, TessellationQuality::Lowest] {
            let profile = process_content_at(I_BEAM, 1, q);
            assert_eq!(
                profile.outer.len(),
                12,
                "{q:?} I-shape should be the 12-point sharp section"
            );
            // Sharp section area (closed form): 180·171 − (180−6)·(171−2·9.5).
            let expected = 180.0 * 171.0 - 174.0 * 152.0;
            let area = outer_area(&profile);
            assert!(
                (area - expected).abs() < 1e-6,
                "{q:?} sharp I area {area:.3} vs {expected:.3}"
            );
            // Fillets are interior, so the bbox is the nominal section either way.
            let (mnx, mny, mxx, mxy) = outer_bbox(&profile);
            assert!((mxx - mnx - 180.0).abs() < 1e-6 && (mxy - mny - 171.0).abs() < 1e-6);
        }
    }

    // Medium and above are untouched by #1809 — the arcs must stay byte-identical
    // to the pre-change output, which is the `TessellationQuality` identity
    // invariant the whole enum rests on.
    #[test]
    fn steel_fillets_unchanged_at_medium_and_above() {
        const I_BEAM: &str = "#1=IFCISHAPEPROFILEDEF(.AREA.,$,$,180.,171.,6.,9.5,15.,$,$);\n";
        let medium = process_content_at(I_BEAM, 1, TessellationQuality::Medium);
        assert!(
            medium.outer.len() > 12,
            "Medium must keep the fillet arcs, got {} points",
            medium.outer.len()
        );
        for q in [TessellationQuality::High, TessellationQuality::Highest] {
            let profile = process_content_at(I_BEAM, 1, q);
            assert_eq!(profile.outer.len(), medium.outer.len(), "{q:?} vertex count");
            for (a, b) in profile.outer.iter().zip(medium.outer.iter()) {
                assert_eq!((a.x, a.y), (b.x, b.y), "{q:?} must be byte-identical to Medium");
            }
        }
    }

    // Profiles carrying several independent radii collapse all of them together,
    // leaving the plain sharp corner counts: L = 6, U = 8, T = 8. The L-shape
    // separates FilletRadius (concave root) from EdgeRadius (convex toes), and
    // the T-shape splits its edge radius into flange and web variants, so this
    // covers the mixed concave/convex cases the I-shape alone does not.
    #[test]
    fn asymmetric_steel_radii_drop_together_below_medium() {
        let cases = [
            // Depth 100, Width 80, Thickness 10, FilletRadius 12, EdgeRadius 8.
            ("#1=IFCLSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,12.,8.,$,$,$);\n", 6),
            // Depth 200, FlangeWidth 80, Web 10, Flange 12, Fillet 12, Edge 6.
            ("#1=IFCUSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,10.,12.,12.,6.,$,$);\n", 8),
            // Depth 200, FlangeWidth 100, Web 10, Flange 15, Fillet 12,
            // FlangeEdgeRadius 6, WebEdgeRadius 4.
            ("#1=IFCTSHAPEPROFILEDEF(.AREA.,$,$,200.,100.,10.,15.,12.,6.,4.,$,$);\n", 8),
        ];
        for (content, sharp_points) in cases {
            for q in [TessellationQuality::Low, TessellationQuality::Lowest] {
                let profile = process_content_at(content, 1, q);
                assert_eq!(
                    profile.outer.len(),
                    sharp_points,
                    "{q:?} expected {sharp_points} sharp points for {content}"
                );
            }
            assert!(
                process_content(content, 1).outer.len() > sharp_points,
                "Medium must still round {content}"
            );
        }
    }
