// SPDX-License-Identifier: MPL-2.0
// #7955 fixed analytic oracles, shared by Node and the actual module Worker.
import { assert, request, response, f64, u32 } from './contract.mjs';
export async function runNormalContract(batch) {
  const call = async (op, ...fields) => response((await batch([request(op, ...fields)]))[0]);
  const session = await call(1);
  const results = [];
  try {
    for (const box of [false, true]) for (const scale of [[1, 1, 1], [-2, 3, 0.5]]) {
      const source = await call(box ? 3 : 4, session, ...[0, 0, 0, ...(box ? [2, 2, 3] : [2, 3])].map(f64));
      const matrix = [scale[0],0,0,0, 0,scale[1],0,0, 0,0,scale[2],0, 7,-4,2,1];
      const singular = matrix.slice(); singular[0] = 0;
      response((await batch([request(18, session, source, ...singular.map(f64))]))[0], 1);
      const copied = await call(18, session, source, ...matrix.map(f64));
      const solid = copied.slice(0, 16);
      const mesh = await call(9, session, solid, f64(0.001), f64(5));
      const info = new DataView((await call(10, session, mesh)).buffer);
      const vertices = info.getUint32(0, true), triangles = info.getUint32(4, true);
      assert(vertices > 0 && triangles > 0 && triangles <= 1000000, 'bounded normal witness');
      async function read(stream, count, width) {
        const out = [];
        for (let offset = 0; offset < count; offset += 480) {
          const size = Math.min(480, count - offset);
          const bytes = await call(11, session, mesh, u32(stream), u32(offset), u32(size));
          assert(bytes.length === size * width, 'normal witness count');
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let i = 0; i < size; i++) out.push(width === 8 ? view.getFloat64(i*8, true) : view.getUint32(i*4, true));
        }
        return out;
      }
      const p = await read(1, vertices*3, 8), indices = await read(2, triangles*3, 4);
      const normals = await read(4, triangles*9, 8);
      let lateral = 0;
      for (let t = 0; t < triangles; t++) {
        const points = indices.slice(t*3, t*3+3).map(index => {
          assert(index < vertices, 'normal witness index');
          return p.slice(index*3, index*3+3).map((x, i) => (x-matrix[12+i])/scale[i]);
        });
        let plane;
        for (let axis = 0; axis < 3; axis++) for (const side of [0, axis === 2 ? 3 : 2]) {
          if (!box && axis !== 2) continue;
          if (points.every(q => Math.abs(q[axis]-side) < 1e-7)) plane = { axis, side };
        }
        assert(!box || plane, 'sharp box analytic plane');
        if (!plane) lateral++;
        for (let corner = 0; corner < 3; corner++) {
          const q = points[corner];
          if (!plane) assert(Math.abs(q[0]*q[0]+q[1]*q[1]-4) < 1e-6, 'cylinder analytic locus');
          const sourceNormal = plane ? [0,1,2].map(i => i === plane.axis ? (plane.side === 0 ? -1 : 1) : 0) : [q[0], q[1], 0];
          // Gradient of ellipse after signed nonuniform map: A^-T n.
          const expected = sourceNormal.map((x, i) => x/scale[i]);
          const size = Math.hypot(...expected);
          const n = normals.slice(t*9+corner*3, t*9+corner*3+3);
          assert(n.every(Number.isFinite) && Math.abs(Math.hypot(...n)-1) < 1e-8, 'unit surface normal');
          assert(n.every((x, i) => Math.abs(x-expected[i]/size) < 1e-7), 'independent inverse-transpose corner normal');
        }
      }
      assert(box || lateral > 0, 'curved oracle reached');
      results.push({ box, scale, vertices, triangles, lateral });
      for (const h of [mesh, solid, source]) await call(8, session, h);
    }
    return results;
  } finally { await call(2, session); }
}
