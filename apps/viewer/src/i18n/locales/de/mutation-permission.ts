/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const mutationPermissionDe = {
  'mutationPermission.workflowRunning': 'Warten Sie, bis die Workflow-Prüfung oder die PDF-Erfassung abgeschlossen ist, oder brechen Sie den Workflow ab',
  'mutationPermission.editModeRequired': 'Aktivieren Sie den Bearbeitungsmodus, um dieses Modell zu ändern',
  'mutationPermission.roleRequired': 'Zum Bearbeiten ist in dieser geteilten Sitzung Bearbeiterzugriff erforderlich',
  'mutationPermission.modelUnavailable': 'Dieses Modell enthält keine bearbeitbaren IFC-Daten',
  'mutationPermission.propertiesLoading': 'Die Eigenschaften des Modells werden noch geladen',
  'mutationPermission.propertiesFailed': 'Die Eigenschaften des Modells konnten nicht geladen werden, daher ist es nicht bearbeitbar',
  'mutationPermission.idSpaceExhausted': 'Dieses Modell hat mehr Entitäten als der dafür reservierte Bereich und kann in dieser Sitzung nicht bearbeitet werden',
} satisfies Catalogue;
