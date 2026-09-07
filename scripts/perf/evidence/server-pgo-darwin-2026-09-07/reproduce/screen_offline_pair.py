# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Isolated offline witness process; all allocations die before next timed pair."""
import json,sys
from pathlib import Path
import wire
from wire_arrow_v2 import decode_run
from screen_compare_v2 import qualify
pair=Path(sys.argv[1]);fixture_sha=sys.argv[2]
original=wire.data_model;last_data=None;last_witness=None

def exact_reuse(data):
 global last_data,last_witness
 if last_data is None or data!=last_data:last_witness=original(data);last_data=data
 return last_witness

wire.data_model=exact_reuse
for side in ('base','candidate'):
 decode_run(pair/side,False);decode_run(pair/side/'cache-replay',None)
result=qualify(pair/'base',pair/'candidate',fixture_sha)
with (pair/'offline-qualification.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
raise SystemExit(0 if result['passed'] else 1)
