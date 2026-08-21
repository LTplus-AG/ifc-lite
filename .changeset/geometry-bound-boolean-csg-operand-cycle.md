---
'@ifc-lite/geometry': patch
---

A Boolean/CSG operand cycle no longer aborts the process.
`IfcCsgSolid.TreeRootExpression` may be an `IfcBooleanResult` whose operands
may in turn be `IfcCsgSolid`, so the two recurse into each other over
file-supplied references. The `IfcCsgSolid` arm built a fresh
`BooleanClippingProcessor`, resetting both the depth counter and the cycle
guard, so three entities were enough to recurse forever with depth never
passing 1. The result was `fatal runtime error: stack overflow, aborting` —
an abort, not a catchable panic, so nothing downstream could report it. Both
entity types appear in the Body representations of ordinary files, so an
exporter bug is enough to trigger it.

A path-scoped visited set is now threaded through the whole operand path,
inserted on the way in and removed on the way out, so an operand legitimately
reached from two branches of an acyclic tree is still processed both times.
Its length is the current nesting depth, which also bounds chain length:
`MAX_OPERAND_PATH_NODES = 64`. That sits well clear of `MAX_BOOLEAN_DEPTH`
(10), so it cannot make that cap's job harder. The 42-node `DIFFERENCE` chains
real exporters produce are FirstOperand spine nodes, walked iteratively, and
never reach this guard.

Unlike the sibling fixes in this series, this one reports: hitting either bound
returns a catchable geometry error naming the entity — `Cyclic boolean/CSG
operand reference at #N` or `Boolean/CSG operand chain exceeds 64 nested nodes
at #N`. The offending element is dropped with that error; the rest of the file
loads.
