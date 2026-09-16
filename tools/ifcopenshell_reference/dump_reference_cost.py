#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Reference (IfcOpenShell) side of the cost differential parity pair.

Uses the pinned IfcOpenShell purely as a black-box data-access library (the
documented `ifcopenshell.file` API: `by_type`, attribute access, `.id()`) to
read `IfcCostSchedule` / `IfcCostItem` / `IfcCostValue` / `IfcQuantity*` /
`IfcRel*` entities straight off the STEP file. The traversal, the shared-
reference dedup scheme, and the arithmetic-tree resolution below are written
from the IFC4 specification, independently of `dump_ifclite_cost.mjs` and
independently of IfcOpenShell's own internal cost-resolution helpers (which
are not read, imported, or consulted here) — see `compare.py`'s "Cost
differential parity" section docstring for the shared canonical schema both
dumpers must emit.

Usage: python3 dump_reference_cost.py <model.ifc> --out <dump.json>
"""

from __future__ import annotations

import argparse
import json
import sys

import ifcopenshell


def numeric(value):
    """Coerce an IfcOpenShell scalar measure value to a plain float, or None."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


KIND_LABELS = {"value": "Value", "measure": "Measure", "unit": "Unit"}

# Entity types an IfcAppliedValueSelect reference may target.
REFERENCE_APPLIED_TYPES = ("IfcCostValue", "IfcAppliedValue", "IfcMeasureWithUnit")


def applied_reference(entity):
    """The entity an AppliedValue references, or None for a simple measure,
    an unset attribute, or an unsupported target."""
    applied_value = getattr(entity, "AppliedValue", None)
    if applied_value is None or hasattr(applied_value, "wrappedValue"):
        return None
    return applied_value if applied_value.is_a() in REFERENCE_APPLIED_TYPES else None


class NodeRegistry:
    """Mirrors the JS `NodeRegistry` in dump_ifclite_cost.mjs: first-seen path
    wins per underlying entity id(); later paths to the same entity record a
    thin `SharedWith` pointer instead of a duplicate body.

    The walk over value -> (AppliedValue | Components | UnitBasis) ->
    IfcMeasureWithUnit -> UnitComponent is iterative: a recursive walk hits
    Python's recursion limit on a deeply composed IfcCostValue chain. A frame
    claims its entity on entry (so a later path, or a cycle back into it,
    records `SharedWith`) and writes its body on exit, after every dependency's
    body exists; children are pushed in reverse so they are visited in IFC
    ordered-attribute order. The global `by_id` claim doubles as the cycle
    guard: every entity is expanded at most once."""

    def __init__(self):
        self.by_id = {}   # entity.id() -> first path
        self.nodes = {}    # path -> node body

    def register_value(self, path, entity):
        return self._walk({"kind": "value", "path": path, "entity": entity})

    def _walk(self, root):
        stack = [dict(root, entered=False)]
        while stack:
            frame = stack[-1]
            if frame["entered"]:
                stack.pop()
                self._finish(frame)
                continue
            frame["entered"] = True
            children = self._enter(frame)
            if children is None:
                stack.pop()
                continue
            for child in reversed(children):
                stack.append(dict(child, entered=False))
        return root["path"]

    def _enter(self, frame):
        path, entity, kind = frame["path"], frame["entity"], frame["kind"]
        if entity is None:
            self.nodes[path] = {"Kind": KIND_LABELS[kind], "Missing": True}
            return None
        seen = self.by_id.get(entity.id())
        if seen is not None:
            self.nodes[path] = {"SharedWith": seen}
            return None
        self.by_id[entity.id()] = path
        if kind == "value" and entity.is_a("IfcMeasureWithUnit"):
            # An AppliedValue reference may target an IfcMeasureWithUnit
            # rather than another IfcCostValue/IfcAppliedValue.
            frame["kind"] = kind = "measure"
        if kind == "value":
            children = []
            if applied_reference(entity) is not None:
                children.append({"kind": "value", "path": f"{path}/ref", "entity": entity.AppliedValue})
            for idx, comp in enumerate(getattr(entity, "Components", None) or ()):
                children.append({"kind": "value", "path": f"{path}/component/{idx}", "entity": comp})
            unit_basis = getattr(entity, "UnitBasis", None)
            if unit_basis is not None:
                children.append({"kind": "measure", "path": f"{path}/unitBasis", "entity": unit_basis})
            return children
        if kind == "measure":
            return [{"kind": "unit", "path": f"{path}/unit", "entity": getattr(entity, "UnitComponent", None)}]
        return []

    def _finish(self, frame):
        path, entity, kind = frame["path"], frame["entity"], frame["kind"]
        if kind == "value":
            applied = None
            applied_value = getattr(entity, "AppliedValue", None)
            if applied_value is not None:
                if hasattr(applied_value, "wrappedValue"):
                    # A simple measure (IfcMonetaryMeasure, IfcRatioMeasure, ...)
                    applied = {"Kind": "Typed", "Type": applied_value.is_a(), "Value": numeric(applied_value.wrappedValue)}
                elif applied_reference(entity) is not None:
                    applied = {"Kind": "Reference", "Node": f"{path}/ref"}
                else:
                    applied = {"Kind": "Unsupported"}
            components_attr = getattr(entity, "Components", None) or ()
            node = {
                "Kind": "Value",
                "Type": entity.is_a(),
                "Name": getattr(entity, "Name", None),
                # `is None`, not truthiness: a present-but-empty Category ("")
                # is a real IfcLabel value and must not fall back to CostType
                # or collapse into "absent".
                "Category": category_of(entity),
                "Condition": getattr(entity, "Condition", None),
                "ArithmeticOperator": getattr(entity, "ArithmeticOperator", None),
                "Applied": applied,
                "Components": [f"{path}/component/{idx}" for idx in range(len(components_attr))] or None,
                "UnitBasisNode": f"{path}/unitBasis" if getattr(entity, "UnitBasis", None) is not None else None,
            }
            node["Resolved"] = resolve_node(self.nodes, node)
            self.nodes[path] = node
        elif kind == "measure":
            value_component = getattr(entity, "ValueComponent", None)
            value = numeric(getattr(value_component, "wrappedValue", None))
            self.nodes[path] = {
                "Kind": "Measure",
                "Type": entity.is_a(),
                "ValueType": value_component.is_a() if value_component is not None else None,
                "Value": value,
                "UnitNode": f"{path}/unit",
                "Resolved": value,
            }
        else:
            type_name = entity.is_a()
            self.nodes[path] = {
                "Kind": "Unit",
                "Type": type_name,
                "UnitType": getattr(entity, "UnitType", None),
                "Currency": getattr(entity, "Currency", None) if type_name == "IfcMonetaryUnit" else None,
                "Symbol": None,
                "Dimension": None,
            }

    def register_quantity(self, path, entity):
        if entity is None:
            self.nodes[path] = {"Kind": "Quantity", "Missing": True}
            return path
        seen = self.by_id.get(entity.id())
        if seen is not None:
            self.nodes[path] = {"SharedWith": seen}
            return path
        self.by_id[entity.id()] = path
        type_name = entity.is_a()
        dimension_field = {
            "IfcQuantityLength": ("LengthValue", "length"),
            "IfcQuantityArea": ("AreaValue", "area"),
            "IfcQuantityVolume": ("VolumeValue", "volume"),
            "IfcQuantityCount": ("CountValue", "count"),
            "IfcQuantityWeight": ("WeightValue", "weight"),
            "IfcQuantityTime": ("TimeValue", "time"),
            # IFC4X3 only.
            "IfcQuantityNumber": ("NumberValue", "number"),
        }.get(type_name, (None, None))
        value = numeric(getattr(entity, dimension_field[0], None)) if dimension_field[0] else None
        self.nodes[path] = {
            "Kind": "Quantity",
            "Type": type_name,
            "Name": getattr(entity, "Name", None),
            "Dimension": dimension_field[1],
            "Value": value,
        }
        return path


def node_resolved(nodes, path):
    node = nodes.get(path)
    if node is None:
        return None
    if "SharedWith" in node:
        # A SharedWith target is always a first-registration path, never
        # another pointer: one hop, not a chain.
        node = nodes.get(node["SharedWith"]) or {}
    return node.get("Resolved")


def resolve_node(nodes, node):
    applied = node.get("Applied")
    if applied:
        if applied["Kind"] == "Typed":
            return applied["Value"]
        if applied["Kind"] == "Reference":
            return node_resolved(nodes, applied["Node"])
        return None
    operator = node.get("ArithmeticOperator")
    components = node.get("Components")
    if operator and components:
        values = [node_resolved(nodes, p) for p in components]
        if any(v is None for v in values):
            return None
        if operator == "ADD":
            total = 0.0
            for v in values:
                total += v
            return total
        if operator == "SUBTRACT":
            total = values[0]
            for v in values[1:]:
                total -= v
            return total
        if operator == "MULTIPLY":
            total = 1.0
            for v in values:
                total *= v
            return total
        if operator == "DIVIDE":
            total = values[0]
            for v in values[1:]:
                if v == 0:
                    return None
                total /= v
            return total
        return None
    return None


def category_of(entity):
    """IFC4 Category, else the IFC2X3 CostType. An empty label is kept."""
    category = getattr(entity, "Category", None)
    return category if category is not None else getattr(entity, "CostType", None)


def project_currency_of(model):
    """The currency IfcProject.UnitsInContext assigns - not the first
    IfcMonetaryUnit in STEP order, which may be an unassigned unit. None when
    there is no assignment or it declares conflicting currencies."""
    currencies = set()
    for project in model.by_type("IfcProject")[:1]:
        assignment = getattr(project, "UnitsInContext", None)
        for unit in (getattr(assignment, "Units", None) or ()):
            if unit.is_a("IfcMonetaryUnit") and getattr(unit, "Currency", None):
                currencies.add(unit.Currency)
    return next(iter(currencies)) if len(currencies) == 1 else None


def build_canonical_dump(model):
    schema_version = model.schema
    registry = NodeRegistry()

    cost_items = model.by_type("IfcCostItem")
    cost_schedules = model.by_type("IfcCostSchedule")
    items_by_gid = {item.GlobalId: item for item in cost_items if item.GlobalId}
    sorted_gids = sorted(items_by_gid.keys())

    item_id_to_gid = {item.id(): item.GlobalId for item in cost_items}
    schedule_id_to_gid = {s.id(): s.GlobalId for s in cost_schedules}
    item_ids = {item.id() for item in cost_items}
    schedule_ids = {s.id() for s in cost_schedules}

    nests_children = {}
    nests_parent = {}
    control_items = {}
    item_schedules = {}
    product_items = {}
    task_items = {}

    for rel in model.by_type("IfcRelNests"):
        parent = rel.RelatingObject
        kids = rel.RelatedObjects or ()
        if parent is None or parent.id() not in item_ids:
            continue
        kid_ids = [k.id() for k in kids if k.id() in item_ids]
        nests_children.setdefault(parent.id(), []).extend(kid_ids)
        for k in kid_ids:
            nests_parent[k] = parent.id()

    for rel in model.by_type("IfcRelAssignsToControl"):
        control = rel.RelatingControl
        related = rel.RelatedObjects or ()
        if control is None:
            continue
        target_ids = [r.id() for r in related]
        control_items.setdefault(control.id(), []).extend(target_ids)

    for control_id, target_ids in control_items.items():
        if control_id in schedule_ids:
            for t in target_ids:
                if t in item_ids:
                    item_schedules.setdefault(t, []).append(control_id)
        elif control_id in item_ids:
            kids = [t for t in target_ids if t in item_ids]
            if kids:
                nests_children.setdefault(control_id, []).extend(kids)
                for k in kids:
                    nests_parent[k] = control_id

    for rel in model.by_type("IfcRelAssignsToProduct"):
        product = rel.RelatingProduct
        related = rel.RelatedObjects or ()
        if product is None:
            continue
        for r in related:
            if r.id() in item_ids:
                product_items.setdefault(r.id(), []).append(product.id())

    for rel in model.by_type("IfcRelAssignsToProcess"):
        process = rel.RelatingProcess
        related = rel.RelatedObjects or ()
        if process is None:
            continue
        for r in related:
            if r.id() in item_ids:
                task_items.setdefault(r.id(), []).append(process.id())

    project_currency = project_currency_of(model)

    items = {}
    for gid in sorted_gids:
        item = items_by_gid[gid]
        values_attr = getattr(item, "CostValues", None) or ()
        quantities_attr = getattr(item, "CostQuantities", None) or ()
        value_paths = [registry.register_value(f"item:{gid}/value/{idx}", v) for idx, v in enumerate(values_attr)]
        quantity_paths = [registry.register_quantity(f"item:{gid}/quantity/{idx}", q) for idx, q in enumerate(quantities_attr)]
        resolved_total = node_resolved(registry.nodes, value_paths[0]) if value_paths else None
        parent_id = nests_parent.get(item.id())
        items[gid] = {
            "Name": getattr(item, "Name", None),
            "Identification": getattr(item, "Identification", None),
            "PredefinedType": getattr(item, "PredefinedType", None),
            "ParentGlobalId": item_id_to_gid.get(parent_id),
            "ChildGlobalIds": sorted(filter(None, (item_id_to_gid.get(c) for c in nests_children.get(item.id(), [])))),
            "ScheduleGlobalIds": sorted(filter(None, (schedule_id_to_gid.get(s) for s in item_schedules.get(item.id(), [])))),
            "ProductGlobalIds": len(product_items.get(item.id(), [])),
            "TaskGlobalIds": len(task_items.get(item.id(), [])),
            "HasCostValues": len(values_attr) > 0,
            "HasCostQuantities": len(quantities_attr) > 0,
            "Values": value_paths,
            "Quantities": quantity_paths,
            "ResolvedTotal": None if resolved_total is None else {"Amount": resolved_total, "Currency": project_currency},
        }

    schedules = {}
    for sched in cost_schedules:
        if not sched.GlobalId:
            continue
        schedules[sched.GlobalId] = {
            "Name": getattr(sched, "Name", None),
            "Identification": getattr(sched, "Identification", None),
            "PredefinedType": getattr(sched, "PredefinedType", None),
            "Status": getattr(sched, "Status", None),
            "ItemGlobalIds": sorted(filter(None, (item_id_to_gid.get(i) for i in control_items.get(sched.id(), []) if i in item_ids))),
        }

    return {
        "SchemaVersion": schema_version,
        "Currency": project_currency,
        "HasCostData": len(cost_items) > 0 or len(cost_schedules) > 0,
        "Schedules": schedules,
        "Items": items,
        "Nodes": registry.nodes,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    model = ifcopenshell.open(args.input)
    dump = build_canonical_dump(model)
    with open(args.out, "w") as f:
        json.dump(dump, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"[dump_reference_cost] wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
