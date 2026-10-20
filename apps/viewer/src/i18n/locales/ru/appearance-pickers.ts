/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const appearancePickersRu = {
  "appearance.scan.surfaceSource": "{model} · Поверхность {number}",
  "appearance.scan.pointCloudSource": "{model} · Облако точек (сохранено точек {retained} из {seen})",
  "appearance.facePicker.error.miss": "Под указателем нет видимой поверхности.",
  "appearance.facePicker.error.differentSurface": "Выберите грань объекта, открытого в редакторе граней.",
  "appearance.facePicker.error.ambiguous": "У этой отображаемой грани нет точного идентификатора источника. Перезагрузите модель и повторите попытку.",
  "appearance.facePicker.error.busy": "Дождитесь завершения предварительного просмотра текущего внешнего вида.",
} satisfies Catalogue;
