/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared analysis-panel chrome (#5834): the header run slot, the stale
 * banner (#5820), the export split button and the demo-data empty state that
 * IDS, Clash, Compare and BCF render through `components/viewer/analysis/`.
 * Panel-specific wording (what a run is called, what a format exports) stays
 * in each panel's own catalogue and is passed in.
 */
export const analysisPanelEn = {
  'analysisStale.message': 'The model changed since this analysis ran. These results may be out of date.',
  'analysisStale.rerun': 'Re-run',
  'analysisPanel.rerun': 'Re-run',
  'analysisPanel.cancel': 'Cancel',
  'analysisPanel.clearResults': 'Clear results',
  'analysisPanel.close': 'Close',
  'analysisPanel.dismissError': 'Dismiss error',
  'analysisPanel.export.chooseFormat': 'Choose export format',
  'analysisPanel.export.default': 'default',
  'analysisPanel.demo.try': 'Try with demo data',
  'analysisPanel.demo.loading': 'Loading demo data…',
  'analysisPanel.demo.failed': 'The demo data could not be loaded.',
} as const;
