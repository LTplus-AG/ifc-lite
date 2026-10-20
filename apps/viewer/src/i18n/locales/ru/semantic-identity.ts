/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const semanticIdentityRu = {
  "semantic.identityControls": "Стратегия идентификации IFC",
  "semantic.identityUri": "URI ресурса содержит IFC GlobalId",
  "semantic.identityUriMode": "Сопоставление URI ресурса",
  "semantic.identityUriTemplateMode": "Полный шаблон URI",
  "semantic.identityUriSegmentMode": "Последний сегмент пути (включается отдельно)",
  "semantic.identityUriTemplate": "Полный шаблон URI ресурса",
  "semantic.identityUriApply": "Применить шаблон URI",
  "semantic.identityUriHint": "В шаблоне используется одна подстановка {GlobalId}. Для последнего сегмента пути нужны известные URI ресурсов для обратных запросов. Сопоставление URI никогда не заменяет выбранную стратегию прямого GlobalId.",
  "semantic.identityDirect": "IFC GlobalId и ревизия модели",
  "semantic.identityLinks": "Явные ссылки на ресурсы",
  "semantic.identityProfile": "Поля идентификации профиля",
  "semantic.identityGuidField": "Поле GlobalId профиля",
  "semantic.identityRevisionField": "Поле ревизии профиля",
  "semantic.identityNoRevision": "Нет поля ревизии",
  "semantic.identityLinkJson": "Ссылки на ресурсы (JSON)",
  "semantic.identityApplyLinks": "Применить ссылки на ресурсы",
  "semantic.identityLinkHint": "Используйте resourceId, modelRevision и GlobalId. Для ревизий модели требуется явная привязка к загруженной модели.",
} satisfies Catalogue;
