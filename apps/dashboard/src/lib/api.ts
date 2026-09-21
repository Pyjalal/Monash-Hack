import type {
  Case,
  Category,
  Classification,
  OperationalDecision,
  Usage,
} from "@cargolens/shared";
import type { Flow, FlowValidation } from "@cargolens/shared/flows";

export type WorkflowState = OperationalDecision["workflowState"];
export type CaseStatus = "queued" | "classified" | "failed";
export interface InboxRow {
  id: string;
  subject: string;
  from: string;
  status: CaseStatus;
  classification: Omit<Classification, "raw"> | null;
  workflowState: WorkflowState;
  sourceVersion: string;
}
export interface InboxResponse {
  emails: InboxRow[];
  queue: { active: number; queued: number; inFlight: number };
}
export interface DraftResponse {
  draft: {
    id: string;
    caseId: string;
    sourceVersion: string;
    decisionVersion: number;
    action: string;
    to: string;
    subject: string;
    text: string;
    evidence: OperationalDecision["fieldResults"];
    templateVersion: string;
  };
}
export interface GmailStatus {
  configured: boolean;
  enabled?: boolean;
  busy?: boolean;
  authorization?: string;
  mailbox?: string;
  lastError?: string | null;
  [key: string]: unknown;
}
export interface RunReport {
  id: string;
  state: string;
  total: number;
  startedAt: string;
  wallMs?: number;
  classified?: number;
  failed?: number;
  pending?: number;
  cached?: number;
  reused?: number;
  p50Ms?: number | null;
  p95Ms?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  requests?: number;
  cacheCondition: string;
  processWarmth: string;
  latencyScope?: string;
  usageScope?: string;
  costUsd?: number | null;
  falseClears?: number | null;
}
export interface DashboardReport {
  mode?: string;
  generatedAt: string;
  counts: {
    total: number;
    classified: number;
    failed: number;
    pending: number;
  };
  usage: Usage & { requests: number };
  runs: RunReport[];
  recovery: {
    textAttempts: number;
    comparisonAttachments: number;
    ocrRecovered: number;
  };
  scope: string;
}
export interface Delivery {
  id: string;
  caseId: string;
  sourceVersion: string;
  action: string;
  status: string;
  attempts: number;
  error: string | null;
  sentMessageId: string | null;
  reply: { to: string; subject: string; text: string };
}
export interface Activity {
  sequence: number;
  type: string;
  at: string;
  data: unknown;
}
export interface SourceReading {
  id: string;
  name: string;
  status: string;
  sha256: string;
  hashMatches: boolean;
  text: string;
  spans: {
    kind: string;
    text: string;
    line?: number;
    page?: number;
    sheet?: string;
    cell?: string;
  }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
  }
}

export interface FlowRunReport {
  flowId: string;
  flowVersion: string;
  caseId: string;
  status: "COMPLETED" | "SKIPPED" | "BLOCKED" | "FAILED" | "INVALID";
  nodes: { id: string; type: string; state: string; detail?: string }[];
  outcome: { kind: string; action?: string; reason?: string } | null;
  errors: string[];
}

export interface ApiClient {
  chat(input: { message: string; history: { role: 'user' | 'assistant'; content: string }[]; caseId?: string }, signal?: AbortSignal): Promise<unknown>;
  dashboard(): Promise<DashboardReport>;
  run(id: string): Promise<RunReport>;
  activity(id: string): Promise<{ events: Activity[] }>;
  sources(
    id: string,
  ): Promise<{ sourceVersion: string; sources: SourceReading[] }>;
  recover(id: string, payload: unknown): Promise<{ recovery: unknown }>;
  emails(): Promise<InboxResponse>;
  getCase(id: string): Promise<Case>;
  comparison(
    id: string,
  ): Promise<{
    sourceVersion: string;
    decisionVersion: number;
    evidence: unknown;
  } | null>;
  importInbox(): Promise<{ job: string; queued: number }>;
  retry(id: string): Promise<Case>;
  compare(
    id: string,
    version: { sourceVersion: string; decisionVersion: number },
  ): Promise<{ saved: boolean; decision: OperationalDecision }>;
  draft(
    id: string,
    version: { sourceVersion: string; decisionVersion: number },
  ): Promise<DraftResponse>;
  flows(): Promise<{ flows: Flow[] }>;
  saveFlow(flow: Flow): Promise<{ flow: Flow; validation: FlowValidation }>;
  runFlow(caseId: string, flowId: string): Promise<{ run: FlowRunReport }>;
  gmailStatus(): Promise<GmailStatus>;
  gmailOutbox(): Promise<{ items: Delivery[] }>;
  gmailSync(): Promise<{ job: string }>;
  gmailDispatch(): Promise<{ queued: boolean }>;
}

export function createApiClient(
  baseUrl: string,
  token: string,
  onUnauthorized: () => void,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  const request = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new ApiError(401, "UNAUTHORIZED");
    }
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      details?: unknown;
    } | null;
    if (!response.ok)
      throw new ApiError(
        response.status,
        body?.error ?? `HTTP_${response.status}`,
        body?.details,
      );
    return body as T;
  };
  const post = <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    chat: (input, signal) => request('/api/chat', { method: 'POST', body: JSON.stringify(input), signal }),
    dashboard: () => request("/dashboard"),
    run: (id) => request(`/runs/${encodeURIComponent(id)}`),
    activity: (id) => request(`/cases/${encodeURIComponent(id)}/activity`),
    sources: (id) => request(`/cases/${encodeURIComponent(id)}/sources`),
    recover: (id, payload) =>
      post(`/cases/${encodeURIComponent(id)}/recover`, payload),
    emails: () => request("/emails?limit=1000"),
    getCase: (id) => request(`/cases/${encodeURIComponent(id)}`),
    comparison: async (id) => {
      try {
        return await request(`/cases/${encodeURIComponent(id)}/comparison`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    importInbox: () => post("/import"),
    retry: (id) => post(`/cases/${encodeURIComponent(id)}/retry`),
    compare: (id, version) =>
      post(`/cases/${encodeURIComponent(id)}/compare`, version),
    draft: (id, version) =>
      post(`/cases/${encodeURIComponent(id)}/draft`, version),
    flows: () => request("/flows"),
    saveFlow: (flow) => post("/flows", flow),
    runFlow: (caseId, flowId) =>
      post(`/cases/${encodeURIComponent(caseId)}/flow-run`, { flowId }),
    gmailStatus: () => request("/gmail/status"),
    gmailOutbox: () => request("/gmail/outbox"),
    gmailSync: () => post("/gmail/sync", {}),
    gmailDispatch: () => post("/gmail/dispatch"),
  };
}

/** Human labels. Benchmark words (OK, NEEDS_REVIEW) are deliberately absent: this surface shows operational state only. */
export const CATEGORY_LABEL: Record<Category, string> = {
  BL_COMPARISON: "BL comparison",
  SI_REQUEST: "SI request",
  INVOICE_QUERY: "Invoice query",
  GENERAL: "General",
  SPAM: "Spam",
  UNCERTAIN: "Uncertain",
};
export const WORKFLOW_LABEL: Record<WorkflowState, string> = {
  AWAITING_DOCUMENTS: "Awaiting documents",
  PROCESSING: "Processing",
  BLOCKED: "Needs review",
  VERIFIED: "Verified",
  MISMATCH: "Mismatch found",
  NOT_APPLICABLE: "No comparison",
  FAILED: "Failed",
};
export const API_ERROR_LABEL: Record<string, string> = {
  UNAUTHORIZED: "Session rejected by the API. Sign in again.",
  STALE_OR_MISSING_CASE:
    "The case changed since this view loaded. Reload it before acting.",
  STALE_DECISION: "Evidence version moved. Reload the case before acting.",
  COMPARISON_INTENT_UNVERIFIED:
    "Comparison is only allowed for a verified verify-now BL request.",
  EVIDENCE_READER_NOT_CONFIGURED:
    "API has no DATASET_ROOT configured; source documents cannot be read.",
  SOURCE_EVIDENCE_VALIDATION_FAILED:
    "Source evidence did not validate. Nothing was saved.",
  REPLY_VALIDATION_FAILED: "Decision saved but the outbound reply was blocked.",
  DATASET_NOT_CONFIGURED: "API has no dataset configured for import.",
  IMPORT_RUNNING: "An import is already running.",
  GMAIL_NOT_CONFIGURED: "Gmail connector is not configured on the API.",
  GMAIL_AUTOMATION_DISABLED:
    "Sending is disabled (GMAIL_AUTOMATION_ENABLED=false).",
  GMAIL_AUTHORIZATION_REQUIRED: "Connect the mailbox first.",
  GMAIL_BUSY: "Gmail connector is busy. Try again shortly.",
  NO_DRAFT_ACTION: "This decision has no outbound action to preview.",
  THREAD_CONTEXT_REQUIRED: "Thread context is required before drafting.",
  BLOCKED_OR_UNVERIFIED_CASE: "A confirmation needs seven verified matches.",
  NOT_FOUND: "Case not found.",
  INTERNAL_ERROR: "API error. Check the server log.",
};
export const describeError = (error: unknown): string =>
  error instanceof ApiError
    ? (API_ERROR_LABEL[error.code] ?? `API refused: ${error.code}`)
    : error instanceof Error
      ? error.message
      : "Unknown error";
