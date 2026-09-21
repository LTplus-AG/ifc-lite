/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Script tool's own chrome (#4918 slice: webgpu/script). Covers
 * `ScriptPanel.tsx`: the header (default title, saved-script selector,
 * AI-chat toggle, close), the post-authoring "install as tool" banner, the
 * run/save/save-as-tool/undo/redo/new-script/reset-sandbox toolbar and its
 * tooltips, the execution status indicators, the output console (sandbox
 * hint, "Fix with LLM", return-value label, empty state), and the delete
 * confirmation dialog.
 *
 * `'Untitled Script'` (the default name a newly created script gets, both
 * from the toolbar Save action and the "Blank Script" template) stays
 * literal: the moment `createScript`/`handleNew` runs it becomes a
 * persisted, user-renamable script name — model/user content, not view
 * chrome, same reasoning the search-modal catalogue documents for a
 * created list's default `name: 'Filter result'`.
 */
export const scriptPanelEn = {
  // Header
  'scriptPanel.header.defaultTitle': 'Script Editor',
  'scriptPanel.header.selectScriptAriaLabel': 'Select saved script',
  'scriptPanel.header.deleteMenuItem': 'Delete',
  'scriptPanel.header.hideAiChat': 'Hide AI Chat',
  'scriptPanel.header.showAiChat': 'Show AI Chat',
  'scriptPanel.header.closeAriaLabel': 'Close',

  // Post-authoring "install as tool" banner
  'scriptPanel.toolReady.title': 'This script is ready',
  'scriptPanel.toolReady.description': 'Install it as a one-click button in your toolbar.',
  'scriptPanel.toolReady.installButton': 'Install as tool',
  'scriptPanel.toolReady.dismissAriaLabel': 'Dismiss',

  // Toolbar
  'scriptPanel.toolbar.runButton': 'Run',
  'scriptPanel.toolbar.runTooltip': 'Run script (Ctrl+Enter)',
  'scriptPanel.toolbar.saveAriaLabel': 'Save script',
  'scriptPanel.toolbar.saveTooltip': 'Save (Ctrl+S)',
  'scriptPanel.toolbar.saveAsToolAriaLabel': 'Save this script as a persistent tool',
  'scriptPanel.toolbar.saveAsToolButton': 'Save as tool',
  'scriptPanel.toolbar.saveAsToolTooltip':
    'Turn this script into a permanent one-click button in your toolbar',
  'scriptPanel.toolbar.undoAriaLabel': 'Undo',
  'scriptPanel.toolbar.undoTooltip': 'Undo (Ctrl+Z)',
  'scriptPanel.toolbar.redoAriaLabel': 'Redo',
  'scriptPanel.toolbar.redoTooltip': 'Redo (Ctrl+Shift+Z)',
  'scriptPanel.toolbar.newScript': 'New script',
  'scriptPanel.toolbar.blankScriptMenuItem': 'Blank Script',
  'scriptPanel.toolbar.resetSandbox': 'Reset sandbox',

  // Execution status
  'scriptPanel.status.running': 'Running...',
  'scriptPanel.status.error': 'Error',

  // Output console
  'scriptPanel.output.header': 'Output',
  'scriptPanel.output.sandboxHintPrefix': 'Scripts run in a QuickJS sandbox — no DOM, no',
  'scriptPanel.output.fetchCode': 'fetch',
  'scriptPanel.output.sandboxHintMiddle': ', no browser globals. Use',
  'scriptPanel.output.bimCode': 'bim.*',
  'scriptPanel.output.sandboxHintSuffix': 'APIs for viewer / data / export side-effects.',
  'scriptPanel.output.fixWithLlmButton': 'Fix with LLM',
  'scriptPanel.output.returnLabel': 'Return:',
  'scriptPanel.output.emptyState': 'Press Run or Ctrl+Enter to execute',

  // Delete confirmation dialog
  'scriptPanel.deleteDialog.title': 'Delete Script',
  'scriptPanel.deleteDialog.confirmPrefix': 'Are you sure you want to delete “',
  'scriptPanel.deleteDialog.fallbackScriptName': 'this script',
  'scriptPanel.deleteDialog.confirmSuffix': '”? This action cannot be undone.',
  'scriptPanel.deleteDialog.cancelButton': 'Cancel',
  'scriptPanel.deleteDialog.deleteButton': 'Delete',
} as const;
