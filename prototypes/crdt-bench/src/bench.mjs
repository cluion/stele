// P0-1:Yjs vs Loro 實測 — Stele 真實場景
import * as Y from "yjs";
import { LoroDoc } from "loro-crdt";
import { gzipSync } from "node:zlib";

const N_KEYSTROKES = 20_000;
const N_NODES = 1_000;
const N_MOVES = 2_000;
const N_OFFLINE = 2_000;

const results = {};
const ms = (t0) => Math.round((performance.now() - t0) * 10) / 10;
const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;
// 固定種子的偽隨機,兩邊跑一樣的操作序列
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// ── 場景 1:逐鍵打字(編輯器手感的底層成本)──
{
  const chars = "abcdefghij 這是中文測試內容,包含標點。\n";
  let t0 = performance.now();
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("t");
  let rand = rng(42);
  for (let i = 0; i < N_KEYSTROKES; i++) {
    const pos = Math.floor(rand() * (ytext.length + 1));
    ytext.insert(pos, chars[i % chars.length]);
  }
  const yTime = ms(t0);
  const ySnapshot = Y.encodeStateAsUpdate(ydoc);

  t0 = performance.now();
  const ldoc = new LoroDoc();
  const ltext = ldoc.getText("t");
  rand = rng(42);
  for (let i = 0; i < N_KEYSTROKES; i++) {
    const pos = Math.floor(rand() * (ltext.length + 1));
    ltext.insert(pos, chars[i % chars.length]);
  }
  ldoc.commit();
  const lTime = ms(t0);
  const lSnapshot = ldoc.export({ mode: "snapshot" });
  const lShallow = ldoc.export({ mode: "shallow-snapshot", frontiers: ldoc.frontiers() });

  // 從快照載入(開檔體驗)
  t0 = performance.now();
  const ydoc2 = new Y.Doc();
  Y.applyUpdate(ydoc2, ySnapshot);
  const yLoad = ms(t0);
  t0 = performance.now();
  const ldoc2 = new LoroDoc();
  ldoc2.import(lSnapshot);
  ldoc2.getText("t").toString();
  const lLoad = ms(t0);

  results.typing = {
    "打 2 萬鍵(ms)": { yjs: yTime, loro: lTime },
    "載入快照(ms)": { yjs: yLoad, loro: lLoad },
    "快照大小(KB)": { yjs: kb(ySnapshot.length), loro: kb(lSnapshot.length), "loro淺快照": kb(lShallow.length) },
    "快照gzip(KB)": { yjs: kb(gzipSync(ySnapshot).length), loro: kb(gzipSync(lSnapshot).length) },
  };
}

// ── 場景 2:資料夾樹 — 建立與搬移 ──
{
  // Yjs 沒有樹型別:用 parent-pointer(Y.Map: id → {parent, name})
  let t0 = performance.now();
  const ydoc = new Y.Doc();
  const ymap = ydoc.getMap("tree");
  const yIds = [];
  let rand = rng(7);
  for (let i = 0; i < N_NODES; i++) {
    const id = `n${i}`;
    const node = new Y.Map();
    node.set("name", `note-${i}`);
    node.set("parent", i === 0 ? null : yIds[Math.floor(rand() * yIds.length)]);
    ymap.set(id, node);
    yIds.push(id);
  }
  for (let i = 0; i < N_MOVES; i++) {
    const a = yIds[Math.floor(rand() * yIds.length)];
    const b = yIds[Math.floor(rand() * yIds.length)];
    if (a !== b) ymap.get(a).set("parent", b); // 注意:無迴圈防護!
  }
  const yTime = ms(t0);

  t0 = performance.now();
  const ldoc = new LoroDoc();
  const ltree = ldoc.getTree("tree");
  const lNodes = [];
  rand = rng(7);
  for (let i = 0; i < N_NODES; i++) {
    const node = i === 0 ? ltree.createNode() : lNodes[Math.floor(rand() * lNodes.length)].createNode();
    node.data.set("name", `note-${i}`);
    lNodes.push(node);
  }
  let cycleRejected = 0;
  for (let i = 0; i < N_MOVES; i++) {
    const a = lNodes[Math.floor(rand() * lNodes.length)];
    const b = lNodes[Math.floor(rand() * lNodes.length)];
    if (a.id === b.id) continue;
    try { a.move(b); } catch { cycleRejected++; } // Loro 拒絕產生迴圈的 move
  }
  ldoc.commit();
  const lTime = ms(t0);

  results.tree = {
    "建1000節點+2000次搬移(ms)": { yjs: yTime, loro: lTime },
    "Loro 拒絕的違法搬移次數": cycleRejected,
    註: "Yjs 無樹型別,parent-pointer 模型不會拒絕任何搬移(含製造迴圈的),防護要自己寫",
  };
}

// ── 場景 3:併發搬移 → 迴圈死亡案例(協作正確性)──
{
  // 兩個 peer 同時把對方的資料夾搬進自己底下
  const setupY = () => {
    const d = new Y.Doc();
    const m = d.getMap("tree");
    for (const id of ["A", "B"]) {
      const n = new Y.Map();
      n.set("parent", null);
      m.set(id, n);
    }
    return d;
  };
  const y1 = setupY();
  const y2 = new Y.Doc();
  Y.applyUpdate(y2, Y.encodeStateAsUpdate(y1));
  y1.getMap("tree").get("A").set("parent", "B"); // peer1:A 移進 B
  y2.getMap("tree").get("B").set("parent", "A"); // peer2:B 移進 A
  Y.applyUpdate(y1, Y.encodeStateAsUpdate(y2));
  Y.applyUpdate(y2, Y.encodeStateAsUpdate(y1));
  const pa = y1.getMap("tree").get("A").get("parent");
  const pb = y1.getMap("tree").get("B").get("parent");
  const yCycle = pa === "B" && pb === "A";

  const l1 = new LoroDoc();
  const t1 = l1.getTree("tree");
  const a = t1.createNode(); a.data.set("name", "A");
  const b = t1.createNode(); b.data.set("name", "B");
  l1.commit();
  const l2 = new LoroDoc();
  l2.import(l1.export({ mode: "snapshot" }));
  const t2 = l2.getTree("tree");
  const [a2, b2] = t2.roots();
  t1.getNodeByID(a.id).move(t1.getNodeByID(b.id)); l1.commit(); // peer1:A→B 底下
  b2.move(a2); l2.commit();                                      // peer2:B→A 底下
  l1.import(l2.export({ mode: "update" }));
  l2.import(l1.export({ mode: "update" }));
  const cyc = (tree, id) => { // 檢查是否可從節點走回自己
    let cur = tree.getNodeByID(id).parent(), hops = 0;
    while (cur && hops++ < 10) { if (cur.id === id) return true; cur = cur.parent(); }
    return false;
  };
  const lCycle = cyc(l1.getTree("tree"), a.id) || cyc(l1.getTree("tree"), b.id);
  const lConverged = JSON.stringify(l1.getTree("tree").toJSON()) === JSON.stringify(l2.getTree("tree").toJSON());

  results.concurrentMove = {
    "Yjs parent-pointer 併發搬移後產生迴圈": yCycle ? "是(A↔B 互為父子,資料夾樹壞掉)" : "否",
    "Loro 併發搬移後產生迴圈": lCycle ? "是" : "否(自動擇一勝出)",
    "Loro 兩端收斂一致": lConverged,
  };
}

// ── 場景 4:離線合併(local-first 核心)──
{
  const mk = (lib) => {
    if (lib === "yjs") {
      const d = new Y.Doc();
      d.getText("t").insert(0, "base ");
      return d;
    }
    const d = new LoroDoc();
    d.getText("t").insert(0, "base ");
    d.commit();
    return d;
  };
  // Yjs
  let base = mk("yjs");
  const yA = new Y.Doc(); Y.applyUpdate(yA, Y.encodeStateAsUpdate(base));
  const yB = new Y.Doc(); Y.applyUpdate(yB, Y.encodeStateAsUpdate(base));
  let rand = rng(9);
  for (let i = 0; i < N_OFFLINE; i++) {
    yA.getText("t").insert(Math.floor(rand() * yA.getText("t").length), "a");
    yB.getText("t").insert(Math.floor(rand() * yB.getText("t").length), "b");
  }
  const updA = Y.encodeStateAsUpdate(yA, Y.encodeStateVector(yB));
  const updB = Y.encodeStateAsUpdate(yB, Y.encodeStateVector(yA));
  let t0 = performance.now();
  Y.applyUpdate(yA, updB);
  Y.applyUpdate(yB, updA);
  const yMerge = ms(t0);
  const yOk = yA.getText("t").toString() === yB.getText("t").toString();

  // Loro
  base = mk("loro");
  const lA = new LoroDoc(); lA.import(base.export({ mode: "snapshot" }));
  const lB = new LoroDoc(); lB.import(base.export({ mode: "snapshot" }));
  rand = rng(9);
  for (let i = 0; i < N_OFFLINE; i++) {
    lA.getText("t").insert(Math.floor(rand() * lA.getText("t").length), "a");
    lB.getText("t").insert(Math.floor(rand() * lB.getText("t").length), "b");
  }
  lA.commit(); lB.commit();
  const lUpdA = lA.export({ mode: "update", from: lB.version() });
  const lUpdB = lB.export({ mode: "update", from: lA.version() });
  t0 = performance.now();
  lA.import(lUpdB);
  lB.import(lUpdA);
  const lMerge = ms(t0);
  const lOk = lA.getText("t").toString() === lB.getText("t").toString();

  results.offlineMerge = {
    "雙方各2000離線編輯,合併(ms)": { yjs: yMerge, loro: lMerge },
    "增量更新大小(KB)": { yjs: kb(updA.length + updB.length), loro: kb(lUpdA.length + lUpdB.length) },
    "收斂一致": { yjs: yOk, loro: lOk },
  };
}

console.log(JSON.stringify({ versions: { yjs: "13.6.31", loro: "1.13.7", node: process.version }, ...results }, null, 2));
