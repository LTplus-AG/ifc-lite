/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const REPORT_FIELDS: Array<[string, string]> = [['project', 'Project'], ['title', 'Report title'], ['author', 'Prepared by'], ['date', 'Date'], ['revision', 'Revision']];
export const reportTitleBlock = (fields: Readonly<Record<string, string>>) => Object.fromEntries(REPORT_FIELDS.map(([key, label]) => [label, fields[key] ?? '']));
