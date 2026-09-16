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
are not read, imported, or consulted here) — see `compare_cost.py`'s module
docstring for the shared canonical schema both dumpers must emit.

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


class NodeRegistry:
    """Mirrors the JS `NodeRegistry` in dump_ifclite_cost.mjs: first-seen path
    wins per underlying entity id(); later paths to the same entity record a
    thin `SharedWith` pointer instead of a duplicate body."""

    def __init__(self):
        self.by_id = {}   # entity.id() -> first path
        self.nodes = {}    # path -> node body

    def register_value(self, path, entity):
        if entity is None:
            self.nodes[path] = {"Kind": "Value", "Missing": True}
            return path
        seen = self.by_id.get(entity.id())
        if seen is not None:
            self.nodes[path] = {"SharedWith": seen}
            return path
        self.by_id[entity.id()] = path

        applied = None
        applied_value = getattr(entity, "AppliedValue", None)
        if applied_value is not None:
            if hasattr(applied_value, "wrappedValue"):
                # A simple measure (IfcMonetaryMeasure, IfcRatioMeasure, ...)
                applied = {"Kind": "Typed", "Type": applied_value.is_a(), "Value": numeric(applied_value.wrappedValue)}
            elif hasattr(applied_value, "is_a") and applied_value.is_a() in ("IfcCostValue", "IfcAppliedValue"):
                ref_path = self.register_value(f"{path}/ref", applied_value)
                applied = {"Kind": "Reference", "Node": ref_path}
            else:
                applied = {"Kind": "Unsupported"}

        operator = getattr(entity, "ArithmeticOperator", None)
        components_attr = getattr(entity, "Components", None) or []
        components = None
        if components_attr:
            components = [
                self.register_value(f"{path}/component/{idx}", comp)
                for idx, comp in enumerate(components_attr)
            ]

        unit_basis_node = None
        unit_basis = getattr(entity, "UnitBasis", None)
        if unit_basis is not None:
            unit_basis_node = self.register_unit(f"{path}/unitBasis", unit_basis)

        category = getattr(entity, "Category", None) or getattr(entity, "CostType", None)
        condition = getattr(entity, "Condition", None)

        node = {
            "Kind": "Value",
            "Type": entity.is_a(),
            "Name": getattr(entity, "Name", None),
            "Category": category,
            "Condition": condition,
            "ArithmeticOperator": operator,
            "Applied": applied,
            "Components": components,
            "UnitBasisNode": unit_basis_node,
        }
        node["Resolved"] = resolve_node(self.nodes, node)
        self.nodes[path] = node
        return path

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

    def register_unit(self, path, entity):
        if entity is None:
            self.nodes[path] = {"Kind": "Unit", "Missing": True}
            return path
        seen = self.by_id.get(entity.id())
        if seen is not None:
            self.nodes[path] = {"SharedWith": seen}
            return path
        self.by_id[entity.id()] = path
        type_name = entity.is_a()
        currency = getattr(entity, "Currency", None) if type_name == "IfcMonetaryUnit" else None
        symbol = None
        unit_type = getattr(entity, "UnitType", None)
        self.nodes[path] = {
            "Kind": "Unit",
            "Type": type_name,
            "UnitType": unit_type,
            "Currency": currency,
            "Symbol": symbol,
            "Dimension": None,
        }
        return path


def node_resolved(nodes, path):
    node = nodes.get(path)
    if node is None:
        return None
    if "SharedWith" in node:
        return node_resolved(nodes, node["SharedWith"])
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

    project_currency = None
    for unit in model.by_type("IfcMonetaryUnit"):
        project_currency = getattr(unit, "Currency", None)
        break

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
