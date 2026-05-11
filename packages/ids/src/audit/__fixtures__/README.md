# Audit fixtures

The `.ids` files in `valid/`, `invalid/` and `issues/` are copied verbatim
from [buildingSMART/IDS-Audit-tool](https://github.com/buildingSMART/IDS-Audit-tool)'s
`testing.shared/` directory (MIT-licensed; see `UPSTREAM_LICENSE`).

The expected outcomes are encoded in `audit.fixtures.test.ts`. When
upgrading the upstream corpus, drop the new file in the matching folder
and add an entry to the test table.
