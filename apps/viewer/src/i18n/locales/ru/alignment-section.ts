/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const alignmentSectionRu = {
  "alignmentSection.mode": "Трасса",
  "alignmentSection.model": "Модель трассы",
  "alignmentSection.axis": "Выбрать IfcAlignment",
  "alignmentSection.axisFallback": "IfcAlignment #{id}",
  "alignmentSection.noAxes": "Нет IfcAlignment",
  "alignmentSection.loading": "Определение трассы…",
  "alignmentSection.distance": "Горизонтальное расстояние от начала",
  "alignmentSection.approximate": "Аппроксимированная кривая · расстояние от начала",
  "alignmentSection.help": "Расстояние измеряется в геометрических горизонтальных метрах от физической начальной точки, а не в заданных пикетах. Плоскость следует по вычисленной касательной. Перетаскивание плоскости отсоединяет её от трассы; чтобы продолжить, выберите трассу снова.",
  "alignmentSection.error": "Не удалось построить сечение этой трассы: {detail}",
} satisfies Catalogue;
