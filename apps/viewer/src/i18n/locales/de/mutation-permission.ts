/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const mutationPermissionDe = {
  'mutationPermission.workflowRunning': 'Warten Sie, bis die Workflow-Prüfung oder die PDF-Erfassung abgeschlossen ist, oder brechen Sie den Workflow ab',
  'mutationPermission.editModeRequired': 'Aktivieren Sie den Bearbeitungsmodus, um dieses Modell zu ändern',
  'mutationPermission.roleRequired': 'Zum Bearbeiten ist in dieser geteilten Sitzung Bearbeiterzugriff erforderlich',
  'mutationPermission.modelUnavailable': 'Dieses Modell enthält keine bearbeitbaren IFC-Daten',
} satisfies Catalogue;
