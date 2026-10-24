# Wasm overlay refusal oracle (#7779 W1)

`behaviour.oracle.patch` contains only the grid and alignment production changes. The revert oracle reverse-applies it while keeping the new tests. The old grid reader draws a malformed third coordinate at zero elevation, and both overlays draw an unresolvable placement at identity. The changed tests must fail on those outputs while retaining the valid two-dimensional endpoint and genuinely absent placement cases.
