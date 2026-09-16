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
 * IfcCostValue / IfcAppliedValue, an IfcMeasureWithUnit (used as an
 * AppliedValue or a UnitBasis) and its UnitComponent, or an IfcQuantity*,
 * reached from a canonical traversal (items sorted by GlobalId, then their
 * CostValues / CostQuantities, then per value its AppliedValue reference,
 * Components and UnitBasis in IFC ordered-attribute order —
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
    this.byExpressId = new Map(); // expressId -> first path
    this.nodes = {}; // path -> node body (or { SharedWith })
    this.valueByExpressId = new Map(graph.CostValues.map(v => [v.ref.expressId, v]));
    this.quantityByExpressId = new Map(graph.CostQuantities.map(v => [v.ref.expressId, v]));
    this.unitByExpressId = new Map(graph.Units.map(v => [v.ref.expressId, v]));
    this.measureByExpressId = new Map(graph.MeasuresWithUnit.map(v => [v.ref.expressId, v]));
  }

  registerValue(path, expressId) {
    return this.walk({ kind: 'value', path, expressId });
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

  /**
   * Iterative depth-first walk over value -> (AppliedValue | Components |
   * UnitBasis) -> measure -> unit. A recursive walk overflowed the JS stack on
   * a deeply composed IfcCostValue chain the parser itself reads fine, so the
   * stack is explicit: a frame CLAIMS its entity on entry (so a later path, or
   * a cycle back into it, records `SharedWith` exactly as the old pre-order
   * recursion did) and writes its body on exit, after every dependency's body
   * exists. Children are pushed in reverse so they are visited in IFC
   * ordered-attribute order, which keeps path registration order - and so
   * which path owns a shared entity - identical to dump_reference_cost.py.
   * The global `byExpressId` claim is also the cycle guard: every entity is
   * expanded at most once, so the walk is bounded by the entity count.
   */
  walk(root) {
    const stack = [{ ...root, entered: false }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.entered) {
        stack.pop();
        this.finish(frame);
        continue;
      }
      frame.entered = true;
      const children = this.enter(frame);
      if (children === null) {
        stack.pop();
        continue;
      }
      for (let i = children.length - 1; i >= 0; i--) stack.push({ ...children[i], entered: false });
    }
    return root.path;
  }

  /** Claim the frame's entity and return its child frames, or null when the frame is already final. */
  enter(frame) {
    const { path, expressId } = frame;
    const seen = this.byExpressId.get(expressId);
    if (seen !== undefined) {
      this.nodes[path] = { SharedWith: seen };
      return null;
    }
    this.byExpressId.set(expressId, path);
    if (frame.kind === 'value') {
      // An AppliedValue reference may target an IfcCostValue/IfcAppliedValue
      // OR an IfcMeasureWithUnit; dispatch on what the entity actually is.
      if (this.measureByExpressId.has(expressId) && !this.valueByExpressId.has(expressId)) {
        frame.kind = 'measure';
        return this.measureChildren(frame);
      }
      const value = this.valueByExpressId.get(expressId);
      if (!value) {
        this.nodes[path] = { Kind: 'Value', Missing: true };
        return null;
      }
      frame.value = value;
      const children = [];
      if (value.AppliedValue?.Kind === 'Reference') {
        children.push({ kind: 'value', path: `${path}/ref`, expressId: value.AppliedValue.ref.expressId });
      }
      (value.Components ?? []).forEach((ref, idx) => {
        children.push({ kind: 'value', path: `${path}/component/${idx}`, expressId: ref.expressId });
      });
      if (value.UnitBasis) {
        children.push({ kind: 'measure', path: `${path}/unitBasis`, expressId: value.UnitBasis.expressId });
      }
      return children;
    }
    if (frame.kind === 'measure') return this.measureChildren(frame);
    return [];
  }

  measureChildren(frame) {
    const measure = this.measureByExpressId.get(frame.expressId);
    if (!measure) {
      this.nodes[frame.path] = { Kind: 'Measure', Missing: true };
      return null;
    }
    frame.measure = measure;
    return [{ kind: 'unit', path: `${frame.path}/unit`, expressId: measure.UnitComponent.expressId }];
  }

  finish(frame) {
    const { path } = frame;
    if (frame.kind === 'value') {
      const value = frame.value;
      const applied = value.AppliedValue
        ? value.AppliedValue.Kind === 'Typed'
          ? { Kind: 'Typed', Type: value.AppliedValue.Type, Value: parseNumericLiteral(value.AppliedValue.Value) ?? null }
          : value.AppliedValue.Kind === 'Reference'
            ? { Kind: 'Reference', Node: `${path}/ref` }
            : { Kind: 'Unsupported' }
        : null;
      const components = value.Components
        ? value.Components.map((_, idx) => `${path}/component/${idx}`)
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
        UnitBasisNode: value.UnitBasis ? `${path}/unitBasis` : null,
        Resolved: resolveNode(this.nodes, applied, value.ArithmeticOperator, components),
      };
    } else if (frame.kind === 'measure') {
      const value = parseNumericLiteral(frame.measure.ValueComponent) ?? null;
      this.nodes[path] = {
        Kind: 'Measure',
        Type: 'IfcMeasureWithUnit',
        ValueType: frame.measure.ValueType ?? null,
        Value: value,
        UnitNode: `${path}/unit`,
        Resolved: value,
      };
    } else {
      const u = this.unitByExpressId.get(frame.expressId);
      this.nodes[path] = u
        ? {
          Kind: 'Unit',
          Type: u.Type ?? null,
          UnitType: u.UnitType ?? null,
          Currency: u.Currency ?? null,
          Symbol: u.Symbol ?? null,
          Dimension: u.Dimension ?? null,
        }
        : { Kind: 'Unit', Missing: true };
    }
  }
}

/**
 * Resolve a value node whose dependencies' bodies are already written (the
 * walk guarantees that) to a plain number, or null. Not recursive: it only
 * reads the dependencies' own `Resolved` fields. A dependency still being
 * walked (a reference cycle) has no body yet and resolves to null.
 */
function resolveNode(nodes, applied, operator, componentPaths) {
  if (applied) {
    if (applied.Kind === 'Typed') return applied.Value;
    if (applied.Kind === 'Reference') return nodeResolved(nodes, applied.Node);
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
  // A SharedWith target is always a first-registration path, never another
  // SharedWith pointer, so this is a single hop rather than a chain.
  const body = node.SharedWith ? nodes[node.SharedWith] : node;
  return body?.Resolved ?? null;
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

  // The project currency is the one IfcProject.UnitsInContext assigns (the
  // read model leaves it unset when that assignment declares conflicting
  // currencies) - NOT the first IfcMonetaryUnit in the file, which can be an
  // unassigned unit that merely precedes the project's in STEP order.
  const projectUnitCurrency = graph.Currency ?? null;

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
    // Lite-only evidence field, never compared as a value: compare.py reads it
    // as the paired marker a DEGRADED:IFC2X3_PARTIAL_READ classification
    // requires (the read model's own diagnostic, not the comparator's guess).
    DiagnosticCodes: [...new Set(graph.Diagnostics.map(d => d.Code))].sort(),
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
