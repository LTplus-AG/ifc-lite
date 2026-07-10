// Parity harness: identical program to spike-parity-ts/harness.ts.
// Prints f64 results as raw bit patterns so outputs can be diffed byte-exactly.
#![allow(non_snake_case)]
mod plato;
use plato::*;

struct Rng {
    a: u32,
}
impl Rng {
    fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b79f5);
        let a = self.a;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
    fn range(&mut self, min: f64, max: f64) -> f64 {
        min + self.next() * (max - min)
    }
}

fn bits(x: f64) -> String {
    format!("{:016x}", x.to_bits())
}

fn main() {
    let mut rng = Rng { a: 0xC0FFEE };
    let pts: Vec<Vector3D> = (0..256)
        .map(|_| {
            let x = rng.range(-50.0, 50.0);
            let y = rng.range(-50.0, 50.0);
            let z = rng.range(-50.0, 50.0);
            Vector3D::new(x, y, z)
        })
        .collect();

    let mut box_a = Constants::EmptyBox();
    for p in &pts[..128] {
        box_a = box_a.Include(*p);
    }
    let mut box_b = Constants::EmptyBox();
    for p in &pts[128..] {
        box_b = box_b.Include(*p);
    }

    let u = box_a.Union(box_b);
    let w = u.FoldOrigin(Vector3D::new(12.5, -7.25, 3.001));
    let e = w.Expand(0.0075);

    let mut cnt = 0;
    for p in &pts {
        if u.Contains(p.Scale(0.5)) {
            cnt += 1;
        }
    }

    println!("u.min={} {} {}", bits(u.Min.X), bits(u.Min.Y), bits(u.Min.Z));
    println!("u.max={} {} {}", bits(u.Max.X), bits(u.Max.Y), bits(u.Max.Z));
    let c = w.Center();
    println!("w.center={} {} {}", bits(c.X), bits(c.Y), bits(c.Z));
    let ext = e.Extent();
    println!("e.extent={} {} {}", bits(ext.X), bits(ext.Y), bits(ext.Z));
    println!("e.halfdiag={}", bits(e.HalfDiagonal()));
    println!("contains={}", cnt);
    println!("intersects={}", box_a.Intersects(box_b));
    println!("empty={}", Constants::EmptyBox().IsEmptyBox());
}
