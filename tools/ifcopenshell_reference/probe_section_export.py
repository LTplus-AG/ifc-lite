#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Independently reopen a #7711 export and its real-model receipt.

Generate the receipt with IFC_LITE_SECTION_EVIDENCE_DIR set while running
the root Turbo export tests. Requires the reference tool's IfcOpenShell.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.placement



def check_placement(old, new):
    """#7908: unchanged EXPRESS ids do not imply unchanged placement values."""
    before = old.ObjectPlacement
    after = new.ObjectPlacement
    assert (before is None) == (after is None), (old.id(), "placement presence changed")
    if before is None:
        return
    assert before.id() == after.id(), (old.id(), "placement identity changed")
    a = ifcopenshell.util.placement.get_local_placement(before)
    b = ifcopenshell.util.placement.get_local_placement(after)
    assert all(math.isfinite(x) and math.isfinite(y) and math.isclose(x, y, rel_tol=0, abs_tol=1e-9)
               for x, y in zip(a.flat, b.flat)), (old.id(), "placement transform changed")


def check_fill_links(source, output, retained_ids):
    """#7908: derive required links from source, including missing output rows."""
    expected = {r.id() for r in source.by_type("IfcRelFillsElement")
                if r.RelatingOpeningElement.id() in retained_ids
                and r.RelatedBuildingElement.id() in retained_ids}
    actual = {r.id() for r in output.by_type("IfcRelFillsElement")}
    assert actual == expected, ("fill links changed", sorted(expected - actual), sorted(actual - expected))
    for relation in output.by_type("IfcRelFillsElement"):
        previous = source.by_id(relation.id())
        assert relation.GlobalId == previous.GlobalId, relation.id()
        for attribute in ["RelatingOpeningElement", "RelatedBuildingElement"]:
            current = getattr(relation, attribute).id()
            assert current in retained_ids and current == getattr(previous, attribute).id(), relation.id()


def probe(source_path, evidence_dir):
    receipt = json.loads((evidence_dir / "haus-evidence.json").read_text())
    output_path = evidence_dir / "haus-cropped.ifc"
    for path, key in [(source_path, "sourceSha256"), (output_path, "outputSha256")]:
        assert hashlib.sha256(path.read_bytes()).hexdigest() == receipt[key], key
    source = ifcopenshell.open(str(source_path))
    output = ifcopenshell.open(str(output_path))
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    reopened = 0
    reopened_ids = set()
    trimmed_ids = set(receipt["trimmed"])
    max_x = float("-inf")
    for entity in output.by_type("IfcProduct"):
        # #7908: identity alone cannot certify a trimmed product whose body vanished.
        if entity.id() in trimmed_ids:
            assert entity.Representation, (entity.id(), "trimmed representation missing")
        if not entity.Representation or any(entity.is_a(kind) for kind in (
            "IfcOpeningElement", "IfcAnnotation", "IfcGrid"
        )):
            continue
        shape = ifcopenshell.geom.create_shape(settings, entity)
        vertices = shape.geometry.verts
        assert vertices, (entity.id(), "empty geometry")
        assert len(vertices) % 3 == 0 and all(math.isfinite(v) for v in vertices), (entity.id(), "invalid vertices")
        bound = max(vertices[0::3])
        assert bound <= receipt["offset"] + 0.001, (entity.id(), bound)
        max_x = max(max_x, bound)
        reopened += 1
        reopened_ids.add(entity.id())
    assert trimmed_ids <= reopened_ids, ("trimmed geometry not reopened", sorted(trimmed_ids - reopened_ids))
    identities = []
    for entity_id in receipt["trimmed"]:
        old = source.by_id(entity_id)
        new = output.by_id(entity_id)
        assert old.is_a() == new.is_a(), entity_id
        assert old.GlobalId == new.GlobalId, entity_id
        check_placement(old, new)
        assert ifcopenshell.util.element.get_psets(old) == ifcopenshell.util.element.get_psets(new), entity_id
        for attribute in ["HasAssociations", "ContainedInStructure", "IsTypedBy"]:
            previous = sorted(r.id() for r in getattr(old, attribute, []))
            retained = sorted(r.id() for r in getattr(new, attribute, []))
            assert previous == retained, (entity_id, attribute)
        identities.append({"expressId": entity_id, "type": new.is_a(), "GlobalId": new.GlobalId})
    retained_ids = {entity.id() for entity in output}
    opening_links = 0
    for opening in output.by_type("IfcOpeningElement"):
        # IFC4/4X3 IfcFeatureElementSubtraction requires one VoidsElements link.
        assert len(opening.VoidsElements) == 1, (opening.id(), "orphaned opening")
        relation = opening.VoidsElements[0]
        previous = source.by_id(relation.id())
        assert relation.GlobalId == previous.GlobalId, relation.id()
        assert relation.RelatedOpeningElement.id() == opening.id(), relation.id()
        assert relation.RelatingBuildingElement.id() in retained_ids, relation.id()
        assert relation.RelatingBuildingElement.id() == previous.RelatingBuildingElement.id(), relation.id()
        old = source.by_id(opening.id())
        assert opening.GlobalId == old.GlobalId and opening.is_a() == old.is_a(), opening.id()
        opening_links += 1
    check_fill_links(source, output, retained_ids)
    for entity_id in retained_ids.intersection(receipt["outside"]):
        container = output.by_id(entity_id)
        assert container.is_a("IfcSpatialElement") and container.Representation is None, (entity_id, "outside body retained")
    assert reopened > 0 and identities
    result = {
        "engine": ifcopenshell.version,
        "sourceSha256": receipt["sourceSha256"],
        "outputSha256": receipt["outputSha256"],
        "reopenedProducts": reopened,
        "maxX": max_x,
        "planeOffset": receipt["offset"],
        "checkedIdentities": len(identities),
        "checkedTrimmedGeometry": len(trimmed_ids),
        "checkedOpeningLinks": opening_links,
        "types": sorted({item["type"] for item in identities}),
    }
    (evidence_dir / "ifcopenshell-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("evidence_dir", type=Path)
    args = parser.parse_args()
    probe(args.source, args.evidence_dir)
