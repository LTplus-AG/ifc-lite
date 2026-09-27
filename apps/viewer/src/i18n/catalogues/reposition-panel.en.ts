/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The model-reposition tool's own chrome (#4918 slice) across the
 * `reposition/` directory and the docked `placement` panel's Local tab
 * (`placement/LocalTab.tsx`, #5505, which replaced the floating
 * `RepositionPanel.tsx`'s form — the moving/reference model pickers, framing
 * shortcuts, point-picking prompts, constraint/input-mode controls, the
 * move-dimensions readout, and the apply/undo/redo/reset actions),
 * `RotationControls.tsx` (the heading
 * and pivot fields, their guidance text, and the per-model rotation
 * summary), `PlacementGizmo.tsx` (the drag-handle SVG's aria-labels and its
 * live delta readout), `PlacementFiles.tsx` (the save/restore-placements
 * disclosure and its instance-mapping fieldset), and
 * `StaleMeasurementBadge.tsx` (the single stale-measurement indicator).
 * Model NAMES are runtime content and stay as interpolation params; the
 * hover-target kind (vertex/edge/face/point) and the source/target pick
 * role are internal enums whose display words are catalogued like any
 * other data-table `labelKey` (same pattern as `sectionConstants.ts`'s
 * `AXIS_INFO`). Thrown `Error` messages surfaced only through `err.message`
 * (never rendered as their own JSX literal) stay English, same as the rest
 * of this sweep's panels.
 */
export const repositionPanelEn = {
  'repositionPanel.title': 'Reposition models',
  'repositionPanel.cancelAriaLabel': 'Cancel repositioning',
  'repositionPanel.cancelButton': 'Cancel',
  'repositionPanel.subtitle': 'Local workspace placement · metres · Z is elevation',
  'repositionPanel.movingModelsLegend': 'Moving models',
  'repositionPanel.lockAction': 'Lock',
  'repositionPanel.unlockAction': 'Unlock',
  'repositionPanel.toggleLockAriaLabel': '{action} {name}',
  'repositionPanel.statusLocked': 'Locked',
  'repositionPanel.statusUnlocked': 'Unlocked',
  'repositionPanel.referenceModelLabel': 'Reference model',
  'repositionPanel.chooseReferenceOption': 'Choose reference',
  'repositionPanel.frameMovingButton': 'Frame moving',
  'repositionPanel.frameReferenceButton': 'Frame reference',
  'repositionPanel.frameBothButton': 'Frame both',
  'repositionPanel.moveNearReferenceButton': 'Move near reference',
  'repositionPanel.moveNearNote': 'Move near uses bounds centres for approximate positioning.',
  'repositionPanel.pickSourceButton': 'Pick source point',
  'repositionPanel.pickTargetButton': 'Pick target point',
  'repositionPanel.snapLabel': 'Snap',
  'repositionPanel.pickPrompt': 'Pick a {role} point. Use the other mouse buttons to navigate.',
  'repositionPanel.previewPrompt': 'Preview the move, then Apply.',
  'repositionPanel.hoverDetail': '{kind} · {name}',
  'repositionPanel.pickRoleSource': 'source',
  'repositionPanel.pickRoleTarget': 'target',
  'repositionPanel.hoverKindVertex': 'vertex',
  'repositionPanel.hoverKindEdge': 'edge',
  'repositionPanel.hoverKindFace': 'face',
  'repositionPanel.hoverKindPoint': 'point',
  'repositionPanel.hoverKindOrigin': 'origin',
  'repositionPanel.hoverKindBounds': 'bounds',
  'repositionPanel.constraintLabel': 'Constraint',
  'repositionPanel.movementConstraintAriaLabel': 'Movement constraint',
  'repositionPanel.inputLabel': 'Input',
  'repositionPanel.coordinateInputModeAriaLabel': 'Coordinate input mode',
  'repositionPanel.deltaModeOption': 'Move by ΔX / ΔY / ΔZ',
  'repositionPanel.absoluteModeOption': 'Set source point X / Y / Z',
  'repositionPanel.deltaPrefix': 'Δ',
  'repositionPanel.axisFieldDeltaAriaLabel': 'Delta {axis}',
  'repositionPanel.axisFieldSourceAriaLabel': 'Source {axis}',
  'repositionPanel.previewValuesButton': 'Preview values',
  'repositionPanel.distanceLabel': 'Distance along direction',
  'repositionPanel.moveDistanceAriaLabel': 'Move distance',
  'repositionPanel.previewDistanceButton': 'Preview distance',
  'repositionPanel.moveDimensionsAriaLabel': 'Move dimensions',
  'repositionPanel.moveOutput': 'Move {distance} m · ΔX {dx} · ΔY {dy} · ΔZ {dz}',
  'repositionPanel.nudgeIncrementLabel': 'Nudge increment',
  'repositionPanel.keyboardHelp':
    'Hold Shift while picking for orthogonal movement. Choose X/Y/Z, then ↑/↓ to nudge. Enter applies. Escape cancels.',
  'repositionPanel.modelPositionRow': '{name}: {values} m',
  'repositionPanel.applyButton': 'Apply',
  'repositionPanel.undoButton': 'Undo placement',
  'repositionPanel.redoButton': 'Redo placement',
  'repositionPanel.resetButton': 'Reset placement',

  'repositionPanel.rotation.legend': 'Rotate',
  'repositionPanel.rotation.description':
    'About the vertical axis only, counter-clockwise seen from above. Applied to the model before the placement offset above. A previewed move that has not been applied yet is committed together with the heading.',
  'repositionPanel.rotation.headingLabel': 'Heading',
  'repositionPanel.rotation.angleAriaLabel': 'Rotation angle in degrees',
  'repositionPanel.rotation.pivotAxisLabel': 'Pivot {axis}',
  'repositionPanel.rotation.pivotAxisAriaLabel': 'Rotation pivot {axis}',
  'repositionPanel.rotation.pivotNote':
    "Pivot is one workspace point in metres for every selected model; elevation does not affect a vertical-axis turn. It defaults to the model's bounds centre and moves with the model afterwards.",
  'repositionPanel.rotation.applyButton': 'Apply rotation',
  'repositionPanel.rotation.clearButton': 'Clear rotation',
  'repositionPanel.rotation.summaryRow': '{name}: {degrees}° about {pivot}',

  'repositionPanel.gizmo.handlesAriaLabel': 'Model movement handles',
  'repositionPanel.gizmo.dragPlaneAriaLabel': 'Drag {plane} plane',
  'repositionPanel.gizmo.dragAxisAriaLabel': 'Drag {axis} axis',
  'repositionPanel.gizmo.deltaLabel': '{distance} m',

  'repositionPanel.files.summary': 'Save or restore placements',
  'repositionPanel.files.intro':
    'Positions are saved in this browser for matching source files. Export a placement file to transfer them. Original model files stay unchanged.',
  'repositionPanel.files.exportButton': 'Export placements',
  'repositionPanel.files.openLabel': 'Open placement file',
  'repositionPanel.files.matchLegend': 'Match saved instances to loaded models',
  'repositionPanel.files.bindAriaLabel': 'Bind {instance}',
  'repositionPanel.files.chooseSourceOption': 'Choose matching source',
  'repositionPanel.files.importNote': 'Import changes positions as one undoable operation. Current position locks are preserved.',
  'repositionPanel.files.importButton': 'Import positions',
  'repositionPanel.files.statusReviewMapping': 'Review the model mapping, then import positions.',
  'repositionPanel.files.statusImported': 'Placements imported. Undo placement restores the previous placements.',

  'repositionPanel.staleBadge.title':
    'Model positions changed. These points remain at their old workspace coordinates; re-measure to validate.',
  'repositionPanel.staleBadge.label': 'Stale',
} as const satisfies Record<string, TranslationValue>;
