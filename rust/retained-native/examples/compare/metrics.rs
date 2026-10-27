// SPDX-License-Identifier: MPL-2.0
//! Independent f64 measurements, using exact coordinate keys without welding.
use std::collections::BTreeMap;
#[derive(Clone, Debug)]
pub struct Metrics {
    pub volume: f64,
    pub area: f64,
    pub bbox: [f64; 6],
    pub defects: usize,
}
impl Default for Metrics {
    fn default() -> Self {
        Self {
            volume: 0.,
            area: 0.,
            bbox: [
                f64::INFINITY,
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ],
            defects: 0,
        }
    }
}
pub fn transform(m: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12])
}
pub fn extend_bbox(b: &mut [f64; 6], p: [f64; 3]) {
    for i in 0..3 {
        b[i] = b[i].min(p[i]);
        b[i + 3] = b[i + 3].max(p[i]);
    }
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.into_iter().zip(b).map(|(x, y)| x * y).sum()
}
fn key(p: [f64; 3]) -> [u64; 3] {
    p.map(|x| if x == 0. { 0 } else { x.to_bits() })
}
impl Metrics {
    pub fn add_mesh(&mut self, points: &[[f64; 3]], indices: &[u32]) -> Result<(), String> {
        if points.iter().flatten().any(|x| !x.is_finite()) || !indices.len().is_multiple_of(3) {
            return Err("nonfinite positions or incomplete triangle".into());
        }
        let Some(origin) = points.first() else {
            return Err("empty mesh".into());
        };
        let mut edges = BTreeMap::new();
        let mut volume = 0.;
        for triangle in indices.chunks_exact(3) {
            let a = *points.get(triangle[0] as usize).ok_or("bad mesh index")?;
            let b = *points.get(triangle[1] as usize).ok_or("bad mesh index")?;
            let c = *points.get(triangle[2] as usize).ok_or("bad mesh index")?;
            for p in [a, b, c] {
                extend_bbox(&mut self.bbox, p);
            }
            let normal = cross(sub(b, a), sub(c, a));
            self.area += dot(normal, normal).sqrt() / 2.;
            volume += dot(sub(a, *origin), cross(sub(b, *origin), sub(c, *origin))) / 6.;
            for (a, b) in [(a, b), (b, c), (c, a)] {
                let (a, b) = (key(a), key(b));
                *edges
                    .entry(if a < b { (a, b) } else { (b, a) })
                    .or_insert(0usize) += 1;
            }
        }
        // Signed contributions cancel folds/cavities within this mesh. Only
        // complete mesh volumes are made positive when accumulating parts.
        self.volume += volume.abs();
        self.defects += edges.values().filter(|&&n| n != 2).count();
        Ok(())
    }
}
pub fn relative(actual: f64, expected: f64) -> f64 {
    if expected == 0. {
        if actual == 0. {
            0.
        } else {
            f64::INFINITY
        }
    } else {
        (actual - expected).abs() / expected.abs()
    }
}
pub fn bbox_deviation(a: &[f64; 6], b: &[f64; 6]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(a, b)| (a - b).abs())
        .fold(0., |maximum, deviation| {
            if deviation.is_finite() {
                maximum.max(deviation)
            } else {
                f64::INFINITY
            }
        })
}

#[cfg(test)]
#[path = "metrics_tests.rs"]
mod tests;
