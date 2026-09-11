/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Data Quality Audit ──────────────────────────────────────────────────
// Stakeholder: BIM Manager / QA
//
// Scans every entity in the model for data completeness issues that would
// take hours to find by clicking through the UI. Produces a scorecard,
// color-codes the 3D view by quality level, and exports an issues CSV.
// ─────────────────────────────────────────────────────────────────────────

bim.viewer.resetColors()
const all = bim.query.all()
if (all.length === 0) { console.error('No entities loaded'); throw new Error('empty model') }

// ── 1. Check every entity for missing attributes ────────────────────────
interface Issue { entity: BimEntity; field: string }
const issues: Issue[] = []
const scores: Record<string, { entity: BimEntity; score: number }> = {}

// Track property coverage per type
const typePsetCoverage: Record<string, { total: number; withPsets: number }> = {}

for (const e of all) {
  let score = 0
  const maxScore = 5 // Name, Description, ObjectType, has properties, has quantities

  if (e.Name && e.Name !== '') score++
  else issues.push({ entity: e, field: 'Name' })

  if (e.Description && e.Description !== '') score++
  else issues.push({ entity: e, field: 'Description' })

  if (e.ObjectType && e.ObjectType !== '') score++
  else issues.push({ entity: e, field: 'ObjectType' })

  const psets = bim.query.properties(e)
  if (psets.length > 0) score++
  else issues.push({ entity: e, field: 'PropertySets' })

  const qsets = bim.query.quantities(e)
  if (qsets.length > 0) score++
  else issues.push({ entity: e, field: 'Quantities' })

  scores[e.GlobalId] = { entity: e, score }

  // Track pset coverage per type
  if (!typePsetCoverage[e.Type]) typePsetCoverage[e.Type] = { total: 0, withPsets: 0 }
  typePsetCoverage[e.Type].total++
  if (psets.length > 0) typePsetCoverage[e.Type].withPsets++
}

// ── 2. Classify entities by quality tier ────────────────────────────────
const tiers = { complete: [] as BimEntity[], good: [] as BimEntity[], partial: [] as BimEntity[], poor: [] as BimEntity[] }
for (const { entity, score } of Object.values(scores)) {
  if (score === 5) tiers.complete.push(entity)
  else if (score >= 4) tiers.good.push(entity)
  else if (score >= 2) tiers.partial.push(entity)
  else tiers.poor.push(entity)
}

// ── 3. Color-code by quality ────────────────────────────────────────────
const batches: Array<{ entities: BimEntity[]; color: string }> = []
if (tiers.complete.length > 0) batches.push({ entities: tiers.complete, color: '#27ae60' }) // green
if (tiers.good.length > 0) batches.push({ entities: tiers.good, color: '#f1c40f' })    // yellow
if (tiers.partial.length > 0) batches.push({ entities: tiers.partial, color: '#e67e22' }) // orange
if (tiers.poor.length > 0) batches.push({ entities: tiers.poor, color: '#e74c3c' })    // red
if (batches.length > 0) bim.viewer.colorizeAll(batches)

// ── 4. Report ───────────────────────────────────────────────────────────
const overallScore = ((tiers.complete.length + tiers.good.length * 0.8 + tiers.partial.length * 0.4) / all.length * 100)
console.log('═══════════════════════════════════════')
console.log('  DATA QUALITY AUDIT')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Overall score: ' + overallScore.toFixed(1) + '% (' + all.length + ' entities)')
console.log('')
console.log('  Complete (5/5): ' + tiers.complete.length + '  ● green')
console.log('  Good     (4/5): ' + tiers.good.length + '  ● yellow')
console.log('  Partial  (2-3): ' + tiers.partial.length + '  ● orange')
console.log('  Poor     (0-1): ' + tiers.poor.length + '  ● red')

// ── 5. Issue breakdown by field ─────────────────────────────────────────
const issuesByField: Record<string, number> = {}
for (const issue of issues) {
  issuesByField[issue.field] = (issuesByField[issue.field] || 0) + 1
}
console.log('')
console.log('── Missing Data Breakdown ──')
for (const [field, count] of Object.entries(issuesByField).sort((a, b) => b[1] - a[1])) {
  const pct = (count / all.length * 100).toFixed(1)
  console.log('  ' + field + ': ' + count + ' entities (' + pct + '% missing)')
}

// ── 6. Property coverage per type ───────────────────────────────────────
console.log('')
console.log('── Property Coverage by Type ──')
const coverageSorted = Object.entries(typePsetCoverage)
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 15)
for (const [type, cov] of coverageSorted) {
  const pct = (cov.withPsets / cov.total * 100).toFixed(0)
  const bar = '█'.repeat(Math.round(cov.withPsets / cov.total * 20))
  console.log('  ' + type + ': ' + bar + ' ' + pct + '% (' + cov.withPsets + '/' + cov.total + ')')
}

// ── 7. Worst offenders (first 10 entities with score 0-1) ──────────────
if (tiers.poor.length > 0) {
  console.log('')
  console.log('── Worst Offenders (score 0-1) ──')
  for (const e of tiers.poor.slice(0, 10)) {
    console.log('  ' + (e.Name || '<no name>') + ' [' + e.Type + '] GlobalId=' + e.GlobalId)
  }
  if (tiers.poor.length > 10) {
    console.log('  ... and ' + (tiers.poor.length - 10) + ' more')
  }
}

// ── 8. Export all entities with discovered property/quantity data ────────
// Discover common property columns from a sample
const sampleForDiscovery = all.slice(0, 200)
const discoveredPropPaths = new Set<string>()
const discoveredQtyPaths = new Set<string>()
for (const e of sampleForDiscovery) {
  const psets = bim.query.properties(e)
  for (const pset of psets) {
    for (const p of pset.properties) {
      if (p.value !== null && p.value !== '') {
        discoveredPropPaths.add(pset.name + '.' + p.name)
      }
    }
  }
  const qsets = bim.query.quantities(e)
  for (const qset of qsets) {
    for (const q of qset.quantities) {
      if (q.value !== null && q.value !== 0) {
        discoveredQtyPaths.add(qset.name + '.' + q.name)
      }
    }
  }
}
// Cap columns to keep CSV manageable
const auditPropCols = Array.from(discoveredPropPaths).sort().slice(0, 20)
const auditQtyCols = Array.from(discoveredQtyPaths).sort().slice(0, 10)
bim.export.csv(all, {
  columns: ['Name', 'Type', 'GlobalId', 'Description', 'ObjectType', ...auditPropCols, ...auditQtyCols],
  filename: 'data-quality-audit.csv'
})
console.log('')
console.log('Exported ' + all.length + ' entities (' + (5 + auditPropCols.length + auditQtyCols.length) + ' columns) to data-quality-audit.csv')
