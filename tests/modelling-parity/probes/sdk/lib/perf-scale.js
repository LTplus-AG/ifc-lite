// Helper for large-tall-model-performance.js (not a probe itself): grows a fresh blank session
// with batches of 50 columns until PARITY_SCALE_BUDGET_MS runs out, printing one JSON line with
// the cost of one addColumn per batch. Run by the probe as `ifc-lite run lib/perf-scale.js`.
const S = bim.store, M = bim.model.activeId(), L = S.listStoreyLevels(M)[0].expressId;
const budget = Number(process.env.PARITY_SCALE_BUDGET_MS || 30000), t0 = Date.now(), batches = [];
for (let b = 0; b < 40 && Date.now() - t0 < budget; b++) {
  const n0 = bim.query().toArray().length, tb = Date.now();
  let ops = 0;
  for (let i = 0; i < 50 && Date.now() - t0 < budget; i++, ops++) S.addColumn(M, L, { Position: [i * 0.5, b * 2, 0], Width: 0.3, Depth: 0.3, Height: 3 });
  if (ops) batches.push({ sessionElements: n0, ops, msPerOp: Math.round(((Date.now() - tb) / ops) * 100) / 100 });
}
console.log(`@@SCALE@@${JSON.stringify(batches)}`);
