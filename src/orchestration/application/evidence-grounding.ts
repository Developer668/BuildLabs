export function normalizeExtractiveEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .trim();
}

export function isSameExtractiveEvidence(
  statement: string,
  excerpt: string,
): boolean {
  const normalizedStatement = normalizeExtractiveEvidence(statement);
  return (
    normalizedStatement.length > 0 &&
    normalizedStatement === normalizeExtractiveEvidence(excerpt)
  );
}

export function findStandaloneEvidenceOffset(
  content: string,
  excerpt: string,
): number {
  let offset = content.indexOf(excerpt);
  while (offset >= 0) {
    if (isStandaloneEvidenceAt(content, excerpt, offset)) {
      return offset;
    }
    offset = content.indexOf(excerpt, offset + 1);
  }
  return -1;
}

export function isStandaloneEvidenceAt(
  content: string,
  excerpt: string,
  offset: number,
): boolean {
  if (
    offset < 0 ||
    content.slice(offset, offset + excerpt.length) !== excerpt
  ) {
    return false;
  }
  let unitStart = offset;
  while (unitStart > 0 && !/[.!?\n]/.test(content[unitStart - 1] ?? "")) {
    unitStart -= 1;
  }
  let unitEnd = offset;
  while (unitEnd < content.length && !/[.!?\n]/.test(content[unitEnd] ?? "")) {
    unitEnd += 1;
  }
  if (unitEnd < content.length) {
    unitEnd += 1;
  }
  return isSameExtractiveEvidence(content.slice(unitStart, unitEnd), excerpt);
}
