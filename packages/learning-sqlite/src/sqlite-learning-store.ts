import { Database } from "bun:sqlite";
import type {
  ExecutionTrace,
  Feedback,
  ScoredSkill,
  SkillRecord,
  SkillStore,
  TraceFilter,
  TraceStore,
} from "@ageflow/learning";
import { MIGRATIONS } from "./migrations.js";
import { SqliteSkillStore } from "./sqlite-skill-store.js";
import { SqliteTraceStore } from "./sqlite-trace-store.js";

/**
 * Convenience wrapper — single SQLite database backing both stores.
 * Implements SkillStore & TraceStore.
 */
export class SqliteLearningStore implements SkillStore, TraceStore {
  private readonly skillStore: SqliteSkillStore;
  private readonly traceStore: SqliteTraceStore;

  constructor(pathOrDb: string | Database) {
    const db = typeof pathOrDb === "string" ? new Database(pathOrDb) : pathOrDb;
    for (const sql of MIGRATIONS) db.run(sql);
    this.skillStore = new SqliteSkillStore(db);
    this.traceStore = new SqliteTraceStore(db);
  }

  // ─── SkillStore delegation ─────────────────────────────────────────────────

  save(skill: SkillRecord): Promise<void> {
    return this.skillStore.save(skill);
  }

  get(id: string): Promise<SkillRecord | null> {
    return this.skillStore.get(id);
  }

  getByTarget(
    targetAgent: string,
    targetWorkflow?: string,
  ): Promise<SkillRecord[]> {
    return this.skillStore.getByTarget(targetAgent, targetWorkflow);
  }

  getActiveForTask(
    taskName: string,
    workflowName?: string,
  ): Promise<SkillRecord | null> {
    return this.skillStore.getActiveForTask(taskName, workflowName);
  }

  getBestInLineage(skillId: string): Promise<SkillRecord | null> {
    return this.skillStore.getBestInLineage(skillId);
  }

  search(query: string, limit: number): Promise<ScoredSkill[]> {
    return this.skillStore.search(query, limit);
  }

  list(): Promise<SkillRecord[]> {
    return this.skillStore.list();
  }

  retire(id: string): Promise<void> {
    return this.skillStore.retire(id);
  }

  delete(id: string): Promise<void> {
    return this.skillStore.delete(id);
  }

  // ─── TraceStore delegation ─────────────────────────────────────────────────

  saveTrace(trace: ExecutionTrace): Promise<void> {
    return this.traceStore.saveTrace(trace);
  }

  getTrace(id: string): Promise<ExecutionTrace | null> {
    return this.traceStore.getTrace(id);
  }

  getTraces(filter: TraceFilter): Promise<ExecutionTrace[]> {
    return this.traceStore.getTraces(filter);
  }

  addFeedback(traceId: string, feedback: Feedback): Promise<void> {
    return this.traceStore.addFeedback(traceId, feedback);
  }
}
