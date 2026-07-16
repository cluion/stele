import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GraphData } from "../main/preload.ts";
import { initLayout, tickLayout, type LayoutNode } from "./force-layout.ts";

const SETTLE_TICKS = 300;
const HIT_RADIUS = 14;
const NODE_RADIUS = 6;

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function GraphView({ active, onOpen }: { active: string | undefined; onOpen: (rel: string) => void }) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const activeRef = useRef(active);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    activeRef.current = active;
    onOpenRef.current = onOpen;
  });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let disposed = false;
    let raf = 0;
    let data: GraphData = { nodes: [], edges: [] };
    let layout: LayoutNode[] = [];
    let ticksLeft = 0;
    let hover = -1;
    let size = { w: 0, h: 0 };

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      size = { w: r.width, h: r.height };
      canvas.width = Math.round(r.width * devicePixelRatio);
      canvas.height = Math.round(r.height * devicePixelRatio);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
    };

    const draw = () => {
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      const accent = cssVar("--accent");
      const muted = cssVar("--text-muted");
      const border = cssVar("--border-strong");
      const text = cssVar("--text");

      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      for (const [si, ti] of data.edges) {
        const a = layout[si];
        const b = layout[ti];
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      ctx.font = `11px ${cssVar("--font-ui") || "sans-serif"}`;
      ctx.textAlign = "center";
      for (let i = 0; i < layout.length; i++) {
        const n = layout[i]!;
        const isActive = data.nodes[i] === activeRef.current;
        const isHover = i === hover;
        ctx.beginPath();
        ctx.arc(n.x, n.y, isHover ? NODE_RADIUS + 2 : NODE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = isActive || isHover ? accent : muted;
        ctx.fill();
        const label = data.nodes[i]!.replace(/\.md$/, "").split("/").pop()!;
        ctx.fillStyle = isActive || isHover ? text : muted;
        ctx.fillText(label, n.x, n.y + NODE_RADIUS + 14);
      }
    };

    const step = () => {
      if (disposed) return;
      if (ticksLeft > 0) {
        ticksLeft--;
        tickLayout(layout, data.edges, { width: size.w, height: size.h });
        draw();
      }
      raf = requestAnimationFrame(step);
    };

    const load = () =>
      void window.stele.graph().then((g) => {
        if (disposed) return;
        data = g;
        layout = initLayout(g.nodes.length, size.w, size.h);
        ticksLeft = SETTLE_TICKS;
        setNodeCount(g.nodes.length);
      });

    const nearest = (e: MouseEvent): number => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      let best = -1;
      let bestD = HIT_RADIUS;
      for (let i = 0; i < layout.length; i++) {
        const d = Math.hypot(layout[i]!.x - x, layout[i]!.y - y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    };

    const onMove = (e: MouseEvent) => {
      const i = nearest(e);
      if (i !== hover) {
        hover = i;
        canvas.style.cursor = i >= 0 ? "pointer" : "default";
        draw();
      }
    };
    const onClick = (e: MouseEvent) => {
      const i = nearest(e);
      if (i >= 0) onOpenRef.current(data.nodes[i]!);
    };

    resize();
    load();
    const unsubscribe = window.stele.onIndexUpdated(load);
    const observer = new ResizeObserver(() => {
      resize();
      ticksLeft = Math.max(ticksLeft, 60);
    });
    observer.observe(wrap);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    raf = requestAnimationFrame(step);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      unsubscribe();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <div className="graph" ref={wrapRef} data-node-count={nodeCount}>
      <canvas ref={canvasRef} />
      <p className="graph-hint">{t("graph.hint")}</p>
    </div>
  );
}
