/**
 * Documented expected behaviour for the demo fixtures.
 *
 * This file is read only when *reporting*, never when classifying. Nothing here
 * reaches the model: `buildClassificationState` passes subject, current body,
 * quoted history, content scope and attachment count, and no email id, filename
 * or label. Keeping the expectations in a separate module from the fixture
 * inbox makes that boundary obvious rather than merely true.
 */
export interface DemoExpectation {
  id: string;
  /** Live means a real provider call; replay means fixed bytes read from disk. */
  evidence: 'live-classification + fixture-documents' | 'live-classification + no-documents';
  what: string;
  expect: {
    category: string;
    requestedAction?: string;
    workflowState?: string;
    /** Field names that must be reported as mismatched, if any. */
    mismatches?: string[];
    /** Blocker codes that must be present. */
    blockers?: string[];
    /** Next action the decision must select. */
    nextAction?: string;
  };
  why: string;
}

export const DEMO_EXPECTATIONS: DemoExpectation[] = [
  {
    id: 'demo_001',
    evidence: 'live-classification + fixture-documents',
    what: 'Misleading subject: the subject line says an invoice is overdue; the current request is a BL check.',
    expect: { category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', workflowState: 'VERIFIED', mismatches: [] },
    why: 'The classifier must read the current request rather than the subject. The documents agree on all seven fields, so this is the clean confirmation path.',
  },
  {
    id: 'demo_002',
    evidence: 'live-classification + fixture-documents',
    what: 'Numeric mismatch: the SI says 3 containers, the draft BL says 4.',
    expect: { category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', workflowState: 'MISMATCH', mismatches: ['container_count'], nextAction: 'REQUEST_AMENDMENT' },
    why: 'A single-field numeric difference must be caught and named, and must block confirmation rather than being rounded away.',
  },
  {
    id: 'demo_003',
    evidence: 'live-classification + fixture-documents',
    what: 'Readable scan: both documents are image-only PDFs with no text layer.',
    expect: { category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS' },
    why: 'Scanned evidence must go through recovery rather than being reported as unreadable. If OCR cannot establish a field, the case must stay unverified instead of guessing.',
  },
  {
    id: 'demo_004',
    evidence: 'live-classification + no-documents',
    what: 'Dropped attachment: the body says the SI and draft BL are attached; nothing is.',
    expect: { category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', workflowState: 'AWAITING_DOCUMENTS', blockers: ['MISSING_ATTACHMENT'], nextAction: 'REQUEST_DOCUMENTS' },
    why: 'A promise of evidence is not evidence. The case must become an explicit request for the missing documents, never a comparison of nothing.',
  },
  {
    id: 'demo_005',
    evidence: 'live-classification + no-documents',
    what: 'The sender is asking us to prepare and send the draft BL. Subject and body agree.',
    expect: { category: 'BL_COMPARISON', requestedAction: 'REQUEST_DRAFT', workflowState: 'AWAITING_DOCUMENTS' },
    why: 'Documentation responsibility sits with us here. Nothing may be verified, and the reply must not ask this sender for the document they just requested from us.',
  },
  {
    id: 'demo_006',
    evidence: 'live-classification + no-documents',
    what: 'Genuinely contradictory: the subject asks for an SI, the body asks for a draft BL.',
    expect: { category: 'BL_COMPARISON', requestedAction: 'UNCERTAIN', workflowState: 'BLOCKED', blockers: ['UNCERTAIN_INTENT'] },
    why: 'When the subject and the body ask for different documents there is no defensible single action. The case must say so and stop, rather than pick one and act on it. This is the honest-uncertainty path, and it is why demo_005 keeps subject and body consistent.',
  },
];
