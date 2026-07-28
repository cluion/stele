import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { fieldText } from "@stele/editor-core";
import type { QueryOutcome } from "../main/preload.ts";

/**
 * 查詢視圖:把 ```stele-query 程式碼區塊在所見即所得模式下渲染成查詢結果。
 *
 * **只在所見即所得模式渲染,源碼模式維持原始查詢文字**——這順著 Stele 既有的雙模式分工:
 * 源碼模式本來就是看與改原文的地方。要編輯查詢就切到源碼模式(Cmd+E),
 * 比在渲染結果裡塞一個編輯狀態單純,也不會有「點哪裡才進得去」的猜謎。
 *
 * 序列化完全不受影響:這只是 node view,Markdown 寫回磁碟時仍是原本的 code fence。
 */

/** 這個語言標記的 code fence 才渲染成查詢 */
export const QUERY_LANG = "stele-query";

export interface QueryViewDeps {
  /** 執行查詢(走 IPC 到 main) */
  run: (source: string) => Promise<QueryOutcome>;
  /** 點擊結果列時開啟該篇筆記 */
  open: (path: string) => void;
  /**
   * 已翻譯好的文案。做成 getter 而非固定字串:node view 只建立一次,
   * 固定字串會把當下的語言釘死。node view 本身不認識 i18n 實作。
   */
  labels: () => {
    running: string;
    empty: string;
    colFile: string;
    error: (reason: string) => string;
    count: (n: number) => string;
  };
}

export class QueryNodeView implements NodeView {
  readonly dom: HTMLElement;
  private source: string;
  /** 每次重算遞增:非同步結果回來時比對,晚到的舊查詢不覆蓋新結果 */
  private run = 0;

  constructor(
    node: PMNode,
    private readonly deps: QueryViewDeps,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "query-view";
    this.source = node.textContent;
    this.refresh();
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "code_block" || node.attrs["params"] !== QUERY_LANG) return false;
    if (node.textContent !== this.source) {
      this.source = node.textContent;
      this.refresh();
    }
    return true;
  }

  /** 不提供 contentDOM,所以 PM 不會把游標放進來;內部的點擊也不該變成編輯操作 */
  stopEvent(): boolean {
    return true;
  }
  ignoreMutation(): boolean {
    return true;
  }

  private refresh(): void {
    const token = ++this.run;
    this.dom.replaceChildren(this.status(this.deps.labels().running));
    void this.deps
      .run(this.source)
      .then((outcome) => {
        if (token !== this.run) return; // 已有更新的查詢在跑
        this.dom.replaceChildren(this.render(outcome));
      })
      .catch((err: unknown) => {
        if (token !== this.run) return;
        this.dom.replaceChildren(this.status(err instanceof Error ? err.message : String(err), true));
      });
  }

  private status(text: string, isError = false): HTMLElement {
    const el = document.createElement("p");
    el.className = isError ? "query-error" : "query-status";
    el.textContent = text;
    return el;
  }

  private render(outcome: QueryOutcome): HTMLElement {
    if ("error" in outcome) return this.status(this.deps.labels().error(outcome.error), true);
    if (outcome.rows.length === 0) return this.status(this.deps.labels().empty);

    const wrap = document.createElement("div");
    wrap.className = "query-result";

    const link = (path: string, label: string): HTMLElement => {
      const a = document.createElement("button");
      a.className = "query-link";
      a.textContent = label;
      a.title = path;
      a.addEventListener("click", () => this.deps.open(path));
      return a;
    };

    if (outcome.columns.length === 0) {
      const ul = document.createElement("ul");
      ul.className = "query-list";
      for (const row of outcome.rows) {
        const li = document.createElement("li");
        li.appendChild(link(row.path, row.name));
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    } else {
      const table = document.createElement("table");
      const head = document.createElement("tr");
      for (const label of [this.deps.labels().colFile, ...outcome.columns]) {
        const th = document.createElement("th");
        th.textContent = label;
        head.appendChild(th);
      }
      table.appendChild(head);
      for (const row of outcome.rows) {
        const tr = document.createElement("tr");
        const first = document.createElement("td");
        first.appendChild(link(row.path, row.name));
        tr.appendChild(first);
        for (const cell of row.cells) {
          const td = document.createElement("td");
          td.textContent = fieldText(cell);
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      wrap.appendChild(table);
    }

    const foot = document.createElement("p");
    foot.className = "query-count";
    foot.textContent = this.deps.labels().count(outcome.rows.length);
    wrap.appendChild(foot);
    return wrap;
  }
}
