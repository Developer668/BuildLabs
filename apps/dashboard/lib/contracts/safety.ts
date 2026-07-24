import { z } from "zod";

const MARKUP = /[<>]/;
const EMBEDDED_SCHEME =
  /\b(?:javascript|data|vbscript|file|blob):|https?:\/\/\S+/i;
const SECRET_SHAPE =
  /\b(?:bearer\s+[a-z0-9._~+/=-]+|sk[-_][a-z0-9_-]{8,}|api[-_ ]?key\s*[:=]|access[-_ ]?token\s*[:=]|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/i;
const INTERNAL_REFERENCE =
  /\b(?:sandbox[-_ ]?id|workspace[-_ ]?id|trace[-_ ]?id|payment[-_ ]?intent|checkout[-_ ]?session|daytona[-_ ]?(?:sandbox|workspace)|raw[-_ ]?(?:log|output))\b/i;

const FORBIDDEN_CUSTOMER_KEYS = new Set([
  "artifacturl",
  "bearer",
  "checkoutsessionid",
  "credential",
  "credentials",
  "daytonaurl",
  "environment",
  "html",
  "internalid",
  "mcpapp",
  "modeloutput",
  "paymentintentid",
  "providereventid",
  "providerid",
  "rawhtml",
  "rawlog",
  "rawlogs",
  "rawoutput",
  "reasoning",
  "sandboxid",
  "sandboxurl",
  "secret",
  "stderr",
  "stdout",
  "token",
  "traceid",
  "workspaceid",
  "workspaceurl",
]);

export class UnsafeProjectionError extends Error {
  constructor(message = "The projection contains unsafe or unsupported data") {
    super(message);
    this.name = "UnsafeProjectionError";
  }
}

export function safeTextSchema(maximumLength: number) {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .refine((value) => !containsUnsafeTextControls(value), {
      message: "Text contains control or direction-override characters",
    })
    .refine((value) => !MARKUP.test(value), {
      message: "Text markup is not accepted",
    })
    .refine((value) => !EMBEDDED_SCHEME.test(value), {
      message: "Embedded URLs are not accepted in display text",
    })
    .refine((value) => !SECRET_SHAPE.test(value), {
      message: "Text resembles credential material",
    })
    .refine((value) => !INTERNAL_REFERENCE.test(value), {
      message: "Text contains an internal provider reference",
    });
}

export const SafeHttpsUrlSchema = z
  .url()
  .max(2_000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.hash === "" &&
        !containsUnsafeTextControls(value)
      );
    } catch {
      return false;
    }
  }, "Only credential-free HTTPS URLs are accepted");

export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

export const ProjectAliasSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{22}$/);
export const BatchAliasSchema = z.string().regex(/^bat_[A-Za-z0-9_-]{22}$/);
export const BuilderAliasSchema = z.string().regex(/^bld_[A-Za-z0-9_-]{22}$/);
export const EventAliasSchema = z.string().regex(/^evt_[A-Za-z0-9_-]{22}$/);
export const FrameAliasSchema = z.string().regex(/^frm_[A-Za-z0-9_-]{22}$/);

export const SafeRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => {
    if (
      containsUnsafeTextControls(value) ||
      value.startsWith("/") ||
      value.startsWith("\\") ||
      value.includes("\\") ||
      value.includes("\0")
    ) {
      return false;
    }
    const segments = value.split("/");
    return (
      segments.length <= 20 &&
      segments.every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          segment.length <= 80,
      )
    );
  }, "Only bounded workspace-relative paths are accepted");

export function assertNoForbiddenCustomerKeys(value: unknown): void {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > 20_000) {
      throw new UnsafeProjectionError(
        "The projection exceeds its safety limit",
      );
    }
    if (current === null || typeof current !== "object") continue;
    if (visited.has(current)) {
      throw new UnsafeProjectionError("Cyclic projection data is not accepted");
    }
    visited.add(current);
    if (Array.isArray(current)) {
      for (const nested of current as unknown[]) {
        pending.push(nested);
      }
      continue;
    }
    for (const [key, nested] of Object.entries(
      current as Record<string, unknown>,
    )) {
      const normalized = key.replaceAll(/[-_\s]/g, "").toLowerCase();
      if (FORBIDDEN_CUSTOMER_KEYS.has(normalized)) {
        throw new UnsafeProjectionError(
          `The customer projection cannot contain ${key}`,
        );
      }
      pending.push(nested);
    }
  }
}

export function parseCustomerSafe<T>(schema: z.ZodType<T>, value: unknown): T {
  assertNoForbiddenCustomerKeys(value);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UnsafeProjectionError();
  }
  return parsed.data;
}

export function containsUnsafeTextControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}
