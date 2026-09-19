import { expect, it } from "vitest";
import { DEFAULT_API_URL, normalizeApiUrl, isLoopbackApiUrl } from "./settings.js";

it("accepts only credential-free HTTP loopback API URLs", () => {
  expect(isLoopbackApiUrl("http://127.0.0.1:3001")).toBe(true);
  expect(isLoopbackApiUrl("http://localhost:4312/")).toBe(true);
  expect(isLoopbackApiUrl("https://127.0.0.1:3001")).toBe(false);
  expect(isLoopbackApiUrl("http://127.0.0.1:3001/api")).toBe(false);
  expect(isLoopbackApiUrl("http://user:pass@localhost:3001")).toBe(false);
});

it("normalizes accepted URLs and falls back safely", () => {
  expect(normalizeApiUrl("http://localhost:4312/")).toBe("http://localhost:4312");
  expect(normalizeApiUrl("https://api.example.com")).toBe(DEFAULT_API_URL);
});
