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
// own diagnostic, never a guess. Exports a JSON report alongside the console
// report.
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

  // Kept in sync with the Cost panel's own `CYCLE_CODES_LIST`
  // (apps/viewer/src/lib/cost/cost-tree.ts) — templates.ts substitutes the
  // real list into the literal below at template-build time (see the
  // CYCLE_CODES_INJECT marker and templates.test.ts's sync assertion), so
  // this file never hand-duplicates which diagnostic codes count as cyclic.
  const cycleCodes: string[] = ['NESTING_CYCLE'] // CYCLE_CODES_INJECT
  const cyclic = data.Diagnostics.some((d) => cycleCodes.includes(d.Code))
  if (cyclic) {
    console.log('[cost] WARNING: a cost item cycle was detected — see per-item diagnostics below.')
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

  // JSON, not CSV: `bim.export.csv()`/`bim.export.json()` resolve columns from an
  // entity's property/quantity sets (`SetName.ValueName`), and these rows carry
  // `bim.cost.evaluateItem()` results instead — a resolved amount, currency and
  // diagnostics text with no backing pset/qset to point a column path at. Rolling
  // a CSV writer by hand here would just be an eighth escaper (the repo caps this
  // at exactly one per language — see `scripts/check-csv-escaper-copies.mjs`), so
  // this template hands the report to `bim.export.download()` as JSON, which
  // needs no escaping of its own: `JSON.stringify` already quotes every value.
  const json = JSON.stringify(rows, null, 2)

  bim.export.download(json, 'cost-report.json', 'application/json')
  console.log(`[cost] exported cost-report.json (${rows.length} row(s))`)
}
