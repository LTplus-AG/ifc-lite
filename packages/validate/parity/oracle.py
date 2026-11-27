#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Reference findings for the @ifc-lite/validate parity report.

Runs ifcopenshell.validate (schema checks plus express_rules=True) on each
file and prints one JSON document: {"version", "files": [{"path", "sha256",
"findings": [{"type", "instance", "attribute", "message"}]}]}.
IfcOpenShell (LGPL) is a test oracle only; nothing here ships.

Usage: python oracle.py <file.ifc> [...]
"""

from __future__ import annotations

import hashlib
import json
import re
import sys

INSTANCE_ID = re.compile(r"^#(\d+)=")


def instance_id(value) -> int | None:
    if value is None:
        return None
    m = INSTANCE_ID.match(str(value))
    return int(m.group(1)) if m else None


def run(path: str) -> dict:
    import ifcopenshell
    import ifcopenshell.validate

    with open(path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    class AttributeLogger(ifcopenshell.validate.json_logger):
        def log(self, level, message, *args):
            super().log(level, message, *args)
            if level != "error" or self.state.get("type") != "simpletype_rule":
                return
            # The pinned engine logs the rule name but drops its attribute.
            # Capture the actual enclosing attribute iteration while it is live.
            from ifcopenshell.express import rule_executor
            frame = sys._getframe(1)
            while frame is not None and frame.f_code is not rule_executor.run.__code__:
                frame = frame.f_back
            if frame is None or "attr" not in frame.f_locals:
                raise RuntimeError("Oracle did not expose the failing type-rule attribute")
            self.statements[-1]["valueAttribute"] = frame.f_locals["attr"].name()

    logger = AttributeLogger()
    try:
        ifcopenshell.validate.validate(path, logger, express_rules=True)
    except Exception as exc:  # the oracle failing is a result, never a silent pass
        return {"path": path, "sha256": digest, "error": f"{type(exc).__name__}: {exc}", "findings": []}
    findings = []
    schema = None
    for s in logger.statements:
        if s.get("level") != "error":
            continue
        message = str(s.get("message", ""))
        attribute = s.get("attribute")
        enum = re.match(r"An enumeration literal '.*?' is not valid for type '(\w+)'", message)
        entity = re.match(r"#\d+\s*=\s*(\w+)\(", str(s.get("instance")), re.I)
        if enum and entity and not attribute:
            if schema is None:
                schema = ifcopenshell.schema_by_name(ifcopenshell.open(path).schema_identifier)
            declaration = schema.declaration_by_name(entity.group(1))
            matches = [a.name() for a in declaration.all_attributes()
                       if hasattr(a.type_of_attribute(), "declared_type")
                       and a.type_of_attribute().declared_type().name().lower() == enum.group(1).lower()]
            if len(matches) == 1:
                attribute = f"{declaration.name()}.{matches[0]}"
        findings.append({
            "type": s.get("type"),
            "instance": instance_id(s.get("instance")),
            "instanceText": str(s.get("instance"))[:200] if s.get("instance") is not None else None,
            "attribute": attribute,
            **({"valueAttribute": s["valueAttribute"]} if "valueAttribute" in s else {}),
            "message": message,
        })
    return {"path": path, "sha256": digest, "findings": findings}


def implemented_rules(schema: str) -> list[str]:
    """Rule ids ifcopenshell's compiled rule module for `schema` evaluates."""
    import ast
    import os

    import ifcopenshell.express

    path = os.path.join(os.path.dirname(ifcopenshell.express.__file__), "rules", f"{schema}.py")
    tree = ast.parse(open(path, encoding="utf-8").read())
    out = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        fields = {t.targets[0].id: t.value.value for t in node.body if isinstance(t, ast.Assign) and isinstance(t.value, ast.Constant)}
        scope = fields.get("SCOPE")
        if scope in ("entity", "type"):
            out.append(f"{fields['TYPE_NAME']}.{fields['RULE_NAME']}")
        elif scope == "file":
            out.append(f"global:{node.name}")
    return out


def main(argv: list[str]) -> int:
    if argv[:1] == ["--rules"]:
        print(json.dumps({schema: implemented_rules(schema) for schema in argv[1:]}))
        return 0
    if not argv:
        print("oracle.py: no files given", file=sys.stderr)
        return 2
    import ifcopenshell

    print(json.dumps({"version": ifcopenshell.version, "files": [run(p) for p in argv]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
