/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Building Envelope & Thermal Check ───────────────────────────────────
// Stakeholder: Architect / Energy Consultant
//
// Identifies all external-facing elements (walls, slabs, roofs, windows,
// doors, curtain walls) by reading Pset_*Common.IsExternal and checks
// whether they carry thermal transmittance values. Missing thermal data
// on external elements is a common issue in energy models. The script
// isolates the envelope, color-codes by thermal status, and exports
// the findings — a workflow that requires cross-referencing two property
// values across hundreds of elements.
// ─────────────────────────────────────────────────────────────────────────

bim.viewer.resetColors()
bim.viewer.resetVisibility()

// ── 1. Gather envelope candidates ───────────────────────────────────────
const envelopeTypes = [
  'IfcWall', 'IfcWallStandardCase', 'IfcCurtainWall',
  'IfcSlab', 'IfcRoof',
  'IfcDoor', 'IfcDoorStandardCase',
  'IfcWindow',
  'IfcPlate',
]
const candidates = bim.query.byType(...envelopeTypes)

if (candidates.length === 0) {
  console.error('No envelope element types found')
  throw new Error('no elements')
}

// ── 2. Classify each element ────────────────────────────────────────────
interface EnvelopeResult {
  entity: BimEntity
  isExternal: boolean | null
  thermalTransmittance: number | null
  thermalSource: string
}

const results: EnvelopeResult[] = []
// Collect property paths for CSV export
const envelopePropPaths = new Set<string>()

for (const entity of candidates) {
  const result: EnvelopeResult = { entity, isExternal: null, thermalTransmittance: null, thermalSource: '' }
  const psets = bim.query.properties(entity)
  for (const pset of psets) {
    for (const p of pset.properties) {
      const lower = p.name.toLowerCase()
      if (lower === 'isexternal' && p.value !== null) {
        result.isExternal = p.value === true || p.value === 'TRUE' || p.value === '.T.'
        envelopePropPaths.add(pset.name + '.IsExternal')
      }
      if (lower === 'thermaltransmittance' && p.value !== null && p.value !== '') {
        result.thermalTransmittance = typeof p.value === 'number' ? p.value : parseFloat(String(p.value))
        result.thermalSource = pset.name
        envelopePropPaths.add(pset.name + '.ThermalTransmittance')
      }
      // Also capture other thermal-related properties
      if ((lower === 'firerating' || lower === 'loadbearing' || lower === 'acousticrating') && p.value !== null && p.value !== '') {
        envelopePropPaths.add(pset.name + '.' + p.name)
      }
    }
  }
  results.push(result)
}

// ── 3. Separate external vs internal ────────────────────────────────────
const external = results.filter(r => r.isExternal === true)
const internal = results.filter(r => r.isExternal === false)
const unknown = results.filter(r => r.isExternal === null)

const extWithThermal = external.filter(r => r.thermalTransmittance !== null)
const extNoThermal = external.filter(r => r.thermalTransmittance === null)

// ── 4. Color-code ───────────────────────────────────────────────────────
const batches: Array<{ entities: BimEntity[]; color: string }> = []
if (extWithThermal.length > 0) batches.push({ entities: extWithThermal.map(r => r.entity), color: '#27ae60' })  // green: external + thermal
if (extNoThermal.length > 0) batches.push({ entities: extNoThermal.map(r => r.entity), color: '#e74c3c' })    // red: external, missing thermal
if (internal.length > 0) batches.push({ entities: internal.map(r => r.entity), color: '#95a5a6' })            // grey: internal
if (unknown.length > 0) batches.push({ entities: unknown.map(r => r.entity), color: '#f39c12' })              // orange: unknown
if (batches.length > 0) bim.viewer.colorizeAll(batches)

// Isolate envelope if we found external elements
if (external.length > 0) {
  bim.viewer.isolate(external.map(r => r.entity))
}

// ── 5. Report ───────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════')
console.log('  BUILDING ENVELOPE & THERMAL CHECK')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Scanned ' + candidates.length + ' envelope-type elements')
console.log('')
console.log('  External:   ' + external.length + '  (isolated in view)')
console.log('  Internal:   ' + internal.length + '  ● grey')
console.log('  Undefined:  ' + unknown.length + '  ● orange — IsExternal not set')
console.log('')
console.log('  External with thermal data:    ' + extWithThermal.length + '  ● green')
console.log('  External without thermal data: ' + extNoThermal.length + '  ● red — NEEDS ATTENTION')

// ── 6. Thermal value distribution ───────────────────────────────────────
if (extWithThermal.length > 0) {
  console.log('')
  console.log('── Thermal Transmittance (U-value) Distribution ──')

  // Group by type
  const byType: Record<string, number[]> = {}
  for (const r of extWithThermal) {
    if (!byType[r.entity.Type]) byType[r.entity.Type] = []
    if (r.thermalTransmittance !== null) byType[r.entity.Type].push(r.thermalTransmittance)
  }

  for (const [type, values] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    const min = Math.min(...values)
    const max = Math.max(...values)
    const avg = values.reduce((s, v) => s + v, 0) / values.length
    console.log('  ' + type + ' (' + values.length + ')')
    console.log('    min=' + min.toFixed(3) + '  avg=' + avg.toFixed(3) + '  max=' + max.toFixed(3) + ' W/(m²·K)')
  }
}

// ── 7. Elements missing IsExternal property ─────────────────────────────
if (unknown.length > 0) {
  console.log('')
  console.warn('── Missing IsExternal Property ──')
  const byType: Record<string, number> = {}
  for (const r of unknown) {
    byType[r.entity.Type] = (byType[r.entity.Type] || 0) + 1
  }
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.warn('  ' + type + ': ' + count + ' elements')
  }
}

// ── 8. External elements missing thermal data ───────────────────────────
if (extNoThermal.length > 0) {
  console.log('')
  console.warn('── External Elements Without Thermal Data ──')
  for (const r of extNoThermal.slice(0, 15)) {
    console.warn('  ' + (r.entity.Name || '<unnamed>') + ' [' + r.entity.Type + ']')
  }
  if (extNoThermal.length > 15) console.warn('  ... and ' + (extNoThermal.length - 15) + ' more')

  const envPropCols = Array.from(envelopePropPaths).sort()
  bim.export.csv(extNoThermal.map(r => r.entity), {
    columns: ['Name', 'Type', 'GlobalId', 'ObjectType', ...envPropCols],
    filename: 'envelope-missing-thermal.csv'
  })
  console.log('')
  console.log('Exported ' + extNoThermal.length + ' elements to envelope-missing-thermal.csv')
}

// Export full envelope dataset with all discovered properties
if (external.length > 0) {
  const envPropCols = Array.from(envelopePropPaths).sort()
  bim.export.csv(external.map(r => r.entity), {
    columns: ['Name', 'Type', 'GlobalId', 'ObjectType', ...envPropCols],
    filename: 'envelope-analysis.csv'
  })
  console.log('Exported ' + external.length + ' external elements (' + (4 + envPropCols.length) + ' columns) to envelope-analysis.csv')
}
