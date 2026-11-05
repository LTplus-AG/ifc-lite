/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const capturedArtifactsDe = {
  "capturedArtifacts.population": "Grundgesamtheit",
  "capturedArtifacts.all": "Alle Bauteile, die diesen Kriterien entsprechen, in geladenen Dateien",
  "capturedArtifacts.selectedCaption": {"one": "{count} ausgewähltes Bauteil aus {files} erfasst", "other": "{count} ausgewählte Bauteile aus {files} erfasst"},
  "capturedArtifacts.visibleCaption": {"one": "{count} sichtbares Bauteil aus {files} erfasst", "other": "{count} sichtbare Bauteile aus {files} erfasst"},
  "capturedArtifacts.files": {"one": "{count} Datei", "other": "{count} Dateien"},
  "capturedArtifacts.captureSelected": "Auswahl erfassen",
  "capturedArtifacts.captureVisible": "Sichtbare erfassen",
  "capturedArtifacts.clear": "Erfassung löschen",
  "capturedArtifacts.captureFailed": "Diese Bauteile konnten nicht erfasst werden.",
} satisfies Catalogue;
