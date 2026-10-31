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
latitude, longitude and elevation, and drops every STEP comment: what a
committed fixture should carry. The
site placement stays (it sets the RTC offset), so the extract is only as
anonymous as that placement; use it on models that are already public. Product names and type names are kept; check them before committing.
The extract is meant to give the same host mesh as the full model through
`process_geometry`; check that with `mesh_census --ids` before relying on it.
"""

import re
import sys

ENTITY = re.compile(r"^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\((.*)\);\s*$", re.S)
REF = re.compile(r"#(\d+)")
LEADING_COMMENTS = re.compile(r"^(?:/\*.*?\*/\s*)+", re.S)


def records(text):
    """(id, type, body, raw) for each DATA record, joining wrapped lines.

    A record ends at a ';' outside strings AND block comments, so a comment
    holding a ';' cannot cut a record in two. A record is recognised on a
    comment-free copy (STEP allows comments between any two tokens), and
    `body` comes from that copy; `raw` keeps the original text."""
    data = text.split("DATA;", 1)[1].rsplit("ENDSEC;", 1)[0]
    out, buf, in_str, in_comment, previous = [], [], False, False, ""
    for ch in data:
        buf.append(ch)
        mark = ch
        if in_comment:
            if previous == "*" and ch == "/":
                in_comment = False
                mark = ""  # a closing '/' must not open a new comment
        elif in_str:
            if ch == "'":
                in_str = False
        elif previous == "/" and ch == "*":
            in_comment = True
            mark = ""  # an opening '*' must not close it
        elif ch == "'":
            in_str = True
        elif ch == ";":
            raw = LEADING_COMMENTS.sub("", "".join(buf).strip())
            buf = []
            m = ENTITY.match(without_comments(raw))
            if m:
                out.append((int(m.group(1)), m.group(2), m.group(3), raw))
        previous = mark
    return out


def without_comments(text):
    """`text` with its STEP block comments removed, strings untouched."""
    return STEP_TOKEN.sub(lambda m: "" if m.group(0).startswith("/*") else m.group(0), text)


def strip_strings(body):
    """`body` with strings emptied and comments removed: what is left holds
    only the record's real #references."""
    return re.sub(r"'(?:[^']|'')*'|/\*.*?\*/", "''", body, flags=re.S)


# A string, or a STEP block comment (dropped from anonymised records: it can
# carry identifying text, and a comma inside it would split attributes).
STEP_TOKEN = re.compile(r"'(?:[^']|'')*'|/\*.*?\*/", re.S)
# Every string blanked: people and their contact details.
CONTACT = {"IFCPERSON", "IFCTELECOMADDRESS", "IFCPOSTALADDRESS", "IFCADDRESS", "IFCACTORROLE"}
# Every string but the GlobalId blanked: names of the project and the site.
NAMED_ROOTS = {"IFCPROJECT", "IFCSITE"}


def blank(raw, keep_first):
    """`raw` with comments removed and quoted strings emptied, the first
    string kept if asked."""
    seen = [0]

    def sub(m):
        if m.group(0).startswith("/*"):
            return ""
        seen[0] += 1
        return m.group(0) if keep_first and seen[0] == 1 else "''"

    return STEP_TOKEN.sub(sub, raw)


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
            # RelatingBuildingElement and RelatedOpeningElement are the last
            # two references; OwnerHistory is optional in IFC4.
            if len(r) >= 2 and r[-2] in hosts:
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
        schema_text = without_comments(schema.group(0)) if schema else "FILE_SCHEMA(('IFC2X3'));"
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
            elif anonymise:
                # Comments anywhere can carry text nobody meant to publish.
                raw = without_comments(raw)
            f.write(raw + "\n")
        f.write("ENDSEC;\nEND-ISO-10303-21;\n")
    print(f"{len(keep)} records, {len(openings)} openings -> {dst}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
