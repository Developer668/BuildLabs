import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  DASHBOARD_ALIAS_COOKIE,
  aliasCookieValue,
  customerSessionToken,
} from "./cookies";
import { DashboardBffError, asRecord, safeInteger, safeString } from "./http";

const ALIAS_AAD = Buffer.from("buildlabs.dashboard.alias-map.v1", "utf8");
const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ALIAS_PATTERN = /^prj_[A-Za-z0-9_-]{22}$/;

export interface CustomerAliasContext {
  projectAlias: string;
  internalProjectId: string;
  sessionBinding: string;
  expiresAt: number;
}

interface SealedAliasMap {
  v: 1;
  exp: number;
  session: string;
  projects: Array<{ alias: string; internalId: string }>;
}

export function dashboardAliasSecret(): string {
  const value = process.env.BUILDLABS_DASHBOARD_ALIAS_SECRET?.trim();
  if (value === undefined || Buffer.byteLength(value, "utf8") < 32) {
    throw new DashboardBffError(
      503,
      "dashboard_aliases_unconfigured",
      "The customer dashboard alias boundary is unavailable",
    );
  }
  return value;
}

export function createCustomerAliasContext(input: {
  internalProjectId: string;
  sessionToken: string;
  expiresAt: number;
  secret: string;
}): CustomerAliasContext {
  validateInternalProjectId(input.internalProjectId);
  validateExpiry(input.expiresAt);
  return {
    internalProjectId: input.internalProjectId,
    projectAlias: opaqueAlias("prj", input.internalProjectId, input.secret),
    sessionBinding: sessionBinding(input.sessionToken, input.secret),
    expiresAt: input.expiresAt,
  };
}

export function sealCustomerAliasContext(
  context: CustomerAliasContext,
  secret: string,
): string {
  const payload: SealedAliasMap = {
    v: 1,
    exp: context.expiresAt,
    session: context.sessionBinding,
    projects: [
      {
        alias: context.projectAlias,
        internalId: context.internalProjectId,
      },
    ],
  };
  const key = encryptionKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(ALIAS_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "alias",
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function openCustomerAliasContext(input: {
  sealed: string;
  projectAlias: string;
  sessionToken: string;
  secret: string;
  nowEpochSeconds?: number;
}): CustomerAliasContext {
  const parts = input.sealed.split(".");
  if (
    parts.length !== 5 ||
    parts[0] !== "alias" ||
    parts[1] !== "v1" ||
    !PROJECT_ALIAS_PATTERN.test(input.projectAlias)
  ) {
    throw unauthorized();
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(input.secret),
      Buffer.from(parts[2]!, "base64url"),
    );
    decipher.setAAD(ALIAS_AAD);
    decipher.setAuthTag(Buffer.from(parts[4]!, "base64url"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, "base64url")),
      decipher.final(),
    ]);
  } catch {
    throw unauthorized();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    throw unauthorized();
  }
  const map = parseAliasMap(parsed);
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000);
  const expectedSession = sessionBinding(input.sessionToken, input.secret);
  if (map.exp <= now || !constantTimeTextEqual(map.session, expectedSession)) {
    throw unauthorized();
  }
  const project = map.projects.find(
    (candidate) => candidate.alias === input.projectAlias,
  );
  if (project === undefined) {
    throw unauthorized();
  }
  return {
    projectAlias: project.alias,
    internalProjectId: project.internalId,
    sessionBinding: map.session,
    expiresAt: map.exp,
  };
}

export function resolveCustomerAliasContext(
  request: Request,
  projectAlias: string,
  secret = dashboardAliasSecret(),
): CustomerAliasContext {
  return openCustomerAliasContext({
    sealed: aliasCookieValue(request),
    projectAlias,
    sessionToken: customerSessionToken(request),
    secret,
  });
}

export function opaqueAlias(
  kind: "prj" | "bat" | "bld" | "evt" | "frm" | "str",
  internalValue: string,
  secret: string,
): string {
  if (
    internalValue.length === 0 ||
    internalValue.length > 512 ||
    Buffer.byteLength(secret, "utf8") < 32
  ) {
    throw new DashboardBffError(
      500,
      "alias_generation_failed",
      "A customer-safe identifier could not be generated",
    );
  }
  const digest = createHmac("sha256", secret)
    .update(`buildlabs.dashboard.${kind}.v1\0${internalValue}`, "utf8")
    .digest("base64url")
    .slice(0, 22);
  return `${kind}_${digest}`;
}

export function sessionBinding(sessionToken: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("buildlabs.dashboard.session.v1\0", "utf8")
    .update(sessionToken, "utf8")
    .digest("base64url");
}

export { DASHBOARD_ALIAS_COOKIE };

function encryptionKey(secret: string): Buffer {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new DashboardBffError(
      503,
      "dashboard_aliases_unconfigured",
      "The customer dashboard alias boundary is unavailable",
    );
  }
  return createHash("sha256")
    .update("buildlabs.dashboard.alias-key.v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

function parseAliasMap(value: unknown): SealedAliasMap {
  const record = asRecord(value);
  const exp = safeInteger(record?.exp, 1);
  const session = safeString(record?.session, 128);
  const projects = Array.isArray(record?.projects) ? record.projects : [];
  if (
    record?.v !== 1 ||
    exp === undefined ||
    session === undefined ||
    projects.length < 1 ||
    projects.length > 8
  ) {
    throw unauthorized();
  }
  const parsedProjects = projects.map((item) => {
    const project = asRecord(item);
    const alias = safeString(project?.alias, 64);
    const internalId = safeString(project?.internalId, 64);
    if (
      alias === undefined ||
      internalId === undefined ||
      !PROJECT_ALIAS_PATTERN.test(alias) ||
      !PROJECT_ID_PATTERN.test(internalId)
    ) {
      throw unauthorized();
    }
    return { alias, internalId };
  });
  if (
    new Set(parsedProjects.map((project) => project.alias)).size !==
    parsedProjects.length
  ) {
    throw unauthorized();
  }
  return { v: 1, exp, session, projects: parsedProjects };
}

function validateInternalProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new DashboardBffError(
      502,
      "invalid_upstream_project",
      "The authentication service returned an invalid project",
    );
  }
}

function validateExpiry(expiresAt: number): void {
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(Date.now() / 1_000) ||
    expiresAt > Math.floor(Date.now() / 1_000) + 30 * 24 * 60 * 60
  ) {
    throw new DashboardBffError(
      502,
      "invalid_upstream_session",
      "The authentication service returned an invalid session lifetime",
    );
  }
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function unauthorized(): DashboardBffError {
  return new DashboardBffError(
    401,
    "customer_session_invalid",
    "A valid customer session is required",
  );
}
