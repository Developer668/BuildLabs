import { randomUUID } from "node:crypto";

import type { EvidenceStatus } from "../domain/evidence.js";
import { digestJson } from "../lib/canonical-json.js";

export interface ReceiptBaseInput {
  runId: string;
  revisionHash: string;
  status: EvidenceStatus;
  startedAt: string;
  completedAt: string;
  input: unknown;
  output: unknown;
}

export function createReceiptBase(input: ReceiptBaseInput): {
  receiptId: string;
  runId: string;
  revisionHash: string;
  status: EvidenceStatus;
  startedAt: string;
  completedAt: string;
  inputDigest: string;
  outputDigest: string;
} {
  return {
    receiptId: randomUUID(),
    runId: input.runId,
    revisionHash: input.revisionHash,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    inputDigest: digestJson(input.input),
    outputDigest: digestJson(input.output),
  };
}
