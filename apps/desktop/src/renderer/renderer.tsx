import "./styles.css";
import "./i18n.ts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import type { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { SteleBinding, resolveWikilink, rankFiles } from "@stele/editor-core";
import { createSourceView, topBlockCM, scrollToBlockCM, type SourceView } from "./source-editor.ts";
import { encodeCursor, participantCursor, throttle, type RemoteCursor } from "./remote-cursors.ts";
import { remoteCursorPlugin, remoteCursorKey, type BlockCursor } from "./wysiwyg-cursors.ts";
import { GraphView } from "./graph-view.tsx";
import type { SteleApi, BacklinkItem, VaultInfo, Participant, ShareEntry, SharePermission } from "../main/preload.ts";

type EditorMode = "wysiwyg" | "source";

declare global {
  interface Window {
    stele: SteleApi;
  }
}

// 主題跟隨系統,token 層以 data-theme 切換
const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => {
  document.documentElement.dataset["theme"] = media.matches ? "dark" : "light";
};
applyTheme();
media.addEventListener("change", applyTheme);

/** 目前捲動位置最上方可見的 PM 頂層子節點索引;pane 是實際的捲動容器 */
function topBlockPM(view: EditorView, pane: HTMLElement): number {
  const paneTop = pane.getBoundingClientRect().top;
  const doc = view.state.doc;
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement && dom.getBoundingClientRect().bottom > paneTop) return i;
    pos += doc.child(i).nodeSize;
  }
  return Math.max(0, doc.childCount - 1);
}

/** 捲動到 PM 第 index 個頂層子節點 */
function scrollToBlockPM(view: EditorView, index: number): void {
  if (index <= 0) return;
  const doc = view.state.doc;
  let pos = 0;
  for (let i = 0; i < Math.min(index, doc.childCount - 1); i++) pos += doc.child(i).nodeSize;
  const dom = view.nodeDOM(pos);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "start" });
}

interface Suggest {
  query: string;
  /** 「[[」起點的 PM 位置 */
  from: number;
  x: number;
  y: number;
}

function Editor({
  rel,
  mode,
  files,
  participants,
  onNavigate,
  onToggleMode,
}: {
  rel: string;
  mode: EditorMode;
  files: string[];
  participants: Participant[];
  onNavigate: (target: string) => void;
  onToggleMode: () => void;
}) {
  const { t } = useTranslation();
  const paneRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [ytext, setYtext] = useState<Y.Text | undefined>();
  const ydocRef = useRef<Y.Doc | undefined>(undefined);
  const sourceRef = useRef<SourceView | undefined>(undefined);
  const bindingRef = useRef<SteleBinding | undefined>(undefined);
  /** 模式切換時傳遞可見頂部區塊索引,塊級近似保持捲動位置 */
  const scrollBlock = useRef(0);
  const onNavigateRef = useRef(onNavigate);
  useEffect(() => {
    onNavigateRef.current = onNavigate;
  });

  // ── [[ 自動完成 ──
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const suggestItems = suggest
    ? suggest.query
      ? rankFiles(files, suggest.query, 8)
      : files.filter((f) => f !== rel).slice(0, 8)
    : [];
  const suggestRef = useRef<{ open: Suggest | null; items: string[]; index: number }>({ open: null, items: [], index: 0 });
  useEffect(() => {
    suggestRef.current = { open: suggest, items: suggestItems, index: suggestIndex };
  });

  const refreshSuggest = (view: EditorView) => {
    const { $from, empty } = view.state.selection;
    if (!empty || !$from.parent.isTextblock) {
      setSuggest(null);
      return;
    }
    const textBefore = $from.parent.textBetween(Math.max(0, $from.parentOffset - 60), $from.parentOffset, undefined, "￼");
    const match = /\[\[([^[\]￼]*)$/.exec(textBefore);
    const pane = paneRef.current;
    if (!match || !pane) {
      setSuggest(null);
      return;
    }
    const coords = view.coordsAtPos($from.pos);
    const rect = pane.getBoundingClientRect();
    setSuggest({
      query: match[1]!,
      from: $from.pos - match[0].length,
      x: coords.left - rect.left + pane.scrollLeft,
      y: coords.bottom - rect.top + pane.scrollTop + 4,
    });
    setSuggestIndex(0);
  };

  const pickSuggest = (file: string) => {
    const view = viewRef.current;
    const open = suggestRef.current.open;
    if (!view || !open) return;
    const node = view.state.schema.nodes["wikilink"]!.create({ target: file.replace(/\.md$/, "") });
    view.dispatch(view.state.tr.replaceRangeWith(open.from, view.state.selection.from, node));
    setSuggest(null);
    view.focus();
  };

  // 文件生命週期:每個 rel 一份本地 Y.Doc,與 main 經 IPC 雙向同步
  useEffect(() => {
    let ydoc: Y.Doc | undefined;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void window.stele.openDoc(rel).then((snapshot) => {
      if (cancelled) return;
      ydoc = new Y.Doc();
      ydocRef.current = ydoc;
      Y.applyUpdate(ydoc, snapshot, "main");

      // 本地變更推給 main;main 廣播回來的以 origin "main" 套用,不再回推
      ydoc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== "main") window.stele.pushUpdate(rel, update);
      });
      unsubscribe = window.stele.onDocUpdate((updateRel, update) => {
        if (updateRel === rel && ydoc) Y.applyUpdate(ydoc, update, "main");
      });
      setYtext(ydoc.getText("md"));
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      ydoc?.destroy();
      setYtext(undefined);
      scrollBlock.current = 0;
    };
  }, [rel]);

  // 投影生命週期:依模式掛 PM 或 CM,真相永遠是 ytext
  useEffect(() => {
    const host = ref.current;
    const pane = paneRef.current;
    if (!ytext || !host || !pane) return;

    if (mode === "wysiwyg") {
      const binding = new SteleBinding(ytext);
      // 掛遠端游標 plugin;meta-only 更新走 binding.dispatch 不觸發 writeBack
      binding.state = binding.state.reconfigure({ plugins: [...binding.state.plugins, remoteCursorPlugin()] });
      // WYSIWYG 本地游標:塊級,回報所在段落的 block.from(source 端會顯示為段首 caret)
      const pmCursorSend = throttle((offset: number) => {
        window.stele.setCursor(rel, encodeCursor(ytext, offset, offset));
      }, 90);
      const reportPmCursor = (state: EditorState) => {
        // 用 binding 已增量維護的 blocks,不在每次按鍵整份重 parse
        pmCursorSend.call(binding.blockStart(state.selection.$head.index(0)));
      };
      const view = new EditorView(host, {
        state: binding.state,
        dispatchTransaction: (tr) => {
          binding.dispatch(tr);
          if (tr.selectionSet || tr.docChanged) reportPmCursor(binding.state);
        },
        handleClickOn: (_view, _pos, node) => {
          if (node.type.name === "wikilink") {
            onNavigateRef.current(String(node.attrs["target"]));
            return true;
          }
          return false;
        },
        handleKeyDown: (_view, event) => {
          const s = suggestRef.current;
          if (!s.open || s.items.length === 0) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const dir = event.key === "ArrowDown" ? 1 : -1;
            setSuggestIndex((s.index + dir + s.items.length) % s.items.length);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            pickSuggest(s.items[s.index]!);
            return true;
          }
          if (event.key === "Escape") {
            setSuggest(null);
            return true;
          }
          return false;
        },
      });
      viewRef.current = view;
      bindingRef.current = binding;
      binding.onStateChange = (state) => {
        view.updateState(state);
        refreshSuggest(view);
      };
      scrollToBlockPM(view, scrollBlock.current);
      return () => {
        scrollBlock.current = topBlockPM(view, pane);
        viewRef.current = undefined;
        bindingRef.current = undefined;
        setSuggest(null);
        pmCursorSend.cancel();
        binding.destroy();
        view.destroy();
      };
    }

    // 游標回報節流:打字期間每按鍵都會觸發 selectionSet,合併後 ~90ms 送一次
    const cursorSend = throttle((anchor: number, head: number) => {
      window.stele.setCursor(rel, encodeCursor(ytext, anchor, head));
    }, 90);
    const source = createSourceView(host, ytext, cursorSend.call);
    sourceRef.current = source;
    scrollToBlockCM(source.view, ytext.toString(), scrollBlock.current);
    return () => {
      scrollBlock.current = topBlockCM(source.view, pane, ytext.toString());
      sourceRef.current = undefined;
      cursorSend.cancel();
      source.destroy();
    };
  }, [ytext, mode, rel]);

  // 遠端游標:participants 變動時解析 relative position 並推進當前投影
  useEffect(() => {
    const doc = ydocRef.current;
    if (!ytext || !doc) return;
    const cursors: RemoteCursor[] = [];
    for (const p of participants) {
      const c = participantCursor(doc, ytext, p);
      if (c) cursors.push(c);
    }
    if (mode === "source") {
      sourceRef.current?.setRemoteCursors(cursors);
    } else {
      const view = viewRef.current;
      const binding = bindingRef.current;
      if (!view || !binding) return;
      const blockCursors: BlockCursor[] = cursors.map((c) => ({
        clientId: c.clientId,
        block: binding.blockIndexAt(c.head), // 用 binding 增量 blocks,免整份重 parse
        color: c.color,
        name: c.name,
      }));
      view.dispatch(view.state.tr.setMeta(remoteCursorKey, blockCursors));
    }
  }, [participants, ytext, mode]);

  return (
    <div className="editor-pane" ref={paneRef}>
      <div className="mode-toggle-wrap">
        <button
          className="mode-toggle"
          title={t(mode === "wysiwyg" ? "editor.toSource" : "editor.toWysiwyg")}
          aria-label={t(mode === "wysiwyg" ? "editor.toSource" : "editor.toWysiwyg")}
          onClick={onToggleMode}
        >
          {mode === "wysiwyg" ? "</>" : "¶"}
        </button>
      </div>
      {!ytext && <p className="placeholder">{t("editor.loading")}</p>}
      <div id="editor" ref={ref} />
      {suggest && suggestItems.length > 0 && (
        <ul className="wikilink-suggest" style={{ left: suggest.x, top: suggest.y }}>
          {suggestItems.map((f, i) => (
            <li key={f}>
              <button
                className={i === suggestIndex ? "selected" : ""}
                onMouseEnter={() => setSuggestIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSuggest(f);
                }}
              >
                {f.replace(/\.md$/, "")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Backlinks({ rel, onOpen }: { rel: string; onOpen: (rel: string) => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<BacklinkItem[]>([]);

  useEffect(() => {
    let live = true;
    const load = () => void window.stele.backlinks(rel).then((r) => { if (live) setItems(r); });
    load();
    const unsubscribe = window.stele.onIndexUpdated(load);
    return () => { live = false; unsubscribe(); };
  }, [rel]);

  return (
    <aside className="backlinks">
      <h2>{t("backlinks.title")} <span className="count">{items.length}</span></h2>
      {items.length === 0 && <p className="placeholder">{t("backlinks.empty")}</p>}
      <ul>
        {items.map((item, i) => (
          <li key={`${item.file}-${i}`}>
            <button onClick={() => onOpen(item.file)}>
              <span className="file">{item.file.replace(/\.md$/, "")}</span>
              <span className="context">{item.line}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

const SWITCHER_LIMIT = 10;
const RECENT_LIMIT = 20;

type SwitcherItem = { kind: "file"; rel: string } | { kind: "create"; name: string };

/** 與 main 的 vault:create 同規則:拒空 segment、.、.. */
const isLegalNoteName = (name: string) =>
  name.split("/").every((seg) => seg.trim() !== "" && seg !== "." && seg !== "..");

function QuickSwitcher({
  files,
  recent,
  onPick,
  onCreate,
  onClose,
}: {
  files: string[];
  recent: string[];
  onPick: (rel: string) => void;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [createFailed, setCreateFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const trimmed = query.trim();
  const matches = trimmed
    ? rankFiles(files, trimmed, SWITCHER_LIMIT)
    : (recent.length > 0 ? recent : files).slice(0, SWITCHER_LIMIT);

  const norm = trimmed.toLowerCase();
  const hasExact = files.some((f) => {
    const noExt = f.replace(/\.md$/, "").toLowerCase();
    return noExt === norm || noExt.slice(noExt.lastIndexOf("/") + 1) === norm;
  });
  const items: SwitcherItem[] = [
    ...matches.map((rel) => ({ kind: "file", rel }) as const),
    ...(trimmed !== "" && !hasExact && isLegalNoteName(trimmed)
      ? [{ kind: "create", name: trimmed } as const]
      : []),
  ];
  const sel = items.length === 0 ? -1 : Math.min(selected, items.length - 1);

  const pick = (item: SwitcherItem) => {
    if (item.kind === "file") {
      onPick(item.rel);
      onClose();
    } else {
      setCreateFailed(false);
      void onCreate(item.name)
        .then(onClose)
        .catch(() => setCreateFailed(true));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return; // IME 選字中:Enter 是確認選字、方向鍵在選候選字,都不屬於切換器
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setSelected((sel + dir + items.length) % items.length);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[sel];
      if (item) pick(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="switcher-backdrop" onClick={onClose}>
      <div className="switcher" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={t("switcher.placeholder")}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
            setCreateFailed(false);
          }}
          onKeyDown={onKeyDown}
        />
        {createFailed && <p className="error">{t("switcher.createFailed")}</p>}
        {items.length === 0 && <p className="placeholder">{t("switcher.empty")}</p>}
        <ul>
          {items.map((item, i) => (
            <li key={item.kind === "file" ? item.rel : " create"}>
              <button
                className={i === sel ? "selected" : ""}
                onMouseEnter={() => setSelected(i)}
                onClick={() => pick(item)}
              >
                {item.kind === "file"
                  ? item.rel.replace(/\.md$/, "")
                  : t("switcher.create", { name: item.name })}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SearchModal({ onPick, onClose }: { onPick: (rel: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BacklinkItem[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim() === "") {
        setResults([]);
        return;
      }
      void window.stele.search(query).then(setResults);
    }, 120);
    return () => clearTimeout(timer);
  }, [query]);

  const sel = results.length === 0 ? -1 : Math.min(selected, results.length - 1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return; // IME 選字中不攔截
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length > 0) {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setSelected((sel + dir + results.length) % results.length);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[sel];
      if (hit) {
        onPick(hit.file);
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="switcher-backdrop" onClick={onClose}>
      <div className="switcher search" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={t("search.placeholder")}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        {query.trim() !== "" && results.length === 0 && <p className="placeholder">{t("search.empty")}</p>}
        <ul>
          {results.map((hit, i) => (
            <li key={hit.file}>
              <button
                className={i === sel ? "selected" : ""}
                onMouseEnter={() => setSelected(i)}
                onClick={() => {
                  onPick(hit.file);
                  onClose();
                }}
              >
                <span className="file">{hit.file.replace(/\.md$/, "")}</span>
                <span className="context">{hit.line}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Welcome({ onChoose, onOpenShare }: { onChoose: () => void; onOpenShare: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="welcome">
      <h1>Stele</h1>
      <p>{t("welcome.tagline")}</p>
      <button onClick={onChoose}>{t("welcome.open")}</button>
      {/* 沒有 vault 的純消費者也能貼分享連結開臨時協作 */}
      <button className="welcome-secondary" onClick={onOpenShare}>
        {t("open.shared")}
      </button>
    </div>
  );
}

/** 唯讀分享對話框:建立連結、複製、撤銷。可編輯分享後端已備但無消費端,故此處只做唯讀 */
function ShareDialog({ rel, onClose }: { rel: string; onClose: () => void }) {
  const { t } = useTranslation();
  const name = rel.replace(/\.md$/, "");
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  // 載入本篇既有連結(排除已撤銷);live flag 防元件卸載後 setState
  useEffect(() => {
    let live = true;
    void window.stele.listShares().then((all) => {
      if (live) setShares(all.filter((s) => s.rel === rel && !s.revoked));
    });
    return () => {
      live = false;
    };
  }, [rel]);

  // Esc 關閉,與其他浮層一致
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = (): void => {
    setBusy(true);
    setFailed(false);
    void window.stele
      .createShare(rel, "read")
      .then((created) => {
        setLink(created.url);
        return window.stele.listShares();
      })
      .then((all) => setShares(all.filter((s) => s.rel === rel && !s.revoked)))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  const copy = (url: string): void => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const revoke = (shareId: string): void => {
    void window.stele.revokeShare(shareId).then((all) => {
      setShares(all.filter((s) => s.rel === rel && !s.revoked));
    });
  };

  return (
    <div className="switcher-backdrop" onClick={onClose}>
      <div className="switcher share" onClick={(e) => e.stopPropagation()}>
        <h2>{t("share.title", { name })}</h2>
        <p className="placeholder">{t("share.subtitle")}</p>
        {link ? (
          <div className="share-link">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <button className="primary" onClick={() => copy(link)}>
              {copied ? t("share.copied") : t("share.copy")}
            </button>
          </div>
        ) : (
          <button className="primary create" disabled={busy} onClick={create}>
            {busy ? t("share.creating") : t("share.create")}
          </button>
        )}
        {failed && <p className="error">{t("share.failed")}</p>}
        <h3 className="share-heading">{t("share.existing")}</h3>
        {shares.length === 0 ? (
          <p className="placeholder">{t("share.empty")}</p>
        ) : (
          <ul>
            {shares.map((s) => (
              <li key={s.shareId} className="share-row">
                <code>{s.shareId}</code>
                <button className="danger" onClick={() => revoke(s.shareId)}>
                  {t("share.revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface SharedState {
  status: string;
  permission?: SharePermission;
  synced: boolean;
  closed?: string;
}

/** 共享筆記編輯器:綁定 main 端臨時協作 doc(shared:* IPC),唯讀時關閉輸入 */
function SharedEditor({ readOnly }: { readOnly: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ytext, setYtext] = useState<Y.Text | undefined>();

  useEffect(() => {
    let cancelled = false;
    const ydoc = new Y.Doc();
    // 先訂閱再取快照:bootstrap 串流的任何空窗都由 CRDT 冪等套用補上
    ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "main") window.stele.pushShared(update);
    });
    const unsubscribe = window.stele.onSharedUpdate((update) => Y.applyUpdate(ydoc, update, "main"));
    void window.stele.openShared().then((snapshot) => {
      if (cancelled) return;
      if (snapshot) Y.applyUpdate(ydoc, snapshot, "main");
      setYtext(ydoc.getText("md"));
    });
    return () => {
      cancelled = true;
      unsubscribe();
      ydoc.destroy();
      setYtext(undefined);
    };
  }, []);

  useEffect(() => {
    const host = ref.current;
    if (!ytext || !host) return;
    const binding = new SteleBinding(ytext);
    const view = new EditorView(host, {
      state: binding.state,
      editable: () => !readOnly,
      dispatchTransaction: (tr) => binding.dispatch(tr),
    });
    binding.onStateChange = (state) => view.updateState(state);
    return () => {
      binding.destroy();
      view.destroy();
    };
  }, [ytext, readOnly]);

  return (
    <div className="editor-pane">
      <div id="editor" ref={ref} />
    </div>
  );
}

/** 貼上分享連結對話框:消費可編輯/唯讀連結,開臨時協作視窗 */
function ConsumeDialog({ onOpen, onClose }: { onOpen: (url: string) => Promise<boolean>; onClose: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (): void => {
    if (!url.trim()) return;
    setBusy(true);
    setFailed(false);
    void onOpen(url.trim()).then((ok) => {
      if (!ok) {
        setFailed(true);
        setBusy(false);
      }
    });
  };

  return (
    <div className="switcher-backdrop" onClick={onClose}>
      <div className="switcher share consume" onClick={(e) => e.stopPropagation()}>
        <h2>{t("consume.title")}</h2>
        <p className="placeholder">{t("consume.hint")}</p>
        <div className="share-link">
          <input
            autoFocus
            placeholder={t("consume.placeholder")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className="primary" disabled={busy} onClick={submit}>
            {busy ? t("consume.opening") : t("consume.open")}
          </button>
        </div>
        {failed && <p className="error">{t("consume.failed")}</p>}
      </div>
    </div>
  );
}

/** 共享協作全螢幕視窗:橫幅(權限/連線狀態/關閉)+ 共享編輯器 */
function SharedView({ state, onClose }: { state: SharedState; onClose: () => void }) {
  const { t } = useTranslation();
  const statusKey = state.status === "online" || state.status === "offline" ? state.status : "connecting";
  return (
    <div className="shared-overlay">
      <header className="shared-bar">
        <span className="shared-title">{t("shared.title")}</span>
        {state.permission && (
          <span className={`shared-badge ${state.permission}`}>
            {t(state.permission === "write" ? "shared.writable" : "shared.readonly")}
          </span>
        )}
        <span className="shared-status">{t(`shared.${statusKey}`)}</span>
        <button className="shared-close" onClick={onClose}>
          {t("shared.close")}
        </button>
      </header>
      {state.closed ? (
        <p className="placeholder shared-revoked">{t("shared.revoked")}</p>
      ) : !state.synced ? (
        <p className="placeholder">{t("editor.loading")}</p>
      ) : (
        <SharedEditor readOnly={state.permission !== "write"} />
      )}
    </div>
  );
}

function App() {
  const { t } = useTranslation();
  // undefined = 啟動查詢中,null = 尚未開啟 vault(歡迎畫面)
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null | undefined>(undefined);
  const [active, setActive] = useState<string | undefined>();
  const [recent, setRecent] = useState<string[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; folder: string; rel?: string } | null>(null);
  const [renaming, setRenaming] = useState<{ rel: string; value: string; failed?: string } | null>(null);
  const [shareRel, setShareRel] = useState<string | null>(null);
  // 每篇筆記各自記住模式,session 內有效,預設 WYSIWYG
  const [modes, setModes] = useState<ReadonlyMap<string, EditorMode>>(new Map());
  // "off" = 這個 vault 沒設定同步,指示燈隱藏
  const [syncState, setSyncState] = useState("off");
  // 各筆記的在場協作者(不含自己);以 rel 為 key,切換筆記只是讀不同 key
  const [presenceByRel, setPresenceByRel] = useState<Record<string, Participant[]>>({});
  // 消費分享連結:null = 未開共享;貼上連結對話框開關
  const [shared, setShared] = useState<SharedState | null>(null);
  const [consumeOpen, setConsumeOpen] = useState(false);

  useEffect(() => {
    void window.stele.syncStatus().then(setSyncState);
    return window.stele.onSyncStatus(setSyncState);
  }, [vaultInfo?.root]);

  useEffect(() => {
    return window.stele.onPresence((rel, list) => {
      setPresenceByRel((prev) => ({ ...prev, [rel]: list }));
    });
  }, []);

  // 共享 session 事件:只在共享開著時(shared 非 null)更新
  useEffect(() => {
    const offs = [
      window.stele.onSharedStatus((status) => setShared((p) => (p ? { ...p, status } : p))),
      window.stele.onSharedPermission((permission) => setShared((p) => (p ? { ...p, permission } : p))),
      window.stele.onSharedSynced(() => setShared((p) => (p ? { ...p, synced: true } : p))),
      window.stele.onSharedClosed((closed) => setShared((p) => (p ? { ...p, closed } : p))),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const openShared = (url: string): Promise<boolean> =>
    window.stele.consumeShare(url).then((res) => {
      if (res.ok) {
        setShared({ status: "connecting", synced: false });
        setConsumeOpen(false);
      }
      return res.ok;
    });

  const exitShared = (): void => {
    setShared(null);
    void window.stele.closeShared();
  };

  // 切換筆記時通知主行程更新在場宣告
  useEffect(() => {
    window.stele.setActiveNote(active ?? null);
  }, [active]);

  const participants = active ? (presenceByRel[active] ?? []) : [];

  useEffect(() => {
    void window.stele.listVault().then((info) => {
      setVaultInfo(info);
      setActive(info?.files[0]);
    });
  }, []);

  // 側欄與切換器跟著外部新增/刪除檔案即時刷新
  useEffect(() => {
    return window.stele.onIndexUpdated(() => {
      void window.stele.listVault().then((info) => {
        if (info) setVaultInfo(info);
      });
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 不分 Shift:Linux 上 Ctrl+Shift+F 常被輸入法簡繁切換攔走,Ctrl+F 是主要途徑
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setSwitcherOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setGraphOpen((open) => !open);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        openDailyRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setConsumeOpen(true);
      } else if (e.key === "Escape") {
        setGraphOpen(false);
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e" && active) {
        e.preventDefault();
        setModes((m) => {
          const next = new Map(m);
          next.set(active, m.get(active) === "source" ? "wysiwyg" : "source");
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const activate = (rel: string) => {
    setActive(rel);
    setRecent((r) => [rel, ...r.filter((f) => f !== rel)].slice(0, RECENT_LIMIT));
  };

  const openDaily = () => {
    void window.stele
      .daily()
      .then(async (rel) => {
        const info = await window.stele.listVault();
        if (info) setVaultInfo(info);
        activate(rel);
        setGraphOpen(false);
      })
      .catch((err: unknown) => console.error("開啟每日筆記失敗:", err));
  };
  const openDailyRef = useRef(openDaily);
  useEffect(() => {
    // latest-ref 模式:鍵盤 effect 掛一次,永遠呼叫到最新的 openDaily
    // eslint-disable-next-line react-hooks/immutability
    openDailyRef.current = openDaily;
  });

  const createAndOpen = async (name: string) => {
    const rel = await window.stele.createNote(name);
    const info = await window.stele.listVault();
    if (info) setVaultInfo(info);
    activate(rel);
  };

  const chooseVault = () => {
    void window.stele
      .chooseVault()
      .then((info) => {
        if (!info) return; // 使用者取消:現狀不動
        setVaultInfo(info);
        setActive(info.files[0]);
        setRecent([]);
        setModes(new Map()); // rel 在不同 vault 可能撞名,一併重置
        setPresenceByRel({}); // 同理,舊 vault 的在場清單不能沿用到新 vault
        setSwitcherOpen(false);
      })
      .catch((err: unknown) => console.error("換 vault 失敗:", err));
  };

  const files = vaultInfo?.files ?? [];

  /** 未命名、未命名 2、未命名 3… 找到第一個沒被用掉的 */
  const newUntitled = (folder: string) => {
    const base = t("contextmenu.untitled");
    let name = `${folder}${base}`;
    for (let n = 2; files.includes(`${name}.md`); n++) name = `${folder}${base} ${n}`;
    void createAndOpen(name).catch((err: unknown) => console.error("新增筆記失敗:", err));
    setMenu(null);
  };

  const navigate = (target: string) => {
    const dest = resolveWikilink(files, target);
    if (dest) {
      activate(dest);
      return;
    }
    const name = target.split("#")[0]!.trim();
    const base = name.slice(name.lastIndexOf("/") + 1);
    if (!name || (base.includes(".") && !base.endsWith(".md"))) return; // 圖片等非筆記目標不建檔
    void createAndOpen(name).catch((err: unknown) => console.error(`wikilink 建檔失敗 ${name}:`, err));
  };

  // 消費分享連結不需 vault,故浮層在任何 vault 狀態下都掛
  const overlays = (
    <>
      {consumeOpen && <ConsumeDialog onOpen={openShared} onClose={() => setConsumeOpen(false)} />}
      {shared && <SharedView state={shared} onClose={exitShared} />}
    </>
  );

  if (vaultInfo === undefined) return null; // 啟動查詢中,避免歡迎畫面閃現
  if (vaultInfo === null)
    return (
      <>
        <Welcome onChoose={chooseVault} onOpenShare={() => setConsumeOpen(true)} />
        {overlays}
      </>
    );

  return (
    <div className="app">
      <nav
        className="sidebar"
        onContextMenu={(e) => {
          e.preventDefault();
          const rel = (e.target as HTMLElement).closest("button[data-rel]")?.getAttribute("data-rel") ?? undefined;
          const folder = rel ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
          setMenu({ x: e.clientX, y: e.clientY, folder, rel });
        }}
      >
        <div className="vault-header">
          <h1>{vaultInfo.vault}</h1>
          {syncState !== "off" && (
            <span className={`sync-dot ${syncState}`} title={t(`sync.${syncState}`)} aria-label={t(`sync.${syncState}`)} />
          )}
          <button className="vault-switch" title={t("search.open")} aria-label={t("search.open")} onClick={() => setSearchOpen(true)}>
            ⌕
          </button>
          <button className="vault-switch" title={t("daily.today")} aria-label={t("daily.today")} onClick={openDaily}>
            今
          </button>
          <button
            className={graphOpen ? "vault-switch active" : "vault-switch"}
            title={t("graph.toggle")}
            aria-label={t("graph.toggle")}
            onClick={() => setGraphOpen((open) => !open)}
          >
            ◉
          </button>
          <button className="vault-switch" title={t("open.shared")} aria-label={t("open.shared")} onClick={() => setConsumeOpen(true)}>
            ⇲
          </button>
          <button className="vault-switch" title={t("vault.switch")} aria-label={t("vault.switch")} onClick={chooseVault}>
            ⇄
          </button>
        </div>
        {files.length === 0 && <p className="placeholder">{t("sidebar.empty")}</p>}
        {files.map((f) => (
          <button key={f} data-rel={f} className={f === active ? "active" : ""} onClick={() => activate(f)}>
            {f.replace(/\.md$/, "")}
          </button>
        ))}
      </nav>
      {graphOpen ? (
        <GraphView
          active={active}
          onOpen={(rel) => {
            activate(rel);
            setGraphOpen(false);
          }}
        />
      ) : active ? (
        <>
          {participants.length > 0 && (
            <div className="presence-bar">
              {participants.map((p) => (
                <span key={p.clientId} className="presence-avatar" style={{ background: p.color }} title={p.name}>
                  {[...p.name][0] ?? "?"}
                </span>
              ))}
            </div>
          )}
          <Editor
            key={`${vaultInfo.root}:${active}`}
            rel={active}
            mode={modes.get(active) ?? "wysiwyg"}
            files={files}
            participants={participants}
            onNavigate={navigate}
            onToggleMode={() =>
              setModes((m) => {
                const next = new Map(m);
                next.set(active, m.get(active) === "source" ? "wysiwyg" : "source");
                return next;
              })
            }
          />
          <Backlinks rel={active} onOpen={activate} />
        </>
      ) : (
        <p className="placeholder">{t("editor.pickNote")}</p>
      )}
      {menu && (
        <div className="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
            <button onClick={() => newUntitled(menu.folder)}>{t("contextmenu.newNote")}</button>
            {menu.rel && (
              <>
                <button
                  onClick={() => {
                    setRenaming({ rel: menu.rel!, value: menu.rel!.replace(/\.md$/, "") });
                    setMenu(null);
                  }}
                >
                  {t("contextmenu.rename")}
                </button>
                <button
                  onClick={() => {
                    setShareRel(menu.rel!);
                    setMenu(null);
                  }}
                >
                  {t("contextmenu.share")}
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    const rel = menu.rel!;
                    setMenu(null);
                    if (!window.confirm(t("delete.confirm", { name: rel.replace(/\.md$/, "") }))) return;
                    void window.stele
                      .deleteNote(rel)
                      .then(async () => {
                        const info = await window.stele.listVault();
                        if (info) setVaultInfo(info);
                        setRecent((r) => r.filter((f) => f !== rel));
                        if (active === rel) setActive(info?.files[0]);
                      })
                      .catch((err: unknown) => console.error("刪除失敗:", err));
                  }}
                >
                  {t("contextmenu.delete")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {renaming && (
        <div className="switcher-backdrop" onClick={() => setRenaming(null)}>
          <div className="switcher" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={renaming.value}
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Escape") setRenaming(null);
                if (e.key !== "Enter") return;
                e.preventDefault();
                void window.stele
                  .renameNote(renaming.rel, renaming.value)
                  .then(async (newRel) => {
                    const info = await window.stele.listVault();
                    if (info) setVaultInfo(info);
                    setRecent((r) => r.map((f) => (f === renaming.rel ? newRel : f)));
                    if (active === renaming.rel) setActive(newRel);
                    setRenaming(null);
                  })
                  .catch((err: unknown) => setRenaming({ ...renaming, failed: String(err) }));
              }}
            />
            {renaming.failed && <p className="error">{t("rename.failed")}</p>}
            <p className="placeholder">{t("rename.hint")}</p>
          </div>
        </div>
      )}
      {searchOpen && (
        <SearchModal
          onPick={(rel) => {
            activate(rel);
            setGraphOpen(false);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {switcherOpen && (
        <QuickSwitcher
          files={files}
          recent={recent.filter((f) => f !== active && files.includes(f))}
          onPick={activate}
          onCreate={createAndOpen}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {shareRel && <ShareDialog rel={shareRel} onClose={() => setShareRel(null)} />}
      {overlays}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
