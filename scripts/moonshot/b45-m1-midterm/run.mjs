#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B4.5 — the M1 midterm run as literally worded, all three clauses in ONE run.
 *
 * The exam (docs/vision/moonshots-finishing-plan.md §4 "M1", §5 "B4.5"):
 *
 *   A wall edit on the 169 MB Holter Tower fixture WITH REAL GEOMETRY-MESH
 *   LEAVES PRESENT, certificate verified in a second process in under 500 ms
 *   while resolving under 5% of DAG nodes, and over 90% cache hits on
 *   single-wall recompute.
 *
 * Why this script exists: the two halves had never been done at once.
 *   - `g0-certificate-demo.mjs` ran the 169 MB fixture but SKIPPED geometry-mesh
 *     leaves entirely (data plane only) and verified IN-PROCESS.
 *   - `g1-memoized-recompute.mjs` ran real mesh leaves but on the small duplex
 *     fixture; its 169 MB run again skipped meshes.
 * So the headline "63 ms, 0.052% of nodes, 169 MB" is a DATA-PLANE-ONLY number.
 * This script is g1's work at g0's scale, with g0's certificate, verified the
 * way b35-demo verifies: in a genuinely separate `node` process.
 *
 * Pipeline:
 *   1. Parse the fixture (packages/cli's loader -> ColumnarParser).
 *   2. Mesh it headlessly (GeometryProcessor, wasm-backed) — the SAME path
 *      `packages/cli`'s clash command and g1's mesh run use. This is the
 *      expensive step and its cost is reported honestly, separately.
 *   3. Build ONE node-hash-v0 DAG containing BOTH planes:
 *        geometry-mesh leaves (one per MeshData)  \
 *        property-set leaves (one per Pset/Qset)  / -> element -> storey
 *        (`relationship`) -> root (`layer`)
 *      Same shape and same node-kind vocabulary as g0/g1.
 *   4. Two single-wall edits, each recomputed through @ifc-lite/provenance's
 *      ProvenanceDag (clause 3, cache hits):
 *        A. property-only wall edit (the shape g1's exam used)
 *        B. property + GEOMETRY wall edit — every mesh leaf of that wall moves
 *           1 mm. This is the honest reading of "a wall edit ... with real
 *           geometry-mesh leaves present": the edit itself touches geometry.
 *      Edit B is the one the certificate is cut from.
 *   5. Certificate for edit B: writes = the wall's mesh leaves + the edited
 *      pset + element + storey + root; reads = the wall's untouched sibling
 *      psets; claim = `subtree-untouched` over every OTHER storey.
 *   6. Verify in a SECOND PROCESS (`verify-worker.mjs`), 1 warmup + 5 timed
 *      spawns, counting every resolver lookup (clauses 1 and 2).
 *   7. Tamper battery in the second process: (a) flip one float in a bundled
 *      mesh payload, (b) flip one child hash under a bundled untouched-storey
 *      subtree, (c) do (b) AND re-derive the claim's own hash so the
 *      certificate agrees with the lie, then stamp an attacker-chosen trust
 *      anchor on it and on the bundle's `expected*` fields. Each must be
 *      rejected, must have altered something, and must be rejected for the
 *      SPECIFIC reason it was written to prove.
 *   8. Correctness cross-check: a from-scratch rebuild over the final payload
 *      state must reproduce the incrementally recomputed DAG exactly. It is
 *      part of the verdict, not a note beside it.
 *
 * Writable domain for this bet is `scripts/moonshot/b45-m1-midterm/**` only;
 * nothing under packages/ or the g0/g1 scripts is touched.
 *
 * Usage:
 *   node scripts/moonshot/b45-m1-midterm/run.mjs [--probe] [--no-aggregates]
 *        [--write-scorecard | --scorecard-out <path>] [fixture.ifc]
 *
 *   --probe             stop after parse + mesh + structure and print an
 *                       extrapolated cost for the full mesh-leaf hash pass.
 *   --no-aggregates     use g0/g1's narrower DAG shape (storey containment only,
 *                       no IfcRelAggregates expansion) for a like-for-like
 *                       comparison against those runs.
 *   --write-scorecard   re-bless: overwrite the COMMITTED scorecard next to this
 *                       script (`scorecard.json`, or `scorecard-no-aggregates.json`
 *                       under --no-aggregates).
 *   --scorecard-out <p> write the scorecard to an explicit path.
 * Env:
 *   B45_SKIP_CROSSCHECK=1   skip the from-scratch rebuild cross-check
 *   B45_KEEP_BUNDLES=1      keep the working bundles instead of deleting them
 *   B45_OUT=<dir>           where bundles go (default: a fresh per-run mkdtemp
 *                           directory; setting this makes the path shared again,
 *                           so do not point two concurrent runs at one)
 *   B45_HEAP_MB=<n>         old-space limit for the re-exec (default 12288)
 *
 * THE PLAIN RUN DOES NOT TOUCH THE COMMITTED SCORECARD. It writes to a temp
 * path and prints where. An earlier revision always wrote `scorecard.json` next
 * to this script, which meant the documented reproduction command destroyed the
 * source of truth it was supposed to be checked against -- and `--no-aggregates`
 * destroyed it with figures from a DIFFERENT DAG shape. Re-blessing is now an
 * explicit act (`--write-scorecard`), which is what a source of truth deserves.
 *
 * The script re-execs itself once with a raised old-space limit; a mesh-bearing
 * DAG at this scale does not fit in Node's default heap.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

/* ------------------------------------------------------------------ */
/* Re-exec with a bigger heap (once).                                   */
/* ------------------------------------------------------------------ */

const HEAP_MB = Number(process.env.B45_HEAP_MB ?? 12288);
if (!process.env.B45_REEXEC) {
  const child = spawnSync(
    process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, __filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, B45_REEXEC: '1' } },
  );
  process.exit(child.status ?? 1);
}

const { loadIfcFile } = await import(path.join(REPO_ROOT, 'packages/cli/dist/loader.js'));
const { RelationshipType } = await import(path.join(REPO_ROOT, 'packages/data/dist/index.js'));
const { ProvenanceDag, computeNodeHash, createCertificate, hashResolvedNode } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);
const { GeometryProcessor } = await import(path.join(REPO_ROOT, 'packages/geometry/dist/index.js'));

const argv = process.argv.slice(2);
const PROBE = argv.includes('--probe');
// `--no-aggregates` reproduces g0/g1's DAG shape exactly (storey ->
// IfcRelContainedInSpatialStructure only). Default is the wider shape that
// also follows IfcRelAggregates — see buildDagStructure's docstring.
const EXPAND_AGGREGATES = !argv.includes('--no-aggregates');
const WRITE_SCORECARD = argv.includes('--write-scorecard');
const scorecardOutIdx = argv.indexOf('--scorecard-out');
const SCORECARD_OUT_ARG = scorecardOutIdx === -1 ? null : argv[scorecardOutIdx + 1];
if (scorecardOutIdx !== -1 && (!SCORECARD_OUT_ARG || SCORECARD_OUT_ARG.startsWith('--'))) {
  console.error('--scorecard-out needs a path argument.');
  process.exit(2);
}
if (WRITE_SCORECARD && SCORECARD_OUT_ARG) {
  console.error('--write-scorecard and --scorecard-out are mutually exclusive: one re-blesses the');
  console.error('committed scorecard, the other writes somewhere else. Pick one.');
  process.exit(2);
}
const positional = argv.filter(
  (a, i) => !a.startsWith('--') && !(scorecardOutIdx !== -1 && i === scorecardOutIdx + 1),
);
const FIXTURE = path.resolve(
  REPO_ROOT,
  positional[0] ?? 'tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc',
);
// The fixture is not committed (no LFS; see AGENTS.md "Test fixtures"). Say so
// here rather than letting the loader throw a parse error three frames deep.
//
// It FAILS rather than skipping, deliberately, and that is a departure from the
// rule for fixture-backed *tests*. This is not a test: nothing runs it in CI
// (grep `b45` in .github/workflows -- no hit), and its siblings g0 and g1, which
// need the same 169 MB fixture and ARE in CI, do not self-skip either; the
// workflow gates them from outside (moonshot.yml E2a/E2b, `fixtures.outputs.scope
// != full` -> notice + exit 0). Exiting 0 here would put a silent green inside
// the one script whose whole output is a PASS/FAIL verdict, which is how a bet
// comes to be scored on a run that never happened.
if (!existsSync(FIXTURE)) {
  // `fetch-fixtures.mjs` takes a path relative to tests/models, so only print a
  // fetch command for a fixture that actually lives under it. A command that
  // does not work is worse than no command.
  const catalogued = path.relative(path.join(REPO_ROOT, 'tests/models'), FIXTURE).replace(/\\/g, '/');
  const fetchLine =
    catalogued.startsWith('..') || path.isAbsolute(catalogued)
      ? '  (not under tests/models, so it is not in the fixture catalogue)\n'
      : `  FIXTURE_TIMEOUT_MS=600000 node scripts/fixtures/fetch-fixtures.mjs ${catalogued}\n`;
  console.error(
    `[b45] fixture not found: ${FIXTURE}\n` +
      'It is not committed. Fetch it with:\n' +
      fetchLine +
      'or fetch the whole catalogue with `pnpm fixtures`. The 60 s default timeout\n' +
      'aborts a 177 MB pull, which is why FIXTURE_TIMEOUT_MS is set above.',
  );
  process.exit(2);
}
// Bundles are working artifacts, not deliverables: the element-granularity
// sensitivity bundle alone is ~36 MB, which has no business landing in the
// repo. They go to a PER-RUN temp dir and are removed at the end (keep them
// with B45_KEEP_BUNDLES=1). Only `scorecard.json` is written next to this
// script.
//
// PER-RUN, AND WHY THAT IS NOT TIDINESS. This was a fixed
// `$TMPDIR/ifc-lite-b45-m1-midterm` shared by every concurrent run, and every
// run ends by `rmSync`-ing it. Measured, two runs started together (duplex and
// AC20-FZK-Haus, six trials): the loser lost its tamper bundles mid-battery in
// 6/6, and in 5 of those the forged-trust-anchor case came back
// `caught: true, altered: true` on `unreadable-bundle` -- rejected because its
// file had been deleted under it, not because the anchor check fired. Under the
// catch-only assertion this script carried one commit ago that is a green
// tamper battery on a PASS scorecard, testing nothing. The silent form is
// worse: both runs use the same TRUST_ROOT and KERNEL_VERSION, so one run's
// bundle verifies `ok: true` in the other's worker -- measured, the FZK bundle
// at duplex's shared path returns `ok: true, nodesResolved: 8` where the
// genuine bundle returns 22, so clause 1 and clause 2 would be reported over a
// different model with this run's denominator. `mkdtemp` makes the path
// unguessable and unshared; the payload-count assertion in
// `verifyInSecondProcess` is the second line, because a verifier that accepts
// any internally-consistent bundle under the same anchor cannot tell the runner
// it was handed the wrong one.
const OUT_DIR = process.env.B45_OUT
  ? path.resolve(process.env.B45_OUT)
  : mkdtempSync(path.join(os.tmpdir(), 'ifc-lite-b45-m1-midterm-'));

/**
 * Where the scorecard goes. The two DAG shapes get two different committed
 * names on purpose: `--no-aggregates` measures a different graph, and letting it
 * overwrite `scorecard.json` is how a documented reproduction command silently
 * replaces the exam's own record with a counterfactual's.
 */
const SCORECARD_NAME = EXPAND_AGGREGATES ? 'scorecard.json' : 'scorecard-no-aggregates.json';
const COMMITTED_SCORECARD = path.join(__dirname, SCORECARD_NAME);
const SCORECARD_PATH = SCORECARD_OUT_ARG
  ? path.resolve(SCORECARD_OUT_ARG)
  : WRITE_SCORECARD
    ? COMMITTED_SCORECARD
    : // Tagged with the run's own temp-dir name for the same reason the temp dir
      // is per-run: `$TMPDIR/ifc-lite-b45-scorecard.json` was a fixed path, so
      // two plain runs raced to write the file each of them then tells the
      // reader to go and read.
      path.join(os.tmpdir(), `${path.basename(OUT_DIR)}-${SCORECARD_NAME}`);

const KERNEL_VERSION = 'b45-m1-midterm-kernel-v0';
const TRUST_ROOT = 'b45-m1-midterm-trust-root-v0';
// Placeholder tagged layerId for the root `layer` node (spec §3.4 / Q1), same
// stand-in g0/g1 use: this demo has no ifcx layer document behind the root.
const ROOT_LAYER_ID = 'blake3:b45-m1-midterm-root-layer-placeholder';

const log = (...parts) => {
  const rss = (process.memoryUsage.rss() / 1e6).toFixed(0);
  console.error(`[b45 +${(performance.now() / 1000).toFixed(1)}s rss=${rss}MB]`, ...parts);
};

/** Highest RSS this process has been observed at. Node's `resourceUsage().maxRSS`
 *  is the authority (kernel-tracked high-water mark); this sampler exists only
 *  to attribute the peak to a phase. */
let peakRssBytes = 0;
const samplePeak = () => {
  const rss = process.memoryUsage.rss();
  if (rss > peakRssBytes) peakRssBytes = rss;
  return rss;
};
const peakSampler = setInterval(samplePeak, 250);
peakSampler.unref();

/* ------------------------------------------------------------------ */
/* Shared helpers (same normalization rules as g0/g1)                   */
/* ------------------------------------------------------------------ */

function normalizePropertyValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mutatedValue(value) {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'string') return `${value}__EDITED`;
  return 'EDITED_FROM_NULL';
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/* ------------------------------------------------------------------ */
/* DAG structure: BOTH planes                                           */
/* ------------------------------------------------------------------ */

/**
 * Build the node spec factory. Same node-kind vocabulary and same
 * leaf -> element -> storey -> root shape as g0/g1, with three changes forced
 * by 169 MB scale and by mesh leaves actually being present:
 *
 *   - meshes are bucketed by expressId ONCE (g1's per-element
 *     `meshes.filter(...)` is O(elements x meshes) — fine on duplex, quadratic
 *     death on the tower);
 *   - mesh typed arrays are referenced, not copied (g1's `Float32Array.from`
 *     would double an already multi-GB working set);
 *   - `expandAggregates` (default on) also walks `IfcRelAggregates` from each
 *     storey-contained element, registering decomposed sub-elements as element
 *     nodes under their parent element.
 *
 * That last one is not cosmetic. g0/g1 reach elements ONLY through
 * `IfcRelContainedInSpatialStructure`, and on this fixture that misses 40,028
 * of 110,632 MeshData entries (36%) — 27,427 IfcMember + 11,469 IfcPlate, i.e.
 * the curtain-wall system, which is aggregated into its host rather than
 * contained by the storey. Leaving them out would understate the geometry
 * plane by a third while claiming "mesh leaves present". Both shapes are run
 * and both are reported, because the wider shape ALSO inflates the clause-2
 * denominator — see REPORT.md, this is called out rather than banked.
 */
function buildDagStructure(store, meshes, { expandAggregates = true } = {}) {
  const byExpressId = new Map();
  let classCounts = { 0: 0, 1: 0, 2: 0, other: 0 };
  for (const mesh of meshes) {
    const cls = mesh.geometryClass ?? 0;
    if (cls === 0 || cls === 1 || cls === 2) classCounts[cls]++;
    else classCounts.other++;
    // Class 2 = instanced type TEMPLATE, not a placed occurrence (see
    // packages/geometry/src/types.ts). g1 excluded it from the DAG and this
    // run keeps that decision so the two are comparable; the count of what was
    // excluded is reported rather than quietly dropped.
    if (cls === 2) continue;
    let list = byExpressId.get(mesh.expressId);
    if (!list) {
      list = [];
      byExpressId.set(mesh.expressId, list);
    }
    list.push(mesh);
  }

  const storeyEntities = store.getEntitiesByType('IfcBuildingStorey');
  const storeys = storeyEntities.map((s) => ({
    expressId: s.expressId,
    name: store.entities.getName(s.expressId) || `Storey #${s.expressId}`,
    elementIds: store.relationships.getRelated(s.expressId, RelationshipType.ContainsElements, 'forward'),
  }));

  const elementMeta = new Map(); // expressId -> { storeyId, ifcType, globalId, psetNodeIds, meshNodeIds, subElementIds }
  const elementChildren = new Map();
  const initialLeafPayloads = new Map();
  let psetCount = 0;
  let meshLeafCount = 0;
  let elementCount = 0;
  let aggregatedElementCount = 0;
  const attachedExpressIds = new Set();

  /** Register one element node (and its leaves). Returns false if already
   *  registered — an element decomposed into two parents, or contained twice,
   *  is deduped so it appears exactly once in the DAG. */
  function registerElement(expressId, storeyExpressId, subElementIds) {
    if (elementMeta.has(expressId)) return false;

    const psets = store.getProperties(expressId);
    const psetNodeIds = [];
    for (let i = 0; i < psets.length; i++) {
      const pset = psets[i];
      const nodeId = `pset:${expressId}:${i}`;
      initialLeafPayloads.set(nodeId, {
        name: pset.name,
        properties: pset.properties.map((p) => ({ name: p.name, value: normalizePropertyValue(p.value) })),
      });
      psetNodeIds.push({ nodeId, name: pset.name });
      psetCount++;
    }

    const elementMeshes = byExpressId.get(expressId) ?? [];
    if (elementMeshes.length > 0) attachedExpressIds.add(expressId);
    const meshNodeIds = elementMeshes.map((_, i) => `mesh:${expressId}:${i}`);
    elementMeshes.forEach((mesh, i) => {
      initialLeafPayloads.set(meshNodeIds[i], {
        expressId: mesh.expressId,
        geometryClass: mesh.geometryClass ?? 0,
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        origin: mesh.origin ?? [0, 0, 0],
      });
      meshLeafCount++;
    });

    const ifcType = store.entities.getTypeName(expressId) || 'Unknown';
    const globalId = store.entities.getGlobalId(expressId) || String(expressId);
    elementMeta.set(expressId, {
      storeyId: storeyExpressId,
      ifcType,
      globalId,
      psetNodeIds,
      meshNodeIds,
      subElementIds,
    });
    elementChildren.set(expressId, {
      childIds: [
        ...meshNodeIds,
        ...psetNodeIds.map((p) => p.nodeId),
        ...subElementIds.map((id) => `element:${id}`),
      ],
      componentKeys: [
        ...meshNodeIds.map((id, i) => ({ id, key: `geometry-mesh#${i}` })),
        ...psetNodeIds.map((p, i) => ({ id: p.nodeId, key: `pset:${p.name}#${i}` })),
        ...subElementIds.map((id) => ({ id: `element:${id}`, key: `decomposes:${id}` })),
      ],
    });
    elementCount++;
    return true;
  }

  /** Direct `IfcRelAggregates` children of `expressId` that are themselves
   *  registerable elements (not already registered elsewhere in the DAG). */
  function aggregateChildren(expressId) {
    if (!expandAggregates) return [];
    const kids = store.relationships.getRelated(expressId, RelationshipType.Aggregates, 'forward') ?? [];
    // Dedupe and drop self-references defensively; a malformed model that
    // aggregates an element into itself would otherwise cycle the DAG.
    return [...new Set(kids)].filter((id) => id !== expressId);
  }

  for (const storey of storeys) {
    for (const rootExpressId of storey.elementIds) {
      if (elementMeta.has(rootExpressId)) continue;
      // Iterative post-order: children must be registered before the parent,
      // because a parent's element node lists its children's node ids.
      const stack = [{ id: rootExpressId, expanded: false }];
      const inProgress = new Set();
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (elementMeta.has(frame.id)) {
          stack.pop();
          inProgress.delete(frame.id);
          continue;
        }
        if (!frame.expanded) {
          frame.expanded = true;
          inProgress.add(frame.id);
          frame.kids = aggregateChildren(frame.id).filter(
            (id) => !elementMeta.has(id) && !inProgress.has(id),
          );
          for (const kid of frame.kids) stack.push({ id: kid, expanded: false });
          continue;
        }
        stack.pop();
        inProgress.delete(frame.id);
        const subElementIds = frame.kids.filter((id) => elementMeta.has(id));
        registerElement(frame.id, storey.expressId, subElementIds);
        if (frame.id !== rootExpressId) aggregatedElementCount++;
      }
    }
  }

  // Meshes whose expressId is not directly contained in any storey have no
  // element node to hang from in this DAG shape (g0/g1 have the same blind
  // spot: both walk storey -> ContainsElements). Counted, not hidden.
  let orphanMeshes = 0;
  for (const [expressId, list] of byExpressId) {
    if (!attachedExpressIds.has(expressId)) orphanMeshes += list.length;
  }

  function buildSpecs(leafPayloads) {
    const specs = [];
    for (const [nodeId, payload] of leafPayloads) {
      specs.push({
        id: nodeId,
        kind: nodeId.startsWith('mesh:') ? 'geometry-mesh' : 'property-set',
        payload,
      });
    }
    for (const [expressId, meta] of elementMeta) {
      const { childIds, componentKeys } = elementChildren.get(expressId);
      specs.push({
        id: `element:${expressId}`,
        kind: 'element',
        children: childIds,
        buildPayload: (h) => ({
          key: meta.globalId,
          ifcType: meta.ifcType,
          components: componentKeys.map(({ id, key }) => ({ componentKey: key, hash: h.get(id) })),
        }),
      });
    }
    for (const storey of storeys) {
      const elementIds = storey.elementIds.filter((id) => elementMeta.has(id)).map((id) => `element:${id}`);
      specs.push({
        id: `storey:${storey.expressId}`,
        kind: 'relationship',
        children: elementIds,
        buildPayload: (h) => ({
          relType: 'IfcRelContainedInSpatialStructure',
          roles: [{ roleName: 'RelatedElements', refs: elementIds.map((id) => h.get(id)) }],
        }),
      });
    }
    const storeyNodeIds = storeys.map((s) => `storey:${s.expressId}`);
    specs.push({
      id: 'root',
      kind: 'layer',
      children: storeyNodeIds,
      buildPayload: (h) => ({ layerId: ROOT_LAYER_ID, childHashes: storeyNodeIds.map((id) => h.get(id)) }),
    });
    return specs;
  }

  /**
   * Materialize a COMPOSITE node's payload for the verifier's bundle.
   *
   * `ProvenanceDag` stores composites as a `buildPayload` closure, not as a
   * materialized payload, so there is nothing to read out of the engine. This
   * rebuilds the payload from the same inputs the engine used: the structure
   * fixed above plus the DAG's CURRENT child hashes. It is deliberately NOT a
   * shortcut around verification — the verifier re-derives the node's hash from
   * this payload and compares it to the certificate's claim, so if this
   * reconstruction were wrong in any byte the verification would fail.
   */
  function materializeComposite(getHash, nodeId) {
    if (nodeId === 'root') {
      return { layerId: ROOT_LAYER_ID, childHashes: storeys.map((s) => getHash(`storey:${s.expressId}`)) };
    }
    if (nodeId.startsWith('storey:')) {
      const expressId = Number(nodeId.slice('storey:'.length));
      const storey = storeys.find((s) => s.expressId === expressId);
      const elementIds = storey.elementIds.filter((id) => elementMeta.has(id)).map((id) => `element:${id}`);
      return {
        relType: 'IfcRelContainedInSpatialStructure',
        roles: [{ roleName: 'RelatedElements', refs: elementIds.map((id) => getHash(id)) }],
      };
    }
    if (nodeId.startsWith('element:')) {
      const expressId = Number(nodeId.slice('element:'.length));
      const meta = elementMeta.get(expressId);
      const { componentKeys } = elementChildren.get(expressId);
      return {
        key: meta.globalId,
        ifcType: meta.ifcType,
        components: componentKeys.map(({ id, key }) => ({ componentKey: key, hash: getHash(id) })),
      };
    }
    throw new Error(`[b45] materializeComposite: not a composite node id: "${nodeId}"`);
  }

  return {
    storeys,
    elementMeta,
    initialLeafPayloads,
    buildSpecs,
    materializeComposite,
    psetCount,
    meshLeafCount,
    elementCount,
    aggregatedElementCount,
    orphanMeshes,
    classCounts,
  };
}

async function buildDag(buildSpecs, leafPayloads) {
  const dag = new ProvenanceDag();
  for (const spec of buildSpecs(leafPayloads)) dag.addNode(spec);
  const t0 = performance.now();
  await dag.build();
  const buildMs = performance.now() - t0;
  return { dag, buildMs, totalNodes: dag.size };
}

/* ------------------------------------------------------------------ */
/* Edits                                                                */
/* ------------------------------------------------------------------ */

function applyPropertyEdit(dag, leafPayloads, elementMeta, expressId) {
  const meta = elementMeta.get(expressId);
  const target = meta.psetNodeIds[0];
  const oldPayload = leafPayloads.get(target.nodeId);
  const oldProp = oldPayload.properties[0];
  const newValue = mutatedValue(oldProp.value);
  const newPayload = {
    name: oldPayload.name,
    properties: oldPayload.properties.map((p, i) => (i === 0 ? { name: p.name, value: newValue } : p)),
  };
  leafPayloads.set(target.nodeId, newPayload);
  dag.setPayload(target.nodeId, 'property-set', newPayload);
  return {
    psetNodeId: target.nodeId,
    psetName: oldPayload.name,
    propertyName: oldProp.name,
    before: oldProp.value,
    after: newValue,
  };
}

/**
 * Move a wall 1 mm along local X: every mesh leaf of the element gets a fresh
 * positions array with `delta` added to each x. f32 storage means a delta below
 * the coordinate's ULP would silently vanish, so the resulting hash is checked
 * against the old one and the delta escalated until it actually registers —
 * a "geometry edit" whose hash did not move would make clause 3 look good for
 * the wrong reason.
 */
async function applyGeometryEdit(dag, leafPayloads, elementMeta, expressId) {
  const meta = elementMeta.get(expressId);
  const touched = [];
  for (const nodeId of meta.meshNodeIds) {
    const oldPayload = leafPayloads.get(nodeId);
    const oldHash = await computeNodeHash('geometry-mesh', oldPayload);
    let newPayload;
    let newHash = oldHash;
    for (const delta of [0.001, 0.01, 0.1, 1]) {
      const positions = Float32Array.from(oldPayload.positions);
      for (let i = 0; i < positions.length; i += 3) positions[i] += delta;
      newPayload = { ...oldPayload, positions };
      newHash = await computeNodeHash('geometry-mesh', newPayload);
      if (newHash !== oldHash) break;
    }
    if (newHash === oldHash) {
      throw new Error(`[b45] geometry edit on ${nodeId} did not change its hash even at delta=1 m`);
    }
    leafPayloads.set(nodeId, newPayload);
    dag.setPayload(nodeId, 'geometry-mesh', newPayload);
    touched.push({ nodeId, oldHash, newHash, vertices: newPayload.positions.length / 3 });
  }
  return touched;
}

/* ------------------------------------------------------------------ */
/* Bundle serialization for the second process                          */
/* ------------------------------------------------------------------ */

function b64(ta) {
  const view = ArrayBuffer.isView(ta)
    ? Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength)
    : Buffer.from(Uint8Array.from(ta).buffer);
  return view.toString('base64');
}

function serializeResolved(kind, payload) {
  if (kind !== 'geometry-mesh') return { kind, payload };
  return {
    kind,
    payload: {
      expressId: payload.expressId,
      geometryClass: payload.geometryClass,
      positions: { __ta: 'f32', b64: b64(payload.positions) },
      normals: { __ta: 'f32', b64: b64(payload.normals) },
      indices: { __ta: 'u32', b64: b64(payload.indices) },
      origin: [...payload.origin],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  log(`fixture: ${FIXTURE}`);

  const parseStart = performance.now();
  const store = await loadIfcFile(FIXTURE);
  const parseMs = performance.now() - parseStart;
  const fileSize = store.fileSize;
  log(`parsed in ${(parseMs / 1000).toFixed(1)}s — ${store.entityCount} entities, ${fileSize} bytes`);
  samplePeak();

  /* --- Mesh pass: REAL geometry, the same headless path g1 and the CLI use --- */
  const processor = new GeometryProcessor();
  await processor.init();
  const bytes =
    store.source && store.source.byteLength > 0
      ? store.source
      : new Uint8Array(readFileSync(FIXTURE));
  const meshStart = performance.now();
  const geomResult = await processor.process(bytes);
  const meshMs = performance.now() - meshStart;
  const meshes = geomResult.meshes;
  log(
    `meshed in ${(meshMs / 1000).toFixed(1)}s — ${meshes.length} MeshData entries, ` +
      `${geomResult.totalTriangles} triangles, ${geomResult.totalVertices} vertices`,
  );
  samplePeak();

  const structStart = performance.now();
  const struct = buildDagStructure(store, meshes, { expandAggregates: EXPAND_AGGREGATES });
  const structMs = performance.now() - structStart;
  log(
    `DAG structure (${EXPAND_AGGREGATES ? 'contained+aggregated' : 'contained-only (g0/g1 shape)'}) ` +
      `in ${(structMs / 1000).toFixed(1)}s — ${struct.elementCount} elements ` +
      `(${struct.aggregatedElementCount} via IfcRelAggregates), ` +
      `${struct.psetCount} property-sets, ${struct.meshLeafCount} geometry-mesh leaves, ` +
      `${struct.storeys.length} storeys; excluded class-2 templates=${struct.classCounts[2]}, ` +
      `meshes still unattached=${struct.orphanMeshes}`,
  );
  if (struct.meshLeafCount === 0) {
    throw new Error('[b45] no geometry-mesh leaves in the DAG — the mesh-bearing clause is unmeetable');
  }
  samplePeak();

  /* --- Probe mode: extrapolate the mesh-hash cost and stop. --- */
  if (PROBE) {
    const meshNodeIds = [...struct.initialLeafPayloads.keys()].filter((id) => id.startsWith('mesh:'));
    const sampleIds = meshNodeIds.filter((_, i) => i % Math.max(1, Math.floor(meshNodeIds.length / 300)) === 0);
    let sampleFloats = 0;
    const t0 = performance.now();
    for (const id of sampleIds) {
      const p = struct.initialLeafPayloads.get(id);
      sampleFloats += p.positions.length + p.normals.length + p.indices.length;
      await computeNodeHash('geometry-mesh', p);
    }
    const sampleMs = performance.now() - t0;
    let totalFloats = 0;
    for (const id of meshNodeIds) {
      const p = struct.initialLeafPayloads.get(id);
      totalFloats += p.positions.length + p.normals.length + p.indices.length;
    }
    const estimateMs = sampleFloats > 0 ? (sampleMs / sampleFloats) * totalFloats : 0;
    log(
      `PROBE: sampled ${sampleIds.length}/${meshNodeIds.length} mesh leaves ` +
        `(${sampleFloats} of ${totalFloats} scalars) in ${sampleMs.toFixed(0)}ms ` +
        `-> extrapolated full mesh-leaf hash pass ≈ ${(estimateMs / 1000).toFixed(0)}s`,
    );
    console.log(
      JSON.stringify({
        probe: true,
        entities: store.entityCount,
        fileSize,
        meshDataEntries: meshes.length,
        triangles: geomResult.totalTriangles,
        meshLeaves: struct.meshLeafCount,
        propertySets: struct.psetCount,
        elements: struct.elementCount,
        storeys: struct.storeys.length,
        totalMeshScalars: totalFloats,
        estimatedMeshHashSeconds: Number((estimateMs / 1000).toFixed(1)),
        parseSeconds: Number((parseMs / 1000).toFixed(1)),
        meshSeconds: Number((meshMs / 1000).toFixed(1)),
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
    // The probe writes no bundles, so the per-run directory it never used must
    // not be left behind: one empty `mkdtemp` per probe invocation is a leak
    // the single fixed directory did not have.
    if (!process.env.B45_OUT && process.env.B45_KEEP_BUNDLES !== '1') {
      rmSync(OUT_DIR, { recursive: true, force: true });
    }
    return;
  }

  /* --- Full DAG build, both planes --- */
  const leafPayloads = new Map(struct.initialLeafPayloads);
  log('building + hashing the full DAG (this is the expensive, one-time construction cost)…');
  const { dag, buildMs, totalNodes } = await buildDag(struct.buildSpecs, leafPayloads);
  log(`full DAG built + hashed: ${totalNodes} nodes in ${(buildMs / 1000).toFixed(1)}s`);
  samplePeak();

  /* --- Pick the walls ---
   * Exam B deliberately takes the HEAVIEST wall in the model (most mesh
   * vertices across its geometry-mesh leaves), not the first one found. A
   * first-found wall on this fixture has a single 24-vertex mesh leaf, and a
   * certificate over 24 vertices would make clause 1 (< 500 ms) look good for
   * a reason that has nothing to do with geometry being present. The verifier
   * should have to re-derive the largest mesh payload a wall edit can produce
   * here.
   * Exam A keeps g1's rule (first wall with a populated pset) because a
   * property-only edit's cost does not depend on the wall's size. */
  let propOnlyTarget;
  let geomTarget;
  let geomTargetVertices = -1;
  for (const [expressId, meta] of struct.elementMeta) {
    if (!/^IfcWall/i.test(meta.ifcType)) continue;
    const hasPset =
      meta.psetNodeIds.length > 0 && leafPayloads.get(meta.psetNodeIds[0].nodeId).properties.length > 0;
    if (!hasPset) continue;
    if (propOnlyTarget === undefined) propOnlyTarget = expressId;
    if (meta.meshNodeIds.length > 0) {
      let vertices = 0;
      for (const id of meta.meshNodeIds) vertices += leafPayloads.get(id).positions.length / 3;
      if (vertices > geomTargetVertices) {
        geomTargetVertices = vertices;
        geomTarget = expressId;
      }
    }
  }
  if (propOnlyTarget === undefined) throw new Error('[b45] no IfcWall-like element with a populated pset');
  if (geomTarget === undefined) {
    throw new Error('[b45] no IfcWall-like element that has BOTH a populated pset and a geometry-mesh leaf');
  }
  if (propOnlyTarget === geomTarget) {
    // Keep the two exams on distinct walls so the second one starts from a
    // clean (non-dirty) DAG that the first did not already touch.
    for (const [expressId, meta] of struct.elementMeta) {
      if (expressId === geomTarget) continue;
      if (!/^IfcWall/i.test(meta.ifcType)) continue;
      if (meta.psetNodeIds.length === 0) continue;
      if (leafPayloads.get(meta.psetNodeIds[0].nodeId).properties.length === 0) continue;
      propOnlyTarget = expressId;
      break;
    }
  }
  log(
    `wall selection: exam A element ${propOnlyTarget}; exam B element ${geomTarget} ` +
      `(heaviest wall: ${geomTargetVertices} vertices across ` +
      `${struct.elementMeta.get(geomTarget).meshNodeIds.length} mesh leaves)`,
  );

  /* --- Exam A: property-only single-wall edit (g1's exam shape) --- */
  const metaA = struct.elementMeta.get(propOnlyTarget);
  const editA = applyPropertyEdit(dag, leafPayloads, struct.elementMeta, propOnlyTarget);
  const telemetryA = await dag.recompute();
  log(
    `EXAM A property-only wall edit — element ${propOnlyTarget} (${metaA.ifcType}), ` +
      `${editA.psetName}.${editA.propertyName}: recomputed=${telemetryA.recomputed} ` +
      `cacheHits=${telemetryA.cacheHits} hitRate=${(telemetryA.hitRate * 100).toFixed(4)}% ` +
      `in ${telemetryA.elapsedMs.toFixed(1)}ms`,
  );

  /* --- Exam B: property + GEOMETRY single-wall edit (the headline) --- */
  const metaB = struct.elementMeta.get(geomTarget);
  const editBProp = applyPropertyEdit(dag, leafPayloads, struct.elementMeta, geomTarget);
  const touchedMeshes = await applyGeometryEdit(dag, leafPayloads, struct.elementMeta, geomTarget);
  const telemetryB = await dag.recompute();
  log(
    `EXAM B property+geometry wall edit — element ${geomTarget} (${metaB.ifcType}, ${metaB.globalId}), ` +
      `${touchedMeshes.length} mesh leaves moved 1mm ` +
      `(${touchedMeshes.reduce((n, m) => n + m.vertices, 0)} vertices): ` +
      `recomputed=${telemetryB.recomputed} cacheHits=${telemetryB.cacheHits} ` +
      `hitRate=${(telemetryB.hitRate * 100).toFixed(4)}% in ${telemetryB.elapsedMs.toFixed(1)}ms`,
  );
  samplePeak();

  /* --- Certificate for exam B --- */
  // `writes` is exactly the set the engine recomputed for this edit — the
  // edited leaves plus every ancestor up to root. Taking it from the telemetry
  // rather than hand-listing a pset/element/storey/root path (as g0 did) keeps
  // it correct for any DAG depth, including the aggregated curtain-wall
  // sub-elements this shape adds.
  const writes = telemetryB.recomputedNodeIds.map((id) => ({ nodeId: id, hash: dag.getHash(id) }));
  const meshWriteRefs = writes.filter((w) => w.nodeId.startsWith('mesh:'));
  const reads = metaB.psetNodeIds
    .filter((p) => p.nodeId !== editBProp.psetNodeId)
    .map((p) => ({ nodeId: p.nodeId, hash: dag.getHash(p.nodeId) }));
  const untouchedStoreyRefs = struct.storeys
    .filter((s) => s.expressId !== metaB.storeyId)
    .map((s) => ({ nodeId: `storey:${s.expressId}`, hash: dag.getHash(`storey:${s.expressId}`) }));

  const certificate = createCertificate({
    kernelVersion: KERNEL_VERSION,
    trustRoot: TRUST_ROOT,
    reads,
    writes,
    claims: [{ type: 'subtree-untouched', nodes: untouchedStoreyRefs }],
  });
  log(
    `certificate: ${writes.length} writes (${meshWriteRefs.length} of them geometry-mesh), ` +
      `${reads.length} reads, ${untouchedStoreyRefs.length} subtree-untouched storey refs`,
  );

  /* --- Bundle: exactly the payloads the verifier's resolver will ask for --- */
  const bundleNodeIds = new Set([
    ...writes.map((r) => r.nodeId),
    ...reads.map((r) => r.nodeId),
    ...untouchedStoreyRefs.map((r) => r.nodeId),
  ]);
  const nodes = {};
  const getHash = (nodeId) => dag.getHash(nodeId);
  for (const id of bundleNodeIds) {
    const kind = dag.getKind(id);
    const payload =
      id.startsWith('mesh:') || id.startsWith('pset:')
        ? leafPayloads.get(id)
        : struct.materializeComposite(getHash, id);
    nodes[id] = serializeResolved(kind, payload);
  }
  // NOTE the absence of `expectedTrustRoot`/`expectedKernelVersion`. The pin the
  // verifier checks against is the verifier's own configuration (passed through
  // the environment below), never a field of the artifact it is checking — see
  // verify-worker.mjs's header for the forged bundle that motivated this.
  const bundle = { certificate, nodes };
  const bundlePath = path.join(OUT_DIR, 'bundle.json');
  const bundleJson = JSON.stringify(bundle);
  writeFileSync(bundlePath, bundleJson);
  log(`bundle written: ${bundlePath} (${(bundleJson.length / 1e6).toFixed(2)} MB, ${bundleNodeIds.size} payloads)`);

  /* --- Verify in a SECOND PROCESS --- */
  const workerPath = path.join(__dirname, 'verify-worker.mjs');
  /**
   * Spawn the verifier on `pathToBundle`.
   *
   * `expectPayloads` is the number of payloads THIS runner put in that bundle.
   * When it is given, an `ok` verdict that resolved a different number of
   * distinct nodes is an error rather than a measurement, because it can only
   * mean the file at that path is not the file this run wrote. That is not
   * hypothetical arithmetic: every bundle this bet produces is signed by the
   * same TRUST_ROOT/KERNEL_VERSION pair, so a bundle from ANOTHER run of this
   * script verifies `ok: true` here -- measured, an AC20-FZK-Haus bundle
   * returns `ok: true, nodesResolved: 8` against the duplex run's 22 -- and
   * clauses 1 and 2 would then be reported over someone else's model with this
   * run's denominator. The anchor cannot catch that (it is a genuine bundle,
   * just not this one); the payload count can.
   */
  function verifyInSecondProcess(pathToBundle, expectPayloads = null) {
    const t0 = performance.now();
    const res = spawnSync(process.execPath, [workerPath, pathToBundle], {
      encoding: 'utf-8',
      // The trust anchor travels here and nowhere else: the verifier's pin has
      // to come from the party doing the verifying, not from the artifact.
      env: {
        ...process.env,
        B45_EXPECT_TRUST_ROOT: TRUST_ROOT,
        B45_EXPECT_KERNEL_VERSION: KERNEL_VERSION,
      },
    });
    const processWallMs = performance.now() - t0;
    if (res.status !== 0) {
      throw new Error(`[b45] verify-worker exited ${res.status}: ${res.stderr}`);
    }
    const verdict = { ...JSON.parse(res.stdout.trim()), processWallMs };
    if (expectPayloads !== null && verdict.ok && verdict.uniqueNodesResolved !== expectPayloads) {
      throw new Error(
        `[b45] the verifier resolved ${verdict.uniqueNodesResolved} distinct nodes from ` +
          `${pathToBundle}, but this run wrote ${expectPayloads} payloads into it. A verified ` +
          'bundle that is not the one this run produced makes every figure below an attribution ' +
          'error, so it is an abort rather than a number.',
      );
    }
    return verdict;
  }

  const warm = verifyInSecondProcess(bundlePath, bundleNodeIds.size);
  if (!warm.ok) throw new Error(`[b45] warm-up second-process verify FAILED: ${warm.reason}`);
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(verifyInSecondProcess(bundlePath, bundleNodeIds.size));
  for (const r of runs) {
    if (!r.ok) throw new Error(`[b45] second-process verify FAILED: ${r.reason}`);
  }
  const verifyMedianMs = median(runs.map((r) => r.verifyMs));
  const processWallMedianMs = median(runs.map((r) => r.processWallMs));
  const bundleParseMedianMs = median(runs.map((r) => r.bundleParseMs));
  const nodesResolved = runs[0].nodesResolved;
  const uniqueNodesResolved = runs[0].uniqueNodesResolved;
  log(
    `second-process verify: ok=true, verifyMs=[${runs.map((r) => r.verifyMs.toFixed(2)).join(', ')}] ` +
      `median=${verifyMedianMs.toFixed(2)}ms; bundleParse median=${bundleParseMedianMs.toFixed(2)}ms; ` +
      `whole-process wall median=${processWallMedianMs.toFixed(1)}ms; ` +
      `nodesResolved=${nodesResolved} (unique ${uniqueNodesResolved}) of ${totalNodes}`,
  );

  /* --- Sensitivity probe (NOT the exam) ---------------------------------
   * Clauses 1 and 2 are not properties of the DAG, they are properties of the
   * CLAIM. g0 chose `subtree-untouched` at STOREY granularity, so a single-wall
   * edit resolves O(storeys) nodes — 60 of 250,582 here — no matter how many
   * mesh leaves exist. Adding 109,632 mesh leaves therefore cannot move clause
   * 2, and mostly cannot move clause 1 either.
   *
   * This probe re-cuts the SAME edit with the same writes/reads but claims
   * `subtree-untouched` at ELEMENT granularity over every element node the
   * edit did not recompute — the strictly stronger claim a suspicious
   * counterparty might actually demand ("prove element by element that nothing
   * else moved"). It is reported so the headline is read for what it is.
   * -------------------------------------------------------------------- */
  let sensitivity = null;
  {
    const recomputedSet = new Set(telemetryB.recomputedNodeIds);
    const elementRefs = [];
    for (const expressId of struct.elementMeta.keys()) {
      const id = `element:${expressId}`;
      if (recomputedSet.has(id)) continue;
      elementRefs.push({ nodeId: id, hash: dag.getHash(id) });
    }
    const cert2 = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads,
      writes,
      claims: [{ type: 'subtree-untouched', nodes: elementRefs }],
    });
    const nodes2 = {};
    for (const r of [...writes, ...reads, ...elementRefs]) {
      if (nodes2[r.nodeId]) continue;
      const kind = dag.getKind(r.nodeId);
      const payload =
        r.nodeId.startsWith('mesh:') || r.nodeId.startsWith('pset:')
          ? leafPayloads.get(r.nodeId)
          : struct.materializeComposite(getHash, r.nodeId);
      nodes2[r.nodeId] = serializeResolved(kind, payload);
    }
    const p2 = path.join(OUT_DIR, 'bundle.sensitivity-element-granular.json');
    const json2 = JSON.stringify({ certificate: cert2, nodes: nodes2 });
    writeFileSync(p2, json2);
    const r2 = verifyInSecondProcess(p2, Object.keys(nodes2).length);
    if (!r2.ok) throw new Error(`[b45] sensitivity-probe verify FAILED: ${r2.reason}`);
    const pct2 = (r2.nodesResolved / totalNodes) * 100;
    sensitivity = {
      claimGranularity: 'element',
      claimNodes: elementRefs.length,
      nodesResolved: r2.nodesResolved,
      nodesResolvedPct: Number(pct2.toFixed(4)),
      verifyMs: Number(r2.verifyMs.toFixed(1)),
      bundleBytes: json2.length,
      wouldPassClause1: r2.verifyMs < 500,
      wouldPassClause2: pct2 < 5,
    };
    log(
      `SENSITIVITY (not the exam) element-granularity claim: resolved ${r2.nodesResolved} nodes ` +
        `(${pct2.toFixed(2)}%) in ${r2.verifyMs.toFixed(1)}ms from a ${(json2.length / 1e6).toFixed(1)}MB bundle ` +
        `-> clause1 ${sensitivity.wouldPassClause1 ? 'PASS' : 'FAIL'}, clause2 ${sensitivity.wouldPassClause2 ? 'PASS' : 'FAIL'}`,
    );
  }

  /* --- Tamper battery, also in the second process ------------------------
   * Every case records `altered`: the byte-level evidence that the case
   * actually changed the bundle. A tamper test that mutates nothing is a check
   * that passes without exercising anything, which is the same defect class as
   * a verifier reading its trust anchor out of the artifact — a green cell
   * carrying no information. `caught && altered` is what the scorecard means.
   * -------------------------------------------------------------------- */
  const tamperResults = [];
  {
    // (a) flip one float inside a bundled geometry-mesh payload.
    const meshId = meshWriteRefs[0]?.nodeId;
    if (meshId) {
      const t = JSON.parse(bundleJson);
      const enc = t.nodes[meshId].payload.positions;
      const before = enc.b64;
      const buf = Buffer.from(before, 'base64');
      // An empty positions blob would leave `buf[0] ^= 0xff` a no-op and the
      // case would "pass" having flipped nothing.
      if (buf.byteLength > 0) {
        buf[0] ^= 0xff;
        enc.b64 = buf.toString('base64');
        const p = path.join(OUT_DIR, 'bundle.tamper-mesh.json');
        writeFileSync(p, JSON.stringify(t));
        const r = verifyInSecondProcess(p);
        tamperResults.push({
          case: 'geometry-mesh-float-flip',
          caught: r.ok === false,
          altered: enc.b64 !== before,
          reason: r.reason,
        });
        log(`tamper (mesh float flip): ok=${r.ok} reason=${r.reason ?? '-'}`);
      } else {
        log('tamper (mesh float flip): SKIPPED — the bundled mesh carries no positions bytes');
      }
    }
  }
  {
    // (b) flip one property value inside a bundled untouched-storey subtree —
    // the storey relationship node's own payload is a list of element hashes,
    // so tamper the hash list directly (the equivalent of an element under that
    // storey having silently changed).
    //
    // The storey has to be one that HAS a child hash to flip. Taking
    // `untouchedStoreyRefs[0]` unconditionally reads `roles[0].refs` of whatever
    // happens to be first, and an empty storey (no contained elements, which
    // Holter does not have but another fixture will) would throw, or flip
    // nothing and record a vacuous pass.
    const t = JSON.parse(bundleJson);
    const storeyId = untouchedStoreyRefs
      .map((r) => r.nodeId)
      .find((id) => (t.nodes[id]?.payload?.roles?.[0]?.refs ?? []).length > 0);
    if (storeyId) {
      const refs = t.nodes[storeyId].payload.roles[0].refs;
      const before = refs[0];
      refs[0] = `${before.slice(0, -1)}${before.slice(-1) === '0' ? '1' : '0'}`;
      const p = path.join(OUT_DIR, 'bundle.tamper-storey.json');
      writeFileSync(p, JSON.stringify(t));
      const r = verifyInSecondProcess(p);
      tamperResults.push({
        case: 'untouched-storey-child-hash-flip',
        caught: r.ok === false,
        altered: refs[0] !== before,
        reason: r.reason,
      });
      log(`tamper (untouched storey child-hash flip): ok=${r.ok} reason=${r.reason ?? '-'}`);
    } else {
      log('tamper (untouched storey child-hash flip): SKIPPED — no untouched storey carries a child hash');
    }
  }
  {
    // (c) the forgery the trust-anchor fix exists for. Tamper a child hash under
    // an untouched storey AND re-derive the claim's own hash so the certificate
    // is internally consistent with the lie, then stamp an attacker-chosen
    // trustRoot/kernelVersion on the certificate and ship the matching
    // `expected*` fields the old worker pinned against. Against a verifier that
    // reads its anchor from the bundle this returned `ok: true` with all 60
    // nodes resolved — indistinguishable from the genuine bundle. It is in the
    // battery so it can never quietly become true again.
    const t = JSON.parse(bundleJson);
    const claim = t.certificate.claims.find((c) => c.type === 'subtree-untouched');
    const ref = claim?.nodes.find((n) => (t.nodes[n.nodeId]?.payload?.roles?.[0]?.refs ?? []).length > 0);
    if (ref) {
      const refs = t.nodes[ref.nodeId].payload.roles[0].refs;
      const beforeRef = refs[0];
      const beforeHash = ref.hash;
      refs[0] = `${beforeRef.slice(0, -1)}${beforeRef.slice(-1) === '0' ? '1' : '0'}`;
      ref.hash = await hashResolvedNode(t.nodes[ref.nodeId]);
      t.certificate.trustRoot = 'attacker-forged-trust-root-v0';
      t.certificate.kernelVersion = 'attacker-forged-kernel-v0';
      t.expectedTrustRoot = t.certificate.trustRoot;
      t.expectedKernelVersion = t.certificate.kernelVersion;
      const p = path.join(OUT_DIR, 'bundle.forged-trust-anchor.json');
      writeFileSync(p, JSON.stringify(t));
      const r = verifyInSecondProcess(p);
      tamperResults.push({
        case: 'forged-trust-anchor-with-rederived-claim-hash',
        caught: r.ok === false,
        altered: refs[0] !== beforeRef && ref.hash !== beforeHash,
        reason: r.reason,
      });
      log(`tamper (forged trust anchor + re-derived claim hash): ok=${r.ok} reason=${r.reason ?? '-'}`);
    } else {
      log('tamper (forged trust anchor): SKIPPED — no claimed storey carries a child hash');
    }
  }
  // WHY THE REASON IS ASSERTED AND NOT JUST THE CATCH. "Caught" is not the
  // property any of these cases is under test for; each one exists to prove a
  // SPECIFIC check fires, and caught-for-the-wrong-reason would pass a
  // catch-only assertion while the check it was written for had quietly
  // stopped working. The forged-anchor case is where that is not hypothetical:
  // it flips a child hash AND re-derives the claim hash so the certificate
  // agrees with the lie, and the whole point is that the ANCHOR rejects it. If
  // the re-derivation ever broke, the case would come back caught on
  // `hash-mismatch` — green, and testing nothing it was written to test.
  // Declared here rather than pushed into the entries so the scorecard's shape
  // is unchanged; each entry already records the `reason` a reader can check
  // this against.
  const MUST_REJECT_WITH = {
    'geometry-mesh-float-flip': 'hash-mismatch',
    'untouched-storey-child-hash-flip': 'hash-mismatch',
    'forged-trust-anchor-with-rederived-claim-hash': 'bundle-carries-trust-anchor',
  };
  const tamperAllCaught =
    tamperResults.length > 0 &&
    tamperResults.every((t) => t.caught && t.altered && t.reason === MUST_REJECT_WITH[t.case]);
  if (!tamperAllCaught) {
    throw new Error(
      `[b45] tamper battery did not hold: ${JSON.stringify(tamperResults)} — expected rejection ` +
        `reasons ${JSON.stringify(MUST_REJECT_WITH)}. A case that was not caught, that altered ` +
        'nothing, or that was caught for a different reason than the one it was written to prove ' +
        'means the verdict below is not evidence of anything.',
    );
  }

  /* --- Correctness cross-check --- */
  let correctnessCrossCheck = null;
  let crossCheckMs = null;
  if (process.env.B45_SKIP_CROSSCHECK !== '1') {
    log('cross-check: rebuilding the whole DAG from scratch over the FINAL payload state…');
    const t0 = performance.now();
    const { dag: freshDag } = await buildDag(struct.buildSpecs, leafPayloads);
    crossCheckMs = performance.now() - t0;
    const a = dag.snapshot();
    const b = freshDag.snapshot();
    correctnessCrossCheck = a.size === b.size;
    if (correctnessCrossCheck) {
      for (const [id, hash] of a) {
        if (b.get(id) !== hash) {
          correctnessCrossCheck = false;
          log(`MISMATCH at "${id}": incremental=${hash} fresh=${b.get(id)}`);
          break;
        }
      }
    }
    correctnessCrossCheck = correctnessCrossCheck && dag.getHash('root') === freshDag.getHash('root');
    log(`cross-check: ${correctnessCrossCheck ? 'PASS' : 'FAIL'} (rebuild took ${(crossCheckMs / 1000).toFixed(1)}s)`);
  } else {
    log('cross-check SKIPPED (B45_SKIP_CROSSCHECK=1)');
  }
  samplePeak();

  /* --- Scorecard --- */
  const nodesResolvedPct = (nodesResolved / totalNodes) * 100;
  const dataPlaneNodes = totalNodes - struct.meshLeafCount;
  const nodesResolvedPctDataPlaneDenominator = (nodesResolved / dataPlaneNodes) * 100;

  const clause1 = verifyMedianMs < 500;
  const clause2 = nodesResolvedPct < 5;
  const clause3 = telemetryB.hitRate > 0.9 && telemetryA.hitRate > 0.9;
  const meshLeavesPresent = struct.meshLeafCount > 0 && touchedMeshes.length > 0;
  // The cross-check is a stated correctness invariant of this bet, so it belongs
  // in the verdict, not beside it. It was only recorded: forcing a divergence
  // (corrupting one pset payload before the from-scratch rebuild) produced
  // `correctnessCrossCheck: false` next to `verdict: "PASS"` and exit code 0 --
  // an incremental DAG that no longer agrees with a rebuild, published as a
  // pass. `!== false` and not `=== true` because B45_SKIP_CROSSCHECK=1 leaves it
  // null: an explicit opt-out the artifact still records, rather than a failure.
  const crossCheckHeld = correctnessCrossCheck !== false;

  const scorecard = {
    bet: 'B4.5',
    exam: 'M1 midterm as literally worded, one run, mesh leaves present',
    fixture: path.relative(REPO_ROOT, FIXTURE),
    fixtureBytes: fileSize,
    entities: store.entityCount,
    dagShape: EXPAND_AGGREGATES ? 'contained+aggregated' : 'contained-only (g0/g1 shape)',

    nodesTotal: totalNodes,
    nodesMeshLeaves: struct.meshLeafCount,
    nodesPropertySetLeaves: struct.psetCount,
    nodesElements: struct.elementCount,
    nodesElementsViaAggregates: struct.aggregatedElementCount,
    nodesStoreys: struct.storeys.length,
    meshDataEntries: meshes.length,
    meshDataExcludedClass2: struct.classCounts[2],
    meshDataUnattached: struct.orphanMeshes,
    triangles: geomResult.totalTriangles,
    vertices: geomResult.totalVertices,

    nodesResolvedDuringVerify: nodesResolved,
    uniqueNodesResolvedDuringVerify: uniqueNodesResolved,
    nodesResolvedPct: Number(nodesResolvedPct.toFixed(6)),
    nodesResolvedPctIfMeshLeavesExcludedFromDenominator: Number(
      nodesResolvedPctDataPlaneDenominator.toFixed(6),
    ),

    verifyMedianMs: Number(verifyMedianMs.toFixed(3)),
    verifyAllMs: runs.map((r) => Number(r.verifyMs.toFixed(3))),
    verifyBundleParseMedianMs: Number(bundleParseMedianMs.toFixed(3)),
    verifyWholeProcessWallMedianMs: Number(processWallMedianMs.toFixed(1)),
    verifierMaxRssBytes: runs[0].maxRssBytes,
    bundleBytes: bundleJson.length,

    examA_propertyOnlyWallEdit: {
      element: propOnlyTarget,
      ifcType: metaA.ifcType,
      recomputed: telemetryA.recomputed,
      cacheHits: telemetryA.cacheHits,
      hitRate: Number(telemetryA.hitRate.toFixed(8)),
      recomputeMs: Number(telemetryA.elapsedMs.toFixed(3)),
    },
    examB_propertyPlusGeometryWallEdit: {
      element: geomTarget,
      ifcType: metaB.ifcType,
      globalId: metaB.globalId,
      meshLeavesEdited: touchedMeshes.length,
      verticesMoved: touchedMeshes.reduce((n, m) => n + m.vertices, 0),
      recomputed: telemetryB.recomputed,
      cacheHits: telemetryB.cacheHits,
      hitRate: Number(telemetryB.hitRate.toFixed(8)),
      recomputeMs: Number(telemetryB.elapsedMs.toFixed(3)),
    },

    parseMs: Number(parseMs.toFixed(0)),
    meshMs: Number(meshMs.toFixed(0)),
    dagStructureMs: Number(structMs.toFixed(0)),
    dagBuildMs: Number(buildMs.toFixed(0)),
    crossCheckRebuildMs: crossCheckMs === null ? null : Number(crossCheckMs.toFixed(0)),
    correctnessCrossCheck,
    tamper: tamperResults,
    sensitivityElementGranularityClaim: sensitivity,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,

    clause1_verifyUnder500msInSecondProcess: clause1,
    clause2_under5PctOfDagNodesResolved: clause2,
    clause3_over90PctCacheHitsOnSingleWallRecompute: clause3,
    meshLeavesGenuinelyPresent: meshLeavesPresent,
    verdict: clause1 && clause2 && clause3 && meshLeavesPresent && crossCheckHeld ? 'PASS' : 'FAIL',
  };

  mkdirSync(path.dirname(SCORECARD_PATH), { recursive: true });
  writeFileSync(SCORECARD_PATH, `${JSON.stringify(scorecard, null, 2)}\n`);
  // Removing the working directory must never remove the run's own result.
  // `--scorecard-out $B45_OUT/scorecard.json` is a perfectly natural thing to
  // type, and the unconditional rmSync deleted the file it had just written.
  const scorecardRel = path.relative(OUT_DIR, SCORECARD_PATH);
  const scorecardInsideOutDir =
    scorecardRel === '' || (!scorecardRel.startsWith('..') && !path.isAbsolute(scorecardRel));
  if (process.env.B45_KEEP_BUNDLES === '1') {
    log(`working bundles kept in ${OUT_DIR} (B45_KEEP_BUNDLES=1)`);
  } else if (scorecardInsideOutDir) {
    log(`working bundles kept in ${OUT_DIR}: the scorecard was written inside it`);
  } else {
    rmSync(OUT_DIR, { recursive: true, force: true });
  }
  console.log(JSON.stringify(scorecard));

  log(`CLAUSE 1 (second-process verify < 500 ms):        ${clause1 ? 'PASS' : 'FAIL'} (${verifyMedianMs.toFixed(2)} ms)`);
  log(`CLAUSE 2 (< 5% of DAG nodes resolved):            ${clause2 ? 'PASS' : 'FAIL'} (${nodesResolvedPct.toFixed(4)}%)`);
  log(`CLAUSE 3 (> 90% cache hits, single-wall):         ${clause3 ? 'PASS' : 'FAIL'} (A ${(telemetryA.hitRate * 100).toFixed(4)}%, B ${(telemetryB.hitRate * 100).toFixed(4)}%)`);
  log(`MESH LEAVES PRESENT:                              ${meshLeavesPresent ? 'YES' : 'NO'} (${struct.meshLeafCount} leaves, ${touchedMeshes.length} edited)`);
  log(
    `FROM-SCRATCH CROSS-CHECK:                         ${
      correctnessCrossCheck === null ? 'SKIPPED (B45_SKIP_CROSSCHECK=1)' : correctnessCrossCheck ? 'PASS' : 'FAIL'
    }`,
  );
  log(`VERDICT: ${scorecard.verdict}`);
  if (SCORECARD_PATH === COMMITTED_SCORECARD) {
    log(`scorecard RE-BLESSED in place: ${path.relative(REPO_ROOT, SCORECARD_PATH)}`);
    log('Re-transcribe REPORT.md against it and re-run scripts/moonshot/ci/check-report-numerals.mjs.');
  } else {
    log(`scorecard written to ${SCORECARD_PATH}`);
    log(`committed source of truth left untouched: ${path.relative(REPO_ROOT, COMMITTED_SCORECARD)}`);
    log('Re-bless it deliberately with --write-scorecard.');
  }

  // Thrown AFTER the scorecard is written, so the failing run still leaves the
  // artifact that records why it failed -- but the process must not exit 0. The
  // tamper battery aborts earlier and writes nothing; this one has a verdict
  // worth keeping.
  if (correctnessCrossCheck === false) {
    throw new Error(
      '[b45] the from-scratch cross-check FAILED: the incrementally recomputed DAG does not ' +
        'agree with a rebuild over the same final payload state. Every clause above is measured ' +
        'against a DAG that is wrong, so the verdict is FAIL and this run is not evidence.',
    );
  }
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
