/**
 * Procedural Memory Manager
 *
 * Stores learned procedures (step-by-step instructions) with success/failure tracking.
 * Upserts on procedure name.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { ProceduralMemoryEntry, ProceduralStep } from "../types.js";
import { buildTermScore, tokenizeQuery } from "./query-tokens.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("memory.procedural");

/**
 * Cap on rows a search returns. A term-scored search over a long injected
 * prompt matches far more rows than a whole-string LIKE ever did; the budget
 * manager trims further, but an unbounded result would build the block first.
 */
const SEARCH_LIMIT = 10;

type Database = BetterSqlite3.Database;

export class ProceduralMemoryManager {
  constructor(private db: Database) {}

  /**
   * Save a procedure. Upserts on name.
   * Returns the ULID id.
   */
  save(entry: {
    name: string;
    description: string;
    steps: ProceduralStep[];
  }): string {
    const id = ulid();
    try {
      this.db.prepare(
        `INSERT INTO procedural_memory (id, name, description, steps)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           steps = excluded.steps,
           updated_at = datetime('now')`,
      ).run(
        id,
        entry.name,
        entry.description,
        JSON.stringify(entry.steps),
      );
    } catch (error) {
      logger.error("Failed to save", error instanceof Error ? error : undefined);
    }
    return id;
  }

  /**
   * Get a procedure by name.
   */
  get(name: string): ProceduralMemoryEntry | undefined {
    try {
      const row = this.db.prepare(
        "SELECT * FROM procedural_memory WHERE name = ?",
      ).get(name) as any | undefined;
      return row ? deserializeProcedural(row) : undefined;
    } catch (error) {
      logger.error("Failed to get", error instanceof Error ? error : undefined);
      return undefined;
    }
  }

  /**
   * Record a success or failure outcome for a named procedure.
   */
  recordOutcome(name: string, success: boolean): void {
    try {
      const column = success ? "success_count" : "failure_count";
      this.db.prepare(
        `UPDATE procedural_memory SET ${column} = ${column} + 1, last_used_at = datetime('now'), updated_at = datetime('now') WHERE name = ?`,
      ).run(name);
    } catch (error) {
      logger.error("Failed to record outcome", error instanceof Error ? error : undefined);
    }
  }

  /**
   * Search procedures by name or description.
   */
  search(query: string): ProceduralMemoryEntry[] {
    try {
      // A short, deliberate query is still matched as one literal substring:
      // that is what recall_procedure passes, and it keeps '%' and '_' literal
      // instead of letting them act as wildcards or term separators.
      const escaped = query.replace(/[%_]/g, (ch) => `\\${ch}`);
      const exact = this.db.prepare(
        `SELECT * FROM procedural_memory
         WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
         ORDER BY success_count DESC, updated_at DESC`,
      ).all(`%${escaped}%`, `%${escaped}%`) as any[];
      if (exact.length > 0) return exact.map(deserializeProcedural);

      // Nothing holds the query verbatim — the normal case for the retriever,
      // whose query is the whole injected turn input. Fall back to scoring
      // rows by how many distinct query terms they match. See query-tokens.ts.
      const terms = tokenizeQuery(query);
      if (terms.length === 0) return [];
      const { sql, params } = buildTermScore(terms, ["name", "description"]);
      const rows = this.db.prepare(
        `SELECT * FROM (
           SELECT *, (${sql}) AS match_score FROM procedural_memory
         )
         WHERE match_score > 0
         ORDER BY match_score DESC, success_count DESC, updated_at DESC
         LIMIT ${SEARCH_LIMIT}`,
      ).all(...params) as any[];
      return rows.map(deserializeProcedural);
    } catch (error) {
      logger.error("Failed to search", error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Delete a procedure by name.
   */
  delete(name: string): void {
    try {
      this.db.prepare("DELETE FROM procedural_memory WHERE name = ?").run(name);
    } catch (error) {
      logger.error("Failed to delete", error instanceof Error ? error : undefined);
    }
  }
}

function deserializeProcedural(row: any): ProceduralMemoryEntry {
  let steps: ProceduralStep[] = [];
  try {
    steps = JSON.parse(row.steps || "[]");
  } catch {
    logger.error("Failed to parse steps for: " + row.name);
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    steps,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
