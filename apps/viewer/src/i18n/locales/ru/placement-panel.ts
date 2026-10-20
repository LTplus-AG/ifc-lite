/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const placementPanelRu = {
  "placementPanel.title": "Размещение",
  "placementPanel.headerCloseTitle": "Закрыть панель размещения",
  "placementPanel.tabs.local": "Локальные координаты",
  "placementPanel.tabs.georeference": "Геопривязка",
  "placementPanel.local.emptyTitle": "Модели не выбраны",
  "placementPanel.local.emptyHint": "Выберите модели, которые нужно переместить, затем начните изменение положения.",
  "placementPanel.local.startButton": "Начать изменение положения",
  "placementPanel.georeference.emptyTitle": "Нет геопривязанной модели",
  "placementPanel.georeference.emptyHint": "Загрузите модель с преобразованием карты (IfcMapConversion), чтобы отредактировать здесь опорную точку её участка.",
  "placementPanel.georeference.editToggleOn": "Редактирование",
  "placementPanel.georeference.editToggleOff": "Редактировать опорную точку",
  "placementPanel.georeference.startHint": "Перетаскивайте маркеры плоскости и высоты в 3D-виде или смещайте опорную точку ниже.",
} satisfies Catalogue;
