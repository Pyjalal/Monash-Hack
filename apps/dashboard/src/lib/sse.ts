import type { CaseEvent } from "@cargolens/shared";

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Incremental text/event-stream parser. Feed chunks; receive complete frames. */
export function createSseParser(): { push(chunk: string): SseFrame[] } {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n");
      const frames: SseFrame[] = [];
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame: SseFrame = { data: "" };
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value =
            colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (field === "event") frame.event = value;
          else if (field === "id") frame.id = value;
        }
        frame.data = data.join("\n");
        if (frame.event || frame.data) frames.push(frame);
      }
      return frames;
    },
  };
}

export function parseCaseEvent(frame: SseFrame): CaseEvent | null {
  if (frame.event === "heartbeat") return null;
  try {
    const parsed = JSON.parse(frame.data) as Partial<CaseEvent>;
    if (
      typeof parsed.sequence !== "number" ||
      typeof parsed.type !== "string" ||
      typeof parsed.at !== "string"
    )
      return null;
    return {
      sequence: parsed.sequence,
      type: parsed.type,
      caseId: parsed.caseId ?? null,
      at: parsed.at,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

export type StreamState =
  "connecting" | "replaying" | "live" | "reconnecting" | "offline";

export interface StreamHandlers {
  onEvent(event: CaseEvent): void;
  onState(state: StreamState): void;
  onUnauthorized?(): void;
}

/** fetch-based SSE so the bearer token travels in a header, never in the URL. Resumes from the last sequence. */
export function openEventStream(
  url: string,
  token: string,
  handlers: StreamHandlers,
  options: {
    after?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): () => void {
  const controller = new AbortController();
  const fetchImpl = options.fetchImpl ?? fetch;
  let cursor = options.after ?? 0;
  let attempt = 0;
  let closed = false;
  options.signal?.addEventListener("abort", () => controller.abort());
  const run = async () => {
    while (!closed) {
      handlers.onState(attempt === 0 ? "connecting" : "reconnecting");
      try {
        const response = await fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Last-Event-ID": String(cursor),
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        });
        if (response.status === 401) {
          handlers.onState("offline");
          handlers.onUnauthorized?.();
          return;
        }
        if (!response.ok || !response.body)
          throw new Error(`stream ${response.status}`);
        attempt = 0;
        handlers.onState("replaying");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const frame of parser.push(
            decoder.decode(value, { stream: true }),
          )) {
            if (frame.event === "heartbeat") {
              handlers.onState("live");
              continue;
            }
            const event = parseCaseEvent(frame);
            if (event) {
              cursor = Math.max(cursor, event.sequence);
              handlers.onEvent(event);
            }
          }
        }
      } catch {
        if (closed) return;
      }
      attempt++;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(15000, 500 * 2 ** Math.min(attempt, 5))),
      );
    }
  };
  void run();
  return () => {
    closed = true;
    controller.abort();
    handlers.onState("offline");
  };
}
