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
