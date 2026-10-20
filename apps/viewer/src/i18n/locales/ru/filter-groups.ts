/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const filterGroupsRu = {
  "filterGroups.addGroup": "Добавить группу",
  "filterGroups.addGroupTitle": "Добавить ещё одну группу ИЛИ — \"+\" в текст селектора",
  "filterGroups.tabsAriaLabel": "Группы фильтров",
  "filterGroups.groupLabel": "Группа {index}",
  "filterGroups.removeGroupAriaLabel": "Удалить группу {index}",
  "filterGroups.noRules": "Нет правил — добавьте правило для запуска.",
  "filterGroups.ruleCount": {
    one: "{count} правило",
    many: "{count} правил",
    other: "{count} правила",
  },
  "filterGroups.groupCountOr": {
    one: "{count} группа (ИЛИ)",
    many: "{count} групп (ИЛИ)",
    other: "{count} группы (ИЛИ)",
  },
  "filterGroups.limit": "лимит",
  "filterGroups.readbackTitle": "Текущий фильтр представлен в виде текста-селектора — здесь отображается вторая группа (Добавить группу, ниже), соединённая знаком \"+\".",
} satisfies Catalogue;
