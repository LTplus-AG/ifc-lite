---
'@ifc-lite/diff': minor
---

`EntityFingerprint` gains an optional `volume` — the enclosed volume of the entity's geometry, in the caller's units cubed (issue [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)).

Purely additive: no existing option reads it, and a diff that supplies it is byte-identical to one that does not until `detectSplitMerge` is enabled.

Absent means **not proved** — never zero, and never "differs". The producer this contract was written against emits a value only where the meshed geometry was provably a single closed orientable solid, so roughly a third of a real model's elements carry none. That is what makes the field usable while sparse: the engine treats it asymmetrically, requiring a COMPLETE set of volumes before one can confirm a claim while letting a PARTIAL sum already refute one. A `NaN`, zero or negative value is ignored exactly as if the field were absent; resolve your producer's absent-sentinel at its boundary rather than passing one through.
