const MAX_MODEL_CONTENT_CHARACTERS = 200_000;
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);
const ALWAYS_SUPPRESSED_TAGS = new Set(["head", "script", "style", "template"]);
const QUOTED_CONTAINER_MARKERS = [
  "gmail_quote",
  "gmail_extra",
  "gmail_signature",
  "yahoo_quoted",
  "divrplyfwdmsg",
  "moz-cite-prefix",
  "moz-signature",
];

export class InvalidInboundContentError extends Error {
  constructor() {
    super("Inbound email has no usable customer-authored content");
    this.name = "InvalidInboundContentError";
  }
}

/**
 * Produces bounded customer-authored plain text. HTML structure, active
 * content, quoted prior messages, and common signature blocks are discarded so
 * an earlier proposal cannot silently become fresh customer evidence.
 */
export function normalizeInboundEmailContent(
  text: string | null,
  html: string | null,
): string {
  const candidate = text?.trim().length
    ? normalizePlainText(text)
    : htmlToPlainText(html ?? "");
  const authored = stripQuotedHistoryAndSignature(candidate)
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (authored.length === 0) {
    throw new InvalidInboundContentError();
  }
  if (authored.length > MAX_MODEL_CONTENT_CHARACTERS) {
    throw new InvalidInboundContentError();
  }
  return authored;
}

export function normalizeInboundEmailEvidence(
  subject: string,
  text: string | null,
  html: string | null,
): string {
  const normalizedSubject = normalizePlainText(subject)
    .replace(/\s+/g, " ")
    .trim();
  if (normalizedSubject.length === 0 || normalizedSubject.length > 998) {
    throw new InvalidInboundContentError();
  }
  const content = `Subject: ${normalizedSubject}\n\n${normalizeInboundEmailContent(
    text,
    html,
  )}`;
  if (content.length > MAX_MODEL_CONTENT_CHARACTERS) {
    throw new InvalidInboundContentError();
  }
  return content;
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replaceAll("\u0000", "")
    .replace(/\u00a0/g, " ");
}

function htmlToPlainText(html: string): string {
  const output: string[] = [];
  const suppressedTags: string[] = [];
  let index = 0;
  while (index < html.length) {
    const opening = html.indexOf("<", index);
    if (opening < 0) {
      if (suppressedTags.length === 0) {
        output.push(html.slice(index));
      }
      break;
    }
    if (opening > index && suppressedTags.length === 0) {
      output.push(html.slice(index, opening));
    }
    if (html.startsWith("<!--", opening)) {
      const commentEnd = html.indexOf("-->", opening + 4);
      index = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const closing = findTagEnd(html, opening + 1);
    if (closing < 0) {
      break;
    }
    const rawTag = html.slice(opening + 1, closing);
    const parsed = parseTag(rawTag);
    if (parsed) {
      if (parsed.closing) {
        if (suppressedTags.length > 0) {
          const matching = suppressedTags.lastIndexOf(parsed.name);
          if (matching >= 0) {
            suppressedTags.splice(matching);
          }
        } else if (BLOCK_TAGS.has(parsed.name)) {
          output.push("\n");
        }
      } else {
        const suppress =
          ALWAYS_SUPPRESSED_TAGS.has(parsed.name) ||
          parsed.name === "blockquote" ||
          QUOTED_CONTAINER_MARKERS.some((marker) =>
            rawTag.toLowerCase().includes(marker),
          );
        if (suppressedTags.length > 0 || suppress) {
          if (!parsed.selfClosing) {
            suppressedTags.push(parsed.name);
          }
        } else if (BLOCK_TAGS.has(parsed.name)) {
          output.push("\n");
        }
      }
    }
    index = closing + 1;
  }
  return normalizePlainText(decodeHtmlEntities(output.join("")));
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseTag(
  rawTag: string,
): { name: string; closing: boolean; selfClosing: boolean } | undefined {
  const normalized = rawTag.trim();
  const match = /^\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(normalized);
  if (!match?.[1]) {
    return undefined;
  }
  return {
    name: match[1].toLowerCase(),
    closing: normalized.startsWith("/"),
    selfClosing: /\/\s*$/.test(normalized),
  };
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d{1,7})|#x([a-f0-9]{1,6})|([a-z]{2,10}));/gi,
    (
      entity,
      decimal: string | undefined,
      hexadecimal: string | undefined,
      named: string | undefined,
    ) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(
          decimal ?? hexadecimal!,
          decimal ? 10 : 16,
        );
        if (
          Number.isSafeInteger(codePoint) &&
          codePoint > 0 &&
          codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return String.fromCodePoint(codePoint);
        }
        return "";
      }
      const replacements: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: '"',
      };
      return replacements[named?.toLowerCase() ?? ""] ?? entity;
    },
  );
}

function stripQuotedHistoryAndSignature(value: string): string {
  const lines = normalizePlainText(value).split("\n");
  const retained: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (
      /^On .{1,500}wrote:$/i.test(trimmed) ||
      /^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}$/i.test(
        trimmed,
      ) ||
      isHeaderBlockStart(lines, index) ||
      /^--\s*$/.test(line) ||
      /^(?:Sent from my|Get Outlook for)/i.test(trimmed)
    ) {
      break;
    }
    if (/^\s*>/.test(line)) {
      continue;
    }
    retained.push(line);
  }
  return retained.join("\n");
}

function isHeaderBlockStart(lines: readonly string[], index: number): boolean {
  if (!/^\s*From:\s+\S/i.test(lines[index] ?? "")) {
    return false;
  }
  return lines
    .slice(index + 1, index + 6)
    .some((line) => /^\s*(?:Sent|Date|To|Subject):\s+/i.test(line));
}
