/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * German translations for IDS validation
 */

export const de = {
  // ============================================================================
  // Status
  // ============================================================================
  status: {
    pass: 'BESTANDEN',
    fail: 'FEHLGESCHLAGEN',
    not_applicable: 'NICHT ANWENDBAR',
  },

  // ============================================================================
  // Optionality / Cardinality
  // ============================================================================
  optionality: {
    required: 'Erforderlich',
    optional: 'Optional',
    prohibited: 'Verboten',
  },

  cardinality: {
    satisfied: 'Kardinalität erfüllt',
    atLeast: 'Mindestens {min} erwartet, {count} gefunden',
    atMost: 'Maximal {max} erwartet, {count} gefunden',
    between: 'Zwischen {min} und {max} erwartet, {count} gefunden',
    exactly: 'Genau {count} erwartet',
  },

  // ============================================================================
  // Relationships
  // ============================================================================
  relations: {
    IfcRelAggregates: 'Teil von',
    IfcRelAssignsToGroup: 'gruppiert in',
    IfcRelContainedInSpatialStructure: 'enthalten in',
    IfcRelNests: 'verschachtelt in',
    IfcRelVoidsElement: 'durchbrechend',
    IfcRelFillsElement: 'ausfüllend',
  },

  // ============================================================================
  // Constraint Descriptions
  // ============================================================================
  constraints: {
    simpleValue: '"{value}"',
    pattern: 'entsprechend Muster "{pattern}"',
    enumeration: {
      single: '"{value}"',
      multiple: 'eines von [{values}]',
    },
    bounds: {
      between: 'zwischen {min} und {max}',
      atLeast: 'mindestens {min}',
      atMost: 'höchstens {max}',
      greaterThan: 'größer als {min}',
      lessThan: 'kleiner als {max}',
    },
  },

  // ============================================================================
  // Applicability Descriptions
  // ============================================================================
  applicability: {
    entity: {
      simple: 'Elemente vom Typ {entityType}',
      withPredefined: '{entityType}-Elemente mit vordefiniertem Typ {predefinedType}',
      pattern: 'Elemente mit Typ entsprechend {pattern}',
    },
    attribute: {
      exists: 'Elemente bei denen Attribut "{name}" existiert',
      equals: 'Elemente bei denen "{name}" gleich {value} ist',
      pattern: 'Elemente bei denen "{name}" dem Muster {pattern} entspricht',
    },
    property: {
      exists: 'Elemente mit Eigenschaft "{property}" in "{pset}"',
      equals: 'Elemente bei denen "{pset}.{property}" gleich {value} ist',
      pattern: 'Elemente bei denen "{pset}.{property}" dem Muster {pattern} entspricht',
      bounded: 'Elemente bei denen "{pset}.{property}" {bounds} ist',
    },
    classification: {
      any: 'Elemente mit beliebiger Klassifizierung',
      system: 'Elemente klassifiziert in "{system}"',
      value: 'Elemente mit Klassifizierung "{value}"',
      systemAndValue: 'Elemente klassifiziert als "{value}" in "{system}"',
    },
    material: {
      any: 'Elemente mit zugewiesenem Material',
      value: 'Elemente mit Material "{value}"',
      pattern: 'Elemente mit Material entsprechend {pattern}',
    },
    partOf: {
      simple: 'Elemente die {relation} einem anderen Element sind',
      withEntity: 'Elemente die {relation} einem/einer {entity} sind',
      withEntityAndType: 'Elemente die {relation} einem/einer {entity} mit Typ {predefinedType} sind',
    },
  },

  // ============================================================================
  // Requirement Descriptions
  // ============================================================================
  requirements: {
    entity: {
      mustBe: 'Muss vom Typ {entityType} sein',
      mustHavePredefined: 'Muss vordefinierten Typ {predefinedType} haben',
      mustBeWithPredefined: 'Muss {entityType} mit vordefiniertem Typ {predefinedType} sein',
    },
    attribute: {
      mustExist: 'Attribut "{name}" muss existieren',
      mustEqual: 'Attribut "{name}" muss {value} entsprechen',
      mustMatch: 'Attribut "{name}" muss dem Muster {pattern} entsprechen',
      mustNotExist: 'Attribut "{name}" darf nicht existieren',
      mustNotEqual: 'Attribut "{name}" darf nicht {value} sein',
    },
    property: {
      mustExist: 'Eigenschaft "{pset}.{property}" muss existieren',
      mustEqual: 'Eigenschaft "{pset}.{property}" muss {value} sein',
      mustMatch: 'Eigenschaft "{pset}.{property}" muss dem Muster {pattern} entsprechen',
      mustBeBounded: 'Eigenschaft "{pset}.{property}" muss {bounds} sein',
      mustHaveType: 'Eigenschaft "{pset}.{property}" muss vom Datentyp {dataType} sein',
      mustNotExist: 'Eigenschaft "{pset}.{property}" darf nicht existieren',
    },
    classification: {
      mustHave: 'Muss eine Klassifizierung haben',
      mustBeInSystem: 'Muss in "{system}" klassifiziert sein',
      mustHaveValue: 'Muss Klassifizierung "{value}" haben',
      mustBeInSystemWithValue: 'Muss als "{value}" in "{system}" klassifiziert sein',
      mustNotHave: 'Darf keine Klassifizierung haben',
      mustNotBeInSystem: 'Darf nicht in "{system}" klassifiziert sein',
    },
    material: {
      mustHave: 'Muss ein Material zugewiesen haben',
      mustBe: 'Muss Material "{value}" haben',
      mustMatch: 'Muss Material entsprechend {pattern} haben',
      mustNotHave: 'Darf kein Material zugewiesen haben',
    },
    partOf: {
      mustBe: 'Muss {relation} einem/einer {entity} sein',
      mustBeSimple: 'Muss {relation} einem anderen Element sein',
      mustNotBe: 'Darf nicht {relation} einem Element sein',
    },
  },

  // ============================================================================
  // Failure Reasons
  // ============================================================================
  failures: {
    // Entity failures
    entityTypeMismatch: 'Elementtyp ist "{actual}", erwartet {expected}',
    predefinedTypeMismatch: 'Vordefinierter Typ ist "{actual}", erwartet {expected}',
    predefinedTypeMissing: 'Vordefinierter Typ ist nicht gesetzt, erwartet {expected}',

    // Attribute failures
    attributeMissing: 'Attribut "{name}" existiert nicht',
    attributeEmpty: 'Attribut "{name}" ist leer',
    attributeValueMismatch: 'Attribut "{name}" ist "{actual}", erwartet {expected}',
    attributePatternMismatch: 'Attribut "{name}" Wert "{actual}" entspricht nicht dem Muster {expected}',
    attributeProhibited: 'Verbotenes Attribut "{name}" existiert mit Wert "{actual}"',

    // Property failures
    psetMissing: 'PropertySet "{pset}" nicht gefunden',
    psetMissingAvailable: 'PropertySet "{pset}" nicht gefunden. Verfügbar: {available}',
    propertyMissing: 'Eigenschaft "{property}" nicht in "{pset}" gefunden',
    propertyMissingAvailable: 'Eigenschaft "{property}" nicht in "{pset}" gefunden. Verfügbar: {available}',
    propertyEmpty: 'Eigenschaft "{pset}.{property}" hat keinen Wert',
    propertyValueMismatch: 'Eigenschaft "{pset}.{property}" ist "{actual}", erwartet {expected}',
    propertyPatternMismatch: 'Eigenschaft "{pset}.{property}" Wert "{actual}" entspricht nicht {expected}',
    propertyDatatypeMismatch: 'Eigenschaft "{pset}.{property}" Datentyp ist "{actual}", erwartet {expected}',
    propertyOutOfBounds: 'Eigenschaft "{pset}.{property}" Wert {actual} liegt außerhalb des Bereichs {expected}',
    propertyProhibited: 'Verbotene Eigenschaft "{pset}.{property}" existiert mit Wert "{actual}"',

    // Classification failures
    classificationMissing: 'Keine Klassifizierung zugewiesen',
    classificationSystemMismatch: 'Klassifizierungssystem "{actual}" entspricht nicht dem erwarteten "{expected}"',
    classificationSystemMissingAvailable: 'Klassifizierungssystem "{expected}" nicht gefunden. Verfügbar: {available}',
    classificationValueMismatch: 'Klassifizierungscode "{actual}" entspricht nicht dem erwarteten {expected}',
    classificationValueMissingAvailable: 'Klassifizierungscode {expected} nicht gefunden. Verfügbar: {available}',
    classificationProhibited: 'Verbotene Klassifizierung "{actual}" existiert im System "{system}"',

    // Material failures
    materialMissing: 'Kein Material zugewiesen',
    materialValueMismatch: 'Material "{actual}" entspricht nicht dem erwarteten {expected}',
    materialValueMissingAvailable: 'Material {expected} nicht gefunden. Verfügbar: {available}',
    materialProhibited: 'Verbotenes Material "{actual}" ist zugewiesen',

    // PartOf failures
    partOfMissing: 'Element ist nicht {relation} einem/einer {entity}',
    partOfMissingSimple: 'Element ist nicht {relation} einem anderen Element',
    partOfEntityMismatch: 'Übergeordnetes Element ist {actual}, erwartet {expected}',
    partOfPredefinedMismatch: 'Vordefinierter Typ des übergeordneten Elements ist "{actual}", erwartet {expected}',
    partOfProhibited: 'Element ist {relation} {actual}, was verboten ist',

    // Generic
    prohibited: 'Verbotenes {field} gefunden: "{actual}"',
    unknown: 'Validierung fehlgeschlagen: {reason}',
  },

  // ============================================================================
  // Summary
  // ============================================================================
  summary: {
    title: 'IDS-Validierungsbericht',
    specifications: '{passed}/{total} Spezifikationen bestanden',
    entities: '{passed}/{total} Elemente konform ({percent}%)',
    overallPass: 'Modell erfüllt alle Anforderungen',
    overallFail: 'Modell hat {count} fehlgeschlagene Spezifikationen',
    noApplicable: 'Keine anwendbaren Elemente gefunden',
  },

  // ============================================================================
  // UI Labels
  // ============================================================================
  ui: {
    specification: 'Spezifikation',
    specifications: 'Spezifikationen',
    requirement: 'Anforderung',
    requirements: 'Anforderungen',
    applicability: 'Gilt für',
    entity: 'Element',
    entities: 'Elemente',
    passed: 'Bestanden',
    failed: 'Fehlgeschlagen',
    passRate: 'Erfolgsquote',
    actualValue: 'Tatsächlich',
    expectedValue: 'Erwartet',
    failureReason: 'Grund',
    showAll: 'Alle anzeigen',
    showFailed: 'Nur fehlgeschlagene',
    isolateFailed: 'Fehlgeschlagene isolieren',
    isolatePassed: 'Bestandene isolieren',
    exportJson: 'JSON exportieren',
    exportBcf: 'BCF exportieren',
    loadIds: 'IDS-Datei laden',
    runValidation: 'Validierung starten',
    clearResults: 'Ergebnisse löschen',
  },
};
