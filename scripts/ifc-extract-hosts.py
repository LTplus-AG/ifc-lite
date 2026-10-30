#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Cut a small IFC fixture out of a large model: the given host elements, the
openings that void them, and everything those reference (#8190).

Usage: scripts/ifc-extract-hosts.py <model.ifc> <out.ifc> <host id> [<host id>...]

Kept: every IfcRelVoidsElement whose relating element is a host, every
IfcRelFillsElement of those openings, the IfcProject (units and contexts),
every IfcSite (its placement sets the RTC offset), and
the transitive closure of #references from all of them. Nothing else, so the
spatial structure and every other product drop out. Names stay as authored:
blank them before committing a fixture from a model you may not publish.
The extract is meant to give the same host mesh as the full model through
`process_geometry`; check that with `mesh_census --ids` before relying on it.
"""

import re
import sys

ENTITY = re.compile(r"^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\((.*)\);\s*$", re.S)
REF = re.compile(r"#(\d+)")


def records(text):
    """(id, type, body, raw) for each DATA record, joining wrapped lines."""
    data = text.split("DATA;", 1)[1].rsplit("ENDSEC;", 1)[0]
    # Split on ';' outside strings.
    out, buf, in_str = [], [], False
    for ch in data:
        buf.append(ch)
        if ch == "'":
            in_str = not in_str
        elif ch == ";" and not in_str:
            raw = "".join(buf).strip()
            buf = []
            m = ENTITY.match(raw)
            if m:
                out.append((int(m.group(1)), m.group(2), m.group(3), raw))
    return out


def strip_strings(body):
    return re.sub(r"'(?:[^']|'')*'", "''", body)


def main(argv):
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst, hosts = argv[1], argv[2], {int(a.lstrip("#")) for a in argv[3:]}
    text = open(src, encoding="utf-8", errors="surrogateescape").read()
    header = text.split("DATA;", 1)[0]
    recs = records(text)
    by_id = {r[0]: r for r in recs}
    refs = {r[0]: [int(x) for x in REF.findall(strip_strings(r[2]))] for r in recs}

    roots = set(hosts)
    openings = set()
    for rid, typ, body, _ in recs:
        if typ == "IFCRELVOIDSELEMENT":
            r = refs[rid]
            if len(r) >= 3 and r[-2] in hosts:
                roots.add(rid)
                openings.add(r[-1])
        elif typ in ("IFCPROJECT", "IFCSITE"):
            # The site placement sets the RTC / site offset, and with it every
            # f32 rounding downstream: without it the host meshes differently.
            roots.add(rid)
    for rid, typ, body, _ in recs:
        if typ == "IFCRELFILLSELEMENT" and refs[rid] and refs[rid][-2] in openings:
            roots.add(rid)

    keep, stack = set(), list(roots)
    while stack:
        i = stack.pop()
        if i in keep or i not in by_id:
            continue
        keep.add(i)
        stack.extend(refs[i])

    with open(dst, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(header)
        f.write("DATA;\n")
        for rid in sorted(keep):
            f.write(by_id[rid][3] + "\n")
        f.write("ENDSEC;\nEND-ISO-10303-21;\n")
    print(f"{len(keep)} records, {len(openings)} openings -> {dst}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
