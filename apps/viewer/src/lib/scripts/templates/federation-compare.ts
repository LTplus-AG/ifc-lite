/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Multi-Model Federation Comparison ───────────────────────────────────
// Stakeholder: Project Manager / BIM Coordinator
//
// When multiple IFC models are loaded (architectural + structural + MEP),
// this script compares them side by side: entity counts, type coverage,
// naming consistency, and property completeness per model. The UI shows
// one tree at a time — this script cross-references everything and
// highlights discrepancies that indicate coordination issues.
// ─────────────────────────────────────────────────────────────────────────

const models = bim.model.list()

if (models.length === 0) {
  console.error('No models loaded')
  throw new Error('no models')
}

console.log('═══════════════════════════════════════')
console.log('  FEDERATION COMPARISON')
console.log('═══════════════════════════════════════')
console.log('')

// ── 1. Model overview ───────────────────────────────────────────────────
console.log('── Loaded Models (' + models.length + ') ──')
let totalEntities = 0
for (const m of models) {
  const sizeMB = (m.fileSize / 1024 / 1024).toFixed(1)
  console.log('  [' + m.id.slice(0, 8) + '] ' + m.name)
  console.log('    Schema: ' + m.schemaVersion + '  |  Entities: ' + m.entityCount + '  |  Size: ' + sizeMB + ' MB')
  totalEntities += m.entityCount
}
console.log('')
console.log('Total: ' + totalEntities + ' entities across ' + models.length + ' models')

// ── 2. Type distribution per model ──────────────────────────────────────
const all = bim.query.all()

// Build type→model distribution
const typeByModel: Record<string, Record<string, number>> = {}
const modelEntityMap: Record<string, BimEntity[]> = {}
for (const e of all) {
  const mid = e.ref.modelId
  if (!modelEntityMap[mid]) modelEntityMap[mid] = []
  modelEntityMap[mid].push(e)

  if (!typeByModel[e.Type]) typeByModel[e.Type] = {}
  typeByModel[e.Type][mid] = (typeByModel[e.Type][mid] || 0) + 1
}

// Find types that exist in multiple models (potential overlaps/conflicts)
const sharedTypes: string[] = []
const exclusiveTypes: Record<string, string[]> = {} // modelId → types only in that model

for (const [type, distribution] of Object.entries(typeByModel)) {
  const modelIds = Object.keys(distribution)
  if (modelIds.length > 1) {
    sharedTypes.push(type)
  } else {
    const mid = modelIds[0]
    if (!exclusiveTypes[mid]) exclusiveTypes[mid] = []
    exclusiveTypes[mid].push(type)
  }
}

console.log('')
console.log('── Type Distribution ──')
console.log('')

// Types present in multiple models
if (sharedTypes.length > 0) {
  console.log('Types shared across models (' + sharedTypes.length + '):')
  const header = '  Type                         ' + models.map(m => ('| ' + m.name.slice(0, 10) + '          ').slice(0, 13)).join('')
  console.log(header)
  console.log('  ' + '-'.repeat(header.length - 2))

  for (const type of sharedTypes.sort((a, b) => {
    const totalA = Object.values(typeByModel[a]).reduce((s, v) => s + v, 0)
    const totalB = Object.values(typeByModel[b]).reduce((s, v) => s + v, 0)
    return totalB - totalA
  }).slice(0, 20)) {
    const typeStr = (type + '                              ').slice(0, 30)
    const counts = models.map(m => {
      const c = typeByModel[type][m.id] || 0
      return ('| ' + (c > 0 ? String(c) : '-') + '           ').slice(0, 13)
    }).join('')
    console.log('  ' + typeStr + counts)
  }
}

// Types exclusive to one model
console.log('')
console.log('Types exclusive to one model:')
for (const m of models) {
  const exclusive = exclusiveTypes[m.id] || []
  if (exclusive.length > 0) {
    console.log('  ' + m.name + ': ' + exclusive.slice(0, 8).join(', ') + (exclusive.length > 8 ? ' (+' + (exclusive.length - 8) + ' more)' : ''))
  }
}

// ── 3. Naming consistency check ─────────────────────────────────────────
console.log('')
console.log('── Naming Consistency ──')
for (const m of models) {
  const entities = modelEntityMap[m.id] || []
  const named = entities.filter(e => e.Name && e.Name !== '')
  const described = entities.filter(e => e.Description && e.Description !== '')
  const typed = entities.filter(e => e.ObjectType && e.ObjectType !== '')
  const namePct = entities.length > 0 ? (named.length / entities.length * 100).toFixed(1) : '0'
  const descPct = entities.length > 0 ? (described.length / entities.length * 100).toFixed(1) : '0'
  const typePct = entities.length > 0 ? (typed.length / entities.length * 100).toFixed(1) : '0'
  console.log('  ' + m.name + ':')
  console.log('    Named: ' + namePct + '%  |  Described: ' + descPct + '%  |  ObjectType: ' + typePct + '%')
}

// ── 4. Property coverage comparison ─────────────────────────────────────
console.log('')
console.log('── Property Coverage (sample of 100 per model) ──')
for (const m of models) {
  const entities = modelEntityMap[m.id] || []
  const sample = entities.slice(0, 100)
  let withPsets = 0
  let withQsets = 0
  let totalPsets = 0
  for (const e of sample) {
    const psets = bim.query.properties(e)
    const qsets = bim.query.quantities(e)
    if (psets.length > 0) withPsets++
    if (qsets.length > 0) withQsets++
    totalPsets += psets.length
  }
  const psetPct = sample.length > 0 ? (withPsets / sample.length * 100).toFixed(0) : '0'
  const qsetPct = sample.length > 0 ? (withQsets / sample.length * 100).toFixed(0) : '0'
  const avgPsets = sample.length > 0 ? (totalPsets / sample.length).toFixed(1) : '0'
  console.log('  ' + m.name + ':')
  console.log('    With properties: ' + psetPct + '%  |  With quantities: ' + qsetPct + '%  |  Avg psets/entity: ' + avgPsets)
}

// ── 5. Potential coordination issues ────────────────────────────────────
if (models.length > 1) {
  console.log('')
  console.log('── Coordination Notes ──')

  // Check for spatial types in non-architectural models
  const spatialTypes = ['IfcBuilding', 'IfcBuildingStorey', 'IfcSite', 'IfcSpace']
  for (const m of models) {
    const hasSpatial: string[] = []
    for (const st of spatialTypes) {
      if (typeByModel[st] && typeByModel[st][m.id]) {
        hasSpatial.push(st + '(' + typeByModel[st][m.id] + ')')
      }
    }
    if (hasSpatial.length > 0) {
      console.log('  ' + m.name + ' defines: ' + hasSpatial.join(', '))
    }
  }

  // Check entity count ratios (large disparities may indicate issues)
  const counts = models.map(m => modelEntityMap[m.id]?.length || 0)
  const maxCount = Math.max(...counts)
  const minCount = Math.min(...counts)
  if (maxCount > 0 && minCount > 0 && maxCount / minCount > 10) {
    console.warn('')
    console.warn('  Large entity count disparity (' + maxCount + ' vs ' + minCount + ')')
    console.warn('  This may indicate models at different levels of detail')
  }
}

// ── 6. Color-code by model origin ───────────────────────────────────────
const modelColors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']
const colorBatches: Array<{ entities: BimEntity[]; color: string }> = []
let idx = 0
for (const m of models) {
  const entities = modelEntityMap[m.id] || []
  if (entities.length > 0) {
    colorBatches.push({ entities, color: modelColors[idx % modelColors.length] })
    idx++
  }
}
if (colorBatches.length > 0) bim.viewer.colorizeAll(colorBatches)

console.log('')
console.log('── Model Colors ──')
idx = 0
for (const m of models) {
  console.log('  ' + m.name + '  ● ' + modelColors[idx % modelColors.length])
  idx++
}
