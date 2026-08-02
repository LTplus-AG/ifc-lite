# Schedule Import

The viewer's construction-schedule (Gantt) panel can import a schedule authored in an external planning tool, instead of only extracting `IfcTask`/`IfcWorkSchedule` entities already in the model or generating one from the spatial hierarchy. Use **Import schedule…** in the Gantt panel's empty state or toolbar to pick a file.

This page covers the importer only — for the Gantt panel itself, see the in-app "Generate schedule" flow.

## Two limitations, up front

- **Imported tasks are not linked to any IFC elements.** A Gantt-tool export knows nothing about IFC entities, so every imported task comes back with empty `productExpressIds`/`productGlobalIds`. Assigning elements to tasks is still a manual step in the viewer after import.
- **Dates are taken as authored — no critical-path recalculation.** The source tool already sequenced and levelled the schedule; the importer does not re-derive dates from durations and dependencies. If you edit a task's duration afterward, downstream dates are not automatically shifted.

## Supported inputs

### Microsoft Project XML (MSPDI) — preferred

Export from MS Project with **File → Save As → XML**. This is the lossless path: dates are unambiguous ISO datetimes, durations are already ISO 8601, and each dependency carries an explicit link type and lag — nothing has to be guessed.

The closed, binary `.mpp` format is **not supported**. Save/export as XML instead.

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

## Date handling

ISO dates (`YYYY-MM-DD`) are unambiguous and always read correctly. Any other format (`13/01/2026`, `01/13/2026`, …) is genuinely ambiguous per cell, so the importer scans every date in the file: the first value it finds with a component above 12 in either position proves which position is the day, and that order is then applied to the whole file. If nothing in the file disambiguates it (every date is `<= 12` in both positions), the importer **reads it day-first and emits a warning** rather than guessing silently.

If exact date order matters, prefer ISO dates in your CSV export, or use MSPDI, which has no ambiguity at all.

## Duration and predecessor grammar (CSV)

Durations accept `5 days`, `2 wks`, `8 hrs`, `1 mon`, or a bare number (interpreted as days). `edays` (elapsed days) are treated the same as plain days — the importer does not model working-calendar exceptions.

Predecessors use MS Project's shorthand:

```text
12FS+3 days, 14SS-1 day, 7
```

- `12FS+3 days` — Finish-Start from task `12`, with a 3-day lag.
- `14SS-1 day` — Start-Start from task `14`, with a 1-day **lead** (negative lag is preserved, not clamped).
- `7` — a bare id defaults to Finish-Start with no lag.
- Entries are separated by `,` or `;`.

## Re-import behaviour

**Importing replaces the schedule currently loaded in the panel.** This is the same behaviour as "Generate schedule": the panel holds one schedule at a time, so importing over an existing one — whether it was extracted from the model or generated — discards it from the panel. The IFC file on disk is untouched, so a schedule that came from the model can be recovered by reloading it.

Separately, task and work-schedule GlobalIds are derived deterministically from the file name plus the project name read from the file (when present) — not from a random value or the file's byte content. Re-importing the exact same file (the common "fixed one date, re-exported" workflow) therefore yields the same GlobalIds every time, which keeps a subsequent IFC export reproducible rather than producing a fresh set of identifiers on each round.

## Warnings

Rows or values the importer could not read confidently (an unparsable date, a duration it doesn't recognise, a predecessor referring to a task that isn't in the file, an outline-level jump) are not silently dropped or guessed past — they're collected as warnings and surfaced in a toast notification after the import completes, alongside the imported task and dependency counts.
