---
"@ifc-lite/export": patch
---

Stop the Parquet export wrapping large express ids to negative numbers.

`columnsToParquet` inferred Int32 for any whole-number column, so an IFC express
id at or above 2,147,483,648 came back NEGATIVE: an id-shaped number that joins
to nothing, in a file that opens cleanly. An express id is a `u32` everywhere
else in this codebase (`Uint32Array` in the parser's entity index and its
transports, `u32` in the Rust crates), and STEP bounds an entity id only by the
`u32` the readers use, so this was reachable input rather than a hypothetical.

`columnsToParquet` takes an optional `uintColumns` set, and `ParquetExporter`
declares its id and geometry-index columns (`ExpressId`, `EntityId`, `SourceId`,
`TargetId`, `RelId`, `ElementId`, `StoreyId`, `BuildingId`, `SiteId`, `Index0-2`,
`VertexStart`/`Count`, `IndexStart`/`Count`).

**Schema change for `.bos` consumers:** those columns are now `UINT32` rather
than `INT32`. Readers that pinned the old signed type will need updating; the
values themselves are unchanged except for the large ones that were previously
wrong.
