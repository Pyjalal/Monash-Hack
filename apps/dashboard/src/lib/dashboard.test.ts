import { describe, expect, it, vi } from "vitest";
import { createSseParser, openEventStream } from "./sse";
import {
  readSession,
  writeSession,
  clearSession,
  SESSION_MAX_AGE_MS,
} from "./session";
import { counts, filterRows, canCompare, canDraft } from "./view-model";
import { createApiClient, type InboxRow } from "./api";
import type { Case } from "@cargolens/shared";

describe("dashboard behavior contracts", () => {
  it("expires the tab credential, rejects future timestamps and clears sign-out state", () => {
    let value: string | null = null;
    const storage = {
      getItem: () => value,
      setItem: (_key: string, v: string) => {
        value = v;
      },
      removeItem: () => {
        value = null;
      },
    };
    writeSession(storage, {
      token: "test",
      apiUrl: "http://localhost:3001",
      issuedAt: 100,
    });
    expect(readSession(storage, 101)?.token).toBe("test");
    expect(readSession(storage, 100 + SESSION_MAX_AGE_MS)).toBeNull();
    writeSession(storage, {
      token: "test",
      apiUrl: "http://localhost:3001",
      issuedAt: 200,
    });
    expect(readSession(storage, 100)).toBeNull();
    writeSession(storage, {
      token: "test",
      apiUrl: "http://localhost:3001",
      issuedAt: 100,
    });
    clearSession(storage);
    expect(value).toBeNull();
  });
  it("parses real newline SSE frames split across network boundaries", () => {
    const parser = createSseParser();
    expect(parser.push("id: 1\r")).toEqual([]);
    expect(
      parser.push('\nevent: case.classified\r\ndata: {"sequence":1}\r\n\r\n'),
    ).toEqual([{ id: "1", event: "case.classified", data: '{"sequence":1}' }]);
    expect(parser.push("event: heartbeat\ndata: {}\n\n")).toHaveLength(1);
  });
  it("sends credentials only in headers and invokes unauthorized handling", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 401 }),
    );
    const expired = vi.fn();
    const client = createApiClient(
      "http://localhost",
      "private-test-token",
      expired,
      fetcher,
    );
    await expect(client.emails()).rejects.toThrow("UNAUTHORIZED");
    expect(expired).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).not.toContain("private-test-token");
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer private-test-token",
    });
  });
  it("filters 520 records and keeps failure/pending counters independent", () => {
    const rows = Array.from({ length: 520 }, (_, i) => ({
      id: String(i),
      subject: `Shipment ${i}`,
      from: "ops@example.test",
      status: i === 0 ? "failed" : i === 1 ? "queued" : "classified",
      classification: null,
      workflowState: "AWAITING_DOCUMENTS",
      sourceVersion: "v",
    })) as InboxRow[];
    expect(counts(rows)).toEqual({
      total: 520,
      classified: 518,
      pending: 1,
      failed: 1,
    });
    expect(filterRows(rows, "Shipment 519", "", "")).toEqual([rows[519]]);
    expect(filterRows(rows, "", "", "VERIFIED")).toEqual([]);
  });
  it("does not authorize future draft requests or uncertain intent for comparison", () => {
    const record = {
      decision: {
        category: "BL_COMPARISON",
        requestedAction: "REQUEST_DRAFT",
        documentExpectation: "DEFERRED",
        nextAction: "FETCH_THREAD",
        blockers: [],
      },
    } as unknown as Case;
    expect(canCompare(record)).toBe(false);
    expect(canDraft(record)).toBe(false);
    Object.assign(record.decision!, {
      requestedAction: "VERIFY_DOCUMENTS",
      documentExpectation: "EXPECTED_NOW",
      blockers: ["UNCERTAIN_INTENT"],
    });
    expect(canCompare(record)).toBe(false);
  });
  it("closes an unauthorized stream without a retry loop", async () => {
    const states: string[] = [];
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("", { status: 401 }),
    );
    const close = openEventStream(
      "http://localhost/events",
      "private",
      { onEvent: () => {}, onState: (state) => states.push(state) },
      { fetchImpl: fetcher },
    );
    await vi.waitFor(() => expect(states).toContain("offline"));
    expect(fetcher).toHaveBeenCalledOnce();
    close();
  });
});
