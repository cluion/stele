import "./styles.css";
import "./i18n.ts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import { EditorView } from "prosemirror-view";
import { SteleBinding, resolveWikilink, rankFiles } from "@stele/editor-core";
import { createSourceView, topBlockCM, scrollToBlockCM } from "./source-editor.ts";
import { GraphView } from "./graph-view.tsx";
import type { SteleApi, BacklinkItem, VaultInfo } from "../main/preload.ts";

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
  onNavigate,
  onToggleMode,
}: {
  rel: string;
  mode: EditorMode;
  files: string[];
  onNavigate: (target: string) => void;
  onToggleMode: () => void;
}) {
  const { t } = useTranslation();
  const paneRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [ytext, setYtext] = useState<Y.Text | undefined>();
  /** 模式切換時傳遞可見頂部區塊索引,塊級近似保持捲動位置 */
  const scrollBlock = useRef(0);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

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
  suggestRef.current = { open: suggest, items: suggestItems, index: suggestIndex };

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
      const view = new EditorView(host, {
        state: binding.state,
        dispatchTransaction: (tr) => binding.dispatch(tr),
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
      binding.onStateChange = (state) => {
        view.updateState(state);
        refreshSuggest(view);
      };
      scrollToBlockPM(view, scrollBlock.current);
      return () => {
        scrollBlock.current = topBlockPM(view, pane);
        viewRef.current = undefined;
        setSuggest(null);
        binding.destroy();
        view.destroy();
      };
    }

    const source = createSourceView(host, ytext);
    scrollToBlockCM(source.view, ytext.toString(), scrollBlock.current);
    return () => {
      scrollBlock.current = topBlockCM(source.view, pane, ytext.toString());
      source.destroy();
    };
  }, [ytext, mode]);

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

function Welcome({ onChoose }: { onChoose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="welcome">
      <h1>Stele</h1>
      <p>{t("welcome.tagline")}</p>
      <button onClick={onChoose}>{t("welcome.open")}</button>
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
  const [menu, setMenu] = useState<{ x: number; y: number; folder: string } | null>(null);
  // 每篇筆記各自記住模式,session 內有效,預設 WYSIWYG
  const [modes, setModes] = useState<ReadonlyMap<string, EditorMode>>(new Map());

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
  openDailyRef.current = openDaily;

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

  if (vaultInfo === undefined) return null; // 啟動查詢中,避免歡迎畫面閃現
  if (vaultInfo === null) return <Welcome onChoose={chooseVault} />;

  return (
    <div className="app">
      <nav
        className="sidebar"
        onContextMenu={(e) => {
          e.preventDefault();
          const rel = (e.target as HTMLElement).closest("button[data-rel]")?.getAttribute("data-rel");
          const folder = rel ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
          setMenu({ x: e.clientX, y: e.clientY, folder });
        }}
      >
        <div className="vault-header">
          <h1>{vaultInfo.vault}</h1>
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
          <Editor
            key={`${vaultInfo.root}:${active}`}
            rel={active}
            mode={modes.get(active) ?? "wysiwyg"}
            files={files}
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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
