/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const sweptDiskInspectionRu = {
  "properties.sweptDisk.heading": "Производная исходная геометрия",
  "properties.sweptDisk.sourceNote": "Размеры направляющей, вычисленные по исходной геометрии. Атрибуты IFC и значения IfcElementQuantity указаны отдельно.",
  "properties.sweptDisk.loading": "Чтение выбранной геометрии источника…",
  "properties.sweptDisk.empty": "У выбранного нет исходной геометрии тела с круговым сечением",
  "properties.sweptDisk.solid": "IfcSweptDiskSolid #{id}",
  "properties.sweptDisk.status": "Описание",
  "properties.sweptDisk.complete": "Завершено",
  "properties.sweptDisk.unsupported": "Неподдерживаемый",
  "properties.sweptDisk.sourceModified": "Источник изменён операциями CSG",
  "properties.sweptDisk.modifiedHint": "Исходная направляющая может отличаться от видимого результата.",
  "properties.sweptDisk.modifiedHighlightHint": "Исходный сегмент не может быть выделен на фоне сетки, модифицированной CSG.",
  "properties.sweptDisk.yes": "Да",
  "properties.sweptDisk.no": "Нет",
  "properties.sweptDisk.directrix": "Исходная направляющая",
  "properties.sweptDisk.mappingPath": "Путь сопоставления",
  "properties.sweptDisk.none": "Нет",
  "properties.sweptDisk.radius": "Radius",
  "properties.sweptDisk.innerRadius": "InnerRadius",
  "properties.sweptDisk.unsupportedRadiusHint": "Radius содержит заданное значение; радиус в мировой системе координат определить не удалось.",
  "properties.sweptDisk.derivedCentreline": "Вычисленные измерения осевой линии",
  "properties.sweptDisk.totalLength": "Общая длина осевой линии",
  "properties.sweptDisk.segment": "Сегмент {index}",
  "properties.sweptDisk.bend": "Величина изгиба",
  "properties.sweptDisk.signedSweep": "Угол поворота со знаком",
} satisfies Catalogue;
