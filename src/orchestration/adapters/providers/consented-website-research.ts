import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";

import type {
  CaptureWebsiteRequest,
  WebsiteResearchCapture,
  WebsiteResearchPort,
} from "../../ports/website-research.js";
import { ProviderAdapterError } from "./provider-error.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "text/plain",
]);
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 512 * 1_024;
const DEFAULT_MAX_EXCERPT_CHARACTERS = 4_000;
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAX_TITLE_CHARACTERS = 1_000;
const MAX_PUBLISHER_CHARACTERS = 500;
const MAX_CANONICAL_URL_CHARACTERS = 2_000;

// Keep families in separate lists. Node represents IPv4 entries internally as
// IPv4-mapped IPv6; mixing a `::ffff:0:0/96` rule into the same list would
// therefore classify every IPv4 address as blocked.
const BLOCKED_IPV4_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_IPV4_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

const BLOCKED_IPV6_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  BLOCKED_IPV6_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const GLOBAL_IPV6_ADDRESSES = new BlockList();
GLOBAL_IPV6_ADDRESSES.addSubnet("2000::", 3, "ipv6");

export interface ResearchResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type ResearchDnsResolver = (
  hostname: string,
) => Promise<readonly ResearchResolvedAddress[]>;

export interface PinnedResearchRequest {
  url: URL;
  address: ResearchResolvedAddress;
  maxBodyBytes: number;
  timeoutMilliseconds: number;
  signal: AbortSignal;
}

export interface ResearchHttpResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Uint8Array;
}

export type ResearchHttpsTransport = (
  request: PinnedResearchRequest,
) => Promise<ResearchHttpResponse>;

export interface ConsentedWebsiteResearchOptions {
  resolver?: ResearchDnsResolver;
  transport?: ResearchHttpsTransport;
  now?: () => Date;
  maxRedirects?: number;
  maxBodyBytes?: number;
  maxExcerptCharacters?: number;
  timeoutMilliseconds?: number;
}

export class ConsentedWebsiteResearchAdapter implements WebsiteResearchPort {
  readonly #resolver: ResearchDnsResolver;
  readonly #transport: ResearchHttpsTransport;
  readonly #now: () => Date;
  readonly #maxRedirects: number;
  readonly #maxBodyBytes: number;
  readonly #maxExcerptCharacters: number;
  readonly #timeoutMilliseconds: number;

  constructor(options: ConsentedWebsiteResearchOptions = {}) {
    this.#resolver = options.resolver ?? systemResolver;
    this.#transport = options.transport ?? pinnedHttpsTransport;
    this.#now = options.now ?? (() => new Date());
    this.#maxRedirects = assertBoundedInteger(
      options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      0,
      10,
    );
    this.#maxBodyBytes = assertBoundedInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      1_024,
      5 * 1_024 * 1_024,
    );
    this.#maxExcerptCharacters = assertBoundedInteger(
      options.maxExcerptCharacters ?? DEFAULT_MAX_EXCERPT_CHARACTERS,
      1,
      20_000,
    );
    this.#timeoutMilliseconds = assertBoundedInteger(
      options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
      100,
      60_000,
    );
  }

  async capture(
    request: CaptureWebsiteRequest,
    signal?: AbortSignal,
  ): Promise<WebsiteResearchCapture> {
    try {
      return await this.#capture(request, signal);
    } catch (error) {
      if (error instanceof ProviderAdapterError) {
        throw error;
      }
      throw new ProviderAdapterError(
        "research",
        "capture_website",
        "PROVIDER_FAILURE",
      );
    }
  }

  async #capture(
    request: CaptureWebsiteRequest,
    signal?: AbortSignal,
  ): Promise<WebsiteResearchCapture> {
    assertAuthorization(request);
    const requestedUrl = parseAllowedUrl(request.url);
    let currentUrl = requestedUrl;
    const seenUrls = new Set<string>();
    const redirectChain: string[] = [];
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMilliseconds);
    const operationSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const deadline = Date.now() + this.#timeoutMilliseconds;

    for (let redirectCount = 0; ; redirectCount += 1) {
      throwIfAborted(operationSignal);
      const serializedUrl = currentUrl.toString();
      if (seenUrls.has(serializedUrl)) {
        throw new ProviderAdapterError(
          "research",
          "follow_redirect",
          "POLICY_BLOCKED",
        );
      }
      seenUrls.add(serializedUrl);
      redirectChain.push(serializedUrl);

      const address = await resolveAndRecheck(
        currentUrl,
        this.#resolver,
        operationSignal,
      );
      const remainingMilliseconds = deadline - Date.now();
      if (remainingMilliseconds <= 0) {
        throw new ProviderAdapterError(
          "research",
          "capture_website",
          "PROVIDER_FAILURE",
        );
      }
      const response = await this.#transport({
        url: currentUrl,
        address,
        maxBodyBytes: this.#maxBodyBytes,
        timeoutMilliseconds: remainingMilliseconds,
        signal: operationSignal,
      });
      throwIfAborted(operationSignal);

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        if (redirectCount >= this.#maxRedirects) {
          throw new ProviderAdapterError(
            "research",
            "follow_redirect",
            "POLICY_BLOCKED",
          );
        }
        const location = singleHeader(response.headers, "location");
        if (!location) {
          throw new ProviderAdapterError(
            "research",
            "follow_redirect",
            "INVALID_PROVIDER_RESPONSE",
          );
        }
        let redirectedUrl: URL;
        try {
          redirectedUrl = new URL(location, currentUrl);
        } catch {
          throw new ProviderAdapterError(
            "research",
            "follow_redirect",
            "INVALID_PROVIDER_RESPONSE",
          );
        }
        const nextUrl = parseAllowedUrl(redirectedUrl.toString());
        assertAuthorizedRedirect(requestedUrl, nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new ProviderAdapterError(
          "research",
          "capture_website",
          "INVALID_PROVIDER_RESPONSE",
        );
      }
      if (response.body.byteLength > this.#maxBodyBytes) {
        throw new ProviderAdapterError(
          "research",
          "capture_website",
          "POLICY_BLOCKED",
        );
      }
      const declaredLength = singleHeader(response.headers, "content-length");
      if (declaredLength) {
        const parsedLength = Number(declaredLength);
        if (
          !Number.isSafeInteger(parsedLength) ||
          parsedLength < 0 ||
          parsedLength > this.#maxBodyBytes
        ) {
          throw new ProviderAdapterError(
            "research",
            "capture_website",
            "POLICY_BLOCKED",
          );
        }
      }
      const contentEncoding = singleHeader(
        response.headers,
        "content-encoding",
      );
      if (
        contentEncoding &&
        contentEncoding.trim().toLowerCase() !== "identity"
      ) {
        throw new ProviderAdapterError(
          "research",
          "capture_website",
          "POLICY_BLOCKED",
        );
      }
      const rawContentType = singleHeader(response.headers, "content-type");
      if (!rawContentType) {
        throw new ProviderAdapterError(
          "research",
          "capture_website",
          "POLICY_BLOCKED",
        );
      }
      const { mediaType, charset } = parseContentType(rawContentType);
      if (!ALLOWED_CONTENT_TYPES.has(mediaType)) {
        throw new ProviderAdapterError(
          "research",
          "capture_website",
          "POLICY_BLOCKED",
        );
      }
      const decoded = decodeBody(response.body, charset);
      const metadata =
        mediaType === "text/html" || mediaType === "application/xhtml+xml"
          ? extractHtmlMetadata(decoded, currentUrl, requestedUrl)
          : {};
      const text = extractText(decoded, mediaType);
      const textExcerpt = truncateText(text, this.#maxExcerptCharacters);
      if (textExcerpt.length === 0) {
        throw new ProviderAdapterError(
          "research",
          "capture_website",
          "INVALID_PROVIDER_RESPONSE",
        );
      }
      const retrievedAt = this.#now();
      if (Number.isNaN(retrievedAt.getTime())) {
        throw new ProviderAdapterError(
          "research",
          "capture_website",
          "INVALID_PROVIDER_RESPONSE",
        );
      }
      const normalizedRetrievedAt = retrievedAt.toISOString();
      const finalUrl = currentUrl.toString();
      return {
        url: finalUrl,
        requestedUrl: requestedUrl.toString(),
        finalUrl,
        redirectChain,
        capturedAt: normalizedRetrievedAt,
        retrievedAt: normalizedRetrievedAt,
        ...metadata,
        textExcerpt,
        sha256: createHash("sha256").update(textExcerpt).digest("hex"),
      };
    }
  }
}

/**
 * Keep navigation within the hostname tree the caller authorized. This is
 * deliberately stricter than guessing an eTLD+1 without a maintained public
 * suffix list: apex/subdomain redirects work, while sibling or unrelated
 * public hosts require a separately consented capture.
 */
function assertAuthorizedRedirect(requestedUrl: URL, nextUrl: URL): void {
  const authorizedHostname = normalizedHostname(requestedUrl);
  const nextHostname = normalizedHostname(nextUrl);
  const authorizedIsIp = isIP(authorizedHostname) !== 0;
  const nextIsIp = isIP(nextHostname) !== 0;
  const allowed =
    authorizedHostname === nextHostname ||
    (!authorizedIsIp &&
      !nextIsIp &&
      (nextHostname.endsWith(`.${authorizedHostname}`) ||
        authorizedHostname.endsWith(`.${nextHostname}`)));
  if (!allowed) {
    throw new ProviderAdapterError(
      "research",
      "follow_redirect",
      "POLICY_BLOCKED",
    );
  }
}

async function systemResolver(
  hostname: string,
): Promise<readonly ResearchResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, {
    all: true,
    verbatim: true,
  });
  return addresses.flatMap((result) =>
    result.family === 4 || result.family === 6
      ? [{ address: result.address, family: result.family }]
      : [],
  );
}

async function resolveAndRecheck(
  url: URL,
  resolver: ResearchDnsResolver,
  signal: AbortSignal,
): Promise<ResearchResolvedAddress> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    const address: ResearchResolvedAddress = {
      address: hostname,
      family: literalFamily === 4 ? 4 : 6,
    };
    assertPublicAddress(address);
    return address;
  }

  const firstResolution = await abortable(resolver(hostname), signal);
  validateResolution(firstResolution);
  // Re-resolve immediately before the connection and pin the transport to a
  // vetted address from this second result to close the DNS-rebinding gap.
  const secondResolution = await abortable(resolver(hostname), signal);
  validateResolution(secondResolution);
  return secondResolution[0]!;
}

function validateResolution(
  addresses: readonly ResearchResolvedAddress[],
): void {
  if (addresses.length === 0 || addresses.length > 32) {
    throw new ProviderAdapterError(
      "research",
      "resolve_hostname",
      "POLICY_BLOCKED",
    );
  }
  for (const address of addresses) {
    if (isIP(address.address) !== address.family) {
      throw new ProviderAdapterError(
        "research",
        "resolve_hostname",
        "POLICY_BLOCKED",
      );
    }
    assertPublicAddress(address);
  }
}

function assertPublicAddress(address: ResearchResolvedAddress): void {
  if (address.family === 4) {
    if (BLOCKED_IPV4_ADDRESSES.check(address.address, "ipv4")) {
      throw new ProviderAdapterError(
        "research",
        "resolve_hostname",
        "POLICY_BLOCKED",
      );
    }
    return;
  }
  if (
    BLOCKED_IPV6_ADDRESSES.check(address.address, "ipv6") ||
    !GLOBAL_IPV6_ADDRESSES.check(address.address, "ipv6")
  ) {
    throw new ProviderAdapterError(
      "research",
      "resolve_hostname",
      "POLICY_BLOCKED",
    );
  }
}

function parseAllowedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderAdapterError(
      "research",
      "validate_url",
      "POLICY_BLOCKED",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0
  ) {
    throw new ProviderAdapterError(
      "research",
      "validate_url",
      "POLICY_BLOCKED",
    );
  }
  const hostname = normalizedHostname(url);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "home.arpa" ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".internal")
  ) {
    throw new ProviderAdapterError(
      "research",
      "validate_url",
      "POLICY_BLOCKED",
    );
  }
  url.hash = "";
  return url;
}

function assertAuthorization(request: CaptureWebsiteRequest): void {
  if (
    request.authorization?.callerProvided !== true ||
    request.authorization.researchConsent !== true ||
    typeof request.authorization.evidenceRef !== "string" ||
    request.authorization.evidenceRef.trim().length === 0 ||
    request.authorization.evidenceRef.length > 256 ||
    /[\r\n]/.test(request.authorization.evidenceRef)
  ) {
    throw new ProviderAdapterError(
      "research",
      "authorize_research",
      "POLICY_BLOCKED",
    );
  }
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

async function pinnedHttpsTransport(
  input: PinnedResearchRequest,
): Promise<ResearchHttpResponse> {
  const hostname = normalizedHostname(input.url);
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [input.address]);
      return;
    }
    callback(null, input.address.address, input.address.family);
  };

  return await new Promise<ResearchHttpResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname,
        port: input.url.port || 443,
        method: "GET",
        path: `${input.url.pathname}${input.url.search}`,
        lookup: pinnedLookup,
        headers: {
          accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
          "accept-encoding": "identity",
          connection: "close",
          "user-agent": "BuildlapseResearch/1.0",
        },
        maxHeaderSize: 32 * 1_024,
        agent: false,
        signal: input.signal,
        timeout: input.timeoutMilliseconds,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let rejected = false;
        response.on("data", (chunk: Buffer | string) => {
          if (rejected) {
            return;
          }
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > input.maxBodyBytes) {
            rejected = true;
            response.destroy();
            request.destroy();
            reject(new Error("Research response exceeded its body limit"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          if (rejected) {
            return;
          }
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks, bytes),
          });
        });
        response.once("error", reject);
        response.once("aborted", () => {
          reject(new Error("Research response was interrupted"));
        });
      },
    );
    request.once("timeout", () => {
      request.destroy(new Error("Research request timed out"));
    });
    request.once("error", reject);
    request.end();
  });
}

function singleHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([headerName]) => headerName.toLowerCase() === name,
  );
  if (!entry || entry[1] === undefined) {
    return undefined;
  }
  const value = entry[1];
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new ProviderAdapterError(
        "research",
        "parse_headers",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return value[0];
  }
  return value;
}

function parseContentType(value: string): {
  mediaType: string;
  charset: string;
} {
  const parts = value.split(";");
  const mediaType = parts.shift()?.trim().toLowerCase() ?? "";
  let charset = "utf-8";
  for (const parameter of parts) {
    const [rawName, ...rawValue] = parameter.split("=");
    if (rawName?.trim().toLowerCase() !== "charset") {
      continue;
    }
    charset = rawValue
      .join("=")
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return { mediaType, charset: charset.toLowerCase() };
}

function decodeBody(body: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    throw new ProviderAdapterError("research", "decode_body", "POLICY_BLOCKED");
  }
}

function extractText(value: string, mediaType: string): string {
  const withoutMarkup =
    mediaType === "text/plain"
      ? value
      : value
          .replace(/<!--[\s\S]*?-->/g, " ")
          .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ")
          .replace(
            /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi,
            " ",
          )
          .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(withoutMarkup)
    .split("\u0000")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

interface ExtractedHtmlMetadata {
  title?: string;
  publisher?: string;
  canonicalUrl?: string;
}

function extractHtmlMetadata(
  html: string,
  finalUrl: URL,
  requestedUrl: URL,
): ExtractedHtmlMetadata {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/iu.exec(html)?.[1];
  if (!head) {
    return {};
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(head);
  const title = titleMatch?.[1]
    ? boundedMetadataText(titleMatch[1], MAX_TITLE_CHARACTERS)
    : undefined;

  let publisher: string | undefined;
  for (const rawTag of head.match(/<meta\b[^>]*>/giu) ?? []) {
    const attributes = parseHtmlAttributes(rawTag);
    if (attributes.get("name")?.trim().toLowerCase() !== "publisher") {
      continue;
    }
    publisher = boundedMetadataText(
      attributes.get("content") ?? "",
      MAX_PUBLISHER_CHARACTERS,
    );
    if (publisher) {
      break;
    }
  }

  let canonicalUrl: string | undefined;
  for (const rawTag of head.match(/<link\b[^>]*>/giu) ?? []) {
    const attributes = parseHtmlAttributes(rawTag);
    const relations = (attributes.get("rel") ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    if (!relations.includes("canonical")) {
      continue;
    }
    canonicalUrl = allowedCanonicalUrl(
      attributes.get("href") ?? "",
      finalUrl,
      requestedUrl,
    );
    if (canonicalUrl) {
      break;
    }
  }

  return {
    ...(title ? { title } : {}),
    ...(publisher ? { publisher } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
  };
}

function parseHtmlAttributes(rawTag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const tagName = /^<\s*[a-z][a-z0-9:-]*/iu.exec(rawTag)?.[0].length ?? 0;
  const source = rawTag.slice(tagName, rawTag.endsWith(">") ? -1 : undefined);
  const pattern =
    /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || attributes.has(name)) {
      continue;
    }
    attributes.set(
      name,
      decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ""),
    );
  }
  return attributes;
}

function boundedMetadataText(
  rawValue: string,
  maximumCharacters: number,
): string | undefined {
  if (
    /<(?:script|style|noscript|template)\b/iu.test(rawValue) ||
    hasUnsafeMetadataControlCharacter(rawValue)
  ) {
    return undefined;
  }
  const value = decodeHtmlEntities(rawValue)
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    value.length === 0 ||
    value.length > maximumCharacters ||
    value.includes("\uFFFD")
  ) {
    return undefined;
  }
  return value;
}

function hasUnsafeMetadataControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowedWhitespace = code === 9 || code === 10 || code === 13;
    if ((code < 32 && !allowedWhitespace) || code === 127) {
      return true;
    }
  }
  return false;
}

function allowedCanonicalUrl(
  rawHref: string,
  finalUrl: URL,
  requestedUrl: URL,
): string | undefined {
  if (
    rawHref.trim().length === 0 ||
    rawHref.length > MAX_CANONICAL_URL_CHARACTERS
  ) {
    return undefined;
  }
  let canonical: URL;
  try {
    canonical = new URL(rawHref, finalUrl);
  } catch {
    return undefined;
  }
  if (
    canonical.protocol !== "https:" ||
    canonical.username.length > 0 ||
    canonical.password.length > 0 ||
    canonical.hostname.length === 0 ||
    !hostnamesShareAuthorizedTree(requestedUrl, canonical)
  ) {
    return undefined;
  }
  canonical.hash = "";
  const serialized = canonical.toString();
  return serialized.length <= MAX_CANONICAL_URL_CHARACTERS
    ? serialized
    : undefined;
}

function hostnamesShareAuthorizedTree(left: URL, right: URL): boolean {
  const leftHostname = normalizedHostname(left);
  const rightHostname = normalizedHostname(right);
  if (leftHostname === rightHostname) {
    return true;
  }
  if (isIP(leftHostname) !== 0 || isIP(rightHostname) !== 0) {
    return false;
  }
  return (
    rightHostname.endsWith(`.${leftHostname}`) ||
    leftHostname.endsWith(`.${rightHostname}`)
  );
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi,
    (entity, numeric: string | undefined, name: string | undefined) => {
      if (name) {
        return named[name.toLowerCase()] ?? entity;
      }
      if (!numeric) {
        return entity;
      }
      const codePoint = numeric.toLowerCase().startsWith("x")
        ? Number.parseInt(numeric.slice(1), 16)
        : Number.parseInt(numeric, 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return "\uFFFD";
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  const truncated = value.slice(0, maximum);
  return /[\uD800-\uDBFF]$/.test(truncated)
    ? truncated.slice(0, -1)
    : truncated;
}

function assertBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProviderAdapterError(
      "research",
      "configuration",
      "INVALID_INPUT",
    );
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Research operation aborted");
  }
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Research operation aborted"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error("DNS lookup failed"));
      },
    );
  });
}
