/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFC catalog's React implementations, one per component name.
 * `createIfcCatalog` rejects this list if a name is missing or extra.
 */

import type { ReactCatalogComponent } from '@a2ui/react';
import { ButtonImpl, CheckBoxImpl, ChoicePickerImpl, SliderImpl, TextFieldImpl } from './basic-inputs';
import { CardImpl, ColumnImpl, DividerImpl, ListImpl, RowImpl, TabsImpl, TextImpl } from './basic-layout';
import { ActionBarImpl } from './ActionBar';
import { ColorLegendImpl } from './ColorLegend';
import { EntityCardImpl } from './EntityCard';
import { EntityListImpl } from './EntityList';
import { EntityTableImpl } from './EntityTable';
import { GroupChartImpl } from './GroupChart';
import { CalloutImpl } from './notes';
import { StatGroupImpl } from './StatGroup';

export const IFC_REACT_COMPONENTS: readonly ReactCatalogComponent[] = [
  TextImpl, RowImpl, ColumnImpl, ListImpl, CardImpl, TabsImpl, DividerImpl,
  ButtonImpl, TextFieldImpl, CheckBoxImpl, ChoicePickerImpl, SliderImpl,
  EntityTableImpl, EntityListImpl, EntityCardImpl, StatGroupImpl, GroupChartImpl, ColorLegendImpl, ActionBarImpl, CalloutImpl,
];
