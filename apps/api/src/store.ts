import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ClassificationSchema, EmailSchema, OperationalDecisionSchema, type CaseEvent, type Classification, type Email, type OperationalDecision, type Usage } from '@cargolens/shared';
import { getClassificationRecoverySignals } from './ai/classify.js';

export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export type CaseRecord = { email: Email; sourceVersion: string; classification: Classification | null; decision: OperationalDecision | null; status: string; updatedAt: string };
type CaseRow = { source_json: string; source_version: string; classification_json: string | null; decision_json: string | null; status: string; updated_at: string };
export type RequestUsage = { requestId: string; model: string; usage: Usage; elapsedMs: number; emailCount: number };

export function initialDecision(classification: Classification, sourceVersion: string): OperationalDecision {
  const comparison = classification.category === 'BL_COMPARISON';
  const deferred = comparison && classification.expectation === 'FUTURE_DRAFT';
  const immediate = comparison && classification.expectation === 'VERIFY_NOW';
  const wrongDocuments = comparison && classification.documentIssue === 'WRONG_DOCS' && (classification.documentIssueConfidence ?? 0) >= 0.8;
  const recovery = getClassificationRecoverySignals(classification);
  const uncertain = recovery.length > 0 || classification.category === 'UNCERTAIN' || comparison && !deferred && !immediate && !wrongDocuments;
  return OperationalDecisionSchema.parse({
    category: classification.category, requestedAction: uncertain ? 'UNCERTAIN' : deferred ? 'REQUEST_DRAFT' : immediate || wrongDocuments ? 'VERIFY_DOCUMENTS' : 'OTHER',
    documentExpectation: uncertain ? 'UNCERTAIN' : deferred ? 'DEFERRED' : immediate || wrongDocuments ? 'EXPECTED_NOW' : 'UNCERTAIN',
    verificationState: uncertain || wrongDocuments ? 'BLOCKED' : 'NOT_STARTED', workflowState: uncertain || wrongDocuments ? 'BLOCKED' : comparison ? 'AWAITING_DOCUMENTS' : 'NOT_APPLICABLE',
    knownMismatches: [], blockers: [...recovery, ...(wrongDocuments ? ['WRONG_DOC_TYPE'] : uncertain ? ['UNCERTAIN_INTENT'] : [])],
    fieldResults: [], nextAction: recovery.length ? 'RECOVER_FIELDS' : wrongDocuments ? 'REQUEST_CLARIFICATION' : comparison ? 'FETCH_THREAD' : uncertain ? 'REQUEST_CLARIFICATION' : 'NONE', sourceVersion, decisionVersion: 1,
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
      CREATE TABLE IF NOT EXISTS ai_requests (request_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rule_cache (key TEXT PRIMARY KEY, probability REAL NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_comparisons (case_id TEXT NOT NULL, source_version TEXT NOT NULL,
        decision_version INTEGER NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(case_id, source_version, decision_version));
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
    if (changed) {
      this.emit('case.classified', id, { sourceVersion, classification, decision });
      const signals = getClassificationRecoverySignals(classification);
      if (signals.length) this.emit('classification.recovery.required', id, { sourceVersion, signals });
    }
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
  saveDocumentComparison(id: string, decision: OperationalDecision, evidence: unknown): boolean {
    return this.db.transaction(() => {
      if (!this.saveDecision(id, decision)) return false;
      this.db.prepare('INSERT INTO document_comparisons VALUES (?,?,?,?,?)')
        .run(id, decision.sourceVersion, decision.decisionVersion, JSON.stringify(evidence), new Date().toISOString());
      return true;
    })();
  }
  getDocumentComparison(id: string): { sourceVersion: string; decisionVersion: number; evidence: unknown } | null {
    const current = this.getCase(id);
    const row = this.db.prepare('SELECT evidence_json FROM document_comparisons WHERE case_id=? AND source_version=? AND decision_version=?')
      .get(id, current?.sourceVersion ?? '', current?.decision?.decisionVersion ?? 0) as { evidence_json: string } | undefined;
    return row && current?.decision ? { sourceVersion: current.sourceVersion, decisionVersion: current.decision.decisionVersion, evidence: JSON.parse(row.evidence_json) } : null;
  }
  getCached(key: string): Classification | null {
    const row = this.db.prepare('SELECT result_json FROM classification_cache WHERE key=?').get(key) as {result_json: string} | undefined;
    return row ? ClassificationSchema.parse(JSON.parse(row.result_json)) : null;
  }
  cache(key: string, result: Classification): void {
    this.db.prepare('INSERT OR REPLACE INTO classification_cache VALUES (?,?,?)').run(key, JSON.stringify(ClassificationSchema.parse(result)), new Date().toISOString());
  }
  getCachedRule(key: string): number | null {
    const row = this.db.prepare('SELECT probability FROM rule_cache WHERE key=?').get(key) as { probability: number } | undefined;
    return row && Number.isFinite(row.probability) ? row.probability : null;
  }
  cacheRule(key: string, probability: number): void {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new RangeError('Rule probability must be within [0, 1]');
    this.db.prepare('INSERT OR REPLACE INTO rule_cache VALUES (?,?,?)').run(key, probability, new Date().toISOString());
  }
  recordUsage(request: RequestUsage): void {
    this.db.prepare('INSERT OR IGNORE INTO ai_requests VALUES (?,?,?)').run(request.requestId, JSON.stringify(request), new Date().toISOString());
  }
  getRequestUsage(requestId: string): RequestUsage | null {
    const row = this.db.prepare('SELECT payload_json FROM ai_requests WHERE request_id=?').get(requestId) as {payload_json:string} | undefined;
    return row ? JSON.parse(row.payload_json) as RequestUsage : null;
  }
  usageSummary(): Usage & { requests: number } {
    const requests = this.db.prepare('SELECT payload_json FROM ai_requests').all() as {payload_json:string}[];
    return requests.reduce((sum, row) => { const request = JSON.parse(row.payload_json) as RequestUsage;
      return { requests: sum.requests + 1, input_tokens: sum.input_tokens + request.usage.input_tokens, output_tokens: sum.output_tokens + request.usage.output_tokens };
    }, { requests: 0, input_tokens: 0, output_tokens: 0 });
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
