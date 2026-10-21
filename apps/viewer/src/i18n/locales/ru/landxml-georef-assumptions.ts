/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const landxmlGeorefAssumptionsRu = {
  "landXmlGeorefAssumptions.sharedVerticalDatum.label": "Считать систему высот общей",
  "landXmlGeorefAssumptions.sharedVerticalDatum.description": "Если в файле LandXML или в модели, на которую он размещается, не указана система высот, использовать высоты как записано, считая систему общей для обоих. Если системы различаются, поверхность окажется выше или ниже на величину разницы между двумя системами высот.",
  "landXmlGeorefAssumptions.epsgFromName.label": "Читать код EPSG из названия системы координат",
  "landXmlGeorefAssumptions.epsgFromName.description": "Если в CoordinateSystem файла LandXML не указан код EPSG, но название состоит ровно из \"EPSG:\" и следующего за ним числа (например, EPSG:31467), использовать этот код. Любое другое название не считывается. Если название было лишь подписью, поверхность окажется не на своём месте.",
  "landXmlGeorefAssumptions.title": "Не удалось совместить файл LandXML \"{fileName}\" с моделью",
  "landXmlGeorefAssumptions.offer": "Его можно разместить, если принять:",
  "landXmlGeorefAssumptions.load": "Загрузить с этими допущениями",
  "landXmlGeorefAssumptions.always": "Всегда принимать это допущение",
  "landXmlGeorefAssumptions.alwaysHint": "\"Всегда принимать это допущение\" также включает отмеченные допущения в разделе Настройки, Общие для всех последующих файлов LandXML. Там их можно снова отключить.",
  "landXmlGeorefAssumptions.cancel": "Отменить",
  "landXmlGeorefAssumptions.settings": "Геопривязка LandXML",
  "landXmlGeorefAssumptions.settingsHint": "По умолчанию оба допущения отключены: файл LandXML, в котором не указано, как его совместить с моделью, отклоняется, а сообщение указывает, чего не хватает. Включайте допущение, только если оно справедливо для ваших файлов. Размещённая таким образом модель помечается \"С допущениями\".",
  "landXmlGeorefAssumptions.badge": "С допущениями",
  "landXmlGeorefAssumptions.assumed": "Размещено с выбранными вами допущениями",
  "landXmlGeorefAssumptions.sharedVerticalDatum.applied": "Система высот считается общей с опорной моделью: вертикальная система отсчёта не указана.",
  "landXmlGeorefAssumptions.epsgFromName.applied": "{crs} считан из названия CoordinateSystem: код EPSG не указан.",
} satisfies Catalogue;
