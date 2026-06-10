/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end harness for the SpacePlateHandle WASM binding.
 *
 * Drives the *real* wasm module (built from rust/wasm-bindings) through the
 * full editor loop — build a plate from wall-axis segments, then drag / merge /
 * split — asserting the topology behaves across the JS↔Rust boundary exactly as
 * the native Rust unit tests do.
 *
 * Build the wasm first (nodejs target, into a temp dir so the web pkg the
 * viewer uses is untouched):
 *
 *   rustup run nightly-2025-11-15 wasm-pack build rust/wasm-bindings \
 *     --target nodejs --out-dir /tmp/space-dcel-pkg --out-name ifc-lite --release
 *
 * Then run:  node scripts/space-dcel-e2e.cjs [/tmp/space-dcel-pkg]
 */

const path = require('node:path');

const PKG_DIR = process.argv[2] || '/tmp/space-dcel-pkg';
const { SpacePlateHandle } = require(path.join(PKG_DIR, 'ifc-lite.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sumArea = (patches) => patches.reduce((s, p) => s + p.area, 0);

// segCoords = [ax,ay,bx,by,...]; segSources = one i32 per segment (-1 = none).
function seg(ax, ay, bx, by, src) {
  return { coords: [ax, ay, bx, by], src };
}
function pack(segs) {
  return {
    coords: Float64Array.from(segs.flatMap((s) => s.coords)),
    sources: Int32Array.from(segs.map((s) => s.src)),
  };
}

// A 8×3 box split by a central wall at x=4 → two 4×3 rooms. Source 99 = the
// shared wall; 1..4 = the outer walls.
function twoRoomPlate() {
  const { coords, sources } = pack([
    seg(0, 0, 8, 0, 1),
    seg(8, 0, 8, 3, 2),
    seg(8, 3, 0, 3, 3),
    seg(0, 3, 0, 0, 4),
    seg(4, 0, 4, 3, 99),
  ]);
  return new SpacePlateHandle(coords, sources, 0.1, 0.5);
}

console.log('SpacePlateHandle end-to-end (real wasm)\n');

// ── A. Build + derive ──────────────────────────────────────────────
console.log('A. build a single 4×3 room');
{
  const { coords, sources } = pack([
    seg(0, 0, 4, 0, 10),
    seg(4, 0, 4, 3, 11),
    seg(4, 3, 0, 3, 12),
    seg(0, 3, 0, 0, 13),
  ]);
  const plate = new SpacePlateHandle(coords, sources, 0.1, 0.5);
  check('one room derived', plate.roomCount === 1, `got ${plate.roomCount}`);
  const rooms = plate.snapshot();
  check('area = 12 m²', approx(rooms[0].area, 12), rooms[0].area);
  check('every boundary edge carries a source', plate.boundingElements(rooms[0].face).every((b) => b.source != null));
  plate.free();
}

// ── B. Drag a shared vertex → both rooms follow in one call ─────────
console.log('B. drag the shared wall base — both rooms update from one call');
{
  const plate = twoRoomPlate();
  check('two rooms', plate.roomCount === 2, `got ${plate.roomCount}`);
  check('areas sum to 24', approx(sumArea(plate.snapshot()), 24));

  const v = plate.findVertexNear(4, 0, 1e-6);
  check('found shared base vertex at (4,0)', v != null, v);
  const patches = plate.dragVertex(v, 5, 0);
  check('drag returns BOTH rooms', patches.length === 2, `got ${patches.length}`);
  check('area conserved under drag', approx(sumArea(patches), 24), sumArea(patches));
  check('both faces stay simple', patches.every((p) => p.simple === true));
  check('rooms became unequal (13.5 vs 10.5)', Math.abs(patches[0].area - patches[1].area) > 1.0,
    patches.map((p) => p.area).join(' vs '));
  plate.free();
}

// ── C. Merge across the shared wall via twin lookup ────────────────
console.log('C. merge the two rooms across their shared wall');
{
  const plate = twoRoomPlate();
  const [r0] = plate.roomIds();
  const others = new Set(plate.roomIds());
  // The shared edge: a bounding edge of r0 whose twin's face is the OTHER room.
  let shared = null;
  let sharedSource = null;
  for (const b of plate.boundingElements(r0)) {
    const nbr = plate.neighborAcross(b.edge);
    if (nbr != null && nbr !== r0 && others.has(nbr)) {
      shared = b.edge;
      sharedSource = b.source;
      break;
    }
  }
  check('found the shared wall edge via neighborAcross', shared != null, shared);
  check('shared wall reports source element 99', sharedSource === 99, sharedSource);

  const merged = plate.mergeFaces(shared);
  check('merge returns one surviving room', merged.length === 1, merged.length);
  check('one room left', plate.roomCount === 1, plate.roomCount);
  check('merged area = full box (24 m²)', approx(merged[0].area, 24), merged[0].area);
  check('merged room is simple', merged[0].simple === true);
  plate.free();
}

// ── D. Split a room with a diagonal partition (provenance distinguished) ──
console.log('D. split a 4×4 room with a user-drawn diagonal');
{
  const { coords, sources } = pack([
    seg(0, 0, 4, 0, 20),
    seg(4, 0, 4, 4, 21),
    seg(4, 4, 0, 4, 22),
    seg(0, 4, 0, 0, 23),
  ]);
  const plate = new SpacePlateHandle(coords, sources, 0.1, 0.5);
  const [room] = plate.roomIds();
  const v00 = plate.findVertexNear(0, 0, 1e-6);
  const v44 = plate.findVertexNear(4, 4, 1e-6);
  check('found both diagonal corners', v00 != null && v44 != null, `${v00},${v44}`);

  const parts = plate.splitFace(room, v00, v44, -1 /* user partition, no source */);
  check('split returns two faces', parts.length === 2, parts.length);
  check('two rooms now', plate.roomCount === 2, plate.roomCount);
  check('each half is 8 m²', parts.every((p) => approx(p.area, 8)), parts.map((p) => p.area).join(','));
  check('areas sum to parent (16)', approx(sumArea(parts), 16));

  // The user partition is unsourced; the inherited walls keep their source.
  const childBounds = plate.boundingElements(parts[1].face);
  check('the user-drawn partition has a null source', childBounds.some((b) => b.source == null));
  check('the inherited walls keep a source', childBounds.some((b) => b.source != null));
  plate.free();
}

// ── E. Edit-rejection surfaces as a JS error ───────────────────────
console.log('E. invalid edits reject across the boundary');
{
  const plate = twoRoomPlate();
  const [r0] = plate.roomIds();
  // An exterior wall: twin's face is the outer face (not a room).
  let extEdge = null;
  const rooms = new Set(plate.roomIds());
  for (const b of plate.boundingElements(r0)) {
    const nbr = plate.neighborAcross(b.edge);
    if (nbr == null || !rooms.has(nbr)) { extEdge = b.edge; break; }
  }
  let threw = false;
  try { plate.mergeFaces(extEdge); } catch (e) { threw = /BordersExterior/.test(String(e)); }
  check('merging an exterior wall throws BordersExterior', threw);
  plate.free();
}

console.log(`\n${failures === 0 ? 'PASS — all checks green' : `FAIL — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
