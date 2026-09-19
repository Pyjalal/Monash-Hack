import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ClassificationSchema, EmailSchema, OperationalDecisionSchema, type CaseEvent, type Classification, type Email, type OperationalDecision } from '@cargolens/shared';

export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export type CaseRecord = { email: Email; sourceVersion: string; classification: Classification | null; decision: OperationalDecision | null; status: string; updatedAt: string };
type CaseRow = { source_json: string; source_version: string; classification_json: string | null; decision_json: string | null; status: string; updated_at: string };

export function initialDecision(classification: Classification, sourceVersion: string): OperationalDecision {
  const comparison = classification.category === 'BL_COMPARISON';
  const deferred = comparison && classification.expectation === 'FUTURE_DRAFT' && (classification.expectationConfidence ?? 0) >= 0.8;
  const immediate = comparison && ['VERIFY_NOW', 'REPORTS_MISSING'].includes(classification.expectation ?? '') && (classification.expectationConfidence ?? 0) >= 0.8;
  const uncertain = classification.category === 'UNCERTAIN' || comparison && !deferred && !immediate;
  return OperationalDecisionSchema.parse({
    category: classification.category, requestedAction: deferred ? 'REQUEST_DRAFT' : immediate ? 'VERIFY_DOCUMENTS' : uncertain ? 'UNCERTAIN' : 'OTHER',
    documentExpectation: deferred ? 'DEFERRED' : immediate ? 'EXPECTED_NOW' : 'UNCERTAIN',
    verificationState: uncertain ? 'BLOCKED' : 'NOT_STARTED', workflowState: uncertain ? 'BLOCKED' : comparison ? 'AWAITING_DOCUMENTS' : 'NOT_APPLICABLE',
    knownMismatches: [], blockers: uncertain ? ['UNCERTAIN_INTENT'] : [], fieldResults: [], nextAction: comparison ? 'FETCH_THREAD' : uncertain ? 'REQUEST_CLARIFICATION' : 'NONE', sourceVersion, decisionVersion: 1,
  });
}

export class Store {
  readonly db: Database.Database;
  private readonly emitter = new EventEmitter();
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, source_json TEXT NOT NULL, source_version TEXT NOT NULL,
        classification_json TEXT, decision_json TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS classification_cache (key TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, case_id TEXT, at TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, flow_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
  }
  close(): void { this.db.close(); }
  upsertEmail(source: Email): CaseRecord {
    const email = EmailSchema.parse(source);
    if (email.contentScope !== 'full_message') throw new Error('Only full messages can create operational cases');
    const sourceVersion = hash(email);
    const previous = this.getCase(email.id);
    if (previous?.sourceVersion === sourceVersion) return previous;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO cases (id,source_json,source_version,status,updated_at) VALUES (?,?,?,'queued',?)
        ON CONFLICT(id) DO UPDATE SET source_json=excluded.source_json,source_version=excluded.source_version,
        classification_json=NULL,decision_json=NULL,status='queued',updated_at=excluded.updated_at`).run(email.id, JSON.stringify(email), sourceVersion, new Date().toISOString());
      this.emit('case.imported', email.id, { sourceVersion, changed: !!previous });
    })();
    return this.getCase(email.id)!;
  }
  getCase(id: string): CaseRecord | null {
    const row = this.db.prepare('SELECT * FROM cases WHERE id=?').get(id) as CaseRow | undefined;
    return row ? { email: EmailSchema.parse(JSON.parse(row.source_json)), sourceVersion: row.source_version,
      classification: row.classification_json ? ClassificationSchema.parse(JSON.parse(row.classification_json)) : null,
      decision: row.decision_json ? OperationalDecisionSchema.parse(JSON.parse(row.decision_json)) : null,
      status: row.status, updatedAt: row.updated_at } : null;
  }
  listCases(limit = 520, offset = 0): CaseRecord[] {
    return (this.db.prepare('SELECT id FROM cases ORDER BY id LIMIT ? OFFSET ?').all(limit, offset) as {id: string}[]).map(row => this.getCase(row.id)!);
  }
  saveClassification(id: string, sourceVersion: string, classification: Classification): boolean {
    const decision = initialDecision(classification, sourceVersion);
    const changed = this.db.prepare(`UPDATE cases SET classification_json=?,decision_json=?,status='classified',updated_at=? WHERE id=? AND source_version=?`)
      .run(JSON.stringify(ClassificationSchema.parse(classification)), JSON.stringify(decision), new Date().toISOString(), id, sourceVersion).changes;
    if (changed) this.emit('case.classified', id, { sourceVersion, classification, decision });
    return !!changed;
  }
  saveDecision(id: string, decision: OperationalDecision): boolean {
    const parsed = OperationalDecisionSchema.parse(decision);
    const current = this.getCase(id);
    if (!current || current.sourceVersion !== parsed.sourceVersion || parsed.decisionVersion <= (current.decision?.decisionVersion ?? 0)) return false;
    this.db.prepare('UPDATE cases SET decision_json=?,updated_at=? WHERE id=? AND source_version=?')
      .run(JSON.stringify(parsed), new Date().toISOString(), id, parsed.sourceVersion);
    this.emit('case.decision', id, parsed); return true;
  }
  markFailed(id: string, sourceVersion: string, code: string): void {
    const changed = this.db.prepare("UPDATE cases SET status='failed',updated_at=? WHERE id=? AND source_version=?").run(new Date().toISOString(), id, sourceVersion).changes;
    if (changed) this.emit('case.failed', id, { code, sourceVersion });
  }
  getCached(key: string): Classification | null {
    const row = this.db.prepare('SELECT result_json FROM classification_cache WHERE key=?').get(key) as {result_json: string} | undefined;
    return row ? ClassificationSchema.parse(JSON.parse(row.result_json)) : null;
  }
  cache(key: string, result: Classification): void {
    this.db.prepare('INSERT OR REPLACE INTO classification_cache VALUES (?,?,?)').run(key, JSON.stringify(ClassificationSchema.parse(result)), new Date().toISOString());
  }
  emit(type: string, caseId: string | null, data: unknown): CaseEvent {
    const at = new Date().toISOString();
    const inserted = this.db.prepare('INSERT INTO events (type,case_id,at,data_json) VALUES (?,?,?,?)').run(type, caseId, at, JSON.stringify(data));
    const event = { sequence: Number(inserted.lastInsertRowid), type, caseId, at, data };
    this.emitter.emit('event', event); return event;
  }
  eventsAfter(sequence: number, limit = 1000): CaseEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?').all(sequence, limit) as {sequence:number; type:string; case_id:string|null; at:string; data_json:string}[])
      .map(row => ({ sequence: row.sequence, type: row.type, caseId: row.case_id, at: row.at, data: JSON.parse(row.data_json) as unknown }));
  }
  subscribe(listener: (event: CaseEvent) => void): () => void { this.emitter.on('event', listener); return () => { this.emitter.off('event', listener); }; }
}
