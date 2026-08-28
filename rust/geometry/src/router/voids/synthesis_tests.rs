// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::ClippingProcessor;

/// Append a quad, ordering its winding so the facet normal points along
/// `target`. Deriving the winding instead of hand-listing corner order keeps
/// the fixture self-checking: an outward-facing fixture cannot silently become
/// inward-wound and quietly change what the code under test sees.
fn push_quad(m: &mut Mesh, quad: [Point3<f64>; 4], target: Vector3<f64>) {
    let n = (quad[1] - quad[0])
        .cross(&(quad[2] - quad[0]))
        .try_normalize(1e-12)
        .expect("degenerate quad in fixture");
    let q = if n.dot(&target) > 0.0 {
        [quad[0], quad[1], quad[2], quad[3]]
    } else {
        [quad[3], quad[2], quad[1], quad[0]]
    };
    let nrm = target.normalize();
    let b = m.vertex_count() as u32;
    for p in &q {
        m.add_vertex(*p, nrm);
    }
    m.add_triangle(b, b + 1, b + 2);
    m.add_triangle(b, b + 2, b + 3);
}

/// A wall whose window hole is ALREADY cut into its Brep, the way Archicad
/// exports a wall exploded into layer parts (issue #3219). Wall x 0..6,
/// y 0..0.4 (thickness), z 0..3; hole x 2..4, z 0.5..2.5, straight through.
///
/// The hole's jamb facets at x = 2 and x = 4 face INTO the hole, because the
/// pier of host material continues past them. That is the whole point of the
/// fixture: those facets are coincident with a cutter that fills the hole, and
/// coincidence alone used to qualify them for the flush-cap push.
fn pre_cut_wall() -> Mesh {
    pre_cut_wall_with_slot(2.0)
}

/// The same wall carrying a hole of an arbitrary width `w`, centred on x = 3.
///
/// Parametric because a cutter shallower than the jamb pull-in only reaches the
/// pull-in at all if the host's hole is as thin as the cutter: with a wide hole
/// the cutter's caps float clear of every facet and classify `Free`.
fn pre_cut_wall_with_slot(w: f64) -> Mesh {
    let p = |x: f64, y: f64, z: f64| Point3::new(x, y, z);
    let (a, b) = (3.0 - w * 0.5, 3.0 + w * 0.5);
    let mut m = Mesh::with_capacity(96, 144);
    // Front (y = 0) and back (y = 0.4) skins, each an annulus around the hole.
    for (y, out) in [(0.0, Vector3::new(0.0, -1.0, 0.0)), (0.4, Vector3::new(0.0, 1.0, 0.0))] {
        push_quad(&mut m, [p(0.0, y, 0.0), p(6.0, y, 0.0), p(6.0, y, 0.5), p(0.0, y, 0.5)], out);
        push_quad(&mut m, [p(0.0, y, 2.5), p(6.0, y, 2.5), p(6.0, y, 3.0), p(0.0, y, 3.0)], out);
        push_quad(&mut m, [p(0.0, y, 0.5), p(a, y, 0.5), p(a, y, 2.5), p(0.0, y, 2.5)], out);
        push_quad(&mut m, [p(b, y, 0.5), p(6.0, y, 0.5), p(6.0, y, 2.5), p(b, y, 2.5)], out);
    }
    // Outer faces.
    push_quad(&mut m, [p(0.0, 0.0, 0.0), p(6.0, 0.0, 0.0), p(6.0, 0.4, 0.0), p(0.0, 0.4, 0.0)], Vector3::new(0.0, 0.0, -1.0));
    push_quad(&mut m, [p(0.0, 0.0, 3.0), p(6.0, 0.0, 3.0), p(6.0, 0.4, 3.0), p(0.0, 0.4, 3.0)], Vector3::new(0.0, 0.0, 1.0));
    push_quad(&mut m, [p(0.0, 0.0, 0.0), p(0.0, 0.4, 0.0), p(0.0, 0.4, 3.0), p(0.0, 0.0, 3.0)], Vector3::new(-1.0, 0.0, 0.0));
    push_quad(&mut m, [p(6.0, 0.0, 0.0), p(6.0, 0.4, 0.0), p(6.0, 0.4, 3.0), p(6.0, 0.0, 3.0)], Vector3::new(1.0, 0.0, 0.0));
    // Hole reveals: outward normal points INTO the void.
    push_quad(&mut m, [p(a, 0.0, 0.5), p(a, 0.4, 0.5), p(a, 0.4, 2.5), p(a, 0.0, 2.5)], Vector3::new(1.0, 0.0, 0.0));
    push_quad(&mut m, [p(b, 0.0, 0.5), p(b, 0.4, 0.5), p(b, 0.4, 2.5), p(b, 0.0, 2.5)], Vector3::new(-1.0, 0.0, 0.0));
    push_quad(&mut m, [p(a, 0.0, 0.5), p(b, 0.0, 0.5), p(b, 0.4, 0.5), p(a, 0.4, 0.5)], Vector3::new(0.0, 0.0, 1.0));
    push_quad(&mut m, [p(a, 0.0, 2.5), p(b, 0.0, 2.5), p(b, 0.4, 2.5), p(a, 0.4, 2.5)], Vector3::new(0.0, 0.0, -1.0));
    // Self-check before anyone trusts it: 6*0.4*3 minus the w*0.4*2 hole. The
    // SIGN is asserted, not just the magnitude - facet orientation is the
    // property these fixtures exist to exercise, so `.abs()` here would hide
    // exactly the mistake the check is for. `push_quad` winds from the `target`
    // normal, so a wrong normal in any one of these sixteen quads (twelve call
    // sites, four of them inside a two-pass loop) flips a face and nothing else
    // would say so.
    let want = 7.2 - 0.8 * w;
    let vol = mesh_signed_volume(&m);
    assert!(
        (vol - want).abs() < 1e-6,
        "pre_cut_wall_with_slot({w}) is malformed or inward-wound: \
         signed volume {vol:.6}, expected {want:+.6}"
    );
    m
}

/// A jamb pull-in must stay inside the cutter it is moving within.
///
/// Why the bound exists is stated once, on [`CutterFrame::shrink`]; repeating
/// it here would be two copies free to drift apart on the next tune of the
/// constant. What is local to this test is the fixture it needs.
///
/// The host must carry a slot as thin as the cutter for the clamp to be
/// reachable at all: with a wide hole the cutter's caps float clear of every
/// facet, classify `Free`, and never move. An earlier version of this test put
/// a thin cutter inside `pre_cut_wall`'s 2 m hole and passed with the clamp
/// deleted, testing nothing.
///
/// 2 mm is the one case that can fail: it collapses to zero width without the
/// clamp. 4 mm is exactly break-even (`cap_band` and `span * RING_BAND_FRACTION`
/// are both 1 mm), so it discriminates nothing on its own and is kept only as
/// the largest span where `span * 0.5` is still the right expectation, which is
/// what makes the 2 mm row's expectation non-arbitrary. Wider spans were
/// dropped: above 4 mm `.min` selects `cap_band` with or without the clamp, so
/// such a row could not discriminate. Note it would also need a DIFFERENT
/// expectation, `span - 2 * cap_band` rather than `span * 0.5`, so it cannot
/// simply be added to this loop.
#[test]
fn a_pull_in_never_inverts_a_shallow_cutter() {
    for span in [0.002_f64, 0.004] {
        let host = pre_cut_wall_with_slot(span);
        let cutter = GeometryRouter::make_box_mesh(
            Point3::new(3.0 - span * 0.5, -10.0, 0.5),
            Point3::new(3.0 + span * 0.5, 10.4, 2.5),
        );
        let ext = GeometryRouter::extend_opening_mesh_through_host(
            &cutter,
            &host,
            Vector3::new(1.0, 0.0, 0.0),
        );
        let (mn, mx) = ext.bounds();
        let remaining = (mx.x as f64) - (mn.x as f64);
        // Exactly half is the designed floor (a quarter per cap). The
        // tolerance is absolute in the COORDINATE, not relative to the span:
        // `Mesh` stores f32, so each cap position is quantized at ulp(3) =
        // 2.38e-7 and a width differenced from two of them can be off by 2 ulp
        // = 4.77e-7 however narrow the cutter is. Measured here: 7.25e-8 at
        // 2 mm, 3.32e-7 at 4 mm, both inside that bound and inside the 1e-6
        // tolerance. A COLLAPSED cutter fails this; an inverted one does not,
        // which is what the volume assertion below is for.
        // The oracle is signed VOLUME, not the AABB. No bounds-based assertion
        // can see a symmetric over-pull: at `shrink = 0.75 * span` the two caps
        // swap places (min-cap vertices land at `omn + 0.75*span`, max-cap ones
        // at `omn + 0.25*span`) and the AABB comes back bit-identical to the
        // correct `[3 - span/4, 3 + span/4]`. Width is sign-blind for the same
        // reason, being |span - 2*shrink|. Turning the box inside out flips the
        // volume's SIGN, which is the one reading that survives the swap.
        //
        // Both caps are jambs at both spans, and the bound is the binding term
        // at 2 mm and exactly break-even at 4 mm, so each cap pulls in by a
        // quarter of the span either way: a box of `span/2` by 20.4 by 2.0.
        let (want_lo, want_hi) = (3.0 - span * 0.25, 3.0 + span * 0.25);
        assert!(
            ((mn.x as f64) - want_lo).abs() <= 1.0e-6
                && ((mx.x as f64) - want_hi).abs() <= 1.0e-6,
            "span {span}: caps at {:.9} .. {:.9}, expected {want_lo:.9} .. \
             {want_hi:.9} (width {remaining:.9})",
            mn.x,
            mx.x
        );
        // 20.4 deep in y (-10 .. 10.4), 2.0 tall in z (0.5 .. 2.5).
        let want_vol = span * 0.5 * 20.4 * 2.0;
        let vol = mesh_signed_volume(&ext);
        assert!(
            (vol - want_vol).abs() <= want_vol * 1.0e-3,
            "span {span}: cutter volume {vol:.9}, expected {want_vol:.9}; a \
             NEGATIVE value means the caps swapped and the box is inside out"
        );
    }
}

/// A coincident facet only votes on a cap if it sits UNDER the opening's
/// footprint. On a multi-body host a large plate lying in the same plane but
/// somewhere else entirely would otherwise outvote the real cap by area and
/// suppress a push that #1007 needs.
///
/// Slab 2 x 1 x 0.4 pierced from below; a 10 x 10 plate rests in the same
/// z = 0.4 plane but starts 3.5 m away. The plate's underside faces -z and is
/// 50x the cap's area, so an unrestricted area tally reads the exit cap as
/// re-entrant and skips the clearance push entirely.
#[test]
fn remote_coplanar_facet_does_not_outvote_a_local_exit_cap() {
    let slab = GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(2.0, 1.0, 0.4));
    let plate = GeometryRouter::make_box_mesh(Point3::new(5.0, 0.0, 0.4), Point3::new(15.0, 10.0, 0.6));
    let mut host = slab.clone();
    host.merge(&plate);
    let (inner, outer) = (-0.5, 0.4);
    let cutter = GeometryRouter::make_box_mesh(Point3::new(0.5, 0.25, inner), Point3::new(1.5, 0.75, outer));
    let span = outer - inner;

    let extended =
        GeometryRouter::extend_opening_mesh_through_host(&cutter, &host, Vector3::new(0.0, 0.0, 1.0));
    let clearance = extended.bounds().1.z as f64 - outer;

    assert!(
        clearance > 0.1 * span,
        "a remote coplanar facet must not outvote the local exit cap; the cap was \
         pushed clear by only {clearance:.4} of a {span:.4} span"
    );
}

/// Issue #3219. A cutter that exactly fills a hole the host ALREADY carries
/// must remove nothing, whatever axis the frame inference handed us.
///
/// `dir` here is the wall RUN, which is what `infer_opening_frame` picks for
/// the reporter's openings (they are 44 m deep and 1.21 m wide, and the
/// no-extrusion-direction branch picks the smallest extent). Before the exit-cap
/// sign test, both jambs read as flush caps and were each pushed `0.30 * span`
/// into the pier beside them, removing 2 * 0.6 * 0.4 * 2.0 = 0.96 m3 of wall
/// that no authored opening ever occupied.
///
/// This is the assertion shape the void suite lacked. Its existing tests
/// ray-cast "the wall has a hole", which is monotone in the cut: it passes just
/// as happily when the hole is far too wide. Removed-volume-equals-zero is
/// two-sided, so it bounds the cut hole against the authored one.
#[test]
fn flush_cap_is_not_pushed_into_a_pre_cut_jamb() {
    let host = pre_cut_wall();
    let cutter = GeometryRouter::make_box_mesh(Point3::new(2.0, -10.0, 0.5), Point3::new(4.0, 10.4, 2.5));
    let dir = Vector3::new(1.0, 0.0, 0.0);

    let extended = GeometryRouter::extend_opening_mesh_through_host(&cutter, &host, dir);
    let clipper = ClippingProcessor::new();
    let before = mesh_signed_volume(&host).abs();
    let cut = clipper
        .subtract_mesh(&host, &extended)
        .expect("subtract must not error on two closed boxes");
    let removed = before - mesh_signed_volume(&cut).abs();

    assert!(
        removed.abs() < 1.0e-3,
        "a cutter that exactly fills a hole the host already carries must remove \
         nothing; removed {removed:.4} m3 (the flush-cap pad ate the piers)"
    );
}

/// The other side of the same gate: a cap the opening genuinely EXITS through
/// still gets its clearance push, which is what issue #1007 / host #1112 needs
/// to avoid a high-aspect rim sliver at the exit seam. A pocket's floating
/// inner cap still must not move, or the pocket becomes a through-hole
/// (wall #552611).
///
/// The clearance is asserted as a BAND relative to the opening's own span, not
/// as the 0.30 constant, so retuning inside the measured clean band stays legal
/// while pad = 0 and a runaway pad both fail.
#[test]
fn flush_cap_on_a_genuine_exit_is_still_pushed_clear() {
    let slab = GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(2.0, 1.0, 0.4));
    // Pocket: outer cap flush with the slab's top face, inner cap floating.
    let (inner, outer) = (0.15, 0.4);
    let pocket = GeometryRouter::make_box_mesh(Point3::new(0.5, 0.25, inner), Point3::new(1.5, 0.75, outer));
    let span = outer - inner;

    let extended =
        GeometryRouter::extend_opening_mesh_through_host(&pocket, &slab, Vector3::new(0.0, 0.0, 1.0));
    let (mn, mx) = extended.bounds();
    let (new_inner, new_outer) = (mn.z as f64, mx.z as f64);

    let clearance = new_outer - outer;
    assert!(
        clearance > 0.1 * span && clearance < 1.0 * span,
        "an exit cap must be pushed clear of the surface by an opening-relative \
         margin; clearance {clearance:.4} is outside (0.1, 1.0) x span {span:.4}"
    );
    assert!(
        (new_inner - inner).abs() < 1.0e-6,
        "the floating inner cap must not move, or the pocket becomes a through-hole; \
         moved from {inner:.4} to {new_inner:.4}"
    );
}

/// Non-finite file coords (e.g. `1.E999` → +inf) make the bbox-fallback's
/// axis extents `inf - inf = NaN`; the old `partial_cmp().unwrap()` panicked
/// on that NaN. A zero `axis_dir` forces that fallback branch.
#[test]
fn remove_internal_membrane_no_panic_on_non_finite_coords() {
    let mut m = Mesh::new();
    // 4 triangles (the minimum the membrane pass processes), all x = +inf so
    // the fallback's ext[0] = inf - inf = NaN reaches the axis-length sort.
    for t in 0..4u32 {
        let base = t * 3;
        for k in 0..3u32 {
            m.positions
                .extend_from_slice(&[f32::INFINITY, t as f32 + k as f32, k as f32]);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }

    // Zero axis_dir → bbox fallback that sorts the NaN-bearing extents.
    let out =
        GeometryRouter::remove_internal_membrane(&m, Vector3::new(0.0, 0.0, 0.0));
    // Reaching here at all means no panic; sanity-check a well-formed result.
    assert_eq!(out.indices.len() % 3, 0);
}

/// ALL-NaN extents (every coordinate +inf, so ext = [NaN, NaN, NaN]) must
/// not panic either, and the result must be deterministic run-to-run —
/// `total_cmp` is a total order, so `max_by` resolves ties identically
/// every time (no HashMap/pointer nondeterminism can leak into the pick).
#[test]
fn remove_internal_membrane_deterministic_on_all_nan_extents() {
    let build = || {
        let mut m = Mesh::new();
        for t in 0..4u32 {
            let base = t * 3;
            for _ in 0..3u32 {
                m.positions.extend_from_slice(&[
                    f32::INFINITY,
                    f32::INFINITY,
                    f32::INFINITY,
                ]);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        }
        m
    };
    let a = GeometryRouter::remove_internal_membrane(&build(), Vector3::new(0.0, 0.0, 0.0));
    let b = GeometryRouter::remove_internal_membrane(&build(), Vector3::new(0.0, 0.0, 0.0));
    assert_eq!(a.indices, b.indices, "all-NaN extents must pick a deterministic axis");
    assert_eq!(a.positions.len(), b.positions.len());
    assert_eq!(a.indices.len() % 3, 0);
}

/// Pin the semantics the fix relies on: `total_cmp` orders -0.0 < 0.0 and
/// finite < NaN, and `max_by` keeps the LAST maximum on ties — so the axis
/// pick over any extent triple (including NaN and signed zeros) is total,
/// panic-free, and deterministic. This mirrors the exact selection
/// expression in `remove_internal_membrane`'s bbox fallback.
#[test]
fn axis_pick_total_order_semantics() {
    let pick = |ext: [f64; 3]| -> usize {
        (0..3).max_by(|&i, &j| ext[i].total_cmp(&ext[j])).unwrap()
    };
    assert_eq!(pick([-0.0, 0.0, -1.0]), 1, "+0.0 outranks -0.0 in the total order");
    assert_eq!(pick([0.0, 0.0, 0.0]), 2, "ties resolve to the last index");
    assert_eq!(pick([f64::NAN, f64::NAN, f64::NAN]), 2, "all-NaN ties resolve to the last index");
    assert_eq!(pick([f64::NAN, 1.0, 2.0]), 0, "positive NaN outranks finite values");
    assert_eq!(pick([1.0, f64::INFINITY, f64::NAN]), 2, "positive NaN outranks +inf");
}

/// Reverse every facet's winding. IFC bodies are not reliably outward-wound.
fn flip_winding(m: &Mesh) -> Mesh {
    let mut o = m.clone();
    for t in o.indices.chunks_exact_mut(3) {
        t.swap(1, 2);
    }
    o
}

/// Cap classification must not depend on host winding. IFC winding is not
/// reliably outward (`kernel/mesh_bridge.rs`), and the host is not oriented
/// until AFTER the cut (`processing/src/element.rs` runs
/// `orient_mesh_outward_verdict` on the result), so an inward-wound body
/// reaches this code exactly as authored.
///
/// `exit_cap::detect` qualifies a cap on parallelism plus coincidence and then
/// vetoes with RAY PARITY (`point_inside_mesh_agreed`), which counts crossings
/// and never reads a facet's orientation. This test pins that: flipping every
/// facet must change neither the #1007 exit clearance nor the #3219 jamb
/// verdict.
///
/// An earlier revision decided the cap from a SIGNED facet normal, taking the
/// host's global convention from its signed volume. Both failure modes were
/// reproduced against it: an inward-wound slab lost the #1007 clearance push
/// entirely (0.0000 of a 0.2500 span), and an inward-wound pre-cut wall got the
/// #3219 pier-eating back (the cutter grew to 1.400 .. 4.600 against an
/// authored 2.000 .. 4.000). It could not read a MIXED-winding body at all.
/// Parity has none of those failure modes, so that design was deleted rather
/// than patched.
#[test]
fn an_inward_wound_host_is_read_the_same_as_an_outward_one() {
    let up = Vector3::new(0.0, 0.0, 1.0);
    let slab = GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(2.0, 1.0, 0.4));
    let pocket =
        GeometryRouter::make_box_mesh(Point3::new(0.5, 0.25, 0.15), Point3::new(1.5, 0.75, 0.4));
    let clearance = |host: &Mesh| {
        GeometryRouter::extend_opening_mesh_through_host(&pocket, host, up)
            .bounds()
            .1
            .z as f64
            - 0.4
    };
    let (outward, inward) = (clearance(&slab), clearance(&flip_winding(&slab)));
    assert!(
        (outward - inward).abs() < 1.0e-9 && inward > 0.0,
        "an inward-wound host must get the same exit clearance as an outward one; \
         outward {outward:.6}, inward {inward:.6}"
    );

    let cutter =
        GeometryRouter::make_box_mesh(Point3::new(2.0, -10.0, 0.5), Point3::new(4.0, 10.4, 2.5));
    let ext = GeometryRouter::extend_opening_mesh_through_host(
        &cutter,
        &flip_winding(&pre_cut_wall()),
        Vector3::new(1.0, 0.0, 0.0),
    );
    let (mn, mx) = ext.bounds();
    // NOT equality. A jamb cap is now pulled one coincidence band INTO the void
    // the host already carries, rather than left exactly on the jamb plane,
    // because a coplanar cap grazes and tears (#295370 went 622 -> 1198 open
    // edges when the push was merely declined). The property that matters is
    // one-sided: the cutter must never exceed the authored opening, which is
    // what eats the pier. Under-reaching it by a band costs nothing, because
    // the host already carries the hole and the cutter is redundant there.
    let band = 2.0f64 * 1.0e-3; // cap_band for this 2 m span
    assert!(
        (mn.x as f64) >= 2.0 - 1.0e-6 && (mx.x as f64) <= 4.0 + 1.0e-6,
        "an inward-wound pre-cut host must not have its jambs pushed into the piers; \
         cutter spans {:.3} .. {:.3}, authored 2.000 .. 4.000",
        mn.x,
        mx.x
    );
    assert!(
        (mn.x as f64) <= 2.0 + band + 1.0e-6 && (mx.x as f64) >= 4.0 - band - 1.0e-6,
        "and it must not under-reach by more than the one band it is pulled in by; \
         cutter spans {:.3} .. {:.3}",
        mn.x,
        mx.x
    );
}
