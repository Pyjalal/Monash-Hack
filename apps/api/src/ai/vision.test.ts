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
        base64: "unresolved-page-image",
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
          base64: "test-image",
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
          base64: "test-image",
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
          base64: "page-one-evidence",
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
      "unresolved-page-image",
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
      expect(result.attempts).toBe(1);
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
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        estimatedCostUsd: 0.001,
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
    expect(calls).toBe(2);

    if (result.ok) {
      expect(result.attempts).toBe(2);
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
    ]);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.model).toBe("fallback-model");
      expect(result.usedFallback).toBe(true);
      expect(result.attempts).toBe(2);
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