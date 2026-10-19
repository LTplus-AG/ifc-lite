/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const zoneEmissionRu = {
  "zoneEmission.title": "Проверить создание рассчитанных зон",
  "zoneEmission.hint": "Создать весь этот рассчитанный набор зон только в выбранной модели. Состав элементов берётся из текущего результата встроенного вычисления.",
  "zoneEmission.limit": "Предыдущие результаты этого сеанса заменяются. Зоны из ранее импортированного IFC-файла сохраняются. Другие модели не затрагиваются. Предварительный просмотр создаваемого тела недоступен.",
  "zoneEmission.prepare": "Подготовить создание зон в IFC",
  "zoneEmission.apply": "Создать проверенные зоны",
  "zoneEmission.population": "Зон {zones}, рассчитанных элементов {members}, заменено прежних зон {replaced}; сохранено импортированных зон {imported}.",
  "zoneEmission.records": "Выходные записи IFC",
  "zoneEmission.frame": "Единицы измерения и система координат IFC-модели",
  "zoneEmission.receiptProblem": "Модель изменилась, но запись результата не удалось сохранить. Отмена по-прежнему доступна во встроенной панели Изменения.",
} satisfies Catalogue;
