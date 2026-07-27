/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B4.4 end-to-end forward-value cross-check.
 *
 * The Rust battery differentiates the extrusion mesher in process. This script
 * closes the last leg of the "is it the same function?" question by driving the
 * SAME parameter points through the real shipping pipeline - an IFC4 STEP file,
 * decoded and meshed by the wasm `GeometryProcessor` that the viewer and the
 * clash CLI use - and comparing the divergence-theorem volume of the mesh that
 * comes out against the instrumented forward value.
 *
 * Input: the JSON emitted by
 *   cargo test -p ifc-lite-geometry --lib b44_emit_cross_check -- --nocapture
 * (piped through the marker lines), by default read from stdin or --points FILE.
 *
 * Usage:
 *   node scripts/moonshot/b44-kernel-adjoint/kernel-cross-check.mjs --points pts.json
 */

import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const { GeometryProcessor } = await import(
  path.join(REPO_ROOT, 'packages/geometry/dist/index.js')
);

/** Divergence-theorem volume of a triangle soup (same form as the Rust side). */
function meshVolume(positions, indices) {
  let six = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    six += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(six / 6);
}

const f = (v) => {
  // IFC REAL literal: always a decimal point, enough digits to round-trip f64.
  const s = Number(v).toExponential(17);
  return s.replace('e', 'E');
};

/**
 * A minimal IFC4 file holding exactly one rectangular extrusion.
 *
 * The design parameters map one-to-one onto schema attributes:
 *   xdim/ydim -> IfcRectangleProfileDef.XDim / .YDim
 *   depth     -> IfcExtrudedAreaSolid.Depth
 *   dir*      -> IfcExtrudedAreaSolid.ExtrudedDirection (IfcDirection ratios)
 *   px,py,pz,theta -> IfcExtrudedAreaSolid.Position (IfcAxis2Placement3D)
 *
 * The placement is carried on the solid's `Position` rather than the product's
 * `ObjectPlacement` so that the pipeline applies it at exactly the point the
 * instrumented harness does (`ExtrudedAreaSolidProcessor` calls `extrude_profile`
 * and then `apply_transform(pos)`).
 */
function buildIfc(x) {
  const [xdim, ydim, depth, dirx, diry, dirz, px, py, pz, theta] = x;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const L = [];
  const add = (line) => {
    L.push(line);
    return L.length; // 1-based express id, emitted in order below
  };

  const dimExp = add(`#${L.length + 1}=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);`);
  const unitLen = add(`#${L.length + 1}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  const unitArea = add(`#${L.length + 1}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);
  const unitVol = add(`#${L.length + 1}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);
  const units = add(`#${L.length + 1}=IFCUNITASSIGNMENT((#${unitLen},#${unitArea},#${unitVol}));`);
  const originPt = add(`#${L.length + 1}=IFCCARTESIANPOINT((0.,0.,0.));`);
  const axisZ = add(`#${L.length + 1}=IFCDIRECTION((0.,0.,1.));`);
  const axisX = add(`#${L.length + 1}=IFCDIRECTION((1.,0.,0.));`);
  const worldCs = add(`#${L.length + 1}=IFCAXIS2PLACEMENT3D(#${originPt},#${axisZ},#${axisX});`);
  const ctx = add(
    `#${L.length + 1}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#${worldCs},$);`,
  );
  const project = add(
    `#${L.length + 1}=IFCPROJECT('0aaaaaaaaaaaaaaaaaaaaa',$,'B44',$,$,$,$,(#${ctx}),#${units});`,
  );
  const localPlace = add(`#${L.length + 1}=IFCLOCALPLACEMENT($,#${worldCs});`);

  const profile = add(
    `#${L.length + 1}=IFCRECTANGLEPROFILEDEF(.AREA.,'rect',$,${f(xdim)},${f(ydim)});`,
  );
  const solidLoc = add(`#${L.length + 1}=IFCCARTESIANPOINT((${f(px)},${f(py)},${f(pz)}));`);
  const solidAxis = add(`#${L.length + 1}=IFCDIRECTION((0.,0.,1.));`);
  const solidRef = add(`#${L.length + 1}=IFCDIRECTION((${f(c)},${f(s)},0.));`);
  const solidPos = add(
    `#${L.length + 1}=IFCAXIS2PLACEMENT3D(#${solidLoc},#${solidAxis},#${solidRef});`,
  );
  const dir = add(`#${L.length + 1}=IFCDIRECTION((${f(dirx)},${f(diry)},${f(dirz)}));`);
  const solid = add(
    `#${L.length + 1}=IFCEXTRUDEDAREASOLID(#${profile},#${solidPos},#${dir},${f(depth)});`,
  );
  const shapeRep = add(
    `#${L.length + 1}=IFCSHAPEREPRESENTATION(#${ctx},'Body','SweptSolid',(#${solid}));`,
  );
  const prodShape = add(`#${L.length + 1}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${shapeRep}));`);
  const proxy = add(
    `#${L.length + 1}=IFCBUILDINGELEMENTPROXY('1aaaaaaaaaaaaaaaaaaaaa',$,'B44Solid',$,$,#${localPlace},#${prodShape},$,$);`,
  );

  const header = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('b44.ifc','2026-07-27T00:00:00',(''),(''),'ifc-lite b44','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
`;
  void project;
  return { content: `${header}${L.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`, expressId: proxy };
}

async function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--points');
  const raw = pi >= 0 ? readFileSync(args[pi + 1], 'utf8') : readFileSync(0, 'utf8');
  const body = raw.includes('B44_XCHECK_BEGIN')
    ? raw.split('B44_XCHECK_BEGIN')[1].split('B44_XCHECK_END')[0]
    : raw;
  const points = JSON.parse(body.trim());

  const processor = new GeometryProcessor();
  await processor.init();

  const rows = [];
  let worstVsInstrumented = 0;
  let worstVsProductionInProcess = 0;
  let missing = 0;
  for (const [k, pt] of points.entries()) {
    const { content } = buildIfc(pt.x);
    const result = await processor.process(new TextEncoder().encode(content));
    let vol = 0;
    let meshes = 0;
    for (const mesh of result.meshes) {
      vol += meshVolume(mesh.positions, mesh.indices);
      meshes += 1;
    }
    if (meshes === 0) {
      missing += 1;
      rows.push({ point: k, meshes, note: 'no mesh emitted' });
      continue;
    }
    const relInstrumented = Math.abs(vol - pt.instrumentedVolume) / pt.instrumentedVolume;
    const relProduction =
      Math.abs(vol - pt.productionF32Volume) / pt.productionF32Volume;
    worstVsInstrumented = Math.max(worstVsInstrumented, relInstrumented);
    worstVsProductionInProcess = Math.max(worstVsProductionInProcess, relProduction);
    rows.push({
      point: k,
      meshes,
      wasmVolume: vol,
      instrumentedVolume: pt.instrumentedVolume,
      productionF32Volume: pt.productionF32Volume,
      relVsInstrumented: relInstrumented,
      relVsProductionInProcess: relProduction,
    });
    console.log(
      `point ${String(k).padStart(2)}: wasm ${vol.toFixed(9)}  instrumented ${pt.instrumentedVolume.toFixed(9)}  ` +
        `rel ${relInstrumented.toExponential(3)}  (vs in-process production f32: ${relProduction.toExponential(3)})`,
    );
  }

  console.log('---');
  console.log(`points: ${points.length}, meshes missing: ${missing}`);
  console.log(
    `worst relative deviation, wasm pipeline vs instrumented forward value: ${worstVsInstrumented.toExponential(3)}`,
  );
  console.log(
    `worst relative deviation, wasm pipeline vs in-process production f32:  ${worstVsProductionInProcess.toExponential(3)}`,
  );

  const out = path.join(__dirname, 'kernel-cross-check.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        points: points.length,
        missing,
        worstRelVsInstrumented: worstVsInstrumented,
        worstRelVsProductionInProcess: worstVsProductionInProcess,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${out}`);
  if (missing > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
