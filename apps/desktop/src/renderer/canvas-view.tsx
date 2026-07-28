import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import diff from "fast-diff";
import { parseCanvas, serializeCanvas, emptyCanvas, rankFiles, type Canvas, type CanvasNode, type CanvasSide } from "@stele/editor-core";
import {
  screenToWorld,
  zoomAt,
  fitView,
  anchorPoint,
  autoSides,
  edgePath,
  edgeMidpoint,
  arrowPoints,
  hitNode,
  rectFromPoints,
  resizedRect,
  IDENTITY_VIEW,
  type Point,
  type Rect,
  type ResizeHandle,
  type ViewTransform,
} from "./canvas-geometry.ts";
import {
  moveNodes,
  resizeNode,
  removeNodes,
  removeEdges,
  addNode,
  nodeAt,
  connect,
  colorize,
  updateNode,
  dragSet,
  bringToFront,
  selectionInRect,
} from "./canvas-ops.ts";
import { CanvasNodeView, colorValue, PRESET_COLOR_KEYS } from "./canvas-node.tsx";

/**
 * 白板(JSON Canvas)的畫布。
 *
 * 真相在 `.canvas` 檔的**文字**上:白板與筆記共用同一條 CRDT 管線(整份 JSON 存在 Y.Text),
 * 同步、時光機、空間、分享因此全部原封沿用,不必為白板再實作一次。代價是併發合併發生在
 * JSON 文字層——兩人同時拖不同節點會正常收斂,但極端情況下有機會讀到語法半成品。
 * 解析失敗時保留上一個可用狀態並停止寫回(`broken`),絕不拿壞資料覆蓋別人的檔案。
 *
 * 寫檔時機只有「手勢結束」與「編輯完成」:滑鼠每動一格就寫回,會讓同步管線與版本歷史
 * 塞滿沒有意義的中間狀態。拖曳過程只在本地投影(`preview`)。
 */

type Gesture =
  | { kind: "pan"; from: Point; view: ViewTransform }
  | { kind: "move"; ids: ReadonlySet<string>; from: Point; dx: number; dy: number }
  | { kind: "resize"; id: string; handle: ResizeHandle; start: Rect; from: Point; rect: Rect }
  | { kind: "select"; from: Point; to: Point; additive: boolean }
  | { kind: "connect"; from: { node: string; side: CanvasSide }; at: Point; target?: CanvasNode };

interface Selection {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

const EMPTY_SELECTION: Selection = { nodes: new Set(), edges: new Set() };
/** 短過這個距離的拖曳當成點擊:手會抖,節點不該因此偏移一格 */
const DRAG_THRESHOLD = 3;

export function CanvasView({
  rel,
  files,
  readOnly,
  onNavigate,
}: {
  rel: string;
  files: string[];
  readOnly: boolean;
  onNavigate: (target: string) => void;
}) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const ytextRef = useRef<Y.Text | undefined>(undefined);
  const undoRef = useRef<Y.UndoManager | undefined>(undefined);
  /** 按住空白鍵 = 平移模式,與繪圖工具的慣例一致 */
  const spaceRef = useRef(false);

  const [canvas, setCanvas] = useState<Canvas>(emptyCanvas());
  const [broken, setBroken] = useState<string | null>(null);
  const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [editing, setEditing] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [previews, setPreviews] = useState<ReadonlyMap<string, string | null>>(new Map());

  // 事件處理掛在 window/一次性 effect 上,靠 ref 取用最新狀態
  const canvasRef = useRef(canvas);
  const viewRef = useRef(view);
  const selectionRef = useRef(selection);
  const commitRef = useRef<(next: Canvas) => void>(() => {});

  // ── 文件生命週期:與筆記走同一條 IPC 管線 ──
  useEffect(() => {
    let ydoc: Y.Doc | undefined;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let fitted = false;

    void window.stele.openDoc(rel).then((snapshot) => {
      if (cancelled) return;
      ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, snapshot, "main");
      const ytext = ydoc.getText("md");
      ytextRef.current = ytext;
      // 只追蹤本地編輯:協作者的改動不該被自己的 Cmd+Z 撤銷掉
      undoRef.current = new Y.UndoManager(ytext, { trackedOrigins: new Set(["local"]) });

      const refresh = (): void => {
        const parsed = parseCanvas(ytext.toString());
        if ("error" in parsed) {
          setBroken(parsed.error);
          return;
        }
        setBroken(null);
        setCanvas(parsed);
        if (!fitted) {
          fitted = true;
          const rect = wrapRef.current?.getBoundingClientRect();
          if (rect) setView(fitView(parsed.nodes, { width: rect.width, height: rect.height }));
        }
      };

      ydoc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== "main") window.stele.pushUpdate(rel, update);
        refresh();
      });
      unsubscribe = window.stele.onDocUpdate((updateRel, update) => {
        if (updateRel === rel && ydoc) Y.applyUpdate(ydoc, update, "main");
      });
      refresh();
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      undoRef.current?.destroy();
      undoRef.current = undefined;
      ytextRef.current = undefined;
      ydoc?.destroy();
      setCanvas(emptyCanvas());
      setSelection(EMPTY_SELECTION);
      setEditing(null);
      setBroken(null);
    };
  }, [rel]);

  /** 寫回:整份重新序列化,但只把**差異**套進 Y.Text——協作者收到的才是小改動而非整檔替換 */
  const commit = (next: Canvas): void => {
    const ytext = ytextRef.current;
    if (!ytext || readOnly || broken) return;
    const target = serializeCanvas(next);
    const current = ytext.toString();
    if (current === target) return;
    ytext.doc?.transact(() => {
      let pos = 0;
      for (const [kind, text] of diff(current, target)) {
        if (kind === diff.EQUAL) pos += text.length;
        else if (kind === diff.DELETE) ytext.delete(pos, text.length);
        else {
          ytext.insert(pos, text);
          pos += text.length;
        }
      }
    }, "local");
  };

  // 事件監聽掛在 window 上,靠 ref 取用最新狀態(effect 內更新,render 期間不碰 ref)
  useEffect(() => {
    canvasRef.current = canvas;
    viewRef.current = view;
    selectionRef.current = selection;
    commitRef.current = commit;
  });

  // file 節點的預覽內容;路徑集合或 vault 索引一變就重讀
  const fileKeys = useMemo(
    () => [...new Set(canvas.nodes.flatMap((n) => (n.type === "file" ? [n.file] : [])))].sort().join("\n"),
    [canvas.nodes],
  );
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      const wanted = fileKeys.length === 0 ? [] : fileKeys.split("\n");
      void Promise.all(wanted.map((file) => window.stele.noteText(file).then((text) => [file, text] as const))).then((pairs) => {
        if (!cancelled) setPreviews(new Map(pairs));
      });
    };
    load();
    const off = window.stele.onIndexUpdated(load);
    return () => {
      cancelled = true;
      off();
    };
  }, [fileKeys]);

  // 穩定的座標換算:事件 effect 會把它們列進依賴,每次 render 換一個新函式會讓監聽白白重掛
  const localPoint = useCallback((e: { clientX: number; clientY: number }): Point => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }, []);
  const worldPoint = useCallback((e: { clientX: number; clientY: number }): Point => screenToWorld(viewRef.current, localPoint(e)), [localPoint]);

  // 滾輪平移、Cmd/Ctrl(觸控板捏合亦然)縮放;必須是非 passive 監聽,否則 preventDefault 無效
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const at = localPoint(e);
      if (e.ctrlKey || e.metaKey) setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.01), at));
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [localPoint]);

  // ── 手勢:進行中時掛 window 監聽,gesture 一變就重掛,閉包永遠是最新的 ──
  useEffect(() => {
    if (!gesture) return;
    const onMove = (e: PointerEvent): void => {
      const world = worldPoint(e);
      switch (gesture.kind) {
        case "pan": {
          const p = localPoint(e);
          setView({ ...gesture.view, x: gesture.view.x + (p.x - gesture.from.x), y: gesture.view.y + (p.y - gesture.from.y) });
          break;
        }
        case "move":
          setGesture({ ...gesture, dx: world.x - gesture.from.x, dy: world.y - gesture.from.y });
          break;
        case "resize":
          setGesture({ ...gesture, rect: resizedRect(gesture.start, gesture.handle, world.x - gesture.from.x, world.y - gesture.from.y) });
          break;
        case "select":
          setGesture({ ...gesture, to: world });
          break;
        case "connect": {
          const hit = hitNode(canvasRef.current.nodes, world);
          setGesture({ ...gesture, at: world, target: hit && hit.id !== gesture.from.node ? hit : undefined });
          break;
        }
      }
    };

    const onUp = (): void => {
      setGesture(null);
      const current = canvasRef.current;
      if (gesture.kind === "move") {
        if (Math.hypot(gesture.dx, gesture.dy) < DRAG_THRESHOLD) return;
        // 搬動過的節點順手提到最上層:剛動過的東西該蓋在別人上面
        commitRef.current(bringToFront(moveNodes(current, gesture.ids, gesture.dx, gesture.dy), gesture.ids));
      } else if (gesture.kind === "resize") {
        commitRef.current(resizeNode(current, gesture.id, gesture.rect));
      } else if (gesture.kind === "select") {
        const rect = rectFromPoints(gesture.from, gesture.to);
        if (rect.width < DRAG_THRESHOLD && rect.height < DRAG_THRESHOLD) {
          if (!gesture.additive) setSelection(EMPTY_SELECTION);
          return;
        }
        const picked = selectionInRect(current, rect);
        setSelection((prev) =>
          gesture.additive ? { nodes: new Set([...prev.nodes, ...picked.nodes]), edges: new Set([...prev.edges, ...picked.edges]) } : picked,
        );
      } else if (gesture.kind === "connect" && gesture.target) {
        const from = current.nodes.find((n) => n.id === gesture.from.node);
        const to = gesture.target;
        if (from) commitRef.current(connect(current, gesture.from, { node: to.id, side: autoSides(to, from).from }));
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [gesture, worldPoint, localPoint]);

  const startBackground = (e: ReactPointerEvent): void => {
    // 節點、工具列與浮層各自處理自己的按下
    if ((e.target as HTMLElement).closest(".canvas-node, .canvas-toolbar, .switcher-backdrop, .canvas-edge")) return;
    setEditing(null);
    if (e.button === 1 || e.altKey || spaceRef.current) {
      setGesture({ kind: "pan", from: localPoint(e), view: viewRef.current });
      return;
    }
    if (e.button !== 0) return;
    const at = worldPoint(e);
    setGesture({ kind: "select", from: at, to: at, additive: e.shiftKey });
  };

  const onPointerDownNode = (e: ReactPointerEvent, node: CanvasNode): void => {
    e.stopPropagation();
    if (e.button !== 0 || editing === node.id) return;
    setEditing(null);
    const already = selection.nodes.has(node.id);
    const nodes = e.shiftKey ? new Set([...selection.nodes, node.id]) : already ? selection.nodes : new Set([node.id]);
    setSelection({ nodes, edges: e.shiftKey ? selection.edges : new Set() });
    if (readOnly) return;
    setGesture({ kind: "move", ids: dragSet(canvasRef.current, nodes), from: worldPoint(e), dx: 0, dy: 0 });
  };

  const onPointerDownResize = (e: ReactPointerEvent, node: CanvasNode, handle: ResizeHandle): void => {
    e.stopPropagation();
    const start = { x: node.x, y: node.y, width: node.width, height: node.height };
    setGesture({ kind: "resize", id: node.id, handle, start, from: worldPoint(e), rect: start });
  };

  const onPointerDownConnect = (e: ReactPointerEvent, node: CanvasNode, side: CanvasSide): void => {
    e.stopPropagation();
    e.preventDefault();
    setGesture({ kind: "connect", from: { node: node.id, side }, at: worldPoint(e) });
  };

  // 鍵盤:刪除、復原、取消。編輯中的輸入框不攔
  useEffect(() => {
    const isTyping = (): boolean => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    };
    const onDown = (e: KeyboardEvent): void => {
      if (isTyping()) return;
      if (e.key === " ") spaceRef.current = true;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) undoRef.current?.redo();
        else undoRef.current?.undo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        const sel = selectionRef.current;
        if (readOnly || (sel.nodes.size === 0 && sel.edges.size === 0)) return;
        e.preventDefault();
        commitRef.current(removeEdges(removeNodes(canvasRef.current, sel.nodes), sel.edges));
        setSelection(EMPTY_SELECTION);
      } else if (e.key === "Escape") {
        setEditing(null);
        setSelection(EMPTY_SELECTION);
      }
    };
    const onUp = (e: KeyboardEvent): void => {
      if (e.key === " ") spaceRef.current = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [readOnly]);

  /** 新節點落在視窗中央 */
  const viewportCenter = (): Point => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return screenToWorld(viewRef.current, { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 });
  };

  const create = (kind: CanvasNode["type"], content: { file?: string; text?: string; url?: string } = {}, at?: Point): void => {
    const node = nodeAt(kind, at ?? viewportCenter(), content);
    commit(addNode(canvasRef.current, node));
    setSelection({ nodes: new Set([node.id]), edges: new Set() });
    if (kind !== "file") setEditing(node.id); // 剛建立的節點直接可以打字
  };

  const deleteSelection = (): void => {
    commit(removeEdges(removeNodes(canvasRef.current, selection.nodes), selection.edges));
    setSelection(EMPTY_SELECTION);
  };

  const fit = (): void => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setView(fitView(canvasRef.current.nodes, { width: rect.width, height: rect.height }));
  };

  /** 拖曳中的畫面只在本地投影,不寫回檔案 */
  const shown = useMemo((): Canvas => {
    if (gesture?.kind === "move") return moveNodes(canvas, gesture.ids, gesture.dx, gesture.dy);
    if (gesture?.kind === "resize") return resizeNode(canvas, gesture.id, gesture.rect);
    return canvas;
  }, [canvas, gesture]);

  const nodeById = useMemo(() => new Map(shown.nodes.map((n) => [n.id, n])), [shown.nodes]);
  /**
   * 群組一律先畫:它是一片背景,擋在節點前面就等於把裡面的東西藏起來。
   * 命中測試仍照原順序(後面的在上),群組另有「只有邊框與標題可點」的規則,兩者不衝突。
   */
  const painted = useMemo(() => [...shown.nodes].sort((a, b) => Number(a.type !== "group") - Number(b.type !== "group")), [shown.nodes]);
  const markdown = useMemo(
    () => ({ onWikilink: (target: string) => onNavigate(target), onLink: (url: string) => void window.stele.openExternal(url) }),
    [onNavigate],
  );

  const selectedCount = selection.nodes.size + selection.edges.size;
  const marquee = gesture?.kind === "select" ? rectFromPoints(gesture.from, gesture.to) : undefined;
  const pendingFrom = gesture?.kind === "connect" ? nodeById.get(gesture.from.node) : undefined;

  return (
    <div
      className="canvas"
      ref={wrapRef}
      onPointerDown={startBackground}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.getData("text/stele-note");
        if (file && !readOnly) create("file", { file }, worldPoint(e));
      }}
    >
      <div className="canvas-toolbar">
        {!readOnly && (
          <>
            <button onClick={() => create("text")} title={t("canvas.addText")}>
              ＋{t("canvas.text")}
            </button>
            <button onClick={() => setPicker("")} title={t("canvas.addFile")}>
              ＋{t("canvas.note")}
            </button>
            <button onClick={() => create("link", { url: "https://" })} title={t("canvas.addLink")}>
              ＋{t("canvas.link")}
            </button>
            <button onClick={() => create("group")} title={t("canvas.addGroup")}>
              ＋{t("canvas.group")}
            </button>
            <span className="canvas-toolbar-sep" />
            <span className="canvas-swatches">
              {PRESET_COLOR_KEYS.map((key) => (
                <button
                  key={key}
                  className="canvas-swatch"
                  style={{ background: colorValue(key) }}
                  disabled={selectedCount === 0}
                  title={t("canvas.color")}
                  aria-label={t("canvas.color")}
                  onClick={() => commit(colorize(canvasRef.current, selection.nodes, selection.edges, key))}
                />
              ))}
              <button
                className="canvas-swatch canvas-swatch-none"
                disabled={selectedCount === 0}
                title={t("canvas.colorClear")}
                aria-label={t("canvas.colorClear")}
                onClick={() => commit(colorize(canvasRef.current, selection.nodes, selection.edges, undefined))}
              />
            </span>
            <button className="danger" disabled={selectedCount === 0} title={t("canvas.delete")} aria-label={t("canvas.delete")} onClick={deleteSelection}>
              🗑
            </button>
            <span className="canvas-toolbar-sep" />
          </>
        )}
        <button onClick={fit} title={t("canvas.fit")} aria-label={t("canvas.fit")}>
          ⤢
        </button>
        <span className="canvas-zoom">{Math.round(view.zoom * 100)}%</span>
      </div>

      {broken && <p className="canvas-broken">{t("canvas.broken")}</p>}

      <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <svg className="canvas-edges">
          {shown.edges.map((edge) => {
            const from = nodeById.get(edge.fromNode);
            const to = nodeById.get(edge.toNode);
            if (!from || !to) return null;
            const auto = autoSides(from, to);
            const fromSide = edge.fromSide ?? auto.from;
            const toSide = edge.toSide ?? auto.to;
            const a = anchorPoint(from, fromSide);
            const b = anchorPoint(to, toSide);
            const stroke = colorValue(edge.color);
            const d = edgePath(a, fromSide, b, toSide);
            const mid = edgeMidpoint(a, fromSide, b, toSide);
            return (
              <g
                key={edge.id}
                className={selection.edges.has(edge.id) ? "canvas-edge selected" : "canvas-edge"}
                style={stroke ? { color: stroke } : undefined}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelection({ nodes: new Set(), edges: new Set([edge.id]) });
                }}
              >
                <path className="canvas-edge-hit" d={d} />
                <path className="canvas-edge-line" d={d} />
                {(edge.toEnd ?? "arrow") === "arrow" && <polygon className="canvas-edge-arrow" points={arrowPoints(b, toSide)} />}
                {edge.fromEnd === "arrow" && <polygon className="canvas-edge-arrow" points={arrowPoints(a, fromSide)} />}
                {edge.label !== undefined && (
                  <text className="canvas-edge-label" x={mid.x} y={mid.y}>
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}
          {pendingFrom && gesture?.kind === "connect" && (
            <path
              className="canvas-edge-pending"
              d={edgePath(
                anchorPoint(pendingFrom, gesture.from.side),
                gesture.from.side,
                gesture.target ? anchorPoint(gesture.target, autoSides(gesture.target, pendingFrom).from) : gesture.at,
                gesture.target ? autoSides(gesture.target, pendingFrom).from : gesture.from.side,
              )}
            />
          )}
        </svg>

        {painted.map((node) => (
          <CanvasNodeView
            key={node.id}
            node={node}
            selected={selection.nodes.has(node.id)}
            editing={editing === node.id}
            readOnly={readOnly}
            preview={node.type === "file" ? previews.get(node.file) : undefined}
            markdown={markdown}
            onPointerDownNode={onPointerDownNode}
            onPointerDownResize={onPointerDownResize}
            onPointerDownConnect={onPointerDownConnect}
            onStartEdit={(n) => setEditing(n.id)}
            onCommitEdit={(n, value) => {
              setEditing(null);
              const patch = n.type === "text" ? { text: value } : n.type === "link" ? { url: value } : { label: value };
              commit(updateNode(canvasRef.current, n.id, patch as never));
            }}
            onOpenFile={onNavigate}
          />
        ))}

        {marquee && <div className="canvas-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
      </div>

      {picker !== null && (
        <div className="switcher-backdrop" onClick={() => setPicker(null)}>
          <div className="switcher" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder={t("canvas.pickNote")}
              value={picker}
              onChange={(e) => setPicker(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setPicker(null);
              }}
            />
            {(picker ? rankFiles(files, picker, 8) : files.slice(0, 8))
              .filter((f) => f !== rel)
              .map((file) => (
                <button
                  key={file}
                  className="switcher-item"
                  onClick={() => {
                    setPicker(null);
                    create("file", { file });
                  }}
                >
                  {file.replace(/\.(md|canvas)$/, "")}
                </button>
              ))}
          </div>
        </div>
      )}

      <p className="canvas-hint">{t(readOnly ? "canvas.readOnly" : "canvas.hint")}</p>
    </div>
  );
}
