/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const profileSectionRu = {
  "profileSection.kind.Rectangle": "Прямоугольник",
  "profileSection.kind.I": "I / H",
  "profileSection.kind.L": "Уголок (L)",
  "profileSection.kind.T": "Тавр (T)",
  "profileSection.kind.U": "Швеллер (U)",
  "profileSection.kind.C": "Швеллер с отгибами (C)",
  "profileSection.kind.Circle": "Круг",
  "profileSection.kind.RectangleHollow": "Полый прямоугольник",
  "profileSection.kind.CircleHollow": "Полый круг",
  "profileSection.field.width": "Ширина",
  "profileSection.field.height": "Высота",
  "profileSection.field.depth": "Глубина",
  "profileSection.field.overallWidth": "Ширина",
  "profileSection.field.overallDepth": "Глубина",
  "profileSection.field.flangeWidth": "Ширина полки",
  "profileSection.field.web": "Стенка",
  "profileSection.field.flange": "Полка",
  "profileSection.field.thickness": "Толщина",
  "profileSection.field.wall": "Стенка",
  "profileSection.field.girth": "Отгиб",
  "profileSection.field.radius": "Радиус",
  "profileSection.fieldAria": "{label} в метрах",
  "profileSection.picker.label": "Сечение",
  "profileSection.picker.title": "Выбрать поперечное сечение новых элементов",
  "profileSection.picker.button": "Сечение: {kind}",
  "profileSection.kindAria": "Вид сечения",
  "profileSection.previewAria": "Предварительный просмотр сечения: {kind}, {across} на {up}",
  "profileSection.invalid": "Этот {kind} не подходит: {reason}",
  "profileSection.inspector.title": "Профиль сечения",
  "profileSection.inspector.unavailable": "Профиль можно изменить у элемента, построенного непосредственно по сечению",
  "profileSection.inspector.dimsNote": "Размеры прямоугольника задаются в разделе Размеры",
  "profileSection.inspector.outerSize": "Внешний размер определяется сечением: измените его в Профиле",
  "profileSection.inspector.edit": "Изменить профиль",
} satisfies Catalogue;
