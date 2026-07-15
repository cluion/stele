/**
 * 快速切換器的模糊比對:按 code point 逐字比對,CJK 與 emoji 天然可用
 * query 必須是 candidate 的有序子序列才算符合
 */

/** 段界:路徑分隔與常見檔名分隔,其後的字元命中有加分 */
const BOUNDARY = new Set(["/", " ", "-", "_", "."]);

const SCORE_MATCH = 1;
const SCORE_CONSECUTIVE = 2;
const SCORE_BOUNDARY = 3;
const BASENAME_MULTIPLIER = 2;

/** 從 candidate 的 start 位置起貪婪比對整個 query;不成立回傳 null */
function greedyFrom(q: readonly string[], c: readonly string[], start: number, basenameStart: number): number | null {
  let score = 0;
  let prev = -2;
  let ci = start;
  let allInBasename = true;
  for (const ch of q) {
    while (ci < c.length && c[ci] !== ch) ci++;
    if (ci === c.length) return null;
    score += SCORE_MATCH;
    if (ci === prev + 1) score += SCORE_CONSECUTIVE;
    if (ci === 0 || BOUNDARY.has(c[ci - 1]!)) score += SCORE_BOUNDARY;
    if (ci < basenameStart) allInBasename = false;
    prev = ci;
    ci++;
  }
  return allInBasename ? score * BASENAME_MULTIPLIER : score;
}

/**
 * query 對 candidate 的符合分數;不符合回傳 null,空 query 回傳 0
 * 對 query 首字的每個出現位置各試一次貪婪比對,取最高分
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = [...query.toLowerCase()];
  if (q.length === 0) return 0;
  const c = [...candidate.toLowerCase()];
  if (q.length > c.length) return null;

  const basenameStart = c.lastIndexOf("/") + 1;
  let best: number | null = null;
  for (let start = 0; start <= c.length - q.length; start++) {
    if (c[start] !== q[0]) continue;
    const score = greedyFrom(q, c, start, basenameStart);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

/**
 * 對 vault 檔案清單做模糊搜尋,依分數排序取前 limit 個;同分短路徑優先
 * 比對時忽略 .md 副檔名,回傳原始路徑;空查詢回傳原序前 limit 個
 */
export function rankFiles(files: readonly string[], query: string, limit = 50): string[] {
  if (query.trim().length === 0) return files.slice(0, limit);

  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const score = fuzzyScore(query, file.replace(/\.md$/, ""));
    if (score !== null) scored.push({ file, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.file.length - b.file.length)
    .slice(0, limit)
    .map((s) => s.file);
}
