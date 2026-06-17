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

interface TypeTakeoff {
  type: string
  count: number
  quantities: Record<string, { sum: number; count: number; unit: string }>
}

console.log('═══════════════════════════════════════')
console.log('  QUANTITY TAKEOFF')
console.log('═══════════════════════════════════════')
console.log('')

const takeoffs: TypeTakeoff[] = []
let totalElements = 0
// Collect all unique Qto set+quantity paths for CSV export columns
const quantityColumns = new Set<string>()

for (const ifcType of ELEMENT_TYPES) {
  const entities = bim.query.byType(ifcType)
  if (entities.length === 0) continue

  totalElements += entities.length
  const takeoff: TypeTakeoff = { type: ifcType, count: entities.length, quantities: {} }

  // Sample all entities for quantities (cap at 500 to avoid timeout)
  const sample = entities.length > 500 ? entities.slice(0, 500) : entities
  const isSampled = entities.length > 500

  for (const entity of sample) {
    const qsets = bim.query.quantities(entity)
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (q.value === null || q.value === 0) continue
        const lower = q.name.toLowerCase()
        // Only aggregate quantities we care about
        const match = QTY_KEYS.find(k => lower.includes(k))
        if (!match) continue
        const key = q.name
        if (!takeoff.quantities[key]) takeoff.quantities[key] = { sum: 0, count: 0, unit: '' }
        takeoff.quantities[key].sum += q.value
        takeoff.quantities[key].count++
        // Track the full path for CSV export
        quantityColumns.add(qset.name + '.' + q.name)
      }
    }
  }

  // Scale up if sampled
  if (isSampled) {
    const factor = entities.length / sample.length
    for (const q of Object.values(takeoff.quantities)) {
      q.sum = q.sum * factor
    }
  }

  takeoffs.push(takeoff)
}

if (takeoffs.length === 0) {
  console.error('No elements with quantities found')
  throw new Error('no quantities')
}

// ── Report ──────────────────────────────────────────────────────────────
console.log('Scanned ' + totalElements + ' elements across ' + takeoffs.length + ' types')
console.log('')

for (const t of takeoffs.sort((a, b) => b.count - a.count)) {
  console.log('── ' + t.type + ' (' + t.count + ') ──')
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

// ── Summary table ───────────────────────────────────────────────────────
console.log('── Summary ──')
console.log('Type                       | Count |    Area    |   Volume')
console.log('---------------------------+-------+------------+-----------')
for (const t of takeoffs.sort((a, b) => b.count - a.count)) {
  // Find area and volume totals
  let area = 0
  let volume = 0
  for (const [name, q] of Object.entries(t.quantities)) {
    const lower = name.toLowerCase()
    if (lower.includes('area') && !lower.includes('net')) area += q.sum
    if (lower.includes('volume') && !lower.includes('net')) volume += q.sum
  }
  const typeStr = (t.type + '                           ').slice(0, 27)
  const countStr = ('     ' + t.count).slice(-5)
  const areaStr = area > 0 ? (area.toFixed(1) + ' m²') : '-'
  const volStr = volume > 0 ? (volume.toFixed(2) + ' m³') : '-'
  console.log(typeStr + '| ' + countStr + ' | ' + ('          ' + areaStr).slice(-10) + ' | ' + ('         ' + volStr).slice(-9))
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
