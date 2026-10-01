/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';
export const ionUploadEn = {
  'ionUpload.title': 'Upload to Cesium ion',
  'ionUpload.description': 'Upload one IFC model with its pending edits to your Cesium ion account. All model properties are included.',
  'ionUpload.close': 'Close',
  'ionUpload.upload': 'Upload',
  'ionUpload.uploading': 'Uploading…',
  'ionUpload.abort': 'Cancel upload',
  'ionUpload.successTitle': 'Upload accepted',
  'ionUpload.errorTitle': 'Upload did not complete',
  'ionUpload.accepted': 'Cesium ion accepted the upload and will tile it. Open the asset to check progress and placement.',
  'ionUpload.cancelled': 'Upload cancelled. Any asset already created remains in Cesium ion; you can remove it there.',
  'ionUpload.failed': '{phase} failed (HTTP {status}). Check your token permissions and the asset in Cesium ion before retrying.',
  'ionUpload.exportWarnings': 'IFC preparation reported {count} warnings. Export IFC locally and resolve them before uploading.',
  'ionUpload.serializationFailed': 'Could not prepare the edited IFC. Try exporting IFC locally to check the model.',
  'ionUpload.texturesUnsupported': 'This model includes image resources. Export IFCZIP locally to preserve its images. Direct texture upload is not supported yet.',
  'ionUpload.noModel': 'Load a STEP IFC model to upload. IFCX and LandXML are not supported.',
  'ionUpload.openAsset': 'Open asset {id} in Cesium ion',
  'ionUpload.model': 'Model',
  'ionUpload.token': 'Cesium ion token (assets:write)',
  'ionUpload.tokenHelp': 'Use a separate token with assets:write permission. It is kept in memory until this dialog closes, and is never saved or sent to analytics.',
  'ionUpload.createToken': 'Create a token',
  'ionUpload.placement': 'Cesium ion uses the georeferencing stored in the exported IFC. For models without georeferencing, set their location in Cesium ion after uploading.',
  'ionUpload.phase.serialize': 'Preparing edited IFC…',
  'ionUpload.phase.create': 'Creating asset…',
  'ionUpload.phase.upload': 'Uploading IFC…',
  'ionUpload.phase.complete': 'Starting tiling…',
} as const satisfies Record<string, TranslationValue>;
