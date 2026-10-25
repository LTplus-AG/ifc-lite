#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Optional independent IFC4 validator/round-trip; requires installed IfcOpenShell.

No installation is attempted. --cli points to an existing ifc-lite dist/index.js.
This is fixture tooling, not a new CI gate. Rust integration tests run in cargo test.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    try:
        import ifcopenshell
        import ifcopenshell.validate
    except ImportError:
        raise SystemExit('UNRUN: no IfcOpenShell installed in this Python; do not count as pass')
    oracle = json.loads((ROOT/'oracles.json').read_text())
    report = {'license':'SPDX-License-Identifier: MPL-2.0','python':sys.version,'ifcopenshell':ifcopenshell.version,'files':[]}
    failed = False
    for name in oracle['cases']:
        path = ROOT/name
        source = ifcopenshell.open(str(path))
        roundtrip = ifcopenshell.file.from_string(source.to_string())
        row = {'file':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'entity_count':len(list(source)),'roundtrip_entity_count':len(list(roundtrip))}
        row['roundtrip_entities_equal'] = all(str(e)==str(roundtrip.by_id(e.id())) for e in source)
        errors = []
        for label, model in [('source',source),('roundtrip',roundtrip)]:
            logger = ifcopenshell.validate.json_logger()
            ifcopenshell.validate.validate(model,logger,express_rules=True)
            errors.extend({'stage':label,'message':s['message'],'instance':str(s.get('instance',''))} for s in logger.statements)
        row['schema_errors'] = errors
        if args.cli:
            run = subprocess.run(['node',str(args.cli),'validate',str(path),'--json'],capture_output=True,text=True)
            row['cli'] = {'path':str(args.cli.resolve()),'sha256':hashlib.sha256(args.cli.read_bytes()).hexdigest(),'exit':run.returncode,'stdout':run.stdout,'stderr':run.stderr}
            failed |= run.returncode != 0
        failed |= bool(errors) or not row['roundtrip_entities_equal']
        report['files'].append(row)
    report['passed'] = not failed
    text = json.dumps(report,indent=2)+'\n'
    if args.report:
        args.report.write_text(text)
    print(text)
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    main()
