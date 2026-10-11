# Source frame replacement release regression (#6537 / PR #6584)

The actual dropped Claude finding on `287350ae` was correct: canonical `restorePreAlignment` replaces source position/normal allocations while a previously registered `placedMesh` copy can still retain the prior allocations. The judge rejected its quoted anchor, not the behavior. The original validated finding, job log and direct canonical counterexample are retained.

The canonical buffer helper now records per-mesh historical allocation membership in weak sets during actual copy registration. Bounded release clears current and prior target-owned fields on registered copies, while independent replacement fields survive. Neither bookkeeping nor retained release metadata strongly owns original backing allocations.

Root Turbo against old production passes the four existing appearance controls and fails the new actual-restore assertion with 48 retained bytes. Byte-exact restored candidate passes all five, then 77 relevant controls including actual backing-buffer collection after source replacement and real canonical Bonsai primary/federated loading. Plain full root typecheck covers 3726 test files. Source/gate logs and the unchanged runtime/fixture pins are in `qualification.json`.

Controls executed on the recorded five-file dirty candidate atop `287350ae`; the subsequent source commit preserves those exact bytes. This distinction is explicit in the receipt. Native GPU performance and OS resident-memory improvement remain unqualified. Tests of split fragments still explicitly register copies; no automatic Scene registration is claimed.
