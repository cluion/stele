import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { CanvasNode, CanvasSide } from "@stele/editor-core";
import { CanvasMarkdown, type MarkdownHandlers } from "./canvas-markdown.tsx";
import type { ResizeHandle } from "./canvas-geometry.ts";

/**
 * 白板上的一個節點。四種型別各有各的呈現,共用同一套外框、選取態與把手。
 *
 * 節點是 DOM 而非畫布繪製:文字要能選取、能編輯、能無障礙讀取,
 * 這些在 2D canvas 上全部得自己重寫一遍。
 */

/** JSON Canvas 的預設色號(1–6);其餘視為 CSS 色值原樣使用 */
const PRESET_COLORS: Record<string, string> = {
  "1": "#e93147",
  "2": "#ec7500",
  "3": "#e0ac00",
  "4": "#08b94e",
  "5": "#00bfbc",
  "6": "#7852ee",
};

export const PRESET_COLOR_KEYS = ["1", "2", "3", "4", "5", "6"] as const;

export function colorValue(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  return PRESET_COLORS[color] ?? color;
}

const SIDES: readonly CanvasSide[] = ["top", "right", "bottom", "left"];
const HANDLES: readonly ResizeHandle[] = ["nw", "ne", "sw", "se"];

export interface NodeViewProps {
  node: CanvasNode;
  selected: boolean;
  editing: boolean;
  readOnly: boolean;
  /** file 節點的筆記內容;undefined = 還沒讀到,null = 檔案不在 */
  preview: string | null | undefined;
  markdown: MarkdownHandlers;
  onPointerDownNode: (e: ReactPointerEvent, node: CanvasNode) => void;
  onPointerDownResize: (e: ReactPointerEvent, node: CanvasNode, handle: ResizeHandle) => void;
  onPointerDownConnect: (e: ReactPointerEvent, node: CanvasNode, side: CanvasSide) => void;
  onStartEdit: (node: CanvasNode) => void;
  onCommitEdit: (node: CanvasNode, value: string) => void;
  onOpenFile: (file: string) => void;
}

export function CanvasNodeView(props: NodeViewProps) {
  const { node, selected, editing, readOnly } = props;
  const { t } = useTranslation();
  const color = colorValue(node.color);
  const className = [
    "canvas-node",
    `canvas-node-${node.type}`,
    selected ? "selected" : "",
    editing ? "editing" : "",
    color ? "colored" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      data-node-id={node.id}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        ...(color ? ({ "--canvas-node-color": color } as Record<string, string>) : {}),
      }}
      onPointerDown={(e) => props.onPointerDownNode(e, node)}
      onDoubleClick={() => {
        if (node.type === "file") props.onOpenFile(node.file);
        else if (!readOnly) props.onStartEdit(node);
      }}
    >
      <NodeBody {...props} />
      {!readOnly && (
        <>
          {SIDES.map((side) => (
            <button
              key={side}
              className={`canvas-port canvas-port-${side}`}
              title={t("canvas.connect")}
              aria-label={t("canvas.connect")}
              onPointerDown={(e) => props.onPointerDownConnect(e, node, side)}
            />
          ))}
          {selected &&
            HANDLES.map((handle) => (
              <span key={handle} className={`canvas-grip canvas-grip-${handle}`} onPointerDown={(e) => props.onPointerDownResize(e, node, handle)} />
            ))}
        </>
      )}
    </div>
  );
}

function NodeBody({ node, editing, preview, markdown, onCommitEdit, onOpenFile }: NodeViewProps) {
  const { t } = useTranslation();
  if (editing) {
    const initial = node.type === "text" ? node.text : node.type === "link" ? node.url : node.type === "group" ? (node.label ?? "") : "";
    return <NodeEditor initial={initial} multiline={node.type === "text"} onCommit={(value) => onCommitEdit(node, value)} />;
  }

  switch (node.type) {
    case "text":
      return (
        <div className="canvas-node-body">
          {node.text.trim().length === 0 ? <p className="canvas-node-empty">{t("canvas.emptyText")}</p> : <CanvasMarkdown source={node.text} handlers={markdown} />}
        </div>
      );
    case "file": {
      const name = node.file.replace(/\.(md|canvas)$/, "").split("/").pop() ?? node.file;
      return (
        <>
          <button className="canvas-node-title" onClick={() => onOpenFile(node.file)} title={node.file}>
            {name}
            {node.subpath ? <span className="canvas-node-subpath">{node.subpath}</span> : null}
          </button>
          <div className="canvas-node-body canvas-node-preview">
            {preview === undefined ? null : preview === null ? (
              <p className="canvas-node-missing">{t("canvas.missingFile", { file: node.file })}</p>
            ) : (
              <CanvasMarkdown source={preview} handlers={markdown} />
            )}
          </div>
        </>
      );
    }
    case "link":
      return (
        <>
          <button className="canvas-node-title" onClick={() => markdown.onLink(node.url)} title={node.url}>
            {hostOf(node.url)}
          </button>
          <div className="canvas-node-body canvas-node-url">{node.url}</div>
        </>
      );
    case "group":
      return <div className="canvas-group-label">{node.label ?? t("canvas.untitledGroup")}</div>;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 就地編輯:失焦即提交(白板上沒有「存檔」按鈕,離開就是完成),Escape 也提交——
 * 使用者按 Escape 通常是想退出編輯,把剛打的字丟掉不是他的本意。
 */
function NodeEditor({ initial, multiline, onCommit }: { initial: string; multiline: boolean; onCommit: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const committed = useRef(false);
  const latest = useRef({ value, onCommit });
  useEffect(() => {
    latest.current = { value, onCommit };
  });
  useEffect(() => {
    ref.current?.focus();
    if (ref.current instanceof HTMLTextAreaElement) ref.current.selectionStart = ref.current.value.length;
    /**
     * 卸載即提交。點畫布空白處會直接把這個編輯框從畫面上拿掉,而 React 卸載元素**不保證**
     * 觸發 blur——只靠 onBlur 的話,「打完字點旁邊」這個最自然的動作會讓內容無聲消失。
     */
    return () => {
      if (committed.current) return;
      committed.current = true;
      latest.current.onCommit(latest.current.value);
    };
  }, []);

  const commit = (): void => {
    if (committed.current) return;
    committed.current = true;
    onCommit(value);
  };
  const onKeyDown = (e: { key: string; nativeEvent: { isComposing: boolean }; preventDefault: () => void }): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape" || (e.key === "Enter" && !multiline)) {
      e.preventDefault();
      commit();
    }
  };

  return multiline ? (
    <textarea
      ref={ref as React.RefObject<HTMLTextAreaElement>}
      className="canvas-node-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    />
  ) : (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      className="canvas-node-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
