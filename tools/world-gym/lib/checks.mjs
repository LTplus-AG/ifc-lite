/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-process schema / clash / quantity checks for the World Gym labeler.
 *
 * v1 labeled every model by launching two fresh `node dist/index.js <cmd>`
 * subprocesses (`ifc-lite validate --json`, `ifc-lite clash --matrix
 * --json`), paying ~250-500ms of Node startup + module load + WASM init per
 * call - the dominant cost of the whole pipeline (median 1434ms/model
 * against a sub-10ms generation cost). This module removes that tax by
 * importing the exact same building blocks those commands use and keeping
 * one warm GeometryProcessor per process:
 *
 *   - schema: `computeValidationIssues()` from packages/cli's validate.ts -
 *     the literal function `ifc-lite validate` calls, not a reimplementation.
 *   - clash: `GeometryProcessor.process()` + `elementsFromStep()` +
 *     `createClashEngine().run()` - the same pipeline clash.ts drives, with
 *     the same discipline-matrix rules PLUS one World-Gym rule
 *     (`IfcFooting` self-clash, hard mode). The extra rule exists because
 *     the discipline matrix only pairs MEP/HVAC/ELEC/FIRE selectors against
 *     structure/architecture - a corpus containing only walls, slabs,
 *     columns, beams and spaces can NEVER fire a matrix rule, which is
 *     exactly why the v1 pilot's "0 clashes across 1,000 models" was
 *     vacuous. World Gym's adversarial mode injects overlapping IfcFooting
 *     pairs (a type no clean family emits), so the footing self-clash rule
 *     is the discriminative channel: clean models score 0 by construction,
 *     corrupted models score the number of injected overlapping pairs.
 *   - quantities: re-extracted from the PARSED file via EntityNode (not from
 *     generation metadata), so the quantity-accuracy reward channel compares
 *     "what an independent reader sees in the bytes" against the generation
 *     ground truth.
 *
 * Console hygiene: the geometry/opening-cutting pipeline writes diagnostic
 * lines (`rect_fast: fired ...`, `[IFC-LITE] Opening classifier ...`)
 * straight to console.log, not through any logger. In-process that noise
 * would interleave with our own stdout payloads, so every check runs under
 * `withQuietConsole()` which routes console.log/warn to stderr for the
 * duration of the call. (loadIfcBytes already captures parser console
 * output itself; this covers the geometry pipeline which it does not.)
 */

// These bind to BUILT workspace artifacts (packages/*/dist). Guarded dynamic
// imports (top-level await) instead of static imports so a missing/stale
// build fails with an actionable message rather than a raw
// ERR_MODULE_NOT_FOUND from deep inside the resolver. Note the guard can
// only catch a missing build, not a stale one - rebuild before long runs.
let loadIfcBytes;
let computeValidationIssues;
let GeometryProcessor;
let createClashEngine;
let disciplineMatrixRules;
let elementsFromStep;
let EntityNode;
try {
  ({ loadIfcBytes } = await import('../../../packages/cli/dist/loader.js'));
  ({ computeValidationIssues } = await import('../../../packages/cli/dist/commands/validate.js'));
  ({ GeometryProcessor } = await import('../../../packages/geometry/dist/index.js'));
  ({ createClashEngine, disciplineMatrixRules } = await import('../../../packages/clash/dist/index.js'));
  ({ elementsFromStep } = await import('../../../packages/clash/dist/adapters/step.js'));
  ({ EntityNode } = await import('../../../packages/query/dist/index.js'));
} catch (err) {
  throw new Error(
    `world-gym checks need the built workspace artifacts (packages/*/dist). Run 'pnpm build' (and 'pnpm build:wasm' or 'pnpm build:wasm:fetch') at the repo root first. Underlying error: ${err.message}`,
  );
}

/** The one non-matrix rule; see module doc for why the matrix alone is blind here. */
export const FOOTING_SELF_RULE = { id: 'gym-footing-self', name: 'IfcFooting self-clash', a: 'IfcFooting', mode: 'hard', severity: 'critical' };

let sharedProcessor = null;
let consolePatched = false;

/**
 * Permanently route console.log/warn to stderr for this process. The wasm
 * geometry module captures its print bindings at init time, so a scoped
 * (restore-in-finally) redirect leaks diagnostics onto stdout whenever the
 * module prints through a binding taken before or outside the scope. Label
 * workers and the labeler CLI both emit their payloads via
 * process.stdout.write / IPC, never console, so a process-wide redirect is
 * safe and is the only reliable way to keep stdout parseable.
 */
function patchConsoleToStderr() {
  if (consolePatched) return;
  consolePatched = true;
  const toStderr = (...parts) => process.stderr.write(`${parts.map(String).join(' ')}\n`);
  console.log = toStderr;
  console.warn = toStderr;
  console.info = toStderr;
}

/** Warm (or reuse) the per-process GeometryProcessor. One WASM init per worker, amortized. */
export async function initChecks() {
  if (!sharedProcessor) {
    patchConsoleToStderr();
    sharedProcessor = new GeometryProcessor();
    await sharedProcessor.init();
  }
  return sharedProcessor;
}

/** Route console.log/warn to stderr for the duration of `fn` (sync or async). */
async function withQuietConsole(fn) {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...parts) => process.stderr.write(`${parts.map(String).join(' ')}\n`);
  console.warn = console.log;
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

/**
 * Parse serialized IFC content into an IfcDataStore, in-process.
 * Accepts the generator's UTF-8 string content.
 */
export async function parseStore(content, label = 'in-memory.ifc') {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return withQuietConsole(() => loadIfcBytes(bytes, label));
}

/** Same verdict shape the v1 subprocess `ifc-lite validate --json` path produced. */
export function schemaCheckInProcess(store) {
  const issues = computeValidationIssues(store);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  return {
    ok: true,
    valid: errors === 0,
    errors,
    warnings,
    schema: store.schemaVersion ?? null,
    issues: issues.map((i) => ({ severity: i.severity, rule: i.rule, message: i.message })),
  };
}

/**
 * Clash verdict: discipline matrix (parity with the v1 subprocess path) plus
 * the footing self-clash rule (the actually-discriminative one; see module doc).
 */
export async function clashCheckInProcess(store, modelId = 'model.ifc', probeExpressIds = []) {
  const processor = await initChecks();
  return withQuietConsole(async () => {
    // `store.source` is an IfcSourceBytes ACCESSOR since #2339, not a
    // Uint8Array. It still answers `byteLength`, so the guard below passes --
    // but `GeometryProcessor.process(buffer: Uint8Array)` then meshes nothing
    // and returns 0 entries, which silently zeroes every clash rule. Scope the
    // materialized buffer to the call, matching packages/cli gym/channels.ts.
    const source = store.source;
    if (!source || source.byteLength === 0) {
      return { ok: false, error: 'store did not retain source bytes' };
    }
    const result = await source.withMaterializedAsync((bytes) => processor.process(bytes));
    const meshes = result.meshes;
    const meshedIds = new Set(meshes.map((m) => m.expressId));
    const probesMeshed = {};
    for (const id of probeExpressIds) probesMeshed[id] = meshedIds.has(id);
    const { elements, exclusions } = elementsFromStep({ store, meshes, modelId });

    const rules = [...disciplineMatrixRules('hard'), FOOTING_SELF_RULE];
    const engine = createClashEngine({ backend: 'ts' });
    const clashResult = await engine.run(elements, rules, { exclusions });

    const byRule = {};
    const pairs = [];
    for (const c of clashResult.clashes) {
      byRule[c.ruleId ?? c.rule ?? 'unknown'] = (byRule[c.ruleId ?? c.rule ?? 'unknown'] ?? 0) + 1;
      pairs.push({
        a: c.a.name ?? c.a.tag ?? c.a.key,
        b: c.b.name ?? c.b.tag ?? c.b.key,
        severity: c.severity,
        distance: Math.round(c.distance * 1e6) / 1e6,
      });
    }
    pairs.sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : x.b > y.b ? 1 : 0) : x.a < y.a ? -1 : 1));

    return {
      ok: true,
      total: clashResult.summary.total,
      bySeverity: clashResult.summary.bySeverity,
      byRule,
      pairs: pairs.slice(0, 50),
      meshedElementCount: meshes.length,
      probesMeshed,
    };
  });
}

/** Express ids of elements whose Name starts with `prefix` (used to locate injected defect elements in the parsed file). */
export function findExpressIdsByNamePrefix(store, ifcType, prefix) {
  const ids = store.entityIndex.byType.get(ifcType) ?? [];
  const out = [];
  for (const id of ids) {
    const name = new EntityNode(store, id).name;
    if (typeof name === 'string' && name.startsWith(prefix)) out.push(id);
  }
  return out;
}

/**
 * Re-extract the GymQuantities totals from the parsed store - an independent
 * read of the bytes, deliberately NOT reusing generation metadata, so the
 * quantity-accuracy channel measures file-vs-ground-truth agreement.
 * Sums GrossVolume (walls/columns/beams/slabs) and NetFloorArea (spaces).
 */
export function extractQuantityTotals(store) {
  const sumQuantity = (ifcType, qtyName) => {
    const ids = store.entityIndex.byType.get(ifcType) ?? [];
    let sum = 0;
    let withQty = 0;
    for (const id of ids) {
      const v = new EntityNode(store, id).quantity('GymQuantities', qtyName);
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
        withQty += 1;
      }
    }
    return { sum, count: ids.length, withQty };
  };

  const wall = sumQuantity('IFCWALL', 'GrossVolume');
  const slab = sumQuantity('IFCSLAB', 'GrossVolume');
  const column = sumQuantity('IFCCOLUMN', 'GrossVolume');
  const beam = sumQuantity('IFCBEAM', 'GrossVolume');
  const space = sumQuantity('IFCSPACE', 'NetFloorArea');

  return {
    wallGrossVolume: wall.sum,
    slabGrossVolume: slab.sum,
    columnGrossVolume: column.sum,
    beamGrossVolume: beam.sum,
    roomNetFloorArea: space.sum,
    elementsWithQuantities: wall.withQty + slab.withQty + column.withQty + beam.withQty + space.withQty,
    quantifiableElements: wall.count + slab.count + column.count + beam.count + space.count,
  };
}
