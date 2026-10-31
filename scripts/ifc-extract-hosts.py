#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Cut a small IFC fixture out of a large model: the given host elements, the
openings that void them, and everything those reference (#8190).

Usage: scripts/ifc-extract-hosts.py [--anonymise] <model.ifc> <out.ifc> <host id>...

Kept: every IfcRelVoidsElement whose relating element is a host, every
IfcRelFillsElement of those openings, the IfcProject (units and contexts),
every IfcSite (its placement sets the RTC offset), and
the transitive closure of #references from all of them. Nothing else, so the
spatial structure and every other product drop out. `--anonymise` writes a
minimal header, blanks every string of IfcPerson, its addresses and roles,
and of any IfcOrganization that is not an application's, and blanks the
project's and site's names (GlobalIds stay), and unsets the site's reference
latitude, longitude and elevation: what a committed fixture should carry. The
site placement stays (it sets the RTC offset), so the extract is only as
anonymous as that placement; use it on models that are already public. Product names and type names are kept; check them before committing.
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


QUOTED = re.compile(r"'(?:[^']|'')*'")
# Every string blanked: people and their contact details.
CONTACT = {"IFCPERSON", "IFCTELECOMADDRESS", "IFCPOSTALADDRESS", "IFCADDRESS", "IFCACTORROLE"}
# Every string but the GlobalId blanked: names of the project and the site.
NAMED_ROOTS = {"IFCPROJECT", "IFCSITE"}


def blank(raw, keep_first):
    """`raw` with its quoted strings emptied, the first one kept if asked."""
    seen = [0]

    def sub(m):
        seen[0] += 1
        return m.group(0) if keep_first and seen[0] == 1 else "''"

    return QUOTED.sub(sub, raw)


def top_level_args(body):
    """The comma-separated attributes of a record body, nesting and strings kept."""
    out, cur, depth, in_str = [], [], 0, False
    for ch in body:
        if ch == "'":
            in_str = not in_str
        elif not in_str and ch == "(":
            depth += 1
        elif not in_str and ch == ")":
            depth -= 1
        elif not in_str and ch == "," and depth == 0:
            out.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    out.append("".join(cur))
    return out


def drop_site_location(rid, body):
    """IfcSite with RefLatitude, RefLongitude and RefElevation (attributes 10
    to 12) unset. They are metadata only; the site PLACEMENT stays, because it
    sets the RTC offset the extract has to reproduce."""
    args = top_level_args(body)
    for i in (9, 10, 11):
        if i < len(args):
            args[i] = "$"
    return f"#{rid}= IFCSITE({','.join(args)});"


def main(argv):
    anonymise = "--anonymise" in argv
    argv = [a for a in argv if a != "--anonymise"]
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

    applications = {refs[r[0]][0] for r in recs if r[1] == "IFCAPPLICATION" and refs[r[0]]}
    if anonymise:
        schema = re.search(r"FILE_SCHEMA\s*\(.*?\);", header, re.S)
        schema_text = schema.group(0) if schema else "FILE_SCHEMA(('IFC2X3'));"
        name = dst.rsplit("/", 1)[-1]
        header = (
            "ISO-10303-21;\nHEADER;\n"
            "FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');\n"
            f"FILE_NAME('{name}','',(''),(''),'','','');\n"
            f"{schema_text}\nENDSEC;\n"
        )
    with open(dst, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(header)
        f.write("DATA;\n")
        for rid in sorted(keep):
            _, typ, _, raw = by_id[rid]
            if anonymise and (typ in CONTACT or (typ == "IFCORGANIZATION" and rid not in applications)):
                raw = blank(raw, keep_first=False)
            elif anonymise and typ in NAMED_ROOTS:
                raw = blank(raw, keep_first=True)
                if typ == "IFCSITE":
                    raw = drop_site_location(rid, ENTITY.match(raw).group(3))
            f.write(raw + "\n")
        f.write("ENDSEC;\nEND-ISO-10303-21;\n")
    print(f"{len(keep)} records, {len(openings)} openings -> {dst}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
