/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralPropertiesRu = {
  "properties.structural.heading": "Анализ конструкций",
  "properties.structural.relatedUnavailable": "У некоторых объектов, на которые ссылаются исходные связи IFC, отсутствуют или повторяются GlobalIds. Их нельзя определить однозначно. Соответствующие строки пропущены, полные итоги неизвестны.",
  "properties.structural.sourceUnavailable": "Без исходного файла IFC невозможно проверить исходные поля расчётной модели и полный состав связей. Показаны доступные заданные поля.",
  "properties.structural.loadsTruncatedTooltip": "В процессе извлечения одна или несколько приложенных нагрузок были ограничены — этот элемент может нести больше данных о нагрузке, чем показано",
  "properties.structural.truncatedBadge": "Сокращено",
  "properties.structural.predefined": "Предопределённый",
  "properties.structural.model": "Модель",
  "properties.structural.connections": "Соединения ({countDisplay})",
  "properties.structural.appliedLoads": "Приложенные нагрузки ({countDisplay})",
  "properties.structural.noDofs": "(без степеней свободы)",
  "properties.structural.fixedDofs": {
    one: "{countDisplay} степень свободы зафиксирована",
    few: "{countDisplay} степени свободы зафиксированы",
    many: "{countDisplay} степеней свободы зафиксировано",
    other: "{countDisplay} степени свободы зафиксировано",
  },
  "properties.structural.elasticDofs": {
    one: "{countDisplay} упругая степень свободы",
    few: "{countDisplay} упругие степени свободы",
    many: "{countDisplay} упругих степеней свободы",
    other: "{countDisplay} упругой степени свободы",
  },
  "properties.structural.freeDofs": {
    one: "{countDisplay} свободная степень свободы",
    few: "{countDisplay} свободные степени свободы",
    many: "{countDisplay} свободных степеней свободы",
    other: "{countDisplay} свободной степени свободы",
  },
  "properties.structural.noComponents": "(без компонентов)",
  "properties.structural.componentValue": "{name}: {value}",
  "properties.structural.configurationDropped": "[исключено: {name}]",
  "properties.structural.configurationAt": "{components} @ {location}",
} satisfies Catalogue;
