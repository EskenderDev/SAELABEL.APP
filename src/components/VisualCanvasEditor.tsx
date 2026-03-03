import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorElementDefinition, UpsertEditorElementPayload } from "@/lib/api/client";
import { createEditorApi } from "@/lib/api/client";
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";

type Props = {
  xml: string;
  onXmlChange: (xml: string) => void;
  apiBaseUrl: string;
  timeoutMs: number;
  docId: string;
  docName: string;
  metadata: {
    version: string;
    brand: string;
    description: string;
    part: string;
    size: string;
  };
  onDocNameChange: (name: string) => void;
  onMetadataChange: (meta: any) => void;
};

type Kind = "sae" | "glabels";
type Obj = {
  id: string;
  xmlIndex: number | null;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  rotateDeg: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
  groupId?: string;
  barcodeKind?: string;
};
type Parsed = {
  kind: Kind;
  widthPt: number;
  heightPt: number;
  objects: Obj[];
  xmlDocument: XMLDocument;
};
type DragState = {
  mode: "move" | "resize" | "transform";
  id: string;
  handle?: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  w: number;
  h: number;
  startRotateDeg?: number;
  startSkewX?: number;
  startSkewY?: number;
  centerClientX?: number;
  centerClientY?: number;
  startAngleRad?: number;
  transformKind?: "rotate" | "skewX" | "skewY" | "skewAuto";
  originMap?: Record<string, { x: number; y: number }>;
};
type BoxSelectState = { startClientX: number; startClientY: number; currentClientX: number; currentClientY: number };
type LayerNode =
  | { kind: "group"; groupId: string; members: Obj[] }
  | { kind: "item"; object: Obj };
type Unit = "mm" | "cm" | "in" | "pt";
type Guideline = { id: string; orientation: "horizontal" | "vertical"; posPt: number };

const MIN = 4;
const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const TYPES = ["text", "barcode", "box", "line", "ellipse", "image"] as const;
const BASE_ELEMENT_KEYS = new Set(["text", "barcode", "box", "line", "ellipse", "image"]);
const ICON: Record<(typeof TYPES)[number], any> = {
  text: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  ),
  barcode: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5v14M8 5v14M12 5v14M17 5v14M21 5v14" />
    </svg>
  ),
  box: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    </svg>
  ),
  line: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  ellipse: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
    </svg>
  ),
  image: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ),
};

const BarcodeImage = ({ value, kind, width, height, zoom, onResize }: { value: string; kind?: string; width: number; height: number; zoom: number; onResize?: (w: number, h: number) => void }) => {
  const [imgData, setImgData] = useState<string>("");
  
  useEffect(() => {
    if (!value) return;
    const format = (kind || "CODE128").toUpperCase();
    
    if (format === "QR") {
      QRCode.toDataURL(value, {
        margin: 0,
        width: Math.round(Math.min(width, height) * zoom * 2),
        color: { dark: "#000000", light: "#ffffff00" }
      }).then(url => {
        setImgData(url);
        // QR is square, use its requested size or default
        if (onResize) onResize(width, height);
      })
        .catch(err => console.error("QR render error:", err));
    } else {
      const canvas = document.createElement("canvas");
      try {
        JsBarcode(canvas, value, {
          format,
          width: Math.max(1, Math.round(2 * zoom)),
          height: Math.max(10, Math.round(height * zoom)),
          displayValue: false,
          margin: 0,
          background: "transparent",
          lineColor: "#000",
        });
        setImgData(canvas.toDataURL());
        
        // Match the bounding box to the actual rendered barcode
        if (onResize) {
          const actualWidthPt = canvas.width / (zoom * 2); // Approximation 
          onResize(actualWidthPt, height);
        }
      } catch (e) {
        console.warn("Barcode render error:", e);
      }
    }
  }, [value, kind, zoom, height, width]);

  return imgData ? <img src={imgData} alt={value} style={{ width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }} /> : null;
};

const n = (v: string | null | undefined, f: number) => {
  const p = Number.parseFloat((v ?? "").replace("pt", ""));
  return Number.isFinite(p) ? p : f;
};
const pt = (v: number) => v.toFixed(4).replace(/\.?0+$/, "");
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const num = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
const PT_PER_IN = 72;
const MM_PER_IN = 25.4;
const toUnit = (ptValue: number, unit: Unit): number => {
  if (unit === "pt") return ptValue;
  if (unit === "in") return ptValue / PT_PER_IN;
  if (unit === "mm") return (ptValue / PT_PER_IN) * MM_PER_IN;
  return (ptValue / PT_PER_IN) * 2.54; // cm
};
const fromUnit = (value: number, unit: Unit): number => {
  if (unit === "pt") return value;
  if (unit === "in") return value * PT_PER_IN;
  if (unit === "mm") return (value / MM_PER_IN) * PT_PER_IN;
  return (value / 2.54) * PT_PER_IN; // cm
};
const unitStep = (unit: Unit): string => (unit === "pt" ? "1" : unit === "in" ? "0.01" : "0.1");

const Ruler = ({ 
  orientation, 
  lengthPt, 
  zoom, 
  unit, 
  offsetPt = 0,
  onStartGuideline,
  guidelines = []
}: { 
  orientation: "horizontal" | "vertical", 
  lengthPt: number, 
  zoom: number, 
  unit: Unit,
  offsetPt?: number,
  onStartGuideline?: (e: React.MouseEvent) => void,
  guidelines?: Guideline[]
}) => {
  const isH = orientation === "horizontal";
  const stepPt = fromUnit(isH ? 10 : 10, unit === "in" ? "in" : unit); 
  const subStepPt = stepPt / 10;
  
  // Viewport-based rendering
  const ticks = [];
  const startPt = Math.floor(-offsetPt / stepPt) * stepPt;
  const endPt = startPt + 5000; // Large enough buffer

  for (let pt = startPt; pt <= endPt; pt += subStepPt) {
    const pos = (pt + offsetPt) * zoom;
    const i = Math.round(pt / subStepPt);
    const isMajor = i % 10 === 0;
    const isMid = i % 5 === 0 && !isMajor;
    const val = Math.round(toUnit(pt, unit));
    
    ticks.push(
      <div key={pt} className={`rulerTick ${isMajor ? "major" : isMid ? "mid" : "small"}`} style={{ [isH ? "left" : "top"]: pos }}>
        {isMajor && <span className="rulerLabel">{val}</span>}
      </div>
    );
  }

  return (
    <div className={`ruler ${orientation}`} onMouseDown={onStartGuideline}>
      {ticks}
      {guidelines.filter(g => g.orientation === orientation).map(g => (
        <div key={g.id} className="rulerIndicator" style={{ [isH ? "left" : "top"]: (g.posPt + offsetPt) * zoom }} />
      ))}
    </div>
  );
};

function toAffine(o: Obj): { a: number; b: number; c: number; d: number } {
  const rad = (o.rotateDeg * Math.PI) / 180;
  const kx = Math.tan((o.skewX * Math.PI) / 180);
  const ky = Math.tan((o.skewY * Math.PI) / 180);
  const sx = o.scaleX;
  const sy = o.scaleY;
  const m11 = sx;
  const m12 = kx * sy;
  const m21 = ky * sx;
  const m22 = sy * (1 + ky * kx);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    a: cos * m11 - sin * m21,
    b: sin * m11 + cos * m21,
    c: cos * m12 - sin * m22,
    d: sin * m12 + cos * m22,
  };
}

function intersects(a: { l: number; t: number; r: number; b: number }, b: { l: number; t: number; r: number; b: number }): boolean {
  return !(a.r < b.l || a.l > b.r || a.b < b.t || a.t > b.b);
}

function contains(a: { l: number; t: number; r: number; b: number }, b: { l: number; t: number; r: number; b: number }): boolean {
  return b.l >= a.l && b.t >= a.t && b.r <= a.r && b.b <= a.b;
}

function parse(xml: string): Parsed {
  const d = new DOMParser().parseFromString(xml, "application/xml");
  if (d.querySelector("parsererror")) throw new Error("XML invalido.");
  const root = d.documentElement.nodeName.toLowerCase();
  if (root === "saelabels") {
    const rect = d.documentElement.getElementsByTagName("label_rectangle")[0];
    const objects = Array.from(d.documentElement.getElementsByTagName("objects")[0]?.getElementsByTagName("object") ?? []).map((e, i) => ({
      id: `o-${i}`, xmlIndex: i, type: (e.getAttribute("type") ?? "text").toLowerCase(),
      x: n(e.getAttribute("x_pt"), 0), y: n(e.getAttribute("y_pt"), 0), w: n(e.getAttribute("w_pt"), 40), h: n(e.getAttribute("h_pt"), 20),
      content: e.getElementsByTagName("content")[0]?.textContent?.trim() ?? "",
      rotateDeg: n(e.getAttribute("rot_deg"), 0),
      scaleX: n(e.getAttribute("scale_x"), 1),
      scaleY: n(e.getAttribute("scale_y"), 1),
      skewX: n(e.getAttribute("skew_x"), 0),
      skewY: n(e.getAttribute("skew_y"), 0),
      barcodeKind: e.getAttribute("style") ?? undefined,
    }));
    return {
      kind: "sae",
      widthPt: n(rect?.getAttribute("width_pt"), 200),
      heightPt: n(rect?.getAttribute("height_pt"), 100),
      objects,
      xmlDocument: d,
    };
  }
  if (root === "glabels-document" || root === "glabels-template" || root === "template") {
    const t = d.documentElement.nodeName === "Template" ? d.documentElement : d.documentElement.getElementsByTagName("Template")[0];
    const rect = t?.getElementsByTagName("Label-rectangle")[0];
    const objects = Array.from(d.documentElement.getElementsByTagName("Objects")[0]?.children ?? []).filter((x) => x.nodeName.startsWith("Object-")).map((e, i) => ({
      id: `o-${i}`, xmlIndex: i, type: e.nodeName.replace("Object-", "").toLowerCase(),
      x: n(e.getAttribute("x"), 0), y: n(e.getAttribute("y"), 0), w: n(e.getAttribute("w"), 40), h: n(e.getAttribute("h"), 20),
      content: e.getElementsByTagName("p")[0]?.textContent?.trim() ?? e.getAttribute("data") ?? "",
      rotateDeg: n(e.getAttribute("rot_deg"), 0),
      scaleX: n(e.getAttribute("scale_x"), 1),
      scaleY: n(e.getAttribute("scale_y"), 1),
      skewX: n(e.getAttribute("skew_x"), 0),
      skewY: n(e.getAttribute("skew_y"), 0),
      barcodeKind: e.getAttribute("style") ?? undefined,
    }));
    return {
      kind: "glabels",
      widthPt: n(rect?.getAttribute("width"), 200),
      heightPt: n(rect?.getAttribute("height"), 100),
      objects,
      xmlDocument: d,
    };
  }
  throw new Error("Solo saelabels/glabels.");
}

export default function VisualCanvasEditor({ 
  xml, 
  onXmlChange, 
  apiBaseUrl, 
  timeoutMs,
  docId,
  docName,
  metadata,
  onDocNameChange,
  onMetadataChange
}: Props) {
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => setIsMounted(true), []);

  const [zoomPercent, setZoomPercent] = useState(200);
  const [error, setError] = useState("");
  const [objects, setObjects] = useState<Obj[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [boxSelect, setBoxSelect] = useState<BoxSelectState | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string | null } | null>(null);
  const [elements, setElements] = useState<EditorElementDefinition[]>([]);
  const [status, setStatus] = useState("");
  const [templateUnit, setTemplateUnit] = useState<Unit>("mm");
  const [baseElementIds, setBaseElementIds] = useState<string[]>([]);
  const [templateWidthPt, setTemplateWidthPt] = useState(200);
  const [templateHeightPt, setTemplateHeightPt] = useState(100);
  const [isBoardDragOver, setIsBoardDragOver] = useState(false);
  const [dragLayerId, setDragLayerId] = useState<string | null>(null);
  const [transformModeIds, setTransformModeIds] = useState<string[]>([]);
  const [sidebarEditMode, setSidebarEditMode] = useState(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(300);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(300);
  const [editingElementId, setEditingElementId] = useState("");
  const [elementForm, setElementForm] = useState<UpsertEditorElementPayload>({
    key: "text",
    name: "Texto",
    category: "basic",
    objectType: "text",
    defaultWidthPt: 90,
    defaultHeightPt: 24,
    defaultContent: "${texto}"
  });
  const [guidelines, setGuidelines] = useState<Guideline[]>([]);
  const [activeGuidelineDrag, setActiveGuidelineDrag] = useState<{ id: string; startPosPt: number; hasExitedRuler?: boolean } | null>(null);
  const [rulerOffsets, setRulerOffsets] = useState({ x: 0, y: 0 });
  const [activeRightTab, setActiveRightTab] = useState<"layers" | "properties" | "preview">("layers");
  
  const boardRef = useRef<HTMLDivElement | null>(null);
  const studioBodyRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const draggedElementRef = useRef<EditorElementDefinition | null>(null);
  const resizingSidebarRef = useRef<{
    side: "left" | "right";
    startX: number;
    startWidth: number;
    otherWidth: number;
    bodyWidth: number;
  } | null>(null);
  
  const editorApi = useMemo(() => createEditorApi(apiBaseUrl, { timeoutMs }), [apiBaseUrl, timeoutMs]);
  
  const parseResult = useMemo(() => {
    try { return { parsed: parse(xml), parseError: "" }; } catch (e) { return { parsed: null, parseError: e instanceof Error ? e.message : "Error parseando." }; }
  }, [xml]);
  
  const parsed = parseResult.parsed;
  const viewError = parseResult.parseError || error;
  const zoom = zoomPercent / 100;
  
  const activeTransformKind = drag?.mode === "transform"
    ? (drag.transformKind ?? ((drag.handle?.length ?? 0) === 2 ? "rotate" : "skewAuto"))
    : null;

  const refresh = async () => {
    const els = await editorApi.listElements();
    setElements(els);
    setBaseElementIds((prev) => {
      const seeded = els.filter((el) => BASE_ELEMENT_KEYS.has(el.key)).map((el) => el.id);
      if (seeded.length === 0) return prev;
      return Array.from(new Set([...prev, ...seeded]));
    });
  };

  useEffect(() => {
    if (!parsed) return;
    setObjects(parsed.objects);
    setTemplateWidthPt(parsed.widthPt);
    setTemplateHeightPt(parsed.heightPt);
    setError("");
  }, [parsed]);

  useEffect(() => {
    setTransformModeIds([]);
  }, [selectedIds]);

  // Auto-sync objects to XML prop
  useEffect(() => {
    const timer = setTimeout(() => {
      applyXml();
    }, 500);
    return () => clearTimeout(timer);
  }, [objects, templateWidthPt, templateHeightPt, metadata]);

  useEffect(() => {
    const run = async () => {
      try { await refresh(); } catch (e) { setStatus(e instanceof Error ? e.message : "No se pudo cargar libreria."); }
    };
    void run();
  }, [editorApi]);

  useEffect(() => {
    if (!drag && !activeGuidelineDrag) return;
    const move = (ev: MouseEvent) => {
      if (activeGuidelineDrag && viewportRef.current) {
        const br = boardRef.current?.getBoundingClientRect();
        if (!br) return;
        const orient = guidelines.find(g => g.id === activeGuidelineDrag.id)?.orientation;
        if (!orient) return;
        
        const isH = orient === "horizontal";
        const mousePos = isH ? ev.clientY : ev.clientX;
        const boardPos = isH ? br.top : br.left;
        const newPosPt = (mousePos - boardPos) / zoom;
        
        // Remove if dragged back to ruler
        const vbr = viewportRef.current.getBoundingClientRect();
        const isInRuler = isH ? (ev.clientY < vbr.top + 24) : (ev.clientX < vbr.left + 24);
        
        if (!activeGuidelineDrag.hasExitedRuler && !isInRuler) {
          setActiveGuidelineDrag(prev => prev ? { ...prev, hasExitedRuler: true } : null);
        }

        if (activeGuidelineDrag.hasExitedRuler && isInRuler) {
          setGuidelines(prev => prev.filter(g => g.id !== activeGuidelineDrag.id));
        } else {
          setGuidelines(prev => prev.map(g => g.id === activeGuidelineDrag.id ? { ...g, posPt: newPosPt } : g));
        }
        return;
      }

      if (!drag) return;

      const dx = (ev.clientX - drag.startX) / zoom;
      const dy = (ev.clientY - drag.startY) / zoom;
      const dragObj = objects.find(o => o.id === drag.id);
      const groupToMove = dragObj?.groupId 
        ? objects.filter(o => o.groupId === dragObj.groupId).map(o => o.id)
        : selectedIds.includes(drag.id) ? selectedIds : [drag.id];

      setObjects((prev) => prev.map((o) => {
        if (!groupToMove.includes(o.id)) return o;
        if (drag.mode === "move") {
          const origin = drag.originMap?.[o.id] ?? { x: o.x, y: o.y };
          let nextX = origin.x + dx;
          let nextY = origin.y + dy;
          if (!ev.altKey) { nextX = clamp(nextX, -1000, 2000); nextY = clamp(nextY, -1000, 2000); }
          return { ...o, x: nextX, y: nextY };
        }
        if (o.id !== drag.id) return o;
        if (drag.mode === "transform") {
          const h = drag.handle ?? "se";
          const kind = drag.transformKind ?? (h.length === 2 ? "rotate" : "skewAuto");
          if (kind === "rotate") {
            const cx = drag.centerClientX ?? drag.startX;
            const cy = drag.centerClientY ?? drag.startY;
            const startAngle = drag.startAngleRad ?? 0;
            const currentAngle = Math.atan2(ev.clientY - cy, ev.clientX - cx);
            const deltaDeg = ((currentAngle - startAngle) * 180) / Math.PI;
            return { ...o, rotateDeg: num(drag.startRotateDeg ?? o.rotateDeg, o.rotateDeg) + deltaDeg };
          }
          if (kind === "skewAuto") {
            const skewFactor = ev.shiftKey ? 0.12 : 0.28;
            if (Math.abs(dx) >= Math.abs(dy)) {
              const dir = h === "w" || h === "nw" || h === "sw" ? -1 : 1;
              return { ...o, skewX: clamp(num(drag.startSkewX ?? o.skewX, o.skewX) + (dx * dir * skewFactor), -80, 80) };
            }
            const dir = h === "n" || h === "ne" || h === "nw" ? -1 : 1;
            return { ...o, skewY: clamp(num(drag.startSkewY ?? o.skewY, o.skewY) + (dy * dir * skewFactor), -80, 80) };
          }
          if (kind === "skewX") {
            const skewFactor = ev.shiftKey ? 0.12 : 0.28;
            const dir = h === "w" ? -1 : 1;
            return { ...o, skewX: clamp(num(drag.startSkewX ?? o.skewX, o.skewX) + (dx * dir * skewFactor), -80, 80) };
          }
          const skewFactor = ev.shiftKey ? 0.12 : 0.28;
          const dir = h === "n" ? -1 : 1;
          return { ...o, skewY: clamp(num(drag.startSkewY ?? o.skewY, o.skewY) + (dy * dir * skewFactor), -80, 80) };
        }
        const h = drag.handle ?? "se";
        let x = drag.x, y = drag.y, w = drag.w, hh = drag.h;
        if (h.includes("e")) w = Math.max(MIN, drag.w + dx);
        if (h.includes("s")) hh = Math.max(MIN, drag.h + dy);
        if (h.includes("w")) { const r = drag.x + drag.w; x = drag.x + dx; w = Math.max(MIN, r - x); }
        if (h.includes("n")) { const b = drag.y + drag.h; y = drag.y + dy; hh = Math.max(MIN, b - y); }
        if (x < -1000) { w += (x + 1000); x = -1000; }
        if (y < -1000) { hh += (y + 1000); y = -1000; }
        if (x + w > 3000) w = 3000 - x;
        if (y + hh > 3000) hh = 3000 - y;
        return { ...o, x, y, w, h: hh };
      }));
    };
    const up = () => { setDrag(null); setActiveGuidelineDrag(null); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [drag, activeGuidelineDrag, zoom, objects, selectedIds, guidelines]);

  useEffect(() => {
    if (!boxSelect) return;
    const toPt = (clientX: number, clientY: number) => {
      const r = boardRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
      return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
    };
    const move = (ev: MouseEvent) => {
      setBoxSelect((prev) => (prev ? { ...prev, currentClientX: ev.clientX, currentClientY: ev.clientY } : prev));
    };
    const up = () => {
      setBoxSelect((prev) => {
        if (!prev) return null;
        if (Math.abs(prev.currentClientX - prev.startClientX) < 3 && Math.abs(prev.currentClientY - prev.startClientY) < 3) {
          setSelectedIds([]);
          return null;
        }
        const p1 = toPt(prev.startClientX, prev.startClientY);
        const p2 = toPt(prev.currentClientX, prev.currentClientY);
        const area = { l: Math.min(p1.x, p2.x), t: Math.min(p1.y, p2.y), r: Math.max(p1.x, p2.x), b: Math.max(p1.y, p2.y) };
        const mode = prev.currentClientX >= prev.startClientX ? "touch" : "contain";
        const ids = objects
          .filter((o) => {
            const rect = { l: o.x, t: o.y, r: o.x + o.w, b: o.y + o.h };
            return mode === "touch" ? intersects(area, rect) : contains(area, rect);
          })
          .map((o) => o.id);
        setSelectedIds(ids);
        return null;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [boxSelect, zoom, objects]);

  useEffect(() => {
    const hide = () => setContextMenu(null);
    window.addEventListener("click", hide);
    return () => window.removeEventListener("click", hide);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      if (event.key === "Escape") { setSelectedIds([]); setContextMenu(null); }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedIds.length > 0) { event.preventDefault(); deleteObjects(selectedIds); }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const state = resizingSidebarRef.current;
      if (!state) return;
      const delta = event.clientX - state.startX;
      const centerMin = 340;
      const handlesWidth = 12;
      if (state.side === "left") {
        const next = clamp(state.startWidth + delta, 220, Math.max(220, state.bodyWidth - state.otherWidth - centerMin - handlesWidth));
        setLeftSidebarWidth(next);
      } else {
        const next = clamp(state.startWidth - delta, 220, Math.max(220, state.bodyWidth - state.otherWidth - centerMin - handlesWidth));
        setRightSidebarWidth(next);
      }
    };
    const onUp = () => {
      resizingSidebarRef.current = null;
      window.document.body.style.cursor = "";
      window.document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    const restore = () => { setLeftSidebarWidth(300); setRightSidebarWidth(300); };
    window.addEventListener("saelabel:restore-panels", restore as EventListener);
    return () => window.removeEventListener("saelabel:restore-panels", restore as EventListener);
  }, []);

  const applyXml = (): string | null => {
    if (!parsed) return null;
    const next = parsed.xmlDocument.cloneNode(true) as XMLDocument;
    if (parsed.kind === "sae") {
      next.documentElement.setAttribute("version", metadata.version || "1.0");
      const templateNode = next.documentElement.getElementsByTagName("template")[0];
      if (templateNode) {
        templateNode.setAttribute("brand", metadata.brand || "Custom");
        templateNode.setAttribute("description", metadata.description || "Etiqueta");
        templateNode.setAttribute("part", metadata.part || "P-1");
        templateNode.setAttribute("size", metadata.size || "custom");
      }
      const rectNode = next.documentElement.getElementsByTagName("label_rectangle")[0];
      if (rectNode) {
        rectNode.setAttribute("width_pt", pt(Math.max(1, templateWidthPt)));
        rectNode.setAttribute("height_pt", pt(Math.max(1, templateHeightPt)));
      }
      let node = next.documentElement.getElementsByTagName("objects")[0];
      if (!node) { node = next.createElement("objects"); next.documentElement.appendChild(node); }
      const xmlObjs = Array.from(node.getElementsByTagName("object"));
      for (const o of objects) {
        const ex = o.xmlIndex !== null ? xmlObjs[o.xmlIndex] : undefined;
        if (ex) {
          ex.setAttribute("x_pt", pt(o.x)); ex.setAttribute("y_pt", pt(o.y)); ex.setAttribute("w_pt", pt(o.w)); ex.setAttribute("h_pt", pt(o.h));
          ex.setAttribute("rot_deg", pt(o.rotateDeg));
          ex.setAttribute("scale_x", pt(o.scaleX)); ex.setAttribute("scale_y", pt(o.scaleY)); ex.setAttribute("skew_x", pt(o.skewX)); ex.setAttribute("skew_y", pt(o.skewY));
          if (o.type === "barcode" && o.barcodeKind) ex.setAttribute("style", o.barcodeKind.toLowerCase());
          const c = ex.getElementsByTagName("content")[0] ?? next.createElement("content");
          c.textContent = o.content;
          if (!c.parentElement) ex.appendChild(c);
        } else {
          const e = next.createElement("object");
          e.setAttribute("type", o.type); e.setAttribute("x_pt", pt(o.x)); e.setAttribute("y_pt", pt(o.y)); e.setAttribute("w_pt", pt(o.w)); e.setAttribute("h_pt", pt(o.h));
          e.setAttribute("style", o.type === "barcode" ? (o.barcodeKind?.toLowerCase() || "code128") : "");
          e.setAttribute("color", "0xff"); e.setAttribute("dx_pt", "0"); e.setAttribute("dy_pt", "0"); e.setAttribute("show_text", "false"); e.setAttribute("checksum", "false");
          e.setAttribute("rot_deg", pt(o.rotateDeg));
          e.setAttribute("scale_x", pt(o.scaleX)); e.setAttribute("scale_y", pt(o.scaleY)); e.setAttribute("skew_x", pt(o.skewX)); e.setAttribute("skew_y", pt(o.skewY));
          const c = next.createElement("content"); c.textContent = o.content; e.appendChild(c);
          node.appendChild(e);
        }
      }
    } else {
      next.documentElement.setAttribute("version", metadata.version || "4.0");
      const templateNode = next.documentElement.nodeName === "Template" ? next.documentElement : next.documentElement.getElementsByTagName("Template")[0];
      if (templateNode) {
        templateNode.setAttribute("brand", metadata.brand || "Custom");
        templateNode.setAttribute("description", metadata.description || "Etiqueta");
        templateNode.setAttribute("part", metadata.part || "P-1");
        templateNode.setAttribute("size", metadata.size || "custom");
      }
      const rectNode = templateNode?.getElementsByTagName("Label-rectangle")[0];
      if (rectNode) {
        rectNode.setAttribute("width", `${pt(Math.max(1, templateWidthPt))}pt`);
        rectNode.setAttribute("height", `${pt(Math.max(1, templateHeightPt))}pt`);
      }
      let node = next.documentElement.getElementsByTagName("Objects")[0];
      if (!node) { node = next.createElement("Objects"); next.documentElement.appendChild(node); }
      const xmlObjs = Array.from(node.children).filter((x) => x.nodeName.startsWith("Object-"));
      for (const o of objects) {
        const ex = o.xmlIndex !== null ? (xmlObjs[o.xmlIndex] as Element | undefined) : undefined;
        if (ex) {
          ex.setAttribute("x", `${pt(o.x)}pt`); ex.setAttribute("y", `${pt(o.y)}pt`); ex.setAttribute("w", `${pt(o.w)}pt`); ex.setAttribute("h", `${pt(o.h)}pt`);
          ex.setAttribute("rot_deg", pt(o.rotateDeg));
          ex.setAttribute("scale_x", pt(o.scaleX)); ex.setAttribute("scale_y", pt(o.scaleY)); ex.setAttribute("skew_x", pt(o.skewX)); ex.setAttribute("skew_y", pt(o.skewY));
          if (o.type === "barcode" && o.barcodeKind) ex.setAttribute("style", o.barcodeKind.toLowerCase());
          const m = toAffine(o);
          ex.setAttribute("a0", pt(m.a)); ex.setAttribute("a1", pt(m.b)); ex.setAttribute("a2", pt(m.c)); ex.setAttribute("a3", pt(m.d)); ex.setAttribute("a4", "0"); ex.setAttribute("a5", "0");
        } else {
          const tag = o.type === "text" ? "Object-text" : o.type === "barcode" ? "Object-barcode" : o.type === "box" ? "Object-box" : o.type === "line" ? "Object-line" : o.type === "ellipse" ? "Object-ellipse" : "Object-image";
          const e = next.createElement(tag);
          e.setAttribute("x", `${pt(o.x)}pt`); e.setAttribute("y", `${pt(o.y)}pt`); e.setAttribute("w", `${pt(o.w)}pt`); e.setAttribute("h", `${pt(o.h)}pt`);
          const m = toAffine(o);
          e.setAttribute("a0", pt(m.a)); e.setAttribute("a1", pt(m.b)); e.setAttribute("a2", pt(m.c)); e.setAttribute("a3", pt(m.d)); e.setAttribute("a4", "0"); e.setAttribute("a5", "0");
          e.setAttribute("lock_aspect_ratio", o.type === "image" ? "true" : "false"); e.setAttribute("shadow", "false");
          e.setAttribute("rot_deg", pt(o.rotateDeg));
          e.setAttribute("scale_x", pt(o.scaleX)); e.setAttribute("scale_y", pt(o.scaleY)); e.setAttribute("skew_x", pt(o.skewX)); e.setAttribute("skew_y", pt(o.skewY));
          if (o.type === "text") { e.setAttribute("color", "0xff"); e.setAttribute("font_family", "Sans"); e.setAttribute("font_size", "10"); e.setAttribute("align", "left"); e.setAttribute("valign", "top"); const p = next.createElement("p"); p.textContent = o.content || "${texto}"; e.appendChild(p); }
          if (o.type === "barcode") { e.setAttribute("style", o.barcodeKind?.toLowerCase() || "code128"); e.setAttribute("data", o.content || "${barcode}"); e.setAttribute("text", "true"); e.setAttribute("checksum", "false"); }
          if (o.type === "box" || o.type === "ellipse") { e.setAttribute("fill_color", "0xffffff"); e.setAttribute("line_color", "0xff"); e.setAttribute("line_width", "1pt"); }
          if (o.type === "line") { e.setAttribute("dx", `${pt(o.w)}pt`); e.setAttribute("dy", "0pt"); e.setAttribute("line_color", "0xff"); e.setAttribute("line_width", "1pt"); }
          if (o.type === "image") e.setAttribute("src", o.content ?? "");
          node.appendChild(e);
        }
      }
    }
    const nextXml = new XMLSerializer().serializeToString(next);
    onXmlChange(nextXml);
    return nextXml;
  };

  useEffect(() => {
    const updateOffsets = () => {
      if (!boardRef.current || !viewportRef.current) return;
      const b = boardRef.current.getBoundingClientRect();
      const v = viewportRef.current.getBoundingClientRect();
      // Offset such that pos 0 in ruler is label top-left
      // offsetPt * zoom + ruler_pos = board_pos
      // Since ruler starts at viewport start:
      // offsetPt * zoom + viewport_pos = board_pos
      setRulerOffsets({
        x: (b.left - v.left) / zoom,
        y: (b.top - v.top) / zoom
      });
    };
    updateOffsets();
    const timer = setInterval(updateOffsets, 100); // Poll for scroll/layout changes
    return () => clearInterval(timer);
  }, [zoom, templateWidthPt, templateHeightPt]);

  const startGuideline = (orientation: "horizontal" | "vertical", e: React.MouseEvent) => {
    const id = `g-${crypto.randomUUID()}`;
    const br = boardRef.current?.getBoundingClientRect();
    if (!br) return;
    const isH = orientation === "horizontal";
    const posPt = (isH ? e.clientY - br.top : e.clientX - br.left) / zoom;
    setGuidelines(prev => [...prev, { id, orientation, posPt }]);
    setActiveGuidelineDrag({ id, startPosPt: posPt, hasExitedRuler: false });
  };

  const deleteObjects = (ids: string[]) => {
    setObjects((prev) => prev.filter((o) => !ids.includes(o.id)));
    setSelectedIds([]);
    setContextMenu(null);
  };

  const duplicateObjects = (ids: string[]) => {
    const toCopy = objects.filter((x) => ids.includes(x.id));
    if (toCopy.length === 0) return;
    const copies = toCopy.map((o) => ({ ...o, id: `o-${Date.now()}-${Math.random()}`, x: o.x + 10, y: o.y + 10, xmlIndex: null }));
    setObjects((prev) => [...prev, ...copies]);
    setSelectedIds(copies.map((c) => c.id));
    setContextMenu(null);
  };

  const bringToFront = (id: string) => {
    setObjects((prev) => {
      const idx = prev.findIndex((o) => o.id === id);
      if (idx === -1) return prev;
      const copy = [...prev];
      const [item] = copy.splice(idx, 1);
      copy.push(item);
      return copy;
    });
    setContextMenu(null);
  };

  const sendToBack = (id: string) => {
    setObjects((prev) => {
      const idx = prev.findIndex((o) => o.id === id);
      if (idx === -1) return prev;
      const copy = [...prev];
      const [item] = copy.splice(idx, 1);
      copy.unshift(item);
      return copy;
    });
    setContextMenu(null);
  };

  const handleContextMenu = (e: React.MouseEvent, id: string | null) => {
    e.preventDefault();
    if (id && !selectedIds.includes(id)) setSelectedIds([id]);
    setContextMenu({ x: e.clientX, y: e.clientY, id });
  };

  const groupSelected = () => {
    if (selectedIds.length < 2) return;
    const groupId = `g-${crypto.randomUUID()}`;
    setObjects((prev) => prev.map((o) => (selectedIds.includes(o.id) ? { ...o, groupId } : o)));
    setContextMenu(null);
  };

  const ungroupSelected = () => {
    const ids = new Set(objects.filter((o) => selectedIds.includes(o.id) && o.groupId).map((o) => o.groupId!));
    setObjects((prev) => prev.map((o) => (o.groupId && ids.has(o.groupId) ? { ...o, groupId: undefined } : o)));
    setContextMenu(null);
  };

  const moveLayer = (token: string, dir: "up" | "down" | "top" | "bottom") => {
    setObjects((prev) => {
      const ids = token.startsWith("group:") ? prev.filter((o) => o.groupId === token.slice(6)).map((o) => o.id) : [token];
      if (ids.length === 0) return prev;
      const idx = prev.findIndex((o) => o.id === ids[0]);
      if (idx < 0) return prev;
      const block = prev.filter((o) => ids.includes(o.id));
      const rest = prev.filter((o) => !ids.includes(o.id));
      if (dir === "up") rest.splice(Math.min(rest.length, idx + 1), 0, ...block);
      else if (dir === "down") rest.splice(Math.max(0, idx - 1), 0, ...block);
      else if (dir === "top") rest.push(...block);
      else if (dir === "bottom") rest.unshift(...block);
      return rest;
    });
  };

  const reorderByLayerDrop = (dragToken: string, targetToken: string) => {
    setObjects((prev) => {
      const dIds = dragToken.startsWith("group:") ? prev.filter((o) => o.groupId === dragToken.slice(6)).map((o) => o.id) : [dragToken];
      const tIds = targetToken.startsWith("group:") ? prev.filter((o) => o.groupId === targetToken.slice(6)).map((o) => o.id) : [targetToken];
      if (dIds.some(id => tIds.includes(id))) return prev;
      const block = prev.filter((o) => dIds.includes(o.id));
      const rest = prev.filter((o) => !dIds.includes(o.id));
      const idx = rest.findIndex((o) => o.id === tIds[0]);
      if (idx < 0) return prev;
      rest.splice(idx, 0, ...block);
      return rest;
    });
  };

  const saveElement = async () => {
    if (!sidebarEditMode) { setStatus("Activa Modo Edicion para guardar elementos."); return; }
    if (editingElementId && baseElementIds.includes(editingElementId)) { setStatus("Los elementos base no se pueden editar."); return; }
    if (!elementForm.key.trim() || !elementForm.name.trim()) { setStatus("Key y nombre son requeridos."); return; }
    try {
      await editorApi.saveElement({ ...elementForm, id: editingElementId || undefined, key: elementForm.key.trim(), name: elementForm.name.trim() });
      setEditingElementId("");
      setElementForm({ key: "text", name: "Texto", category: "basic", objectType: "text", defaultWidthPt: 90, defaultHeightPt: 24, defaultContent: "${texto}" });
      setStatus("Elemento guardado.");
      await refresh();
    } catch (e) { setStatus(e instanceof Error ? e.message : "No se pudo guardar elemento."); }
  };

  const editElement = (el: EditorElementDefinition) => {
    if (baseElementIds.includes(el.id)) { setStatus("Los elementos base no se pueden editar."); return; }
    setEditingElementId(el.id);
    setElementForm({ id: el.id, key: el.key, name: el.name, category: el.category, objectType: el.objectType as any, defaultWidthPt: el.defaultWidthPt, defaultHeightPt: el.defaultHeightPt, defaultContent: el.defaultContent });
  };

  const deleteElement = async (id: string) => {
    if (baseElementIds.includes(id)) { setStatus("Los elementos base no se pueden eliminar."); return; }
    try {
      await editorApi.deleteElement(id);
      if (editingElementId === id) setEditingElementId("");
      setStatus("Elemento eliminado.");
      await refresh();
    } catch (e) { setStatus(e instanceof Error ? e.message : "No se pudo eliminar elemento."); }
  };

  const resetDragState = () => { draggedElementRef.current = null; setIsBoardDragOver(false); };

  if (!isMounted) return null;
  if (viewError) return <p className="editorError">{viewError}</p>;
  if (!parsed) return null;

  const sel = objects.find((o) => o.id === selectedIds[0]);
  const hasGroupedSelection = objects.some((o) => selectedIds.includes(o.id) && !!o.groupId);
  const layerNodes: LayerNode[] = (() => {
    const t2b = [...objects].reverse();
    const uG = new Set<string>();
    const nodes: LayerNode[] = [];
    for (const o of t2b) {
      if (o.groupId) { if (uG.has(o.groupId)) continue; uG.add(o.groupId); nodes.push({ kind: "group", groupId: o.groupId, members: t2b.filter((x) => x.groupId === o.groupId) }); }
      else nodes.push({ kind: "item", object: o });
    }
    return nodes;
  })();
  const previewScale = Math.max(0.1, Math.min(240 / Math.max(1, templateWidthPt), 160 / Math.max(1, templateHeightPt)));

  return (
    <section className="editorStudio">
      <header className="studioTopbar">
        <div className="toolbarGroup">
          <div className="toolbarDivider" />
          <div className="zoomControlContainer">
            <span className="controlIcon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/></svg>
            </span>
            <label className="zoomLabel">Zoom
              <input type="range" min={25} max={500} step={5} value={zoomPercent} onChange={(e) => setZoomPercent(Number(e.target.value))} />
            </label>
            <span className="zoomBadge">{zoomPercent}%</span>
          </div>
          <div className="toolbarDivider" />
          <div className="sizeControlsContainer">
            <label className="zoomLabel sizeLabel">
              <span className="sizeAxis">W</span>
              <span className="unitInput">
                <input type="number" title={`Ancho (${templateUnit})`} value={Number(toUnit(templateWidthPt, templateUnit).toFixed(3))} step={unitStep(templateUnit)} onChange={(e) => setTemplateWidthPt(Math.max(1, fromUnit(Number(e.target.value), templateUnit)))} />
                <small>{templateUnit}</small>
              </span>
            </label>
            <label className="zoomLabel sizeLabel">
              <span className="sizeAxis">H</span>
              <span className="unitInput">
                <input type="number" title={`Alto (${templateUnit})`} value={Number(toUnit(templateHeightPt, templateUnit).toFixed(3))} step={unitStep(templateUnit)} onChange={(e) => setTemplateHeightPt(Math.max(1, fromUnit(Number(e.target.value), templateUnit)))} />
                <small>{templateUnit}</small>
              </span>
            </label>
            <select className="unitSelect" value={templateUnit} onChange={(e) => setTemplateUnit(e.target.value as Unit)}>
              {["mm", "cm", "in", "pt"].map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
      </header>

      <div ref={studioBodyRef} className="studioBody" style={{ gridTemplateColumns: `${leftSidebarWidth}px 6px minmax(0, 1fr) 6px ${rightSidebarWidth}px` }}>
        <aside className="leftSidebar">
          <div className="sidebarHeader">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3>Elementos</h3>
              <label className="editModeSwitch"><input type="checkbox" checked={sidebarEditMode} onChange={(e) => setSidebarEditMode(e.target.checked)} /><span className="track"><span className="thumb" /></span><small>Edit</small></label>
            </div>
          </div>
          <div className="sidebarScroll">
            <div className="paletteGrid">
              {(elements.length > 0 ? elements : TYPES.map(t => ({ id: t, key: t, name: cap(t), category: "basic", objectType: t, defaultWidthPt: 40, defaultHeightPt: 20, defaultContent: t === "text" || t === "barcode" ? t : "" }))).map((el) => (
                <div key={el.id} className="paletteCard">
                  <button type="button" className="iconBtn" draggable onDragStart={(e) => { draggedElementRef.current = el as any; e.dataTransfer.setData("application/saelabel-element", JSON.stringify(el)); }} onDragEnd={resetDragState}><span className="ico">{ICON[el.objectType as keyof typeof ICON]}</span><small>{el.name}</small></button>
                  {sidebarEditMode && <div className="paletteActions">{baseElementIds.includes(el.id) ? <span className="baseTag">Base</span> : <><button type="button" className="mini secondary" onClick={() => editElement(el as any)}>Edit</button><button type="button" className="mini secondary" onClick={() => deleteElement(el.id)}>Del</button></>}</div>}
                </div>
              ))}
            </div>
            {sidebarEditMode && (
              <div className="elementForm">
                <h4>{editingElementId ? "Editar" : "Nuevo"}</h4>
                <input value={elementForm.name} placeholder="Nombre" onChange={(e) => setElementForm(p => ({ ...p, name: e.target.value }))} />
                <input value={elementForm.key} placeholder="Key" onChange={(e) => setElementForm(p => ({ ...p, key: e.target.value }))} />
                <div className="sizeRow"><input type="number" value={elementForm.defaultWidthPt} onChange={(e) => setElementForm(p => ({ ...p, defaultWidthPt: Number(e.target.value) || 1 }))} /><input type="number" value={elementForm.defaultHeightPt} onChange={(e) => setElementForm(p => ({ ...p, defaultHeightPt: Number(e.target.value) || 1 }))} /></div>
                <button type="button" className="mini" onClick={saveElement}>Guardar</button>
              </div>
            )}
            <div className="editHint">
              <strong>Tip:</strong> Arrastra los elementos al lienzo para agregarlos. Doble clic en un elemento para activar rotacion y sesgado.
            </div>
          </div>
        </aside>
        <div className="sidebarResizer left" onMouseDown={(e) => { resizingSidebarRef.current = { side: "left", startX: e.clientX, startWidth: leftSidebarWidth, otherWidth: rightSidebarWidth, bodyWidth: studioBodyRef.current?.getBoundingClientRect().width ?? 0 }; }} />
        <main className="canvasArea">
          <div className="canvasLayout">
            <div className="rulerCorner" />
            <Ruler orientation="horizontal" lengthPt={templateWidthPt} zoom={zoom} unit={templateUnit} offsetPt={rulerOffsets.x} onStartGuideline={(e) => startGuideline("horizontal", e)} guidelines={guidelines} />
            <Ruler orientation="vertical" lengthPt={templateHeightPt} zoom={zoom} unit={templateUnit} offsetPt={rulerOffsets.y} onStartGuideline={(e) => startGuideline("vertical", e)} guidelines={guidelines} />
            <div ref={viewportRef} className="canvasViewport" onMouseDown={(e) => { if (e.target === e.currentTarget) { setContextMenu(null); setBoxSelect({ startClientX: e.clientX, startClientY: e.clientY, currentClientX: e.clientX, currentClientY: e.clientY }); } }} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={(e) => { e.preventDefault(); resetDragState(); }}>
              {guidelines.map(g => (
                <div key={g.id} className={`guideline ${g.orientation}`} style={{ [g.orientation === "horizontal" ? "top" : "left"]: (g.posPt + (g.orientation === "horizontal" ? rulerOffsets.y : rulerOffsets.x)) * zoom + 24 }} onMouseDown={(e) => { e.stopPropagation(); setActiveGuidelineDrag({ id: g.id, startPosPt: g.posPt }); }} />
              ))}
              {boxSelect && viewportRef.current && (
                <div className={`selectionRect ${boxSelect.currentClientX >= boxSelect.startClientX ? "touch" : "contain"}`} style={{ left: Math.min(boxSelect.startClientX, boxSelect.currentClientX) - viewportRef.current.getBoundingClientRect().left, top: Math.min(boxSelect.startClientY, boxSelect.currentClientY) - viewportRef.current.getBoundingClientRect().top, width: Math.abs(boxSelect.currentClientX - boxSelect.startClientX), height: Math.abs(boxSelect.currentClientY - boxSelect.startClientY) }} />
              )}
              <div ref={boardRef} className={`canvasBoard ${isBoardDragOver ? "dragOver" : ""} ${activeTransformKind ? `transform-${activeTransformKind}` : ""}`} style={{ width: templateWidthPt * zoom, height: templateHeightPt * zoom }} onMouseDown={(e) => { if (e.target === e.currentTarget) { setContextMenu(null); setBoxSelect({ startClientX: e.clientX, startClientY: e.clientY, currentClientX: e.clientX, currentClientY: e.clientY }); } }} onDragOver={(e) => { e.preventDefault(); setIsBoardDragOver(true); }} onDragLeave={() => setIsBoardDragOver(false)} onDrop={(e) => { e.preventDefault(); setIsBoardDragOver(false); const raw = e.dataTransfer.getData("application/saelabel-element"); const el = raw ? JSON.parse(raw) : draggedElementRef.current; if (!el || !boardRef.current) return; const br = boardRef.current.getBoundingClientRect(); const x = (e.clientX - br.left) / zoom; const y = (e.clientY - br.top) / zoom; setObjects(p => [...p, { id: `new-${crypto.randomUUID()}`, xmlIndex: null, type: el.objectType, x, y, w: el.defaultWidthPt, h: el.defaultHeightPt, content: el.defaultContent || "", rotateDeg: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 }]); }}>
                {objects.map((o) => (
                  <button key={o.id} type="button" className={`canvasObject ${o.type} ${selectedIds.includes(o.id) ? "selected" : ""}`} style={{ left: o.x * zoom, top: o.y * zoom, width: o.w * zoom, height: o.h * zoom, transform: `rotate(${o.rotateDeg}deg) skew(${o.skewX}deg, ${o.skewY}deg) scale(${o.scaleX}, ${o.scaleY})` }} onMouseDown={(e) => { e.stopPropagation(); const ids = objects.find(x => x.id === o.id)?.groupId ? objects.filter(x => x.groupId === objects.find(x => x.id === o.id)?.groupId).map(x => x.id) : selectedIds.includes(o.id) ? selectedIds : [o.id]; setDrag({ mode: "move", id: o.id, startX: e.clientX, startY: e.clientY, x: o.x, y: o.y, w: o.w, h: o.h, originMap: ids.reduce((a, id) => { const f = objects.find(x => x.id === id); if (f) a[id] = { x: f.x, y: f.y }; return a; }, {} as any) }); }} onContextMenu={(e) => handleContextMenu(e, o.id)} onClick={(e) => { e.stopPropagation(); if (e.ctrlKey) setSelectedIds(p => p.includes(o.id) ? p.filter(id => id !== o.id) : [...p, o.id]); else setSelectedIds([o.id]); }} onDoubleClick={() => setTransformModeIds(p => p.includes(o.id) ? p.filter(x => x !== o.id) : [...p, o.id])}>
                    <span>{o.type}</span>
                    {o.type === "image" ? (
                      o.content ? <img src={o.content} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }} /> : <div className="imgPlaceholder">Imagen</div>
                    ) : o.type === "barcode" ? (
                      <div className="barcodeViz" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                        <BarcodeImage 
                          value={o.content || "123456"} 
                          kind={o.barcodeKind} 
                          width={o.w} 
                          height={o.h} 
                          zoom={zoom} 
                          onResize={(w, h) => {
                            if (Math.abs(o.w - w) > 0.5 || Math.abs(o.h - h) > 0.5) {
                              setObjects(p => p.map(x => x.id === o.id ? { ...x, w, h } : x));
                            }
                          }}
                        />
                        <span className="kindBadge" style={{ position: "absolute", bottom: "-12px", fontSize: "8px", background: "transparent", padding: "1px 4px", borderRadius: "4px", color: "rgba(0,0,0,0.5)" }}>{o.barcodeKind || "CODE128"}</span>
                      </div>
                    ) : o.type === "line" ? (
                      <div className="lineViz" style={{ width: "100%", height: "100%", background: "currentColor" }} />
                    ) : (
                      <small>{o.content}</small>
                    )}
                    {selectedIds.includes(o.id) && HANDLES.map(h => (
                      <span key={h} className={`resizeHandle ${h} ${transformModeIds.includes(o.id) ? "transform" : ""} ${h.length === 2 ? "rotateMode" : "skewMode"}`} onMouseDown={(e) => { e.stopPropagation(); const br = boardRef.current?.getBoundingClientRect(); const cx = (br?.left ?? 0) + (o.x + o.w / 2) * zoom; const cy = (br?.top ?? 0) + (o.y + o.h / 2) * zoom; setDrag({ mode: transformModeIds.includes(o.id) ? "transform" : "resize", id: o.id, handle: h, startX: e.clientX, startY: e.clientY, x: o.x, y: o.y, w: o.w, h: o.h, startRotateDeg: o.rotateDeg, startSkewX: o.skewX, startSkewY: o.skewY, centerClientX: cx, centerClientY: cy, startAngleRad: Math.atan2(e.clientY - cy, e.clientX - cx) }); }} />
                    ))}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </main>
        <div className="sidebarResizer right" onMouseDown={(e) => { resizingSidebarRef.current = { side: "right", startX: e.clientX, startWidth: rightSidebarWidth, otherWidth: leftSidebarWidth, bodyWidth: studioBodyRef.current?.getBoundingClientRect().width ?? 0 }; }} />
        <aside className="rightSidebar">
          <div className="sidebarTabs">
            <button type="button" className={`sidebarTab ${activeRightTab === "layers" ? "active" : ""}`} onClick={() => setActiveRightTab("layers")}>Capas</button>
            <button type="button" className={`sidebarTab ${activeRightTab === "properties" ? "active" : ""}`} onClick={() => setActiveRightTab("properties")}>Propiedades</button>
            <button type="button" className={`sidebarTab ${activeRightTab === "preview" ? "active" : ""}`} onClick={() => setActiveRightTab("preview")}>Vista Previa</button>
          </div>
          <div className="sidebarScroll">
            {activeRightTab === "layers" && (
              <div className="layersPanel">
                {layerNodes.map(node => node.kind === "group" ? (
                  <div key={node.groupId} className="layerGroupWrap">
                    <div className="layerItem layerGroup" draggable onDragStart={() => setDragLayerId(`group:${node.groupId}`)} onDrop={(e) => { e.preventDefault(); if (dragLayerId) reorderByLayerDrop(dragLayerId, `group:${node.groupId}`); setDragLayerId(null); }} onClick={() => setSelectedIds(node.members.map(m => m.id))}><span>Grupo ({node.members.length})</span></div>
                    {node.members.map(m => <div key={m.id} className="layerItem layerChild" onClick={() => setSelectedIds([m.id])}><span>{m.type}</span></div>)}
                  </div>
                ) : (
                  <div key={node.object.id} className="layerItem" draggable onDragStart={() => setDragLayerId(node.object.id)} onDrop={(e) => { e.preventDefault(); if (dragLayerId) reorderByLayerDrop(dragLayerId, node.object.id); setDragLayerId(null); }} onClick={() => setSelectedIds([node.object.id])}><span>{node.object.type}</span></div>
                ))}
              </div>
            )}
            {activeRightTab === "properties" && sel && (
              <div className="inspectorPanel">
                <div className="inspectorFields">
                  <label>X<input type="number" value={sel.x} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, x: Number(e.target.value) } : x))} /></label>
                  <label>Y<input type="number" value={sel.y} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, y: Number(e.target.value) } : x))} /></label>
                  <label>Ancho<input type="number" value={sel.w} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, w: Number(e.target.value) } : x))} /></label>
                  <label>Alto<input type="number" value={sel.h} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, h: Number(e.target.value) } : x))} /></label>
                  <label>Rotación (°)<input type="number" value={sel.rotateDeg} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, rotateDeg: Number(e.target.value) } : x))} /></label>
                  <label>Escala X<input type="number" step="0.1" value={sel.scaleX} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, scaleX: Number(e.target.value) } : x))} /></label>
                  <label>Escala Y<input type="number" step="0.1" value={sel.scaleY} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, scaleY: Number(e.target.value) } : x))} /></label>
                  <label>Sesgado X (°)<input type="number" value={sel.skewX} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, skewX: Number(e.target.value) } : x))} /></label>
                  <label>Sesgado Y (°)<input type="number" value={sel.skewY} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, skewY: Number(e.target.value) } : x))} /></label>
                  {sel.type === "barcode" && (
                    <label className="full">Tipo Barcode
                      <select value={sel.barcodeKind || "CODE128"} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, barcodeKind: e.target.value } : x))}>
                        {["CODE128", "EAN13", "QR", "UPC", "CODE39"].map(k => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </label>
                  )}
                  {sel.type === "image" && (
                    <div className="full imgUploadRow">
                      <button type="button" className="mini" onClick={() => { const input = document.createElement("input"); input.type = "file"; input.accept = "image/*"; input.onchange = (e) => { const file = (e.target as HTMLInputElement).files?.[0]; if (file) { const reader = new FileReader(); reader.onload = (loadEv) => { setObjects(p => p.map(x => x.id === sel.id ? { ...x, content: loadEv.target?.result as string } : x)); }; reader.readAsDataURL(file); } }; input.click(); }}>Cargar Imagen</button>
                    </div>
                  )}
                  <label className="full">Contenido<input value={sel.content} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, content: e.target.value } : x))} /></label>
                </div>
              </div>
            )}
            {activeRightTab === "preview" && (
              <div className="previewPanel">
                <div className="previewViewport">
                  <div className="previewLabel" style={{ width: templateWidthPt * previewScale, height: templateHeightPt * previewScale }}>
                    {objects.map(o => (
                      <div key={o.id} className={`previewObject ${o.type}`} style={{ left: o.x * previewScale, top: o.y * previewScale, width: o.w * previewScale, height: o.h * previewScale, transform: `rotate(${o.rotateDeg}deg) scale(${o.scaleX}, ${o.scaleY})` }}>
                        {o.type === "barcode" && <BarcodeImage value={o.content || "123456"} kind={o.barcodeKind} width={o.w} height={o.h} zoom={previewScale} />}
                        {o.type === "image" && o.content && <img src={o.content} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
                        {o.type === "line" && <div className="lineViz" style={{ width: "100%", height: "100%", background: "currentColor" }} />}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {status && <p className="status">{status}</p>}
          </div>
        </aside>
      </div>
      {contextMenu && (
        <div className="contextMenu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.id ? (
            <>
              <div className="menuItem" onClick={() => moveLayer(contextMenu.id!, "up")}>Subir capa</div>
              <div className="menuItem" onClick={() => moveLayer(contextMenu.id!, "down")}>Bajar capa</div>
              <div className="menuItem" onClick={() => bringToFront(contextMenu.id!)}>Traer al frente</div>
              <div className="menuItem" onClick={() => sendToBack(contextMenu.id!)}>Enviar al fondo</div>
              <div className="menuLine" />
              <div className="menuItem" onClick={() => duplicateObjects(selectedIds)}>Duplicar</div>
              <div className="menuItem" onClick={() => groupSelected()}>Agrupar</div>
              <div className="menuItem" onClick={() => ungroupSelected()}>Desagrupar</div>
              <div className="menuLine" />
              <div className="menuItem danger" onClick={() => deleteObjects(selectedIds)}>Eliminar</div>
            </>
          ) : (
            <div className="menuItem" onClick={() => setSelectedIds([])}>Limpiar seleccion</div>
          )}
        </div>
      )}
    </section>
  );
}
