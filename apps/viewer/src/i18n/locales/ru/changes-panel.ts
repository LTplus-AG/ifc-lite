/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const changesPanelRu = {
  "changesPanel.title": "Изменения",
  "changesPanel.close": "Закрыть изменения",
  "changesPanel.empty": "Операции редактирования не зафиксированы.",
  "changesPanel.rowCount": {
    one: "{count} правка",
    many: "{count} правок",
    other: "{count} правки",
  },
  "changesPanel.entity": "{type} #{id}",
  "changesPanel.georeference": "Геопривязка",
  "changesPanel.modelMetadata": "Метаданные модели",
  "changesPanel.jump": "Перейти к {entity} в {model}",
  "changesPanel.revert": "Вернуть исходное",
  "changesPanel.revertUnavailable": "Отменить это изменение безопасно невозможно, пока от него зависят более новые изменения.",
  "changesPanel.revertStale": "Эта правка изменилась. Просмотрите текущий список и попробуйте снова.",
  "changesPanel.revertPermission": "Перед отменой изменений включите режим редактирования или запросите доступ к редактированию.",
  "changesPanel.revertSharedRoom": "Покиньте общую комнату, прежде чем отменять изменения. Комната пока не может синхронизировать это изменение.",
  "changesPanel.revertUnsupported": "Эту правку нельзя отменить с боковой панели. Используйте Отменить действие, если это последний шаг.",
} satisfies Catalogue;
