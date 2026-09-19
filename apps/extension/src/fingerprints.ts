import type { InboxRowCandidate } from "./adapters.js";

export interface PreviewEmail {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  contentScope: "inbox_snippet";
  attachments: [];
}

export interface FingerprintedRow {
  candidate: InboxRowCandidate;
  fingerprint: string;
  email: PreviewEmail;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintCandidate(candidate: InboxRowCandidate): Promise<FingerprintedRow> {
  const content = [candidate.source, candidate.subject, candidate.from, candidate.snippet].join("\u241f");
  const fingerprint = await sha256Hex(content);
  const rowIdentity = await sha256Hex(`${candidate.source}\u241f${candidate.rowKey}`);
  const id = `${candidate.source}:${rowIdentity.slice(0, 16)}:${fingerprint.slice(0, 24)}`;
  return {
    candidate,
    fingerprint,
    email: {
      id,
      subject: candidate.subject,
      from: candidate.from,
      snippet: candidate.snippet,
      contentScope: "inbox_snippet",
      attachments: [],
    },
  };
}
