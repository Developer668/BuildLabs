const SECRET_KEY_NAMES =
  /^(api[_-]?key|authorization|credential|password|private[_-]?key|secret|token)$/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE =
  /(?<![A-Za-z0-9])(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?![A-Za-z0-9])/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const KNOWN_TOKENS =
  /\b(?:bt_|ck_|cpk-|cr[-_]|dtn_|fw_|re_|rk_(?:live|test)_|pk_(?:live|test)_|sk[-_]|xi[-_])[A-Za-z0-9._-]{12,}\b/g;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const FLY_ACCESS_TOKEN = /\bFlyV1\s+[A-Za-z0-9._-]{12,}\b/g;
const URL_SECRET = /([?&](?:api[_-]?key|key|signature|token)=)[^&#\s]+/gi;

export function redactText(input: string): string {
  return input
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(KNOWN_TOKENS, "[REDACTED_TOKEN]")
    .replace(AWS_ACCESS_KEY, "[REDACTED_TOKEN]")
    .replace(FLY_ACCESS_TOKEN, "[REDACTED_TOKEN]")
    .replace(URL_SECRET, "$1[REDACTED]")
    .replace(EMAIL, "[EMAIL]")
    .replace(PHONE, "[PHONE]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value instanceof Error) {
    return {
      name: boundText(value.name || "Error", 256),
      message: boundText(value.message || "Unknown error", 4_096),
      ...(value.stack ? { stack: boundText(value.stack, 8_192) } : {}),
    };
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY_NAMES.test(key) ? "[REDACTED]" : redactValue(item),
      ]),
    );
  }

  return value;
}

export function boundText(input: string, maxBytes: number): string {
  const redacted = redactText(input);
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.length <= maxBytes) {
    return redacted;
  }

  const suffix = `\n[TRUNCATED ${bytes.length - maxBytes} BYTES]`;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}${suffix}`;
}
