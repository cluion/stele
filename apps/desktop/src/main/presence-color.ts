/** 從 deviceId 穩定衍生一個好看的色相,同一裝置每次同色;在場指示與留言作者共用,兩處必得一致 */
const PRESENCE_COLORS = ["#0e7b93", "#d99a3d", "#b5485d", "#5b8c5a", "#7d5ba6", "#c56b2d", "#2c7da0"];

export function colorFor(deviceId: string): string {
  let h = 0;
  for (const ch of deviceId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}
