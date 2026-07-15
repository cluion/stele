/**
 * Obsidian 式 wikilink 目標解析
 * 規則:剝除 #錨點 → 完整相對路徑精確符合 → basename 不分大小寫符合取路徑最短者
 */
export function resolveWikilink(files: readonly string[], rawTarget: string): string | undefined {
  const target = rawTarget.split("#")[0]!.trim();
  if (target.length === 0) return undefined;

  const withExt = target.endsWith(".md") ? target : `${target}.md`;
  const exact = files.find((f) => f === withExt);
  if (exact) return exact;

  const base = withExt.slice(withExt.lastIndexOf("/") + 1).toLowerCase();
  return files
    .filter((f) => f.slice(f.lastIndexOf("/") + 1).toLowerCase() === base)
    .sort((a, b) => a.length - b.length)[0];
}
