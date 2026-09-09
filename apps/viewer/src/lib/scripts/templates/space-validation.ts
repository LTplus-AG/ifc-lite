/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Space & Room Validation ─────────────────────────────────────────────
// Stakeholder: Facility Manager / Architect
//
// Validates IfcSpace entities for operations handover readiness. Checks
// that every space has a Name, LongName, area and volume quantities,
// and required properties. Generates a room schedule with measurements
// and flags incomplete spaces. This would take hours of clicking through
// individual spaces in the property panel.
// ─────────────────────────────────────────────────────────────────────────

bim.viewer.resetColors()
bim.viewer.resetVisibility()

const spaces = bim.query.byType('IfcSpace')

if (spaces.length === 0) {
  console.warn('No IfcSpace entities found in this model.')
  console.log('')
  console.log('This script validates room/space data. Models without')
  console.log('IfcSpace entities are missing spatial programming data.')
  console.log('')
  // Show what spatial types exist
  const spatialTypes = bim.query.byType('IfcBuildingStorey', 'IfcBuilding', 'IfcSite')
  if (spatialTypes.length > 0) {
    console.log('Spatial structure found:')
    for (const e of spatialTypes) {
      console.log('  ' + e.Type + ': ' + (e.Name || '<unnamed>'))
    }
  }
  throw new Error('no spaces')
}

// ── 1. Extract space data ───────────────────────────────────────────────
interface SpaceData {
  entity: BimEntity
  area: number | null
  volume: number | null
  perimeter: number | null
  height: number | null
  longName: string | null
  category: string | null
  occupancy: string | null
  issues: string[]
}

const spaceData: SpaceData[] = []
// Collect property/quantity paths for CSV export
const spacePropPaths = new Set<string>()
const spaceQtyPaths = new Set<string>()

for (const space of spaces) {
  const data: SpaceData = {
    entity: space, area: null, volume: null, perimeter: null, height: null,
    longName: null, category: null, occupancy: null, issues: []
  }

  // Extract quantities
  const qsets = bim.query.quantities(space)
  for (const qset of qsets) {
    for (const q of qset.quantities) {
      const lower = q.name.toLowerCase()
      if (lower.includes('area') && !lower.includes('wall') && data.area === null) data.area = q.value
      if (lower.includes('volume') && data.volume === null) data.volume = q.value
      if (lower.includes('perimeter') && data.perimeter === null) data.perimeter = q.value
      if (lower.includes('height') && data.height === null) data.height = q.value
      if (q.value !== null && q.value !== 0) spaceQtyPaths.add(qset.name + '.' + q.name)
    }
  }

  // Extract properties
  const psets = bim.query.properties(space)
  for (const pset of psets) {
    for (const p of pset.properties) {
      const lower = p.name.toLowerCase()
      if (lower === 'longname' && p.value) data.longName = String(p.value)
      if (lower === 'category' && p.value) data.category = String(p.value)
      if (lower === 'occupancytype' && p.value) data.occupancy = String(p.value)
      if (p.value !== null && p.value !== '') spacePropPaths.add(pset.name + '.' + p.name)
    }
  }

  // Also check entity attributes
  if (!data.longName && space.Description) data.longName = space.Description

  // Check for issues
  if (!space.Name || space.Name === '') data.issues.push('Missing Name')
  if (!data.longName) data.issues.push('Missing LongName/Description')
  if (data.area === null) data.issues.push('Missing Area')
  if (data.volume === null) data.issues.push('Missing Volume')

  spaceData.push(data)
}

// ── 2. Classify spaces ─────────────────────────────────────────────────
const complete = spaceData.filter(s => s.issues.length === 0)
const incomplete = spaceData.filter(s => s.issues.length > 0)

// ── 3. Color-code ───────────────────────────────────────────────────────
const batches: Array<{ entities: BimEntity[]; color: string }> = []
if (complete.length > 0) batches.push({ entities: complete.map(s => s.entity), color: '#27ae60' })
const minor = incomplete.filter(s => s.issues.length <= 2)
const major = incomplete.filter(s => s.issues.length > 2)
if (minor.length > 0) batches.push({ entities: minor.map(s => s.entity), color: '#f39c12' })
if (major.length > 0) batches.push({ entities: major.map(s => s.entity), color: '#e74c3c' })
if (batches.length > 0) bim.viewer.colorizeAll(batches)

// ── 4. Report ───────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════')
console.log('  SPACE & ROOM VALIDATION')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Spaces found: ' + spaces.length)
console.log('  Complete:     ' + complete.length + '  ● green')
console.log('  Minor issues: ' + minor.length + '  ● orange (1-2 issues)')
console.log('  Major issues: ' + major.length + '  ● red (3+ issues)')

// ── 5. Room schedule ────────────────────────────────────────────────────
console.log('')
console.log('── Room Schedule ──')
console.log('Name                    | Area m²  | Volume m³ | Height m | Status')
console.log('------------------------+----------+-----------+----------+-------')

// Sort by name
const sorted = [...spaceData].sort((a, b) => {
  const nameA = a.entity.Name || 'zzz'
  const nameB = b.entity.Name || 'zzz'
  return nameA.localeCompare(nameB)
})

let totalArea = 0
let totalVolume = 0

for (const s of sorted) {
  const name = ((s.entity.Name || '<unnamed>') + '                        ').slice(0, 24)
  const area = s.area !== null ? (s.area.toFixed(1) + '    ').slice(0, 8) : '-       '
  const vol = s.volume !== null ? (s.volume.toFixed(1) + '     ').slice(0, 9) : '-        '
  const height = s.height !== null ? (s.height.toFixed(2) + '   ').slice(0, 8) : '-       '
  const status = s.issues.length === 0 ? 'OK' : s.issues.length + ' issues'
  console.log(name + '| ' + area + ' | ' + vol + ' | ' + height + ' | ' + status)
  if (s.area !== null) totalArea += s.area
  if (s.volume !== null) totalVolume += s.volume
}

console.log('------------------------+----------+-----------+----------+-------')
console.log('TOTALS                  | ' + (totalArea.toFixed(1) + '    ').slice(0, 8) + ' | ' + (totalVolume.toFixed(1) + '     ').slice(0, 9) + ' |')

// ── 6. Category breakdown ───────────────────────────────────────────────
const categories: Record<string, { count: number; area: number }> = {}
for (const s of spaceData) {
  const cat = s.category || s.entity.ObjectType || 'Uncategorized'
  if (!categories[cat]) categories[cat] = { count: 0, area: 0 }
  categories[cat].count++
  if (s.area !== null) categories[cat].area += s.area
}

if (Object.keys(categories).length > 1) {
  console.log('')
  console.log('── By Category ──')
  for (const [cat, data] of Object.entries(categories).sort((a, b) => b[1].area - a[1].area)) {
    console.log('  ' + cat + ': ' + data.count + ' spaces, ' + data.area.toFixed(1) + ' m²')
  }
}

// ── 7. Issue details ────────────────────────────────────────────────────
if (incomplete.length > 0) {
  console.log('')
  console.warn('── Incomplete Spaces ──')
  const issueCount: Record<string, number> = {}
  for (const s of incomplete) {
    for (const issue of s.issues) {
      issueCount[issue] = (issueCount[issue] || 0) + 1
    }
  }
  for (const [issue, count] of Object.entries(issueCount).sort((a, b) => b[1] - a[1])) {
    console.warn('  ' + issue + ': ' + count + ' spaces')
  }
}

// ── 8. Export ────────────────────────────────────────────────────────────
const spPropCols = Array.from(spacePropPaths).sort().slice(0, 15)
const spQtyCols = Array.from(spaceQtyPaths).sort().slice(0, 15)
bim.export.csv(spaces, {
  columns: ['Name', 'Type', 'GlobalId', 'Description', 'ObjectType', ...spPropCols, ...spQtyCols],
  filename: 'room-schedule.csv'
})
console.log('')
console.log('Exported ' + spaces.length + ' spaces (' + (5 + spPropCols.length + spQtyCols.length) + ' columns) to room-schedule.csv')
