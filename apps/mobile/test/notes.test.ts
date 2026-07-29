import { describe, it, expect } from "vitest";
import { searchNotes, resolveNote, backlinksOf, type Note } from "../src/notes.ts";

/**
 * 行動端的查詢層。規則都有對應的手感:檔名優先於內文(打書名是想去那一篇)、
 * 解不到的 wikilink 不建檔(小螢幕上誤觸多過本意)、同一篇連過來多次只列一列。
 */

const notes: Note[] = [
  { docId: "a", rel: "靈感箱.md", text: "# 靈感箱\n\n白板要能連到筆記\n\n連到 [[專案筆記]]\n" },
  { docId: "b", rel: "專案筆記.md", text: "# 專案筆記\n\n行動端進行中,靈感來自 [[靈感箱]]。\n" },
  { docId: "c", rel: "日記/2026-07-29.md", text: "# 2026-07-29\n\n今天把白板發出去了。參考 [[靈感箱|那份清單]]\n" },
];

describe("搜尋", () => {
  it("檔名命中排在內文命中前面(打書名是想去那一篇)", () => {
    const hits = searchNotes(notes, "靈感箱");
    expect(hits[0]!.rel).toBe("靈感箱.md");
    expect(hits.map((h) => h.rel)).toContain("專案筆記.md"); // 內文提到也找得到
  });

  it("只在內文出現也搜得到,並回傳命中的那一行當上下文", () => {
    const hits = searchNotes(notes, "白板");
    expect(new Set(hits.map((h) => h.rel))).toEqual(new Set(["靈感箱.md", "日記/2026-07-29.md"]));
    expect(hits.find((h) => h.rel === "日記/2026-07-29.md")!.line).toBe("今天把白板發出去了。參考 [[靈感箱|那份清單]]");
  });

  it("同一篇不重複出現(檔名與內文都命中時只算一列)", () => {
    const hits = searchNotes(notes, "專案筆記");
    expect(hits.filter((h) => h.rel === "專案筆記.md")).toHaveLength(1);
  });

  it("空查詢回空陣列,不是回全部", () => {
    expect(searchNotes(notes, "")).toEqual([]);
    expect(searchNotes(notes, "   ")).toEqual([]);
  });

  it("沒有命中就是空的", () => {
    expect(searchNotes(notes, "不存在的字串")).toEqual([]);
  });

  it("大小寫不敏感", () => {
    const upper = [{ docId: "x", rel: "Readme.md", text: "Hello WORLD\n" }];
    expect(searchNotes(upper, "world")).toHaveLength(1);
    expect(searchNotes(upper, "README")).toHaveLength(1);
  });
});

describe("wikilink 解析", () => {
  it("解得到就回那一篇(不分副檔名寫法)", () => {
    expect(resolveNote(notes, "專案筆記")?.docId).toBe("b");
    expect(resolveNote(notes, "專案筆記.md")?.docId).toBe("b");
  });

  it("帶錨點時仍解得到本體", () => {
    expect(resolveNote(notes, "專案筆記#進度")?.docId).toBe("b");
  });

  it("解不到回 undefined——手機上不建檔", () => {
    expect(resolveNote(notes, "還沒有這一篇")).toBeUndefined();
  });
});

describe("反向連結", () => {
  it("列出連到這一篇的筆記與那一行", () => {
    const links = backlinksOf(notes, "靈感箱.md");
    // 順序不是這個函式的規格,比對集合
    expect(new Set(links.map((l) => l.rel))).toEqual(new Set(["專案筆記.md", "日記/2026-07-29.md"]));
    expect(links.find((l) => l.rel === "專案筆記.md")!.line).toBe("行動端進行中,靈感來自 [[靈感箱]]。");
  });

  it("別名連結照樣算(`[[目標|別名]]` 指的還是同一篇)", () => {
    expect(backlinksOf(notes, "靈感箱.md").map((l) => l.rel)).toContain("日記/2026-07-29.md");
  });

  it("不把自己算進去", () => {
    const selfRef: Note[] = [{ docId: "s", rel: "自己.md", text: "看 [[自己]]\n" }];
    expect(backlinksOf(selfRef, "自己.md")).toEqual([]);
  });

  it("同一篇連過來多次只列一列", () => {
    const twice: Note[] = [
      { docId: "t", rel: "來源.md", text: "[[目標]] 又一次 [[目標]]\n" },
      { docId: "u", rel: "目標.md", text: "內容\n" },
    ];
    expect(backlinksOf(twice, "目標.md")).toHaveLength(1);
  });

  it("沒有人連過來就是空的", () => {
    expect(backlinksOf(notes, "日記/2026-07-29.md")).toEqual([]);
  });
});
