---
"@ifc-lite/wasm": patch
"@ifc-lite/server-bin": patch
---

The void router's before/after volume gates and the reported clash intersection volume no longer depend on where the model sits. Both used to sum about the world origin. On native, where positions are absolute, a site 9 km out could shift a host's reading by 2 % when it carried a 1 mm crack, and the clash volume by 2e-5 relative. Both now sum about the operand's bounding-box centre, and a before/after difference reads both meshes about the host's centre so an untouched crack cancels. The analytic prism cutter's partition check still sums about the host-local origin (#4627).
