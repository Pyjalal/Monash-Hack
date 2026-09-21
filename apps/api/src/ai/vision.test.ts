import { describe, expect, it } from "vitest";
import {
  createVisionProvider,
  parseVisionCandidate,
  type VisionRecoveryRequest,
} from "./vision.js";

function requestFixture(): VisionRecoveryRequest {
  return {
    unresolvedPages: [2],
    unresolvedFields: ["shipper"],
    pageImages: [
      {
        page: 2,
        mimeType: "image/png",
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2sAAAAASUVORK5CYII=",
      },
    ],
  };
}

function successResponse(
  candidates: unknown[] = [
    {
      field: "shipper",
      value: "Acme Shipping",
      page: 2,
      confidence: 0.96,
    },
  ],
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates,
              unresolvedFields: [],
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cost: 0.001,
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

describe("vision recovery provider", () => {
  it("returns an explicit error when OpenRouter credentials are missing", async () => {
    const provider = createVisionProvider({
      apiKey: "",
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("missing_credentials");
      expect(result.profile).toBe("vision_blocked");
      expect(result.model).not.toBeNull();
      expect(result.attempts).toBe(0);
    }
  });

  it("rejects page images that OCR did not mark as unresolved", async () => {
    const provider = createVisionProvider({
      apiKey: "test-key",
    });

    const result = await provider.recover({
      unresolvedPages: [1],
      unresolvedFields: ["shipper"],
      pageImages: [
        {
          page: 2,
          mimeType: "image/png",
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2sAAAAASUVORK5CYII=",
        },
      ],
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("invalid_request");
      expect(result.error.message).toContain(
        "Page 2 was not marked unresolved by OCR",
      );
      expect(result.profile).toBe("vision_blocked");
    }
  });

  it("rejects vision candidates that are not supported by unresolved evidence", () => {
    const request: VisionRecoveryRequest = {
      unresolvedPages: [1],
      unresolvedFields: ["shipper"],
      pageImages: [
        {
          page: 1,
          mimeType: "image/png",
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2sAAAAASUVORK5CYII=",
        },
      ],
    };

    expect(
      parseVisionCandidate(
        {
          field: "shipper",
          value: "Acme Shipping",
          page: 1,
          confidence: 0.95,
        },
        request,
      ),
    ).toEqual({
      field: "shipper",
      value: "Acme Shipping",
      page: 1,
      confidence: 0.95,
    });

    expect(
      parseVisionCandidate(
        {
          field: "consignee",
          value: "Invented Company",
          page: 1,
          confidence: 0.9,
        },
        request,
      ),
    ).toBeNull();

    expect(
      parseVisionCandidate(
        {
          field: "shipper",
          value: "Acme Shipping",
          page: 2,
          confidence: 0.9,
        },
        request,
      ),
    ).toBeNull();
  });

  it("rejects a candidate from an unresolved page whose image was not supplied", () => {
    const request: VisionRecoveryRequest = {
      unresolvedPages: [1, 2],
      unresolvedFields: ["shipper"],
      pageImages: [
        {
          page: 1,
          mimeType: "image/png",
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2sAAAAASUVORK5CYII=",
        },
      ],
    };

    expect(
      parseVisionCandidate(
        {
          field: "shipper",
          value: "Unsupported Page Two Value",
          page: 2,
          confidence: 0.99,
        },
        request,
      ),
    ).toBeNull();

    expect(
      parseVisionCandidate(
        {
          field: "shipper",
          value: "Supported Page One Value",
          page: 1,
          confidence: 0.99,
        },
        request,
      ),
    ).toEqual({
      field: "shipper",
      value: "Supported Page One Value",
      page: 1,
      confidence: 0.99,
    });
  });

  it("sends only unresolved page evidence to OpenRouter", async () => {
    let capturedBody = "";

    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body);
      return successResponse([]);
    };

    const provider = createVisionProvider({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: mockFetch,
    });

    await provider.recover(requestFixture());

    expect(capturedBody).toContain(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2sAAAAASUVORK5CYII=",
    );
    expect(capturedBody).toContain("shipper");
    expect(capturedBody).not.toContain(
      "expected target value",
    );
  });

  it("returns validated recovered candidates and usage", async () => {
    const provider = createVisionProvider({
      apiKey: "test-key",
      model: "test-vision-model",
      maxRetries: 0,
      fetch: async () => successResponse(),
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.model).toBe("test-vision-model");
      expect(result.profile).toBe("vision_recovered");
      expect(result.attempts).toBe(2);
      expect(result.usedFallback).toBe(false);

      expect(result.candidates).toEqual([
        {
          field: "shipper",
          value: "Acme Shipping",
          page: 2,
          confidence: 0.96,
        },
      ]);

      expect(result.unresolvedFields).toEqual([]);

      expect(result.usage).toEqual({
        promptTokens: 200,
        completionTokens: 40,
        totalTokens: 240,
        estimatedCostUsd: 0.002,
      });
    }
  });

  it("keeps unsupported evidence unresolved instead of inventing a field", async () => {
    const provider = createVisionProvider({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () =>
        successResponse([
          {
            field: "consignee",
            value: "Invented Company",
            page: 2,
            confidence: 0.99,
          },
        ]),
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.profile).toBe("vision_partial");
      expect(result.candidates).toEqual([]);
      expect(result.unresolvedFields).toEqual(["shipper"]);
    }
  });

  it("keeps conflicting candidates unresolved", async () => {
    const provider = createVisionProvider({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () =>
        successResponse([
          {
            field: "shipper",
            value: "Company A",
            page: 2,
            confidence: 0.9,
          },
          {
            field: "shipper",
            value: "Company B",
            page: 2,
            confidence: 0.9,
          },
        ]),
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.profile).toBe("vision_partial");
      expect(result.candidates).toEqual([]);
      expect(result.unresolvedFields).toEqual(["shipper"]);
    }
  });

  it("retries a transient OpenRouter failure within the configured limit", async () => {
    let calls = 0;

    const mockFetch: typeof fetch = async () => {
      calls += 1;

      if (calls === 1) {
        return new Response("temporary failure", {
          status: 503,
        });
      }

      return successResponse();
    };

    const provider = createVisionProvider({
      apiKey: "test-key",
      maxRetries: 1,
      fetch: mockFetch,
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);

    if (result.ok) {
      expect(result.attempts).toBe(3);
      expect(result.usedFallback).toBe(false);
    }
  });

  it("does not retry a non-retryable client error", async () => {
    let calls = 0;

    const provider = createVisionProvider({
      apiKey: "test-key",
      maxRetries: 2,
      fetch: async () => {
        calls += 1;

        return new Response("bad request", {
          status: 400,
        });
      },
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);

    if (!result.ok) {
      expect(result.error.code).toBe("openrouter_error");
      expect(result.attempts).toBe(1);
    }
  });

  it("does not use the fallback model for a permanent client error", async () => {
    const models: string[] = [];

    const provider = createVisionProvider({
      apiKey: "test-key",
      model: "primary-model",
      fallbackModel: "fallback-model",
      maxRetries: 2,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
        };

        models.push(body.model);

        return new Response("bad request", {
          status: 400,
        });
      },
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(false);
    expect(models).toEqual(["primary-model"]);

    if (!result.ok) {
      expect(result.error.code).toBe("openrouter_error");
      expect(result.attempts).toBe(1);
      expect(result.usedFallback).toBe(false);
      expect(result.model).toBe("primary-model");
    }
  });

  it("uses the configured fallback after the primary model remains unavailable", async () => {
    const models: string[] = [];

    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
      };

      models.push(body.model);

      if (body.model === "primary-model") {
        return new Response("unavailable", {
          status: 503,
        });
      }

      return successResponse();
    };

    const provider = createVisionProvider({
      apiKey: "test-key",
      model: "primary-model",
      fallbackModel: "fallback-model",
      maxRetries: 0,
      fetch: mockFetch,
    });

    const result = await provider.recover(requestFixture());

    expect(models).toEqual([
      "primary-model",
      "fallback-model",
      "fallback-model",
    ]);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.model).toBe("fallback-model");
      expect(result.usedFallback).toBe(true);
      expect(result.attempts).toBe(3);
    }
  });

  it("returns an explicit failure when both primary and fallback fail", async () => {
    const provider = createVisionProvider({
      apiKey: "test-key",
      model: "primary-model",
      fallbackModel: "fallback-model",
      maxRetries: 0,
      fetch: async () =>
        new Response("unavailable", {
          status: 503,
        }),
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.profile).toBe("vision_blocked");
      expect(result.usedFallback).toBe(true);
      expect(result.attempts).toBe(2);
      expect(result.error.code).toBe("model_unavailable");
    }
  });

  it("returns an explicit error for malformed model JSON", async () => {
    const provider = createVisionProvider({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "not-json",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("invalid_response");
      expect(result.profile).toBe("vision_blocked");
    }
  });

  it("rejects invalid provider limits before making a request", async () => {
    let calls = 0;

    const provider = createVisionProvider({
      apiKey: "test-key",
      maxRetries: 99,
      fetch: async () => {
        calls += 1;
        return successResponse();
      },
    });

    const result = await provider.recover(requestFixture());

    expect(result.ok).toBe(false);
    expect(calls).toBe(0);

    if (!result.ok) {
      expect(result.error.code).toBe(
        "invalid_configuration",
      );
    }
  });
});

describe("vision review regressions", () => {
  it("requests a strict JSON schema response and tolerates a fenced JSON payload", async () => {
    const bodies: Array<{ response_format?: { type?: string; json_schema?: { strict?: boolean } } }> = [];
    const fencedResponse = () => new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n{"candidates":[{"field":"shipper","value":"Acme Shipping","page":2,"confidence":0.96}],"unresolvedFields":[]}\n```' } }],
    }));
    const result = await createVisionProvider({ apiKey: "test", fetch: async (_, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { response_format?: { type?: string; json_schema?: { strict?: boolean } } });
      return fencedResponse();
    } }).recover(requestFixture());

    expect(result.profile).toBe("vision_recovered");
    expect(bodies).toHaveLength(2);
    expect(bodies.every(body => body.response_format?.type === "json_schema" && body.response_format.json_schema?.strict === true)).toBe(true);
  });

  it("sends bounded positioned text as transcription assistance while keeping the image authoritative", async () => {
    const bodies: string[] = [];
    const request = requestFixture();
    request.positionedText = [{ page: 2, width: 600, height: 800, blocks: [
      { id: "p2_b1", text: "Notify Party", x: 50, y: 500, width: 80, height: 10 },
      { id: "p2_b2", text: "NAGAPPA EXPORTS", x: 170, y: 500, width: 100, height: 10 },
    ] }];
    const result = await createVisionProvider({ apiKey: "test", fetch: async (_, init) => {
      bodies.push(String(init?.body)); return successResponse();
    } }).recover(request);
    expect(result.profile).toBe("vision_recovered");
    expect(bodies).toHaveLength(2);
    expect(bodies.every(body => body.includes("Positioned text-layer evidence") && body.includes("Notify Party"))).toBe(true);
  });

  it("labels original page numbers and never feeds first-pass answers into revalidation", async () => {
    const bodies: string[] = [];
    const request = Object.assign(requestFixture(), { targetValues: { shipper: "SECRET TARGET" } });
    const result = await createVisionProvider({ apiKey: "test", fetch: async (_, init) => {
      bodies.push(String(init?.body)); return successResponse();
    } }).recover(request);
    expect(result.profile).toBe("vision_recovered");
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain("Source document page 2:");
      expect(body).not.toContain("Acme Shipping");
      expect(body).not.toContain("SECRET TARGET");
    }
  });
  it("keeps disagreeing blind transcriptions unresolved", async () => {
    let calls = 0;
    const result = await createVisionProvider({ apiKey: "test", fetch: async () => {
      calls++; return calls === 1 ? successResponse() : successResponse([{ field: "shipper", value: "Different", page: 2, confidence: 0.99 }]);
    } }).recover(requestFixture());
    expect(result).toMatchObject({ profile: "vision_partial", candidates: [], unresolvedFields: ["shipper"], attempts: 2 });
  });
  it("keeps failed revalidation unresolved and unknown cost unknown", async () => {
    let calls = 0;
    const result = await createVisionProvider({ apiKey: "test", fetch: async () => ++calls === 1 ? successResponse() : new Response("failed", { status: 503 }) }).recover(requestFixture());
    expect(result).toMatchObject({ profile: "vision_partial", candidates: [], attempts: 2, usage: { estimatedCostUsd: null } });
  });
  it.each([0, null, 0.79])("rejects insufficient confidence %s", async (confidence) => {
    const result = await createVisionProvider({ apiKey: "test", fetch: async () => successResponse([{ field: "shipper", value: "Guess", page: 2, confidence }]) }).recover(requestFixture());
    expect(result).toMatchObject({ profile: "vision_partial", candidates: [] });
  });
  it("honors an explicitly unresolved field even with a candidate", async () => {
    const response = await successResponse().json();
    response.choices[0].message.content = JSON.stringify({ candidates: [{ field: "shipper", value: "Guess", page: 2, confidence: 0.99 }], unresolvedFields: ["shipper"] });
    const result = await createVisionProvider({ apiKey: "test", fetch: async () => Response.json(response) }).recover(requestFixture());
    expect(result).toMatchObject({ profile: "vision_partial", candidates: [], attempts: 1 });
  });
  it("bounds a response body that stalls after headers and cancels it", async () => {
    let cancelled = false;
    const result = await createVisionProvider({ apiKey: "test", timeoutMs: 20, maxRetries: 0, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }).recover(requestFixture());
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(cancelled).toBe(true);
  });
  it("rejects oversized responses", async () => {
    const result = await createVisionProvider({ apiKey: "test", maxRetries: 0, fetch: async () => new Response("x".repeat(1024 * 1024 + 1)) }).recover(requestFixture());
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_response" } });
  });
  it.each([null, [], { choices: [] }])("handles malformed top-level response %j", async (body) => {
    const result = await createVisionProvider({ apiKey: "test", fetch: async () => Response.json(body) }).recover(requestFixture());
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_response" } });
  });
  it("retains paid usage when model JSON is malformed", async () => {
    const result = await createVisionProvider({ apiKey: "test", fetch: async () => Response.json({ choices: [{ message: { content: "not json" } }], usage: { cost: 0.002 } }) }).recover(requestFixture());
    expect(result).toMatchObject({ ok: false, usage: { estimatedCostUsd: 0.002 } });
  });
  it("rejects invalid fields, page identifiers and image bytes before calling provider", async () => {
    for (const mutate of [
      (r: VisionRecoveryRequest) => { r.unresolvedPages = [0]; },
      (r: VisionRecoveryRequest) => { r.unresolvedFields = ["target value" as never]; },
      (r: VisionRecoveryRequest) => { r.pageImages[0].base64 = "not-an-image"; },
      (r: VisionRecoveryRequest) => { r.pageImages[0].base64 = "a".repeat(8 * 1024 * 1024 + 1); },
    ]) {
      const request = requestFixture(); mutate(request);
      const result = await createVisionProvider({ apiKey: "test", fetch: async () => { throw new Error("must not call"); } }).recover(request);
      expect(result).toMatchObject({ ok: false, attempts: 0, error: { code: "invalid_request" } });
    }
  });
});

it("retains original evidence despite caller mutation while the request is pending", async () => {
  const request = requestFixture();
  let calls = 0;
  const result = await createVisionProvider({ apiKey: "test", fetch: async (_, init) => {
    calls++;
    if (calls === 1) {
      request.pageImages[0].base64 = "mutated";
      request.unresolvedFields = ["consignee"];
    }
    expect(String(init?.body)).not.toContain("mutated");
    return successResponse();
  } }).recover(request);
  expect(result).toMatchObject({ profile: "vision_recovered", unresolvedFields: [], sourceImageHashes: [{ page: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
});
