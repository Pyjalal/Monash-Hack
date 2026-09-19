# Source-only vision recovery (#42)

`createVisionProvider({ apiKey, model?, fallbackModel? }).recover(request)` accepts only unresolved field names and PNG/JPEG images from **one** source document. Call separately for SI and BL. The caller renders the relevant source pages or crops; the provider never fetches arbitrary image URLs. Send the page numbers for exactly the images being processed. It labels each image with its original page number and returns SHA-256 hashes of decoded image bytes for provenance.

Only allowlisted fields and supplied pages are accepted. Values require confidence >= 0.8, no conflicting values and no explicit unresolved marker. A second blind transcription reads the same immutable images without seeing first-pass candidate values. Only exact field/value/page agreement survives. This is model consistency checking, not a proof of correctness; downstream source validation and deterministic SI/BL comparison remain required. `vision_recovered` means candidate recovery, never permission to send a match confirmation. Any `vision_partial` or `vision_blocked` result must route unresolved fields to clarification through the operational workflow.

## Model and cost

Default: `google/gemini-2.5-flash-lite`, a low-cost image-input model. OpenRouter lists $0.10/M input tokens and $0.40/M output tokens, including image input at the input rate, checked 2026-09-20: https://openrouter.ai/google/gemini-2.5-flash-lite/pricing . This is capability/pricing verification, not a measured extraction-accuracy benchmark. The PR author reported a live request with `google/gemini-3.5-flash`; deployments can explicitly select it as primary or fallback. Its listed rates are higher: https://openrouter.ai/google/gemini-3.5-flash-20260519/pricing . No paid model requests were made during the merge review.

Fallback is opt-in and used only for transient/unavailability failures, never permanent request/authentication failures. Revalidation makes at most one additional request after successful candidate extraction, with no retry or fallback. Reported usage/cost from both successful responses is summed; absent usage remains null, not zero or a guessed total. If a request fails without provider billing metadata, total billing cannot be established locally. Failed model JSON retains reported usage. `attempts`, `usedFallback`, `model`, `latencyMs` and recovery profile describe the complete operation.

## Bounds

- Default 3 pages; configurable maximum 10.
- Maximum 8 MiB base64 per image and 12 MiB decoded images per call; PNG/JPEG signatures checked.
- Default 800 output tokens; hard maximum 4096 per request.
- Default 15-second timeout, maximum 120 seconds per attempt; includes response body consumption.
- Maximum 1 MiB response body. Oversized responses and stalled bodies are stopped.
- Default one retry, maximum three; primary plus optional fallback each bounded, followed by at most one blind revalidation. Worst case nine attempts when configured for three retries and fallback; default with fallback at most five.

This module is independently callable and does not import the generic text client tracked in #44. OCR page rendering, field extraction/comparison and outbound policy integration remain separate work. The component returns clarification-needed outcomes; it does not itself send mail.

## Verification

`npm test -- apps/api/src/ai/vision.test.ts` exercises provider failures, malformed/oversized responses, body timeout and cancellation, bounded inputs, original page labels, absence of target values, low-confidence/conflicting/explicitly unresolved candidates, blind-pass disagreement, telemetry and fallback rules with local HTTP response fixtures. These tests do not claim live model accuracy.
