import { expect, it } from "vitest";
import { DEFAULT_API_URL, normalizeApiUrl, isAllowedApiUrl } from "./settings.js";

it("accepts credential-free HTTP loopback and HTTPS remote API URLs", () => {
  // Loopback stays available for a locally run API.
  expect(isAllowedApiUrl("http://127.0.0.1:3001")).toBe(true);
  expect(isAllowedApiUrl("http://localhost:4312/")).toBe(true);
  expect(isAllowedApiUrl("https://127.0.0.1:3001")).toBe(true);
  // A deployed API is reachable only over HTTPS.
  expect(isAllowedApiUrl("https://cargolens.fly.dev")).toBe(true);
  expect(isAllowedApiUrl("https://cargolens.fly.dev/")).toBe(true);
});

it("rejects insecure remote hosts and any URL carrying extra request surface", () => {
  // Plaintext to a remote host would put inbox text on the wire unprotected.
  expect(isAllowedApiUrl("http://cargolens.fly.dev")).toBe(false);
  expect(isAllowedApiUrl("http://api.example.com:3001")).toBe(false);
  // Credentials, paths, queries and fragments are never part of an API origin.
  expect(isAllowedApiUrl("http://user:pass@localhost:3001")).toBe(false);
  expect(isAllowedApiUrl("https://user:pass@cargolens.fly.dev")).toBe(false);
  expect(isAllowedApiUrl("http://127.0.0.1:3001/api")).toBe(false);
  expect(isAllowedApiUrl("https://cargolens.fly.dev/api")).toBe(false);
  expect(isAllowedApiUrl("https://cargolens.fly.dev?x=1")).toBe(false);
  expect(isAllowedApiUrl("https://cargolens.fly.dev#x")).toBe(false);
  expect(isAllowedApiUrl("ftp://localhost")).toBe(false);
  expect(isAllowedApiUrl("")).toBe(false);
  expect(isAllowedApiUrl(null)).toBe(false);
});

it("normalizes accepted URLs to an origin and falls back safely", () => {
  expect(normalizeApiUrl("http://localhost:4312/")).toBe("http://localhost:4312");
  expect(normalizeApiUrl("https://cargolens.fly.dev/")).toBe("https://cargolens.fly.dev");
  expect(normalizeApiUrl("http://api.example.com")).toBe(DEFAULT_API_URL);
  expect(normalizeApiUrl(undefined)).toBe(DEFAULT_API_URL);
});
