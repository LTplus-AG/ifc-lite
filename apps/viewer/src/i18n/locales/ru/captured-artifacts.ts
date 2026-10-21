/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const capturedArtifactsRu = {
  "capturedArtifacts.population": "Совокупность",
  "capturedArtifacts.all": "Все элементы, соответствующие этим критериям, в загруженных файлах",
  "capturedArtifacts.selectedCaption": {
    one: "{count} выбранный элемент зафиксирован из {files}",
    few: "{count} выбранных элемента зафиксированы из {files}",
    many: "{count} выбранных элементов зафиксировано из {files}",
    other: "{count} выбранного элемента зафиксировано из {files}",
  },
  "capturedArtifacts.visibleCaption": {
    one: "{count} видимый элемент зафиксирован из {files}",
    few: "{count} видимых элемента зафиксированы из {files}",
    many: "{count} видимых элементов зафиксировано из {files}",
    other: "{count} видимого элемента зафиксировано из {files}",
  },
  "capturedArtifacts.files": {
    one: "{count} файл",
    many: "{count} файлов",
    other: "{count} файла",
  },
  "capturedArtifacts.captureSelected": "Зафиксировать выбранное",
  "capturedArtifacts.captureVisible": "Зафиксировать видимое",
  "capturedArtifacts.clear": "Очистить зафиксированное",
  "capturedArtifacts.captureFailed": "Не удалось зафиксировать эти элементы.",
} satisfies Catalogue;
