// SPDX-License-Identifier: MPL-2.0
//! #7955: preregistered f-i (d)/(e) source expectations from the fixture README.
//! These two products are additional witnesses, not additions to the coverage TSV.
use ifc_lite_processing::element::retained_runtime::{ShapeOnlyProduct, ShapePart};
use ifc_lite_retained_native::oracle::normals;
#[path = "../../examples/compare/metrics.rs"]
#[allow(dead_code)] // Reuse the existing frame transform; other measurements are unrelated here.
mod metrics;
use metrics::transform;

pub const MODEL: &str = "tests/fixtures/synthetic-retained/f-i-presentation.ifc";
pub const IDS: [u32; 2] = [425, 507];
// Same supporting-surface incidence bound as the normal source oracle.
const INCIDENCE: f64 = 1e-6;

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { std::array::from_fn(|i| a[i]-b[i]) }
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 { a.into_iter().zip(b).map(|(a,b)| a*b).sum() }
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
}
fn points(part: &ShapePart, triangle: &[u32]) -> [[f64; 3]; 3] {
    std::array::from_fn(|i| {
        let v = triangle[i] as usize * 3;
        transform(&part.world_from_object, [part.positions[v],part.positions[v+1],part.positions[v+2]])
    })
}
fn output(part: &ShapePart, triangle: usize) -> [[f64; 3]; 3] {
    let values = part.normals.as_ref().expect("source gate checked normal presence");
    std::array::from_fn(|i| {
        let n = triangle*9+i*3;
        [values[n],values[n+1],values[n+2]]
    })
}
fn on_plane(points: &[[f64; 3]; 3], origin: [f64; 3], normal: [f64; 3]) -> bool {
    points.iter().all(|&p| dot(sub(p,origin),normal).abs() <= INCIDENCE)
}
fn direction(actual: [f64; 3], expected: [f64; 3], limit: f64, label: &str) -> Result<(),String> {
    let error = normals::angle(actual,expected);
    if !error.is_finite() || error > limit { return Err(format!("{label}: normal angle {error} > {limit}")); }
    Ok(())
}

pub fn check(product: &ShapeOnlyProduct, planar: f64, curved: f64) -> Result<(),String> {
    match product.product_id {
        425 => arc(product,planar,curved),
        507 => bend(product,planar,curved),
        id => Err(format!("unexpected f-i normal witness #{id}")),
    }
}

fn arc(product: &ShapeOnlyProduct, planar: f64, curved: f64) -> Result<(),String> {
    let q = std::f64::consts::FRAC_1_SQRT_2;
    // Opening normals point into its void. Caps/end faces point out of the host.
    let planes = [
        ("jamb -Y", [0.,29.5,0.], [0.,1.,0.]),
        ("jamb +Y", [0.,30.5,0.], [0.,-1.,0.]),
        ("sill", [0.,30.,0.5], [0.,0.,1.]),
        ("lintel", [0.,30.,2.5], [0.,0.,-1.]),
        ("bottom", [0.,30.,0.], [0.,0.,-1.]),
        ("top", [0.,30.,3.], [0.,0.,1.]),
        ("end +45", [0.,30.,0.], [-q,q,0.]),
        ("end -45", [0.,30.,0.], [-q,-q,0.]),
    ];
    let mut planar_corners = [0; 8];
    let mut radial_corners = [0; 2];
    let mut smoothed = [0; 2];
    for part in &product.parts {
        for (t,triangle) in part.indices.chunks_exact(3).enumerate() {
            let p = points(part,triangle);
            let actual = output(part,t);
            if let Some(i) = planes.iter().position(|(_,o,n)| on_plane(&p,*o,*n)) {
                for n in actual { direction(n,planes[i].2,planar,planes[i].0)?; }
                planar_corners[i] += 3;
                continue;
            }
            let Some(i) = [5.,5.3].iter().position(|r|
                p.iter().all(|v| (v[0].hypot(v[1]-30.)-r).abs() <= INCIDENCE))
                else { return Err("f-i arc triangle lies on no hand-derived surface".into()); };
            let facet = cross(sub(p[1],p[0]),sub(p[2],p[0]));
            for (p,n) in p.into_iter().zip(actual) {
                let sign = if i == 0 {-1.} else {1.};
                direction(n,[sign*p[0],sign*(p[1]-30.),0.],curved,"arc radial wall")?;
                radial_corners[i] += 1;
                smoothed[i] += usize::from(normals::angle(n,facet) > 1e-9);
            }
        }
    }
    if planar_corners.contains(&0) || radial_corners.contains(&0) || smoothed.contains(&0) {
        return Err(format!("f-i arc coverage: planes {planar_corners:?}, radial {radial_corners:?}, smoothed {smoothed:?}"));
    }
    println!("f-i (d) planes {planar_corners:?}; radial {radial_corners:?}; smoothed {smoothed:?}");
    println!("sdk witness executed: m11_n_fi_arc");
    Ok(())
}

fn bend(product: &ShapeOnlyProduct, planar: f64, curved: f64) -> Result<(),String> {
    let (s,c) = 30_f64.to_radians().sin_cos();
    let joint = [2.,40.,0.];
    let starts = [[0.,40.,0.],joint];
    let tangents = [[1.,0.,0.],[c,s,0.]];
    let end = [2.+2.*c,40.+2.*s,0.];
    let bisector = [1.+c,s,0.];
    let caps = [(starts[0],[-1.,0.,0.]),(end,tangents[1])];
    let mut cap_corners = [0; 2];
    let mut wall_corners = [0; 2];
    let mut seam: [[Vec<[f64; 3]>; 2]; 2] = std::array::from_fn(|_| std::array::from_fn(|_| Vec::new()));
    for part in &product.parts {
        for (t,triangle) in part.indices.chunks_exact(3).enumerate() {
            let p = points(part,triangle);
            let actual = output(part,t);
            if let Some(i) = caps.iter().position(|(o,n)| on_plane(&p,*o,*n)) {
                for n in actual { direction(n,caps[i].1,planar,"bend cap")?; }
                cap_corners[i] += 3;
                continue;
            }
            let centroid = std::array::from_fn(|i| (p[0][i]+p[1][i]+p[2][i])/3.);
            let leg = usize::from(dot(sub(centroid,joint),bisector) > 0.);
            for (p,n) in p.into_iter().zip(actual) {
                let along = dot(sub(p,starts[leg]),tangents[leg]);
                let radial = std::array::from_fn(|i| p[i]-starts[leg][i]-along*tangents[leg][i]);
                direction(n,radial,curved,"bend radial wall")?;
                wall_corners[leg] += 1;
                // Only near the bend plane: +/-Z may legitimately remain smooth.
                if dot(sub(p,joint),bisector).abs() <= INCIDENCE
                    && p[2].abs() <= 0.05*5_f64.to_radians().sin() {
                    seam[usize::from(p[1] > 40.)][leg].push([n[0],n[1],0.]);
                }
            }
        }
    }
    if cap_corners.contains(&0) || wall_corners.contains(&0) || seam.iter().flatten().any(Vec::is_empty) {
        return Err(format!("f-i bend coverage: caps {cap_corners:?}, legs {wall_corners:?}, seam {:?}",
            seam.each_ref().map(|s| s.each_ref().map(Vec::len))));
    }
    let mut range = [f64::INFINITY,0_f64];
    for side in &seam { for &a in &side[0] { for &b in &side[1] {
        let angle = normals::angle(a,b);
        if angle <= 10_f64.to_radians() || (angle-30_f64.to_radians()).abs() > 2.*curved {
            return Err(format!("f-i in-plane bend angle {angle}: expected 30 degrees within two radial error bounds, above the 10-degree guard"));
        }
        range[0] = range[0].min(angle); range[1] = range[1].max(angle);
    } } }
    println!("f-i (e) caps {cap_corners:?}; radial legs {wall_corners:?}; in-plane angle range {range:?}");
    println!("sdk witness executed: m11_n_fi_bend");
    Ok(())
}
