import type { ReactNode } from "react";

/**
 * 白板節點的輕量 Markdown 呈現。
 *
 * 刻意**不**走編輯器那條完整的 ProseMirror/markdown-it 管線:白板節點是一句話到一小段的量體,
 * 為了它在每張卡片上掛一個編輯器,滾動、選取、游標全都要重來一次。這裡只認白板上實際會用到的
 * 那幾種標記,其餘原樣顯示。
 *
 * 產出的是 React 元素而非 HTML 字串——節點內容來自協作者,`dangerouslySetInnerHTML` 等於把
 * 注入面開給同步管線上的每一個人。
 */

const INLINE = /(\[\[[^[\]\n]+\]\])|(!?\[[^\]\n]*\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(`[^`\n]+`)|(~~[^~\n]+~~)/;

export interface MarkdownHandlers {
  /** 點 [[wikilink]];target 已剝除別名 */
  onWikilink: (target: string) => void;
  /** 點外部連結 */
  onLink: (url: string) => void;
}

function inlineNodes(text: string, handlers: MarkdownHandlers, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) break;
    if (match.index > 0) out.push(rest.slice(0, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("[[")) {
      const inner = token.slice(2, -2);
      const [target, alias] = inner.split("|");
      out.push(
        <button key={key} className="canvas-md-link" onClick={() => handlers.onWikilink(target!.trim())}>
          {(alias ?? target)!.trim()}
        </button>,
      );
    } else if (token.startsWith("[") || token.startsWith("![")) {
      const label = /\[([^\]]*)\]/.exec(token)![1]!;
      const url = /\(([^)\s]+)\)/.exec(token)![1]!;
      out.push(
        <button key={key} className="canvas-md-link" onClick={() => handlers.onLink(url)}>
          {label || url}
        </button>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~")) {
      out.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("`")) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    rest = rest.slice(match.index + token.length);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** 一段內文;段落層級只認標題與清單,其餘當作純文字段落 */
export function CanvasMarkdown({ source, handlers }: { source: string; handlers: MarkdownHandlers }) {
  const blocks: ReactNode[] = [];
  const lines = source.split("\n");
  let list: ReactNode[] = [];
  let ordered = false;

  const flushList = (key: string): void => {
    if (list.length === 0) return;
    const items = list;
    list = [];
    blocks.push(
      ordered ? (
        <ol key={key} className="canvas-md-list">
          {items}
        </ol>
      ) : (
        <ul key={key} className="canvas-md-list">
          {items}
        </ul>
      ),
    );
  };

  lines.forEach((line, i) => {
    const key = `l${i}`;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushList(`${key}-list`);
      blocks.push(
        <p key={key} className={`canvas-md-h canvas-md-h${heading[1]!.length}`}>
          {inlineNodes(heading[2]!, handlers, key)}
        </p>,
      );
    } else if (bullet || numbered) {
      const wasOrdered = ordered;
      ordered = numbered !== null;
      if (list.length > 0 && wasOrdered !== ordered) flushList(`${key}-list`);
      list.push(<li key={key}>{inlineNodes((bullet ?? numbered)![1]!, handlers, key)}</li>);
    } else if (line.trim().length === 0) {
      flushList(`${key}-list`);
    } else {
      flushList(`${key}-list`);
      blocks.push(
        <p key={key} className="canvas-md-p">
          {inlineNodes(line, handlers, key)}
        </p>,
      );
    }
  });
  flushList("tail-list");

  return <>{blocks}</>;
}
