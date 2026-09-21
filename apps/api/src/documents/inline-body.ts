import type { Attachment, Email } from "@cargolens/shared";
import { readTextContent, type AttachmentReadResult } from "./index.js";

export interface InlineBodyDocument {
  attachment: Attachment;
  reading: AttachmentReadResult;
}

const heading = /^(?:\s*#{1,6}\s*)?(SHIPPING\s+INSTRUCTIONS?|SI\s+DOCUMENT|DRAFT\s+(?:B\s*\/?\s*L|BILL\s+OF\s+LADING)|BILL\s+OF\s+LADING|B\s*\/\s*L\s+DOCUMENT)\s*:?\s*$/gimu;

function headingRole(value: string): "si" | "bl" {
  return /SHIPPING|^SI\b/iu.test(value.trim()) ? "si" : "bl";
}

/**
 * Materialises email-body document evidence without writing a fake file.
 * Two explicitly headed SI/BL sections become two documents; otherwise the
 * whole body becomes one document and normal role/pair validation decides
 * whether a counterpart is still missing.
 */
export function inlineBodyDocuments(email: Email): InlineBodyDocument[] {
  const body = email.body?.trim();
  if (!body) return [];
  const markers = [...body.matchAll(heading)].map(match => ({
    role: headingRole(match[1]),
    start: match.index ?? 0,
    contentStart: (match.index ?? 0) + match[0].length,
  }));
  const roles = new Set(markers.map(marker => marker.role));
  const segments = roles.has("si") && roles.has("bl")
    ? markers.map((marker, index) => ({
      role: marker.role,
      text: body.slice(marker.start, markers[index + 1]?.start ?? body.length).trim(),
    })).filter(segment => segment.text)
    : [{ role: "body" as const, text: body }];
  return segments.map((segment, index) => {
    const reading = readTextContent(segment.text);
    return {
      attachment: {
        id: `inline-body:${email.id}:${segment.role}:${index + 1}`,
        name: `email-body-${segment.role}.txt`,
        mimeType: "text/plain",
        sha256: reading.sha256,
      },
      reading,
    };
  });
}
