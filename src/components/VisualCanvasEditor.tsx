import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';

import type { EditorElementDefinition, UpsertEditorElementPayload, LogicalPrinterDto } from "@/lib/api/client";
import { createEditorApi, createLabelsApi } from "@/lib/api/client";
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";
import LogicalPrintersManagerModal from "./LogicalPrintersManagerModal";

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

type VariableDef = {
  name: string;
  type?: string;
  initial?: string;
  increment?: string;
  step?: number;
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
  fillColor?: string;
  lineColor?: string;
  lineWidth?: number;
  showText?: boolean;
  textPosition?: "top" | "bottom";
  fontFamily?: string;
  fontSize?: number;
};
type Parsed = {
  kind: Kind;
  widthPt: number;
  heightPt: number;
  objects: Obj[];
  variables?: VariableDef[];
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
const TYPES = ["text", "barcode", "box", "line", "ellipse", "image", "path"] as const;
const BASE_ELEMENT_KEYS = new Set(["text", "barcode", "box", "line", "ellipse", "image", "path"]);
const ICON: Record<(typeof TYPES)[number], any> = {
  text: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  ),
  barcode: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5v14M8 5v14M12 5v14M17 5v14M21 5v14" />
    </svg>
  ),
  box: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    </svg>
  ),
  line: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  ellipse: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
    </svg>
  ),
  image: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  path: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L15 8L22 9L17 14L18 21L12 18L6 21L7 14L2 9L9 8L12 2Z" />
    </svg>
  ),
};

const PREDEFINED_SHAPES = [
  { name: "Estrella", path: "M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" },
  { name: "Triángulo", path: "M12 2L22 21H2L12 2Z" },
  { name: "Flecha Der", path: "M12 2L22 12L12 22V17H2V7H12V2Z" },
  { name: "Flecha Izq", path: "M12 2L2 12L12 22V17H22V7H12V2Z" },
  { name: "Corazón", path: "M12 21.35L10.55 20.03C5.4 15.36 2 12.27 2 8.5C2 5.41 4.41 3 7.5 3C9.24 3 10.91 3.81 12 5.08C13.09 3.81 14.76 3 16.5 3C19.59 3 22 5.41 22 8.5C22 12.27 18.6 15.36 13.45 20.03L12 21.35Z" },
  { name: "Hexágono", path: "M12 2L21 7V17L12 22L3 17V7L12 2Z" },
  { name: "Rayo", path: "M13 2L3 14H12L11 22L21 10H12L13 2Z" },
  { name: "Check", path: "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3" }
];

const GROUP_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2L19 7V17L12 22L5 17V7L12 2Z" />
    <polyline points="12 22 12 12 19 7" />
    <line x1="12" y1="12" x2="5" y2="7" />
  </svg>
);

const replaceVars = (text: string, variables: VariableDef[]) => {
  if (!text) return text;
  let res = text;
  for (const v of variables) {
    const val = v.initial || (v.increment && v.increment !== "never" ? "1" : "0");
    res = res.replaceAll(`\${${v.name}}`, val);
  }
  return res;
};

const BarcodeImage = ({ value, kind, width, height, zoom, onResize, showText, textPosition, variables = [] }: { value: string; kind?: string; width: number; height: number; zoom: number; onResize?: (w: number, h: number) => void; showText?: boolean; textPosition?: string; variables?: VariableDef[] }) => {
  const [imgData, setImgData] = useState<string>("");
  
  useEffect(() => {
    if (!value) return;
    const format = (kind || "CODE128").toUpperCase();
    const displayValue = replaceVars(value, variables);
    
    if (format === "QR") {
      QRCode.toDataURL(displayValue, {
        margin: 0,
        width: Math.round(Math.min(width, height) * zoom * 2),
        color: { dark: "#000000", light: "#ffffff00" }
      }).then(url => {
        setImgData(url);
        if (onResize) onResize(width, height);
      })
        .catch(err => console.error("QR render error:", err));
    } else {
      const canvas = document.createElement("canvas");
      try {
        JsBarcode(canvas, displayValue, {
          format,
          width: Math.max(1, Math.round(2 * zoom)),
          height: Math.max(10, Math.round(height * zoom)),
          displayValue: showText !== false,
          textPosition: textPosition || "bottom",
          margin: 0,
          background: "transparent",
          lineColor: "#000",
        });
        setImgData(canvas.toDataURL());
        
        if (onResize) {
          const actualWidthPt = canvas.width / (zoom * 2);
          onResize(actualWidthPt, height);
        }
      } catch (e) {
        console.warn("Barcode render error:", e);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          canvas.width = Math.max(100, width * zoom * 2);
          canvas.height = Math.max(20, height * zoom);
          ctx.fillStyle = "red";
          ctx.font = `${Math.round(10 * zoom)}px sans-serif`;
          ctx.fillText(`Error: ${displayValue}`, 5, 15);
          setImgData(canvas.toDataURL());
        }
      }
    }
  }, [value, kind, zoom, height, width, showText, textPosition, variables]);

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

const toHexColor = (v: string | null | undefined): string | undefined => {
  if (!v) return undefined;
  if (v.startsWith("#")) return v;
  if (v.startsWith("0x")) {
    const hex = v.substring(2);
    if (hex.length === 1 || hex.length === 2) return "#000000"; // Assume 0xff is black
    if (hex.length === 6) return `#${hex}`;
    return "#000000";
  }
  if (v === "none" || v === "transparent") return undefined;
  return v;
};

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
      barcodeKind: e.getAttribute("style")?.toUpperCase() ?? undefined,
      fillColor: toHexColor(e.getAttribute("fill_color") ?? e.getAttribute("color")),
      lineColor: toHexColor(e.getAttribute("line_color")),
      lineWidth: n(e.getAttribute("line_width"), 1),
      groupId: e.getAttribute("group_id") ?? undefined,
      showText: e.getAttribute("show_text") === "true",
      textPosition: (e.getAttribute("text_pos") as any) || "bottom",
    }));
    const variablesNode = d.documentElement.getElementsByTagName("variables")[0];
    const variables: VariableDef[] = [];
    if (variablesNode) {
      const vars = Array.from(variablesNode.getElementsByTagName("variable"));
      for (const v of vars) {
        variables.push({
          name: v.getAttribute("name") || "VAR",
          type: v.getAttribute("type") || "text",
          initial: v.getAttribute("initial") || "",
          increment: v.getAttribute("increment") || "never",
          step: Number(v.getAttribute("step")) || undefined,
        });
      }
    }
    
    return {
      kind: "sae",
      widthPt: n(rect?.getAttribute("width_pt"), 200),
      heightPt: n(rect?.getAttribute("height_pt"), 100),
      objects,
      variables,
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
      barcodeKind: e.getAttribute("style")?.toUpperCase() ?? undefined,
      fillColor: toHexColor(e.getAttribute("fill_color") ?? e.getAttribute("color")),
      lineColor: toHexColor(e.getAttribute("line_color")),
      lineWidth: n(e.getAttribute("line_width"), 1),
      groupId: e.getAttribute("group_id") ?? undefined,
      showText: e.getAttribute("text") === "true",
      textPosition: (e.getAttribute("text_pos") as any) || "bottom",
      fontFamily: e.getAttribute("font_family") || undefined,
      fontSize: e.getAttribute("font_size") ? n(e.getAttribute("font_size"), 10) : undefined,
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

  // ── Undo / Redo history ───────────────────────────────────────────────────
  const historyRef = useRef<Obj[][]>([]);
  const historyIdxRef = useRef<number>(-1);
  const isUndoingRef = useRef<boolean>(false);

  const pushHistory = useCallback((snapshot: Obj[]) => {
    if (isUndoingRef.current) return;
    const h = historyRef.current;
    // Truncate any redo states beyond current index
    h.splice(historyIdxRef.current + 1);
    h.push(snapshot.map(o => ({ ...o })));
    if (h.length > 60) h.shift();
    historyIdxRef.current = h.length - 1;
  }, []);
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
  const lastSentXmlRef = useRef<string>("");
  const [editingElementId, setEditingElementId] = useState("");
  const [showElementModal, setShowElementModal] = useState(false);
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
  const [activeRightTab, setActiveRightTab] = useState<"layers" | "properties" | "preview" | "variables">("properties");
  const [variables, setVariables] = useState<VariableDef[]>([]);
  const [newVarName, setNewVarName] = useState("");
  const [isPanning, setIsPanning] = useState(false);
  const [panState, setPanState] = useState<{ startX: number; startY: number; startScrollLeft: number; startScrollTop: number } | null>(null);
  
  // Printing state
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [printForm, setPrintForm] = useState({ printerName: "", copies: 1, isPrinting: false });
  const [showPrintersManagerModal, setShowPrintersManagerModal] = useState(false);
  const [availableLogicalPrinters, setAvailableLogicalPrinters] = useState<LogicalPrinterDto[]>([]);

  // Imprimir variables
  const [printTab, setPrintTab] = useState<"manual"|"excel">("manual");
  const [manualVars, setManualVars] = useState<Record<string, string>>({});
  const [excelData, setExcelData] = useState<Record<string, any>[]>([]);
  const [excelCols, setExcelCols] = useState<string[]>([]);
  const [excelMapping, setExcelMapping] = useState<Record<string, string>>({});
  
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
  const labelsApi = useMemo(() => createLabelsApi(apiBaseUrl, { timeoutMs }), [apiBaseUrl, timeoutMs]);
  
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
  const handleShowPrintModal = async () => {
    setShowPrintModal(true);
    try {
      const logPrinters = await labelsApi.getLogicalPrinters();
      setAvailableLogicalPrinters(logPrinters.filter(p => p.isActive));
      if (printForm.printerName === "" && logPrinters.some(p => p.isActive)) {
        setPrintForm(p => ({ ...p, printerName: logPrinters.filter(x => x.isActive)[0].name }));
      }
    } catch (e) {
      console.error("Error loading logical printers:", e);
    }
  };

  const executePrint = async () => {
    if (!printForm.printerName.trim()) {
      setStatus("Error: Debe especificar el nombre de la impresora.");
      return;
    }
    setPrintForm(p => ({ ...p, isPrinting: true }));
    try {
      applyXml(); // Ensure current state is serialized
      const payload: any = {
        xml,
        printerName: printForm.printerName.trim(),
        copies: printForm.copies,
      };

      if (variables.length > 0) {
        if (printTab === "manual") {
          payload.data = manualVars;
        } else if (printTab === "excel") {
           if (excelData.length === 0) {
              setStatus("Error: No hay datos de excel cargados.");
              setPrintForm(p => ({ ...p, isPrinting: false }));
              return;
           }
           payload.dataList = excelData.map(row => {
               const dict: Record<string, string> = {};
               for (const v of variables) {
                   const colName = excelMapping[v.name];
                   if (colName && row[colName] !== undefined && row[colName] !== null) {
                       dict[v.name] = String(row[colName]);
                   } else {
                       dict[v.name] = "";
                   }
               }
               return dict;
           });
        }
      }

      const res = await labelsApi.print(payload);
      setStatus(`Impresión enviada a ${res.printer} exitosamente.`);
      setShowPrintModal(false);
    } catch (e: any) {
      console.error(e);
      setStatus(`Error al imprimir: ${e.message || "Fallo de conexión"}`);
    } finally {
      setPrintForm(p => ({ ...p, isPrinting: false }));
    }
  };

  useEffect(() => {
    if (!parsed) return;
    // Don't re-apply if this is exactly what we just sent out
    if (xml === lastSentXmlRef.current) return;
    
    setObjects(parsed.objects);
    setVariables(parsed.variables || []);
    setTemplateWidthPt(parsed.widthPt);
    setTemplateHeightPt(parsed.heightPt);
    setError("");
  }, [parsed, xml]);

  useEffect(() => {
    setTransformModeIds([]);
  }, [selectedIds]);

  useEffect(() => {
    const timer = setTimeout(() => {
      applyXml();
    }, 500);
    return () => clearTimeout(timer);
  }, [objects, variables, templateWidthPt, templateHeightPt, metadata]);

  useEffect(() => {
    const run = async () => {
      try { await refresh(); } catch (e) {
        // Ignorar para evitar mostrar mensajes de error tipo Failed to Fetch
      }
    };
    void run();
  }, [editorApi]);

  useEffect(() => {
    if (status) {
      const timer = setTimeout(() => setStatus(""), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  // Push history snapshot when drag starts (captures pre-drag state for undo)
  const prevDragRef = useRef<DragState | null>(null);
  useEffect(() => {
    if (drag !== null && prevDragRef.current === null) {
      // Drag just started — snapshot current objects
      pushHistory(objects);
    }
    prevDragRef.current = drag;
  }, [drag]);

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
      if (panState) {
        if (!viewportRef.current) return;
        const dx = ev.clientX - panState.startX;
        const dy = ev.clientY - panState.startY;
        viewportRef.current.scrollLeft = panState.startScrollLeft - dx;
        viewportRef.current.scrollTop = panState.startScrollTop - dy;
        return;
      }
      setBoxSelect((prev) => (prev ? { ...prev, currentClientX: ev.clientX, currentClientY: ev.clientY } : prev));
    };
    const up = () => {
      if (panState) {
        setIsPanning(false);
        setPanState(null);
        return;
      }
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
  }, [boxSelect, zoom, objects, panState]);

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
      // Undo: Ctrl+Z
      if ((event.ctrlKey || event.metaKey) && event.key === "z" && !event.shiftKey) {
        event.preventDefault();
        const h = historyRef.current;
        if (historyIdxRef.current > 0) {
          historyIdxRef.current--;
          isUndoingRef.current = true;
          setObjects(h[historyIdxRef.current].map(o => ({ ...o })));
          isUndoingRef.current = false;
          setStatus(`Deshacer (${historyIdxRef.current + 1}/${h.length})`);
        }
      }
      // Redo: Ctrl+Y or Ctrl+Shift+Z
      if ((event.ctrlKey || event.metaKey) && (event.key === "y" || (event.key === "z" && event.shiftKey))) {
        event.preventDefault();
        const h = historyRef.current;
        if (historyIdxRef.current < h.length - 1) {
          historyIdxRef.current++;
          isUndoingRef.current = true;
          setObjects(h[historyIdxRef.current].map(o => ({ ...o })));
          isUndoingRef.current = false;
          setStatus(`Rehacer (${historyIdxRef.current + 1}/${h.length})`);
        }
      }
      
      // Print: Ctrl+P
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        handleShowPrintModal();
      }
      
      // Save: Ctrl+S
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        applyXml();
        setStatus("Cambios guardados manual/visualmente (Ctrl+S).");
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
    const handleWheel = (e: WheelEvent) => {
      if (viewportRef.current && viewportRef.current.contains(e.target as Node)) {
        if (e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          const delta = e.deltaY > 0 ? -15 : 15;
          setZoomPercent(p => Math.max(25, Math.min(500, p + delta)));
        }
      }
    };
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
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
      // Clear existing objects in the clone to handle deletions
      while (node.firstChild) { node.removeChild(node.firstChild); }
      
      const replaceVars = (text: string) => {
        let res = text;
        for (const v of variables) {
          const val = v.initial || (v.increment && v.increment !== "never" ? "1" : "");
          res = res.replace(new RegExp(`\\$\\{${v.name}\\}`, 'g'), val);
        }
        return res;
      };

      for (const o of objects) {
        const e = next.createElement("object");
        e.setAttribute("type", o.type); 
        e.setAttribute("x_pt", pt(o.x)); 
        e.setAttribute("y_pt", pt(o.y)); 
        e.setAttribute("w_pt", pt(o.w)); 
        e.setAttribute("h_pt", pt(o.h));
        
        const style = o.type === "barcode" ? (o.barcodeKind?.toLowerCase() || "code128") : "";
        e.setAttribute("style", style);
        
        // Fix for lines: use width/height as dx/dy
        if (o.type === "line") {
          e.setAttribute("dx_pt", pt(o.w));
          e.setAttribute("dy_pt", pt(o.h));
        } else {
          e.setAttribute("dx_pt", "0");
          e.setAttribute("dy_pt", "0");
        }

        e.setAttribute("color", o.lineColor || "#000000"); 
        e.setAttribute("show_text", o.showText ? "true" : "false");
        e.setAttribute("text_pos", o.textPosition || "bottom");
        e.setAttribute("checksum", "false");
        e.setAttribute("rot_deg", pt(o.rotateDeg));
        e.setAttribute("scale_x", pt(o.scaleX)); 
        e.setAttribute("scale_y", pt(o.scaleY)); 
        e.setAttribute("skew_x", pt(o.skewX)); 
        e.setAttribute("skew_y", pt(o.skewY));
        
        if (o.fillColor) e.setAttribute("color", o.fillColor);
        if (o.lineColor) e.setAttribute("line_color", o.lineColor);
        if (o.lineWidth) e.setAttribute("line_width", pt(o.lineWidth));
        if (o.groupId) e.setAttribute("group_id", o.groupId);
        
        const c = next.createElement("content"); 
        c.textContent = o.content; 
        e.appendChild(c);
        node.appendChild(e);
      }

      // Handle variables node
      let varsNode = next.documentElement.getElementsByTagName("variables")[0];
      if (!varsNode) {
        varsNode = next.createElement("variables");
        next.documentElement.appendChild(varsNode);
      }
      while (varsNode.firstChild) { varsNode.removeChild(varsNode.firstChild); }
      for (const v of variables) {
        const ve = next.createElement("variable");
        ve.setAttribute("name", v.name);
        if (v.type) ve.setAttribute("type", v.type);
        if (v.initial) ve.setAttribute("initial", v.initial);
        if (v.increment) ve.setAttribute("increment", v.increment);
        if (v.step !== undefined) ve.setAttribute("step", String(v.step));
        varsNode.appendChild(ve);
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
      // Clear existing objects in the clone to handle deletions
      while (node.firstChild) { node.removeChild(node.firstChild); }

      for (const o of objects) {
        const tag = o.type === "text" ? "Object-text" : o.type === "barcode" ? "Object-barcode" : o.type === "box" ? "Object-box" : o.type === "line" ? "Object-line" : o.type === "ellipse" ? "Object-ellipse" : o.type === "path" ? "Object-path" : "Object-image";
        const e = next.createElement(tag);
        e.setAttribute("x", `${pt(o.x)}pt`); e.setAttribute("y", `${pt(o.y)}pt`); e.setAttribute("w", `${pt(o.w)}pt`); e.setAttribute("h", `${pt(o.h)}pt`);
        const m = toAffine(o);
        e.setAttribute("a0", pt(m.a)); e.setAttribute("a1", pt(m.b)); e.setAttribute("a2", pt(m.c)); e.setAttribute("a3", pt(m.d)); e.setAttribute("a4", "0"); e.setAttribute("a5", "0");
        e.setAttribute("lock_aspect_ratio", o.type === "image" ? "true" : "false"); e.setAttribute("shadow", "false");
        e.setAttribute("rot_deg", pt(o.rotateDeg));
        e.setAttribute("scale_x", pt(o.scaleX)); e.setAttribute("scale_y", pt(o.scaleY)); e.setAttribute("skew_x", pt(o.skewX)); e.setAttribute("skew_y", pt(o.skewY));
        e.setAttribute("fill_color", o.fillColor || "none");
        e.setAttribute("line_color", o.lineColor || "none");
        if (o.lineWidth) e.setAttribute("line_width", pt(o.lineWidth));
        if (o.groupId) e.setAttribute("group_id", o.groupId);
        if (o.type === "text") { 
          e.setAttribute("color", o.fillColor || "#000000"); 
          e.setAttribute("font_family", o.fontFamily || "Sans"); 
          e.setAttribute("font_size", String(o.fontSize ?? 10)); 
          e.setAttribute("align", "left"); 
          e.setAttribute("valign", "top"); 
          const p = next.createElement("p"); 
          p.textContent = o.content || "${texto}"; 
          e.appendChild(p); 
        }
        if (o.type === "barcode") { 
          e.setAttribute("style", o.barcodeKind?.toLowerCase() || "code128"); 
          e.setAttribute("data", o.content || "${barcode}"); 
          e.setAttribute("text", o.showText ? "true" : "false"); 
          e.setAttribute("text_pos", o.textPosition || "bottom");
          e.setAttribute("checksum", "false"); 
        }
        if (o.type === "box" || o.type === "ellipse") { 
          // Defaults are handled above by the generic attributes if missing
          if (!o.lineWidth) e.setAttribute("line_width", "1pt"); 
        }
        if (o.type === "line") { 
          e.setAttribute("dx", `${pt(o.w)}pt`); 
          e.setAttribute("dy", "0pt"); 
          if (!o.lineWidth) e.setAttribute("line_width", "1pt"); 
        }
        if (o.type === "image") e.setAttribute("src", o.content ?? "");
        if (o.type === "path") e.setAttribute("data", o.content ?? "");
        node.appendChild(e);
      }
    }
    const nextXml = new XMLSerializer().serializeToString(next);
    lastSentXmlRef.current = nextXml;
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
    pushHistory(objects);
    setObjects((prev) => prev.filter((o) => !ids.includes(o.id)));
    setSelectedIds([]);
    setContextMenu(null);
  };

  const duplicateObjects = (ids: string[]) => {
    const toCopy = objects.filter((x) => ids.includes(x.id));
    if (toCopy.length === 0) return;
    pushHistory(objects);
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
    if (id && id !== "canvas") {
      if (id.startsWith("group:")) {
        const gid = id.slice(6);
        if (!objects.some(o => selectedIds.includes(o.id) && o.groupId === gid)) {
          setSelectedIds(objects.filter(o => o.groupId === gid).map(o => o.id));
        }
      } else if (!selectedIds.includes(id)) {
        setSelectedIds([id]);
      }
    } else if (id === "canvas") {
      if (!selectedIds.length) {
        // Keep selection empty if clicking on empty canvas
      }
    }
    setContextMenu({ x: e.clientX, y: e.clientY, id: id === "canvas" ? null : id });
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
      setShowElementModal(false);
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
      if (editingElementId === id) {
        setEditingElementId("");
        setShowElementModal(false);
      }
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
        <div style={{ display: 'flex', gap: '0.5rem', padding: '0 1rem' }}>
          <button type="button" className="primary" onClick={handleShowPrintModal} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Imprimir
          </button>
        </div>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
              <h3>Herramientas</h3>
              <label className="editModeSwitch"><input type="checkbox" checked={sidebarEditMode} onChange={(e) => { setSidebarEditMode(e.target.checked); setShowElementModal(false); }} /><span className="track"><span className="thumb" /></span><small style={{marginLeft: '0.4rem', color: 'var(--muted)', fontWeight: 600}}>Edit</small></label>
            </div>
            {sidebarEditMode && (
              <button 
                type="button" 
                style={{ width: '100%', marginTop: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }} 
                onClick={() => { setEditingElementId(""); setElementForm({ key: "text", name: "Nuevo", category: "basic", objectType: "text", defaultWidthPt: 90, defaultHeightPt: 24, defaultContent: "${texto}" }); setShowElementModal(true); }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Nueva
              </button>
            )}
          </div>
          <div className="sidebarScroll">
            <div className="paletteGrid">
              {(elements.length > 0 ? elements : TYPES.map(t => ({ id: t, key: t, name: cap(t), category: "basic", objectType: t, defaultWidthPt: 40, defaultHeightPt: 20, defaultContent: t === "text" || t === "barcode" ? t : "" }))).map((el) => (
                <div key={el.id} className="paletteCard" style={{ position: 'relative' }}>
                  <button 
                    type="button" 
                    className={`iconBtn ${sidebarEditMode ? 'editing' : ''}`} 
                    draggable={!sidebarEditMode || !baseElementIds.includes(el.id)} 
                    onDragStart={(e) => { 
                      draggedElementRef.current = el as any; 
                      e.dataTransfer.setData("application/saelabel-element", JSON.stringify(el)); 
                    }} 
                    onDragEnd={resetDragState}
                    onClick={() => {
                      if (sidebarEditMode && !baseElementIds.includes(el.id)) {
                        editElement(el as any);
                        setShowElementModal(true);
                      }
                    }}
                  >
                    <span className="ico">{ICON[el.objectType as keyof typeof ICON]}</span>
                    <small>{el.name}</small>
                  </button>
                  {sidebarEditMode && baseElementIds.includes(el.id) && (
                    <span className="lockIco" title="Predefinido" style={{ position: 'absolute', top: '4px', right: '4px', color: 'var(--muted)', opacity: 0.6, pointerEvents: 'none' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="sidebarSection" style={{ marginTop: '1.5rem' }}>
              <h4>Formas</h4>
              <div className="paletteGrid">
                {PREDEFINED_SHAPES.map((s) => (
                  <div key={s.name} className="paletteCard">
                    <button 
                      type="button" 
                      className="iconBtn" 
                      draggable 
                      onDragStart={(e) => { 
                        const el = { key: "path", name: s.name, category: "shapes", objectType: "path", defaultWidthPt: 40, defaultHeightPt: 40, defaultContent: s.path };
                        draggedElementRef.current = el as any; 
                        e.dataTransfer.setData("application/saelabel-element", JSON.stringify(el)); 
                      }} 
                      onDragEnd={resetDragState}
                    >
                      <span className="ico">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d={s.path} />
                        </svg>
                      </span>
                      <small>{s.name}</small>
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="editHint" style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--muted)', lineHeight: '1.4', background: '#f8fafc', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border)' }}>
              <strong>Tip:</strong> Arrastra los elementos al lienzo para agregarlos. Doble clic en un elemento para activar rotación y sesgado.
            </div>
          </div>
        </aside>
        <div className="sidebarResizer left" onMouseDown={(e) => { resizingSidebarRef.current = { side: "left", startX: e.clientX, startWidth: leftSidebarWidth, otherWidth: rightSidebarWidth, bodyWidth: studioBodyRef.current?.getBoundingClientRect().width ?? 0 }; }} />
        <main className="canvasArea">
          <div className="canvasLayout">
            <div className="rulerCorner" />
            <Ruler orientation="horizontal" lengthPt={templateWidthPt} zoom={zoom} unit={templateUnit} offsetPt={rulerOffsets.x} onStartGuideline={(e) => startGuideline("horizontal", e)} guidelines={guidelines} />
            <Ruler orientation="vertical" lengthPt={templateHeightPt} zoom={zoom} unit={templateUnit} offsetPt={rulerOffsets.y} onStartGuideline={(e) => startGuideline("vertical", e)} guidelines={guidelines} />
            <div ref={viewportRef} className="canvasViewport" style={{ cursor: isPanning ? 'grabbing' : 'auto' }} onContextMenu={(e) => { e.preventDefault(); handleContextMenu(e, "canvas"); }} onMouseDown={(e) => { if (e.button === 1 || (e.button === 0 && e.shiftKey)) { e.preventDefault(); setIsPanning(true); setPanState({ startX: e.clientX, startY: e.clientY, startScrollLeft: e.currentTarget.scrollLeft, startScrollTop: e.currentTarget.scrollTop }); return; } if (e.target === e.currentTarget && e.button === 0) { setContextMenu(null); setBoxSelect({ startClientX: e.clientX, startClientY: e.clientY, currentClientX: e.clientX, currentClientY: e.clientY }); } }} onDragOver={(e) => { e.preventDefault(); setIsBoardDragOver(true); e.dataTransfer.dropEffect = "copy"; }} onDragLeave={() => setIsBoardDragOver(false)} onDrop={(e) => { e.preventDefault(); setIsBoardDragOver(false); const raw = e.dataTransfer.getData("application/saelabel-element"); const el = raw ? JSON.parse(raw) : draggedElementRef.current; resetDragState(); if (!el || !boardRef.current) return; const br = boardRef.current.getBoundingClientRect(); const x = (e.clientX - br.left) / zoom; const y = (e.clientY - br.top) / zoom; setObjects(p => [...p, { id: `new-${crypto.randomUUID()}`, xmlIndex: null, type: el.objectType, x, y, w: el.defaultWidthPt, h: el.defaultHeightPt, content: el.defaultContent || "", rotateDeg: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, fillColor: undefined, lineColor: "#000000", lineWidth: 1 }]); }}>
              {guidelines.map(g => (
                <div key={g.id} className={`guideline ${g.orientation}`} style={{ [g.orientation === "horizontal" ? "top" : "left"]: (g.posPt + (g.orientation === "horizontal" ? rulerOffsets.y : rulerOffsets.x)) * zoom + 24 }} onMouseDown={(e) => { e.stopPropagation(); setActiveGuidelineDrag({ id: g.id, startPosPt: g.posPt }); }} />
              ))}
              {boxSelect && viewportRef.current && (
                <div className={`selectionRect ${boxSelect.currentClientX >= boxSelect.startClientX ? "touch" : "contain"}`} style={{ left: Math.min(boxSelect.startClientX, boxSelect.currentClientX) - viewportRef.current.getBoundingClientRect().left, top: Math.min(boxSelect.startClientY, boxSelect.currentClientY) - viewportRef.current.getBoundingClientRect().top, width: Math.abs(boxSelect.currentClientX - boxSelect.startClientX), height: Math.abs(boxSelect.currentClientY - boxSelect.startClientY) }} />
              )}
              <div ref={boardRef} className={`canvasBoard ${isBoardDragOver ? "dragOver" : ""} ${activeTransformKind ? `transform-${activeTransformKind}` : ""}`} style={{ width: templateWidthPt * zoom, height: templateHeightPt * zoom }} onMouseDown={(e) => { if (e.target === e.currentTarget) { setContextMenu(null); setBoxSelect({ startClientX: e.clientX, startClientY: e.clientY, currentClientX: e.clientX, currentClientY: e.clientY }); } }}>
                {objects.map((o) => (
                  <button key={o.id} type="button" className={`canvasObject ${o.type} ${selectedIds.includes(o.id) ? "selected" : ""}`} style={{ left: o.x * zoom, top: o.y * zoom, width: o.w * zoom, height: o.h * zoom, transform: `rotate(${o.rotateDeg}deg) skew(${o.skewX}deg, ${o.skewY}deg) scale(${o.scaleX}, ${o.scaleY})` }} onMouseDown={(e) => { e.stopPropagation(); const ids = objects.find(x => x.id === o.id)?.groupId ? objects.filter(x => x.groupId === objects.find(x => x.id === o.id)?.groupId).map(x => x.id) : selectedIds.includes(o.id) ? selectedIds : [o.id]; setDrag({ mode: "move", id: o.id, startX: e.clientX, startY: e.clientY, x: o.x, y: o.y, w: o.w, h: o.h, originMap: ids.reduce((a, id) => { const f = objects.find(x => x.id === id); if (f) a[id] = { x: f.x, y: f.y }; return a; }, {} as any) }); }} onContextMenu={(e) => handleContextMenu(e, o.id)} onClick={(e) => { e.stopPropagation(); if (e.ctrlKey) setSelectedIds(p => p.includes(o.id) ? p.filter(id => id !== o.id) : [...p, o.id]); else setSelectedIds([o.id]); }} onDoubleClick={() => setTransformModeIds(p => p.includes(o.id) ? p.filter(x => x !== o.id) : [...p, o.id])}>
                    {/* Only show type label for non-visual types that have no content renderer */}
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
                          showText={o.showText}
                          textPosition={o.textPosition}
                          variables={variables}
                          onResize={(w, h) => {
                            if (Math.abs(o.w - w) > 0.5 || Math.abs(o.h - h) > 0.5) {
                              setObjects(p => p.map(x => x.id === o.id ? { ...x, w, h } : x));
                            }
                          }}
                        />
                      </div>
                    ) : o.type === "line" ? (
                      <div className="lineViz" style={{ width: "100%", height: "100%", background: o.lineColor || "currentColor" }} />
                    ) : o.type === "path" ? (
                      <svg viewBox="0 0 24 24" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
                        <path 
                          d={o.content} 
                          fill={o.fillColor || "transparent"} 
                          stroke={o.lineColor || "black"} 
                          strokeWidth={o.lineWidth ? o.lineWidth * (24 / Math.max(o.w, o.h)) : 0} 
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                    ) : o.type === "text" ? (
                      <div style={{
                        width: "100%",
                        height: "100%",
                        overflow: "hidden",
                        display: "flex",
                        alignItems: "flex-start",
                        fontSize: `${Math.max(6, (o.fontSize ?? 10) * zoom)}px`,
                        lineHeight: 1.2,
                        color: o.lineColor || "#000",
                        fontFamily: o.fontFamily || "sans-serif",
                        fontWeight: "normal",
                        padding: "1px 2px",
                        boxSizing: "border-box",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        pointerEvents: "none",
                        userSelect: "none",
                      }}>
                        {replaceVars(o.content || "${texto}", variables)}
                      </div>
                    ) : (
                      <div style={{ 
                        width: "100%", 
                        height: "100%", 
                        background: o.fillColor || "transparent", 
                        border: (o.lineWidth ?? 1) > 0 ? `${(o.lineWidth ?? 1) * zoom}px solid ${o.lineColor || "black"}` : "none", 
                        borderRadius: o.type === "ellipse" ? "50%" : "0", 
                        boxSizing: "border-box" 
                      }} />
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
            <button type="button" className={`sidebarTab ${activeRightTab === "properties" ? "active" : ""}`} onClick={() => setActiveRightTab("properties")}>Propiedades</button>
            <button type="button" className={`sidebarTab ${activeRightTab === "layers" ? "active" : ""}`} onClick={() => setActiveRightTab("layers")}>Capas</button>
            <button type="button" className={`sidebarTab ${activeRightTab === "variables" ? "active" : ""}`} onClick={() => setActiveRightTab("variables")}>Datos</button>
            <button type="button" className={`sidebarTab ${activeRightTab === "preview" ? "active" : ""}`} onClick={() => setActiveRightTab("preview")}>Vista Previa</button>
          </div>
          <div className="sidebarScroll">
            {activeRightTab === "layers" && (
              <div className="layersPanel">
                <div className="layersList">
                  {layerNodes.map(node => node.kind === "group" ? (
                    <div key={node.groupId} className="layerGroupWrap">
                      <div className="layerItem layerGroup" draggable onDragStart={() => setDragLayerId(`group:${node.groupId}`)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (dragLayerId) reorderByLayerDrop(dragLayerId, `group:${node.groupId}`); setDragLayerId(null); }} onClick={() => setSelectedIds(node.members.map(m => m.id))} onContextMenu={(e) => handleContextMenu(e, `group:${node.groupId}`)}>
                        <span className="layerIcon">{GROUP_ICON}</span>
                        <span>Grupo ({node.members.length})</span>
                      </div>
                      {node.members.map(m => (
                        <div key={m.id} className={`layerItem layerChild ${selectedIds.includes(m.id) ? "selected" : ""}`} onClick={() => setSelectedIds([m.id])} onContextMenu={(e) => handleContextMenu(e, m.id)} onDragOver={(e) => e.preventDefault()}>
                          <span className="layerIcon">{ICON[m.type as keyof typeof ICON]}</span>
                          <span>{m.type}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div key={node.object.id} className={`layerItem ${selectedIds.includes(node.object.id) ? "selected" : ""}`} draggable onDragStart={() => setDragLayerId(node.object.id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (dragLayerId) reorderByLayerDrop(dragLayerId, node.object.id); setDragLayerId(null); }} onClick={() => setSelectedIds([node.object.id])} onContextMenu={(e) => handleContextMenu(e, node.object.id)}>
                      <span className="layerIcon">{ICON[node.object.type as keyof typeof ICON]}</span>
                      <span>{node.object.type}</span>
                    </div>
                  ))}
                </div>
                <div className="layersToolbar">
                  <button type="button" className="toolBtn" title="Traer al frente" onClick={() => selectedIds[0] && bringToFront(selectedIds[0])}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3l-6 6"/><path d="M21 3v6"/><path d="M21 3h-6"/><path d="M14 14l-4 4"/><path d="M10 18v-4"/><path d="M10 18h4"/></svg>
                  </button>
                  <button type="button" className="toolBtn" title="Enviar al fondo" onClick={() => selectedIds[0] && sendToBack(selectedIds[0])}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21l6-6"/><path d="M3 21v-6"/><path d="M3 21h6"/><path d="M10 10l4-4"/><path d="M14 6v4"/><path d="M14 6h-4"/></svg>
                  </button>
                  <div className="toolDivider" />
                  <button type="button" className="toolBtn" title="Subir capa" onClick={() => selectedIds[0] && moveLayer(selectedIds[0], "up")}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                  </button>
                  <button type="button" className="toolBtn" title="Bajar capa" onClick={() => selectedIds[0] && moveLayer(selectedIds[0], "down")}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div className="toolDivider" />
                  <button type="button" className="toolBtn" title="Agrupar" onClick={groupSelected} disabled={selectedIds.length < 2}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>
                  </button>
                  <button type="button" className="toolBtn danger" title="Eliminar" onClick={() => deleteObjects(selectedIds)} disabled={selectedIds.length === 0}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  </button>
                </div>
              </div>
            )}
            {activeRightTab === "properties" && sel && (
              <div className="inspectorPanel">
                <div className="inspectorScroll">
                  <div className="inspectorSection">
                    <header className="sectionHeader">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
                      <span>Geometría</span>
                    </header>
                    <div className="inspectorFields grid2">
                      <label>X<input type="number" value={sel.x} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, x: Number(e.target.value) } : x))} /></label>
                      <label>Y<input type="number" value={sel.y} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, y: Number(e.target.value) } : x))} /></label>
                      <label>Ancho<input type="number" value={sel.w} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, w: Number(e.target.value) } : x))} /></label>
                      <label>Alto<input type="number" value={sel.h} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, h: Number(e.target.value) } : x))} /></label>
                    </div>
                    <div className="inspectorFields grid3">
                      <label>Rotación<input type="number" value={sel.rotateDeg} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, rotateDeg: Number(e.target.value) } : x))} /></label>
                      <label>Escala X<input type="number" step="0.1" value={sel.scaleX} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, scaleX: Number(e.target.value) } : x))} /></label>
                      <label>Escala Y<input type="number" step="0.1" value={sel.scaleY} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, scaleY: Number(e.target.value) } : x))} /></label>
                    </div>
                  </div>

                  <div className="inspectorSection">
                    <header className="sectionHeader">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                      <span>Apariencia</span>
                    </header>
                    <div className="inspectorFields grid2">
                      {(sel.type === "box" || sel.type === "ellipse" || sel.type === "line" || sel.type === "path") && (
                        <>
                          <label className="full">Color Relleno
                            <div className="colorInput">
                              <input type="color" disabled={!sel.fillColor} value={sel.fillColor || "#ffffff"} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, fillColor: e.target.value } : x))} />
                              <span>{sel.fillColor || "Transparente"}</span>
                              <button className="btnIcon" onClick={() => setObjects(p => p.map(x => x.id === sel.id ? { ...x, fillColor: sel.fillColor ? undefined : "#ffffff" } : x))} title={sel.fillColor ? "Quitar Relleno" : "Poner Relleno"}>
                                {sel.fillColor ? "×" : "+"}
                              </button>
                            </div>
                          </label>
                          <label className="full">Color Borde
                            <div className="colorInput">
                              <input type="color" disabled={sel.lineWidth === 0} value={sel.lineColor || "#000000"} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, lineColor: e.target.value } : x))} />
                              <span>{sel.lineWidth === 0 ? "Sin Borde" : (sel.lineColor || "#000000")}</span>
                            </div>
                          </label>
                          <label className="full">Ancho Borde
                            <div className="colorInput">
                              <input type="number" min="0" step="0.5" value={sel.lineWidth ?? 1} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, lineWidth: Number(e.target.value) } : x))} />
                              <button className="btnIcon" onClick={() => setObjects(p => p.map(x => x.id === sel.id ? { ...x, lineWidth: (sel.lineWidth || 0) > 0 ? 0 : 1 } : x))} title={sel.lineWidth ? "Quitar Borde" : "Poner Borde"}>
                                {sel.lineWidth ? "×" : "+"}
                              </button>
                            </div>
                          </label>
                        </>
                      )}
                      {sel.type === "barcode" && (
                        <label className="full">Tipo Barcode
                          <select value={sel.barcodeKind || "CODE128"} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, barcodeKind: e.target.value } : x))}>
                            {["CODE128", "CODE39", "QR", "EAN13", "EAN8", "UPCA", "UPCE", "ITF", "DATAMATRIX"].map(k => <option key={k} value={k}>{k}</option>)}
                          </select>
                        </label>
                      )}
                      {sel.type === "barcode" && sel.barcodeKind !== "QR" && (
                        <>
                          <label className="full checkboxLabel">
                            <input type="checkbox" checked={!!sel.showText} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, showText: e.target.checked } : x))} />
                            Mostrar texto
                          </label>
                          <label className="full">Posición texto
                            <select value={sel.textPosition || "bottom"} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, textPosition: e.target.value as any } : x))}>
                              <option value="bottom">Abajo</option>
                              <option value="top">Arriba</option>
                            </select>
                          </label>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Contenido section — hidden for shape types that need no content */}
                  {sel.type !== "box" && sel.type !== "ellipse" && sel.type !== "line" && (
                  <div className="inspectorSection">
                    <header className="sectionHeader">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                      <span>{sel.type === "text" ? "Texto" : sel.type === "image" ? "Imagen" : "Contenido"}</span>
                    </header>
                    <div className="inspectorFields">
                      {/* Image upload button */}
                      {sel.type === "image" && (
                        <div className="full imgUploadRow">
                          <button type="button" className="mini" onClick={() => { const input = document.createElement("input"); input.type = "file"; input.accept = "image/*"; input.onchange = (e) => { const file = (e.target as HTMLInputElement).files?.[0]; if (file) { const reader = new FileReader(); reader.onload = (loadEv) => { setObjects(p => p.map(x => x.id === sel.id ? { ...x, content: loadEv.target?.result as string } : x)); }; reader.readAsDataURL(file); } }; input.click(); }}>Cargar Imagen</button>
                        </div>
                      )}

                      {/* Font controls — only for text */}
                      {sel.type === "text" && (
                        <>
                          <label style={{ margin: 0 }}>Fuente
                            <select value={sel.fontFamily || "sans-serif"} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, fontFamily: e.target.value } : x))}>
                              <option value="sans-serif">Sans-serif</option>
                              <option value="serif">Serif</option>
                              <option value="monospace">Monospace</option>
                              <option value="Arial">Arial</option>
                              <option value="Helvetica">Helvetica</option>
                              <option value="Times New Roman">Times New Roman</option>
                              <option value="Courier New">Courier New</option>
                              <option value="Georgia">Georgia</option>
                              <option value="Verdana">Verdana</option>
                              <option value="Tahoma">Tahoma</option>
                            </select>
                          </label>
                          <label style={{ margin: 0 }}>Tamaño
                            <input type="number" min={4} max={200} step={1}
                              value={sel.fontSize ?? 10}
                              onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, fontSize: Number(e.target.value) } : x))}
                            />
                          </label>
                        </>
                      )}

                      {/* Content input — single line for barcode/path/image, small textarea for text */}
                      {sel.type !== "image" && (
                        <label className="full" style={{ margin: 0 }}>Contenido
                          {sel.type === "text" ? (
                            <textarea rows={2} value={sel.content} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, content: e.target.value } : x))} />
                          ) : (
                            <input type="text" value={sel.content} onChange={e => setObjects(p => p.map(x => x.id === sel.id ? { ...x, content: e.target.value } : x))} />
                          )}
                        </label>
                      )}
                    </div>
                  </div>
                  )}
                </div>
              </div>
            )}
            {activeRightTab === "variables" && (
              <div className="variablesPanel" style={{ padding: '1rem' }}>
                <h4 style={{ marginTop: 0, marginBottom: '0.5rem', color: 'var(--text)' }}>Variables Mapeables</h4>
                
                <div style={{ background: 'var(--primary-light, #e0f2fe)', border: '1px solid var(--primary, #3b82f6)', color: 'var(--primary-dark, #1e40af)', padding: '0.8rem', borderRadius: '8px', marginBottom: '1.5rem', fontSize: '0.8rem', lineHeight: '1.4' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem', fontWeight: 600 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    ¿Cómo insertar variables?
                  </div>
                  Para inyectar valores dinámicos en tu etiqueta, primero <strong>selecciona un elemento de Texto o Código de Barras</strong> en el lienzo. Luego, <strong>haz clic en la variable</strong> de la lista de abajo para insertarla.
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                  <input style={{ flex: 1 }} placeholder="Nombre Variable..." value={newVarName} onChange={e => setNewVarName(e.target.value.toUpperCase().replace(/\s+/g, '_'))} onKeyDown={e => { if (e.key === 'Enter' && newVarName.trim() && !variables.some(x => x.name === newVarName.trim())) { setVariables(p => [...p, { name: newVarName.trim(), type: "text", increment: "never" }]); setNewVarName(''); } }} />
                  <button type="button" className="mini primary" onClick={() => { if (newVarName.trim() && !variables.some(x => x.name === newVarName.trim())) { setVariables(p => [...p, { name: newVarName.trim(), type: "text", increment: "never" }]); setNewVarName(''); } }}>Añadir</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  {variables.map(v => {
                    const isNumeric = ['integer', 'int', 'decimal', 'float', 'double'].includes(v.type || 'text');
                    return (
                      <div key={v.name} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: '#ffffff', padding: '0.8rem', borderRadius: '8px', border: '1px solid var(--border)', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <code style={{ fontSize: '0.85rem', color: 'var(--primary)', backgroundColor: 'var(--primary-light, #e0f2fe)', padding: '0.2rem 0.5rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.3rem', transition: 'all 0.2s' }} 
                            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#bae6fd')}
                            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'var(--primary-light, #e0f2fe)')}
                            onClick={() => { 
                              if (sel && (sel.type === 'text' || sel.type === 'barcode')) {
                                setObjects(p => p.map(o => o.id === sel.id ? { ...o, content: (o.content || '') + `\${${v.name}}` } : o));
                                setStatus(`Variable \${${v.name}} insertada.`);
                              } else {
                                setStatus("Selecciona un elemento de texto o código de barras primero.");
                              }
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            {`{${v.name}}`}
                          </code>
                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <select value={v.type || "text"} onChange={e => setVariables(p => p.map(x => x.name === v.name ? { ...x, type: e.target.value } : x))} style={{ fontSize: '0.85rem', padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: '#f8fafc', fontWeight: 500, cursor: 'pointer', outline: 'none' }}>
                              <option value="text">Texto</option>
                              <option value="integer">Entero</option>
                              <option value="decimal">Decimal</option>
                              <option value="date">Fecha</option>
                            </select>
                            <button type="button" className="iconBtn mini danger" style={{ border: 'none', background: 'transparent', padding: '4px', cursor: 'pointer', borderRadius: '4px' }}
                              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#fee2e2')}
                              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                              onClick={() => setVariables(p => p.filter(x => x.name !== v.name))}
                              title="Eliminar variable"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                          </div>
                        </div>
                        {isNumeric && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.2rem', paddingTop: '0.4rem', borderTop: '1px dashed var(--border)' }}>
                            <label style={{ margin: 0, fontSize: '0.7rem', color: 'var(--muted)' }}>Valor Inicial (Opcional)
                              <input style={{ display: 'block', width: '100%', marginTop: '0.2rem', fontSize: '0.75rem', padding: '0.2rem' }} type="text" placeholder="ej. 1" value={v.initial || ''} onChange={e => setVariables(p => p.map(x => x.name === v.name ? { ...x, initial: e.target.value } : x))} />
                            </label>
                            <label style={{ margin: 0, fontSize: '0.7rem', color: 'var(--muted)' }}>Incremento
                              <select style={{ display: 'block', width: '100%', marginTop: '0.2rem', fontSize: '0.75rem', padding: '0.2rem' }} value={v.increment || "never"} onChange={e => setVariables(p => p.map(x => x.name === v.name ? { ...x, increment: e.target.value } : x))}>
                                <option value="never">Ninguno</option>
                                <option value="per_item">Por Elemento / Etiqueta</option>
                                <option value="per_page">Por Página</option>
                              </select>
                            </label>
                            {v.increment && v.increment !== "never" && (
                              <label style={{ margin: 0, fontSize: '0.7rem', color: 'var(--muted)', gridColumn: 'span 2' }}>Paso / Multiplicador
                                <input style={{ display: 'block', width: '100%', marginTop: '0.2rem', fontSize: '0.75rem', padding: '0.2rem' }} type="number" placeholder="ej. 1 (Opcional)" value={v.step ?? ''} onChange={e => setVariables(p => p.map(x => x.name === v.name ? { ...x, step: e.target.value ? Number(e.target.value) : undefined } : x))} />
                              </label>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {activeRightTab === "preview" && (
              <div className="previewPanel">
                <div className="previewViewport">
                  <div className="previewLabel" style={{ width: templateWidthPt * previewScale, height: templateHeightPt * previewScale }}>
                    {objects.map(o => (
                      <div key={o.id} className={`previewObject ${o.type}`} style={{ left: o.x * previewScale, top: o.y * previewScale, width: o.w * previewScale, height: o.h * previewScale, transform: `rotate(${o.rotateDeg}deg) scale(${o.scaleX}, ${o.scaleY})` }}>
                        {o.type === "barcode" && <BarcodeImage value={o.content || "123456"} kind={o.barcodeKind} width={o.w} height={o.h} zoom={previewScale} showText={o.showText} textPosition={o.textPosition} variables={variables} />}
                        {o.type === "image" && o.content && <img src={o.content} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
                        {o.type === "line" && <div className="lineViz" style={{ width: "100%", height: "100%", background: o.lineColor || "currentColor" }} />}
                        {(o.type === "box" || o.type === "ellipse") && (
                          <div style={{ 
                            width: "100%", 
                            height: "100%", 
                            background: o.fillColor || "transparent", 
                            border: (o.lineWidth ?? 1) > 0 ? `${(o.lineWidth ?? 1) * previewScale}px solid ${o.lineColor || "black"}` : "none", 
                            borderRadius: o.type === "ellipse" ? "50%" : "0" 
                          }} />
                        )}
                        {o.type === "text" && (
                          <div style={{
                            width: "100%", height: "100%", overflow: "hidden",
                            fontSize: `${Math.max(4, (o.fontSize ?? 10) * previewScale)}px`,
                            lineHeight: 1.2,
                            color: o.lineColor || "#000",
                            fontFamily: o.fontFamily || "sans-serif",
                            padding: "1px 2px",
                            boxSizing: "border-box",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}>
                            {replaceVars(o.content || "${texto}", variables)}
                          </div>
                        )}
                        {o.type === "path" && (
                          <svg viewBox="0 0 24 24" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
                            <path
                              d={o.content}
                              fill={o.fillColor || "transparent"}
                              stroke={o.lineColor || "black"}
                              strokeWidth={o.lineWidth ? o.lineWidth * (24 / Math.max(o.w, o.h)) : 1}
                              vectorEffect="non-scaling-stroke"
                            />
                          </svg>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {status && (
              <div style={{
                position: 'absolute',
                bottom: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: '#334155',
                color: 'white',
                padding: '10px 20px',
                borderRadius: '8px',
                fontSize: '0.9rem',
                boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
                zIndex: 9999,
                animation: 'fadein 0.3s, fadeout 0.3s 2.7s'
              }}>
                {status}
              </div>
            )}
          </div>
        </aside>
      </div>
      {contextMenu && (
        <div className="contextMenu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.id && contextMenu.id !== "canvas" ? (
            <>
              <div className="menuItem" onClick={() => { setActiveRightTab("properties"); setContextMenu(null); }}>Propiedades</div>
              <div className="menuLine" />
              <div className="menuItem" onClick={() => moveLayer(contextMenu.id!, "up")}>Subir capa</div>
              <div className="menuItem" onClick={() => moveLayer(contextMenu.id!, "down")}>Bajar capa</div>
              <div className="menuItem" onClick={() => bringToFront(contextMenu.id!)}>Traer al frente</div>
              <div className="menuItem" onClick={() => sendToBack(contextMenu.id!)}>Enviar al fondo</div>
              <div className="menuLine" />
              <div className="menuItem" onClick={() => duplicateObjects(selectedIds)}>Duplicar</div>
              {selectedIds.length > 1 && <div className="menuItem" onClick={() => groupSelected()}>Agrupar</div>}
              {objects.some(o => selectedIds.includes(o.id) && o.groupId) && <div className="menuItem" onClick={() => ungroupSelected()}>Desagrupar</div>}
              <div className="menuLine" />
              <div className="menuItem danger" onClick={() => deleteObjects(selectedIds)}>Eliminar</div>
            </>
          ) : (
            <>
              {selectedIds.length > 0 && (
                <>
                  <div className="menuItem" onClick={() => { setActiveRightTab("properties"); setContextMenu(null); }}>Propiedades ({selectedIds.length})</div>
                  <div className="menuLine" />
                  <div className="menuItem" onClick={() => duplicateObjects(selectedIds)}>Duplicar seleccionados</div>
                  {selectedIds.length > 1 && <div className="menuItem" onClick={() => groupSelected()}>Agrupar</div>}
                  {objects.some(o => selectedIds.includes(o.id) && o.groupId) && <div className="menuItem" onClick={() => ungroupSelected()}>Desagrupar</div>}
                  <div className="menuLine" />
                  <div className="menuItem danger" onClick={() => deleteObjects(selectedIds)}>Eliminar seleccionados</div>
                  <div className="menuLine" />
                </>
              )}
              <div className="menuItem" onClick={() => { setSelectedIds([]); setContextMenu(null); }}>Limpiar seleccion</div>
            </>
          )}
        </div>
      )}
      {showElementModal && (
        <div className="modalBackdrop" onClick={() => setShowElementModal(false)}>
          <div className="modalCard" style={{ width: '400px', maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{editingElementId ? "Editar Herramienta" : "Nueva Herramienta"}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
              <label style={{ display: 'block', margin: 0 }}>Nombre
                <input style={{ display: 'block', width: '100%', marginTop: '0.4rem' }} value={elementForm.name} placeholder="p.ej. Código de barras principal" onChange={(e) => setElementForm(p => ({ ...p, name: e.target.value }))} />
              </label>
              <label style={{ display: 'block', margin: 0 }}>Identificador (Key)
                <input style={{ display: 'block', width: '100%', marginTop: '0.4rem' }} value={elementForm.key} placeholder="p.ej. barcode_main" onChange={(e) => setElementForm(p => ({ ...p, key: e.target.value }))} />
              </label>
              <label style={{ display: 'block', margin: 0 }}>Tipo Base
                <select style={{ display: 'block', width: '100%', marginTop: '0.4rem' }} value={elementForm.objectType} onChange={(e) => setElementForm(p => ({ ...p, objectType: e.target.value as any }))}>
                  {TYPES.map(t => <option key={t} value={t}>{cap(t)}</option>)}
                </select>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <label style={{ display: 'block', margin: 0 }}>Ancho (pt)
                  <input style={{ display: 'block', width: '100%', marginTop: '0.4rem' }} type="number" value={elementForm.defaultWidthPt} onChange={(e) => setElementForm(p => ({ ...p, defaultWidthPt: Number(e.target.value) || 1 }))} />
                </label>
                <label style={{ display: 'block', margin: 0 }}>Alto (pt)
                  <input style={{ display: 'block', width: '100%', marginTop: '0.4rem' }} type="number" value={elementForm.defaultHeightPt} onChange={(e) => setElementForm(p => ({ ...p, defaultHeightPt: Number(e.target.value) || 1 }))} />
                </label>
              </div>
              {(elementForm.objectType === 'text' || elementForm.objectType === 'barcode') && (
                <label style={{ display: 'block', margin: 0 }}>Contenido o Variable
                  <input style={{ display: 'block', width: '100%', marginTop: '0.4rem' }} value={elementForm.defaultContent || ''} placeholder="Texto o e.g ${PRECIO}" onChange={(e) => setElementForm(p => ({ ...p, defaultContent: e.target.value }))} />
                </label>
              )}
            </div>
            
            <div className="modalActions" style={{ marginTop: '2rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
              <button type="button" className="secondary" onClick={() => setShowElementModal(false)}>Cancelar</button>
              {editingElementId && <button type="button" className="danger" onClick={() => deleteElement(editingElementId)}>Eliminar</button>}
              <button type="button" className="primary" onClick={saveElement}>Guardar</button>
            </div>
          </div>
        </div>
      )}
      
      {showPrintModal && (
        <div className="modalBackdrop" onClick={() => !printForm.isPrinting && setShowPrintModal(false)} style={{ zIndex: 2000 }}>
          <div className="modalCard" style={{ width: '400px', maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              Imprimir Etiqueta
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>
              Selecciona una impresora lógica configurada o escribe el nombre físico.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <label style={{ display: 'block', margin: 0, fontSize: '0.85rem', fontWeight: 500 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Nombre de Impresora</span>
                  <button type="button" className="toolbarBtn" style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }} onClick={() => setShowPrintersManagerModal(true)}>
                    Administrar Impresoras
                  </button>
                </div>
                {availableLogicalPrinters.length > 0 ? (
                  <select style={{ display: 'block', width: '100%', marginTop: '0.4rem', padding: '0.5rem' }} value={printForm.printerName} onChange={(e) => setPrintForm(p => ({ ...p, printerName: e.target.value }))} disabled={printForm.isPrinting}>
                    <option value="">-- Seleccionar impresora o escribir nombre abajo --</option>
                    {availableLogicalPrinters.map(p => (
                      <option key={p.id} value={p.name}>{p.name} (Física: {p.physicalPrinter})</option>
                    ))}
                  </select>
                ) : null}
                <input style={{ display: 'block', width: '100%', marginTop: availableLogicalPrinters.length > 0 ? '0.4rem' : '0.4rem', padding: '0.5rem' }} value={printForm.printerName} placeholder="Ej. ZDesigner GK420t" onChange={(e) => setPrintForm(p => ({ ...p, printerName: e.target.value }))} disabled={printForm.isPrinting} />
              </label>
              
              <label style={{ display: 'block', margin: 0, fontSize: '0.85rem', fontWeight: 500 }}>Cantidad de Copias {printTab === "excel" ? "(por registro)" : ""}</label>
                <input style={{ display: 'block', width: '100%', marginTop: '0.4rem', padding: '0.5rem' }} type="number" min="1" value={printForm.copies} onChange={(e) => setPrintForm(p => ({ ...p, copies: Math.max(1, Number(e.target.value) || 1) }))} disabled={printForm.isPrinting} />
              
              {variables.length > 0 && (
                <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                  <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
                    <button type="button" className={printTab === "manual" ? "primary" : "secondary"} onClick={() => setPrintTab("manual")}>Valores Manuales</button>
                    <button type="button" className={printTab === "excel" ? "primary" : "secondary"} onClick={() => setPrintTab("excel")}>Cargar Excel (Lote)</button>
                  </div>
                  
                  {printTab === "manual" && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {variables.map(v => (
                        <label key={v.name} style={{ display: 'block', fontSize: '0.85rem' }}>
                          {v.name}
                          <input type="text" style={{ display: 'block', width: '100%', padding: '0.4rem' }} value={manualVars[v.name] || ""} onChange={e => setManualVars(p => ({ ...p, [v.name]: e.target.value }))} />
                        </label>
                      ))}
                    </div>
                  )}

                  {printTab === "excel" && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <label style={{ display: 'block', fontSize: '0.85rem' }}>
                        Archivo Excel (.xlsx, .csv)
                        <input type="file" accept=".xlsx, .xls, .csv" style={{ display: 'block', width: '100%', padding: '0.4rem' }} onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const data = await file.arrayBuffer();
                          const workbook = XLSX.read(data);
                          const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                          const json = XLSX.utils.sheet_to_json(worksheet);
                          setExcelData(json as Record<string,any>[]);
                          if (json.length > 0) {
                            setExcelCols(Object.keys(json[0] as object));
                          }
                        }} />
                      </label>
                      
                      {excelCols.length > 0 && (
                        <div style={{ marginTop: '1rem', background: 'var(--surface2)', padding: '0.8rem', borderRadius: '4px' }}>
                          <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.85rem' }}>Mapeo de Columnas ({excelData.length} filas)</h4>
                          {variables.map(v => (
                            <div key={v.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                              <span style={{ fontSize: '0.85rem' }}>{v.name}</span>
                              <select style={{ padding: '0.3rem', width: '150px' }} value={excelMapping[v.name] || ""} onChange={e => setExcelMapping(p => ({ ...p, [v.name]: e.target.value }))}>
                                <option value="">-- Ignorar --</option>
                                {excelCols.map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            
            <div className="modalActions" style={{ marginTop: '2rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
              <button type="button" className="secondary" onClick={() => setShowPrintModal(false)} disabled={printForm.isPrinting}>Cancelar</button>
              <button type="button" className="primary" onClick={executePrint} disabled={printForm.isPrinting}>
                {printForm.isPrinting ? "Imprimiendo..." : "Enviar a Imprimir"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPrintersManagerModal && (
        <LogicalPrintersManagerModal apiBaseUrl={apiBaseUrl} onClose={async () => {
          setShowPrintersManagerModal(false);
          // Recargar impresoras al cerrar
          try {
            const logPrinters = await labelsApi.getLogicalPrinters();
            setAvailableLogicalPrinters(logPrinters.filter(p => p.isActive));
          } catch(e){}
        }} />
      )}
    </section>
  );
}
