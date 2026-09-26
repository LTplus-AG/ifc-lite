/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The viewer shell/sidebar chrome (#4918 slice): a sibling to
 * `viewer-shell.en.ts` (which covers `ChunkErrorBoundary` and the shared
 * `ui/dialog.tsx` primitive's sr-only close label) under a distinct
 * `shellChrome.*` prefix to avoid any key collision. Covers the unified
 * sidebar's activity rail and its customize popover (`ActivityBar.tsx`,
 * `CustomizeSidebar.tsx`), the docked-pane host and its resize handle
 * (`SidebarDock.tsx`, `SidebarPanelHost.tsx`), the floating/edge-snapped
 * panel window and the popped-out OS/PiP window chrome (`FloatingPanel.tsx`,
 * `PanelWindowHost.tsx`), `ViewerLayout.tsx`'s own top-level chrome (the
 * safe-mode banner, the mobile bottom-sheet host and its floating Hierarchy/
 * Properties buttons), `StatusBar.tsx`, and `MobileToolbar.tsx`. Panel
 * NAMES/TITLES sourced from the panels registry (`@/lib/panels/registry`,
 * outside this slice) are runtime data passed as `{title}` interpolation
 * params, same reasoning as every other slice treating a registry-owned
 * label as data rather than UI copy owned by the component that renders it.
 */
export const shellChromeEn = {
  // Shared between ActivityBar.tsx / CustomizeSidebar.tsx / SidebarPanelHost.tsx
  'shellChrome.shared.customizeSidebar': 'Customize sidebar',
  'shellChrome.shared.doneCustomizing': 'Done customizing',
  'shellChrome.shared.collapseToIcons': 'Collapse to icons',

  // ActivityBar.tsx
  'shellChrome.activityBar.iconAriaLabelHide': '{title}, activate to hide from the sidebar',
  'shellChrome.activityBar.iconAriaLabelFloating': '{title} (floating)',
  'shellChrome.activityBar.iconAriaLabelPopped': '{title} (popped out)',
  'shellChrome.activityBar.clickToHideHint': 'click to hide',
  'shellChrome.activityBar.altShortcutHint': 'Alt+{key}',
  'shellChrome.activityBar.floatingHint': 'floating',
  'shellChrome.activityBar.poppedHint': 'popped out',
  'shellChrome.activityBar.expandSidebar': 'Expand sidebar',
  'shellChrome.activityBar.sidebarOptions': 'Sidebar options',
  'shellChrome.activityBar.customizePanelsMenuItem': 'Customize panels…',
  'shellChrome.activityBar.showAllPanels': 'Show all panels ({count} hidden)',
  'shellChrome.activityBar.resetLayoutMenuItem': 'Reset layout',
  'shellChrome.activityBar.floatCurrentPanel': 'Float current panel',
  'shellChrome.activityBar.popOutToAnotherScreen': 'Pop out to another screen',

  // CustomizeSidebar.tsx
  'shellChrome.customizeSidebar.ariaLabel': 'Customize sidebar panels',
  'shellChrome.customizeSidebar.resetTitle': 'Reset layout: sidebar order and panels, floating panels, panes',
  'shellChrome.customizeSidebar.resetLabel': 'Reset',
  'shellChrome.customizeSidebar.moveUp': 'Move {title} up',
  'shellChrome.customizeSidebar.moveDown': 'Move {title} down',
  'shellChrome.customizeSidebar.alwaysShownAriaLabel': '{title} is always shown',
  'shellChrome.customizeSidebar.hideAriaLabel': 'Hide {title}',
  'shellChrome.customizeSidebar.alwaysShownTitle': 'Always shown',
  'shellChrome.customizeSidebar.hideFromSidebarTitle': 'Hide from sidebar',
  'shellChrome.customizeSidebar.hiddenSectionHeader': 'Hidden',
  'shellChrome.customizeSidebar.showAriaLabel': 'Show {title}',
  'shellChrome.customizeSidebar.showInSidebarTitle': 'Show in sidebar',
  'shellChrome.customizeSidebar.showLabel': 'Show',
  'shellChrome.customizeSidebar.footerHint': 'Drag a row to reorder. Hide moves a panel to Hidden; Show brings it back.',

  // SidebarDock.tsx
  'shellChrome.sidebarDock.resizeAriaLabel': 'Resize sidebar',

  // SidebarPanelHost.tsx
  'shellChrome.sidebarPanelHost.splitPanelAriaLabel': 'Split panel',
  'shellChrome.sidebarPanelHost.splitTooltip': 'Split: stack a second panel below',
  'shellChrome.sidebarPanelHost.panelBelowLabel': 'Panel below',
  'shellChrome.sidebarPanelHost.splitShowBelowLabel': 'Split: show below',
  'shellChrome.sidebarPanelHost.removeSplit': 'Remove split',
  'shellChrome.sidebarPanelHost.dragToFloatTooltip': 'Drag to float, or onto another screen to pop out',
  'shellChrome.sidebarPanelHost.collapseSidebarAriaLabel': 'Collapse sidebar to icons',
  'shellChrome.sidebarPanelHost.resizeSplitAriaLabel': 'Resize split',

  // FloatingPanel.tsx
  'shellChrome.floatingPanel.snapLeft': 'Snap left (overlay)',
  'shellChrome.floatingPanel.snapBottom': 'Snap bottom (overlay)',
  'shellChrome.floatingPanel.snapRight': 'Snap right (overlay)',
  'shellChrome.floatingPanel.freeFloat': 'Free float',
  'shellChrome.floatingPanel.dockTitle': 'Dock into sidebar (reserves space)',
  'shellChrome.floatingPanel.dockAriaLabel': 'Dock into sidebar (reserves space beside the model)',

  // PanelWindowHost.tsx
  'shellChrome.panelWindowHost.kindPip': 'Picture-in-picture',
  'shellChrome.panelWindowHost.kindWindow': 'Window',
  'shellChrome.panelWindowHost.dockTitle': 'Dock back into the sidebar',
  'shellChrome.panelWindowHost.closeWindowTitle': 'Close window',
  'shellChrome.panelWindowHost.liveSyncedNotice': 'Live · synced with the main window',

  // ViewerLayout.tsx
  'shellChrome.layout.safeModeNotice':
    'Safe mode: extensions and the active profile are not loaded for this session. Append {flag} or reload without the flag to resume.',
  'shellChrome.layout.hierarchyLabel': 'Hierarchy',
  'shellChrome.layout.openHierarchyAriaLabel': 'Open Hierarchy',
  'shellChrome.layout.openPropertiesAriaLabel': 'Open Properties',
  'shellChrome.layout.closePanelsAriaLabel': 'Close panels',
  'shellChrome.layout.analysisFallback': 'Analysis',
  'shellChrome.layout.addElementLabel': 'Add element',
  'shellChrome.layout.dragToResizeAriaLabel': 'Drag to resize or dismiss',

  // StatusBar.tsx
  'shellChrome.statusBar.loadingFallback': 'Loading...',
  'shellChrome.statusBar.ready': 'Ready',
  'shellChrome.statusBar.cancelStreamTitle': 'Cancel the model or point cloud that is loading',
  'shellChrome.statusBar.cancelButton': 'Cancel',
  'shellChrome.statusBar.elementsCount': { one: 'element', other: 'elements' },
  'shellChrome.statusBar.trisCount': { one: 'tri', other: 'tris' },
  'shellChrome.statusBar.hiddenCount': '{count} hidden',
  'shellChrome.statusBar.ghostedCount': '{count} ghosted',
  // Presentation entry point (#5508) — opens the `presentation` bottom panel.
  'shellChrome.statusBar.presentationLabel': 'Present',
  'shellChrome.statusBar.presentationTooltip': 'Presentation (views: {views}, entities: {entities})',
  'shellChrome.statusBar.fpsUnit': 'FPS',
  'shellChrome.statusBar.webgpuChecking': 'Checking...',
  'shellChrome.statusBar.webgpuLabel': 'WebGPU',
  'shellChrome.statusBar.noWebgpuLabel': 'No WebGPU',
  'shellChrome.statusBar.appVersion': 'v{version}',
  'shellChrome.statusBar.ifcliteAriaLabel': 'Visit ifclite.dev — about, docs, and packages',
  'shellChrome.statusBar.ifcliteLinkLabel': 'ifclite.dev →',

  // MobileToolbar.tsx
  'shellChrome.mobileToolbar.openFileAriaLabel': 'Open file',
  'shellChrome.mobileToolbar.addModelAriaLabel': 'Add model',
  'shellChrome.mobileToolbar.moreActionsAriaLabel': 'More actions',
  'shellChrome.mobileToolbar.commands': 'Commands…',
  'shellChrome.mobileToolbar.homeAriaLabel': 'Home',
  'shellChrome.mobileToolbar.fitAllAriaLabel': 'Fit All',
  'shellChrome.mobileToolbar.showAllAriaLabel': 'Show All',
  'shellChrome.mobileToolbar.selectTool': 'Select',
  'shellChrome.mobileToolbar.measureTool': 'Measure',
  'shellChrome.mobileToolbar.sectionTool': 'Section',
  'shellChrome.mobileToolbar.walkMode': 'Walk Mode',
  'shellChrome.mobileToolbar.isolateSelection': 'Isolate Selection',
  'shellChrome.mobileToolbar.hideSelection': 'Hide Selection',
  'shellChrome.mobileToolbar.frameSelection': 'Frame Selection',
  'shellChrome.mobileToolbar.perspective': 'Perspective',
  'shellChrome.mobileToolbar.orthographic': 'Orthographic',
  'shellChrome.mobileToolbar.exportGlb': 'Export GLB',
  'shellChrome.mobileToolbar.exportGlbSuccess': 'Exported GLB ({size} KB)',
  'shellChrome.mobileToolbar.exportGlbFailed': 'Export failed: {message}',
  'shellChrome.mobileToolbar.unknownError': 'Unknown error',
  'shellChrome.mobileToolbar.lightMode': 'Light Mode',
  'shellChrome.mobileToolbar.darkMode': 'Dark Mode',
} as const satisfies Record<string, TranslationValue>;
