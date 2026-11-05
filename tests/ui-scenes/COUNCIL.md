# UI design council (#8802)

The UI overhaul is a hill climb against three numbers. Two are measured by
scripts and only one asks a model for its taste. This file is the council's
brief, and reviewers receive it verbatim.

1. **Drift**: `pnpm ui-drift` counts off-system styling (raw palette classes,
   hex literals, arbitrary Tailwind values, native controls). It may only go
   down.
2. **Council win rate**: blind pairwise preference of the candidate over a
   frozen baseline, and over the previous accepted round.
3. **Hard constraints**: measured in each capture's `manifest.json`. The
   council cannot trade these away.

## The product

IFC-Lite is a professional BIM viewer and checker that runs in the browser.
Its users are architects, engineers, BIM coordinators and checkers working
long sessions on large models. They value:

- **The model first.** The 3D or 2D model is the work. Chrome supports it.
- **Density without clutter.** Experts scan many properties, rows and tools
  at once. Large, airy consumer layouts are a regression here, not polish.
- **Colour that means something.** IFC classes, selection, isolation, clash
  A/B, validation pass/fail and status use colour semantically. Decorative
  colour competes with it. Losing all colour (grey sludge) is also a failure.
- **State that is never ambiguous.** What is selected, which tool is active,
  what is hidden or isolated, which model of a federation is in focus.

## Hard constraints (veto)

A candidate that violates any of these loses the round, whatever the votes:

- `modelVisibleFraction` drops more than 0.03 below the baseline in a scene
  whose subject is the model rather than an extra panel: `loaded`,
  `isolated`, `mobile-loaded`, and `selected-properties` (it shows the
  properties panel, which is already the default right panel in `loaded`,
  so it adds no chrome of its own). Scenes that open a further panel or a
  dialog (`lists`, `drawing`, `command-palette`, ...) are judged by the
  council instead.
- `minFontPx` below 10, or `smallTextShare` (text under 11 px) rises more than
  0.05 above the baseline.
- Any page error new against the baseline.
- Behaviour checks fail (e2e, ribbon reachability, i18n, axe baseline).

## Reviewer protocol

You are one of several independent reviewers. You will not see other
reviewers' opinions, earlier rounds, scores, or any target. Judge only the
images in front of you.

For each scene you get two screenshots, **X** and **Y**, of the same state:
same model, camera, theme and viewport. The labels are random per scene and
say nothing about which is newer.

For every scene, read both images with the Read tool, then decide:

- `preferred`: `X`, `Y` or `tie`, with `confidence` 1–3. Prefer a clear
  `X`/`Y` when you can name a concrete reason. Use `tie` only when neither
  is better for the user.
- per axis, the same choice (`X`/`Y`/`tie`):
  - `hierarchy`: the primary content and next action are obvious; emphasis is
    deliberate.
  - `coherence`: one system of type, spacing, radius, icon size, borders and
    colour roles across surfaces.
  - `density`: information per area suits an expert, while remaining legible
    and scannable.
  - `modelPrimacy`: the model dominates; chrome is quiet and out of its way.
  - `stateClarity`: selection, active tool or panel, and modes are
    unmistakable.
  - `craft`: alignment, consistent padding, contrast, truncation, light/dark
    parity.
- `scores`: an absolute 1–10 per axis for **each** image, judged on its own
  merits against the best professional tools you know (Figma, Blender,
  Linear, Revit, Solibri, BIMcollab Zoom, Dalux). A 10 means you would not
  change anything. Don't anchor on the other image.
- `defects`: the concrete problems. Each defect names the image, the screen
  element (where it is and what it says), what is wrong, the effect on a
  user, and a specific fix. "Feels cluttered" is not a defect; "the 6
  ribbon groups in the top bar all use the same weight, so the active
  Measure tool doesn't stand out; give the active tool a filled
  primary-tinted background" is.

Then write one JSON file to the path you were given, with nothing else in it:

```json
{
  "reviewer": "<model name>",
  "verdicts": [
    {
      "scene": "loaded", "theme": "dark",
      "preferred": "X", "confidence": 2,
      "axes": { "hierarchy": "X", "coherence": "tie", "density": "Y",
                "modelPrimacy": "X", "stateClarity": "tie", "craft": "X" },
      "scores": {
        "X": { "hierarchy": 7, "coherence": 6, "density": 7, "modelPrimacy": 8, "stateClarity": 6, "craft": 6 },
        "Y": { "hierarchy": 6, "coherence": 6, "density": 8, "modelPrimacy": 7, "stateClarity": 6, "craft": 5 }
      },
      "defects": [
        { "image": "Y", "element": "top-left ribbon, 'Measure' button", "problem": "…",
          "impact": "…", "fix": "…", "severity": 2 }
      ]
    }
  ],
  "crossScene": [
    { "problem": "…", "fix": "…", "occurrences": [
      { "scene": "lists", "theme": "dark", "image": "X" },
      { "scene": "bcf", "theme": "light", "image": "Y" }
    ] }
  ]
}
```

`severity` is 1 (polish), 2 (noticeable cost to the user) or 3 (blocks or
misleads). `crossScene` holds patterns you saw across several scenes in the
same image set (X and Y are re-randomised per scene, so name the image per
scene).

### Solo rounds

In a solo packet every item has only an **X** image. Read every item and
provide `scores.X` on all six axes and `defects`, all with `"image": "X"`.
Omit `preferred`, `confidence`, `axes` and `scores.Y`. Keep `scene` and
`theme` on every verdict. Include `crossScene` using the occurrence schema
above (every occurrence has `"image": "X"`).

Also include a top-level `recommendations` array with exactly 10 entries,
ranked 1–10 by expected user benefit. Each entry has this shape:

```json
{ "rank": 1, "change": "…", "why": "…", "affects": ["loaded", "lists"], "effort": "S" }
```

`affects` lists scene ids; `effort` is `"S"`, `"M"` or `"L"`. Solo tallies
report absolute scores, defects, cross-scene patterns and recommendations.

Do not read any other file in the packet directory, the repository, or
earlier rounds. Do not guess which image is newer.
