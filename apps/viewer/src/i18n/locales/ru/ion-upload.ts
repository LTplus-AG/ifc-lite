/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const ionUploadRu = {
  "ionUpload.title": "Загрузить в Cesium ion",
  "ionUpload.description": "Загрузите одну IFC-модель с ожидающими изменениями в свою учётную запись Cesium ion. Все свойства модели включены.",
  "ionUpload.close": "Закрыть",
  "ionUpload.upload": "Загрузить",
  "ionUpload.uploading": "Загрузка…",
  "ionUpload.abort": "Отменить загрузку",
  "ionUpload.successTitle": "Передано на создание тайлов",
  "ionUpload.errorTitle": "Загрузка не завершилась",
  "ionUpload.accepted": "Cesium ion принял загрузку и разобьёт её на тайлы. Откройте ресурс для проверки хода выполнения и размещения.",
  "ionUpload.cancelled": "Загрузка отменена. Все уже созданные ресурсы остаются в Cesium ion; вы можете удалить их там.",
  "ionUpload.failed": "Ошибка на этапе {phase} (HTTP {status}). {help}",
  "ionUpload.failure.authorization": "Токен не может создавать ресурсы. Используйте токен с областью действия assets:write (токен по умолчанию только читает) и проверьте разрешённые URL-адреса в Cesium ion.",
  "ionUpload.failure.conflict": "Cesium ion отклонил запрос на загрузку. Если повторная попытка не удастся, сообщите об этой ошибке вместе с её HTTP-статусом.",
  "ionUpload.failure.capacity": "Перед повторной попыткой проверьте тарифный план, объём хранилища и размер загружаемого файла в Cesium ion.",
  "ionUpload.failure.rateLimit": "Cesium ion ограничивает частоту запросов. Подождите перед повторной попыткой.",
  "ionUpload.failure.service": "Cesium ion не смог выполнить запрос. Перед повторной попыткой проверьте состояние сервиса.",
  "ionUpload.failure.request": "Перед повторной попыткой проверьте соединение и состояние ресурса в Cesium ion. Возможно, загрузка не завершилась.",
  "ionUpload.exportWarnings": {
    one: "При подготовке IFC для Cesium ion обнаружена {count} проблема, поэтому ничего не загружено.",
    many: "При подготовке IFC для Cesium ion обнаружено {count} проблем, поэтому ничего не загружено.",
    other: "При подготовке IFC для Cesium ion обнаружено {count} проблемы, поэтому ничего не загружено.",
  },
  "ionUpload.serializationFailed": "Не удалось подготовить отредактированный IFC. Попробуйте экспортировать IFC локально, чтобы проверить модель.",
  "ionUpload.texturesUnsupported": "Эта модель включает графические ресурсы. Экспортируйте IFCZIP локально, чтобы сохранить изображения. Прямая загрузка текстур пока не поддерживается.",
  "ionUpload.noModel": "Загрузите модель STEP IFC для отправки. IFCX и LandXML не поддерживаются.",
  "ionUpload.openAsset": "Открыть {name} в Cesium ion",
  "ionUpload.model": "Модель",
  "ionUpload.token": "Токен Cesium ion (assets:write)",
  "ionUpload.tokenHelp": "Используйте отдельный токен с разрешением assets:write. Он хранится в памяти до закрытия этого диалогового окна и никогда не сохраняется и не отправляется в аналитику.",
  "ionUpload.createToken": "Создать токен",
  "ionUpload.placement": "При загрузке сохраняется геопривязка IFC. Распознанные названия вертикальной системы отсчёта EVRS2007 или EGM2008 передаются как высота над уровнем моря EGM2008. Другой текст системы отсчёта сохраняется. После создания тайлов проверьте местоположение, ориентацию и высотную отметку в Cesium ion. Для моделей без геопривязки задайте местоположение там.",
  "ionUpload.phase.serialize": "Подготовка отредактированного IFC…",
  "ionUpload.phase.create": "Создание ресурса…",
  "ionUpload.phase.upload": "Загрузка IFC…",
  "ionUpload.phase.complete": "Запуск создания тайлов…",
} satisfies Catalogue;
