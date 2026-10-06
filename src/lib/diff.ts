export type DiffType = "same" | "add" | "del";

export interface DiffLine {
  type: DiffType;
  text: string;
  oldNum?: number;
  newNum?: number;
}

/**
 * Upper bound on the LCS table size (cells). Beyond this a pathological edit
 * region degrades to a del-all/add-all summary rather than allocating a huge
 * table. Kept to bound both memory and time.
 */
export const MAX_DP_CELLS = 250_000;

/**
 * Computes a line-by-line diff between two text documents.
 * Optimised with common prefix/suffix trimming for sub-millisecond execution.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  if (oldText === newText) {
    return oldText.split(/\r?\n/).map((line, idx) => ({
      type: "same",
      text: line,
      oldNum: idx + 1,
      newNum: idx + 1,
    }));
  }

  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);

  let prefixCount = 0;
  const minLen = Math.min(oldLines.length, newLines.length);

  while (
    prefixCount < minLen &&
    oldLines[prefixCount] === newLines[prefixCount]
  ) {
    prefixCount++;
  }

  let suffixCount = 0;
  while (
    suffixCount < minLen - prefixCount &&
    oldLines[oldLines.length - 1 - suffixCount] ===
      newLines[newLines.length - 1 - suffixCount]
  ) {
    suffixCount++;
  }

  const result: DiffLine[] = [];

  // 1. Common prefix
  for (let i = 0; i < prefixCount; i++) {
    result.push({
      type: "same",
      text: oldLines[i]!,
      oldNum: i + 1,
      newNum: i + 1,
    });
  }

  // 2. Middle changed region
  const middleOld = oldLines.slice(prefixCount, oldLines.length - suffixCount);
  const middleNew = newLines.slice(prefixCount, newLines.length - suffixCount);

  const m = middleOld.length;
  const n = middleNew.length;

  if (m * n <= MAX_DP_CELLS) {
    // DP LCS, stored in one flat Uint32Array: O(m*n) 32-bit ints (~1 MB at the
    // cap) instead of m+1 boxed rows, so memory stays flat and predictable.
    const stride = n + 1;
    const dp = new Uint32Array((m + 1) * stride);

    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        if (middleOld[i] === middleNew[j]) {
          dp[(i + 1) * stride + (j + 1)] = dp[i * stride + j] + 1;
        } else {
          const up = dp[i * stride + (j + 1)];
          const left = dp[(i + 1) * stride + j];
          dp[(i + 1) * stride + (j + 1)] = up > left ? up : left;
        }
      }
    }

    // Backtrack LCS
    let i = m;
    let j = n;
    const middleDiff: DiffLine[] = [];

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && middleOld[i - 1] === middleNew[j - 1]) {
        middleDiff.push({
          type: "same",
          text: middleOld[i - 1]!,
          oldNum: prefixCount + i,
          newNum: prefixCount + j,
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i * stride + (j - 1)] >= dp[(i - 1) * stride + j])) {
        middleDiff.push({
          type: "add",
          text: middleNew[j - 1]!,
          newNum: prefixCount + j,
        });
        j--;
      } else if (i > 0 && (j === 0 || dp[i * stride + (j - 1)] < dp[(i - 1) * stride + j])) {
        middleDiff.push({
          type: "del",
          text: middleOld[i - 1]!,
          oldNum: prefixCount + i,
        });
        i--;
      }
    }

    middleDiff.reverse();
    result.push(...middleDiff);
  } else {
    // Large change fallback: mark all removed then all added
    for (let i = 0; i < m; i++) {
      result.push({
        type: "del",
        text: middleOld[i]!,
        oldNum: prefixCount + i + 1,
      });
    }
    for (let j = 0; j < n; j++) {
      result.push({
        type: "add",
        text: middleNew[j]!,
        newNum: prefixCount + j + 1,
      });
    }
  }

  // 3. Common suffix
  for (let s = suffixCount; s > 0; s--) {
    const oldIdx = oldLines.length - s;
    const newIdx = newLines.length - s;
    result.push({
      type: "same",
      text: oldLines[oldIdx]!,
      oldNum: oldIdx + 1,
      newNum: newIdx + 1,
    });
  }

  return result;
}
