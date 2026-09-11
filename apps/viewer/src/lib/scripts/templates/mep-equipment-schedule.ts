/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── MEP Equipment Schedule ──────────────────────────────────────────────
// Stakeholder: HVAC / MEP Engineer
//
// Discovers all MEP/distribution elements in the model, extracts their
// properties (manufacturer, model, capacity, pressure, flow rate), and
// generates a structured equipment register. The UI's property panel
// shows one element at a time — this script scans hundreds of elements
// and builds the schedule that would otherwise require a spreadsheet.
// ─────────────────────────────────────────────────────────────────────────

// ── 1. Query all MEP-related IFC types ──────────────────────────────────
const MEP_TYPES = [
  // HVAC
  'IfcAirTerminal', 'IfcAirTerminalBox', 'IfcFan', 'IfcCoil', 'IfcCompressor',
  'IfcCondenser', 'IfcCooledBeam', 'IfcCoolingTower', 'IfcEvaporativeCooler',
  'IfcEvaporator', 'IfcHeatExchanger', 'IfcHumidifier', 'IfcUnitaryEquipment',
  'IfcBoiler', 'IfcChiller', 'IfcAirToAirHeatRecovery',
  // Plumbing
  'IfcSanitaryTerminal', 'IfcWasteTerminal', 'IfcFireSuppressionTerminal',
  'IfcTank', 'IfcPump', 'IfcValve',
  // Electrical
  'IfcElectricDistributionBoard', 'IfcElectricGenerator', 'IfcElectricMotor',
  'IfcTransformer', 'IfcSwitchingDevice', 'IfcOutlet', 'IfcLightFixture',
  'IfcLamp', 'IfcJunctionBox',
  // Generic distribution
  'IfcDistributionElement', 'IfcDistributionControlElement',
  'IfcDistributionFlowElement', 'IfcFlowTerminal', 'IfcFlowMovingDevice',
  'IfcFlowController', 'IfcFlowStorageDevice', 'IfcFlowTreatmentDevice',
  'IfcFlowFitting', 'IfcFlowSegment', 'IfcEnergyConversionDevice',
  // Segments
  'IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment', 'IfcCableSegment',
  'IfcDuctFitting', 'IfcPipeFitting', 'IfcCableCarrierFitting',
  // Furnishing (often used for MEP equipment in some models)
  'IfcFurnishingElement',
]

const elements = bim.query.byType(...MEP_TYPES)

if (elements.length === 0) {
  // Fall back: show what types ARE in the model so user can adapt
  console.warn('No standard MEP element types found.')
  console.log('')
  console.log('Available types in this model:')
  const all = bim.query.all()
  const types: Record<string, number> = {}
  for (const e of all) types[e.Type] = (types[e.Type] || 0) + 1
  for (const [t, c] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + t + ': ' + c)
  }
  console.log('')
  console.log('Tip: edit MEP_TYPES at top of script to match your model\'s types.')
  throw new Error('no MEP elements')
}

// ── 2. Group by IFC type ────────────────────────────────────────────────
const byType: Record<string, BimEntity[]> = {}
for (const e of elements) {
  if (!byType[e.Type]) byType[e.Type] = []
  byType[e.Type].push(e)
}

console.log('═══════════════════════════════════════')
console.log('  MEP EQUIPMENT SCHEDULE')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Found ' + elements.length + ' MEP elements across ' + Object.keys(byType).length + ' types')

// ── 3. Extract properties for each type ─────────────────────────────────
// Properties of interest for MEP equipment
const MEP_PROPS = [
  'manufacturer', 'model', 'reference', 'status',
  'capacity', 'power', 'voltage', 'current', 'frequency',
  'flowrate', 'pressure', 'temperature',
  'nominalcapacity', 'nominalpower',
]

interface EquipmentEntry {
  entity: BimEntity
  props: Record<string, string | number | boolean | null>
}

const schedule: Record<string, EquipmentEntry[]> = {}
// Collect all unique property paths for CSV export columns
const propertyColumns = new Set<string>()

for (const [type, entities] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  schedule[type] = []

  // Cap property extraction at 200 per type
  const sample = entities.length > 200 ? entities.slice(0, 200) : entities

  for (const entity of sample) {
    const entry: EquipmentEntry = { entity, props: {} }
    const psets = bim.query.properties(entity)
    for (const pset of psets) {
      for (const p of pset.properties) {
        const lower = p.name.toLowerCase()
        if (MEP_PROPS.some(k => lower.includes(k)) && p.value !== null && p.value !== '') {
          const path = pset.name + '.' + p.name
          entry.props[path] = p.value
          propertyColumns.add(path)
        }
      }
    }
    schedule[type].push(entry)
  }
}

// ── 4. Print schedule ───────────────────────────────────────────────────
for (const [type, entries] of Object.entries(schedule).sort((a, b) => b[1].length - a[1].length)) {
  console.log('')
  console.log('── ' + type + ' (' + byType[type].length + ') ──')

  // Collect all property keys found in this type
  const allKeys = new Set<string>()
  for (const entry of entries) {
    for (const key of Object.keys(entry.props)) allKeys.add(key)
  }

  if (allKeys.size === 0) {
    // Show name grouping even without properties
    const names: Record<string, number> = {}
    for (const entry of entries) {
      const key = entry.entity.Name || entry.entity.ObjectType || '<unnamed>'
      names[key] = (names[key] || 0) + 1
    }
    for (const [name, count] of Object.entries(names).sort((a, b) => b[1] - a[1])) {
      console.log('  ' + name + (count > 1 ? ' (x' + count + ')' : ''))
    }
  } else {
    // Show first 10 entries with their properties
    for (const entry of entries.slice(0, 10)) {
      const label = entry.entity.Name || entry.entity.ObjectType || '<unnamed>'
      console.log('  ' + label)
      for (const [key, value] of Object.entries(entry.props)) {
        console.log('    ' + key + ' = ' + value)
      }
    }
    if (entries.length > 10) console.log('  ... and ' + (entries.length - 10) + ' more')
  }
}

// ── 5. Color-code by system type ────────────────────────────────────────
const palette = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
]
const batches: Array<{ entities: BimEntity[]; color: string }> = []
let colorIdx = 0
for (const [type, entities] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  batches.push({ entities, color: palette[colorIdx % palette.length] })
  colorIdx++
}
bim.viewer.colorizeAll(batches)
bim.viewer.isolate(elements)

// ── 6. Summary ──────────────────────────────────────────────────────────
console.log('')
console.log('── Type Summary ──')
for (const [type, entities] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  const color = palette[(Object.keys(byType).sort((a, b) => byType[b].length - byType[a].length).indexOf(type)) % palette.length]
  console.log('  ' + type + ': ' + entities.length + '  ● ' + color)
}

// ── 7. Export ────────────────────────────────────────────────────────────
const propCols = Array.from(propertyColumns).sort()
bim.export.csv(elements, {
  columns: ['Name', 'Type', 'ObjectType', 'GlobalId', 'Description', ...propCols],
  filename: 'mep-equipment-schedule.csv'
})
console.log('')
console.log('Exported ' + elements.length + ' MEP elements (' + (5 + propCols.length) + ' columns) to mep-equipment-schedule.csv')
console.log('Elements are isolated and color-coded by type in 3D view')
