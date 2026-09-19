# Native readers and sourced candidates

`readAttachment({ root, relativePath, mimeType? })` returns the original file's SHA-256, extracted text, source spans, status, readability facts and a `candidates` array. The two new fields are optional in the TypeScript interface so existing injected readers remain compatible; the real readers always populate them.

```ts
const document = await readAttachment({ root, relativePath });
for (const candidate of document.candidates ?? []) {
  // Feed the literal label/value and pairing to the field selector.
  // Keep the candidate ID and source for correlation and evidence verification.
  candidate.id;
  candidate.label;
  candidate.value;
  candidate.pairing;
  candidate.source.sha256;
  candidate.source.labelSpans;
  candidate.source.valueSpans;
}
```

Candidates are structural hypotheses, not verified fields. `pairing` distinguishes a literal delimiter from adjacent spreadsheet cells, aligned consecutive spreadsheet rows, or consecutive DOCX paragraphs. The splitter does not infer SI/BL roles, normalize shipping values, or select the seven comparison fields. Downstream selection must handle ambiguity and missing candidates explicitly. A document being READABLE does not establish that every relevant field was extracted.

Each candidate ID is deterministic for the document hash, exact source spans and pairing method; it does not depend on the filename. Labels and values are literal slices of the extracted text with outer whitespace removed. Multiline values preserve internal whitespace and line breaks. Every source span includes the same offsets and locator kind as the reader: one-based text/DOCX lines, one-based PDF pages, or spreadsheet sheet/cell coordinates. DOCX table content currently uses Mammoth's serialized paragraph/line positions, not Word table coordinates. PDF candidates do not cross page boundaries; spreadsheet candidates do not cross sheets. Merged-cell aliases are skipped so the master cell remains the source.

`splitLabelValueCandidates({ sha256, text, spans }, { adjacentParagraphs? })` is reusable for supplied native-reader spans. It omits empty or visibly corrupted values and rejects values spanning unrepresented non-whitespace source gaps. Adjacent-paragraph candidates are enabled by the DOCX reader and remain explicitly unverified layout hypotheses.

Statuses distinguish `EMPTY`, `GARBLED`, `OCR_REQUIRED`, `UNSUPPORTED` and `PARSE_ERROR`, alongside path/size failures. Image-only PDF pages produce OCR_REQUIRED; mixed PDFs retain available native text and list `pagesNeedingOcr`. Corrupted PDF pages also enter that page list. GARBLED text and its spans are retained for recovery, with no field candidates asserted for a globally garbled document.

Readability records Unicode letter/number counts, replacement characters and suspicious controls. Garbled detection uses a replacement/control ratio of at least 10%, or a control-character ratio of at least 5%; it does not require Latin/ASCII text. These are transparent quality heuristics, not language understanding or OCR accuracy guarantees. Sparse corruption remains visible in the facts, and an affected candidate is omitted even if the rest of the document is readable.

Run `npx vitest run apps/api/src/documents` for source-provenance and reader fixtures. Native readers do not call model providers or perform OCR.
