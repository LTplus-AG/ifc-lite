/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The one activity tray for user-initiated jobs (U02, #6925): model loads,
 * clash and validation runs, exports, assistant requests, Flow runs and BCF
 * publication (`components/viewer/activity/`, `lib/activity/`).
 */
export const activityTrayEn = {
  'activityTray.button': 'Activity',
  'activityTray.buttonRunning': { one: 'Activity: {count} job running', other: 'Activity: {count} jobs running' },
  'activityTray.title': 'Activity',
  'activityTray.empty': 'No jobs in this session yet.',
  'activityTray.list': 'Jobs',
  'activityTray.cancel': 'Cancel',
  'activityTray.cancelLabel': 'Cancel {title}',
  'activityTray.open': 'Open',
  'activityTray.openLabel': 'Open {title}',
  'activityTray.clearFinished': 'Clear finished',
  'activityTray.persistent': 'Kept across reloads',
  'activityTray.interruptedHint': 'The page closed while this ran. It did not finish; run it again.',
  'activityTray.failureNoDetail': 'The job failed without an explanation from its source.',
  'activityTray.publication.empty': 'No server effects were queued.',
  'activityTray.progress': '{done} of {total}',
  // Spoken when a job finishes while the viewer is open: "Export (Export IFC): Failed".
  'activityTray.announce': '{title}: {status}',
  'activityTray.announceSubject': '{title} ({subject}): {status}',


  'activityTray.job.load': 'Load model',
  'activityTray.job.sourceDownload': 'Download source files',
  'activityTray.sourceDownload.partialCancelled': { one: 'Cancelled after dispatching {count} file for loading. Dispatched files remain available.', other: 'Cancelled after dispatching {count} files for loading. Dispatched files remain available.' },
  'activityTray.sourceDownload.partialFailed': { one: 'Dispatched {count} file for loading; some downloads failed. Dispatched files remain available.', other: 'Dispatched {count} files for loading; some downloads failed. Dispatched files remain available.' },
  'activityTray.sourceDownload.failed': { one: '{count} download failed; no files were dispatched for loading.', other: '{count} downloads failed; no files were dispatched for loading.' },
  'activityTray.job.clash': 'Clash detection',
  'activityTray.job.validation': 'Data validation',
  'activityTray.job.list': 'List execution',
  'activityTray.job.bulk': 'Bulk property update',
  'activityTray.bulk.cancelledWithChanges': { one: 'Cancelled after changing {count} entity. Applied changes remain available to undo.', other: 'Cancelled after changing {count} entities. Applied changes remain available to undo.' },
  'activityTray.bulk.failedWithChanges': { one: 'Changed {count} entity; some updates failed. Applied changes remain available to undo.', other: 'Changed {count} entities; some updates failed. Applied changes remain available to undo.' },
  'activityTray.job.flow': 'Flow run',
  'activityTray.job.ai': 'Assistant request',
  'activityTray.job.export': 'Export',
  'activityTray.job.zoneGeometry': 'Export zone geometry',
  'activityTray.job.zoneTable': 'Export zone quantities',
  'activityTray.zone.geometryPartial': 'Published {whole} whole and {cut} cut elements; {refused} refused and {missing} without geometry.',
  'activityTray.zone.tablePartial': { one: 'Published the table with {count} unmeasured quantity row; its reason remains in the table.', other: 'Published the table with {count} unmeasured quantity rows; their reasons remain in the table.' },
  'activityTray.job.validationBcf': 'Export validation report as BCF',
  'activityTray.job.publication': 'BCF publication',

  'activityTray.publication.effects': '{done} of {total} server effects done',
  'activityTray.publication.attention': { one: '{count} effect needs a server check', other: '{count} effects need a server check' },
  'activityTray.publication.failed': { one: '{count} effect failed', other: '{count} effects failed' },
  'activityTray.ai.timeout': 'Timed out',
  'activityTray.ai.truncated': 'Stopped at the output limit',
} as const satisfies Record<string, TranslationValue>;
