import { DOMSerializer } from "prosemirror-model";
import { parseDoc, steleSchema } from "@stele/editor-core";

/** 唯讀渲染:走與編輯器同一套 schema,連結/表格/callout 的呈現與桌面一致 */
export function renderMarkdown(container: HTMLElement, markdown: string): void {
  const { doc } = parseDoc(markdown);
  const fragment = DOMSerializer.fromSchema(steleSchema).serializeFragment(doc.content);
  container.replaceChildren(fragment);
}
