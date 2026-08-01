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
 *                                                                  [--allow-stale-build]
 *
 * ACCEPTANCE CRITERIA. See ACCEPTANCE below: this script FAILS (non-zero exit)
 * when a point emits no mesh, when a deviation is not finite, or when either
 * relative deviation exceeds its documented bar.
 */

import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ARGV = process.argv.slice(2);

/**
 * The bars this check is graded against, and why each is the number it is.
 *
 * Without these two constants the loop below computed deviations, printed them
 * and exited 0 no matter how large they were: the only failure it could produce
 * was "no mesh came out at all". A cross-check that cannot fail on the quantity
 * it measures is not evidence, so the deviations are now graded.
 *
 * `vsInstrumented` - the wasm pipeline's f32 mesh volume against the
 * instrumented f64 forward value. These two differ by one thing that is not a
 * defect: `Mesh` stores positions as `f32`, and at the battery's world
 * placements (up to 30 m from the origin) that quantisation is worth ~3e-6
 * relative. The in-process legs of the same comparison measured 2.968e-6
 * (family A) and 4.603e-6 (family B) worst-case over 1,200 points; 1e-5 is the
 * next round number above the largest figure this quantisation has ever
 * produced here. It is a bar on a KNOWN error source, not on the gradient.
 *
 * `vsProductionInProcess` - the wasm pipeline against the native in-process
 * production mesher, i.e. the same Rust source through two code generators on
 * the same f32 storage. Nothing but codegen (fused multiply-add, libm) can
 * differ, and the committed run's worst case is 2.4e-8. 1e-6 sits two orders
 * below the f32 quantisation floor above, so this bar cannot be satisfied by
 * "it rounded the same way": it fails if wasm is running a different function,
 * which is the question this leg exists to answer.
 *
 * Both bars are recorded in kernel-cross-check.json next to the figures they
 * graded, so a reader of the artifact sees the criterion, not just the result.
 */
const ACCEPTANCE = {
  vsInstrumented: 1e-5,
  vsProductionInProcess: 1e-6,
};

/**
 * The dynamic import below loads a BUILD ARTIFACT, not source. If it is missing
 * the bare module-not-found is unhelpful; worse, if it is stale the check
 * silently compares this revision's instrumented forward values against a mesher
 * compiled from some other revision, and reports agreement. So the provenance is
 * asserted here: the built bundle and the wasm binary must both exist and must
 * both be newer than every source file that feeds them.
 */
function assertBuildIsCurrent() {
  const dist = path.join(REPO_ROOT, 'packages/geometry/dist/index.js');
  const wasm = path.join(REPO_ROOT, 'packages/wasm/pkg/ifc-lite_bg.wasm');
  const BUILD_CMD = 'pnpm --filter @ifc-lite/geometry... build';
  for (const [what, p] of [['@ifc-lite/geometry build output', dist], ['the wasm binary', wasm]]) {
    if (!existsSync(p)) {
      console.error(
        `cross-check cannot run: ${what} is missing (${path.relative(REPO_ROOT, p)}).\n` +
          `Build it from this working tree first:\n  ${BUILD_CMD}`,
      );
      process.exit(1);
    }
  }
  const builtAt = Math.min(statSync(dist).mtimeMs, statSync(wasm).mtimeMs);
  const sourceDirs = [
    'packages/geometry/src',
    'rust/geometry/src',
    'rust/wasm-bindings/src',
  ];
  let newest = { at: 0, file: null };
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const at = statSync(p).mtimeMs;
        if (at > newest.at) newest = { at, file: p };
      }
    }
  };
  for (const d of sourceDirs) {
    const abs = path.join(REPO_ROOT, d);
    if (existsSync(abs)) walk(abs);
  }
  if (newest.file && newest.at > builtAt) {
    const msg =
      `cross-check build is STALE: ${path.relative(REPO_ROOT, newest.file)} is newer than the ` +
      'built artifacts, so the wasm under test was not compiled from this working tree.\n' +
      `Rebuild:\n  ${BUILD_CMD}`;
    if (!ARGV.includes('--allow-stale-build')) {
      console.error(`${msg}\n(pass --allow-stale-build to run anyway; the result is then not evidence)`);
      process.exit(1);
    }
    console.warn(`WARNING: ${msg}\nContinuing because --allow-stale-build was passed.`);
  }
}

assertBuildIsCurrent();

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
  const args = ARGV;
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
  let failed = 0;
  /** A deviation is acceptable only if it is a finite number at or under its bar. */
  const grade = (dev, limit) => Number.isFinite(dev) && dev <= limit;
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
      failed += 1;
      rows.push({ point: k, meshes, passed: false, note: 'no mesh emitted' });
      continue;
    }
    const relInstrumented = Math.abs(vol - pt.instrumentedVolume) / pt.instrumentedVolume;
    const relProduction =
      Math.abs(vol - pt.productionF32Volume) / pt.productionF32Volume;
    const okInstrumented = grade(relInstrumented, ACCEPTANCE.vsInstrumented);
    const okProduction = grade(relProduction, ACCEPTANCE.vsProductionInProcess);
    const passed = okInstrumented && okProduction;
    if (!passed) failed += 1;
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
      passed,
    });
    console.log(
      `point ${String(k).padStart(2)}: wasm ${vol.toFixed(9)}  instrumented ${pt.instrumentedVolume.toFixed(9)}  ` +
        `rel ${relInstrumented.toExponential(3)}  (vs in-process production f32: ${relProduction.toExponential(3)})` +
        (passed
          ? ''
          : `  FAIL${okInstrumented ? '' : ` [vs instrumented > ${ACCEPTANCE.vsInstrumented}]`}` +
            `${okProduction ? '' : ` [vs in-process production > ${ACCEPTANCE.vsProductionInProcess}]`}`),
    );
  }

  console.log('---');
  console.log(`points: ${points.length}, meshes missing: ${missing}, points failed: ${failed}`);
  console.log(
    `worst relative deviation, wasm pipeline vs instrumented forward value: ${worstVsInstrumented.toExponential(3)} ` +
      `[bar ${ACCEPTANCE.vsInstrumented}]`,
  );
  console.log(
    `worst relative deviation, wasm pipeline vs in-process production f32:  ${worstVsProductionInProcess.toExponential(3)} ` +
      `[bar ${ACCEPTANCE.vsProductionInProcess}]`,
  );

  const out = path.join(__dirname, 'kernel-cross-check.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        points: points.length,
        missing,
        failed,
        verdict: failed === 0 ? 'PASS' : 'FAIL',
        acceptance: ACCEPTANCE,
        worstRelVsInstrumented: worstVsInstrumented,
        worstRelVsProductionInProcess: worstVsProductionInProcess,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${out}`);
  console.log(failed === 0 ? 'cross-check PASS' : `cross-check FAIL (${failed} of ${points.length} points)`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
