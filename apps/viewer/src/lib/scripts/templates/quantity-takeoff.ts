/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Quantity Takeoff ────────────────────────────────────────────────────
// Stakeholder: Cost Estimator / Project Manager
//
// Aggregates quantities (area, volume, length, width, height) across all
// structural and architectural element types. This combines what would
// require opening the properties panel for each element individually,
// manually recording numbers, and aggregating in a spreadsheet. The
// script does it in seconds and exports a ready-to-use CSV.
// ─────────────────────────────────────────────────────────────────────────

const ELEMENT_TYPES = [
  'IfcWall', 'IfcWallStandardCase',
  'IfcSlab',
  'IfcColumn',
  'IfcBeam',
  'IfcDoor', 'IfcDoorStandardCase',
  'IfcWindow',
  'IfcCovering',
  'IfcCurtainWall',
  'IfcRoof',
  'IfcStair', 'IfcStairFlight',
  'IfcRailing',
  'IfcPlate',
  'IfcMember',
  'IfcFooting',
  'IfcPile',
]

// Quantities we care about (case-insensitive matching)
const QTY_KEYS = ['area', 'volume', 'length', 'width', 'height', 'netarea', 'netsidearea', 'netvolume', 'grossarea', 'grossvolume', 'perimeter']

/**
 * One figure per element for the summary table, taken from the IFC standard
 * base-quantity names in priority order. Summing every quantity whose name
 * merely CONTAINS "volume" added GrossVolume, NetVolume and each exporter's
 * localised duplicates ("Brutto-Volumen der Wand", "Konditionales Volumen", …)
 * together, overstating a wall's volume ~3x; "area" likewise added a wall's
 * side area to its footprint area. Area priority runs side -> plan -> plain so
 * each class lands on the area that describes it: walls on GrossSideArea,
 * slabs and roofs on GrossArea, doors and windows on Area.
 */
const VOLUME_PRIORITY = ['GrossVolume', 'NetVolume']
const AREA_PRIORITY = ['GrossSideArea', 'NetSideArea', 'GrossArea', 'NetArea', 'Area']

/** Cap per type; beyond it the sums are extrapolated and labelled as such. */
const SAMPLE_CAP = 500

interface TypeTakeoff {
  type: string
  count: number
  sampled: number
  quantities: Record<string, { sum: number; count: number }>
  area: { sum: number; count: number }
  volume: { sum: number; count: number }
}

console.log('═══════════════════════════════════════')
console.log('  QUANTITY TAKEOFF')
console.log('═══════════════════════════════════════')
console.log('')

// One query, grouped by each element's CONCRETE class. `byType` already expands
// to subtypes, so querying `IfcWall` and `IfcWallStandardCase` separately
// returned the same walls twice and reported them as two types.
const elements = bim.query.byType(...ELEMENT_TYPES)
const byClass = new Map<string, BimEntity[]>()
for (const e of elements) {
  const list = byClass.get(e.Type)
  if (list) list.push(e)
  else byClass.set(e.Type, [e])
}

const takeoffs: TypeTakeoff[] = []
// Collect all unique Qto set+quantity paths for CSV export columns
const quantityColumns = new Set<string>()

for (const [type, entities] of byClass) {
  const sample = entities.length > SAMPLE_CAP ? entities.slice(0, SAMPLE_CAP) : entities
  const takeoff: TypeTakeoff = {
    type, count: entities.length, sampled: sample.length, quantities: {},
    area: { sum: 0, count: 0 }, volume: { sum: 0, count: 0 },
  }

  for (const entity of sample) {
    const byName = new Map<string, number>()
    for (const qset of bim.query.quantities(entity)) {
      for (const q of qset.quantities) {
        if (q.value === null || q.value === 0) continue
        const lower = q.name.toLowerCase()
        if (!QTY_KEYS.some(k => lower.includes(k))) continue
        if (!takeoff.quantities[q.name]) takeoff.quantities[q.name] = { sum: 0, count: 0 }
        takeoff.quantities[q.name].sum += q.value
        takeoff.quantities[q.name].count++
        if (!byName.has(q.name)) byName.set(q.name, q.value)
        quantityColumns.add(qset.name + '.' + q.name)
      }
    }
    const volume = VOLUME_PRIORITY.map(n => byName.get(n)).find(v => v !== undefined)
    if (volume !== undefined) { takeoff.volume.sum += volume; takeoff.volume.count++ }
    const area = AREA_PRIORITY.map(n => byName.get(n)).find(v => v !== undefined)
    if (area !== undefined) { takeoff.area.sum += area; takeoff.area.count++ }
  }

  // Scale up if sampled -- the report says so below rather than presenting an
  // extrapolation as a measured total.
  if (sample.length < entities.length) {
    const factor = entities.length / sample.length
    for (const q of Object.values(takeoff.quantities)) q.sum *= factor
    takeoff.area.sum *= factor
    takeoff.volume.sum *= factor
  }

  takeoffs.push(takeoff)
}

if (takeoffs.length === 0) {
  console.log('No ' + ELEMENT_TYPES.join(', ') + ' elements in this model, so there is nothing to take off.')
} else {
  // ── Report ────────────────────────────────────────────────────────────
  console.log('Scanned ' + elements.length + ' elements across ' + takeoffs.length + ' classes')
  console.log('')

  for (const t of takeoffs.sort((a, b) => b.count - a.count)) {
    const extrapolated = t.sampled < t.count ? '  [extrapolated from ' + t.sampled + ' of ' + t.count + ']' : ''
    console.log('── ' + t.type + ' (' + t.count + ')' + extrapolated + ' ──')
    const qEntries = Object.entries(t.quantities).sort((a, b) => b[1].sum - a[1].sum)
    if (qEntries.length === 0) {
      console.log('  (no quantities defined)')
    } else {
      for (const [name, q] of qEntries) {
        const avg = q.sum / q.count
        console.log('  ' + name + ': total=' + q.sum.toFixed(2) + '  avg=' + avg.toFixed(2) + '  (from ' + q.count + ' entities)')
      }
    }
    console.log('')
  }

  // ── Summary table ─────────────────────────────────────────────────────
  // Values are in the model's own length unit, squared and cubed. `bim` has no
  // project-unit accessor yet, so the column headers do not claim metres.
  console.log('── Summary (one standard base quantity per element) ──')
  console.log('Class                      | Count |    Area    |   Volume')
  console.log('---------------------------+-------+------------+-----------')
  for (const t of takeoffs) {
    const typeStr = (t.type + '                           ').slice(0, 27)
    const countStr = ('     ' + t.count).slice(-5)
    const areaStr = t.area.count > 0 ? t.area.sum.toFixed(1) : '-'
    const volStr = t.volume.count > 0 ? t.volume.sum.toFixed(2) : '-'
    const mark = t.sampled < t.count ? '  *' : ''
    console.log(typeStr + '| ' + countStr + ' | ' + ('          ' + areaStr).slice(-10) + ' | ' + ('         ' + volStr).slice(-9) + mark)
  }
  if (takeoffs.some(t => t.sampled < t.count)) {
    console.log('* extrapolated from the first ' + SAMPLE_CAP + ' elements of the class')
  }
}

// ── Export ───────────────────────────────────────────────────────────────
// Build a flat entity list with quantities for CSV export
let allElements = bim.query.byType(...ELEMENT_TYPES)
// Respect the active advanced filter, if one is set, so the CSV matches the
// current filtered view rather than the whole model (issue #1107).
const activeFilter = bim.query.matchingActiveFilter()
if (activeFilter) {
  const keep = new Set(activeFilter.map(e => e.ref.modelId + ':' + e.ref.expressId))
  const before = allElements.length
  allElements = allElements.filter(e => keep.has(e.ref.modelId + ':' + e.ref.expressId))
  console.log('Active filter applied: ' + allElements.length + ' of ' + before + ' elements')
}
if (allElements.length > 0) {
  const qtyCols = Array.from(quantityColumns).sort()
  bim.export.csv(allElements, {
    columns: ['Name', 'Type', 'ObjectType', 'GlobalId', ...qtyCols],
    filename: 'quantity-takeoff.csv'
  })
  console.log('')
  console.log('Exported ' + allElements.length + ' elements (' + (4 + qtyCols.length) + ' columns) to quantity-takeoff.csv')
}
