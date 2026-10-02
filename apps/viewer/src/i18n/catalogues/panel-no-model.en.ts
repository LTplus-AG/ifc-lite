/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The no-model state of a model-dependent workspace panel
 * (`components/viewer/PanelModelGate.tsx`, #6720). The header already names
 * the panel, so each line says what the panel does instead. The two actions
 * reuse the welcome card's own labels
 * (`viewportLighting.container.emptyState.*`): one action, one name.
 */
export const panelNoModelEn = {
  'panelNoModel.title': 'Start with a model',
  /** Fallback for a gated panel without its own line. */
  'panelNoModel.description': 'This panel works on a model. Load the demo project, or open your own file.',
  'panelNoModel.line.lens': 'Color the model by class, material, classification or any property. Load a model to apply a lens.',
  'panelNoModel.line.charts': 'Count and sum elements by type, storey or property. Load a model to chart it.',
  'panelNoModel.line.environment': 'Sky, sun position, exposure and shadows. Load a model to light it.',
  'panelNoModel.line.presentation': 'Save camera and visibility states as a sequence of views. Load a model to capture them.',
  'panelNoModel.line.drawing': 'Cut plans and sections from the geometry. Load a model to draw from.',
  'panelNoModel.line.model': 'Place and edit elements in the Model workspace. Load a model, or start blank from the start screen.',
  'panelNoModel.line.changes': 'Every edit you make, with undo. Load a model to record changes against.',
  'panelNoModel.line.changeSets': 'Group edits into named sets to export or import. Load a model to record changes against.',
  'panelNoModel.line.cost': 'Browse cost schedules and their items. Load a model to see its costs.',
  'panelNoModel.line.placement': 'Move the model locally or edit its georeference. Load a model to place it.',
  'panelNoModel.line.loadReport': 'Parse warnings and timings for the last load. Load a model to see its report.',
  'panelNoModel.banner.lists': 'Lists run against a model. You can author a list now; results appear once one is loaded.',
  'panelNoModel.banner.document': 'Documents bind to model data. You can write a page now; bound tables and charts fill in once a model is loaded.',
  'panelNoModel.banner.flow': 'Flows run against a model. You can build a graph now; running it needs one.',
  'panelNoModel.banner.gantt': 'You can import a schedule from MS Project or CSV now; generating one from storeys or linking tasks to elements needs a model.',
  'panelNoModel.banner.zones': 'You can import zone sets from JSON now; generating zones from storeys needs a model.',
  'panelNoModel.dropHint': 'or drop a file anywhere in the window',
  'panelNoModel.close': 'Close panel',
} as const;
