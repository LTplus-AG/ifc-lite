---
"@ifc-lite/encoding": minor
"@ifc-lite/export": minor
"@ifc-lite/lists": patch
"@ifc-lite/viewer": patch
"@ifc-lite/sdk": patch
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
---

CSV: numeric cells export as numbers. **The formula guard's default changed.**
Pass `exemptNumbers: false` to `escapeCsvCell` / `guardSpreadsheetFormula` to
keep the old behaviour.

**Read this first if you consume `@ifc-lite/export`.** The CWE-1236 guard
prefixes a leading `=`, `+`, `-`, `@`, TAB or CR with `'` so a spreadsheet reads
the cell as text. It now makes one exception by default: a cell that is *wholly*
a signed number is left alone. Nothing in your code has to change for the
behaviour to change, which is why this is called out here rather than in a
footnote.

The exception cannot weaken the guard. The exempted language contains only
`+ - . e E` and the digits `0-9`, which cannot spell a function name, a cell
reference or a `(`. `=`, `@`, TAB and CR are never exempted, `-0.35=cmd` is not
wholly a number and stays guarded, and a leading invisible character defeats the
exemption rather than the guard, so `<ZWSP>-1` is still prefixed.

**What it costs.** The default has to guess from the text, because most callers
hand it a bare string, and guessing gets identifiers wrong: a `+`-prefixed phone
number is wholly numeric as text, so it is written bare and Excel renders
`4.1791E+10` with the `+` gone. `-007` becomes `-7`. Both were previously kept
exactly, as `'`-prefixed text.

The viewer's Lists CSV does not guess, because it has the value itself: it
exempts a cell when the value really is a number and guards it otherwise, so a
phone number stays text there and a measure stays summable even in a column that
also holds text. So this cost applies to the writers that only ever see strings,
which is the CLI, the SDK, MCP, the compare report, search results, zone tables
and `@ifc-lite/lists`' own CSV. Pass `exemptNumbers: false` to opt any of them
out.

**Why the exception exists.** `@ifc-lite/lists` had exempted numbers since #1772
("`-0.35` exported as `'-0.35` and broke Excel SUM()") while every other writer
guarded them, so the same list exported two ways did not match. The policy is
now one default rather than eleven call-site decisions that drift.

**The viewer's Lists CSV stopped formatting numbers before writing them.** It
ran every value through the display formatter, which calls `toLocaleString()` on
integers. Under en-US that wrote `"-1,000"`, quoted because of the comma, so the
column stopped summing. Under a locale that groups with `.` it wrote a bare
`-3.000`, which a spreadsheet in a `,`-grouping locale reads back as **-3**, a
silent 1000x error in a quantity column. Exempting numbers fixes neither, since
neither string is wholly numeric in the locale that produced it. CSV is
machine-readable output, so it now writes the number, matching what the XLSX
writer always did. PDF, which a human reads, is unchanged.

Two consequences of that, both deliberate. Unit-converted values now show their
full double precision (3 ft in metres is `0.9144000000000001`, not `0.9144`),
which is the same value the XLSX export already carried, so the two agree. And grouping a
list by a numeric column used to hard-code that column as non-numeric in the
schedule/pivot export, where the grouping value is the *only* place the value
appears; it wrote `"'-3,000"` and nothing else for -3000. Schedule grouping
columns now inherit `numeric` and carry the raw value, falling back to the group
label where a bucket holds values that merely format alike.

**The numeric test no longer backtracks.** It was
`/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/`, quadratic on a failing match and
reached only after a trigger matched, so `-` plus 60k digits took ~1.8s. IFC
property text is attacker-controllable, which made that a denial of service on
an export. It is a linear scan now, and lives in `@ifc-lite/encoding` (no
dependencies, already depended on by both callers) as the new `isWhollyNumeric`
export, so there is one copy per language rather than one per package. The
accepted language is unchanged, checked by sweeping every string up to four
characters over the alphabet it is built from against the old regex.
