/* Diagnostic: why does a model yield no walls / no rooms in Space Sketch?
 * Usage: node scripts/space-diag.mjs <path-to.ifc>
 * Parses headlessly and reports, per storey: byStorey count, walls considered,
 * axis segments extracted, skip reasons, and rooms detected.
 */
import fs from 'node:fs';
import { StepTokenizer, ColumnarParser } from '../packages/parser/dist/index.js';
import { extractWallSegmentsForStorey, detectEnclosedAreas } from '../packages/create/dist/index.js';

const path = process.argv[2];
if (!path) { console.error('usage: node scripts/space-diag.mjs <path.ifc>'); process.exit(1); }

const u8 = new Uint8Array(fs.readFileSync(path)); // fresh, exactly-sized buffer
const tok = new StepTokenizer(u8);
const refs = [];
for (const r of tok.scanEntitiesFast()) {
  refs.push({ expressId: r.expressId, type: r.type, byteOffset: r.offset, byteLength: r.length, lineNumber: r.line });
}
const store = await new ColumnarParser().parseLite(u8.buffer, refs, {});

console.log(`\n${path}`);
console.log(`schema=${store.schemaVersion} entities=${store.entityCount} hasSource=${!!store.source} unitScale=${store.lengthUnitScale}`);

// raw wall counts in the file (sanity)
const wallTypes = ['IFCWALL', 'IFCWALLSTANDARDCASE'];
let rawWalls = 0;
for (const ref of refs) if (wallTypes.includes(ref.type.toUpperCase())) rawWalls++;
console.log(`raw IfcWall/IfcWallStandardCase entities in file: ${rawWalls}`);

const sh = store.spatialHierarchy;
if (!sh) { console.log('NO spatialHierarchy'); process.exit(0); }
console.log(`storeys (byStorey keys): ${[...sh.byStorey.keys()].join(', ') || 'NONE'}`);

for (const [sid, els] of sh.byStorey) {
  const res = extractWallSegmentsForStorey(store, sid, undefined, { debug: false });
  const reasons = {};
  for (const s of res.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
  let rooms = [], usedTol = 0;
  for (const tol of [0.1, 0.25, 0.5]) {
    rooms = detectEnclosedAreas(res.segments, { snapTolerance: tol, minArea: 0.5 });
    usedTol = tol;
    if (rooms.length) break;
  }
  const name = store.entities.getName ? store.entities.getName(sid) : '';
  console.log(
    `storey #${sid} "${name}": byStorey=${els.length} considered=${res.considered} ` +
    `segments=${res.segments.length} skipped=${res.skipped.length} ` +
    `skipReasons=${JSON.stringify(reasons)} rooms=${rooms.length}@snap${usedTol}`,
  );
}
