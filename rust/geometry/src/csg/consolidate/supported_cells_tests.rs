use super::*;
fn buckets(faces: &[[[f64; 3]; 3]]) -> BTreeMap<Bucket, Vec<PlaneTri>> {
    let mut out = BTreeMap::new();
    for t in faces {
        let v = t.map(Point3::from);
        let normal = (v[1] - v[0]).cross(&(v[2] - v[0])).normalize();
        let key = (
            (normal.x * 1000.).round() as i64,
            (normal.y * 1000.).round() as i64,
            (normal.z * 1000.).round() as i64,
            0,
        );
        out.entry(key).or_insert_with(Vec::new).push(PlaneTri {
            v,
            normal,
            tag: None,
        });
    }
    out
}
#[test]
fn issue_7292_isolated_thin_cell_needs_all_three_healthy_opposite_supports() {
    let (a, b, c, d) = (
        [0., 0., 0.],
        [0.0002, 0., 0.],
        [4., 4., 0.],
        [0., -0.001, 0.001],
    );
    let faces = [[a, b, c], [b, a, d], [c, b, d], [a, c, d]];
    assert!(tri_is_needle(&faces[0].map(Point3::from)));
    assert_eq!(find(&buckets(&faces)).cells.len(), 1);
    assert!(
        find(&buckets(&faces[..3])).cells.is_empty(),
        "an open flap is not supported"
    );
    let mut reversed = faces;
    reversed[1].swap(0, 1);
    assert!(
        find(&buckets(&reversed)).cells.is_empty(),
        "same-direction incidence is not support"
    );
}
#[test]
fn issue_7292_bypassed_bucket_cannot_preserve_overlapping_or_reversed_interior_faces() {
    let (a, b, c) = ([0., 0., 0.], [0.0002, 0., 0.], [4., 4., 0.]);
    let faces = [
        [a, b, c],
        [b, a, [0., -0.0001, 0.]],
        [c, b, [8., 0., 0.]],
        [a, c, [-4., 4., 0.]],
    ];
    assert_eq!(find(&buckets(&faces)).cells.len(), 1);
    let interior = [[1., 0.2, 0.], [1.2, 0.2, 0.], [1.1, 0.3, 0.]];
    let mut overlapping = faces.to_vec();
    overlapping.push(interior);
    assert!(
        find(&buckets(&overlapping)).cells.is_empty(),
        "a marked bucket cannot preserve an unrelated overlapping face"
    );
    // Signed plane buckets are an established policy. Exercise SAT's winding
    // independence directly rather than changing opposite-normal grouping.
    overlapping.last_mut().unwrap().swap(0, 1);
    let signed = buckets(&overlapping);
    let mixed = signed.into_values().flatten().collect::<Vec<_>>();
    assert!(!nonoverlapping(&mixed));
}
