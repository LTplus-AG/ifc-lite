/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The extensions/flavors surface's own chrome (#4918 sweep):
 * `FlavorListView`, `ExtensionsPanel`, `FlavorDialog`, `FlavorMergeDialog`,
 * `FlavorImportPreview`, `FlavorIndicator`, `HelpHint`, `BundlePreview`,
 * `ExtensionDockHost`, `ExtensionExportSlot`, `ExtensionToolbarSlot`.
 *
 * Deliberately NOT covered — runtime/extension-contributed content, not a
 * literal authored in this repo:
 *  - `flavor.name` / `flavor.description` (user-authored flavor metadata)
 *  - installed extension `record.id` / `record.version` / capability ids
 *  - `contribution.payload.title` / `.name` (extension manifest strings,
 *    `ExtensionDockHost` tab titles, `ExtensionExportSlot` exporter names,
 *    `ExtensionToolbarSlot` command titles)
 *  - bundle file paths / source text (`BundlePreview`)
 *
 * Multi-paragraph `HelpHint` bodies (`ExtensionsPanel`, `FlavorDialog`) are
 * flattened to plain sentences rather than kept as `<strong>`-styled
 * fragments: per the i18n README, a translator gets one complete message
 * per paragraph instead of assembling bolded words back into a sentence.
 */
export const extensionsFlavorsEn = {
  // ── FlavorListView ──
  'extensionsFlavors.flavorListView.intro':
    'Profiles bundle your extensions, lenses, queries, clash rules, and layout. Switch to isolate experiments; export to share or back up.',
  'extensionsFlavors.flavorListView.saveCurrentAriaLabel': 'Save current setup as a new profile',
  'extensionsFlavors.flavorListView.createNewAriaLabel': 'Create a new empty profile',
  'extensionsFlavors.flavorListView.saveCurrentLabel': 'Save current as profile',
  'extensionsFlavors.flavorListView.newFlavorLabel': 'New profile',
  'extensionsFlavors.flavorListView.importButton': 'Import',
  'extensionsFlavors.flavorListView.resetTitle': 'Recreate the Default baseline profile',
  'extensionsFlavors.flavorListView.resetButton': 'Reset',
  'extensionsFlavors.flavorListView.nameSnapshotLabel': {
    one: 'Name this profile (will snapshot {countDisplay} lens)',
    other: 'Name this profile (will snapshot {countDisplay} lenses)',
  },
  'extensionsFlavors.flavorListView.nameEmptyLabel': 'Name this new empty profile',
  'extensionsFlavors.flavorListView.placeholderSnapshot': 'Cost estimating',
  'extensionsFlavors.flavorListView.placeholderEmpty': 'Empty workspace',
  'extensionsFlavors.flavorListView.switchToEmptyTitle': 'Switch to empty profile',
  'extensionsFlavors.flavorListView.switchToSnapshotTitle': 'Switch to snapshot of current state',
  'extensionsFlavors.flavorListView.modeLabelSnapshot': 'snapshot',
  'extensionsFlavors.flavorListView.modeLabelEmpty': 'empty',
  'extensionsFlavors.flavorListView.createButton': 'Create',
  'extensionsFlavors.flavorListView.cancelButton': 'Cancel',
  'extensionsFlavors.flavorListView.emptyState':
    'No profiles yet. Click {newFlavor} above, {reset} for the baseline, or {import} a .iflv.',
  'extensionsFlavors.flavorListView.saveNameAriaLabel': 'Save name',
  'extensionsFlavors.flavorListView.cancelRenameAriaLabel': 'Cancel rename',
  'extensionsFlavors.flavorListView.renameAriaLabel': 'Rename {name}',
  'extensionsFlavors.flavorListView.clickToRenameTitle': 'Click to rename',
  'extensionsFlavors.flavorListView.activeBadge': 'Active',
  'extensionsFlavors.flavorListView.uncapturedTitle': {
    one: '{countDisplay} lens in viewer not yet captured',
    other: '{countDisplay} lenses in viewer not yet captured',
  },
  'extensionsFlavors.flavorListView.uncapturedBadge': '{count} uncaptured',
  'extensionsFlavors.flavorListView.statsLine':
    '{ext} ext · {lens} lens · {qry} qry · {clash} clash · updated {date}',
  'extensionsFlavors.flavorListView.activateButton': 'Activate',
  'extensionsFlavors.flavorListView.captureAriaLabel': 'Capture current viewer state into {name}',
  'extensionsFlavors.flavorListView.captureTitleUncaptured':
    'Save current viewer state into {name} ({count} new)',
  'extensionsFlavors.flavorListView.captureTitleSnapshot': 'Snapshot current viewer state into {name}',
  'extensionsFlavors.flavorListView.renameTitle': 'Rename',
  'extensionsFlavors.flavorListView.duplicateAriaLabel': 'Duplicate {name}',
  'extensionsFlavors.flavorListView.duplicateTitle': 'Duplicate',
  'extensionsFlavors.flavorListView.exportAriaLabel': 'Export {name}',
  'extensionsFlavors.flavorListView.exportTitle': 'Export as .iflv',
  'extensionsFlavors.flavorListView.deleteAriaLabel': 'Delete {name}',
  'extensionsFlavors.flavorListView.deleteTitle': 'Delete',

  // ── ExtensionsPanel ──
  'extensionsFlavors.extensionsPanel.heading': 'Extensions',
  'extensionsFlavors.extensionsPanel.activeFlavorTitle': 'Active profile: {name}. Click to manage.',
  'extensionsFlavors.extensionsPanel.activeFlavorAriaLabel':
    'Active profile: {name}. Click to open the profile dialog.',
  'extensionsFlavors.extensionsPanel.helpHint.intro':
    'Extensions are sandboxed bundles of JavaScript that add buttons, panels, lenses, or exporters to the viewer.',
  'extensionsFlavors.extensionsPanel.helpHint.tabStripInfo':
    'The tab strip below jumps to: Ideas (mined patterns + starter suggestions), Repair (SDK-update compatibility check), Audit (lifecycle ledger), Privacy (action-log controls + prompt overlay).',
  'extensionsFlavors.extensionsPanel.helpHint.gettingStarted':
    'Get started by describing one in chat, browsing starter ideas, or importing a .iflx bundle.',
  'extensionsFlavors.extensionsPanel.helpHint.docLinkLabel': 'Read the Extensions guide →',
  'extensionsFlavors.extensionsPanel.importButton': 'Import',
  'extensionsFlavors.extensionsPanel.closeAriaLabel': 'Close extensions panel',
  'extensionsFlavors.extensionsPanel.tabStripAriaLabel': 'Extension surfaces',
  'extensionsFlavors.extensionsPanel.tab.installed': 'Installed',
  'extensionsFlavors.extensionsPanel.tab.ideas': 'Ideas',
  'extensionsFlavors.extensionsPanel.tab.repair': 'Repair',
  'extensionsFlavors.extensionsPanel.tab.audit': 'Audit',
  'extensionsFlavors.extensionsPanel.emptyState.title': 'No extensions installed',
  'extensionsFlavors.extensionsPanel.emptyState.description':
    'Extensions are sandboxed bundles that add commands, lenses, panels, or exporters. You can install one three ways:',
  'extensionsFlavors.extensionsPanel.emptyState.describeInChat': 'Describe one in chat (AI authors it)',
  'extensionsFlavors.extensionsPanel.emptyState.authoringPrompt':
    'Author an extension for me. Help me describe it: what should it do?',
  'extensionsFlavors.extensionsPanel.emptyState.browseIdeas': 'Browse starter ideas',
  'extensionsFlavors.extensionsPanel.emptyState.importFile': 'Import a .iflx file',
  'extensionsFlavors.extensionsPanel.emptyState.cliHint':
    'All extensions run in a sandbox with explicit capability grants. Build one from the CLI with ifc-lite ext init.',
  'extensionsFlavors.extensionsPanel.row.stats': {
    one: 'v{version} · {countDisplay} capability · {date}',
    other: 'v{version} · {countDisplay} capabilities · {date}',
  },
  'extensionsFlavors.extensionsPanel.row.forkAriaLabel': 'Fork {id}',
  'extensionsFlavors.extensionsPanel.row.forkTitle': 'Fork: edit this extension in the chat',
  'extensionsFlavors.extensionsPanel.row.runTestsAriaLabel': 'Run tests for {id}',
  'extensionsFlavors.extensionsPanel.toast.testsRunning': 'Running tests for {id}…',
  'extensionsFlavors.extensionsPanel.toast.testsNotDeclared': '{id} declares no tests',
  'extensionsFlavors.extensionsPanel.toast.testsPassed': {
    one: '{id}: {passed}/{total} test passed',
    other: '{id}: {passed}/{total} tests passed',
  },
  'extensionsFlavors.extensionsPanel.toast.testsFailed': {
    one: '{id}: {failed} test failed — {error}',
    other: '{id}: {failed} tests failed — {error}',
  },
  'extensionsFlavors.extensionsPanel.toast.testsRunFailed': 'Tests for {id} failed — {error}',
  'extensionsFlavors.extensionsPanel.row.disableAriaLabel': 'Disable extension',
  'extensionsFlavors.extensionsPanel.row.enableAriaLabel': 'Enable extension',
  'extensionsFlavors.extensionsPanel.row.uninstallAriaLabel': 'Uninstall {id}',
  'extensionsFlavors.extensionsPanel.row.moreCapabilities': '+{count} more',
  'extensionsFlavors.extensionsPanel.unknownError': 'unknown error',
  'extensionsFlavors.extensionsPanel.confirmUninstall': 'Uninstall {id}?',
  'extensionsFlavors.extensionsPanel.operation.enable': 'Enable',
  'extensionsFlavors.extensionsPanel.operation.disable': 'Disable',
  'extensionsFlavors.extensionsPanel.operation.uninstall': 'Uninstall',
  'extensionsFlavors.extensionsPanel.toast.expectedBundle':
    'Expected a .iflx extension bundle, got {filename}.',
  'extensionsFlavors.extensionsPanel.toast.bundleUnpackFailed':
    'Bundle did not unpack: {error}',
  'extensionsFlavors.extensionsPanel.toast.readFileFailed': 'Failed to read file: {error}',
  'extensionsFlavors.extensionsPanel.toast.authoredBundleUnpackFailed':
    "Authored bundle didn't unpack: {error}",
  'extensionsFlavors.extensionsPanel.toast.authoredBundlePreviewFailed':
    'Authored bundle preview failed: {error}',
  'extensionsFlavors.extensionsPanel.toast.installed': '{id} v{version} installed',
  'extensionsFlavors.extensionsPanel.toast.storageFull':
    'Out of browser storage. Uninstall an extension or clear some profiles, then retry.',
  'extensionsFlavors.extensionsPanel.toast.installRejected': 'Install rejected: {error}',
  'extensionsFlavors.extensionsPanel.toast.installFailed': 'Install failed: {error}',
  'extensionsFlavors.extensionsPanel.toast.operationFailed': '{operation} failed — {error}',

  // ── FlavorDialog ──
  'extensionsFlavors.flavorDialog.title': 'Profiles',
  'extensionsFlavors.flavorDialog.helpHint.p1':
    'A profile bundles your installed extensions, lenses, saved queries, layout, settings, and prompt overlay into a switchable profile.',
  'extensionsFlavors.flavorDialog.helpHint.p2':
    'New profile / Save current as profile creates one (empty or snapshotted from your current viewer state).',
  'extensionsFlavors.flavorDialog.helpHint.p3':
    'Per-row: Activate switches to it (lenses restore). Camera captures the current viewer state into THAT profile (not just the active one). Click the name to rename. Copy duplicates, Download exports a .iflv.',
  'extensionsFlavors.flavorDialog.helpHint.p4':
    'Import previews a .iflv then offers replace / save-as-new / three-way merge. Reset restores the empty baseline.',
  'extensionsFlavors.flavorDialog.confirmDelete': 'Delete profile {id}?',
  'extensionsFlavors.flavorDialog.confirmReset': 'Reset to baseline profile? Other profiles are preserved.',
  'extensionsFlavors.flavorDialog.snapshotDescription': 'Captured from current viewer state.',
  'extensionsFlavors.flavorDialog.emptyDescription': 'New empty profile.',
  'extensionsFlavors.flavorDialog.operation.export': 'Export',
  'extensionsFlavors.flavorDialog.operation.activate': 'Activate',
  'extensionsFlavors.flavorDialog.operation.delete': 'Delete',
  'extensionsFlavors.flavorDialog.operation.capture': 'Capture',
  'extensionsFlavors.flavorDialog.operation.create': 'Create',
  'extensionsFlavors.flavorDialog.operation.rename': 'Rename',
  'extensionsFlavors.flavorDialog.operation.duplicate': 'Duplicate',
  'extensionsFlavors.flavorDialog.operation.reset': 'Reset',
  'extensionsFlavors.flavorDialog.operation.preview': 'Preview',
  'extensionsFlavors.flavorDialog.operation.import': 'Import',
  'extensionsFlavors.flavorDialog.toast.failure': '{operation} failed — {cause}',
  'extensionsFlavors.flavorDialog.toast.exported': 'Exported {filename}',
  'extensionsFlavors.flavorDialog.toast.switched': 'Switched to {id}',
  'extensionsFlavors.flavorDialog.part.lenses': 'saved lenses',
  'extensionsFlavors.flavorDialog.part.clash': 'clash settings',
  'extensionsFlavors.flavorDialog.part.layout': 'panel layout',
  'extensionsFlavors.flavorDialog.reason.storageQuota': 'Browser storage is full.',
  'extensionsFlavors.flavorDialog.reason.storageUnavailable': 'Browser storage is unavailable.',
  'extensionsFlavors.flavorDialog.reason.serialization': 'Saved data could not be serialized.',
  'extensionsFlavors.flavorDialog.reason.tooManyClashRules': 'There are too many saved clash rules.',
  'extensionsFlavors.flavorDialog.reason.clashDataUnreadable': 'Saved clash data could not be read.',
  'extensionsFlavors.flavorDialog.reason.clashRollbackFailed':
    'Saved clash data may no longer match what is shown.',
  'extensionsFlavors.flavorDialog.toast.switchedPartially':
    'Switched to {id}, but its {parts} could not be applied — {reasons}',
  'extensionsFlavors.flavorDialog.toast.deleted': 'Deleted {id}',
  'extensionsFlavors.flavorDialog.toast.notFound': 'Profile "{id}" not found.',
  'extensionsFlavors.flavorDialog.toast.captured': {
    one: 'Captured {countDisplay} lens + clash rules + sidebar layout into {name}',
    other: 'Captured {countDisplay} lenses + clash rules + sidebar layout into {name}',
  },
  'extensionsFlavors.flavorDialog.toast.createdSnapshot': {
    one: 'Created "{name}" with {countDisplay} lens.',
    other: 'Created "{name}" with {countDisplay} lenses.',
  },
  'extensionsFlavors.flavorDialog.toast.createdEmpty': 'Created "{name}".',
  'extensionsFlavors.flavorDialog.toast.renamed': 'Renamed to "{name}".',
  'extensionsFlavors.flavorDialog.duplicateName': '{name} (copy)',
  'extensionsFlavors.flavorDialog.toast.duplicated': 'Duplicated as "{name}".',
  'extensionsFlavors.flavorDialog.toast.reset': 'Reset to baseline profile',
  'extensionsFlavors.flavorDialog.toast.expectedFile': 'Expected a .iflv profile file, got {filename}.',
  'extensionsFlavors.flavorDialog.toast.imported': 'Imported {name}',
  'extensionsFlavors.flavorDialog.toast.storageFull':
    'Out of browser storage — delete a profile or extension and try again.',

  // ── FlavorMergeDialog ──
  'extensionsFlavors.flavorMergeDialog.title': 'Merge profile',
  'extensionsFlavors.flavorMergeDialog.noActiveFlavor':
    'No active profile — switch to a profile first, then retry the merge.',
  'extensionsFlavors.flavorMergeDialog.computing': 'Computing merge…',
  'extensionsFlavors.flavorMergeDialog.cleanMerge': 'Clean merge — no conflicts between {theirs} and {ours}.',
  'extensionsFlavors.flavorMergeDialog.cancelButton': 'Cancel',
  'extensionsFlavors.flavorMergeDialog.saveButton': 'Save merged profile',
  'extensionsFlavors.flavorMergeDialog.conflictSummary': {
    one: '{countDisplay} conflict between {theirs} (theirs) and {ours} (ours).',
    other: '{countDisplay} conflicts between {theirs} (theirs) and {ours} (ours).',
  },
  'extensionsFlavors.flavorMergeDialog.resolveAriaLabel': 'Resolve {kind} conflict on {key}',
  'extensionsFlavors.flavorMergeDialog.conflictKind.extensionVersion': 'Extension version',
  'extensionsFlavors.flavorMergeDialog.conflictKind.extensionCapabilities':
    'Extension capabilities',
  'extensionsFlavors.flavorMergeDialog.conflictKind.lens': 'Lens',
  'extensionsFlavors.flavorMergeDialog.conflictKind.savedQuery': 'Saved query',
  'extensionsFlavors.flavorMergeDialog.conflictKind.keybinding': 'Keybinding',
  'extensionsFlavors.flavorMergeDialog.conflictKind.setting': 'Setting',
  'extensionsFlavors.flavorMergeDialog.theirsLabel': 'Theirs',
  'extensionsFlavors.flavorMergeDialog.oursLabel': 'Ours',
  'extensionsFlavors.flavorMergeDialog.baseLabel': 'Base',
  'extensionsFlavors.flavorMergeDialog.pickAriaLabel': 'Pick {label}',
  'extensionsFlavors.flavorMergeDialog.toast.merged': 'Merged into {id}',
  'extensionsFlavors.flavorMergeDialog.toast.failed': 'Merge failed: {error}',

  // ── FlavorImportPreview ──
  'extensionsFlavors.flavorImportPreview.title': 'Import preview',
  'extensionsFlavors.flavorImportPreview.nameLabel': 'Name:',
  'extensionsFlavors.flavorImportPreview.idLabel': 'ID:',
  'extensionsFlavors.flavorImportPreview.statsLine': '{extensions} extensions · {lenses} lenses · {queries} queries',
  'extensionsFlavors.flavorImportPreview.cancelButton': 'Cancel',
  'extensionsFlavors.flavorImportPreview.mergeButton': 'Merge…',
  'extensionsFlavors.flavorImportPreview.saveAsNewButton': 'Save as new',
  'extensionsFlavors.flavorImportPreview.replaceButton': 'Replace existing',

  // ── FlavorIndicator ──
  'extensionsFlavors.flavorIndicator.activeAriaLabel': 'Active profile: {name}. Click to manage profiles.',
  'extensionsFlavors.flavorIndicator.inactiveAriaLabel': 'No active profile. Click to manage profiles.',
  'extensionsFlavors.flavorIndicator.activeTitle':
    'Profiles bundle your extensions, lenses, queries, and overlay.\nActive: {name}\nClick to switch / export / import / merge.',
  'extensionsFlavors.flavorIndicator.activeTitleWithDescription':
    'Profiles bundle your extensions, lenses, queries, and overlay.\nActive: {name}\n{description}\nClick to switch / export / import / merge.',
  'extensionsFlavors.flavorIndicator.inactiveTitle':
    'Profiles bundle your extensions, lenses, and settings.\nClick to manage.',
  'extensionsFlavors.flavorIndicator.defaultLabel': 'Default',
  'extensionsFlavors.flavorIndicator.defaultDescription':
    'Baseline profile — no extensions, no overrides.',

  // ── HelpHint ──
  'extensionsFlavors.helpHint.ariaLabel': 'Help: {label}',
  'extensionsFlavors.helpHint.learnMoreDefault': 'Learn more →',

  // ── BundlePreview ──
  'extensionsFlavors.bundlePreview.bundleFilesAriaLabel': 'Bundle files',
  'extensionsFlavors.bundlePreview.viewFileAriaLabel': 'View {path}',
  'extensionsFlavors.bundlePreview.copyAriaLabel': 'Copy file contents',
  'extensionsFlavors.bundlePreview.copyButton': 'Copy',
  'extensionsFlavors.bundlePreview.copySuccessToast': 'Copied {path} to clipboard',
  'extensionsFlavors.bundlePreview.copyFailedToast': 'Copy failed: {error}',

  // ── ExtensionDockHost ──
  'extensionsFlavors.extensionDockHost.dockAriaLabel': 'Extension dock ({slot})',
  'extensionsFlavors.extensionDockHost.loadingWidget': 'Loading widget…',

  // ── ExtensionToolbarSlot ──
  'extensionsFlavors.extensionToolbarSlot.runAriaLabel': 'Run {title}',
} as const satisfies Record<string, TranslationValue>;
