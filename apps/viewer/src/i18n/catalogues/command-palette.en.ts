/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Ctrl/Cmd+K command palette (`CommandPalette.tsx`, #4918 slice 3):
 * every static command label, the category headers browse mode groups by,
 * and the dialog's own chrome (search placeholder, empty state, footer
 * hints, aria-label).
 *
 * Deliberately NOT covered, same reasoning as slice 2's shared-commands
 * catalogue:
 *  - Recent-file entries (`file:recent:*`) — the label IS the filename.
 *  - Script-template entries (`auto:*`) — label/keywords come from
 *    `SCRIPT_TEMPLATES`, user-authored automation content, not UI copy.
 *  - Tour entries (`tour:*`) — the label wraps `tour.title` from
 *    `TOUR_REGISTRY`; only the "Tour: " wrapper and the "{minutes} min"
 *    detail are catalogued here, the title itself is registry content.
 *  - Extension-contributed entries (`ext:*`) — `payload.title`, sourced
 *    from the extension registry at runtime, not a literal in this repo.
 *  - Built-in panel rows resolve their names from the workspace panel registry
 *    so the palette, rail, and ribbon display the same name.
 */
export const commandPaletteEn = {
  "commandPalette.elements.entityActions": "Selected entity actions…",
  "commandPalette.aliases.entityActions": "Copy GlobalId select same type storey duplicate X Y Z positive negative delete anonymized selection export",
  "commandPalette.model.array": "Array selected elements…",
  "commandPalette.model.move": "Move selected elements…",
  "commandPalette.model.rotate": "Rotate selected elements…",
  "commandPalette.model.copy": "Copy selected elements",
  "commandPalette.model.paste": "Paste elements at cursor…",
  "commandPalette.model.pasteInPlace": "Paste elements in place on current storey",
  "commandPalette.model.storeyUp": "Work on storey above",
  "commandPalette.model.storeyDown": "Work on storey below",
  "commandPalette.availability.workspace": "Open the Model workspace first",
  "commandPalette.availability.storeyBoundary": "No next storey in this direction",
  "commandPalette.availability.copyTarget": "Select elements with a copyable placement; hosted elements need their host",
  "commandPalette.availability.textSelection": "Clear the selected page text before copying elements",
  "commandPalette.availability.rendererEntity": "Select a resolvable element in the model; a property-only reference cannot open entity actions",
  "commandPalette.availability.world": "Enable the available 3D world context first",
  'commandPalette.extension.busy': 'Wait for the current extension export to finish',
  'commandPalette.availability.undo': 'No workspace edits to undo (IDS and schedule history are separate)',
  'commandPalette.availability.redo': 'No workspace edits to redo (IDS and schedule history are separate)',
  'commandPalette.aliases.bulk': 'bulk properties query set attribute construction stage',
  'commandPalette.aliases.import': 'CSV spreadsheet data mapping import',
  'commandPalette.aliases.classes': 'class visibility spaces openings annotations grids merge layers fast exact geometry',
  'commandPalette.availability.refresh': 'Reopen every model with a live file handle to refresh',
  'commandPalette.availability.gpuChecking': 'Wait for the WebGPU check to finish',
  'commandPalette.availability.gpu': 'WebGPU is unavailable — see the welcome screen for help',
  'commandPalette.availability.reopen': 'Reopen the file from disk; the cached copy is no longer available',
  'commandPalette.availability.editor': 'Requires editor access',
  'commandPalette.availability.feature': 'Unavailable in this configuration',
  'commandPalette.availability.selection': 'Select elements in the viewer first',
  'commandPalette.availability.entity': 'Select an IFC entity first',
  'commandPalette.availability.ifc': 'Load a model with IFC data first',
  'commandPalette.availability.model': 'Load a model first',
  'commandPalette.availability.camera': 'Wait for the viewer camera to be ready',
  'commandPalette.availability.workplane': 'Choose a valid modeling workplane first',
  'commandPalette.availability.schedule': 'Create or import a schedule first',
  'commandPalette.availability.host': 'Open the viewer tool host first',
  'commandPalette.availability.loading': 'Wait for model loading to finish',
  'commandPalette.state.on': 'On',
  'commandPalette.state.off': 'Off',

  // ── File ──
  'commandPalette.file.open.label': 'Open File',
  'commandPalette.file.saveFederationSetup.label': 'Save Federation Setup',
  'commandPalette.file.openFederationSetup.label': 'Open Federation Setup',
  'commandPalette.file.modelTags.label': 'Model Tags',

  // ── View ──
  'commandPalette.view.home.label': 'Home',
  'commandPalette.view.fit.label': 'Fit All',
  'commandPalette.view.frame.label': 'Frame Selection',
  'commandPalette.view.stacked.label': 'Level — Stacked',
  'commandPalette.view.exploded.label': 'Level — Exploded',
  'commandPalette.view.solo.label': 'Level — Solo',
  'commandPalette.view.projection.label': 'Projection',
  'commandPalette.view.top.label': 'Top View',
  'commandPalette.view.bottom.label': 'Bottom View',
  'commandPalette.view.front.label': 'Front View',
  'commandPalette.view.back.label': 'Back View',
  'commandPalette.view.left.label': 'Left View',
  'commandPalette.view.right.label': 'Right View',
  'commandPalette.view.world.label': 'Toggle 3D World Context',
  'commandPalette.view.spacemouse.label': 'SpaceMouse',

  // ── Tools ──
  'commandPalette.tool.select.label': 'Select',
  'commandPalette.tool.walk.label': 'Walk',
  'commandPalette.tool.reposition.label': 'Reposition models',
  'commandPalette.tool.measure.label': 'Measure',
  'commandPalette.tool.section.label': 'Section',
  'commandPalette.tool.annotate.label': 'Annotate',
  'commandPalette.tool.wall.label': 'Draw walls',
  'commandPalette.tool.slab.label': 'Draw slabs',
  'commandPalette.tool.column.label': 'Place columns',
  'commandPalette.tool.beam.label': 'Draw beams',
  'commandPalette.tool.editMode.label': 'Toggle Edit Mode',
  'commandPalette.tool.split.label': 'Split selected entity',
  'commandPalette.tool.extensionsAuthor.label': 'Author an extension…',

  // ── Visibility ──
  'commandPalette.vis.hide.label': 'Hide Selection',
  'commandPalette.vis.setBasket.label': 'Set Collection from Selection',
  'commandPalette.vis.addBasket.label': 'Add to Collection',
  'commandPalette.vis.removeBasket.label': 'Remove from Collection',
  'commandPalette.vis.toggleBasket.label': 'Toggle Collection Visibility',
  'commandPalette.vis.saveBasketView.label': 'Save Collection as View',
  'commandPalette.vis.togglePresentation.label': 'Toggle Collection Presentation Dock',
  'commandPalette.vis.clearBasket.label': 'Clear Collection',
  'commandPalette.vis.spaces.label': 'Spaces',
  'commandPalette.vis.spatialZones.label': 'Spatial Zones',
  'commandPalette.vis.openings.label': 'Openings',
  'commandPalette.vis.site.label': 'Site',
  'commandPalette.vis.ifcAnnotations.label': 'Annotations',
  'commandPalette.vis.ifcGrid.label': 'Grids',
  'commandPalette.vis.resetColors.label': 'Reset Colors',

  // ── Panels ──
  'commandPalette.panel.chat.label': 'AI Chat',
  'commandPalette.panel.flavors.label': 'Manage profiles…',
  'commandPalette.sidebar.toggle.label': 'Toggle Sidebar',
  'commandPalette.sidebar.collapse.label': 'Collapse Sidebar to Icons',
  'commandPalette.sidebar.customize.label': 'Customize Sidebar…',
  'commandPalette.sidebar.reset.label': 'Reset Layout',

  // ── Schedule / 4D ──
  'commandPalette.schedule.generate.label': 'Generate Schedule from Storeys…',
  'commandPalette.schedule.toggleAnimation.label': 'Toggle 4D Construction Animation',
  'commandPalette.schedule.reset.label': 'Reset Schedule (Clear 4D Data)',

  // ── Export ──
  // Every other Export row reads `exportCommands.*.menuLabel` from the
  // toolbar registry (#5601); CSV is flattened to one row per table here.
  'commandPalette.export.csvEntities.label': 'Export CSV: Entities',
  'commandPalette.export.csvProperties.label': 'Export CSV: Properties',
  'commandPalette.export.csvQuantities.label': 'Export CSV: Quantities',
  'commandPalette.export.csvSpatial.label': 'Export CSV: Spatial',
  'commandPalette.export.unavailable': 'Nothing to export yet. Load a model first.',

  // ── Preferences ──
  'commandPalette.pref.theme.label': 'Theme',
  'commandPalette.pref.tooltips.label': 'Hover Tooltips',
  'commandPalette.pref.hoverOutline.label': 'Hover Outline',
  'commandPalette.pref.settings.label': 'Settings…',

  // ── Learn ──
  'commandPalette.learn.hub.label': 'Open Learn Hub',
  'commandPalette.tour.label': 'Tour: {title}',
  'commandPalette.tour.minutes': '{minutes} min',

  // ── Chrome ──
  'commandPalette.ariaLabel': 'Command palette',
  'commandPalette.searchAriaLabel': 'Search commands',
  'commandPalette.searchPlaceholder': 'What do you need?',
  'commandPalette.escKey': 'Esc',
  'commandPalette.noResults': 'No results',
  'commandPalette.noResultsHint': 'Try a different name or keyword.',
  'commandPalette.clearSearch': 'Clear search',
  'commandPalette.footer.navigate': 'navigate',
  'commandPalette.footer.run': 'run',
  'commandPalette.footer.close': 'close',

  // ── Category headers (browse mode) ──
  'commandPalette.category.recent': 'Recent',
  'commandPalette.category.file': 'File',
  'commandPalette.category.view': 'View',
  'commandPalette.category.tools': 'Tools',
  'commandPalette.category.visibility': 'Visibility',
  'commandPalette.category.panels': 'Panels',
  'commandPalette.category.export': 'Export',
  'commandPalette.category.automation': 'Automation',
  'commandPalette.category.preferences': 'Preferences',
  'commandPalette.category.extensions': 'Extensions',
  'commandPalette.category.learn': 'Learn',
} as const satisfies Record<string, TranslationValue>;
