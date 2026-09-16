#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * ifc-lite side of the cost differential parity pair. Reads an IFC file
 * through the shipped `@ifc-lite/parser` cost read model
 * (`extractCostOnDemand`, via `@ifc-lite/sdk`'s `createCostBackend`) and
 * emits the shared canonical cost schema documented in `compare.py`'s "Cost
 * differential parity" section.
 *
 * This dumper does NOT read or adapt IfcOpenShell source: it only calls our
 * own already-tested read model (packages/parser/src/cost-extractor.ts,
 * merged under #4863) and re-shapes its output into the canonical schema.
 *
 * Usage: node dump_ifclite_cost.mjs <model.ifc> --out <dump.json>
 */

import { readFile, writeFile } from 'node:fs/promises';

// tools/ifcopenshell_reference is intentionally NOT a pnpm workspace member
// (see README.md) — import the built packages by relative dist path rather
// than package name.
const { IfcParser } = await import('../../packages/parser/dist/index.js');
const { createCostBackend } = await import('../../packages/sdk/dist/index.js');

function parseArgs(argv) {
  const positional = [];
  let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { out = argv[++i]; continue; }
    positional.push(argv[i]);
  }
  if (positional.length !== 1 || !out) {
    throw new Error('Usage: node dump_ifclite_cost.mjs <model.ifc> --out <dump.json>');
  }
  return { input: positional[0], out };
}

/** Parse an IFCMONETARYMEASURE/IFCRATIOMEASURE/etc. STEP-literal numeric string ("5.", "0.1") to a number. */
function parseNumericLiteral(value) {
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Deterministic, engine-independent node registry. A "node" is a
 * IfcCostValue / IfcAppliedValue / IfcQuantity* / unit-basis reached from a
 * canonical traversal (items sorted by GlobalId, then their CostValues /
 * CostQuantities / Components / UnitBasis in IFC ordered-attribute order —
 * both dumpers see the same file so this order is identical on both sides).
 *
 * The first path that reaches a given underlying entity registers it; every
 * later path that reaches the SAME underlying entity (by this engine's own
 * internal id — expressId here) records only `{ SharedWith: firstPath }`
 * instead of duplicating the body. This is how shared-reference identity
 * (e.g. two IfcCostItems both pointing at the same IfcCostValue) survives
 * the dump without relying on express ids being stable across engines: only
 * the PATH strings (derived from GlobalId + ordered-list position) are
 * compared across engines, never express ids.
 */
class NodeRegistry {
  constructor(graph) {
    this.graph = graph;
    this.byExpressId = new Map(); // expressId -> first path
    this.nodes = {}; // path -> node body (or { SharedWith })
    this.valueByExpressId = new Map(graph.CostValues.map(v => [v.ref.expressId, v]));
    this.quantityByExpressId = new Map(graph.CostQuantities.map(v => [v.ref.expressId, v]));
    this.unitByExpressId = new Map(graph.Units.map(v => [v.ref.expressId, v]));
  }

  registerValue(path, expressId) {
    const seen = this.byExpressId.get(expressId);
    if (seen !== undefined) {
      this.nodes[path] = { SharedWith: seen };
      return path;
    }
    this.byExpressId.set(expressId, path);
    const value = this.valueByExpressId.get(expressId);
    if (!value) {
      this.nodes[path] = { Kind: 'Value', Missing: true };
      return path;
    }
    const applied = value.AppliedValue
      ? value.AppliedValue.Kind === 'Typed'
        ? { Kind: 'Typed', Type: value.AppliedValue.Type, Value: parseNumericLiteral(value.AppliedValue.Value) ?? null }
        : value.AppliedValue.Kind === 'Reference'
          ? { Kind: 'Reference', Node: this.registerValue(`${path}/ref`, value.AppliedValue.ref.expressId) }
          : { Kind: 'Unsupported' }
      : null;
    const components = value.Components
      ? value.Components.map((ref, idx) => this.registerValue(`${path}/component/${idx}`, ref.expressId))
      : null;
    const unitBasis = value.UnitBasis
      ? this.registerUnit(`${path}/unitBasis`, value.UnitBasis.expressId)
      : null;
    this.nodes[path] = {
      Kind: 'Value',
      Type: value.Type ?? null,
      Name: value.Name ?? null,
      Category: value.Category ?? value.CostType ?? null,
      Condition: value.Condition ?? null,
      ArithmeticOperator: value.ArithmeticOperator ?? null,
      Applied: applied,
      Components: components,
      UnitBasisNode: unitBasis,
      Resolved: resolveNode(this.nodes, path, applied, value.ArithmeticOperator, components),
    };
    return path;
  }

  registerQuantity(path, expressId) {
    const seen = this.byExpressId.get(expressId);
    if (seen !== undefined) { this.nodes[path] = { SharedWith: seen }; return path; }
    this.byExpressId.set(expressId, path);
    const q = this.quantityByExpressId.get(expressId);
    if (!q) { this.nodes[path] = { Kind: 'Quantity', Missing: true }; return path; }
    const value = q.LengthValue ?? q.AreaValue ?? q.VolumeValue ?? q.CountValue
      ?? q.WeightValue ?? q.TimeValue ?? q.NumberValue;
    this.nodes[path] = {
      Kind: 'Quantity',
      Type: q.Type ?? null,
      Name: q.Name ?? null,
      Dimension: q.Dimension ?? null,
      Value: parseNumericLiteral(value) ?? null,
    };
    return path;
  }

  registerUnit(path, expressId) {
    const seen = this.byExpressId.get(expressId);
    if (seen !== undefined) { this.nodes[path] = { SharedWith: seen }; return path; }
    this.byExpressId.set(expressId, path);
    const u = this.unitByExpressId.get(expressId);
    if (!u) { this.nodes[path] = { Kind: 'Unit', Missing: true }; return path; }
    this.nodes[path] = {
      Kind: 'Unit',
      Type: u.Type ?? null,
      UnitType: u.UnitType ?? null,
      Currency: u.Currency ?? null,
      Symbol: u.Symbol ?? null,
      Dimension: u.Dimension ?? null,
    };
    return path;
  }
}

/** Recursively resolve a just-registered node to a plain number, or null. Cycle-safe via `nodes` already-written bodies. */
function resolveNode(nodes, path, applied, operator, componentPaths) {
  if (applied) {
    if (applied.Kind === 'Typed') return applied.Value;
    if (applied.Kind === 'Reference') {
      const target = nodes[applied.Node];
      return target ? nodeResolved(nodes, applied.Node) : null;
    }
    return null;
  }
  if (operator && componentPaths && componentPaths.length > 0) {
    const values = componentPaths.map(p => nodeResolved(nodes, p));
    if (values.some(v => v === null || v === undefined)) return null;
    switch (operator) {
      case 'ADD': return values.reduce((a, b) => a + b, 0);
      case 'SUBTRACT': return values.slice(1).reduce((a, b) => a - b, values[0]);
      case 'MULTIPLY': return values.reduce((a, b) => a * b, 1);
      case 'DIVIDE': {
        if (values.slice(1).some(v => v === 0)) return null;
        return values.slice(1).reduce((a, b) => a / b, values[0]);
      }
      default: return null;
    }
  }
  return null;
}

function nodeResolved(nodes, path) {
  const node = nodes[path];
  if (!node) return null;
  if (node.SharedWith) return nodeResolved(nodes, node.SharedWith);
  return node.Resolved ?? null;
}

function buildCanonicalDump(graph) {
  const registry = new NodeRegistry(graph);
  const itemsByGlobalId = new Map();
  for (const item of graph.CostItems) {
    if (item.GlobalId) itemsByGlobalId.set(item.GlobalId, item);
  }
  const sortedGlobalIds = [...itemsByGlobalId.keys()].sort();

  // Relationship indices, derived straight from the spec-shaped Relationships
  // array — no reference-engine involvement.
  const nestsChildren = new Map(); // parentExpressId -> [childExpressId]
  const nestsParent = new Map(); // childExpressId -> parentExpressId
  const controlItems = new Map(); // scheduleExpressId -> [itemExpressId]
  const itemSchedules = new Map(); // itemExpressId -> [scheduleExpressId]
  const productItems = new Map(); // itemExpressId -> [productExpressId]
  const taskItems = new Map(); // itemExpressId -> [taskExpressId]
  for (const rel of graph.Relationships) {
    if (rel.Type === 'IfcRelNests' && rel.RelatingObject && rel.RelatedObjects) {
      const parentId = rel.RelatingObject.expressId;
      const kids = rel.RelatedObjects.map(r => r.expressId);
      nestsChildren.set(parentId, [...(nestsChildren.get(parentId) ?? []), ...kids]);
      for (const k of kids) nestsParent.set(k, parentId);
    } else if (rel.Type === 'IfcRelAssignsToControl' && rel.RelatingControl && rel.RelatedObjects) {
      // RelatingControl may be a schedule OR another cost item (nesting via
      // control assignment, as used by the canonical fixture); classify by
      // whether it is a known CostSchedule vs a known CostItem below, after
      // both maps are built.
      const controlId = rel.RelatingControl.expressId;
      const targetIds = rel.RelatedObjects.map(r => r.expressId);
      controlItems.set(controlId, [...(controlItems.get(controlId) ?? []), ...targetIds]);
    } else if (rel.Type === 'IfcRelAssignsToProduct' && rel.RelatingProduct && rel.RelatedObjects) {
      const productId = rel.RelatingProduct.expressId;
      for (const r of rel.RelatedObjects) {
        productItems.set(r.expressId, [...(productItems.get(r.expressId) ?? []), productId]);
      }
    } else if (rel.Type === 'IfcRelAssignsToProcess' && rel.RelatingProcess && rel.RelatedObjects) {
      const taskId = rel.RelatingProcess.expressId;
      for (const r of rel.RelatedObjects) {
        taskItems.set(r.expressId, [...(taskItems.get(r.expressId) ?? []), taskId]);
      }
    }
  }
  const itemExpressIds = new Set(graph.CostItems.map(i => i.ref.expressId));
  const scheduleExpressIds = new Set(graph.CostSchedules.map(s => s.ref.expressId));
  for (const [controlId, targetIds] of controlItems) {
    if (scheduleExpressIds.has(controlId)) {
      for (const t of targetIds) {
        if (itemExpressIds.has(t)) itemSchedules.set(t, [...(itemSchedules.get(t) ?? []), controlId]);
      }
    } else if (itemExpressIds.has(controlId)) {
      // A cost item controlling other cost items is also a nesting-equivalent
      // relationship per IFC4 (IfcRelAssignsToControl with a CostItem as the
      // RelatingControl) — fold it into the same parent/child maps as
      // IfcRelNests so downstream ParentGlobalId/ChildGlobalIds stay uniform.
      const kids = targetIds.filter(t => itemExpressIds.has(t));
      if (kids.length > 0) {
        nestsChildren.set(controlId, [...(nestsChildren.get(controlId) ?? []), ...kids]);
        for (const k of kids) nestsParent.set(k, controlId);
      }
    }
  }

  const expressIdToGlobalId = new Map(graph.CostItems.map(i => [i.ref.expressId, i.GlobalId]));
  const globalIdOf = (expressId) => expressIdToGlobalId.get(expressId) ?? null;

  const scheduleExpressIdToGlobalId = new Map(graph.CostSchedules.map(s => [s.ref.expressId, s.GlobalId]));

  const projectUnitCurrency = (() => {
    for (const unit of graph.Units) {
      if (unit.Type === 'IfcMonetaryUnit' && unit.Currency) return unit.Currency;
    }
    return null;
  })();

  const items = {};
  for (const gid of sortedGlobalIds) {
    const item = itemsByGlobalId.get(gid);
    const valuePaths = (item.CostValues ?? []).map((ref, idx) => registry.registerValue(`item:${gid}/value/${idx}`, ref.expressId));
    const quantityPaths = (item.CostQuantities ?? []).map((ref, idx) => registry.registerQuantity(`item:${gid}/quantity/${idx}`, ref.expressId));
    const resolvedTotal = valuePaths.length > 0 ? nodeResolved(registry.nodes, valuePaths[0]) : null;
    items[gid] = {
      Name: item.Name ?? null,
      Identification: item.Identification ?? null,
      PredefinedType: item.PredefinedType ?? null,
      ParentGlobalId: globalIdOf(nestsParent.get(item.ref.expressId)),
      ChildGlobalIds: (nestsChildren.get(item.ref.expressId) ?? []).map(globalIdOf).filter(Boolean).sort(),
      ScheduleGlobalIds: (itemSchedules.get(item.ref.expressId) ?? [])
        .map(id => scheduleExpressIdToGlobalId.get(id) ?? null).filter(Boolean).sort(),
      ProductGlobalIds: [], // filled after products are known below
      TaskGlobalIds: [],
      HasCostValues: (item.CostValues ?? []).length > 0,
      HasCostQuantities: (item.CostQuantities ?? []).length > 0,
      Values: valuePaths,
      Quantities: quantityPaths,
      ResolvedTotal: resolvedTotal === null ? null : { Amount: resolvedTotal, Currency: projectUnitCurrency },
    };
  }

  // Products/tasks referenced by RelAssignsToProduct/Process are not
  // themselves cost entities, so key their GlobalId straight off the raw
  // Relationships payload (RelatedObjects/RelatingProduct/RelatingProcess do
  // not carry GlobalId — only the extractor's item projection does — so we
  // fetch the assigned entity's GlobalId via the IfcDataStore-independent
  // Relationships channel is not possible here; leave as express-id-free
  // GlobalId placeholders resolved through the schedule/task relations we
  // already parsed above is out of scope for a product's own GlobalId, which
  // this read model does not project. ProductGlobalIds/TaskGlobalIds record
  // count only (presence), not identity, to avoid asserting an identity this
  // dumper cannot actually resolve.
  for (const [itemExpressId, productIds] of productItems) {
    const gid = globalIdOf(itemExpressId);
    if (gid && items[gid]) items[gid].ProductGlobalIds = productIds.length;
  }
  for (const [itemExpressId, taskIds] of taskItems) {
    const gid = globalIdOf(itemExpressId);
    if (gid && items[gid]) items[gid].TaskGlobalIds = taskIds.length;
  }
  for (const gid of sortedGlobalIds) {
    if (typeof items[gid].ProductGlobalIds !== 'number') items[gid].ProductGlobalIds = 0;
    if (typeof items[gid].TaskGlobalIds !== 'number') items[gid].TaskGlobalIds = 0;
  }

  const schedules = {};
  for (const sched of graph.CostSchedules) {
    if (!sched.GlobalId) continue;
    schedules[sched.GlobalId] = {
      Name: sched.Name ?? null,
      Identification: sched.Identification ?? null,
      PredefinedType: sched.PredefinedType ?? null,
      Status: sched.Status ?? null,
      ItemGlobalIds: (controlItems.get(sched.ref.expressId) ?? []).map(globalIdOf).filter(Boolean).sort(),
    };
  }

  return {
    SchemaVersion: graph.SchemaVersion,
    Currency: projectUnitCurrency,
    HasCostData: graph.HasCostData,
    Schedules: schedules,
    Items: items,
    Nodes: registry.nodes,
  };
}

async function main() {
  const { input, out } = parseArgs(process.argv.slice(2));
  const bytes = await readFile(input);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const parser = new IfcParser();
  const origLog = console.log; const origWarn = console.warn;
  console.log = (...parts) => process.stderr.write(`[dump_ifclite_cost] ${parts.map(String).join(' ')}\n`);
  console.warn = console.log;
  let store;
  try {
    store = await parser.parseColumnar(arrayBuffer, {});
  } finally {
    console.log = origLog; console.warn = origWarn;
  }
  const backend = createCostBackend(() => ({ modelId: 'model', store }));
  const graph = backend.data();
  const dump = buildCanonicalDump(graph);
  await writeFile(out, JSON.stringify(dump, null, 2) + '\n');
  process.stderr.write(`[dump_ifclite_cost] wrote ${out}\n`);
}

main().catch(err => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
