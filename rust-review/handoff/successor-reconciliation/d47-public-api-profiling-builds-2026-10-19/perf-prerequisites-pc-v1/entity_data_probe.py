# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Fresh-process D47 entity_data producer. Run only in the later authorized cohort."""
import ctypes,json,sys
from pathlib import Path
import ifclite_geom
mode,clock_library,input_path,output_path=sys.argv[1:]
assert mode in ("measure","witness")
clock=ctypes.CDLL(clock_library);clock.d47_clock_now_ns.restype=ctypes.c_uint64
clock.d47_clock_now_ns()  # Initialize the native Instant origin outside the public call.
def proc_kib(label):
    return next(int(line[len(label):].split()[0]) for line in Path("/proc/self/status").read_text().splitlines() if line.startswith(label))
content=Path(input_path).read_bytes()
baseline={"rss_kib":proc_kib("VmRSS:"),"hwm_kib":proc_kib("VmHWM:")}
began=clock.d47_clock_now_ns()
result=ifclite_geom.entity_data(content)  # Default type_properties and attributes, lazy pool remains cold.
elapsed=clock.d47_clock_now_ns()-began
peak=proc_kib("VmHWM:");rss=proc_kib("VmRSS:")
if mode=="witness": payload=result
else: payload={"api":"entity_data","input_bytes":len(content),"entry_to_return_ns":elapsed,"rows":len(result["entities"]),"baseline":baseline,"live_peak_rss_kib":peak,"live_rss_kib":rss,"clock":"native std::time::Instant bridge","result_drop":"after RSS and serialization"}
Path(output_path).write_text(json.dumps(payload))
del result
