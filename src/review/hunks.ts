import { createHash } from "node:crypto";
import { diffLines } from "diff";

export interface RawHunk {
  startLine: number;
  endLine: number;
  oldText: string;
  newText: string;
}

export type ProposalRequest =
  | { kind: "range"; startLine: number; endLine: number; newText: string }
  | { kind: "anchor"; oldText: string; newText: string };

export type ProposalResult = { ok: true; hunks: RawHunk[] } | { ok: false; error: string };

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

export function lineCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const offsets = lineStartOffsets(text);
  return text.endsWith("\n") ? offsets.length - 1 : offsets.length;
}

export function countTextLines(text: string): number {
  return lineCount(text);
}

function offsetOfLine(offsets: number[], text: string, line: number): number {
  return line - 1 < offsets.length ? offsets[line - 1] : text.length;
}

export function oldLineCount(hunk: RawHunk): number {
  return hunk.endLine - hunk.startLine + 1;
}

export function hunkOffsets(text: string, hunk: RawHunk, offsets = lineStartOffsets(text)): { start: number; end: number } {
  const start = offsetOfLine(offsets, text, hunk.startLine);
  const end = offsetOfLine(offsets, text, hunk.startLine + oldLineCount(hunk));
  return { start, end };
}

export function computeHunks(oldText: string, newText: string, lineOffset = 0): RawHunk[] {
  const parts = diffLines(oldText, newText);
  const out: RawHunk[] = [];
  let line = 1;
  let current: { startLine: number; oldCount: number; oldText: string; newText: string } | undefined;
  const flush = () => {
    if (current) {
      out.push({
        startLine: current.startLine + lineOffset,
        endLine: current.startLine + lineOffset + current.oldCount - 1,
        oldText: current.oldText,
        newText: current.newText
      });
      current = undefined;
    }
  };
  for (const part of parts) {
    const n = part.count ?? lineCount(part.value);
    if (!part.added && !part.removed) {
      flush();
      line += n;
      continue;
    }
    if (!current) {
      current = { startLine: line, oldCount: 0, oldText: "", newText: "" };
    }
    if (part.removed) {
      current.oldText += part.value;
      current.oldCount += n;
      line += n;
    } else {
      current.newText += part.value;
    }
  }
  flush();
  return out;
}

export function hunksOverlap(text: string, a: RawHunk, b: RawHunk): boolean {
  const offsets = lineStartOffsets(text);
  const x = hunkOffsets(text, a, offsets);
  const y = hunkOffsets(text, b, offsets);
  if (x.start === y.start) {
    return true;
  }
  return x.start < y.end && y.start < x.end;
}

export function validateHunk(text: string, hunk: RawHunk): boolean {
  const { start, end } = hunkOffsets(text, hunk);
  return text.slice(start, end) === hunk.oldText;
}

export function applyHunks(text: string, hunks: RawHunk[]): string {
  const offsets = lineStartOffsets(text);
  const located = hunks
    .map((h) => ({ h, ...hunkOffsets(text, h, offsets) }))
    .sort((p, q) => q.start - p.start);
  for (let i = 0; i < located.length; i++) {
    const item = located[i];
    if (text.slice(item.start, item.end) !== item.h.oldText) {
      throw new Error(`Hunk at line ${item.h.startLine} does not match the base text`);
    }
    if (i > 0 && item.end > located[i - 1].start) {
      throw new Error(`Hunks at lines ${item.h.startLine} and ${located[i - 1].h.startLine} overlap`);
    }
  }
  let result = text;
  for (const item of located) {
    result = result.slice(0, item.start) + item.h.newText + result.slice(item.end);
  }
  return result;
}

export function mappedStartLine(hunk: RawHunk, earlier: RawHunk[]): number {
  let delta = 0;
  for (const e of earlier) {
    if (e.startLine < hunk.startLine) {
      delta += countTextLines(e.newText) - oldLineCount(e);
    }
  }
  return hunk.startLine + delta;
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeEol(value: string, eol: string): string {
  const unified = value.replace(/\r\n/g, "\n");
  return eol === "\n" ? unified : unified.replace(/\n/g, eol);
}

function allIndexesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle.length === 0) {
    return found;
  }
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    found.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return found;
}

function lineOfOffset(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

export function buildProposal(base: string, request: ProposalRequest, existing: RawHunk[]): ProposalResult {
  const eol = detectEol(base);
  const offsets = lineStartOffsets(base);
  const total = lineCount(base);
  let startLine: number;
  let endLine: number;
  let segmentNew: string;

  if (request.kind === "range") {
    startLine = request.startLine;
    endLine = request.endLine;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine - 1 || endLine > total) {
      return { ok: false, error: `Invalid line range ${startLine}-${endLine}; the file has ${total} lines` };
    }
    const segStart = offsetOfLine(offsets, base, startLine);
    const segEnd = offsetOfLine(offsets, base, endLine + 1);
    const segmentOld = base.slice(segStart, segEnd);
    segmentNew = normalizeEol(request.newText, eol);
    if (segmentOld.endsWith(eol) && segmentNew.length > 0 && !segmentNew.endsWith(eol)) {
      segmentNew += eol;
    }
    const hunks = computeHunks(segmentOld, segmentNew, startLine - 1);
    return finish(base, hunks, existing);
  }

  const anchor = normalizeEol(request.oldText, eol);
  const matches = allIndexesOf(base, anchor);
  if (matches.length === 0) {
    return { ok: false, error: "The oldText anchor was not found in the file. Re-read the range and copy the text exactly." };
  }
  if (matches.length > 1) {
    return { ok: false, error: `The oldText anchor matches ${matches.length} places. Include more surrounding lines so it is unique.` };
  }
  const anchorStart = matches[0];
  const anchorEnd = anchorStart + anchor.length;
  startLine = lineOfOffset(offsets, anchorStart);
  const lastLine = anchorEnd > anchorStart ? lineOfOffset(offsets, anchorEnd - 1) : startLine;
  endLine = lastLine;
  const segStart = offsetOfLine(offsets, base, startLine);
  const segEnd = offsetOfLine(offsets, base, endLine + 1);
  const segmentOld = base.slice(segStart, segEnd);
  segmentNew = base.slice(segStart, anchorStart) + normalizeEol(request.newText, eol) + base.slice(anchorEnd, segEnd);
  const hunks = computeHunks(segmentOld, segmentNew, startLine - 1);
  return finish(base, hunks, existing);
}

function finish(base: string, hunks: RawHunk[], existing: RawHunk[]): ProposalResult {
  if (hunks.length === 0) {
    return { ok: false, error: "The proposed text is identical to the current text; nothing to change." };
  }
  for (const h of hunks) {
    if (!validateHunk(base, h)) {
      return { ok: false, error: `Internal error: hunk at line ${h.startLine} does not match the base` };
    }
    for (const e of existing) {
      if (hunksOverlap(base, h, e)) {
        return { ok: false, error: `This edit overlaps an earlier proposed change at lines ${e.startLine}-${Math.max(e.startLine, e.endLine)}. Propose a separate, non-overlapping edit.` };
      }
    }
  }
  return { ok: true, hunks };
}
