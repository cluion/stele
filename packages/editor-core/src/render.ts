import { DOMSerializer } from "prosemirror-model";
import { parseDoc } from "./convert.ts";
import { steleSchema } from "./schema.ts";

/**
 * 唯讀渲染 Markdown 到一個 DOM 容器。
 *
 * 走與編輯器**同一套 schema**:連結、表格、callout 的呈現因此與桌面逐一致,
 * 而不是每個端各自刻一份「大致像 Markdown」的渲染器,然後在細節上慢慢分岔。
 * 分享檢視器與行動端共用這一份。
 */
export function renderMarkdownTo(container: HTMLElement, markdown: string): void {
  const { doc } = parseDoc(markdown);
  container.replaceChildren(DOMSerializer.fromSchema(steleSchema).serializeFragment(doc.content));
}
