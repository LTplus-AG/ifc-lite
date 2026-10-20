/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const landxmlTerrainExportRu = {
  "landXmlTerrainExport.triggerButton": "Экспортировать LandXML (рельеф)",
  "landXmlTerrainExport.dialogTitle": "Экспорт LandXML (рельеф)",
  "landXmlTerrainExport.dialogDescription": "Записывает выбранный рельеф как поверхность LandXML 1.2 (точки и треугольники) в картографических координатах проекта.",
  "landXmlTerrainExport.cancelButton": "Отменить",
  "landXmlTerrainExport.exportButton": "Экспортировать",
  "landXmlTerrainExport.exportingButton": "Экспорт...",
  "landXmlTerrainExport.successTitle": "Экспортировано",
  "landXmlTerrainExport.errorTitle": "Ошибка экспорта",
  "landXmlTerrainExport.noSelectionTitle": "Выберите рельеф",
  "landXmlTerrainExport.noSelectionDescription": "Выберите рельеф для экспорта: IfcGeographicElement или IfcSite с формой в виде триангулированной поверхности.",
  "landXmlTerrainExport.multipleModelsTitle": "Рельеф из нескольких моделей",
  "landXmlTerrainExport.multipleModelsDescription": {
    few: "Выбранный рельеф взят из {count} моделей. Выбирайте рельеф из одной модели за раз.",
    many: "Выбранный рельеф взят из {count} моделей. Выбирайте рельеф из одной модели за раз.",
    other: "Выбранный рельеф взят из {count} модели. Выбирайте рельеф из одной модели за раз.",
  },
  "landXmlTerrainExport.skippedNote": {
    one: "{count} выбранный объект не является рельефом и исключён.",
    few: "{count} выбранных объекта не являются рельефом и исключены.",
    many: "{count} выбранных объектов не являются рельефом и исключены.",
    other: "{count} выбранного объекта не является рельефом и исключено.",
  },
  "landXmlTerrainExport.checking": "Проверка выбранного рельефа...",
  "landXmlTerrainExport.refusedTitle": "Выбранное нельзя экспортировать",
  "landXmlTerrainExport.unavailableDescription": "Геометрическое ядро недоступно. Перезагрузите страницу и повторите попытку.",
  "landXmlTerrainExport.checkFailedTitle": "Не удалось проверить рельеф",
  "landXmlTerrainExport.surfacesHeading": {
    one: "{count} поверхность",
    many: "{count} поверхностей",
    other: "{count} поверхности",
  },
  "landXmlTerrainExport.surfaceNameColumn": "Поверхность",
  "landXmlTerrainExport.pointsColumn": "Точки",
  "landXmlTerrainExport.trianglesColumn": "Треугольники",
  "landXmlTerrainExport.crsLabel": "Система координат: {crsName}",
  "landXmlTerrainExport.surfaceNameInput": "Название поверхности {name}",
  "landXmlTerrainExport.outputLabel": "Результат",
  "landXmlTerrainExport.outputFormat": "LandXML 1.2",
  "landXmlTerrainExport.fileExtension": ".xml",
  "landXmlTerrainExport.unitsLabel": "Единицы измерения",
  "landXmlTerrainExport.unit.metre": "Метры",
  "landXmlTerrainExport.unit.internationalFoot": "Международные футы",
  "landXmlTerrainExport.unit.usSurveyFoot": "Геодезические футы США",
  "landXmlTerrainExport.usSurveyFootNote": "Высоты записываются в международных футах, поскольку в LandXML 1.2 нет геодезического фута США для высот. В файле указываются обе единицы измерения.",
  "landXmlTerrainExport.decimalsLabel": "Знаков после запятой",
  "landXmlTerrainExport.decimals.3": "3 (0.001)",
  "landXmlTerrainExport.decimals.4": "4 (0.0001)",
  "landXmlTerrainExport.decimals.6": "6 (0.000001)",
  "landXmlTerrainExport.exportedMessage": "Рельеф LandXML экспортирован ({sizeKb} КБ)",
  "landXmlTerrainExport.failedMessage": "Ошибка экспорта рельефа LandXML: {reason}",
} satisfies Catalogue;
