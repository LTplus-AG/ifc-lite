/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Fire Safety Compliance Check ────────────────────────────────────────
// Stakeholder: Architect / Fire Safety Engineer
//
// Cross-references fire rating properties across walls and doors — a task
// that requires clicking through hundreds of entities in the properties
// panel. The script checks Pset_WallCommon.FireRating and
// Pset_DoorCommon.FireRating, flags missing or non-compliant values,
// color-codes the model by compliance status, and generates a report.
// ─────────────────────────────────────────────────────────────────────────

bim.viewer.resetColors()

// ── 1. Gather fire-rated element types ──────────────────────────────────
const walls = bim.query.byType('IfcWall', 'IfcWallStandardCase')
const doors = bim.query.byType('IfcDoor', 'IfcDoorStandardCase')
const slabs = bim.query.byType('IfcSlab')
const total = walls.length + doors.length + slabs.length

if (total === 0) {
  console.error('No walls, doors, or slabs found in model')
  throw new Error('no elements')
}

// ── 2. Extract fire rating from properties ──────────────────────────────
interface FireResult {
  entity: BimEntity
  rating: string | null
  isLoadBearing: boolean | null
  isExternal: boolean | null
}

// Collect fire-related property paths for CSV export
const firePropPaths = new Set<string>()

function extractFireData(entity: BimEntity): FireResult {
  const result: FireResult = { entity, rating: null, isLoadBearing: null, isExternal: null }
  const psets = bim.query.properties(entity)
  for (const pset of psets) {
    for (const p of pset.properties) {
      const lower = p.name.toLowerCase()
      if (lower === 'firerating' && p.value !== null && p.value !== '') {
        result.rating = String(p.value)
        firePropPaths.add(pset.name + '.FireRating')
      }
      if (lower === 'loadbearing' && p.value !== null) {
        result.isLoadBearing = p.value === true || p.value === 'TRUE' || p.value === '.T.'
        firePropPaths.add(pset.name + '.LoadBearing')
      }
      if (lower === 'isexternal' && p.value !== null) {
        result.isExternal = p.value === true || p.value === 'TRUE' || p.value === '.T.'
        firePropPaths.add(pset.name + '.IsExternal')
      }
    }
  }
  return result
}

// ── 3. Analyze each element category ────────────────────────────────────
const wallResults = walls.map(extractFireData)
const doorResults = doors.map(extractFireData)
const slabResults = slabs.map(extractFireData)

// Classify
const rated: BimEntity[] = []
const unrated: BimEntity[] = []
const loadBearingUnrated: BimEntity[] = []
const externalUnrated: BimEntity[] = []

for (const r of [...wallResults, ...doorResults, ...slabResults]) {
  if (r.rating) {
    rated.push(r.entity)
  } else {
    unrated.push(r.entity)
    if (r.isLoadBearing) loadBearingUnrated.push(r.entity)
    if (r.isExternal) externalUnrated.push(r.entity)
  }
}

// ── 4. Group by fire rating value ───────────────────────────────────────
const ratingGroups: Record<string, BimEntity[]> = {}
for (const r of [...wallResults, ...doorResults, ...slabResults]) {
  if (r.rating) {
    if (!ratingGroups[r.rating]) ratingGroups[r.rating] = []
    ratingGroups[r.rating].push(r.entity)
  }
}

// ── 5. Color-code by compliance ─────────────────────────────────────────
const batches: Array<{ entities: BimEntity[]; color: string }> = []
if (rated.length > 0) batches.push({ entities: rated, color: '#27ae60' })           // green = rated
if (loadBearingUnrated.length > 0) batches.push({ entities: loadBearingUnrated, color: '#e74c3c' }) // red = critical
if (externalUnrated.length > 0) batches.push({ entities: externalUnrated, color: '#e67e22' })       // orange = warning
// Remaining unrated that are not load-bearing or external
const otherUnrated = unrated.filter(e => {
  const isLB = loadBearingUnrated.some(lb => lb.GlobalId === e.GlobalId)
  const isExt = externalUnrated.some(ext => ext.GlobalId === e.GlobalId)
  return !isLB && !isExt
})
if (otherUnrated.length > 0) batches.push({ entities: otherUnrated, color: '#f1c40f' }) // yellow = missing
if (batches.length > 0) bim.viewer.colorizeAll(batches)

// ── 6. Report ───────────────────────────────────────────────────────────
const compliancePct = (rated.length / total * 100).toFixed(1)
console.log('═══════════════════════════════════════')
console.log('  FIRE SAFETY COMPLIANCE CHECK')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Scanned: ' + walls.length + ' walls, ' + doors.length + ' doors, ' + slabs.length + ' slabs')
console.log('Compliance: ' + compliancePct + '% (' + rated.length + '/' + total + ' rated)')
console.log('')
console.log('  ● Rated:                    ' + rated.length + '  green')
console.log('  ● Missing (load-bearing):   ' + loadBearingUnrated.length + '  red — CRITICAL')
console.log('  ● Missing (external):       ' + externalUnrated.length + '  orange — WARNING')
console.log('  ● Missing (other):          ' + otherUnrated.length + '  yellow')

// ── 7. Rating distribution ──────────────────────────────────────────────
if (Object.keys(ratingGroups).length > 0) {
  console.log('')
  console.log('── Fire Rating Distribution ──')
  const ratingsSorted = Object.entries(ratingGroups).sort((a, b) => b[1].length - a[1].length)
  for (const [rating, entities] of ratingsSorted) {
    console.log('  ' + rating + ': ' + entities.length + ' elements')
  }
}

// ── 8. Per-type breakdown ───────────────────────────────────────────────
console.log('')
console.log('── Breakdown by Element Type ──')
const typeGroups: Record<string, { rated: number; total: number }> = {}
for (const r of [...wallResults, ...doorResults, ...slabResults]) {
  const t = r.entity.Type
  if (!typeGroups[t]) typeGroups[t] = { rated: 0, total: 0 }
  typeGroups[t].total++
  if (r.rating) typeGroups[t].rated++
}
for (const [type, g] of Object.entries(typeGroups).sort((a, b) => b[1].total - a[1].total)) {
  const pct = (g.rated / g.total * 100).toFixed(0)
  console.log('  ' + type + ': ' + g.rated + '/' + g.total + ' rated (' + pct + '%)')
}

// ── 9. Critical issues list ─────────────────────────────────────────────
if (loadBearingUnrated.length > 0) {
  console.log('')
  console.warn('── CRITICAL: Load-Bearing Without Fire Rating ──')
  for (const e of loadBearingUnrated.slice(0, 15)) {
    console.warn('  ' + (e.Name || '<unnamed>') + ' [' + e.Type + '] GlobalId=' + e.GlobalId)
  }
  if (loadBearingUnrated.length > 15) console.warn('  ... and ' + (loadBearingUnrated.length - 15) + ' more')
}

// ── 10. Export all scanned elements with fire properties ────────────────
const allFireElements = [...walls, ...doors, ...slabs]
const fireCols = Array.from(firePropPaths).sort()
bim.export.csv(allFireElements, {
  columns: ['Name', 'Type', 'GlobalId', 'ObjectType', ...fireCols],
  filename: 'fire-safety-report.csv'
})
console.log('')
console.log('Exported ' + allFireElements.length + ' elements (' + (4 + fireCols.length) + ' columns) to fire-safety-report.csv')
