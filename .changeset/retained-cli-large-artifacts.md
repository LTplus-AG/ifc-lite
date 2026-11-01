---
"@ifc-lite/cli": patch
---

`export --kernel retained` now writes an OBJ or report larger than one JavaScript string. A large model (Holter Tower: 739 MB OBJ, 1.03 GB report) finished its whole run and then failed with `Invalid string length`. The bytes of smaller exports are unchanged.
