/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const remeshRu = {
  "remesh.refused.noSource": "3D-формы этой модели невозможно восстановить после редактирования: она не была загружена из файла IFC.",
  "remesh.refused.noFrame": "3D-формы этой модели невозможно восстановить после редактирования: она была загружена без системы координат движка. Перезагрузите её, чтобы включить обновления.",
  "remesh.refused.colourMerged": "Отредактированный элемент имеет общую сетку с другими элементами, поэтому его 3D-форму нельзя перестроить отдельно. Изменение сохранено.",
  "remesh.refused.unreadable": "Данные отредактированного элемента не удалось считать обратно, поэтому его 3D-форма не была восстановлена. Изменения сохранены.",
  "remesh.refused.alignment": "Модель отредактированного элемента совмещена с системой координат другой модели, и перестроенную форму не удалось совместить таким же образом. Изменение сохранено.",
  "remesh.failed": "3D-форму отредактированного элемента восстановить не удалось: {message}. Изменения сохранены.",
} satisfies Catalogue;
