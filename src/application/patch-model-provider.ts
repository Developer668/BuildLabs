import { createHmac, timingSafeEqual } from "node:crypto";

import {
  PatchProviderBundleAttestationSchema,
  PatchProviderBundleBodySchema,
  PatchProviderBundleSchema,
  PatchProviderExampleSchema,
  PatchProviderExportAttestationSchema,
  PatchProviderExportSchema,
  PatchProviderSourceFileSchema,
  type PatchProviderBundle,
  type PatchProviderExample,
  type PatchProviderExport,
  type PatchProviderSourceFile,
} from "../domain/patch-model-provider.js";
import {
  PatchTrainingSourceSchema,
  type PatchTrainingSource,
} from "../domain/patch-model.js";
import { canonicalJson, digestJson, sha256 } from "../lib/canonical-json.js";
import {
  PATCH_CURATION_POLICY_DIGEST,
  curatePatchTrainingRecord,
} from "./patch-model-training.js";

type ProviderKey = string | Uint8Array;

export const PATCH_PROVIDER_POLICY = Object.freeze({
  version: 1,
  formats: ["openai-sft-jsonl", "fireworks-rft-jsonl"],
  content: {
    rawReasoning: false,
    rawLogs: false,
    paymentData: false,
    personalData: false,
    customerFacts: "deterministic-placeholders",
    maximumFiles: 256,
    maximumSourceBytes: 8_388_608,
  },
  rft: {
    targetInPrompt: false,
    rewardInPrompt: false,
    expectedOutputInPrompt: false,
  },
});

export const PATCH_PROVIDER_POLICY_DIGEST = digestJson(PATCH_PROVIDER_POLICY);

export const PATCH_PROVIDER_TOOLS = Object.freeze([
  {
    type: "function" as const,
    function: {
      name: "apply_patch" as const,
      description:
        "Apply one minimal unified diff to the controller-attested source.",
      strict: true as const,
      parameters: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          patch: {
            type: "string" as const,
          },
        },
        required: ["patch"] as const,
      },
    },
  },
]);

const PROVIDER_SYSTEM_PREFIX = [
  "You are the BuildLabs Patch Model.",
  "Produce the smallest safe code change that satisfies the requested hard requirement.",
  "Preserve every prior hard requirement and never invent customer facts.",
  "Return exactly one apply_patch tool call with no explanatory analysis.",
].join(" ");

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE =
  /(?<![A-Za-z0-9])(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?![A-Za-z0-9])/;
const INTERNATIONAL_PHONE =
  /(?<![A-Za-z0-9])\+\d{1,3}(?:[-.\s]?\d){7,14}(?![A-Za-z0-9])/;
const URL_OR_DOMAIN =
  /\b(?:https?:\/\/|www\.)[^\s"'<>]+|\b[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.(?:ai|app|biz|cloud|co|com|dev|info|io|me|net|online|org|shop|site|store|tech|us|xyz))+(?:\/[^\s"'<>]*)?/i;
const IP_ADDRESS =
  /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/;
const POSTAL_ADDRESS =
  /\b\d{1,6}\s+[A-Za-z][A-Za-z0-9.'-]*(?:\s+[A-Za-z][A-Za-z0-9.'-]*){0,5}\s+(?:Avenue|Ave|Boulevard|Blvd|Court|Ct|Drive|Dr|Highway|Hwy|Lane|Ln|Parkway|Pkwy|Place|Pl|Road|Rd|Street|St|Terrace|Ter|Way)\b/i;
const NAMED_PERSON =
  /\b(?:contact|customer|name|owner)\s*[:=]\s*["']?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const KNOWN_SECRET =
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:bt_|ck_|cpk-|cr[-_]|dtn_|fw_|re_|rk_(?:live|test)_|pk_(?:live|test)_|sk[-_]|xi[-_])[A-Za-z0-9._-]{8,}\b/i;
const NAMED_SECRET =
  /\b(?:api[_-]?key|authorization|credential|password|private[_-]?key|secret|token)\b\s*[:=]\s*["'][^"'\n]{4,}/i;
const PAYMENT_REFERENCE =
  /\b(?:pi|cs_(?:test|live)|cus|ch|pm|seti|sub|in)_[A-Za-z0-9]{8,}\b/i;
const PAYMENT_CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const ABSOLUTE_USER_PATH =
  /(?:^|[\s"'=(])(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/m;
const REASONING_MARKER =
  /<\s*\/?\s*think\s*>|\breasoning_content\b|\bchain[- ]of[- ]thought\b|\bprivate scratchpad\b/i;
const RAW_LOG_MARKER =
  /\b(?:stdout|stderr)\s*:\s*(?:\n|\\+n)|(?:^|\n)\s+at\s+\S+\s+\([^)]+:\d+:\d+\)/i;

interface Replacement {
  value: string;
  token: string;
}

export interface PatchProviderMaterial {
  source: PatchTrainingSource;
  sourceFiles: PatchProviderSourceFile[];
  sourceContentDigest: string;
  unifiedDiff: string;
}

function keyBytes(key: ProviderKey): Uint8Array {
  const bytes =
    typeof key === "string" ? Buffer.from(key, "utf8") : new Uint8Array(key);
  if (bytes.byteLength < 32) {
    throw new Error("Patch provider key must be at least 32 bytes");
  }
  return bytes;
}

function opaqueDigest(
  key: Uint8Array,
  namespace: string,
  value: unknown,
): string {
  return createHmac("sha256", key)
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function assertNoSensitiveContent(value: string, label: string): void {
  if (value.includes(`${String.fromCharCode(27)}[`)) {
    throw new Error(`${label} contains raw process log`);
  }
  const checks: ReadonlyArray<readonly [RegExp, string]> = [
    [EMAIL, "email address"],
    [PHONE, "phone number"],
    [INTERNATIONAL_PHONE, "international phone number"],
    [IP_ADDRESS, "IP address"],
    [URL_OR_DOMAIN, "URL or domain"],
    [POSTAL_ADDRESS, "postal address"],
    [NAMED_PERSON, "named person"],
    [BEARER, "bearer credential"],
    [KNOWN_SECRET, "provider credential"],
    [NAMED_SECRET, "named secret"],
    [PAYMENT_REFERENCE, "payment reference"],
    [ABSOLUTE_USER_PATH, "user filesystem path"],
    [REASONING_MARKER, "private reasoning"],
    [RAW_LOG_MARKER, "raw process log"],
  ];
  const match = checks.find(([pattern]) => pattern.test(value));
  if (match) {
    throw new Error(`${label} contains ${match[1]}`);
  }
  if (containsPaymentCard(value)) {
    throw new Error(`${label} contains payment card data`);
  }
}

function containsPaymentCard(value: string): boolean {
  for (const candidate of value.matchAll(PAYMENT_CARD_CANDIDATE)) {
    const digits = candidate[0].replace(/\D/g, "");
    let sum = 0;
    let alternate = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (alternate) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      alternate = !alternate;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

function validateRelativePath(path: string): void {
  PatchProviderSourceFileSchema.shape.path.parse(path);
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      "Patch provider source path must be normalized and relative",
    );
  }
  const unsafePath = [
    EMAIL,
    PHONE,
    BEARER,
    KNOWN_SECRET,
    PAYMENT_REFERENCE,
    REASONING_MARKER,
  ].find((pattern) => pattern.test(path));
  if (unsafePath !== undefined) {
    throw new Error("Patch provider source path contains sensitive content");
  }
}

function replacementToken(
  category: "FORBIDDEN" | "PROJECT" | "SUPPORTED",
  index: number,
): string {
  return `[${category}_TEXT_${String(index + 1).padStart(3, "0")}]`;
}

function projectReplacements(source: PatchTrainingSource): Replacement[] {
  const supported = source.contract.approvedFacts.flatMap((fact) => [
    fact.statement,
    ...fact.sources.map((factSource) => factSource.excerpt),
  ]);
  const project = [
    source.contract.projectId,
    source.contract.contractId,
    source.consent.projectId,
  ];
  const values: Replacement[] = [
    ...supported.map((value, index) => ({
      value,
      token: replacementToken("SUPPORTED", index),
    })),
    ...source.contract.forbiddenClaims.map((value, index) => ({
      value,
      token: replacementToken("FORBIDDEN", index),
    })),
    ...project.map((value, index) => ({
      value,
      token: replacementToken("PROJECT", index),
    })),
  ];
  const seen = new Set<string>();
  return values
    .filter(({ value }) => {
      const normalized = value.trim().toLocaleLowerCase("en-US");
      if (normalized.length < 4 || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .sort((left, right) => right.value.length - left.value.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceProjectText(
  value: string,
  replacements: Replacement[],
): string {
  let output = value;
  for (const replacement of replacements) {
    const newlineCount = [...replacement.value.matchAll(/\n/g)].length;
    output = output.replace(
      new RegExp(escapeRegExp(replacement.value), "giu"),
      `${replacement.token}${"\n".repeat(newlineCount)}`,
    );
  }
  return output;
}

function providerPathMap(
  files: readonly PatchProviderSourceFile[],
  key: Uint8Array,
): Map<string, string> {
  return new Map(
    files.map(({ path }) => {
      const extension = /\.[A-Za-z0-9]{1,16}$/u.exec(path)?.[0] ?? "";
      return [
        path,
        `files/file_${opaqueDigest(
          key,
          "buildlabs.patch-provider.path",
          path,
        ).slice(0, 24)}${extension}`,
      ];
    }),
  );
}

function replaceProviderPaths(
  value: string,
  pathMap: ReadonlyMap<string, string>,
): string {
  let output = value;
  const paths = [...pathMap.entries()].sort(
    ([left], [right]) => right.length - left.length,
  );
  for (const [sourcePath, providerPath] of paths) {
    output = output.replace(
      new RegExp(escapeRegExp(sourcePath), "gu"),
      providerPath,
    );
  }
  return output;
}

function assertProjectTextRemoved(
  value: string,
  replacements: Replacement[],
  label: string,
): void {
  const normalized = value.toLocaleLowerCase("en-US");
  const leaked = replacements.find(({ value: original }) =>
    normalized.includes(original.toLocaleLowerCase("en-US")),
  );
  if (leaked) {
    throw new Error(`${label} retains customer-specific project text`);
  }
}

interface PatchHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newCount: number;
  readonly lines: readonly string[];
}

interface ParsedFilePatch {
  readonly path: string;
  readonly hunks: readonly PatchHunk[];
}

function parseUnifiedPatch(unifiedDiff: string): {
  paths: string[];
  additions: number;
  deletions: number;
  files: ParsedFilePatch[];
} {
  if (Buffer.byteLength(unifiedDiff, "utf8") > 2_000_000) {
    throw new Error("Patch provider diff exceeds the provider-data limit");
  }
  const lines = unifiedDiff.split("\n");
  const paths: string[] = [];
  const files: ParsedFilePatch[] = [];
  let additions = 0;
  let deletions = 0;
  let current:
    | {
        path: string;
        hunks: PatchHunk[];
      }
    | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (header) {
      if (current !== undefined) {
        files.push({ path: current.path, hunks: current.hunks });
      }
      if (header[1] !== header[2]) {
        throw new Error("Patch provider data does not support renamed files");
      }
      validateRelativePath(header[1]!);
      paths.push(header[1]!);
      current = { path: header[1]!, hunks: [] };
      continue;
    }
    if (/^(?:index |--- |\+\+\+ )/u.test(line) || line === "") continue;
    const hunkHeader =
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
    if (hunkHeader) {
      if (current === undefined) {
        throw new Error("Patch provider diff hunk has no file header");
      }
      const hunkLines: string[] = [];
      for (index += 1; index < lines.length; index += 1) {
        const hunkLine = lines[index]!;
        if (hunkLine.startsWith("diff --git ") || hunkLine.startsWith("@@ ")) {
          index -= 1;
          break;
        }
        if (hunkLine === "" && index === lines.length - 1) break;
        if (hunkLine === "\\ No newline at end of file") {
          throw new Error(
            "Patch provider data requires newline-normalized source",
          );
        }
        if (!/^[- +]/u.test(hunkLine)) {
          throw new Error("Patch provider diff contains unsupported metadata");
        }
        if (hunkLine.startsWith("+")) additions += 1;
        if (hunkLine.startsWith("-")) deletions += 1;
        hunkLines.push(hunkLine);
      }
      const oldCount = Number(hunkHeader[2] ?? 1);
      const newCount = Number(hunkHeader[4] ?? 1);
      const observedOld = hunkLines.filter(
        (hunkLine) => !hunkLine.startsWith("+"),
      ).length;
      const observedNew = hunkLines.filter(
        (hunkLine) => !hunkLine.startsWith("-"),
      ).length;
      if (observedOld !== oldCount || observedNew !== newCount) {
        throw new Error("Patch provider diff hunk counts are inconsistent");
      }
      current.hunks.push({
        oldStart: Number(hunkHeader[1]),
        oldCount,
        newCount,
        lines: hunkLines,
      });
      continue;
    }
    throw new Error("Patch provider diff contains unsupported metadata");
  }
  if (current !== undefined) {
    files.push({ path: current.path, hunks: current.hunks });
  }
  if (paths.length === 0) {
    throw new Error("Patch provider diff must contain a git unified diff");
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("Patch provider diff contains duplicate file sections");
  }
  if (files.some((file) => file.hunks.length === 0)) {
    throw new Error("Patch provider diff file has no hunks");
  }
  return { paths, additions, deletions, files };
}

function applyFilePatch(content: string, patch: ParsedFilePatch): string {
  if (!content.endsWith("\n")) {
    throw new Error("Patch provider source must end with a newline");
  }
  const sourceLines = content.slice(0, -1).split("\n");
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of patch.hunks) {
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunkStart < cursor || hunkStart > sourceLines.length) {
      throw new Error("Patch provider diff hunk is outside the source");
    }
    output.push(...sourceLines.slice(cursor, hunkStart));
    cursor = hunkStart;
    for (const line of hunk.lines) {
      const marker = line[0];
      const value = line.slice(1);
      if (marker === " ") {
        if (sourceLines[cursor] !== value) {
          throw new Error("Patch provider diff context does not match source");
        }
        output.push(value);
        cursor += 1;
      } else if (marker === "-") {
        if (sourceLines[cursor] !== value) {
          throw new Error("Patch provider diff removal does not match source");
        }
        cursor += 1;
      } else {
        output.push(value);
      }
    }
  }
  output.push(...sourceLines.slice(cursor));
  return `${output.join("\n")}\n`;
}

function applyPatchSet(
  files: readonly PatchProviderSourceFile[],
  patchFiles: readonly ParsedFilePatch[],
): PatchProviderSourceFile[] {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  for (const patch of patchFiles) {
    const source = byPath.get(patch.path);
    if (source === undefined) {
      throw new Error("Patch provider diff references an omitted source file");
    }
    byPath.set(patch.path, {
      path: source.path,
      content: applyFilePatch(source.content, patch),
    });
  }
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function safeRequirement(
  source: PatchTrainingSource,
  requirementId: string,
  replacements: Replacement[],
  key: Uint8Array,
): {
  id: string;
  instruction: string;
  priority: "hard";
  verifierKinds: string[];
} {
  const requirement = source.contract.requirements.find(
    (candidate) => candidate.id === requirementId,
  );
  if (!requirement || requirement.priority !== "hard") {
    throw new Error(
      "Patch provider requirement must be a governed hard requirement",
    );
  }
  const instruction = replaceProjectText(requirement.description, replacements);
  assertNoSensitiveContent(instruction, "Patch provider requirement");
  assertProjectTextRemoved(
    instruction,
    replacements,
    "Patch provider requirement",
  );
  return {
    id: `req_${opaqueDigest(key, "buildlabs.patch-provider.requirement", {
      contractRevision: source.contract.contractRevision,
      requirementId,
    }).slice(0, 24)}`,
    instruction,
    priority: "hard",
    verifierKinds: [
      ...new Set(requirement.verifiers.map(({ kind }) => kind)),
    ].sort(),
  };
}

function providerMessageBody(
  source: PatchTrainingSource,
  files: PatchProviderSourceFile[],
  replacements: Replacement[],
  key: Uint8Array,
): string {
  const requested = safeRequirement(
    source,
    source.selection.requestedChangeRequirementId,
    replacements,
    key,
  );
  const priorRequirements = source.contract.requirements
    .filter(
      (requirement) =>
        requirement.priority === "hard" &&
        requirement.id !== source.selection.requestedChangeRequirementId,
    )
    .map((requirement) =>
      safeRequirement(source, requirement.id, replacements, key),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const content = canonicalJson({
    schemaVersion: 1,
    contractRevision: source.contract.contractRevision,
    task: {
      requestedChange: requested,
      priorRequirements,
    },
    source: {
      controllerDigest: source.patch.baseRevisionHash,
      files,
    },
    constraints: {
      changedFileLimit: source.patch.changedFileCount,
      changedLineLimit: source.patch.maxChangedLines,
      preservePriorHardRequirements: true,
      unsupportedBusinessFactsAllowed: false,
    },
  });
  assertNoSensitiveContent(content, "Patch provider prompt");
  assertProjectTextRemoved(content, replacements, "Patch provider prompt");
  return content;
}

function requireProvenMinimalRecord(
  record: ReturnType<typeof curatePatchTrainingRecord>,
): void {
  const components = record.expected.reward.components;
  if (
    !record.expected.reward.accepted ||
    record.expected.reward.terminal !== 1 ||
    Object.values(components).some((score) => score !== 1)
  ) {
    throw new Error(
      `Patch provider examples require complete proof, supported claims, privacy-safe content, and a minimal patch (${record.expected.reward.reasonCodes.join(",") || "unclassified"})`,
    );
  }
}

export function curatePatchProviderExample(
  input: PatchProviderMaterial,
  anonymizationKey: ProviderKey,
): PatchProviderExample {
  const source = PatchTrainingSourceSchema.parse(input.source);
  const key = keyBytes(anonymizationKey);
  const structuralRecord = curatePatchTrainingRecord(source, key);
  requireProvenMinimalRecord(structuralRecord);

  if (
    input.sourceFiles.length === 0 ||
    input.sourceFiles.length > PATCH_PROVIDER_POLICY.content.maximumFiles
  ) {
    throw new Error("Patch provider source file count is outside policy");
  }
  const sourceFiles = input.sourceFiles.map((file) =>
    PatchProviderSourceFileSchema.parse(file),
  );
  const paths = sourceFiles.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Patch provider source paths must be unique");
  }
  for (const path of paths) validateRelativePath(path);
  const sourceBytes = sourceFiles.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  if (sourceBytes > PATCH_PROVIDER_POLICY.content.maximumSourceBytes) {
    throw new Error("Patch provider source exceeds the provider-data limit");
  }
  const sortedSourceFiles = [...sourceFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (digestJson(sortedSourceFiles) !== input.sourceContentDigest) {
    throw new Error(
      "Patch provider source does not match the controller content digest",
    );
  }
  for (const file of sortedSourceFiles) {
    assertNoSensitiveContent(file.content, `Patch provider file ${file.path}`);
  }

  if (sha256(input.unifiedDiff) !== source.patch.diffSha256) {
    throw new Error("Patch provider diff does not match the controller digest");
  }
  const patchStats = parseUnifiedPatch(input.unifiedDiff);
  if (
    patchStats.paths.length !== source.patch.changedFileCount ||
    patchStats.additions !== source.patch.additions ||
    patchStats.deletions !== source.patch.deletions
  ) {
    throw new Error(
      "Patch provider diff statistics do not match the governed patch",
    );
  }
  applyPatchSet(sortedSourceFiles, patchStats.files);

  const replacements = projectReplacements(source);
  const pathsForProvider = providerPathMap(sortedSourceFiles, key);
  const providerFiles = sortedSourceFiles
    .map((file) => ({
      path: pathsForProvider.get(file.path)!,
      content: replaceProjectText(
        replaceProviderPaths(file.content, pathsForProvider),
        replacements,
      ),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const providerPatch = replaceProjectText(
    replaceProviderPaths(input.unifiedDiff, pathsForProvider),
    replacements,
  );
  for (const file of providerFiles) {
    assertNoSensitiveContent(file.content, `Patch provider file ${file.path}`);
    assertProjectTextRemoved(
      file.content,
      replacements,
      `Patch provider file ${file.path}`,
    );
  }
  const providerPatchPayload = providerPatch
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("diff --git ") &&
        !line.startsWith("index ") &&
        !line.startsWith("--- ") &&
        !line.startsWith("+++ ") &&
        !line.startsWith("@@ "),
    )
    .join("\n");
  assertNoSensitiveContent(providerPatchPayload, "Patch provider diff");
  assertProjectTextRemoved(providerPatch, replacements, "Patch provider diff");
  const providerPatchFiles = parseUnifiedPatch(providerPatch).files;
  applyPatchSet(providerFiles, providerPatchFiles);

  const userContent = providerMessageBody(
    source,
    providerFiles,
    replacements,
    key,
  );
  const toolCallId = `call_${structuralRecord.exampleId.slice(0, 24)}`;
  const messages = [
    {
      role: "system" as const,
      content: PROVIDER_SYSTEM_PREFIX,
    },
    {
      role: "user" as const,
      content: userContent,
    },
    {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: toolCallId,
          type: "function" as const,
          function: {
            name: "apply_patch" as const,
            arguments: canonicalJson({ patch: providerPatch }),
          },
        },
      ],
    },
    {
      role: "tool" as const,
      tool_call_id: toolCallId,
      content: canonicalJson({
        status: "PASS",
        proofDigest: structuralRecord.expected.reward.evidenceDigest,
      }),
    },
    {
      role: "assistant" as const,
      content: "Patch applied and controller verification passed.",
    },
  ];

  const requestedChangeDigest = opaqueDigest(
    key,
    "buildlabs.patch-provider.requested-change",
    {
      contractRevision: source.contract.contractRevision,
      requirementId: source.selection.requestedChangeRequirementId,
    },
  );
  const priorRequirementDigests = source.contract.requirements
    .filter(
      (requirement) =>
        requirement.priority === "hard" &&
        requirement.id !== source.selection.requestedChangeRequirementId,
    )
    .map((requirement) =>
      opaqueDigest(key, "buildlabs.patch-provider.prior-requirement", {
        contractRevision: source.contract.contractRevision,
        requirementId: requirement.id,
      }),
    )
    .sort();
  const body = {
    schemaVersion: 1 as const,
    projectScopeId: structuralRecord.projectScopeId,
    exampleId: structuralRecord.exampleId,
    split: structuralRecord.split,
    structuralRecord,
    messages,
    tools: [...PATCH_PROVIDER_TOOLS],
    expected: {
      originalPatchDigest: source.patch.diffSha256,
      providerPatchDigest: sha256(providerPatch),
      proofDigest: structuralRecord.expected.reward.evidenceDigest,
      reward: structuralRecord.expected.reward,
    },
    metadata: {
      contractRevision: source.contract.contractRevision,
      dataUseConsent: "granted" as const,
      consentReceiptDigest: structuralRecord.metadata.consentReceiptDigest,
      sourceDigest: input.sourceContentDigest,
      providerSourceDigest: digestJson(providerFiles),
      requestedChangeDigest,
      priorRequirementDigests,
      taskGroupDigest: opaqueDigest(
        key,
        "buildlabs.patch-provider.task-group",
        {
          projectScopeId: structuralRecord.projectScopeId,
          contractRevision: source.contract.contractRevision,
          requestedChangeDigest,
        },
      ),
      structuralRecordDigest: digestJson(structuralRecord),
      curationPolicyDigest: PATCH_CURATION_POLICY_DIGEST,
      providerPolicyDigest: PATCH_PROVIDER_POLICY_DIGEST,
      factPlaceholderCount: replacements.length,
    },
  };
  return PatchProviderExampleSchema.parse({
    ...body,
    exampleDigest: digestJson(body),
  });
}

function bundleAttestationBody(bundle: {
  projectScopeId: string;
  bundleDigest: string;
  examples: PatchProviderExample[];
}) {
  const providerPolicyDigests = [
    ...new Set(
      bundle.examples.map((example) => example.metadata.providerPolicyDigest),
    ),
  ];
  if (
    providerPolicyDigests.length !== 1 ||
    providerPolicyDigests[0] !== PATCH_PROVIDER_POLICY_DIGEST
  ) {
    throw new Error("Patch provider bundle uses an unknown provider policy");
  }
  return PatchProviderBundleAttestationSchema.omit({ signature: true }).parse({
    schemaVersion: 1,
    purpose: "fireworks-provider-training",
    projectScopeId: bundle.projectScopeId,
    bundleDigest: bundle.bundleDigest,
    providerPolicyDigest: providerPolicyDigests[0],
    consentReceiptDigests: [
      ...new Set(
        bundle.examples.map((example) => example.metadata.consentReceiptDigest),
      ),
    ].sort(),
    exampleCount: bundle.examples.length,
  });
}

function bundleSignature(
  body: ReturnType<typeof bundleAttestationBody>,
  key: ProviderKey,
): string {
  return createHmac("sha256", keyBytes(key))
    .update("buildlabs.patch-provider.bundle.v1")
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

function exportAttestationBody(input: {
  projectScopeId: string;
  bundleDigest: string;
  bundleAttestationSignature: string;
  providerPolicyDigest: string;
  consentReceiptDigests: string[];
  format: "fireworks-rft-jsonl" | "openai-sft-jsonl";
  split: "train" | "heldout";
  lineCount: number;
  contentSha256: string;
}) {
  return PatchProviderExportAttestationSchema.omit({ signature: true }).parse({
    schemaVersion: 1,
    purpose: "fireworks-provider-export",
    ...input,
  });
}

function exportSignature(
  body: ReturnType<typeof exportAttestationBody>,
  key: ProviderKey,
): string {
  return createHmac("sha256", keyBytes(key))
    .update("buildlabs.patch-provider.export.v1")
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

export function curatePatchProviderBundle(
  input: PatchProviderExample[],
  attestationKey: ProviderKey,
): PatchProviderBundle {
  const examples = input
    .map((example) => PatchProviderExampleSchema.parse(example))
    .sort((left, right) => left.exampleId.localeCompare(right.exampleId));
  if (examples.length < 2) {
    throw new Error("Patch provider bundle requires at least two examples");
  }
  const projectScopeId = examples[0]!.projectScopeId;
  if (examples.some((example) => example.projectScopeId !== projectScopeId)) {
    throw new Error("Patch provider bundle cannot mix projects");
  }
  for (const [values, label] of [
    [examples.map(({ exampleId }) => exampleId), "example ids"],
    [examples.map(({ metadata }) => metadata.taskGroupDigest), "task groups"],
    [
      examples.map(({ expected }) => expected.originalPatchDigest),
      "original patch digests",
    ],
    [
      examples.map(({ expected }) => expected.providerPatchDigest),
      "provider patch digests",
    ],
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new Error(`Patch provider bundle contains duplicate ${label}`);
    }
  }
  if (
    !examples.some(({ split }) => split === "train") ||
    !examples.some(({ split }) => split === "heldout")
  ) {
    throw new Error(
      "Patch provider bundle requires train and held-out examples",
    );
  }

  const body = PatchProviderBundleBodySchema.omit({
    bundleDigest: true,
  }).parse({
    schemaVersion: 1,
    projectScopeId,
    examples,
  });
  const bundleDigest = digestJson(body);
  const attestationBody = bundleAttestationBody({
    ...body,
    bundleDigest,
  });
  return PatchProviderBundleSchema.parse({
    ...body,
    bundleDigest,
    attestation: {
      ...attestationBody,
      signature: bundleSignature(attestationBody, attestationKey),
    },
  });
}

export function verifyPatchProviderBundle(
  input: PatchProviderBundle,
  attestationKey: ProviderKey,
): PatchProviderBundle {
  const bundle = PatchProviderBundleSchema.parse(input);
  const expectedBody = bundleAttestationBody(bundle);
  const actualBody = PatchProviderBundleAttestationSchema.omit({
    signature: true,
  }).parse({
    schemaVersion: bundle.attestation.schemaVersion,
    purpose: bundle.attestation.purpose,
    projectScopeId: bundle.attestation.projectScopeId,
    bundleDigest: bundle.attestation.bundleDigest,
    providerPolicyDigest: bundle.attestation.providerPolicyDigest,
    consentReceiptDigests: bundle.attestation.consentReceiptDigests,
    exampleCount: bundle.attestation.exampleCount,
  });
  if (canonicalJson(expectedBody) !== canonicalJson(actualBody)) {
    throw new Error("Patch provider bundle attestation context does not match");
  }
  const actual = Buffer.from(bundle.attestation.signature, "hex");
  const expected = Buffer.from(
    bundleSignature(expectedBody, attestationKey),
    "hex",
  );
  if (
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error("Patch provider bundle signature is invalid");
  }
  return bundle;
}

export function exportPatchProviderBundle(
  input: PatchProviderBundle,
  attestationKey: ProviderKey,
  format: "fireworks-rft-jsonl" | "openai-sft-jsonl",
  split: "train" | "heldout",
): PatchProviderExport {
  const bundle = verifyPatchProviderBundle(input, attestationKey);
  const selected = bundle.examples.filter((example) => example.split === split);
  if (selected.length === 0) {
    throw new Error(`Patch provider bundle has no ${split} examples`);
  }
  const lines = selected.map((example) => {
    const safeMetadata = {
      schemaVersion: 1,
      caseId: example.exampleId,
      projectScopeId: example.projectScopeId,
      split,
      bundleDigest: bundle.bundleDigest,
      contractRevision: example.metadata.contractRevision,
      sourceDigest: example.metadata.sourceDigest,
      providerSourceDigest: example.metadata.providerSourceDigest,
      providerPolicyDigest: example.metadata.providerPolicyDigest,
    };
    if (format === "fireworks-rft-jsonl") {
      return canonicalJson({
        messages: example.messages.slice(0, 2),
        tools: example.tools,
        metadata: safeMetadata,
      });
    }
    return canonicalJson({
      messages: example.messages,
      tools: example.tools,
      metadata: safeMetadata,
    });
  });
  const content = `${lines.join("\n")}\n`;
  const contentSha256 = sha256(content);
  const attestationBody = exportAttestationBody({
    projectScopeId: bundle.projectScopeId,
    bundleDigest: bundle.bundleDigest,
    bundleAttestationSignature: bundle.attestation.signature,
    providerPolicyDigest: bundle.attestation.providerPolicyDigest,
    consentReceiptDigests: bundle.attestation.consentReceiptDigests,
    format,
    split,
    lineCount: lines.length,
    contentSha256,
  });
  return PatchProviderExportSchema.parse({
    schemaVersion: 1,
    bundleDigest: bundle.bundleDigest,
    format,
    split,
    lineCount: lines.length,
    contentSha256,
    content,
    attestation: {
      ...attestationBody,
      signature: exportSignature(attestationBody, attestationKey),
    },
  });
}

export function verifyPatchProviderExport(
  input: PatchProviderExport,
  attestationKey: ProviderKey,
): PatchProviderExport {
  const providerExport = PatchProviderExportSchema.parse(input);
  if (
    providerExport.contentSha256 !== sha256(providerExport.content) ||
    providerExport.bundleDigest !== providerExport.attestation.bundleDigest ||
    providerExport.format !== providerExport.attestation.format ||
    providerExport.split !== providerExport.attestation.split ||
    providerExport.lineCount !== providerExport.attestation.lineCount ||
    providerExport.contentSha256 !== providerExport.attestation.contentSha256
  ) {
    throw new Error("Patch provider export attestation context does not match");
  }
  const expectedBody = exportAttestationBody({
    projectScopeId: providerExport.attestation.projectScopeId,
    bundleDigest: providerExport.attestation.bundleDigest,
    bundleAttestationSignature:
      providerExport.attestation.bundleAttestationSignature,
    providerPolicyDigest: providerExport.attestation.providerPolicyDigest,
    consentReceiptDigests: providerExport.attestation.consentReceiptDigests,
    format: providerExport.attestation.format,
    split: providerExport.attestation.split,
    lineCount: providerExport.attestation.lineCount,
    contentSha256: providerExport.attestation.contentSha256,
  });
  const actual = Buffer.from(providerExport.attestation.signature, "hex");
  const expected = Buffer.from(
    exportSignature(expectedBody, attestationKey),
    "hex",
  );
  if (
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error("Patch provider export signature is invalid");
  }
  return providerExport;
}
