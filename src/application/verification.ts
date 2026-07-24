import type { BuildAssignment } from "../domain/contract.js";
import {
  SandboxAsyncExecutionReceiptSchema,
  type CommandReceipt,
  type SandboxAsyncExecutionReceipt,
} from "../domain/evidence.js";
import { digestJson, sha256 } from "../lib/canonical-json.js";
import { boundText } from "../lib/redaction.js";
import type {
  SandboxSession,
  TraceSpan,
  VerificationTarget,
} from "../ports/index.js";
import { DEPENDENCY_BOOTSTRAP_COMMAND } from "./dependency-bootstrap.js";
import { createReceiptBase } from "./receipts.js";

export const DOCKERFILE_VERIFICATION_COMMAND =
  "test -s Dockerfile && grep -Eq '^[[:space:]]*FROM[[:space:]]+' Dockerfile";
export const CONTAINER_IMAGE_TAG = "buildlabs-proof";
export const CONTAINER_BUILD_COMMAND = `docker build --tag ${CONTAINER_IMAGE_TAG} .`;
export type VerificationPhase = "commands" | "delivery";

const FORBIDDEN_CLAIM_SCANNER_SOURCE = String.raw`
"use strict";

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} = require("node:fs");
const { extname, relative, resolve, sep } = require("node:path");

const MAX_DIAGNOSTICS = 20;
const MAX_PATH_CHARACTERS = 240;
const MAX_GIT_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_WORKSPACE_BYTES = 500 * 1024 * 1024;
const MAX_FORBIDDEN_CLAIMS = 100;
const MAX_FORBIDDEN_CLAIM_CHARACTERS = 500;
const MAX_ENCODED_PAYLOADS = 256;
const MAX_DECODED_PAYLOAD_BYTES = 4 * 1024 * 1024;
const RESERVED_TRACKED_DIRECTORIES = new Set([
  ".buildlabs",
  ".git",
  "node_modules",
]);

function hasReservedTrackedDirectory(path) {
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) =>
      RESERVED_TRACKED_DIRECTORIES.has(segment.toLowerCase()),
    );
}

function boundedPath(path) {
  const characters = Array.from(path);
  if (characters.length <= MAX_PATH_CHARACTERS) {
    return { path };
  }
  const edge = Math.floor((MAX_PATH_CHARACTERS - 3) / 2);
  return {
    path: characters.slice(0, edge).join("") + "..." + characters.slice(-edge).join(""),
    pathDigest: createHash("sha256").update(path).digest("hex"),
    pathTruncated: true,
  };
}

function compactWithOffsets(value) {
  const characters = [];
  const offsets = [];
  for (const match of value.matchAll(/[\p{L}\p{N}]/gu)) {
    characters.push(match[0]);
    for (let index = 0; index < match[0].length; index += 1) {
      offsets.push(match.index);
    }
  }
  return { text: characters.join(""), offsets };
}

function hasPrefix(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function asciiAt(bytes, offset, length) {
  return bytes.subarray(offset, offset + length).toString("ascii");
}

function isVerifiedBinaryAsset(path, absolute, size) {
  const extension = extname(path).toLowerCase();
  const descriptors = openSync(absolute, "r");
  const bytes = Buffer.alloc(Math.min(512, size));
  try {
    readSync(descriptors, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(descriptors);
  }
  switch (extension) {
    case ".png":
      return hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
    case ".jpg":
    case ".jpeg":
      return hasPrefix(bytes, [255, 216, 255]);
    case ".gif":
      return asciiAt(bytes, 0, 6) === "GIF87a" ||
        asciiAt(bytes, 0, 6) === "GIF89a";
    case ".webp":
      return asciiAt(bytes, 0, 4) === "RIFF" &&
        asciiAt(bytes, 8, 4) === "WEBP";
    case ".avif":
      return asciiAt(bytes, 4, 4) === "ftyp" &&
        ["avif", "avis"].includes(asciiAt(bytes, 8, 4));
    case ".bmp":
      return asciiAt(bytes, 0, 2) === "BM";
    case ".ico":
      return hasPrefix(bytes, [0, 0, 1, 0]);
    case ".pdf":
      return asciiAt(bytes, 0, 5) === "%PDF-";
    case ".wasm":
      return hasPrefix(bytes, [0, 97, 115, 109]);
    case ".zip":
      return hasPrefix(bytes, [80, 75, 3, 4]) ||
        hasPrefix(bytes, [80, 75, 5, 6]) ||
        hasPrefix(bytes, [80, 75, 7, 8]);
    case ".gz":
      return hasPrefix(bytes, [31, 139]);
    case ".7z":
      return hasPrefix(bytes, [55, 122, 188, 175, 39, 28]);
    case ".woff":
      return asciiAt(bytes, 0, 4) === "wOFF";
    case ".woff2":
      return asciiAt(bytes, 0, 4) === "wOF2";
    case ".ttf":
      return hasPrefix(bytes, [0, 1, 0, 0]);
    case ".otf":
      return asciiAt(bytes, 0, 4) === "OTTO";
    case ".mp3":
      return asciiAt(bytes, 0, 3) === "ID3" ||
        (bytes[0] === 255 && (bytes[1] & 224) === 224);
    case ".mp4":
    case ".mov":
      return asciiAt(bytes, 4, 4) === "ftyp";
    case ".webm":
      return hasPrefix(bytes, [26, 69, 223, 163]);
    case ".wav":
      return asciiAt(bytes, 0, 4) === "RIFF" &&
        asciiAt(bytes, 8, 4) === "WAVE";
    case ".flac":
      return asciiAt(bytes, 0, 4) === "fLaC";
    case ".tar":
      return asciiAt(bytes, 257, 5) === "ustar";
    default:
      return false;
  }
}

function lineAtOffset(value, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (value.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function buildMatcher(patterns) {
  const nodes = [{ next: new Map(), fail: 0, outputs: [] }];
  for (const pattern of patterns) {
    let state = 0;
    for (let offset = 0; offset < pattern.text.length; offset += 1) {
      const character = pattern.text[offset];
      let nextState = nodes[state].next.get(character);
      if (nextState === undefined) {
        nextState = nodes.length;
        nodes[state].next.set(character, nextState);
        nodes.push({ next: new Map(), fail: 0, outputs: [] });
      }
      state = nextState;
    }
    nodes[state].outputs.push({
      index: pattern.index,
      length: pattern.text.length,
    });
  }
  const queue = [];
  for (const state of nodes[0].next.values()) {
    queue.push(state);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor];
    for (const [character, nextState] of nodes[state].next) {
      queue.push(nextState);
      let fallback = nodes[state].fail;
      while (fallback !== 0 && !nodes[fallback].next.has(character)) {
        fallback = nodes[fallback].fail;
      }
      const fallbackState = nodes[fallback].next.get(character);
      nodes[nextState].fail =
        fallbackState !== undefined && fallbackState !== nextState
          ? fallbackState
          : 0;
      nodes[nextState].outputs.push(
        ...nodes[nodes[nextState].fail].outputs,
      );
    }
  }
  return nodes;
}

function findMatches(value, matcher, visit) {
  let state = 0;
  for (let offset = 0; offset < value.length; offset += 1) {
    const character = value[offset];
    while (state !== 0 && !matcher[state].next.has(character)) {
      state = matcher[state].fail;
    }
    state = matcher[state].next.get(character) ?? 0;
    for (const output of matcher[state].outputs) {
      if (visit(output.index, offset - output.length + 1) === false) {
        return false;
      }
    }
  }
  return true;
}

function decodeBoundedBase64Payloads(value) {
  const payloads = [];
  let totalBytes = 0;
  const patterns = [
    /\batob\s*\(\s*(["'])([a-z0-9+/_-]{8,}={0,2})\1/giu,
    /\bbuffer\s*\.\s*from\s*\(\s*(["'])([a-z0-9+/_-]{8,}={0,2})\1\s*,\s*(["'])base64(?:url)?\3/giu,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (payloads.length >= MAX_ENCODED_PAYLOADS) {
        throw new Error("source contains too many encoded payloads");
      }
      const encoded = match[2];
      let bytes;
      try {
        bytes = Buffer.from(encoded, "base64url");
      } catch {
        continue;
      }
      if (bytes.length === 0) {
        continue;
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_DECODED_PAYLOAD_BYTES) {
        throw new Error("decoded source payloads exceed scan limit");
      }
      payloads.push({
        offset: match.index,
        text: bytes
          .toString("utf8")
          .normalize("NFKC")
          .toLocaleLowerCase("en-US"),
      });
    }
  }
  return payloads;
}

function main() {
  const encodedClaims = process.argv[1];
  if (!encodedClaims) {
    throw new Error("missing claims");
  }
  const claims = JSON.parse(
    Buffer.from(encodedClaims, "base64url").toString("utf8"),
  );
  if (
    !Array.isArray(claims) ||
    claims.length < 1 ||
    claims.length > MAX_FORBIDDEN_CLAIMS ||
    claims.some(
      (claim) =>
        typeof claim !== "string" ||
        claim.length < 1 ||
        claim.length > MAX_FORBIDDEN_CLAIM_CHARACTERS,
    )
  ) {
    throw new Error("invalid claims");
  }
  const exactPatterns = claims.map((claim, index) => ({
    index,
    text: claim.normalize("NFKC").toLocaleLowerCase("en-US"),
  }));
  const compactPatterns = exactPatterns
    .map((pattern) => ({
      index: pattern.index,
      text: compactWithOffsets(pattern.text).text,
    }))
    .filter((pattern) => pattern.text.length >= 4);
  const exactMatcher = buildMatcher(exactPatterns);
  const compactMatcher = buildMatcher(compactPatterns);
  const root = resolve(".");
  const manifest = execFileSync("git", ["ls-files", "-z", "--cached"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: MAX_GIT_MANIFEST_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const paths = manifest
    .subarray(0, manifest.length > 0 && manifest.at(-1) === 0 ? -1 : undefined)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );

  const diagnostics = [];
  const locations = new Set();
  let omitted = false;
  let totalSourceBytes = 0;
  let totalWorkspaceBytes = 0;
  pathLoop: for (const path of paths) {
    if (hasReservedTrackedDirectory(path)) {
      throw new Error("reserved directory is tracked");
    }
    const absolute = resolve(root, ...path.split("/"));
    const child = relative(root, absolute);
    if (
      child.length === 0 ||
      child === ".." ||
      child.startsWith(".." + sep)
    ) {
      throw new Error("unsafe path");
    }
    const metadata = lstatSync(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("unsupported source entry");
    }
    totalWorkspaceBytes += metadata.size;
    if (totalWorkspaceBytes > MAX_TOTAL_WORKSPACE_BYTES) {
      throw new Error("workspace exceeds scan limit");
    }
    const verifiedBinary = isVerifiedBinaryAsset(
      path,
      absolute,
      metadata.size,
    );
    if (verifiedBinary && metadata.size > MAX_BINARY_FILE_BYTES) {
      throw new Error("binary asset exceeds scan limit");
    }
    if (!verifiedBinary && metadata.size > MAX_SOURCE_FILE_BYTES) {
      throw new Error("source file exceeds scan limit");
    }
    if (!verifiedBinary) {
      totalSourceBytes += metadata.size;
      if (totalSourceBytes > MAX_TOTAL_SOURCE_BYTES) {
        throw new Error("source tree exceeds scan limit");
      }
    }
    const bytes = readFileSync(absolute);
    if (!verifiedBinary && bytes.includes(0) && extname(path) === "") {
      throw new Error("unclassified NUL-containing source file");
    }
    const sourceText = bytes.toString("utf8").normalize("NFKC");
    const haystack = sourceText.toLocaleLowerCase("en-US");
    const addLocation = (forbiddenClaimIndex, line) => {
      const location =
        String(forbiddenClaimIndex) + "\0" + path + "\0" + String(line);
      if (locations.has(location)) {
        return true;
      }
      locations.add(location);
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push({
          forbiddenClaimIndex,
          ...boundedPath(path),
          line,
        });
      } else {
        omitted = true;
      }
      return !omitted;
    };
    if (
      !findMatches(haystack, exactMatcher, (forbiddenClaimIndex, offset) =>
        addLocation(
          forbiddenClaimIndex,
          lineAtOffset(haystack, offset),
        ),
      )
    ) {
      break pathLoop;
    }
    if (!verifiedBinary && compactPatterns.length > 0) {
      const compact = compactWithOffsets(haystack);
      if (
        !findMatches(
          compact.text,
          compactMatcher,
          (forbiddenClaimIndex, offset) => {
            const sourceOffset = compact.offsets[offset];
            return sourceOffset === undefined
              ? true
              : addLocation(
                  forbiddenClaimIndex,
                  lineAtOffset(haystack, sourceOffset),
                );
          },
        )
      ) {
        break pathLoop;
      }
    }
    if (!verifiedBinary) {
      for (const payload of decodeBoundedBase64Payloads(sourceText)) {
        const sourceLine = lineAtOffset(sourceText, payload.offset);
        if (
          !findMatches(
            payload.text,
            exactMatcher,
            (forbiddenClaimIndex) =>
              addLocation(forbiddenClaimIndex, sourceLine),
          )
        ) {
          break pathLoop;
        }
        if (compactPatterns.length > 0) {
          const compactPayload = compactWithOffsets(payload.text).text;
          if (
            !findMatches(
              compactPayload,
              compactMatcher,
              (forbiddenClaimIndex) =>
                addLocation(forbiddenClaimIndex, sourceLine),
            )
          ) {
            break pathLoop;
          }
        }
      }
    }
  }

  if (locations.size > 0) {
    process.stdout.write(
      "BUILDLABS_FORBIDDEN_CLAIM_MATCHES_V1 " +
        JSON.stringify({ matches: diagnostics, truncated: omitted }) +
        "\n",
    );
    process.exitCode = 1;
  }
}

try {
  main();
} catch {
  process.stderr.write("BUILDLABS_FORBIDDEN_CLAIM_SCAN_ERROR_V1\n");
  process.exitCode = 2;
}
`;

interface CommandTarget {
  kind: CommandReceipt["kind"];
  command: string;
  timeoutSeconds: number;
  requirementId?: string;
  verifierIndex?: number;
  forbiddenClaimIndices?: number[];
}

export interface CommandVerificationRequest {
  runId: string;
  revisionHash: string;
  assignment: BuildAssignment;
  sandbox: SandboxSession;
  phase: VerificationPhase;
  trace: TraceSpan;
  signal?: AbortSignal | undefined;
}

export async function runCommandVerification(
  request: CommandVerificationRequest,
): Promise<CommandReceipt[]> {
  const targets = commandTargets(request.assignment, request.phase);
  const receipts: CommandReceipt[] = [];

  for (const target of targets) {
    throwIfAborted(request.signal);
    const receipt = await request.trace.child(
      `verify.${target.kind}`,
      "tool",
      {
        kind: target.kind,
        command: target.command,
        ...(target.requirementId
          ? {
              requirementId: target.requirementId,
              verifierIndex: target.verifierIndex,
            }
          : {}),
        ...(target.forbiddenClaimIndices
          ? { forbiddenClaimIndices: target.forbiddenClaimIndices }
          : {}),
      },
      async (span) => {
        const asyncReceiptsBefore = snapshotAsyncExecutionReceipts(
          request.sandbox,
        );
        const startedAt = new Date().toISOString();
        try {
          const result = await request.sandbox.runCommand(
            target.command,
            target.timeoutSeconds,
            request.signal,
          );
          const asyncExecution = appendedAsyncExecutionReceipt(
            request.sandbox,
            asyncReceiptsBefore,
            target.command,
          );
          const completedAt = new Date().toISOString();
          const output = {
            exitCode: result.exitCode,
            stdout: boundText(
              result.stdout,
              request.assignment.limits.maxToolOutputBytes,
            ),
            stderr: boundText(
              result.stderr,
              request.assignment.limits.maxToolOutputBytes,
            ),
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            durationMs: result.durationMs,
            ...(asyncExecution ? { asyncExecution } : {}),
          };
          const receipt: CommandReceipt = {
            ...createReceiptBase({
              runId: request.runId,
              revisionHash: request.revisionHash,
              status: result.exitCode === 0 ? "PASS" : "FAIL",
              startedAt,
              completedAt,
              input: target,
              output,
            }),
            kind: target.kind,
            provider: "daytona",
            command: target.command,
            exitCode: result.exitCode,
            stdout: output.stdout,
            stderr: output.stderr,
            stdoutTruncated: output.stdoutTruncated,
            stderrTruncated: output.stderrTruncated,
            durationMs: result.durationMs,
            ...(asyncExecution ? { asyncExecution } : {}),
            ...(target.requirementId
              ? {
                  requirementId: target.requirementId,
                  verifierIndex: target.verifierIndex,
                }
              : {}),
            ...(target.forbiddenClaimIndices
              ? { forbiddenClaimIndices: target.forbiddenClaimIndices }
              : {}),
          };
          span.log({
            output: {
              status: receipt.status,
              exitCode: receipt.exitCode,
              durationMs: receipt.durationMs,
            },
          });
          return receipt;
        } catch (error) {
          let commandError = error;
          let asyncExecution: SandboxAsyncExecutionReceipt | undefined;
          try {
            asyncExecution = appendedAsyncExecutionReceipt(
              request.sandbox,
              asyncReceiptsBefore,
              target.command,
            );
          } catch (bindingError) {
            commandError = bindingError;
          }
          const completedAt = new Date().toISOString();
          const message = boundText(
            commandError instanceof Error
              ? commandError.message
              : "Unknown command error",
            8_192,
          );
          const output = {
            error: message,
            ...(asyncExecution ? { asyncExecution } : {}),
          };
          const receipt: CommandReceipt = {
            ...createReceiptBase({
              runId: request.runId,
              revisionHash: request.revisionHash,
              status: "ERROR",
              startedAt,
              completedAt,
              input: target,
              output,
            }),
            kind: target.kind,
            provider: "daytona",
            command: target.command,
            exitCode: null,
            stdout: "",
            stderr: message,
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: Math.max(
              0,
              Date.parse(completedAt) - Date.parse(startedAt),
            ),
            ...(asyncExecution ? { asyncExecution } : {}),
            ...(target.requirementId
              ? {
                  requirementId: target.requirementId,
                  verifierIndex: target.verifierIndex,
                }
              : {}),
            ...(target.forbiddenClaimIndices
              ? { forbiddenClaimIndices: target.forbiddenClaimIndices }
              : {}),
          };
          span.log({ error: message });
          return receipt;
        }
      },
    );
    receipts.push(receipt);
    if (target.kind === "dependency-bootstrap" && receipt.status !== "PASS") {
      break;
    }
  }

  return receipts;
}

function snapshotAsyncExecutionReceipts(
  sandbox: SandboxSession,
): SandboxAsyncExecutionReceipt[] | undefined {
  if (!sandbox.asyncExecutionReceipts) {
    return undefined;
  }
  return SandboxAsyncExecutionReceiptSchema.array().parse(
    sandbox.asyncExecutionReceipts(),
  );
}

function appendedAsyncExecutionReceipt(
  sandbox: SandboxSession,
  before: SandboxAsyncExecutionReceipt[] | undefined,
  command: string,
): SandboxAsyncExecutionReceipt | undefined {
  if (!sandbox.asyncExecutionReceipts || before === undefined) {
    return undefined;
  }
  const after = SandboxAsyncExecutionReceiptSchema.array().parse(
    sandbox.asyncExecutionReceipts(),
  );
  if (
    after.length < before.length ||
    digestJson(after.slice(0, before.length)) !== digestJson(before)
  ) {
    throw new Error("Daytona async execution receipt history changed");
  }
  const appended = after.slice(before.length);
  if (appended.length > 1) {
    throw new Error(
      "Daytona command emitted multiple async execution receipts",
    );
  }
  const receipt = appended[0];
  if (receipt && receipt.commandSha256 !== sha256(command)) {
    throw new Error("Daytona async execution receipt covered another command");
  }
  return receipt;
}

function commandTargets(
  assignment: BuildAssignment,
  phase: VerificationPhase,
): CommandTarget[] {
  if (phase === "delivery") {
    return [
      {
        kind: "artifact",
        command: DOCKERFILE_VERIFICATION_COMMAND,
        timeoutSeconds: 30,
      },
      {
        kind: "container-build",
        command: CONTAINER_BUILD_COMMAND,
        timeoutSeconds: 900,
      },
    ];
  }

  const targets: CommandTarget[] = [
    ...(assignment.contract.forbiddenClaims.length > 0
      ? [
          {
            kind: "forbidden-claim" as const,
            command: forbiddenClaimsCommand(
              assignment.contract.forbiddenClaims,
            ),
            timeoutSeconds: 120,
            forbiddenClaimIndices: assignment.contract.forbiddenClaims.map(
              (_, index) => index,
            ),
          },
        ]
      : []),
    {
      kind: "dependency-bootstrap",
      command: DEPENDENCY_BOOTSTRAP_COMMAND,
      timeoutSeconds: 900,
    },
    {
      kind: "build",
      command: assignment.contract.verification.buildCommand,
      timeoutSeconds: 900,
    },
    ...assignment.contract.verification.testCommands.map((command) => ({
      kind: "test" as const,
      command,
      timeoutSeconds: 900,
    })),
  ];

  const requirementTargets: VerificationTarget[] =
    assignment.contract.requirements.flatMap((requirement) =>
      requirement.verifiers.map((verifier, verifierIndex) => ({
        requirementId: requirement.id,
        verifierIndex,
        verifier,
      })),
    );

  for (const target of requirementTargets) {
    if (
      target.verifier.kind !== "command" ||
      !target.requirementId ||
      target.verifierIndex === undefined
    ) {
      continue;
    }
    targets.push({
      kind: "requirement-command",
      command: target.verifier.command,
      timeoutSeconds: target.verifier.timeoutSeconds,
      requirementId: target.requirementId,
      verifierIndex: target.verifierIndex,
    });
  }

  return targets;
}

export function forbiddenClaimCommand(claim: string): string {
  return forbiddenClaimsCommand([claim]);
}

export function forbiddenClaimsCommand(claims: readonly string[]): string {
  const encodedClaims = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  return [
    "node --input-type=commonjs -e",
    shellQuote(FORBIDDEN_CLAIM_SCANNER_SOURCE),
    "--",
    shellQuote(encodedClaims),
  ].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Build run aborted");
  }
}
