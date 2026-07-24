import { z } from "zod";

import { sha256 } from "../../lib/canonical-json.js";

export const PiiTypeSchema = z.enum([
  "person_name",
  "email",
  "phone",
  "address",
  "government_id",
  "financial",
  "other",
]);

export const PiiSpanSchema = z
  .object({
    type: PiiTypeSchema,
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine((span) => span.endOffset > span.startOffset, {
    message: "PII span endOffset must be greater than startOffset",
    path: ["endOffset"],
  });

export type PiiSpan = z.infer<typeof PiiSpanSchema>;

export interface PiiFinding extends PiiSpan {
  value: string;
  sha256: string;
  detector: "deterministic" | "fireworks";
}

export interface MinimizedPiiResult {
  minimized: string;
  findings: PiiFinding[];
}

const EMAIL =
  /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/giu;
const PHONE =
  /(?<![\p{L}\p{N}])(?:\+?[1-9]\d{0,2}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?){2,4}\d{2,4}(?![\p{L}\p{N}])/gu;
const GOVERNMENT_ID = /\b\d{3}-\d{2}-\d{4}\b/gu;
const POSTAL_ADDRESS =
  /\b\d{1,6}\s+(?:[\p{L}\p{N}.'-]+\s+){1,6}(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b(?:[^\n,]{0,40})?/giu;
const FINANCIAL_ACCOUNT =
  /\b(?:account|routing|iban)\s*(?:number|no\.?|#)?\s*[:=-]?\s*[A-Z0-9][A-Z0-9 -]{5,33}\b/giu;
const PAYMENT_CARD = /\b(?:\d[ -]*?){13,19}\b/gu;

export function identifyAndMinimizePii(
  input: string,
  modelSpans: PiiSpan[],
): MinimizedPiiResult {
  const findings = [
    ...deterministicFindings(input, EMAIL, "email"),
    ...deterministicFindings(input, PHONE, "phone"),
    ...deterministicFindings(input, GOVERNMENT_ID, "government_id"),
    ...deterministicFindings(input, POSTAL_ADDRESS, "address"),
    ...deterministicFindings(input, FINANCIAL_ACCOUNT, "financial"),
    ...deterministicFindings(input, PAYMENT_CARD, "financial").filter(
      (finding) => passesLuhn(finding.value),
    ),
    ...modelSpans.map((rawSpan) => {
      const span = PiiSpanSchema.parse(rawSpan);
      if (span.endOffset > input.length) {
        throw new RangeError(
          `PII span ${span.startOffset}:${span.endOffset} is outside the source text`,
        );
      }
      const value = input.slice(span.startOffset, span.endOffset);
      return {
        ...span,
        value,
        sha256: sha256(value),
        detector: "fireworks" as const,
      };
    }),
  ]
    .filter(
      (finding, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.type === finding.type &&
            candidate.startOffset === finding.startOffset &&
            candidate.endOffset === finding.endOffset,
        ) === index,
    )
    .sort(
      (left, right) =>
        left.startOffset - right.startOffset ||
        left.endOffset - right.endOffset,
    );

  // String offsets are UTF-16 code-unit offsets. Operate on slices rather than
  // code points so citations elsewhere in the pipeline retain their offsets.
  let minimized = input;
  for (const finding of [...findings].sort(
    (left, right) => right.startOffset - left.startOffset,
  )) {
    const width = finding.endOffset - finding.startOffset;
    minimized =
      minimized.slice(0, finding.startOffset) +
      "█".repeat(width) +
      minimized.slice(finding.endOffset);
  }
  if (minimized.length !== input.length) {
    throw new Error("PII minimization did not preserve source offsets");
  }

  return { minimized, findings };
}

function deterministicFindings(
  input: string,
  pattern: RegExp,
  type: PiiSpan["type"],
): PiiFinding[] {
  pattern.lastIndex = 0;
  return [...input.matchAll(pattern)].flatMap((match) => {
    if (match.index === undefined || !match[0]) {
      return [];
    }
    const value = match[0];
    return [
      {
        type,
        startOffset: match.index,
        endOffset: match.index + value.length,
        confidence: 1,
        value,
        sha256: sha256(value),
        detector: "deterministic" as const,
      },
    ];
  });
}

function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}
