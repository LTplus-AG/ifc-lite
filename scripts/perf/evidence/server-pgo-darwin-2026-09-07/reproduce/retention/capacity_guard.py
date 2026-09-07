# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Pre-pair disk reserve gate; call before launching either timed arm.
No hashing, compression, deletion or directory walks. Refusal is retained.
"""
import argparse
import json
import os
from pathlib import Path
import time


def check(projection, label, filesystem, output):
    config=json.loads(Path(projection).read_text())
    matches=[r for r in config['models'] if r['label']==label]
    if len(matches)!=1:raise ValueError('Expected one SHA-pinned fixture label')
    row=matches[0];fs=os.statvfs(filesystem);available=fs.f_bavail*fs.f_frsize
    required=config['reserveBytes']+row['pairBudgetBytes']
    result={'protocol':'http-evidence-capacity-v1','time':time.time(),'label':label,
            'fixtureSha256':row['fixtureSha256'],'availableBytes':available,
            'reserveBytes':config['reserveBytes'],'pairBudgetBytes':row['pairBudgetBytes'],
            'requiredBytes':required,'allowPair':available>=required,
            'scope':'Capacity estimate, not a bound on arbitrary IFC expansion. No retention work may overlap either timed arm.'}
    with Path(output).open('x') as stream:json.dump(result,stream,indent=2);stream.write('\n')
    if not result['allowPair']:raise RuntimeError('Insufficient disk for next pair plus reserve; retain evidence and compact only outside timing')
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--projection',required=True);p.add_argument('--label',required=True);p.add_argument('--filesystem',required=True);p.add_argument('--output',required=True)
    a=p.parse_args();print(json.dumps(check(a.projection,a.label,a.filesystem,a.output),indent=2))
