---
"@ifc-lite/bcf": patch
---

Fix three cases in `@ifc-lite/bcf` where a failure or absence produced a result indistinguishable from success:

- Reading a `.bcfzip` where two topic folders declare the same `Topic/@Guid` no longer silently overwrites one topic in the resulting map; the first one read is kept and a `console.warn` reports the collision.
- Reading a `Topic/Index` value that is not a valid number now yields `undefined`, matching the treatment of every other numeric field in the reader, instead of a `NaN` stored as a plain `number`.
- Writing a viewpoint's snapshot now resolves the snapshot bytes once, before deciding whether to emit the markup `<Snapshot>` reference, so a `data:` URL that fails to decode can no longer produce an archive whose markup references a snapshot file that was never written.
