---
"@ifc-lite/export": patch
---

`StepExporter`'s incidental line readers no longer answer from another entity's record when a source ref is out of range.

`entityLineText` gated on `byteLength === 0`, on the stated grounds that an out-of-range ref degrades to "a clamped, empty decode, which is the same answer". It does not. `IfcSourceBytes.decodeUtf8` clamps an unaddressable range onto real file bytes, so the window that survives holds a DIFFERENT record. On a two-record source, giving `#1` the ref `(byteOffset: 0, byteLength: 9999)`:

```
getPropertySetName(#1)  = "SetA"      <- right, by luck: that pattern is unanchored
getPropertyIdsInSet(#1) = [201, 202]  <- wrong: those are #2's members (#1's are [101, 102])
```

The `$`-anchored patterns (`getPropertyIdsInSet`, `getRelatedPropertySet`) match at the end of the CLAMPED window, i.e. against whatever record the file ends on. `retainSharedAtoms` then calls `skipIds.delete(atomId)` for every id returned, so a member list read out of the wrong record un-skips the wrong atoms.

The readers are now gated on `isReadableSourceRef` (#2491), the same predicate the source-iteration pass already uses to decide whether a record's line is emitted at all — so the two passes agree, instead of one making decisions on behalf of a container the other had decided not to write. A record with an unreadable ref degrades to the shape the exporter already handles: nothing generated for it, nothing naming it.

The defect is pre-existing, not introduced by #2398 — the same probe gives `[201, 202]` on the commit before it. What #2398 added was a docstring arguing the behaviour was safe for every out-of-range shape except a negative offset; that docstring, and the matching rationale in `source-ref-bounds.ts`, are corrected to the measured behaviour, in one place with the other citing it.

Also pinned: the byte range's START. Advancing `byteOffset` by one while leaving the end alone previously passed every test in the package, because no reader parses anything from the record's first byte.
