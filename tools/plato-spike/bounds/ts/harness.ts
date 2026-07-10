// Parity harness: identical program to spike-parity-rust/src/main.rs.
// Prints f64 results as raw bit patterns so outputs can be diffed byte-exactly.
import { Vector3D, BBox3, Constants } from './plato.g';

function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const view = new DataView(new ArrayBuffer(8));
function bits(x: number): string {
    view.setFloat64(0, x);
    return view.getBigUint64(0).toString(16).padStart(16, '0');
}

const rng = makeRng(0xc0ffee);
const range = (min: number, max: number) => min + rng() * (max - min);

const pts: Vector3D[] = [];
for (let i = 0; i < 256; i++) {
    const x = range(-50, 50);
    const y = range(-50, 50);
    const z = range(-50, 50);
    pts.push(new Vector3D(x, y, z));
}

let boxA = Constants.EmptyBox;
for (const p of pts.slice(0, 128)) boxA = boxA.Include(p);
let boxB = Constants.EmptyBox;
for (const p of pts.slice(128)) boxB = boxB.Include(p);

const u = boxA.Union(boxB);
const w = u.FoldOrigin(new Vector3D(12.5, -7.25, 3.001));
const e = w.Expand(0.0075);

let cnt = 0;
for (const p of pts) if (u.Contains(p.Scale(0.5))) cnt++;

console.log(`u.min=${bits(u.Min.X)} ${bits(u.Min.Y)} ${bits(u.Min.Z)}`);
console.log(`u.max=${bits(u.Max.X)} ${bits(u.Max.Y)} ${bits(u.Max.Z)}`);
const c = w.Center();
console.log(`w.center=${bits(c.X)} ${bits(c.Y)} ${bits(c.Z)}`);
const ext = e.Extent();
console.log(`e.extent=${bits(ext.X)} ${bits(ext.Y)} ${bits(ext.Z)}`);
console.log(`e.halfdiag=${bits(e.HalfDiagonal())}`);
console.log(`contains=${cnt}`);
console.log(`intersects=${boxA.Intersects(boxB)}`);
console.log(`empty=${Constants.EmptyBox.IsEmptyBox()}`);
