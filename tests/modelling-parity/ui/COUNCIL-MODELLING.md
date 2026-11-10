# Modelling council addendum (#9296)

This is the reviewer brief for the modelling parity frames. It extends
[`tests/ui-scenes/COUNCIL.md`](../../ui-scenes/COUNCIL.md). Reviewers receive
both files. The protocol, the output schema and the hard constraints in
`COUNCIL.md` all apply unchanged. This addendum only says what the frames show
and adds four modelling axes.

## What you are looking at

Each item is one checkpoint of a modelling exercise, captured at 1600x900 in
light or dark:

- **F1**: one room with a door, a window, a floor slab and a space.
- **F2**: the KIT FZK-Haus, a two-storey house.

The run starts from "Start blank" and models the building through the UI: tool
shortcuts, typed lengths, clicks on walls, and the storey chip and manager. At
each checkpoint the camera is set to a fixed view. The exceptions are the
storey and export-review checkpoints, which keep the drawing view.

Item ids are `<exercise>-<checkpoint>`, for example `F2-EG-openings`. X and Y
show the same step of the same exercise, modelled by two builds. The tool,
panel or dialog that is open is part of the step, not noise.

## Modelling axes

Add these four keys to `axes` (`X`, `Y` or `tie`) and to each image's
`scores` (1 to 10), next to the six axes in `COUNCIL.md`:

- `taskClarity`: from this frame alone, could a modeller tell which tool is
  running, what it expects next (the hint line and the HUD fields), and how
  to finish or leave it?
- `drawingFeedback`: does the frame show what was just drawn and what the
  next click will do? Look for snap glyphs, dimensions on the rubber band,
  the joined corners and the placed openings.
- `levelState`: is it unmistakable which storey is active and which storeys
  are visible? Check the storey chip, the hierarchy and the storey manager.
- `errorRecovery`: when something was refused or went wrong (a toast, a
  disabled control, an empty result), does the frame say why and how to
  recover? If nothing went wrong, score how clearly Undo and Esc are offered.

## Modelling defects worth naming

These are concrete things to look for. Do not use them as a checklist.

- **Ambiguous storey.** The chip, the hierarchy and the drawing plane
  disagree, or the storey being drawn on is hidden.
- **Silent controls.** A disabled control with no visible reason, such as
  "Show the plan" at this viewport size.
- **Identifiers instead of words.** The export review lists raw STEP records,
  or a field shows a GUID where a name belongs (a storey attachment, for
  example).
- **Chrome over the work.** A HUD or panel covers the place where the next
  click has to land.

## Vetoes

The vetoes in `COUNCIL.md` apply. For modelling frames, the
`modelVisibleFraction` veto applies to the checkpoints whose subject is the
model: `walls`, `openings`, `room`, `EG-walls`, `EG-openings`, `EG-done`,
`DG-done` and `done`. It does not apply to `storeys` or `export-review`,
which show a panel or dialog on purpose.

The frames' `manifest.json` uses the capture format, so `pair.mjs` and
`tally.mjs` work on it unchanged:

```sh
node tests/ui-scenes/pair.mjs --a <candidate>/frames --b <baseline>/frames --out <packet> --key <key.json>
```

Copy this file into the packet next to `COUNCIL.md` (`pair.mjs` copies only
`COUNCIL.md`). `tally.mjs` counts only the six base axes. Read the four
modelling axes from the verdict files directly.
