export type DiffSegment = { text: string; changed: boolean };
export type TextDiff = { original: DiffSegment[]; proposed: DiffSegment[] };

const MAX_LCS_CELLS = 250_000;

function tokenize(value: string) {
  return value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function append(segments: DiffSegment[], text: string, changed: boolean) {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.changed === changed) previous.text += text;
  else segments.push({ text, changed });
}

function prefixSuffixDiff(original: string[], proposed: string[]): TextDiff {
  let prefix = 0;
  while (prefix < original.length && prefix < proposed.length && original[prefix] === proposed[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < proposed.length - prefix &&
    original[original.length - 1 - suffix] === proposed[proposed.length - 1 - suffix]
  ) suffix += 1;

  const sharedPrefix = original.slice(0, prefix).join("");
  const sharedSuffix = suffix ? original.slice(original.length - suffix).join("") : "";
  const oldMiddle = original.slice(prefix, suffix ? original.length - suffix : original.length).join("");
  const newMiddle = proposed.slice(prefix, suffix ? proposed.length - suffix : proposed.length).join("");
  return {
    original: [
      ...(sharedPrefix ? [{ text: sharedPrefix, changed: false }] : []),
      ...(oldMiddle ? [{ text: oldMiddle, changed: true }] : []),
      ...(sharedSuffix ? [{ text: sharedSuffix, changed: false }] : []),
    ],
    proposed: [
      ...(sharedPrefix ? [{ text: sharedPrefix, changed: false }] : []),
      ...(newMiddle ? [{ text: newMiddle, changed: true }] : []),
      ...(sharedSuffix ? [{ text: sharedSuffix, changed: false }] : []),
    ],
  };
}

/** Produces word-and-punctuation level highlights while preserving exact text. */
export function diffText(originalText: string, proposedText: string): TextDiff {
  const original = tokenize(originalText);
  const proposed = tokenize(proposedText);
  if (original.length * proposed.length > MAX_LCS_CELLS || original.length > 65_000 || proposed.length > 65_000) {
    return prefixSuffixDiff(original, proposed);
  }

  const rows = Array.from({ length: original.length + 1 }, () => new Uint16Array(proposed.length + 1));
  for (let oldIndex = original.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = proposed.length - 1; newIndex >= 0; newIndex -= 1) {
      rows[oldIndex][newIndex] = original[oldIndex] === proposed[newIndex]
        ? rows[oldIndex + 1][newIndex + 1] + 1
        : Math.max(rows[oldIndex + 1][newIndex], rows[oldIndex][newIndex + 1]);
    }
  }

  const result: TextDiff = { original: [], proposed: [] };
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < original.length || newIndex < proposed.length) {
    if (oldIndex < original.length && newIndex < proposed.length && original[oldIndex] === proposed[newIndex]) {
      append(result.original, original[oldIndex], false);
      append(result.proposed, proposed[newIndex], false);
      oldIndex += 1;
      newIndex += 1;
    } else if (oldIndex < original.length && (newIndex >= proposed.length || rows[oldIndex + 1][newIndex] >= rows[oldIndex][newIndex + 1])) {
      append(result.original, original[oldIndex], true);
      oldIndex += 1;
    } else {
      append(result.proposed, proposed[newIndex], true);
      newIndex += 1;
    }
  }
  return result;
}
