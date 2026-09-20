/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const structuralPropertiesEn = {
  'properties.structural.heading': 'Structural Analysis',
  'properties.structural.loadsTruncatedTooltip':
    'One or more applied loads were bounded during extraction — this member may carry more load data than shown',
  'properties.structural.truncatedBadge': 'Truncated',
  'properties.structural.predefined': 'Predefined',
  'properties.structural.model': 'Model',
  'properties.structural.connections': 'Connections ({countDisplay})',
  'properties.structural.appliedLoads': 'Applied loads ({countDisplay})',
  'properties.structural.noDofs': '(no DOFs)',
  'properties.structural.fixedDofs': { one: '{countDisplay} DOF fixed', other: '{countDisplay} DOFs fixed' },
  'properties.structural.elasticDofs': { one: '{countDisplay} DOF elastic', other: '{countDisplay} DOFs elastic' },
  'properties.structural.freeDofs': { one: '{countDisplay} DOF free', other: '{countDisplay} DOFs free' },
  'properties.structural.noComponents': '(no components)',
  'properties.structural.componentValue': '{name}: {value}',
  'properties.structural.configurationDropped': '[dropped: {name}]',
  'properties.structural.configurationAt': '{components} @ {location}',
} as const;
