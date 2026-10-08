/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Italian translations for IDS validation (IDS-011)
 */

export const it = {
  // ============================================================================
  // Status
  // ============================================================================
  status: {
    pass: 'CONFORME',
    fail: 'NON CONFORME',
    not_applicable: 'NON APPLICABILE',
  },

  // ============================================================================
  // Optionality / Cardinality
  // ============================================================================
  optionality: {
    required: 'Obbligatorio',
    optional: 'Facoltativo',
    prohibited: 'Vietato',
  },

  cardinality: {
    satisfied: 'Cardinalità rispettata',
    atLeast: 'Attesi almeno {min}, trovati {count}',
    atMost: 'Attesi al massimo {max}, trovati {count}',
    between: 'Attesi tra {min} e {max}, trovati {count}',
    exactly: 'Attesi esattamente {count}',
  },

  // ============================================================================
  // Relationships
  // ============================================================================
  relations: {
    IfcRelAggregates: 'aggregato in',
    IfcRelAssignsToGroup: 'raggruppato in',
    IfcRelContainedInSpatialStructure: 'contenuto in',
    IfcRelNests: 'annidato in',
    IfcRelVoidsElement: 'che fora',
    IfcRelFillsElement: 'che riempie',
    'IfcRelVoidsElement IfcRelFillsElement': 'collegato tramite un\'apertura a',
  },

  // ============================================================================
  // Constraint Descriptions
  // ============================================================================
  constraints: {
    simpleValue: '"{value}"',
    pattern: 'corrispondente al modello "{pattern}"',
    conjunction: '{first} e {second}',
    enumeration: {
      single: '"{value}"',
      multiple: 'uno tra [{values}]',
    },
    bounds: {
      between: 'tra {min} e {max}',
      atLeast: 'almeno {min}',
      atMost: 'al massimo {max}',
      greaterThan: 'maggiore di {min}',
      lessThan: 'minore di {max}',
    },
  },

  // ============================================================================
  // Applicability Descriptions
  // ============================================================================
  applicability: {
    entity: {
      simple: 'Elementi di tipo {entityType}',
      withPredefined: 'Elementi {entityType} con tipo predefinito {predefinedType}',
      pattern: 'Elementi con tipo corrispondente a {pattern}',
    },
    attribute: {
      exists: 'Elementi in cui l\'attributo "{name}" esiste',
      equals: 'Elementi in cui "{name}" è uguale a {value}',
      pattern: 'Elementi in cui "{name}" corrisponde al modello {pattern}',
    },
    property: {
      exists: 'Elementi con la proprietà "{property}" in "{pset}"',
      equals: 'Elementi in cui "{pset}.{property}" è uguale a {value}',
      pattern: 'Elementi in cui "{pset}.{property}" corrisponde al modello {pattern}',
      bounded: 'Elementi in cui "{pset}.{property}" è {bounds}',
    },
    classification: {
      any: 'Elementi con una classificazione qualsiasi',
      system: 'Elementi classificati in "{system}"',
      value: 'Elementi con classificazione "{value}"',
      systemAndValue: 'Elementi classificati come "{value}" in "{system}"',
    },
    material: {
      any: 'Elementi con un materiale assegnato',
      value: 'Elementi con materiale "{value}"',
      pattern: 'Elementi con materiale corrispondente a {pattern}',
    },
    partOf: {
      simple: 'Elementi {relation} un altro elemento',
      withEntity: 'Elementi {relation} un {entity}',
      withEntityAndType: 'Elementi {relation} un {entity} di tipo {predefinedType}',
    },
  },

  // ============================================================================
  // Requirement Descriptions
  // ============================================================================
  requirements: {
    entity: {
      mustBe: 'Deve essere di tipo {entityType}',
      mustHavePredefined: 'Deve avere il tipo predefinito {predefinedType}',
      mustBeWithPredefined: 'Deve essere {entityType} con tipo predefinito {predefinedType}',
    },
    attribute: {
      mustExist: 'L\'attributo "{name}" deve esistere',
      mustEqual: 'L\'attributo "{name}" deve essere uguale a {value}',
      mustMatch: 'L\'attributo "{name}" deve corrispondere al modello {pattern}',
      mustNotExist: 'L\'attributo "{name}" non deve esistere',
      mustNotEqual: 'L\'attributo "{name}" non deve essere {value}',
    },
    property: {
      mustExist: 'La proprietà "{pset}.{property}" deve esistere',
      mustEqual: 'La proprietà "{pset}.{property}" deve essere uguale a {value}',
      mustMatch: 'La proprietà "{pset}.{property}" deve corrispondere al modello {pattern}',
      mustBeBounded: 'La proprietà "{pset}.{property}" deve essere {bounds}',
      mustHaveType: 'La proprietà "{pset}.{property}" deve essere di tipo {dataType}',
      mustNotExist: 'La proprietà "{pset}.{property}" non deve esistere',
    },
    classification: {
      mustHave: 'Deve avere una classificazione',
      mustBeInSystem: 'Deve essere classificato in "{system}"',
      mustHaveValue: 'Deve avere la classificazione "{value}"',
      mustBeInSystemWithValue: 'Deve essere classificato come "{value}" in "{system}"',
      mustNotHave: 'Non deve avere una classificazione',
      mustNotBeInSystem: 'Non deve essere classificato in "{system}"',
    },
    material: {
      mustHave: 'Deve avere un materiale assegnato',
      mustBe: 'Deve avere il materiale "{value}"',
      mustMatch: 'Deve avere un materiale corrispondente a {pattern}',
      mustNotHave: 'Non deve avere un materiale assegnato',
    },
    partOf: {
      mustBe: 'Deve essere {relation} un {entity}',
      mustBeSimple: 'Deve essere {relation} un altro elemento',
      mustNotBe: 'Non deve essere {relation} un elemento',
    },
  },

  // ============================================================================
  // Failure Reasons
  // ============================================================================
  failures: {
    // Entity failures
    entityTypeMismatch: 'Il tipo di elemento è "{actual}", atteso {expected}',
    predefinedTypeMismatch: 'Il tipo predefinito è "{actual}", atteso {expected}',
    predefinedTypeMissing: 'Il tipo predefinito non è impostato, atteso {expected}',

    // Attribute failures
    attributeMissing: 'L\'attributo "{name}" non esiste',
    attributeEmpty: 'L\'attributo "{name}" è vuoto',
    attributeValueMismatch: 'L\'attributo "{name}" è "{actual}", atteso {expected}',
    attributePatternMismatch: 'Il valore "{actual}" dell\'attributo "{name}" non corrisponde al modello {expected}',
    attributeProhibited: 'L\'attributo vietato "{name}" esiste con il valore "{actual}"',

    // Property failures
    psetMissing: 'Il gruppo di proprietà "{pset}" non è stato trovato',
    psetMissingAvailable: 'Il gruppo di proprietà "{pset}" non è stato trovato. Disponibili: {available}',
    propertyMissing: 'La proprietà "{property}" non è stata trovata in "{pset}"',
    propertyMissingAvailable: 'La proprietà "{property}" non è stata trovata in "{pset}". Disponibili: {available}',
    propertyEmpty: 'La proprietà "{pset}.{property}" non ha alcun valore',
    propertyValueMismatch: 'La proprietà "{pset}.{property}" è "{actual}", atteso {expected}',
    propertyPatternMismatch: 'Il valore "{actual}" della proprietà "{pset}.{property}" non corrisponde a {expected}',
    propertyDatatypeMismatch: 'Il tipo di dato della proprietà "{pset}.{property}" è "{actual}", atteso {expected}',
    propertyDatatypeUnknown: 'La proprietà "{pset}.{property}" non ha un tipo di dato noto, quindi non può essere verificata rispetto a {expected}',
    propertyOutOfBounds: 'Il valore {actual} della proprietà "{pset}.{property}" è fuori dall\'intervallo {expected}',
    propertyProhibited: 'La proprietà vietata "{pset}.{property}" esiste con il valore "{actual}"',

    // Classification failures
    classificationMissing: 'Nessuna classificazione assegnata',
    classificationSystemMismatch: 'Il sistema di classificazione "{actual}" non corrisponde a "{expected}" atteso',
    classificationSystemMissingAvailable: 'Il sistema di classificazione "{expected}" non è stato trovato. Disponibili: {available}',
    classificationValueMismatch: 'Il codice di classificazione "{actual}" non corrisponde a {expected} atteso',
    classificationValueMissingAvailable: 'Il codice di classificazione {expected} non è stato trovato. Disponibili: {available}',
    classificationProhibited: 'La classificazione vietata "{actual}" esiste nel sistema "{system}"',
    classificationUnresolved: 'L\'entità è classificata, ma i dettagli della classificazione non possono essere letti da questa fonte di dati',
    classificationPresenceUnresolved: 'Impossibile stabilire da questa fonte di dati se l\'entità è classificata',

    // Material failures
    materialMissing: 'Nessun materiale assegnato',
    materialUnresolved: 'L\'entità ha un materiale, ma i suoi dettagli non possono essere letti da questa fonte di dati',
    materialValueMismatch: 'Il materiale "{actual}" non corrisponde a {expected} atteso',
    materialValueMissingAvailable: 'Il materiale {expected} non è stato trovato. Disponibili: {available}',
    materialProhibited: 'Il materiale vietato "{actual}" è assegnato',

    // PartOf failures
    partOfMissing: 'L\'elemento non è {relation} un {entity}',
    partOfMissingSimple: 'L\'elemento non è {relation} un altro elemento',
    partOfEntityMismatch: 'L\'elemento padre è {actual}, atteso {expected}',
    partOfPredefinedMismatch: 'Il tipo predefinito dell\'elemento padre è "{actual}", atteso {expected}',
    partOfProhibited: 'L\'elemento è {relation} {actual}, il che è vietato',

    // Generic
    prohibited: '{field} vietato trovato: "{actual}"',
    unknown: 'Validazione non riuscita: {reason}',
  },

  // ============================================================================
  // Summary
  // ============================================================================
  summary: {
    title: 'Rapporto di validazione IDS',
    specifications: '{passed}/{total} specifiche conformi',
    entities: '{passed}/{total} elementi conformi ({percent}%)',
    overallPass: 'Il modello soddisfa tutti i requisiti',
    overallFail: 'Il modello ha {count} specifiche non conformi',
    noApplicable: 'Nessun elemento applicabile trovato',
  },

  // ============================================================================
  // UI Labels
  // ============================================================================
  ui: {
    specification: 'Specifica',
    specifications: 'Specifiche',
    requirement: 'Requisito',
    requirements: 'Requisiti',
    applicability: 'Si applica a',
    entity: 'Elemento',
    entities: 'Elementi',
    passed: 'Conforme',
    failed: 'Non conforme',
    passRate: 'Tasso di conformità',
    actualValue: 'Effettivo',
    expectedValue: 'Atteso',
    failureReason: 'Motivo',
    showAll: 'Mostra tutto',
    showFailed: 'Mostra non conformi',
    isolateFailed: 'Isola non conformi',
    isolatePassed: 'Isola conformi',
    exportJson: 'Esporta JSON',
    exportBcf: 'Esporta BCF',
    loadIds: 'Carica file IDS',
    runValidation: 'Avvia validazione',
    clearResults: 'Cancella risultati',
  },
};
