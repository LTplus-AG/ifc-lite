# Audit fixtures

The `.ids` files in `valid/`, `invalid/` and `issues/` are copied verbatim
from [buildingSMART/IDS-Audit-tool](https://github.com/buildingSMART/IDS-Audit-tool)'s
`testing.shared/` directory (MIT-licensed; see `UPSTREAM_LICENSE`).

The expected outcomes are encoded in `audit.fixtures.test.ts`. When
upgrading the upstream corpus, drop the new file in the matching folder
and add an entry to the test table.

`../xsd/ids-xsd-conformance.test.ts` validates documents against the real
schema: `bsfiles/ids.xsd` (buildingSMART) plus the W3C `XMLSchema.xsd` and
`xml.xsd` it imports, vendored in `w3c/` (see `w3c/UPSTREAM_LICENSE`). The
other files in `bsfiles/` are not referenced by any test.
