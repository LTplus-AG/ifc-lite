# Schedule Import

The viewer's construction-schedule (Gantt) panel can import a schedule authored in an external planning tool, instead of only extracting `IfcTask`/`IfcWorkSchedule` entities already in the model or generating one from the spatial hierarchy. Use **Import schedule…** in the Gantt panel's empty state or toolbar to pick a file.

This page covers the importer only — for the Gantt panel itself, see the in-app "Generate schedule" flow.

## Two limitations, up front

- **Imported tasks are not linked to any IFC elements.** A Gantt-tool export knows nothing about IFC entities, so every imported task comes back with empty `productExpressIds`/`productGlobalIds`. Assigning elements to tasks is still a manual step in the viewer after import. The post-import notification says so explicitly.
- **Dates are taken as authored — no critical-path recalculation.** The source tool already sequenced and levelled the schedule; the importer does not re-derive dates from durations and dependencies. If you edit a task's duration afterward, downstream dates are not automatically shifted.

## Supported inputs

### Microsoft Project XML (MSPDI) — preferred

Export from MS Project with **File → Save As → XML**. This is the lossless path: dates are unambiguous ISO datetimes, durations are already ISO 8601, and each dependency carries an explicit link type and lag — nothing has to be guessed.

The closed, binary `.mpp` format is **not supported** — picking one is rejected immediately with a message naming the file and pointing at File → Save As → XML, rather than being handed to the CSV parser and failing with an unrelated error.

A `PredecessorLink` with `LagFormat` 19 (percent), 20 (elapsed percent), 51 (percent, estimated), or 52 (elapsed percent, estimated) expresses its lag as a percentage of the predecessor's duration, not a time unit — 51/52 are the same tenths-of-a-percent units as 19/20, just with Project's "estimated" flag also set. Converting that correctly needs the predecessor's resolved duration, which this importer does not attempt — the dependency link itself is kept, but the lag is dropped and a warning names the format.

### CSV

A generic fallback for schedules exported from other tools (or hand-built spreadsheets). Column names are matched case- and space-insensitively against alias sets, so "Task Name", "Activity", and "Name" all resolve to the same column. Only a **name** column is mandatory — everything else is optional.

| Column | Recognised header aliases |
|---|---|
| id | `id`, `uid`, `unique id`, `task id`, `no`, `number` |
| name (required) | `name`, `task name`, `task`, `activity`, `activity name`, `title` |
| outline level | `outline level`, `level`, `indent`, `indent level` |
| wbs | `wbs`, `wbs code`, `outline number`, `code` |
| start | `start`, `start date`, `scheduled start`, `planned start`, `early start` |
| finish | `finish`, `finish date`, `end`, `end date`, `scheduled finish`, `planned finish` |
| duration | `duration`, `dur`, `days` |
| predecessors | `predecessors`, `predecessor`, `depends`, `depends on` |
| percent complete | `complete`, `percent complete`, `progress`, `pct complete` |
| milestone | `milestone`, `is milestone` |
| notes | `notes`, `note`, `comment`, `comments`, `description` |

If no outline-level column is present, nesting falls back to depth inferred from a dotted WBS number (`1.2.3` → level 3).

When there is no `id` column at all, each task's id is its 1-based row position — matching MS Project's own default ID column, so a predecessor like `3FS+2 days` resolves to the third data row. That position counts task rows, not physical lines in the file: the header already occupies line 1, so the two were never the same number, and a wholly blank separator row is a formatting artifact rather than a task and does not consume a position either. (Warning `line` numbers are the other way round — those *are* physical file lines, so you can find the offending cell by opening the file.) When there IS an `id` column, an explicit id always wins; a row with a *blank* id cell gets a synthesized `row-<line>-no-id` instead of a bare row number (a hand-edited sheet with only some ids filled in is a realistic case, not an edge case). Synthesized ids are kept out of the file's own id space in both directions:

- A synthesized id can never equal an id you wrote, so it can never look like a duplicate of one. If your file happens to state `row-3-no-id` in an id cell, the stated id is left exactly as written and the synthesized one is moved out of the way, so the two never collide, and a `synthesized-id-collision` warning names that as the cause. The blank-id row is then subject to the usual per-row rules like any other — a row with no task name is still skipped, for that reason rather than this one. (It used to fall through to `duplicate-source-id`, pointing at a duplicate that does not exist from your side of the file, and the blank-id row was dropped.)
- A synthesized id is not addressable by a predecessor. A row you gave no id has no id you could reference, so a predecessor naming one surfaces the normal `unknown-predecessor` warning rather than binding to that row. If the same text *is* stated as an explicit id elsewhere, the reference resolves to the row that states it.

CSV files are read as bytes and decoded with a UTF-16 BOM check before parsing: Excel's "Unicode Text (.txt)" export is UTF-16LE, and is decoded correctly rather than silently turning into NUL-byte-laced garbage. A file with no BOM is decoded as UTF-8 (a UTF-8 BOM, if present, is left in place and stripped by the CSV row splitter itself, as before).

Files over **20 MB** are rejected before parsing, with a clear error naming the file size and the limit. This is a plain UX/perf guard, not a defense against malicious XML — the browser's DOM parser isn't vulnerable to XXE or billion-laughs the way some server-side parsers are.

## Date handling

ISO dates (`YYYY-MM-DD`) are unambiguous and always read correctly. Any other format (e.g. `01/02/2026`, which could be 1 February or 2 January) is genuinely ambiguous per cell, so the importer scans **every** date cell in the file (not just the first one it finds): a cell with a component above 12 in either position (e.g. `13/01/2026` or `01/13/2026`) is read from its own value regardless of the file-wide order, and cells that stay ambiguous alone (both components `<= 12`) fall back to the order resolved from the unambiguous cells.

If the unambiguous cells in a file **disagree** with each other — one proves day-first, another proves month-first, which happens when a spreadsheet mixes locales or a value was hand-edited — the importer reports a `mixed-date-format` warning naming the conflicting values, and **refuses every ambiguous cell** in the file (they come back as `unparsable-date` warnings) rather than guessing from a majority. Unambiguous cells are unaffected and still parse correctly either way.

If nothing in the file disambiguates it at all (every date is `<= 12` in both positions), the importer **reads it day-first and emits an `ambiguous-date-format` warning** rather than guessing silently.

If exact date order matters, prefer ISO dates in your CSV export, or use MSPDI, which has no ambiguity at all.

### Time of day (CSV)

A date cell's time-of-day suffix accepts an optional AM/PM marker: case-insensitive, with or without a space before it, and with or without dots (`8:00AM`, `8:00 AM`, `8:00 a.m.` all read the same). `12 AM` is midnight (hour 0); `12 PM` stays hour 12; any other `PM` hour adds 12. Minutes accept one or two digits (`14:5` reads as `14:05`), so a single-digit minute is not silently dropped to the default time. An optional `:ss` seconds group is also accepted (`5:00:00 PM`, Excel's default datetime rendering) — the AM/PM marker is read correctly either way, but the seconds value itself is not kept; imported times are always minute-precision.

## Duration and predecessor grammar (CSV)

Durations accept `5 days`, `2 wks`, `8 hrs`, `1 mon`, or a bare number (interpreted as days). `edays` (elapsed days) are treated the same as plain days — the importer does not model working-calendar exceptions. A unit it doesn't recognise (a typo like `3 dyas`, or a unit it doesn't model like `2 yrs`) is **not** guessed as days — it's reported as an `unparsable-duration` warning instead, the same way an unreadable date is. A **negative** duration is treated the same way: it is not a valid milestone (`PT0S`), it's an `unparsable-duration` warning — only an explicit `0` means milestone. The same unrecognised-unit rule applies to a predecessor's lag: an unrecognised lag unit drops only the lag (the dependency itself is kept) and warns.

Predecessors use MS Project's shorthand:

```text
12FS+3 days, 14SS-1 day, 7
```

- `12FS+3 days` — Finish-Start from task `12`, with a 3-day lag.
- `14SS-1 day` — Start-Start from task `14`, with a 1-day **lead** (negative lag is preserved, not clamped).
- `7` — a bare id defaults to Finish-Start with no lag.
- Entries are separated by `,` or `;`. A lag magnitude may use a comma as the decimal point (`12FS+1,5 days`), the same European-locale reading `percent complete` already accepts — a comma there is only ever read as a decimal point, never as an entry separator.
- The link code (`FS`/`SS`/`FF`/`SF`) is matched case-insensitively — `12fs+3d` and `12Fs` both parse the same as `12FS+3d`.
- A task id may itself end in something that looks like a link code. The longest reading that names a task actually in the file wins: in a file containing a task `TASKFS`, the entry `TASKFS` is that task with a default Finish-Start link, not task `TASK` with an `FS` link. Where no such task exists, the suffix still splits as usual — `TASK5FS` is task `TASK5` with an `FS` link. Whitespace settles it either way: `TASK FS` is always task `TASK` with an `FS` link, since an id cannot contain a space.

### Lead time (negative lag) on export

A lead survives the import step exactly: it is stored as a negative lag internally, reads back correctly in the panel, and now also round-trips through an exported IFC file. `IfcLagTime.LagValue` is written as a signed ISO 8601-2 duration — a 2-day lead exports as `IFCDURATION('-P2D')`, not `P2D` — so re-importing that file recovers the same negative lag rather than a same-size lag with the wrong direction.

This is a deliberate departure from strict ISO 8601, which has no negative durations. The tradeoff: some third-party `IfcDuration` parsers match only the unsigned `^P...` form and will reject or drop the leading `-`, so a lead exported from ifc-lite may not survive a round trip through a different tool. That is accepted in exchange for the lead surviving an `ifc-lite → IFC → ifc-lite` round trip losslessly, which is the more common path and the one silently breaking without a signed duration. If you need the lead to be read correctly by a consumer whose `IfcDuration` parser rejects the sign, track the direction separately (e.g. in the task name or WBS) until IFC gains a standard, universally-supported way to represent it.

### Duplicate dependency edges

Two dependency entries that name the same predecessor, successor, and link type are deduped: if their lag also matches, the duplicate is dropped silently (it carries no new information); if the lag **differs**, the first-seen edge is kept, the duplicate is dropped, and a warning names the conflicting lags. This applies to both CSV (`5FS+2d, 5`) and MSPDI (a repeated `PredecessorLink`) — without it, two edges with the same predecessor/successor/type would collide on the same deterministic GlobalId and produce two `IfcRelSequence` entities sharing a GUID on export.

## Re-import behaviour

**Importing replaces the schedule currently loaded in the panel**, and — because it's a destructive replace — the viewer asks for confirmation whenever there is hand-edited work or IFC-extracted tasks in the panel that the import would discard. A schedule with nothing to lose (nothing generated or extracted yet) is replaced without asking. This is the same behaviour as "Generate schedule" in every other respect: the panel holds one schedule at a time, so importing over an existing one — whether it was extracted from the model or generated — discards it from the panel. The IFC file on disk is untouched, so a schedule that came from the model can be recovered by reloading it.

Separately, task and work-schedule GlobalIds are derived deterministically from the file name plus the project name read from the file (when present) — not from a random value or the file's byte content. Re-importing the exact same file (the common "fixed one date, re-exported" workflow) therefore yields the same GlobalIds every time, which keeps a subsequent IFC export reproducible rather than producing a fresh set of identifiers on each round.

## Warnings

Rows or values the importer could not read confidently (an unparsable date, a duration it doesn't recognise, a predecessor referring to a task that isn't in the file, an outline-level jump, mixed date formats, a duplicate dependency with conflicting lags) are not silently dropped or guessed past — they're collected as warnings. After the import completes, a toast notification shows the imported task/dependency counts plus a preview of the first couple of warnings, and the **full** warning list is always logged to the browser console (grouped, one line per warning) so nothing is lost to the short toast preview.
