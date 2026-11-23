/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The SHOWCASE look of the huge-geometry generator (scripts/perf/huge-geometry.md).
 * Footage only, never a measurement family: it exists so campaign videos show
 * a place instead of a lattice. The measurement families and their bytes live
 * in huge-geometry-gen.mjs / huge-geometry-ladder.mjs and are not touched.
 *
 * A showcase model is a city on a square spiral of 88 m blocks (72 m lots,
 * 16 m streets with a centre line, street trees). Each lot is a park or holds
 * one typology: a tower on a podium, parallel bars, a courtyard block or a
 * cluster of point towers. Heights fall off from the centre (a skyline), with
 * the odd landmark tower further out. Buildings are real IfcBuilding /
 * IfcBuildingStorey trees; every storey of every wing has a slab, a facade of
 * mullions (IfcMember), spandrel and glazing panels (IfcPlate), round columns,
 * a core, a duct and a pipe run, and instanced furniture; roofs carry
 * instanced plant. Colour carries meaning: one hue per building, a light
 * gradient up the storeys on the spandrels, glazing tinted by the building
 * hue, and fixed colours per element type (concrete, mullions, MEP orange /
 * red / blue, furniture, asphalt, lawn, trees).
 *
 * Elements are emitted block by block, building by building, storey by
 * storey until exactly `elements` are written, so a smaller tier is a prefix
 * of a larger one (the last building is cut off at a storey, like a
 * construction site). Output is a pure function of (elements, seed). One
 * model only (no federation). The manifest's `showcase` block carries what a
 * recorder needs: the city bounding box, the hero building (building 0, the
 * centre tower), the element ids of one hero storey and of the whole hero
 * building, anchor elements with exact world centres (to map IFC coordinates
 * onto the viewer's world), a pick target and the street next to the hero.
 */

import { ellipsoid, guid, prng, real } from './gen-dense-ifc.mjs';
import { meshGrid, mix, placement, writeShared } from './huge-geometry-shapes.mjs';
import { BAY, BLOCK, blockPlan } from './huge-geometry-showcase-city.mjs';

export { spiral } from './huge-geometry-showcase-city.mjs';

export const SHOWCASE_LABEL = 'SHOWCASE look (footage only, not a measurement family)';
export const SHOWCASE_VERSION = 1;
export const FLOOR_H = 3.6;
const HUES = 12;
const BANDS = 8;
/** Triangles of each furniture prototype (boxes of 12). */
const FURNITURE_TRIS = [24, 24, 12, 24];

function hsl(h, s, l) {
  const f = (n) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 1000) / 1000);
}

/** The style table: fixed type colours, then per building hue the spandrel gradient and a glazing tint. */
export function showcasePalette() {
  const type = {
    slab: [0.80, 0.79, 0.76], column: [0.66, 0.64, 0.62], core: [0.78, 0.42, 0.30], mullion: [0.16, 0.18, 0.22],
    duct: [1.00, 0.56, 0.08], pipeRed: [0.90, 0.16, 0.18], pipeBlue: [0.12, 0.46, 0.95], wood: [0.93, 0.80, 0.52],
    teal: [0.10, 0.66, 0.62], magenta: [0.86, 0.26, 0.60], coral: [1.00, 0.45, 0.38], plant: [0.74, 0.77, 0.80],
    fan: [0.25, 0.27, 0.30], asphalt: [0.20, 0.21, 0.24], plaza: [0.70, 0.67, 0.62], lawn: [0.36, 0.64, 0.30],
    marking: [0.97, 0.95, 0.85], trunk: [0.42, 0.29, 0.18], canopy0: [0.22, 0.55, 0.22], canopy1: [0.40, 0.66, 0.20],
    canopy2: [0.16, 0.45, 0.30], roof: [0.55, 0.57, 0.60],
  };
  const colours = [], index = {};
  for (const [k, c] of Object.entries(type)) { index[k] = colours.length; colours.push(c); }
  const spandrel = [], glazing = [];
  for (let h = 0; h < HUES; h++) {
    const hue = (h / HUES + 0.03) % 1;
    spandrel.push(Array.from({ length: BANDS }, (_, b) => { colours.push(hsl(hue, 0.78, 0.36 + (0.38 * b) / (BANDS - 1))); return colours.length - 1; }));
    colours.push(hsl(hue, 0.45, 0.78)); glazing.push(colours.length - 1);
  }
  return { colours, index, spandrel, glazing };
}

/** Resolve CLI options into the complete, JSON-stable showcase scenario. */
export function resolveShowcase(o) {
  const nominal = o.elements;
  if (!Number.isInteger(nominal) || nominal < 1) throw new Error(`elements must be a positive integer, got ${nominal}`);
  if (o.models !== undefined && o.models !== 1) throw new Error('the showcase look is a single model (no --models)');
  if (o.repeat !== undefined || o.tris !== undefined || (o.layout !== undefined && o.layout !== 'city')) {
    throw new Error('the showcase look takes no --repeat, --tris or --layout');
  }
  if (o.scenario !== undefined && o.scenario !== 'showcase') throw new Error(`--look showcase replaces the scenario; got --scenario ${o.scenario}`);
  const seed = o.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`seed must be a non-negative integer, got ${seed}`);
  const label = nominal >= 1e6 && nominal % 1e6 === 0 ? `${nominal / 1e6}M` : nominal >= 1e3 && nominal % 1e3 === 0 ? `${nominal / 1e3}k` : String(nominal);
  const name = o.name ?? ['showcase', label, ...(seed !== 1 ? [`s${seed}`] : [])].join('-');
  if (!/^[\w.-]+$/.test(name)) throw new Error(`name must be [A-Za-z0-9_.-], got ${name}`);
  return { name, look: 'showcase', version: SHOWCASE_VERSION, label: SHOWCASE_LABEL, scenario: 'showcase', nominal, elements: nominal,
    layout: 'city', models: 1, seed, parts: [] };
}

/**
 * Stream the showcase model of the resolved scenario `s` through `sink(text)`.
 * Returns the generator stats (elements, per-class counts, repeated, styles,
 * entities, bytes, triangles) and the `showcase` block for recorders.
 */
export function generateShowcaseModel(sink, s, m = 0) {
  if (m !== 0) throw new Error('the showcase look is a single model');
  const N = s.elements, seed = s.seed;
  let id = 0, bytes = 0, g = 0;
  const raw = (text) => { bytes += text.length; sink(text); };
  const rec = (body) => { raw(`#${++id}=${body};\n`); return id; };
  const gid = () => guid(2 ** 40 + ++g);
  raw(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\n`
    + `FILE_NAME('${s.name}.ifc','2026-11-23T00:00:00',('ifc-lite'),('ifc-lite'),'huge-geometry-gen showcase','huge-geometry-gen','');\n`
    + `FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n`);
  const person = rec("IFCPERSON($,$,'synthetic',$,$,$,$,$)");
  const org = rec("IFCORGANIZATION($,'synthetic',$,$,$)");
  const po = rec(`IFCPERSONANDORGANIZATION(#${person},#${org},$)`);
  const app = rec(`IFCAPPLICATION(#${org},'1','huge-geometry-gen','huge-geometry-gen')`);
  const oh = rec(`IFCOWNERHISTORY(#${po},#${app},$,.NOCHANGE.,$,$,$,0)`);
  const pal = showcasePalette();
  const shared = writeShared(rec, pal.colours);
  const ST = (k) => shared.styles[pal.index[k]];
  const xAxis = rec('IFCDIRECTION((1.,0.,0.))'), yAxis = rec('IFCDIRECTION((0.,1.,0.))');
  const lu = rec('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
  const au = rec('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
  const units = rec(`IFCUNITASSIGNMENT((#${lu},#${au}))`);
  const proj = rec(`IFCPROJECT('${gid()}',#${oh},'${s.name} (showcase city)',$,$,$,$,(#${shared.ctx}),#${units})`);
  const sitePl = rec(`IFCLOCALPLACEMENT($,#${shared.ax})`);
  const site = rec(`IFCSITE('${gid()}',#${oh},'Showcase city',$,$,#${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  rec(`IFCRELAGGREGATES('${gid()}',#${oh},$,$,#${proj},(#${site}))`);

  // Geometry helpers. Profiles are shared by dimensions (bounded cache); solids stay unique per element.
  const profiles = new Map();
  const profile = (xd, yd) => {
    const key = `${real(xd)},${real(yd)}`;
    let p = profiles.get(key);
    if (!p) {
      if (profiles.size > 4096) profiles.clear();
      p = rec(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${shared.ax2},${real(xd)},${real(yd)})`);
      profiles.set(key, p);
    }
    return p;
  };
  const styled = (item, style) => { rec(`IFCSTYLEDITEM(#${item},(#${style}),$)`); return item; };
  /** Box centred on (cx, cy) in plan, from z to z + h; `along` 'x'|'y' extrudes horizontally instead (length h). */
  const box = (xd, yd, h, style, cx = 0, cy = 0, z = 0, along = null) => {
    const at = cx || cy || z ? rec(`IFCCARTESIANPOINT((${real(cx)},${real(cy)},${real(z)}))`) : null;
    let pos;
    if (along === 'x') pos = rec(`IFCAXIS2PLACEMENT3D(#${at ?? shared.origin},#${xAxis},#${yAxis})`);
    else if (along === 'y') pos = rec(`IFCAXIS2PLACEMENT3D(#${at ?? shared.origin},#${yAxis},#${xAxis})`);
    else pos = at ? rec(`IFCAXIS2PLACEMENT3D(#${at},$,$)`) : shared.ax;
    return styled(rec(`IFCEXTRUDEDAREASOLID(#${profile(xd, yd)},#${pos},#${shared.zdir},${real(h)})`), style);
  };
  const cylinder = (radius, h, style, cx = 0, cy = 0, z = 0, along = null) => {
    const at = cx || cy || z ? rec(`IFCCARTESIANPOINT((${real(cx)},${real(cy)},${real(z)}))`) : shared.origin;
    const pos = along === 'x' ? rec(`IFCAXIS2PLACEMENT3D(#${at},#${xAxis},#${yAxis})`)
      : along === 'y' ? rec(`IFCAXIS2PLACEMENT3D(#${at},#${yAxis},#${xAxis})`) : rec(`IFCAXIS2PLACEMENT3D(#${at},$,$)`);
    const prof = rec(`IFCCIRCLEPROFILEDEF(.AREA.,$,#${shared.ax2},${real(radius)})`);
    return styled(rec(`IFCEXTRUDEDAREASOLID(#${prof},#${pos},#${shared.zdir},${real(h)})`), style);
  };
  const shape = (items, repType) => {
    const rep = rec(`IFCSHAPEREPRESENTATION(#${shared.body},'Body','${repType}',(${items.map((i) => `#${i}`).join(',')}))`);
    return rec(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  };
  const protoMap = (items, repType) => {
    const rep = rec(`IFCSHAPEREPRESENTATION(#${shared.body},'Body','${repType}',(${items.map((i) => `#${i}`).join(',')}))`);
    return rec(`IFCREPRESENTATIONMAP(#${shared.ax},#${rep})`);
  };
  const mapped = (map) => {
    const mi = rec(`IFCMAPPEDITEM(#${map},#${shared.cto})`);
    const rep = rec(`IFCSHAPEREPRESENTATION(#${shared.body},'Body','MappedRepresentation',(#${mi}))`);
    return rec(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  };
  const canopyTris = meshGrid(80);
  const canopy = (rand, rz) => {
    const { pts, tris } = ellipsoid(rand, canopyTris.rings, canopyTris.segs, 2.2 + rand(), 2.2 + rand(), rz, 0.12);
    const pl = rec(`IFCCARTESIANPOINTLIST3D((${pts.map(([x, y, z]) => `(${real(x)},${real(y)},${real(z + 2.4 + rz)})`).join(',')}))`);
    return styled(rec(`IFCTRIANGULATEDFACESET(#${pl},$,.T.,(${tris.map(([i, j, k]) => `(${i + 1},${j + 1},${k + 1})`).join(',')}),$)`), shared.styles[pal.index[`canopy${Math.floor(rand() * 3)}`]]);
  };

  // Prototypes (the instanced share): trees, furniture, rooftop plant.
  const trees = [0, 1, 2].map((k) => { const r = prng(mix(seed, 0x7EE, k)); return protoMap([box(0.35, 0.35, 2.6, ST('trunk')), canopy(r, 2.2 + 1.2 * r())], 'SurfaceModel'); });
  const furniture = [
    protoMap([box(1.6, 0.8, 0.05, ST('wood'), 0, 0, 0.72), box(0.45, 0.7, 0.7, ST('teal'), 0.5, 0, 0)], 'SweptSolid'),
    protoMap([box(2.4, 1.1, 0.05, ST('wood'), 0, 0, 0.74), box(0.6, 0.6, 0.72, ST('fan'), 0, 0, 0)], 'SweptSolid'),
    protoMap([box(0.9, 0.5, 1.5, ST('magenta'))], 'SweptSolid'),
    protoMap([box(2.0, 0.9, 0.45, ST('coral')), box(2.0, 0.25, 0.85, ST('coral'), 0, 0.33, 0)], 'SweptSolid'),
  ];
  const plant = [
    protoMap([box(3.2, 2.2, 1.6, ST('plant')), cylinder(0.7, 0.3, ST('fan'), 0.7, 0, 1.6), cylinder(0.7, 0.3, ST('fan'), -0.7, 0, 1.6)], 'SweptSolid'),
    protoMap([box(2.0, 2.0, 2.4, ST('plant')), cylinder(0.85, 0.2, ST('fan'), 0, 0, 2.4)], 'SweptSolid'),
  ];

  // Counters and the showcase block.
  let written = 0, done = N <= 0, repeated = 0, trisKnown = 0;
  const perClass = {};
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const grow = (x0, y0, z0, x1, y1, z1) => {
    bbox.min[0] = Math.min(bbox.min[0], x0); bbox.min[1] = Math.min(bbox.min[1], y0); bbox.min[2] = Math.min(bbox.min[2], z0);
    bbox.max[0] = Math.max(bbox.max[0], x1); bbox.max[1] = Math.max(bbox.max[1], y1); bbox.max[2] = Math.max(bbox.max[2], z1);
  };
  const hero = { building: 0, name: null, ids: [], storeys: [], anchors: [], bbox: null, pick: null };
  const siteIds = [];
  let blocks = 0, buildingCount = 0, storeyCount = 0, maxFloors = 0;
  const buildingIds = [];
  const contain = (ids, parent) => {
    if (ids.length) rec(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid()}',#${oh},$,$,(${ids.map((e) => `#${e}`).join(',')}),#${parent})`);
    ids.length = 0;
  };
  /**
   * Write one element: class, predefined type (null for furnishing), name,
   * parent placement, local (x, y, z), product shape. Returns its id, or null once the budget is spent.
   */
  const element = (cls, predefined, name, parentPl, x, y, z, pds, isMapped = false, tris = 12) => {
    if (done) return null;
    trisKnown += tris;
    const pl = placement(rec, parentPl, x, y, z);
    const tail = predefined ? `,.${predefined}.` : '';
    const e = rec(`${cls}('${gid()}',#${oh},'${name}',$,$,#${pl},#${pds()},$${tail})`);
    perClass[cls] = (perClass[cls] ?? 0) + 1;
    if (isMapped) repeated++;
    if (++written >= N) done = true;
    return e;
  };

  for (let b = 0; !done; b++) {
    const plan = blockPlan(seed, b);
    blocks++;
    const cx = plan.gx * BLOCK.pitch, cy = plan.gy * BLOCK.pitch, half = BLOCK.lot / 2, st = BLOCK.street;
    const r = prng(mix(seed, 0x517E, b));
    const blockPl = placement(rec, sitePl, cx, cy, 0);
    // Ground: lot (lawn for parks and courtyards, paving otherwise), the east and north streets and their centre lines.
    const push = (e) => { if (e !== null) { siteIds.push(e); if (siteIds.length >= 5000) contain(siteIds, site); } };
    const lawn = plan.kind === 'park' || plan.kind === 'court';
    push(element('IFCSLAB', 'BASESLAB', `Lot ${b}`, blockPl, 0, 0, -0.15, () => shape([box(BLOCK.lot, BLOCK.lot, 0.15, ST(lawn ? 'lawn' : 'plaza'))], 'SweptSolid')));
    push(element('IFCSLAB', 'BASESLAB', `Street E${b}`, blockPl, half + st / 2, st / 2, -0.25, () => shape([box(st, BLOCK.pitch, 0.2, ST('asphalt'))], 'SweptSolid')));
    push(element('IFCSLAB', 'BASESLAB', `Street N${b}`, blockPl, 0, half + st / 2, -0.25, () => shape([box(BLOCK.lot, st, 0.2, ST('asphalt'))], 'SweptSolid')));
    push(element('IFCBUILDINGELEMENTPROXY', 'ELEMENT', `Marking E${b}`, blockPl, half + st / 2, st / 2, -0.05, () => shape([box(0.3, BLOCK.pitch, 0.03, ST('marking'))], 'SweptSolid')));
    push(element('IFCBUILDINGELEMENTPROXY', 'ELEMENT', `Marking N${b}`, blockPl, 0, half + st / 2, -0.05, () => shape([box(BLOCK.lot, 0.3, 0.03, ST('marking'))], 'SweptSolid')));
    // Trees: along the lot edges, or a grid for a park.
    const spots = [];
    if (plan.kind === 'park') { for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) spots.push([-30 + i * 12 + (r() - 0.5) * 5, -30 + j * 12 + (r() - 0.5) * 5]); }
    else for (let k = 0; k < 6; k++) { const t = -30 + k * 12; spots.push([t, -half + 2], [t, half - 2], [-half + 2, t], [half - 2, t]); }
    for (const [tx, ty] of spots) push(element('IFCGEOGRAPHICELEMENT', 'NOTDEFINED', `Tree ${b}`, blockPl, tx, ty, 0, () => mapped(trees[mix(seed, b, Math.round(tx * 7 + ty * 13)) % 3]), true, 12 + canopyTris.triangles));
    grow(cx - half, cy - half, -0.3, cx + half + st, cy + half + st, 0);

    for (const bd of plan.buildings) {
      if (done) break;
      const bi = buildingCount++;
      const hue = b === 0 && bi === 0 ? 0 : mix(seed, 0xB1D, bi) % HUES;
      const floors = Math.max(...bd.wings.map((w) => w.f1));
      maxFloors = Math.max(maxFloors, floors);
      const bName = `B${bi} ${bd.kind}`;
      const bPl = placement(rec, blockPl, 0, 0, 0);
      const building = rec(`IFCBUILDING('${gid()}',#${oh},'${bName}',$,$,#${bPl},$,$,.ELEMENT.,$,$,$)`);
      buildingIds.push(building);
      const isHero = bi === 0;
      if (isHero) { hero.name = bName; hero.floors = floors; }
      const storeys = [];
      const heroStorey = Math.floor(floors * 0.6);
      for (let f = 0; f < floors && !done; f++) {
        const sPl = placement(rec, bPl, 0, 0, f * FLOOR_H);
        const storey = rec(`IFCBUILDINGSTOREY('${gid()}',#${oh},'${bName} L${f}',$,$,#${sPl},$,$,.ELEMENT.,${real(f * FLOOR_H)})`);
        storeys.push(storey); storeyCount++;
        const ids = [];
        const add = (e, anchor) => {
          if (e === null) return;
          ids.push(e);
          if (isHero) {
            if (hero.ids.length < 60000) hero.ids.push(e);
            if (anchor && hero.anchors.length < 8) hero.anchors.push({ id: e, centre: anchor });
          }
        };
        const band = Math.min(BANDS - 1, Math.floor((BANDS * f) / Math.max(1, floors - 1)));
        for (const w of bd.wings) {
          if (f < w.f0 || f >= w.f1 || done) continue;
          const wx = w.x + w.w / 2, wy = w.y + w.d / 2, z0 = f * FLOOR_H;
          // Slab (an anchor: exact box), then the facade on all four sides.
          add(element('IFCSLAB', 'FLOOR', `Slab ${bi}.${f}`, sPl, wx, wy, 0, () => shape([box(w.w, w.d, 0.3, ST('slab'))], 'SweptSolid')),
            f === 0 || f === floors - 1 ? [cx + wx, cy + wy, z0 + 0.15] : null);
          for (const side of ['S', 'E', 'N', 'W']) {
            const alongX = side === 'S' || side === 'N';
            const len = alongX ? w.w : w.d, n = Math.max(1, Math.round(len / BAY)), bay = len / n;
            const out = side === 'S' ? -1 : side === 'N' ? 1 : side === 'W' ? -1 : 1;
            for (let i = 0; i < n && !done; i++) {
              const t = (alongX ? w.x : w.y) + (i + 0.5) * bay, t0 = (alongX ? w.x : w.y) + i * bay;
              const edge = alongX ? (out < 0 ? w.y : w.y + w.d) : (out < 0 ? w.x : w.x + w.w);
              const at = (along, offset) => (alongX ? [along, edge + out * offset] : [edge + out * offset, along]);
              const dims = (a, d) => (alongX ? [a, d] : [d, a]);
              const [mx, my] = at(t0, 0.12), [mdx, mdy] = dims(0.14, 0.4);
              add(element('IFCMEMBER', 'MULLION', `Mullion ${bi}.${f}`, sPl, mx, my, 0, () => shape([box(mdx, mdy, FLOOR_H, ST('mullion'))], 'SweptSolid')),
                i === 0 && side === 'E' && (f === 0 || f === floors - 1) ? [cx + mx, cy + my, z0 + FLOOR_H / 2] : null);
              const [px, py] = at(t, 0.05), [pdx, pdy] = dims(bay, 0.22);
              add(element('IFCPLATE', 'CURTAIN_PANEL', `Spandrel ${bi}.${f}`, sPl, px, py, 0, () => shape([box(pdx, pdy, 1.1, shared.styles[pal.spandrel[hue][band]])], 'SweptSolid')));
              const [gx, gy] = at(t, 0.02), [gdx, gdy] = dims(bay - 0.14, 0.06);
              const glass = element('IFCPLATE', 'CURTAIN_PANEL', `Glazing ${bi}.${f}`, sPl, gx, gy, 1.1, () => shape([box(gdx, gdy, FLOOR_H - 1.1, shared.styles[pal.glazing[hue]])], 'SweptSolid'));
              add(glass);
              if (isHero && glass !== null && f === heroStorey && side === 'S' && i === Math.floor(n / 2) && !hero.pick) {
                hero.pick = { id: glass, centre: [cx + gx, cy + gy, z0 + 1.1 + (FLOOR_H - 1.1) / 2], normal: [0, -1, 0] };
              }
            }
          }
          // Core, columns, MEP, furniture.
          const coreW = Math.min(8, w.w * 0.4), coreD = Math.min(6, w.d * 0.4);
          if (w.core) add(element('IFCWALL', 'SHEAR', `Core ${bi}.${f}`, sPl, wx, wy, 0.3, () => shape([box(coreW, coreD, FLOOR_H - 0.3, ST('core'))], 'SweptSolid')));
          const nx = Math.max(1, Math.round(w.w / 8)), ny = Math.max(1, Math.round(w.d / 8));
          for (let i = 1; i < nx && !done; i++) {
            for (let j = 1; j < ny && !done; j++) {
              const px = w.x + (i * w.w) / nx, py = w.y + (j * w.d) / ny;
              if (w.core && Math.abs(px - wx) < coreW / 2 + 0.5 && Math.abs(py - wy) < coreD / 2 + 0.5) continue;
              add(element('IFCCOLUMN', 'COLUMN', `Column ${bi}.${f}`, sPl, px, py, 0.3, () => shape([cylinder(0.28, FLOOR_H - 0.3, ST('column'))], 'SweptSolid'), false, 0));
            }
          }
          const longX = w.w >= w.d, L = (longX ? w.w : w.d) * 0.85, off = Math.min(2.5, (longX ? w.d : w.w) / 4);
          if (Math.min(w.w, w.d) >= 9) {
            add(element('IFCDUCTSEGMENT', 'RIGIDSEGMENT', `Duct ${bi}.${f}`, sPl, longX ? wx - L / 2 : wx + off, longX ? wy + off : wy - L / 2, FLOOR_H - 0.8,
              () => shape([box(0.45, 0.8, L, ST('duct'), 0, 0, 0, longX ? 'x' : 'y')], 'SweptSolid')));
            add(element('IFCPIPESEGMENT', 'RIGIDSEGMENT', `Pipe ${bi}.${f}`, sPl, longX ? wx - L / 2 : wx - off, longX ? wy - off : wy - L / 2, FLOOR_H - 0.5,
              () => shape([cylinder(0.12, L, ST(f % 2 ? 'pipeBlue' : 'pipeRed'), 0, 0, 0, longX ? 'x' : 'y')], 'SweptSolid'), false, 0));
          }
          const desks = Math.min(24, Math.floor((w.w * w.d) / 40));
          const cols = Math.max(1, Math.round(Math.sqrt(desks * (w.w / w.d))));
          for (let k = 0; k < desks && !done; k++) {
            const i = k % cols, j = Math.floor(k / cols), rowsN = Math.ceil(desks / cols);
            const px = w.x + ((i + 0.5) * w.w) / cols, py = w.y + ((j + 0.5) * w.d) / rowsN;
            const fk = mix(seed, written, f) % furniture.length;
            add(element('IFCFURNITURE', 'NOTDEFINED', `Furniture ${bi}.${f}`, sPl, px, py, 0.3, () => mapped(furniture[fk]), true, FURNITURE_TRIS[fk]));
          }
          // Roof: a slab and rooftop plant on the wing's top storey.
          if (f === w.f1 - 1) {
            add(element('IFCSLAB', 'ROOF', `Roof ${bi}`, sPl, wx, wy, FLOOR_H, () => shape([box(w.w, w.d, 0.35, ST('roof'))], 'SweptSolid')));
            const units = Math.min(4, Math.max(1, Math.floor((w.w * w.d) / 150)));
            for (let k = 0; k < units; k++) {
              add(element('IFCUNITARYEQUIPMENT', 'AIRHANDLER', `Plant ${bi}`, sPl, wx + (k - (units - 1) / 2) * (w.w / (units + 1)), wy + (k % 2 ? 2 : -2), FLOOR_H + 0.35,
                () => mapped(plant[k % 2]), true, 12));
            }
          }
          grow(cx + w.x, cy + w.y, z0, cx + w.x + w.w, cy + w.y + w.d, z0 + FLOOR_H + 0.35);
        }
        if (isHero && f === heroStorey) hero.storeys.push({ name: `${bName} L${f}`, ids: [...ids] });
        contain(ids, storey);
      }
      if (storeys.length) rec(`IFCRELAGGREGATES('${gid()}',#${oh},$,$,#${building},(${storeys.map((x) => `#${x}`).join(',')}))`);
      if (isHero) {
        const xs = bd.wings.flatMap((w) => [cx + w.x, cx + w.x + w.w]), ys = bd.wings.flatMap((w) => [cy + w.y, cy + w.y + w.d]);
        hero.bbox = { min: [Math.min(...xs), Math.min(...ys), 0], max: [Math.max(...xs), Math.max(...ys), storeys.length * FLOOR_H] };
        hero.builtFloors = storeys.length;
      }
    }
  }
  contain(siteIds, site);
  if (buildingIds.length) rec(`IFCRELAGGREGATES('${gid()}',#${oh},$,$,#${site},(${buildingIds.map((x) => `#${x}`).join(',')}))`);
  raw('ENDSEC;\nEND-ISO-10303-21;\n');
  // Triangles: boxes and meshes are exact; cylinders are tessellated by the kernel, so the total is a lower bound.
  const trianglesKnown = trisKnown;
  const heroStoreyEntry = hero.storeys[0] ?? null;
  return { model: 0, elements: written, perPart: [], perClass, repeated, unique: written - repeated, openings: 0,
    storeys: storeyCount, entities: id, bytes, triangles: null, trianglesKnown,
    showcase: { label: SHOWCASE_LABEL, version: SHOWCASE_VERSION, styles: pal.colours.length, blocks, buildings: buildingCount, maxFloors,
      floorHeight: FLOOR_H, block: BLOCK, bbox,
      hero: { name: hero.name, floors: hero.floors, builtFloors: hero.builtFloors ?? 0, bbox: hero.bbox, ids: hero.ids, idsCapped: hero.ids.length >= 60000,
        storey: heroStoreyEntry, anchors: hero.anchors, pick: hero.pick,
        street: { from: [BLOCK.lot / 2 + BLOCK.street / 2, -BLOCK.pitch * 1.4, 0], to: [BLOCK.lot / 2 + BLOCK.street / 2, BLOCK.pitch * 1.2, 0] } } } };
}
