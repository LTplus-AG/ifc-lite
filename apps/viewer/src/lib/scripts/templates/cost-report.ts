/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Cost report (IFC 5D) ────────────────────────────────────────────────
// Stakeholder: Cost Estimator / Quantity Surveyor
//
// Reads the loaded model's IfcCostSchedule / IfcCostItem graph through
// `bim.cost` (the same read model the viewer's Cost panel uses — see
// docs/guide/cost-panel.md) and prints a per-item report: resolved amount
// and currency, or — when a value could not be evaluated — the evaluator's
// own diagnostic, never a guess. Exports a CSV alongside the console report.
//
// This script is READ-ONLY: `bim.cost` has no write/author methods.
// Spreadsheet-style cost editing is out of scope for the viewer's Cost
// panel and for this template.
// ─────────────────────────────────────────────────────────────────────────

const data = bim.cost.data()

if (!data.HasCostData) {
  // Genuinely no cost data — NOT the same as "the read failed". `bim.cost`
  // never conflates the two; neither does this report.
  console.log('[cost] this model has no IfcCostItem/IfcCostSchedule data.')
} else {
  console.log(`[cost] schema ${data.SchemaVersion} — ${data.CostSchedules.length} schedule(s), ${data.CostItems.length} cost item(s)`)

  if (data.Currency) {
    console.log(`[cost] project currency: ${data.Currency}`)
  } else {
    const mixedCurrency = data.Diagnostics.some((d) => d.Code === 'MIXED_CURRENCY')
    console.log(mixedCurrency
      ? '[cost] WARNING: the project declares more than one currency — amounts below are never summed across currencies.'
      : '[cost] no project currency declared.')
  }

  const cyclic = data.Diagnostics.some((d) => d.Code === 'NESTING_CYCLE')
  if (cyclic) {
    console.log('[cost] WARNING: a cost item nesting cycle was detected — see per-item diagnostics below.')
  }

  type Row = { id: string; name: string; identification: string; amount: string; currency: string; diagnostics: string }
  const rows: Row[] = []

  for (const item of data.CostItems) {
    const evaluation = bim.cost.evaluateItem(item.ref)
    const unresolved = evaluation.Amount === undefined
    const diagnosticText = evaluation.Diagnostics.map((d) => `${d.Code}: ${d.Message}`).join(' | ')
    console.log(
      unresolved
        ? `  ✗ #${item.ref.expressId} ${item.Name ?? '(unnamed)'} — unresolved${diagnosticText ? ` (${diagnosticText})` : ''}`
        : `  ✓ #${item.ref.expressId} ${item.Name ?? '(unnamed)'} — ${evaluation.Amount}${evaluation.Currency ? ` ${evaluation.Currency}` : ''}`,
    )
    rows.push({
      id: String(item.ref.expressId),
      name: item.Name ?? '',
      identification: item.Identification ?? '',
      amount: evaluation.Amount ?? '',
      currency: evaluation.Currency ?? '',
      diagnostics: diagnosticText,
    })
  }

  const header = ['expressId', 'name', 'identification', 'amount', 'currency', 'diagnostics']
  const csvEscape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const csv = [
    header.join(','),
    ...rows.map((r) => [r.id, r.name, r.identification, r.amount, r.currency, r.diagnostics].map(csvEscape).join(',')),
  ].join('\n')

  bim.export.download(csv, 'cost-report.csv', 'text/csv')
  console.log(`[cost] exported cost-report.csv (${rows.length} row(s))`)
}
