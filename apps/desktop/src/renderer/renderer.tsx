import "./styles.css";
import "./i18n.ts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import { EditorView } from "prosemirror-view";
import { SteleBinding, resolveWikilink } from "@stele/editor-core";
import type { SteleApi, BacklinkItem } from "../main/preload.ts";

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

function Editor({ rel, onNavigate }: { rel: string; onNavigate: (target: string) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let view: EditorView | undefined;
    let binding: SteleBinding | undefined;
    let ydoc: Y.Doc | undefined;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void window.stele.openDoc(rel).then((snapshot) => {
      if (cancelled || !ref.current) return;
      ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, snapshot, "main");
      const ytext = ydoc.getText("md");

      binding = new SteleBinding(ytext);
      view = new EditorView(ref.current, {
        state: binding.state,
        dispatchTransaction: (tr) => binding!.dispatch(tr),
        handleClickOn: (_view, _pos, node) => {
          if (node.type.name === "wikilink") {
            onNavigate(String(node.attrs["target"]));
            return true;
          }
          return false;
        },
      });
      binding.onStateChange = (state) => view!.updateState(state);

      // 本地變更推給 main;main 廣播回來的以 origin "main" 套用,不再回推
      ydoc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== "main") window.stele.pushUpdate(rel, update);
      });
      unsubscribe = window.stele.onDocUpdate((updateRel, update) => {
        if (updateRel === rel && ydoc) Y.applyUpdate(ydoc, update, "main");
      });
      setLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      binding?.destroy();
      view?.destroy();
      ydoc?.destroy();
    };
  }, [rel]);

  return (
    <div className="editor-pane">
      {loading && <p className="placeholder">{t("editor.loading")}</p>}
      <div id="editor" ref={ref} />
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

function App() {
  const { t } = useTranslation();
  const [vault, setVault] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState<string | undefined>();

  useEffect(() => {
    void window.stele.listVault().then(({ vault, files }) => {
      setVault(vault);
      setFiles(files);
      setActive(files[0]);
    });
  }, []);

  const navigate = (target: string) => {
    const dest = resolveWikilink(files, target);
    if (dest) {
      setActive(dest);
      return;
    }
    const name = target.split("#")[0]!.trim();
    const base = name.slice(name.lastIndexOf("/") + 1);
    if (!name || (base.includes(".") && !base.endsWith(".md"))) return; // 圖片等非筆記目標不建檔
    void window.stele.createNote(name).then(async (rel) => {
      const { files: refreshed } = await window.stele.listVault();
      setFiles(refreshed);
      setActive(rel);
    });
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <h1>{vault}</h1>
        {files.length === 0 && <p className="placeholder">{t("sidebar.empty")}</p>}
        {files.map((f) => (
          <button key={f} className={f === active ? "active" : ""} onClick={() => setActive(f)}>
            {f.replace(/\.md$/, "")}
          </button>
        ))}
      </nav>
      {active ? (
        <>
          <Editor key={active} rel={active} onNavigate={navigate} />
          <Backlinks rel={active} onOpen={setActive} />
        </>
      ) : (
        <p className="placeholder">{t("editor.pickNote")}</p>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
