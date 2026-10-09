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
  'ionUpload.successTitle': 'Submitted for tiling',
  'ionUpload.errorTitle': 'Upload did not complete',
  'ionUpload.accepted': 'Cesium ion accepted the upload and will tile it. Open the asset to check progress and placement.',
  'ionUpload.cancelled': 'Upload cancelled. Any asset already created remains in Cesium ion; you can remove it there.',
  'ionUpload.failed': '{phase} failed (HTTP {status}). {help}',
  'ionUpload.failure.authorization': 'The token cannot create assets. Use a token with the assets:write scope (the default token only reads), and check its allowed URLs in Cesium ion.',
  'ionUpload.failure.conflict': 'Cesium ion rejected the upload request. If retrying fails, report this error with its HTTP status.',
  'ionUpload.failure.capacity': 'Check the account plan, storage allowance and upload size in Cesium ion before retrying.',
  'ionUpload.failure.rateLimit': 'Cesium ion is limiting requests. Wait before retrying.',
  'ionUpload.failure.service': 'Cesium ion could not complete this request. Check its service status before retrying.',
  'ionUpload.failure.request': 'Check the connection and the asset in Cesium ion before retrying. The upload may not have completed.',
  'ionUpload.exportWarnings': {
    one: 'Preparing the IFC for Cesium ion reported a problem, so nothing was uploaded.',
    other: 'Preparing the IFC for Cesium ion reported {count} problems, so nothing was uploaded.',
  },
  'ionUpload.serializationFailed': 'Could not prepare the edited IFC. Try exporting IFC locally to check the model.',
  'ionUpload.texturesUnsupported': 'This model includes image resources. Export IFCZIP locally to preserve its images. Direct texture upload is not supported yet.',
  'ionUpload.noModel': 'Load a STEP IFC model to upload. IFCX and LandXML are not supported.',
  'ionUpload.openAsset': 'View {name} in Cesium ion',
  'ionUpload.model': 'Model',
  'ionUpload.token': 'Cesium ion token (assets:write)',
  'ionUpload.tokenHelp': 'Use a separate token with assets:write permission. It is kept in memory until this dialog closes, and is never saved or sent to analytics.',
  'ionUpload.createToken': 'Create a token',
  'ionUpload.placement': 'The upload preserves your IFC georeferencing. After tiling, verify location, orientation and elevation in Cesium ion. For models without georeferencing, set their location there.',
  'ionUpload.phase.serialize': 'Preparing edited IFC…',
  'ionUpload.phase.create': 'Creating asset…',
  'ionUpload.phase.upload': 'Uploading IFC…',
  'ionUpload.phase.complete': 'Starting tiling…',
} as const satisfies Record<string, TranslationValue>;
