/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DuckDB-WASM integration for SQL queries
 * Lazy-loaded to avoid adding ~4MB to bundle unless needed
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { IfcTypeEnumToString, PropertyValueType, QuantityType, RelationshipType } from '@ifc-lite/data';

export interface SQLResult {
  columns: string[];
  rows: unknown[][];
  toArray(): unknown[];
  toJSON(): unknown[];
}

/** Minimal typed surface for the dynamically-loaded @duckdb/duckdb-wasm module. */
interface DuckDBModule {
  selectBundle(bundles: unknown): Promise<{ mainWorker: string; mainModule: string; pthreadWorker: string | null }>;
  getJsDelivrBundles(): unknown;
  AsyncDuckDB: new (logger: unknown, worker: Worker) => DuckDBInstance;
  ConsoleLogger: new () => unknown;
}

interface DuckDBInstance {
  instantiate(mainModule: string, pthreadWorker: string | null): Promise<void>;
  connect(): Promise<DuckDBConnection>;
  registerFileBuffer(name: string, buf: Uint8Array): Promise<void>;
  terminate(): Promise<void>;
}

interface DuckDBConnection {
  query(sql: string): Promise<{ toArray(): unknown[]; numCols: number; schema: { fields: { name: string }[] } }>;
  close(): Promise<void>;
}

export class DuckDBIntegration {
  private db: DuckDBInstance | null = null;
  private conn: DuckDBConnection | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  /**
   * Initialize DuckDB (lazy-loaded)
   */
  async init(store: IfcDataStore): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Dynamic import using Function constructor to prevent Vite static analysis.
        // DuckDB is optional — this will fail gracefully if not installed.
        // The Function() trick is required because Vite would otherwise try to
        // bundle @duckdb/duckdb-wasm, which is a large optional dependency.
        const duckdb = await new Function('return import("@duckdb/duckdb-wasm")')() as DuckDBModule;
        const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

        if (!bundle.mainWorker) {
          throw new Error('DuckDB bundle missing mainWorker');
        }
        const worker = new Worker(bundle.mainWorker);
        this.db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
        await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        this.conn = await this.db.connect();

        await this.registerTables(store);
        await this.createViews();

        this.initialized = true;
        console.log('[DuckDB] Initialization complete');
      } catch (error) {
        throw new Error(`Failed to initialize DuckDB: ${error}`);
      }
    })();

    return this.initPromise;
  }

  /**
   * Execute SQL query
   */
  async query(sql: string): Promise<SQLResult> {
    if (!this.initialized) {
      throw new Error('DuckDB not initialized. Call init() first.');
    }

    if (!this.conn) throw new Error('DuckDB connection not available');
    const result = await this.conn.query(sql);
    const rows = result.toArray();

    return {
      columns: result.schema.fields.map((f) => f.name),
      rows: rows as unknown[][],
      toArray: () => rows,
      toJSON: () => rows.map((row: unknown) => {
        const obj: Record<string, unknown> = {};
        result.schema.fields.forEach((field, i: number) => {
          // Handle DuckDB row format (could be array or object)
          obj[field.name] = Array.isArray(row) ? row[i] : (row as Record<string, unknown>)[field.name];
        });
        return obj;
      }),
    };
  }

  /**
   * Register tables from columnar store using SQL INSERT statements
   * This approach works without Arrow dependencies and is more portable
   */
  private async registerTables(store: IfcDataStore): Promise<void> {
    // conn is guaranteed non-null here — called only from init() after connect()
    const conn = this.conn!;
    console.log('[DuckDB] Registering tables from store with', store.entities.count, 'entities');

    // Create and populate entities table
    await this.createEntitiesTable(store);

    // Create and populate properties table
    await this.createPropertiesTable(store);

    // Create and populate quantities table
    await this.createQuantitiesTable(store);

    // Create and populate relationships table
    await this.createRelationshipsTable(store);

    console.log('[DuckDB] All tables registered successfully');
  }

  /**
   * Create and populate entities table
   */
  private async createEntitiesTable(store: IfcDataStore): Promise<void> {
    const conn = this.conn!;
    // Create table
    await conn.query(`
      CREATE TABLE entities (
        express_id INTEGER PRIMARY KEY,
        global_id VARCHAR,
        name VARCHAR,
        description VARCHAR,
        type VARCHAR,
        object_type VARCHAR,
        has_geometry BOOLEAN,
        is_type BOOLEAN,
        contained_in_storey INTEGER,
        defined_by_type INTEGER
      )
    `);

    const { entities, strings } = store;
    const batchSize = 1000;

    // Insert in batches for performance
    for (let i = 0; i < entities.count; i += batchSize) {
      const end = Math.min(i + batchSize, entities.count);
      const values: string[] = [];

      for (let j = i; j < end; j++) {
        const expressId = entities.expressId[j];
        const globalId = escapeSQL(strings.get(entities.globalId[j]));
        const name = escapeSQL(strings.get(entities.name[j]));
        const description = escapeSQL(strings.get(entities.description[j]));
        const type = escapeSQL(IfcTypeEnumToString(entities.typeEnum[j]));
        const objectType = escapeSQL(strings.get(entities.objectType[j]));
        const hasGeometry = (entities.flags[j] & 1) !== 0;
        const isType = (entities.flags[j] & 2) !== 0;
        const containedInStorey = entities.containedInStorey[j] || 'NULL';
        const definedByType = entities.definedByType[j] || 'NULL';

        values.push(`(${expressId}, '${globalId}', '${name}', '${description}', '${type}', '${objectType}', ${hasGeometry}, ${isType}, ${containedInStorey}, ${definedByType})`);
      }

      if (values.length > 0) {
        await conn.query(`INSERT INTO entities VALUES ${values.join(', ')}`);
      }
    }

    console.log(`[DuckDB] Registered entities table with ${entities.count} rows`);
  }

  /**
   * Create and populate properties table
   */
  private async createPropertiesTable(store: IfcDataStore): Promise<void> {
    const conn = this.conn!;
    await conn.query(`
      CREATE TABLE properties (
        entity_id INTEGER,
        pset_name VARCHAR,
        pset_global_id VARCHAR,
        prop_name VARCHAR,
        prop_type VARCHAR,
        value_string VARCHAR,
        value_real DOUBLE,
        value_int INTEGER,
        value_bool BOOLEAN
      )
    `);

    const { properties, strings } = store;
    const batchSize = 1000;

    const propTypeNames: Record<number, string> = {
      [PropertyValueType.String]: 'String',
      [PropertyValueType.Real]: 'Real',
      [PropertyValueType.Integer]: 'Integer',
      [PropertyValueType.Boolean]: 'Boolean',
      [PropertyValueType.Logical]: 'Logical',
      [PropertyValueType.Label]: 'Label',
      [PropertyValueType.Identifier]: 'Identifier',
      [PropertyValueType.Text]: 'Text',
      [PropertyValueType.Enum]: 'Enum',
      [PropertyValueType.Reference]: 'Reference',
      [PropertyValueType.List]: 'List',
    };

    for (let i = 0; i < properties.count; i += batchSize) {
      const end = Math.min(i + batchSize, properties.count);
      const values: string[] = [];

      for (let j = i; j < end; j++) {
        const entityId = properties.entityId[j];
        const psetName = escapeSQL(strings.get(properties.psetName[j]));
        const psetGlobalId = escapeSQL(strings.get(properties.psetGlobalId[j]));
        const propName = escapeSQL(strings.get(properties.propName[j]));
        const propType = propTypeNames[properties.propType[j]] || 'Unknown';

        const valueStringIdx = properties.valueString[j];
        const valueString = valueStringIdx >= 0 ? escapeSQL(strings.get(valueStringIdx)) : '';
        const valueReal = isNaN(properties.valueReal[j]) ? 'NULL' : properties.valueReal[j];
        const valueInt = properties.valueInt[j];
        const valueBoolRaw = properties.valueBool[j];
        const valueBool = valueBoolRaw === 255 ? 'NULL' : valueBoolRaw === 1 ? 'true' : 'false';

        values.push(`(${entityId}, '${psetName}', '${psetGlobalId}', '${propName}', '${propType}', '${valueString}', ${valueReal}, ${valueInt}, ${valueBool})`);
      }

      if (values.length > 0) {
        await conn.query(`INSERT INTO properties VALUES ${values.join(', ')}`);
      }
    }

    console.log(`[DuckDB] Registered properties table with ${properties.count} rows`);
  }

  /**
   * Create and populate quantities table
   */
  private async createQuantitiesTable(store: IfcDataStore): Promise<void> {
    const conn = this.conn!;
    await conn.query(`
      CREATE TABLE quantities (
        entity_id INTEGER,
        qset_name VARCHAR,
        quantity_name VARCHAR,
        quantity_type VARCHAR,
        value DOUBLE,
        formula VARCHAR
      )
    `);

    const { quantities, strings } = store;
    const batchSize = 1000;

    const quantTypeNames: Record<number, string> = {
      [QuantityType.Length]: 'Length',
      [QuantityType.Area]: 'Area',
      [QuantityType.Volume]: 'Volume',
      [QuantityType.Count]: 'Count',
      [QuantityType.Weight]: 'Weight',
      [QuantityType.Time]: 'Time',
    };

    for (let i = 0; i < quantities.count; i += batchSize) {
      const end = Math.min(i + batchSize, quantities.count);
      const values: string[] = [];

      for (let j = i; j < end; j++) {
        const entityId = quantities.entityId[j];
        const qsetName = escapeSQL(strings.get(quantities.qsetName[j]));
        const quantityName = escapeSQL(strings.get(quantities.quantityName[j]));
        const quantityType = quantTypeNames[quantities.quantityType[j]] || 'Unknown';
        const value = quantities.value[j];
        const formulaIdx = quantities.formula[j];
        const formula = formulaIdx > 0 ? escapeSQL(strings.get(formulaIdx)) : '';

        values.push(`(${entityId}, '${qsetName}', '${quantityName}', '${quantityType}', ${value}, '${formula}')`);
      }

      if (values.length > 0) {
        await conn.query(`INSERT INTO quantities VALUES ${values.join(', ')}`);
      }
    }

    console.log(`[DuckDB] Registered quantities table with ${quantities.count} rows`);
  }

  /**
   * Create and populate relationships table
   */
  private async createRelationshipsTable(store: IfcDataStore): Promise<void> {
    const conn = this.conn!;
    await conn.query(`
      CREATE TABLE relationships (
        source_id INTEGER,
        target_id INTEGER,
        rel_type VARCHAR,
        rel_id INTEGER
      )
    `);

    const { relationships } = store;
    const edges = relationships.forward;
    const batchSize = 1000;

    const relTypeNames: Record<number, string> = {
      [RelationshipType.ContainsElements]: 'ContainsElements',
      [RelationshipType.Aggregates]: 'Aggregates',
      [RelationshipType.DefinesByProperties]: 'DefinesByProperties',
      [RelationshipType.DefinesByType]: 'DefinesByType',
      [RelationshipType.AssociatesMaterial]: 'AssociatesMaterial',
      [RelationshipType.AssociatesClassification]: 'AssociatesClassification',
      [RelationshipType.VoidsElement]: 'VoidsElement',
      [RelationshipType.FillsElement]: 'FillsElement',
      [RelationshipType.ConnectsPathElements]: 'ConnectsPathElements',
      [RelationshipType.ConnectsElements]: 'ConnectsElements',
      [RelationshipType.SpaceBoundary]: 'SpaceBoundary',
      [RelationshipType.AssignsToGroup]: 'AssignsToGroup',
      [RelationshipType.AssignsToProduct]: 'AssignsToProduct',
      [RelationshipType.ReferencedInSpatialStructure]: 'ReferencedInSpatialStructure',
    };

    // Flatten CSR format to rows
    const rows: { sourceId: number; targetId: number; relType: string; relId: number }[] = [];

    for (const [sourceId, offset] of edges.offsets) {
      const count = edges.counts.get(sourceId) || 0;
      for (let i = offset; i < offset + count; i++) {
        rows.push({
          sourceId,
          targetId: edges.edgeTargets[i],
          relType: relTypeNames[edges.edgeTypes[i]] || 'Unknown',
          relId: edges.edgeRelIds[i],
        });
      }
    }

    // Insert in batches
    for (let i = 0; i < rows.length; i += batchSize) {
      const end = Math.min(i + batchSize, rows.length);
      const values: string[] = [];

      for (let j = i; j < end; j++) {
        const row = rows[j];
        values.push(`(${row.sourceId}, ${row.targetId}, '${row.relType}', ${row.relId})`);
      }

      if (values.length > 0) {
        await conn.query(`INSERT INTO relationships VALUES ${values.join(', ')}`);
      }
    }

    console.log(`[DuckDB] Registered relationships table with ${rows.length} rows`);
  }

  /**
   * Create convenience views
   */
  private async createViews(): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    try {
      await conn.query(`
        CREATE VIEW IF NOT EXISTS walls AS
        SELECT * FROM entities WHERE type IN ('IfcWall', 'IfcWallStandardCase')
      `);

      await conn.query(`
        CREATE VIEW IF NOT EXISTS doors AS
        SELECT * FROM entities WHERE type = 'IfcDoor'
      `);

      await conn.query(`
        CREATE VIEW IF NOT EXISTS windows AS
        SELECT * FROM entities WHERE type = 'IfcWindow'
      `);

      await conn.query(`
        CREATE VIEW IF NOT EXISTS slabs AS
        SELECT * FROM entities WHERE type = 'IfcSlab'
      `);

      await conn.query(`
        CREATE VIEW IF NOT EXISTS columns AS
        SELECT * FROM entities WHERE type = 'IfcColumn'
      `);

      await conn.query(`
        CREATE VIEW IF NOT EXISTS beams AS
        SELECT * FROM entities WHERE type = 'IfcBeam'
      `);

      await conn.query(`
        CREATE VIEW IF NOT EXISTS spaces AS
        SELECT * FROM entities WHERE type = 'IfcSpace'
      `);

      // Create a view joining entities with their properties
      await conn.query(`
        CREATE VIEW IF NOT EXISTS entity_properties AS
        SELECT
          e.express_id, e.name as entity_name, e.type as entity_type,
          p.pset_name, p.prop_name, p.prop_type,
          p.value_string, p.value_real, p.value_int, p.value_bool
        FROM entities e
        LEFT JOIN properties p ON e.express_id = p.entity_id
      `);

      // Create a view joining entities with their quantities
      await conn.query(`
        CREATE VIEW IF NOT EXISTS entity_quantities AS
        SELECT
          e.express_id, e.name as entity_name, e.type as entity_type,
          q.qset_name, q.quantity_name, q.quantity_type, q.value
        FROM entities e
        LEFT JOIN quantities q ON e.express_id = q.entity_id
      `);

      console.log('[DuckDB] Created convenience views');
    } catch (error) {
      // Views may fail if tables aren't registered yet - that's OK
      console.warn('[DuckDB] Could not create views:', error);
    }
  }

  /**
   * Check if DuckDB is available
   */
  static async isAvailable(): Promise<boolean> {
    try {
      // Dynamic import using Function constructor to prevent Vite static analysis
      await new Function('return import("@duckdb/duckdb-wasm")')() as DuckDBModule;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Dispose of DuckDB resources
   */
  async dispose(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
    if (this.db) {
      await this.db.terminate();
      this.db = null;
    }
    this.initialized = false;
    this.initPromise = null;
  }
}

/**
 * Escape a string for SQL (prevent SQL injection)
 */
function escapeSQL(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  // Replace single quotes with two single quotes (SQL escape)
  return value.replace(/'/g, "''");
}
