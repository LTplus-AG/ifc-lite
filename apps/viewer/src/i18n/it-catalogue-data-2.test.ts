/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { catalogueBatchContract } from './__tests__/catalogue-batch';

catalogueBatchContract('it', 8906, [
  'commands',
  'compare-analysis',
  'compare-key-property',
  'compare-panel',
  'copy-array',
  'cost-panel',
  'cost-review',
  'curtain-grid',
  'custom-grouping',
  'data-connector',
  'deviation-stats',
  'document',
  'document-menu',
  'drawing-underlay',
  'error-report',
  'export-dialog',
  'extensions-flavors',
  'extensions-panels',
  'extrusion-inspection',
  'filter-groups',
  'filter-operators',
  'flow-assistant',
  'flow-panel',
  'flow-review',
  'flow-startup',
  'gantt-work-calendar',
  'gaussian-capture',
  'geometry-export-dialogs',
  'georeferencing',
  'group-review',
  'hierarchy',
  'hosted-place',
  'ids-agent',
  'ids-panel',
  'ids-studio',
  'ifc-federation-assumptions',
  'influx',
  'ion-upload',
  'keyboard-shortcuts',
  'landxml',
  'landxml-georef-assumptions',
  'landxml-terrain-export',
]);

// #8906: rendered guidance must distinguish local loading, recovery, and privacy boundaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerLocale, resolve, setLocale } from './registry';
import { requiredModule } from './__tests__/required-module';

test('#8906 Italian recovery and privacy guidance states the effective action', async () => {
  const { activityTrayIt } = await requiredModule(() => import('./locales/it/activity-tray'), 'activity-tray: Italian guidance must be available');
  const { anonymizedExportIt } = await requiredModule(() => import('./locales/it/anonymized-export'), 'anonymized-export: Italian guidance must be available');
  const { copyArrayIt } = await requiredModule(() => import('./locales/it/copy-array'), 'copy-array: Italian guidance must be available');
  const { extensionsPanelsIt } = await requiredModule(() => import('./locales/it/extensions-panels'), 'extensions-panels: Italian guidance must be available');
  const { flowPanelIt } = await requiredModule(() => import('./locales/it/flow-panel'), 'flow-panel: Italian guidance must be available');
  registerLocale('it', { ...activityTrayIt, ...anonymizedExportIt, ...copyArrayIt, ...extensionsPanelsIt, ...flowPanelIt });
  setLocale('it');
  try {
    for (const count of [1, 2, 1_000_000]) {
      for (const key of ['activityTray.sourceDownload.partialCancelled', 'activityTray.sourceDownload.partialFailed', 'activityTray.sourceDownload.failed'] as const) {
        const message = resolve(key, { count });
        assert.match(message, /caricamento.*nel visualizzatore/);
        assert.doesNotMatch(message, /inviat/);
      }
    }
    assert.match(resolve('copyArray.paste.stale'), /non possono più essere incollati.*copiali di nuovo/);
    assert.match(resolve('flowPanel.contributed.diagnostics', { count: 3 }), /non hanno superato la convalida: 3.*console/);
    const description = resolve('anonymizedExport.dialog.description');
    assert.match(description, /solo le categorie selezionate/);
    assert.match(description, /Mantieni conservano i valori originali/);
    for (const key of ['extensionsPanels.ideasPanel.helpPrivacy', 'extensionsPanels.ideasPanel.footerPrivacy'] as const) {
      const message = resolve(key);
      assert.match(message, /registro delle azioni resta locale/);
      assert.match(message, /idee.*chat IA.*messaggi inviati al fornitore IA configurato/);
    }
  } finally { setLocale('en'); }
});
