import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import QRCode from "qrcode";
import * as XLSX from 'xlsx';
import { labelsApi, type LogicalPrinterDto } from "@/lib/api/client";
import { Portal } from "@/components/Portal";

// ─── Types ────────────────────────────────────────────────────────────────────
type Align    = "left" | "center" | "right";
type FontSize = "normal" | "medium" | "large" | "extra-large";

interface Base { id: string; showIf?: string; }
interface TextBlock   extends Base { type: "text";       text: string; align: Align; bold: boolean; size: FontSize; }
interface SepBlock    extends Base { type: "separator";  char: string; }
interface TotalBlock  extends Base { type: "total";      label: string; value: string; bold: boolean; }
interface QrBlock     extends Base { type: "qr";         content: string; align: Align; qrSize: number; }
interface FeedBlock   extends Base { type: "feed";       lines: number; }
interface ActionBlock extends Base { type: "cut" | "beep" | "open-drawer"; }
interface IfBlock     extends Base { type: "if";         expr: string; text: string; bold: boolean; align: Align; }
interface IfelseBlock extends Base { type: "ifelse";     expr: string; thenText: string; elseText: string; align: Align; }

export interface EachColumn { field: string; label: string; width: "auto" | number; align: Align; showIf?: string; bold?: boolean; size?: FontSize; }
interface EachBlock   extends Base { type: "each";       listVar: string; columns: EachColumn[]; showHeader: boolean; childField?: string; childIndentCol?: number; }

type Block = TextBlock | SepBlock | EachBlock | TotalBlock | QrBlock | FeedBlock | ActionBlock | IfBlock | IfelseBlock;

interface TicketDesignerProps { 
  initialXml?: string; 
  onUpdate: (xml: string) => void; 
  apiBaseUrl?: string;
}

// ─── ID generator ─────────────────────────────────────────────────────────────
let _id = 0;
const uid = () => `b${++_id}`;

// ─── XML round-trip ───────────────────────────────────────────────────────────
function xmlToBlocks(xml: string): { blocks: Block[]; width: number; printers: string } {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml || "", "application/xml");
    const root = doc.documentElement;
    if (!root || root.tagName !== "saetickets") return { blocks: [], width: 80, printers: "" };
    const setup  = root.querySelector("setup");
    const charW  = parseInt(setup?.getAttribute("width") ?? "42");
    const printers = setup?.getAttribute("printers") ?? "";
    const width  = charW === 32 ? 58 : 80;
    const cmds   = root.querySelector("commands");
    const blocks: Block[] = [];
    if (!cmds) return { blocks, width, printers };
    const si = (el: Element, a: string) => el.getAttribute(a) ?? "";

    Array.from(cmds.children).forEach(el => {
      const t   = el.tagName;
      const sif = si(el, "showIf") || undefined;
      const parseAl = (s: string) => (["left","center","right"].includes(s) ? s : "left") as Align;

      if      (t === "text")       blocks.push({ id:uid(), type:"text",      text:el.textContent??"", align:parseAl(si(el,"align")), bold:si(el,"bold")==="true", size:(si(el,"size")||"normal") as FontSize, showIf:sif });
      else if (t === "separator")  blocks.push({ id:uid(), type:"separator", char:si(el,"char")||"-", showIf:sif });
      else if (t === "total")      blocks.push({ id:uid(), type:"total",     label:si(el,"label")||"TOTAL", value:si(el,"value")||"0", bold:si(el,"bold")==="true", showIf:sif });
      else if (t === "qr")         blocks.push({ id:uid(), type:"qr",        content:el.textContent??"", align:(si(el,"align")||"center") as Align, qrSize:parseInt(si(el,"size")||"80"), showIf:sif });
      else if (t === "feed")       blocks.push({ id:uid(), type:"feed",      lines:parseInt(si(el,"lines")||"1"), showIf:sif });
      else if (t === "cut")        blocks.push({ id:uid(), type:"cut" });
      else if (t === "beep")       blocks.push({ id:uid(), type:"beep" });
      else if (t === "open-drawer")blocks.push({ id:uid(), type:"open-drawer" });
      else if (t === "if")         blocks.push({ id:uid(), type:"if", expr:si(el,"expr"), text:el.textContent??"", bold:si(el,"bold")==="true", align:(si(el,"align")||"left") as Align, showIf:sif });
      else if (t === "ifelse") {
        const then_ = el.querySelector("then")?.textContent ?? "";
        const else_ = el.querySelector("else")?.textContent ?? "";
        blocks.push({ id:uid(), type:"ifelse", expr:si(el,"expr"), thenText:then_, elseText:else_, align:parseAl(si(el,"align")), showIf:sif });
      }
      else if (t === "each") {
        const cols: EachColumn[] = Array.from(el.querySelectorAll("column")).map(c => ({
          field: si(c,"field"),
          label: si(c,"label"),
          width: si(c,"width")==="auto" ? "auto" : parseInt(si(c,"width")||"10"),
          align: (si(c,"align")||"left") as Align,
          showIf: si(c,"showIf") || undefined,
          bold: si(c,"bold") === "true",
          size: (si(c,"size") || "normal") as FontSize,
        }));
        blocks.push({ 
          id:uid(), type:"each", listVar:si(el,"listVar")||"ITEMS", 
          columns:cols, showHeader:si(el,"header")!=="false", 
          childField:si(el,"childField")||undefined,
          childIndentCol: parseInt(si(el,"childIndentCol")||"0"),
          showIf:sif 
        });
      }
    });
    return { blocks, width, printers };
  } catch { return { blocks: [], width: 80, printers: "" }; }
}

function esc(s?: string) { return (s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function blocksToXml(blocks: Block[], width: number, printers: string): string {
  const chars = width === 58 ? 32 : 42;
  const pAttr = printers ? ` printers="${esc(printers)}"` : "";
  const lines: string[] = [];
  for (const b of blocks) {
    const si = b.showIf ? ` showIf="${esc(b.showIf)}"` : "";
    switch (b.type) {
      case "text":        lines.push(`    <text align="${b.align}" bold="${b.bold}" size="${b.size}"${si}>${esc(b.text)}</text>`); break;
      case "separator":   lines.push(`    <separator char="${esc(b.char)}"${si}/>`); break;
      case "total":       lines.push(`    <total label="${esc(b.label)}" value="${esc(b.value)}" bold="${b.bold}"${si}/>`); break;
      case "qr":          lines.push(`    <qr align="${b.align}" size="${b.qrSize}"${si}>${esc(b.content)}</qr>`); break;
      case "feed":        lines.push(`    <feed lines="${b.lines}"${si}/>`); break;
      case "cut":         lines.push(`    <cut/>`); break;
      case "beep":        lines.push(`    <beep/>`); break;
      case "open-drawer": lines.push(`    <open-drawer/>`); break;
      case "if":          lines.push(`    <if expr="${esc(b.expr)}" align="${b.align}" bold="${b.bold}"${si}>${esc(b.text)}</if>`); break;
      case "ifelse":      lines.push(`    <ifelse expr="${esc(b.expr)}" align="${b.align}"${si}>\n      <then>${esc(b.thenText)}</then>\n      <else>${esc(b.elseText)}</else>\n    </ifelse>`); break;
      case "each": {
        const colXml = b.columns.map(c => {
          const cSi = c.showIf ? ` showIf="${esc(c.showIf)}"` : "";
          const cBold = c.bold ? ` bold="true"` : "";
          const cSize = c.size && c.size !== "normal" ? ` size="${c.size}"` : "";
          return `      <column field="${esc(c.field)}" label="${esc(c.label)}" width="${c.width}" align="${c.align}"${cSi}${cBold}${cSize}/>`;
        }).join("\n");
        const child = b.childField ? ` childField="${esc(b.childField)}"` : "";
        const indent = b.childIndentCol ? ` childIndentCol="${b.childIndentCol}"` : "";
        lines.push(`    <each listVar="${esc(b.listVar)}" header="${b.showHeader}"${child}${indent}${si}>\n${colXml}\n    </each>`);
        break;
      }
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n<saetickets version="1.0">\n  <setup width="${chars}"${pAttr}/>\n  <commands>\n${lines.join("\n")}\n  </commands>\n</saetickets>`;
}

// ─── Column width calculator ──────────────────────────────────────────────────
function calcColWidths(cols: EachColumn[], total: number): number[] {
  const sep = cols.length - 1;
  const fixed = cols.filter(c => c.width !== "auto");
  const auto  = cols.filter(c => c.width === "auto");
  const fixedSum = fixed.reduce((s,c) => s + (c.width as number), 0);
  const autoW = auto.length > 0 ? Math.floor((total - fixedSum - sep) / auto.length) : 0;
  return cols.map(c => c.width === "auto" ? Math.max(4, autoW) : c.width as number);
}

// ─── QR Preview ───────────────────────────────────────────────────────────────
function QrImage({ content, size }: { content: string; size: number }) {
  const [src, setSrc] = React.useState("");
  useEffect(() => {
    const text = content.trim() || "https://example.com";
    QRCode.toDataURL(text, { width: size, margin: 1 }).then(setSrc).catch(() => setSrc(""));
  }, [content, size]);
  return src
    ? <img src={src} style={{ width: size, height: size, display: "block", imageRendering: "pixelated" }} alt="QR" />
    : <span style={{ display:"block", textAlign:"center", padding:"4px", color:"#666", fontSize:"0.7rem" }}>[QR]</span>;
}

// ─── Rich Preview ─────────────────────────────────────────────────────────────
const MONO: React.CSSProperties = { fontFamily:"'Courier New',Courier,monospace", fontSize:"0.78rem", lineHeight:1.55 };
const PREVIEW_ROW: React.CSSProperties = { ...MONO, display:"block", whiteSpace:"pre" };
const INP_STYLE: React.CSSProperties  = { display:"block", width:"100%", marginTop:"0.2rem", padding:"0.6rem 0.75rem", border:"1px solid var(--border,#cbd5e1)", borderRadius:8, fontSize:"0.85rem", background:"var(--surface-alt, #f8fafc)", color: "var(--text)", boxSizing:"border-box", transition: "all 0.2s" };

// ─── Special Variables ────────────────────────────────────────────────────────
const SPECIAL_VARS = [
  { label: "Fecha (ISO)", value: "${!date}" },
  { label: "Hora", value: "${!time}" },
  { label: "Fecha Hora", value: "${!datetime}" },
  { label: "Día (Semana)", value: "${!dayname}" },
  { label: "Semana (Mes)", value: "${!weekmonth}" },
  { label: "Semana (Año)", value: "${!weekyear}" },
  { label: "Año", value: "${!year}" },
  { label: "Mes", value: "${!month}" },
  { label: "Día", value: "${!day}" },
  { label: "Fecha (DD/MM/YY)", value: "${!date:dd/MM/yy}" },
  { label: "Fecha (DD-MM-YYYY)", value: "${!date:dd-MM-yyyy}" },
];

function VarPicker({ onSelect }: { onSelect: (v: string) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button onClick={() => setOpen(!open)} title="Insertar variable especial"
        style={{ width:24, height:24, padding:0, borderRadius:4, border:"1px solid #cbd5e1", background:"#f8fafc", cursor:"pointer", fontSize:"0.65rem", fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", color:"#64748b" }}>
        {`{ }`}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1000 }} />
          <div style={{ position: "absolute", top: "100%", right: 0, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 6, zIndex: 1001, boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)", width: 220, maxHeight: 250, overflow: "auto", marginTop:4 }}>
            <div style={{ padding:"8px 12px", fontSize:"0.65rem", fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.05em", borderBottom:"1px solid #f1f5f9" }}>Variables de Sistema</div>
            {SPECIAL_VARS.map(v => (
              <div key={v.value} onClick={() => { onSelect(v.value); setOpen(false); }} 
                style={{ padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid #f8fafc" }} 
                onMouseOver={e=>e.currentTarget.style.background="#f1f5f9"} onMouseOut={e=>e.currentTarget.style.background="#fff"}>
                <div style={{ fontSize: "0.75rem", fontWeight: 600, color:"#1e293b" }}>{v.label}</div>
                <div style={{ color: "#0ea5e9", fontSize: "0.65rem", fontFamily:"monospace" }}>{v.value}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function padStr(s: string, w: number, a: Align): string {
  if (a==="center") { const lp = Math.max(0,Math.floor((w-s.length)/2)); return " ".repeat(lp)+s.substring(0,w); }
  if (a==="right")  return s.substring(0,w).padStart(w);
  return s.substring(0,w).padEnd(w);
}

function parseCommands(text: string): string {
  const d = new Date();
  let processed = text
    .replace(/\${DATE}/g, d.toLocaleDateString())
    .replace(/\${TIME}/g, d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    .replace(/\${NOW}/g, d.toLocaleString())
    .replace(/\${YEAR}/g, d.getFullYear().toString())
    .replace(/\${MONTH}/g, (d.getMonth() + 1).toString().padStart(2, '0'))
    .replace(/\${DAY}/g, d.getDate().toString().padStart(2, '0'));
  
  // Implicit bold: **text** -> *text* (for preview representation)
  // In real ticket printing this would be handled by the engine, 
  // here we just mark it for preview.
  return processed;
}

// ─── Variable Extraction ─────────────────────────────────────────────────────
function extractVars(blocks: Block[]): string[] {
  const vars = new Set<string>();
  const re = /\${([^}]+)}/g;
  
  const process = (s: string) => {
    let match;
    while ((match = re.exec(s)) !== null) {
      vars.add(match[1]);
    }
  };

  for (const b of blocks) {
    if (b.type === "text") process(b.text);
    if (b.type === "total") { process(b.label); process(b.value); }
    if (b.type === "qr") process(b.content);
    if (b.type === "if") process(b.text);
    if (b.type === "ifelse") { process(b.thenText); process(b.elseText); }
    if (b.type === "each") {
      b.columns.forEach(c => { process(c.field); process(c.label); });
      if (b.childField) vars.add(b.childField);
    }
  }
  
  // Remove special/built-in vars and anything starting with '!'
  const builtIn = ["DATE", "TIME", "NOW", "YEAR", "MONTH", "DAY"];
  builtIn.forEach(v => vars.delete(v));
  
  return Array.from(vars).filter(v => !v.startsWith("!"));
}

function renderTextWithStyles(text: string, bold: boolean, size: FontSize): React.ReactNode {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ fontSize: size === 'normal' ? 'inherit' : (size === 'medium' ? '1.1em' : (size === 'large' ? '1.3em' : '1.5em')) }}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i} style={{ 
      fontWeight: bold ? 700 : 400,
      fontSize: size === 'normal' ? 'inherit' : (size === 'medium' ? '1.1em' : (size === 'large' ? '1.3em' : '1.5em')),
      textTransform: size === 'extra-large' ? 'uppercase' : 'none'
    }}>{part}</span>;
  });
}

function BlockPreviewItem({ block, cols }: { block: Block; cols: number }) {
  const CHIP = (label: string, color: string) => (
    <span style={{ display:"inline-block", padding:"1px 6px", borderRadius:3, fontSize:"0.65rem", fontWeight:700,
      background:color+"22", color, border:`1px solid ${color}44`, marginBottom:2, ...MONO }}>{label}</span>
  );

  switch (block.type) {
    case "text": {
      const txt = parseCommands(block.text);
      return <span style={{ ...PREVIEW_ROW, textAlign: block.align }}>{renderTextWithStyles(txt, block.bold, block.size)}</span>;
    }
    case "separator": return <span style={PREVIEW_ROW}>{block.char.repeat(cols)}</span>;
    case "total": {
      const v = block.value, l = block.label.substring(0, cols-v.length-1);
      return <span style={PREVIEW_ROW}>{(block.bold?"*":"")+l.padEnd(cols-v.length)+v+(block.bold?"*":"")}</span>;
    }
    case "qr": {
      const sz = Math.min(block.qrSize, 120);
      const align = block.align==="center"?"center":block.align==="right"?"flex-end":"flex-start";
      return <div style={{ display:"flex", justifyContent:align, padding:"4px 0" }}><QrImage content={block.content} size={sz} /></div>;
    }
    case "feed": return <><br/>{block.lines>1&&<br/>}</>;
    case "cut":  return <span style={PREVIEW_ROW}>{"─".repeat(cols)+" ✂"}</span>;
    case "beep": return CHIP("BEEP","#f59e0b");
    case "open-drawer": return CHIP("ABRIR CAJÓN","#8b5cf6");
    case "if":
      return (
        <div style={{ border:"1px dashed #0ea5e9", borderRadius:3, padding:"2px 4px", marginBlock:1 }}>
          {CHIP(`IF: ${block.expr}`, "#0ea5e9")}
          <span style={PREVIEW_ROW}>{padStr(block.bold?`*${block.text}*`:block.text, cols, block.align)}</span>
        </div>
      );
    case "ifelse":
      return (
        <div style={{ border:"1px dashed #0ea5e9", borderRadius:3, padding:"2px 6px", marginBlock:1 }}>
          {CHIP(`IF/ELSE: ${block.expr}`, "#0ea5e9")}
          <span style={{ ...PREVIEW_ROW, color:"#16a34a" }}>✓ {padStr(block.thenText,cols,block.align)}</span>
          <span style={{ ...PREVIEW_ROW, color:"#dc2626" }}>✗ {padStr(block.elseText,cols,block.align)}</span>
        </div>
      );
    case "each": {
      const colWidths = calcColWidths(block.columns, cols);
      
      const headerRow = block.showHeader ? (
        <div style={{ display: "flex", borderBottom: "1px solid #eee", paddingBottom: 2, marginBottom: 2 }}>
          {block.columns.map((c, i) => (
            <div key={i} style={{ width: `${(colWidths[i] / cols) * 100}%`, textAlign: c.align, fontWeight: 700, fontSize: '0.7rem' }}>
              {c.label}
            </div>
          ))}
        </div>
      ) : null;

      const indentX = block.childIndentCol ? (block.columns.slice(0, block.childIndentCol).reduce((s, c, i) => s + colWidths[i], 0) + block.childIndentCol) * 8 : 20;

      return (
        <div style={{ display:"flex", flexDirection:"column", width: "100%" }}>
          {headerRow}
          <div style={{ display: "flex" }}>
            {block.columns.map((c, i) => (
              <div key={i} style={{ 
                width: `${(colWidths[i] / cols) * 100}%`, 
                textAlign: c.align,
                fontWeight: c.bold ? 700 : 400,
                fontSize: c.size === 'large' ? '1rem' : (c.size === 'medium' ? '0.85rem' : '0.75rem')
              }}>
                {renderTextWithStyles(c.field === "QTY" ? "1" : (c.field === "DESC" ? "**Item** Demo" : "0.00"), c.bold||false, c.size||"normal")}
              </div>
            ))}
          </div>
          {block.childField && (
            <div style={{ paddingLeft: indentX, fontSize: '0.7rem', color: '#666', borderLeft: '2px solid #eee', marginLeft: 4 }}>
              <div>{renderTextWithStyles(`- Subitem 1`, false, "normal")}</div>
              <div>{renderTextWithStyles(`- Subitem 2 (Separado por coma)`, false, "normal")}</div>
            </div>
          )}
        </div>
      );
    }
    default: return null;
  }
}

function TicketPreview({ blocks, cols }: { blocks: Block[]; cols: number }) {
  return (
    <div className="ticketPreviewArea" style={{ fontFamily:"'Courier New',Courier,monospace", fontSize:"0.78rem", background:"#fff", color:"#111",
      padding:"1rem 1.1rem", borderRadius:3, whiteSpace:"pre", lineHeight:1.55, minWidth:`${cols}ch`,
      display:"inline-block", boxShadow:"0 2px 12px rgba(0,0,0,0.14),0 1px 3px rgba(0,0,0,0.07)" }}>
      {blocks.length === 0
        ? <span style={{ color:"#aaa" }}>(tiquete vacío)</span>
        : blocks.map(b => <BlockPreviewItem key={b.id} block={b} cols={cols} />)
      }
    </div>
  );
}

// ─── Palette ──────────────────────────────────────────────────────────────────
const PALETTE: { label: string; icon: string; cat: string; factory: () => Block }[] = [
  { label:"Texto",      icon:"T",  cat:"contenido",  factory:()=>({ id:uid(), type:"text",      text:"Texto aquí",  align:"center",  bold:false, size:"normal" }) },
  { label:"Separador",  icon:"—",  cat:"contenido",  factory:()=>({ id:uid(), type:"separator", char:"-" }) },
  { label:"Total",      icon:"Σ",  cat:"contenido",  factory:()=>({ id:uid(), type:"total",     label:"TOTAL", value:"${TOTAL}", bold:true }) },
  { label:"QR",         icon:"▣",  cat:"contenido",  factory:()=>({ id:uid(), type:"qr",        content:"${URL}", align:"center", qrSize:80 }) },
  { label:"Lista (each)",icon:"⟳", cat:"control",    factory:()=>({ id:uid(), type:"each",      listVar:"ITEMS",  showHeader:true, columns:[
    { field:"DESC",  label:"Descripción", width:"auto", align:"left" },
    { field:"QTY",   label:"Cant",        width:6,      align:"right" },
    { field:"TOTAL", label:"Total",       width:10,     align:"right" },
  ] }) },
  { label:"Si (if)",    icon:"?",  cat:"control",    factory:()=>({ id:uid(), type:"if",        expr:"${COND}", text:"${VAR}", bold:false, align:"left" }) },
  { label:"Si/No (ifelse)",icon:"⇄", cat:"control",  factory:()=>({ id:uid(), type:"ifelse",   expr:"${COND}", thenText:"Sí", elseText:"No", align:"left" }) },
  { label:"Avance",     icon:"↓",  cat:"acción",     factory:()=>({ id:uid(), type:"feed",      lines:2 }) },
  { label:"Corte",      icon:"✂",  cat:"acción",     factory:()=>({ id:uid(), type:"cut" }) },
  { label:"Beep",       icon:"🔔", cat:"acción",     factory:()=>({ id:uid(), type:"beep" }) },
  { label:"Caja",       icon:"💰", cat:"acción",     factory:()=>({ id:uid(), type:"open-drawer" }) },
];

const ICON_MAP:  Record<string,string> = { text:"T", separator:"—", total:"Σ", qr:"▣", each:"⟳", if:"?", ifelse:"⇄", feed:"↓", cut:"✂", beep:"🔔", "open-drawer":"💰" };
const LABEL_MAP: Record<string,string> = { text:"Texto", separator:"Separador", total:"Total", qr:"QR", each:"Lista", if:"Si", ifelse:"Si/No", feed:"Avance", cut:"Corte", beep:"Beep", "open-drawer":"Caja" };

// ─── Property fields ───────────────────────────────────────
const INP: React.CSSProperties  = { display:"block", width:"100%", marginTop:"0.2rem", padding:"0.6rem 0.75rem", border:"1px solid var(--border,#cbd5e1)", borderRadius:8, fontSize:"0.85rem", background:"#f8fafc", boxSizing:"border-box", transition: "all 0.2s" };
const MINI: React.CSSProperties = { padding:"4px 10px", fontSize:"0.74rem", border:"1px solid var(--border,#cbd5e1)", borderRadius:6, cursor:"pointer", background:"var(--surface-alt, #f8fafc)", color: "var(--text)", fontWeight:600 };

function ColRow({ col, idx, onChange, onDelete, onDragStart, onDragOver, onDrop }:
  { 
    col:EachColumn; idx:number; onChange:(c:EachColumn)=>void; onDelete:()=>void;
    onDragStart: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: () => void;
  }) {
  const [isDragOver, setIsDragOver] = useState(false);
  const u = (p: Partial<EachColumn>) => onChange({ ...col, ...p });
  return (
    <div 
      className="ticketColRow"
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); onDragOver(e); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={() => { setIsDragOver(false); onDrop(); }}
      style={{ 
        border: isDragOver ? "2px solid var(--primary,#16a34a)" : "1px solid var(--border,#e2e8f0)", 
        borderRadius:6, padding:"0.5rem", background:"#f8fafc", marginBottom:"0.5rem",
        cursor:"grab", transition: "all 0.15s", opacity: isDragOver ? 0.6 : 1,
        boxShadow: isDragOver ? "0 4px 6px rgba(0,0,0,0.05)" : "none"
      }}>
      <div style={{ display:"flex", gap:"0.3rem", marginBottom:"0.4rem", alignItems:"center" }}>
        <span style={{ fontSize:"0.8rem", color:"var(--muted,#64748b)", marginRight:"4px" }}>☰</span>
        <span style={{ flex:1, fontSize:"0.74rem", fontWeight:700, color:"var(--text,#1e293b)" }}>Col {idx+1}: {col.label || col.field}</span>
        <button onClick={onDelete} style={{ ...MINI, color:"#dc2626", borderColor:"#fca5a5", padding:"2px 6px" }}>✕</button>
      </div>
      <label style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.4rem" }}>
        <div>
          <span style={{ fontSize:"0.7rem", color:"var(--muted,#64748b)", fontWeight:500 }}>Campo</span>
          <input style={INP} value={col.field}  onChange={e=>u({field:e.target.value})}  placeholder="FIELD" />
        </div>
        <div>
          <span style={{ fontSize:"0.7rem", color:"var(--muted,#64748b)", fontWeight:500 }}>Etiqueta</span>
          <input style={INP} value={col.label}  onChange={e=>u({label:e.target.value})}  placeholder="Columna" />
        </div>
        <div>
          <span style={{ fontSize:"0.7rem", color:"var(--muted,#64748b)", fontWeight:500 }}>Ancho</span>
          <input style={INP} value={col.width}  onChange={e=>u({width:e.target.value==="auto"?"auto":parseInt(e.target.value)||"auto"})} placeholder="auto" />
        </div>
        <div>
          <span style={{ fontSize:"0.7rem", color:"var(--muted,#64748b)", fontWeight:500 }}>Alineación</span>
          <select style={{ ...INP, fontFamily:"system-ui" }} value={col.align} onChange={e=>u({align:e.target.value as Align})}>
            {["left","center","right"].map(o=><option key={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <span style={{ fontSize:"0.7rem", color:"var(--muted,#64748b)", fontWeight:500 }}>Tamaño</span>
          <select style={{ ...INP, fontFamily:"system-ui" }} value={col.size || "normal"} onChange={e=>u({size:e.target.value as FontSize})}>
            {["normal","medium","large"].map(o=><option key={o}>{o}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label className="toggleLabel" style={{ padding: "0.25rem 0" }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Negrita</span>
            <div style={{ position: 'relative' }}>
              <input type="checkbox" className="toggleInput" id={`col-bold-${idx}`}
                checked={col.bold||false} onChange={e=>u({bold:e.target.checked})}/>
              <label htmlFor={`col-bold-${idx}`} className="toggleTrack">
                <div className="toggleThumb"></div>
              </label>
            </div>
          </label>
        </div>
      </label>
      <label style={{ fontSize:"0.7rem", color:"var(--muted,#64748b)", marginTop:"0.4rem", display:"block", fontWeight:500 }}>
        Condición (showIf)
        <input style={INP} value={col.showIf??""} onChange={e=>u({showIf:e.target.value||undefined})} placeholder="${COND}" />
      </label>
    </div>
  );
}

function PrinterSelectorBtn({ value, onOpen }: { value: string; onOpen: () => void }) {
  const selected = value.split(",").map(v => v.trim()).filter(Boolean);
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: "5px",
        padding: "4px 10px 4px 8px", borderRadius: 8,
        border: "1px solid var(--border,#cbd5e1)",
        background: "#f8fafc", cursor: "pointer",
        fontSize: "0.8rem", fontWeight: 600, color: "#475569",
        maxWidth: 300, minWidth: 120,
        transition: "all 0.15s",
        boxShadow: "none"
      }}
      className="ticketPrinterBtn"
      onMouseOver={e => { e.currentTarget.style.borderColor = "var(--accent,#0f766e)"; e.currentTarget.style.background = "var(--surface-alt, #f0fdf4)"; }}
      onMouseOut={e => { e.currentTarget.style.borderColor = "var(--border,#cbd5e1)"; e.currentTarget.style.background = "var(--surface-alt, #f8fafc)"; }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
        <polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>
      </svg>
      {selected.length === 0
        ? <span style={{ color: "#94a3b8", fontWeight: 400 }}>Seleccionar...</span>
        : selected.map(s => (
            <span key={s} style={{ background: "var(--accent,#0f766e)", color: "#fff", padding: "1px 7px", borderRadius: 10, fontSize: "0.68rem", fontWeight: 700 }}>{s}</span>
          ))
      }
    </button>
  );
}


function PropsPanel({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  const L: React.CSSProperties = { display:"block", marginBottom:"0.6rem", fontSize:"0.82rem", fontWeight:600, color:"var(--text,#0f172a)" };
  const I: React.CSSProperties = INP;
  const S: React.CSSProperties = { ...INP, fontFamily:"system-ui" };

  type SS = (v: string)  => Block;
  type SB = (v: boolean) => Block;
  const inp = (val: string,  s: SS, ph?: string) => (
    <div style={{ display:"flex", gap:6, alignItems:"center", marginTop:"0.25rem" }}>
      <input style={{ ...I, flex:1 }} value={val} placeholder={ph} onChange={e=>onChange(s(e.target.value))} />
      <VarPicker onSelect={v => onChange(s((val || "") + v))} />
    </div>
  );
  const sel = (val: string,  s: SS, opts: string[]) => <select style={{ ...S, marginTop:"0.25rem" }} value={val} onChange={e=>onChange(s(e.target.value))}>{opts.map(o=><option key={o}>{o}</option>)}</select>;
  const chk = (val: boolean, s: SB, lbl: string)   => (
    <label className="toggleLabel" style={{ marginTop: '0.4rem' }}>
      <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{lbl}</span>
      <div style={{ position: 'relative' }}>
        <input type="checkbox" className="toggleInput" id={`prop-chk-${lbl}`}
          checked={val} onChange={e=>onChange(s(e.target.checked))}/>
        <label htmlFor={`prop-chk-${lbl}`} className="toggleTrack">
          <div className="toggleThumb"></div>
        </label>
      </div>
    </label>
  );
  const f   = (label: string, node: React.ReactNode) => <label style={L}>{label}{node}</label>;

  const ShowIfField = () => (
    <div style={{ marginTop:"0.75rem", paddingTop:"0.5rem", borderTop:"1px dashed var(--border,#e2e8f0)" }}>
      <label style={{ ...L, color:"var(--muted,#64748b)", fontWeight:400 }}>
        Mostrar si (condición)
        <input style={I} value={("showIf" in block ? block.showIf : "") ?? ""} placeholder="${COND}" onChange={e => onChange({ ...block, showIf: e.target.value || undefined } as Block)} />
      </label>
    </div>
  );

  switch (block.type) {
    case "text": return (<div style={{ display:"grid", gap:"0.35rem" }}>
      {f("Contenido",  inp(block.text,  v=>({...block,text:v}),  "Texto o ${VAR}"))}
      {f("Alineación", sel(block.align, v=>({...block,align:v as Align}),  ["left","center","right"]))}
      {f("Tamaño",     sel(block.size,  v=>({...block,size:v as FontSize}), ["normal","medium","large","extra-large"]))}
      {chk(block.bold, v=>({...block,bold:v}), "Negrita")}
      <ShowIfField/>
    </div>);
    case "separator": return (<div>{f("Carácter", inp(block.char, v=>({...block,char:v}), "-"))}<ShowIfField/></div>);
    case "total": return (<div style={{ display:"grid", gap:"0.35rem" }}>
      {f("Etiqueta", inp(block.label, v=>({...block,label:v}), "TOTAL"))}
      {f("Valor",    inp(block.value, v=>({...block,value:v}), "${TOTAL}"))}
      {chk(block.bold, v=>({...block,bold:v}), "Negrita")}
      <ShowIfField/>
    </div>);
    case "qr": return (<div style={{ display:"grid", gap:"0.35rem" }}>
      {f("Contenido",  inp(block.content, v=>({...block,content:v}), "${URL}"))}
      {f("Alineación", sel(block.align,   v=>({...block,align:v as Align}), ["left","center","right"]))}
      {f("Tamaño px",  <input type="number" style={{ ...I, fontFamily:"system-ui" }} min={32} max={200} step={8} value={block.qrSize} onChange={e=>onChange({...block,qrSize:parseInt(e.target.value)||80})}/>)}
      <ShowIfField/>
    </div>);
    case "feed": return (<div>{f("Líneas", <input type="number" style={{ ...I, fontFamily:"system-ui" }} min={1} max={10} value={block.lines} onChange={e=>onChange({...block,lines:parseInt(e.target.value)||1})}/>)}<ShowIfField/></div>);
    case "if": return (<div style={{ display:"grid", gap:"0.35rem" }}>
      {f("Condición", inp(block.expr, v=>({...block,expr:v}), "${VAR}"))}
      {f("Texto si verdadero", inp(block.text, v=>({...block,text:v}), "Texto o ${VAR}"))}
      {f("Alineación", sel(block.align, v=>({...block,align:v as Align}), ["left","center","right"]))}
      {chk(block.bold, v=>({...block,bold:v}), "Negrita")}
      <ShowIfField/>
    </div>);
    case "ifelse": return (<div style={{ display:"grid", gap:"0.35rem" }}>
      {f("Condición", inp(block.expr, v=>({...block,expr:v}), "${VAR}"))}
      {f("Si verdadero (then)", inp(block.thenText, v=>({...block,thenText:v}), "Texto verdadero"))}
      {f("Si falso (else)",    inp(block.elseText, v=>({...block,elseText:v}),  "Texto falso"))}
      {f("Alineación", sel(block.align, v=>({...block,align:v as Align}), ["left","center","right"]))}
      <ShowIfField/>
    </div>);
    case "each": {
      const [draggedColIdx, setDraggedColIdx] = useState<number | null>(null);
      const update = (p: Partial<EachBlock>) => onChange({ ...block, ...p });
      const updateCol = (i: number, c: EachColumn) => update({ columns: block.columns.map((x,j)=>j===i?c:x) });
      const moveCol   = (from: number, to: number) => {
        if (from === to) return;
        const arr = [...block.columns];
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
        update({ columns: arr });
      };
      const addCol = () => update({ columns: [...block.columns, { field:"CAMPO", label:"Campo", width:"auto", align:"left" }] });
      return (
        <div style={{ display:"grid", gap:"0.4rem" }}>
          {f("Variable lista", <input style={I} value={block.listVar} onChange={e=>update({listVar:e.target.value})} placeholder="ITEMS"/>)}
          {f("Campo de Sub-items (extras)", <input style={I} value={block.childField || ""} onChange={e=>update({childField:e.target.value || undefined})} placeholder="EXTRAS"/>)}
          <label style={L}>Mapear extras a columna (índice)
             <input type="number" min={0} max={Math.max(0, block.columns.length-1)} style={I} value={block.childIndentCol || 0} onChange={e=>update({childIndentCol:parseInt(e.target.value)||0})}/>
             <span style={{ fontSize:"0.65rem", color:"#94a3b8" }}>La indentación será relativa a esta columna</span>
          </label>
          <label style={{ display:"flex",gap:"0.4rem",alignItems:"center",fontSize:"0.79rem",cursor:"pointer" }}>
            <input type="checkbox" checked={block.showHeader} onChange={e=>update({showHeader:e.target.checked})}/> Mostrar encabezados
          </label>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:"0.3rem" }}>
            <span style={{ fontSize:"0.72rem", fontWeight:700, color:"var(--muted,#64748b)", textTransform:"uppercase", letterSpacing:"0.06em" }}>Columnas</span>
            <button onClick={addCol} style={{ ...MINI, color:"var(--primary,#16a34a)", borderColor:"var(--primary,#16a34a)", fontWeight:600 }}>+ Agregar</button>
          </div>
          {block.columns.map((c,i)=>(
            <ColRow key={i} col={c} idx={i} 
              onChange={nc=>updateCol(i,nc)}
              onDelete={()=>update({columns:block.columns.filter((_,j)=>j!==i)})}
              onDragStart={() => setDraggedColIdx(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (draggedColIdx !== null) moveCol(draggedColIdx, i);
                setDraggedColIdx(null);
              }}
            />
          ))}
          <ShowIfField/>
        </div>
      );
    }
    default: return null;
  }
}

function BlockRow({ 
    block, selected, onSelect, onDelete, 
    onDragStart, onDragOver, onDrop 
  }: { 
    block:Block; selected:boolean; onSelect:()=>void; onDelete:()=>void;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  }) {
  const [isDragOver, setIsDragOver] = useState(false);

  const preview = (() => {
    switch (block.type) {
      case "text":      return block.text.substring(0,36);
      case "separator": return block.char.repeat(12);
      case "total":     return `${block.label}: ${block.value}`;
      case "qr":        return `QR: ${block.content.substring(0,18)}`;
      case "each":      return `⟳ ${block.listVar} (${block.columns.length} cols)`;
      case "if":        return `? ${block.expr}`;
      case "ifelse":    return `⇄ ${block.expr}`;
      case "feed":      return `↓ ${block.lines} línea(s)`;
      default:          return LABEL_MAP[block.type] ?? block.type;
    }
  })();

  const catColor: Record<string,string> = { each:"#f59e0b", if:"#0ea5e9", ifelse:"#0ea5e9", cut:"#94a3b8", beep:"#94a3b8", "open-drawer":"#94a3b8" };
  const icolor = catColor[block.type] ?? "inherit";

  return (
    <div 
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
        onDragOver(e);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        setIsDragOver(false);
        onDrop(e);
      }}
      onClick={onSelect} 
      className={`ticketBlockRow ${selected ? 'selected' : ''}`}
      style={{
        display:"flex", alignItems:"center", gap:"0.5rem", padding:"0.5rem 0.6rem",
        background: selected ? "var(--primary,#16a34a)" : "#fff",
        color: selected ? "#fff" : "var(--text,#1e293b)",
        borderRadius:6, cursor:"grab",
        border: selected ? "1px solid var(--primary,#16a34a)" : "1px solid var(--border,#cbd5e1)",
        borderBottom: isDragOver ? "3px solid var(--primary,#16a34a)" : undefined,
        transition:"all 0.15s", userSelect:"none", marginBottom:"0.3rem",
        boxShadow: selected ? "0 2px 4px rgba(22,163,74,0.15)" : "none",
        opacity: isDragOver ? 0.7 : 1
      }}>
      <span style={{ width:"1.3rem", textAlign:"center", fontSize:"0.9rem", color:selected?"#fff":icolor }}>
        ☰
      </span>
      <span style={{ width:"1.2rem", textAlign:"center", fontSize:"0.8rem", opacity:0.8, color:selected?"inherit":icolor }}>{ICON_MAP[block.type]??"•"}</span>
      <span style={{ flex:1, fontSize:"0.76rem", fontFamily:"monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{preview}</span>
      <button onClick={e=>{e.stopPropagation();onDelete();}} style={{ background:"transparent", border:"none", cursor:"pointer", color:selected?"#fff":"#ef4444", fontSize:"1rem", fontWeight:800, padding: "0 4px" }}>×</button>
    </div>
  );
}

const SH = ({ c }: { c: React.ReactNode }) => (
  <p style={{ fontSize:"0.68rem", fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase",
    color:"var(--muted,#64748b)", margin:"0 0 0.5rem", borderBottom:"1px solid var(--border,#e2e8f0)", paddingBottom:"0.3rem" }}>
    {c}
  </p>
);

const CAT_COLOR: Record<string,string> = { contenido:"#16a34a", control:"#0ea5e9", acción:"#94a3b8" };
function PaletteBtn({ item, onClick }: { item: typeof PALETTE[0]; onClick: ()=>void }) {
  const [hover, setHover] = useState(false);
  const c = CAT_COLOR[item.cat]??"#64748b";
  return (
    <button onClick={onClick}
      onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      className="ticketPaletteBtn"
      style={{ display:"flex", alignItems:"center", gap:"0.5rem", padding:"0.38rem 0.5rem",
        background: hover ? `${c}12` : "#fff",
        border: hover ? `1px solid ${c}66` : "1px solid var(--border,#e2e8f0)",
        borderRadius:5, cursor:"pointer", fontSize:"0.79rem", textAlign:"left", width:"100%",
        color:"var(--text,#1e293b)", transition:"all 0.1s", marginBottom:"0.2rem" }}>
      <span style={{ width:"1.2rem", textAlign:"center", color:c, fontWeight:700 }}>{item.icon}</span>
      {item.label}
    </button>
  );
}

// ─── Main Designer ────────────────────────────────────────────────────────────
export default function TicketDesigner({ initialXml, onUpdate, apiBaseUrl }: TicketDesignerProps) {
  const init = useMemo(() => initialXml ? xmlToBlocks(initialXml) : { blocks: [], width: 80, printers: "" }, [initialXml]);
  
  // ─── States ────────────────────────────────────────────────────────────────
  const [blocks, setBlocks]         = useState<Block[]>(init.blocks);
  const [width, setWidth]           = useState<number>(init.width);
  const [printers, setPrinters]     = useState<string>(init.printers);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggedId, setDraggedId]   = useState<string | null>(null);

  // Print Modal States
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [showHelpModal, setShowHelpModal]   = useState(false);
  const [isPrinting, setIsPrinting]         = useState(false);
  const [printData, setPrintData]           = useState<Record<string, string>>({});
  const [printDataList, setPrintDataList]   = useState<Record<string, string>[]>([]);
  const [printTab, setPrintTab]             = useState<"manual" | "batch">("manual");
  const [availableLogicalPrinters, setAvailableLogicalPrinters] = useState<LogicalPrinterDto[]>([]);

  // History States
  const [history, setHistory]     = useState<Block[][]>([]);
  const [redoStack, setRedoStack] = useState<Block[][]>([]);
  const [isPrinterSelectorOpen, setIsPrinterSelectorOpen] = useState(false);
  const [printerSearch, setPrinterSearch] = useState("");

  // ─── Memos & Helpers ────────────────────────────────────────────────────────
  const cols = width === 58 ? 32 : 42;
  const selected = blocks.find(b => b.id === selectedId) ?? null;
  const detectedVars = useMemo(() => extractVars(blocks), [blocks]);
  const listVars = useMemo(() => {
    const sets = new Set<string>();
    blocks.forEach(b => { if(b.type === "each") sets.add(b.listVar); });
    return Array.from(sets);
  }, [blocks]);

  // ─── Callbacks ──────────────────────────────────────────────────────────────
  const pushHistory = useCallback((current: Block[]) => {
    setHistory(h => {
      const next = [...h, current];
      if (next.length > 30) return next.slice(1);
      return next;
    });
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setRedoStack(r => [blocks, ...r]);
    setHistory(h => h.slice(0, h.length - 1));
    setBlocks(prev);
  }, [blocks, history]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[0];
    setHistory(h => [...h, blocks]);
    setRedoStack(r => r.slice(1));
    setBlocks(next);
  }, [blocks, redoStack]);

  const handlePrint = useCallback(() => {
    const initialData: Record<string, string> = {};
    detectedVars.forEach(v => { initialData[v] = ""; });
    setPrintData(initialData);
    if (printDataList.length === 0) setPrintDataList([{}]);
    setShowPrintModal(true);
  }, [detectedVars, printDataList.length]);

  // ─── Effects ────────────────────────────────────────────────────────────────
  // Sync with XML
  useEffect(() => {
    onUpdate(blocksToXml(blocks, width, printers));
  }, [blocks, width, printers, onUpdate]);

  // Load logical printers
  useEffect(() => {
    labelsApi.getLogicalPrinters().then(setAvailableLogicalPrinters).catch(console.error);
  }, [apiBaseUrl]);

  // Global Shortcuts & Events
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); }
    };
    window.addEventListener("keydown", handleKey);
    
    const handleTriggerPrint = () => {
      console.log("TicketDesigner: ticket-trigger-print received");
      handlePrint();
    };
    window.addEventListener("ticket-trigger-print", handleTriggerPrint);

    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("ticket-trigger-print", handleTriggerPrint);
    };
  }, [undo, redo, handlePrint]);

  const executePrint = async () => {
    if (!printers) { alert("Selecciona al menos una impresora"); return; }
    setIsPrinting(true);
    try {
      const xml = blocksToXml(blocks, width, printers);
      const firstPrinter = printers.split(",")[0].trim();
      
      let finalData = { ...printData };
      let finalDataList: Record<string, string>[] | undefined = printDataList;

      if (printTab === "manual") {
        // Flatten list data for each 'each' block detected
        // Note: For now we assume a single table that fills all each blocks
        // or the user only has one each block (common case)
        listVars.forEach(lv => {
          printDataList.forEach((row, idx) => {
            Object.entries(row).forEach(([f, v]) => {
              finalData[`${lv}_${idx}_${f}`] = v;
            });
          });
          finalData[`${lv}_COUNT`] = String(printDataList.length);
        });
        // In manual mode, we send a single document
        finalDataList = undefined;
      }

      const payload = {
        xml,
        printerName: firstPrinter,
        copies: 1,
        data: finalData,
        dataList: finalDataList
      };

      console.log("🚀 Enviando petición de impresión de tiquete:", payload);

      await labelsApi.print(payload);
      
      setShowPrintModal(false);
      alert("Comando de impresión enviado");
    } catch (err) {
      alert("Error al imprimir: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsPrinting(false);
    }
  };

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(sheet) as Record<string, any>[];
        
        if (json.length > 0) {
          // Flatten row data
          const list = json.map(row => {
            const entry: Record<string, string> = {};
            Object.entries(row).forEach(([k, v]) => { entry[k] = String(v); });
            return entry;
          });
          setPrintDataList(list);
          setPrintTab("batch");
        }
      } catch (err) {
        alert("Error al procesar Excel: " + (err instanceof Error ? err.message : String(err)));
      }
    };
    reader.readAsBinaryString(file);
  };

  const addBlock = useCallback((factory: ()=>Block) => {
    pushHistory(blocks);
    const nb = factory();
    setBlocks(p => [...p, nb]);
    setSelectedId(nb.id);
  }, [blocks, pushHistory]);

  const updateBlock = useCallback((updated: Block) => {
    pushHistory(blocks);
    setBlocks(p => p.map(b => b.id === updated.id ? updated : b));
  }, [blocks, pushHistory]);

  const move = (id: string, d: -1|1) => {
    pushHistory(blocks);
    setBlocks(p => {
      const idx = p.findIndex(b=>b.id===id), ni = idx+d;
      if (ni < 0 || ni >= p.length) return p;
      const a = [...p]; [a[idx],a[ni]] = [a[ni],a[idx]]; return a;
    });
  };
  const del = (id: string) => { 
    pushHistory(blocks);
    setBlocks(p=>p.filter(b=>b.id!==id)); 
    setSelectedId(null); 
  };

  const handleDragStart = (id: string) => {
    setDraggedId(id);
  };

  const handleDrop = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    pushHistory(blocks);
    setBlocks(p => {
      const draggedIdx = p.findIndex(b => b.id === draggedId);
      const targetIdx  = p.findIndex(b => b.id === targetId);
      const newBlocks = [...p];
      const [draggedItem] = newBlocks.splice(draggedIdx, 1);
      newBlocks.splice(targetIdx, 0, draggedItem);
      return newBlocks;
    });
    setDraggedId(null);
  };

  const panelBg = "#ffffff", canvasBg = "#e8eaed";
  const div = "1px solid var(--border,#e2e8f0)";
  const cats = [...new Set(PALETTE.map(p=>p.cat))];

  return (
    <section className="ticketDesignerSection" style={{ flex:1, display:"flex", flexDirection:"column", height:"100%", width:"100%", overflow:"hidden",
      background:canvasBg, color:"var(--text,#1e293b)", fontFamily:"system-ui,sans-serif" }}>

      {/* ─── Print Modal ─── */}
      {showPrintModal && (
        <Portal>
        <div className="modalBackdrop" style={{ zIndex:2100 }}>
          <div className="modalCard" onClick={e=>e.stopPropagation()} style={{ width:"min(95%, 720px)", maxHeight: "90vh", display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '0' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
              Preparar Impresión
            </h3>
            
            <div style={{ flex:1, overflowY:"auto", padding:"1.5rem" }}>
              <div style={{ display:"flex", gap:"1rem", marginBottom:"1.5rem" }}>
                <button onClick={()=>setPrintTab("manual")} 
                  style={{ flex:1, padding:"0.6rem", borderRadius:8, border:"none", fontWeight:600, cursor:"pointer",
                    background: printTab === "manual" ? "#0ea5e9" : "#f1f5f9",
                    color: printTab === "manual" ? "#fff" : "#64748b" }}>Valores Manuales</button>
                <button onClick={()=>setPrintTab("batch")}
                  style={{ flex:1, padding:"0.6rem", borderRadius:8, border:"none", fontWeight:600, cursor:"pointer",
                    background: printTab === "batch" ? "#0ea5e9" : "#f1f5f9",
                    color: printTab === "batch" ? "#fff" : "#64748b" }}>Cargar Excel (Lote)</button>
              </div>

              {printTab === "manual" ? (
                <div style={{ display:"grid", gap:"1.2rem" }}>
                  {detectedVars.length > 0 && (
                    <div>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.8rem" }}>
                        <span style={{ fontWeight:700, fontSize:"0.85rem", color:"#64748b" }}>Variables Simples</span>
                        <button onClick={() => {
                          const val = window.prompt("Valor para todos los campos:");
                          if (val !== null) {
                            const next = { ...printData };
                            detectedVars.forEach(v => next[v] = val);
                            setPrintData(next);
                          }
                        }} style={{ ...MINI, fontSize:"0.65rem" }}>Rellenar Todo</button>
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:"1rem", marginTop:"0.8rem" }}>
                        {detectedVars.map(v => (
                          <label key={v} style={{ display:"flex", flexDirection:"column", gap:"0.5rem", fontSize:"0.8rem", fontWeight:600 }}>
                            {v}:
                            <input type="text" value={printData[v] || ""} 
                              onChange={e => setPrintData({...printData, [v]: e.target.value})}
                              style={{ padding:"0.5rem", borderRadius:6, border:"1px solid #cbd5e1" }} />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {listVars.map(lv => (
                    <div key={lv} style={{ border:"1px solid #e2e8f0", borderRadius:8, padding:"1rem" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.8rem" }}>
                        <span style={{ fontWeight:700, fontSize:"0.85rem" }}>Filas para {lv}</span>
                        <button onClick={() => setPrintDataList([...printDataList, {}])}
                          style={{ fontSize:"0.75rem", padding:"0.3rem 0.6rem", background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:4, cursor:"pointer" }}>+ Agregar Fila</button>
                      </div>
                      <div style={{ overflowX:"auto" }}>
                        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"0.75rem" }}>
                          <thead>
                            <tr style={{ background:"#f8fafc" }}>
                              <th style={{ padding:6, border:"1px solid #e2e8f0" }}>#</th>
                              {(() => {
                                const fields = blocks.filter(b=>b.type==="each" && b.listVar===lv)
                                  .flatMap(b => {
                                    const eb = b as EachBlock;
                                    const f = eb.columns.map(c => c.field);
                                    if (eb.childField) f.push(eb.childField);
                                    return f;
                                  })
                                  .filter((v,i,a)=>a.indexOf(v)===i);
                                return fields.map(f => (
                                  <th key={f} style={{ padding:6, border:"1px solid #e2e8f0" }}>{f}</th>
                                ));
                              })()}
                              <th style={{ width:30, border:"1px solid #e2e8f0" }}></th>
                            </tr>
                          </thead>
                          <tbody>
                            {printDataList.map((row, idx) => (
                              <tr key={idx}>
                                <td style={{ padding:6, border:"1px solid #e2e8f0", textAlign:"center" }}>{idx+1}</td>
                                {(() => {
                                  const fields = blocks.filter(b=>b.type==="each" && b.listVar===lv)
                                    .flatMap(b => {
                                      const eb = b as EachBlock;
                                      const f = eb.columns.map(c => c.field);
                                      if (eb.childField) f.push(eb.childField);
                                      return f;
                                    })
                                    .filter((v,i,a)=>a.indexOf(v)===i);
                                  return fields.map(f => (
                                    <td key={f} style={{ padding:0, border:"1px solid #e2e8f0" }}>
                                      <input type="text" value={row[f] || ""} 
                                        onChange={e => {
                                          const newList = [...printDataList];
                                          newList[idx] = { ...row, [f]: e.target.value };
                                          setPrintDataList(newList);
                                        }}
                                        style={{ width:"100%", border:"none", padding:6, background:"transparent", outline:"none" }} />
                                    </td>
                                  ));
                                })()}
                                <td style={{ border:"1px solid #e2e8f0", textAlign:"center" }}>
                                  <button onClick={() => setPrintDataList(printDataList.filter((_, i) => i !== idx))}
                                    style={{ border:"none", background:"none", cursor:"pointer", color:"#ef4444" }}>&times;</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                  {detectedVars.length === 0 && listVars.length === 0 && (
                    <p style={{ textAlign:"center", color:"#94a3b8", fontSize:"0.9rem", padding:"2rem" }}>Este tiquete no tiene variables detectadas.</p>
                  )}
                </div>
              ) : (
                <div style={{ textAlign:"center", padding:"2rem", border:"2px dashed #e2e8f0", borderRadius:12 }}>
                  <p style={{ margin:"0 0 1rem", fontSize:"0.9rem", color:"#64748b" }}>Carga un archivo Excel para realizar una impresión masiva.</p>
                  <input type="file" accept=".xlsx,.xls" onChange={handleExcelUpload} style={{ fontSize:"0.8rem" }} />
                  {printDataList.length > 1 && (
                    <p style={{ marginTop:"1rem", color:"#16a34a", fontWeight:600 }}>{printDataList.length} registros cargados satisfactoriamente.</p>
                  )}
                </div>
              )}
            </div>

            <div className="modalActions">
              <button className="secondary" onClick={()=>setShowPrintModal(false)}>Cancelar</button>
              <button className="primary" onClick={executePrint} disabled={isPrinting}>
                {isPrinting ? "Enviando..." : "🚀 Enviar a Impresora"}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ─── Help / Documentation Modal ─── */}
      {showHelpModal && (
        <Portal>
        <div className="modalBackdrop" style={{ zIndex: 2100 }}>
          <div className="modalCard" onClick={e=>e.stopPropagation()} style={{ width:"min(95%, 850px)", height:"90vh", display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '0' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
              Guía del Motor de Tiquetes
            </h3>
            <div style={{ flex:1, overflowY:"auto", padding:"2rem", fontSize:"0.9rem", lineHeight:1.6, color:"var(--text)" }}>
              <section style={{ marginBottom:"2rem" }}>
                <h4 style={{ borderBottom:"2px solid var(--border)", paddingBottom:8, color:"var(--text)" }}>🚀 Introducción</h4>
                <p>El motor de tiquetes utiliza <b>XML</b> para definir la estructura del documento. Puedes usar variables <code>{`\${VARIABLE}`}</code> que se sustituyen al imprimir.</p>
              </section>

              <section style={{ marginBottom:"2rem" }}>
                <h4 style={{ borderBottom:"2px solid var(--border)", paddingBottom:8, color:"var(--text)" }}>🗓️ Variables de Sistema (Automáticas)</h4>
                <p>Usa el prefijo <code>!</code> para variables que el servidor rellena automáticamente:</p>
                <ul style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, paddingLeft:20, fontSize:"0.8rem" }}>
                  <li><code>{`\${!date}`}</code>: 2026-03-04</li>
                  <li><code>{`\${!time}`}</code>: 16:30:00</li>
                  <li><code>{`\${!datetime}`}</code>: Fecha y hora</li>
                  <li><code>{`\${!dayname}`}</code>: Miércoles</li>
                  <li><code>{`\${!weekmonth}`}</code>: Semana del mes</li>
                  <li><code>{`\${!weekyear}`}</code>: Semana del año</li>
                </ul>
                
                <h5 style={{ marginTop:15, marginBottom:5, color:"var(--accent)" }}>📅 Formatos de Fecha</h5>
                <table style={{ width:"100%", fontSize:"0.75rem", borderCollapse:"collapse", marginBottom:10 }}>
                  <thead><tr style={{ textAlign:"left", borderBottom:"1px solid var(--border)" }}><th>Formato</th><th>Ejemplo</th><th>Descripción</th></tr></thead>
                  <tbody>
                    <tr><td>dd/MM/yyyy</td><td>04/03/2026</td><td>Día/Mes/Año (Latam)</td></tr>
                    <tr><td>MM/dd/yyyy</td><td>03/04/2026</td><td>Mes/Día/Año (USA)</td></tr>
                    <tr><td>yyyy/MM/dd</td><td>2026/03/04</td><td>Año primero</td></tr>
                    <tr><td>dd-MM-yyyy</td><td>04-03-2026</td><td>Con guiones</td></tr>
                    <tr><td>dddd, dd MMMM yyyy</td><td>miércoles, 04 marzo 2026</td><td>Larga</td></tr>
                    <tr><td>d</td><td>04/03/2026</td><td>Fecha corta (.NET)</td></tr>
                    <tr><td>D</td><td>miércoles, 4 de marzo...</td><td>Fecha larga (.NET)</td></tr>
                  </tbody>
                </table>

                <h5 style={{ marginTop:15, marginBottom:5, color:"var(--accent)" }}>⏰ Formatos de Hora</h5>
                <table style={{ width:"100%", fontSize:"0.75rem", borderCollapse:"collapse", marginBottom:10 }}>
                  <thead><tr style={{ textAlign:"left", borderBottom:"1px solid var(--border)" }}><th>Formato</th><th>Ejemplo</th><th>Descripción</th></tr></thead>
                  <tbody>
                    <tr><td>HH:mm</td><td>14:35</td><td>24 horas</td></tr>
                    <tr><td>hh:mm tt</td><td>02:35 PM</td><td>12 horas</td></tr>
                    <tr><td>HH:mm:ss</td><td>14:35:20</td><td>Con segundos</td></tr>
                    <tr><td>yyyy-MM-ddTHH:mm:ss</td><td>...T14:35:20</td><td>ISO 8601 (Hacienda)</td></tr>
                  </tbody>
                </table>
                <p style={{ fontSize:"0.75rem", fontStyle:"italic" }}><b>Uso:</b> {`\${!date:dd/MM/yyyy}`} o {`\${!date:HH:mm}`}</p>
              </section>

              <section style={{ marginBottom:"2rem" }}>
                <h4 style={{ borderBottom:"2px solid var(--border)", paddingBottom:8, color:"var(--text)" }}>🖋️ Estilos de Texto (Markdown)</h4>
                <p>Puedes aplicar estilos directamente en cualquier campo de texto:</p>
                <ul style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px 20px", paddingLeft:20, fontSize:"0.8rem" }}>
                  <li><code>{`**negrita**`}</code>: <b>Negrita</b></li>
                  <li><code>{`***black***`}</code>: Extra Negrita</li>
                  <li><code>{`##medio##`}</code>: Texto Mediano</li>
                  <li><code>{`###grande###`}</code>: Texto Grande</li>
                  <li><code>{`####extra####`}</code>: Extra Grande</li>
                </ul>
              </section>

              <section style={{ marginBottom:"2rem" }}>
                <h4 style={{ borderBottom:"2px solid var(--border)", paddingBottom:8, color:"var(--text)" }}>🔄 Listas (Bloque Each)</h4>
                <p>Para imprimir tablas de productos:</p>
                <ol style={{ paddingLeft:20 }}>
                  <li>Agrega un bloque <b>Each</b>.</li>
                  <li>Define la <b>Variable Lista</b> (ej: <code>ITEMS</code>).</li>
                  <li>Configura las columnas con sus respectivos campos (ej: <code>DESC</code>, <code>QTY</code>).</li>
                  <li>En el modal de impresión, podrás rellenar la tabla manualmente o cargar un Excel.</li>
                </ol>
              </section>

              <section style={{ marginBottom:"2rem", background:"var(--bg-subtle)", padding:"1rem", borderRadius:8, border:"1px solid var(--border)" }}>
                <h4 style={{ margin:"0 0 10px 0", color:"var(--accent)" }}>💡 Tip Pro: Rellenado Rápido</h4>
                <p style={{ margin:0 }}>En el modal de impresión manual, usa el botón <b>"Rellenar Todo"</b> para poner el mismo valor en todas las variables simples rápidamente.</p>
              </section>
            </div>
            <div className="modalActions">
              <button className="primary" onClick={()=>setShowHelpModal(false)} style={{ padding: '0.6rem 2rem' }}>Entendido</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Internal Toolbar (Ancho) */}
      <div className="ticketToolbar" style={{ display:"flex", alignItems:"center", gap:"0.75rem", padding:"0.6rem 1rem",
        background:panelBg, borderBottom:div, flexShrink:0, boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
        
        <button 
          type="button" 
          className="primary" 
          onClick={handlePrint} 
          disabled={isPrinting}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1.25rem', fontSize: '0.85rem' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          {isPrinting ? "Imprimiendo..." : "Imprimir"}
        </button>

        <div style={{ width:1, height:20, background:"var(--border,#e2e8f0)", margin:"0 0.5rem" }} />
        <label style={{ fontSize:"0.8rem", display:"flex", alignItems:"center", gap:"0.5rem", fontWeight:500 }}>
          Ancho:
          <select value={width} onChange={e=>setWidth(parseInt(e.target.value))}
            style={{ padding:"0.3rem 0.6rem", fontSize:"0.78rem", border:"1px solid var(--border,#cbd5e1)", borderRadius:6, background:"var(--surface-alt, #fff)", color:"var(--text)", cursor:"pointer", fontWeight:600 }}>
            <option value={80}>80 mm (42 ch)</option>
            <option value={58}>58 mm (32 ch)</option>
          </select>
        </label>
        <div style={{ width:1, height:20, background:"var(--border,#e2e8f0)", margin:"0 0.5rem" }} />
        <label style={{ fontSize:"0.8rem", display:"flex", alignItems:"center", gap:"0.5rem", fontWeight:500 }}>
          Impresoras:
          <PrinterSelectorBtn value={printers} onOpen={() => setIsPrinterSelectorOpen(true)} />
        </label>
        
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setShowHelpModal(true)}
          title="Documentación y guía de uso"
          style={{
            ...MINI,
            background: "var(--primary,#16a34a)", color: "#fff",
            border: "none", borderRadius: "50%",
            width: 28, height: 28, padding: 0,
            fontSize: "0.9rem", fontWeight: 800,
            cursor: "help", flexShrink: 0,
            boxShadow: "0 2px 6px rgba(22,163,74,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center"
          }}
        >?</button>
      </div>

      <div style={{ flex:1, display:"grid", gridTemplateColumns:"160px 220px 1fr 380px", overflow:"hidden" }}>
        {/* 1. Palette */}
        <aside className="ticketPalette" style={{ background:panelBg, borderRight:div, overflow:"auto", padding:"0.6rem 0.5rem" }}>
          {cats.map(cat => (
            <div key={cat} style={{ marginBottom:"0.8rem" }}>
              <p style={{ fontSize:"0.63rem", fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:CAT_COLOR[cat]??"#64748b", margin:"0 0 0.3rem", paddingLeft:2 }}>{cat}</p>
              {PALETTE.filter(p=>p.cat===cat).map(item=>(
                <PaletteBtn key={item.label} item={item} onClick={()=>addBlock(item.factory)} />
              ))}
            </div>
          ))}
        </aside>

        {/* 2. Structure */}
        <aside className="ticketStructure" style={{ background:"#f8fafc", borderRight:div, overflow:"auto", padding:"0.6rem 0.6rem" }}>
          <SH c={`Estructura (${blocks.length})`} />
          {blocks.length === 0 && (
            <div style={{ padding:"1.2rem", textAlign:"center", color:"var(--muted,#64748b)", fontSize:"0.72rem", background:"#fff", borderRadius:6, border:"1px dashed var(--border,#cbd5e1)" }}>
              ← Agrega bloques
            </div>
          )}
          {blocks.map(b=>(
            <BlockRow key={b.id} block={b} selected={b.id===selectedId}
              onSelect={()=>setSelectedId(b.id)}
              onDelete={()=>del(b.id)}
              onDragStart={() => handleDragStart(b.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(b.id)}
            />
          ))}
        </aside>

        {/* 3. Preview */}
        <main className="ticketCanvasArea" style={{ flex:1, overflow:"auto", padding:"1.5rem", display:"flex", flexDirection:"column", alignItems:"center", background:canvasBg }}>
           <TicketPreview blocks={blocks} cols={cols} />
        </main>

        {/* 4. Properties */}
        <aside className="ticketProperties" style={{ background:panelBg, borderLeft:div, overflow:"auto", padding:"0.8rem 1.2rem", boxShadow:"-2px 0 8px rgba(0,0,0,0.02)" }}>
          <SH c="Propiedades" />
          {selected
            ? <PropsPanel block={selected} onChange={updateBlock} />
            : <div style={{ color:"var(--muted,#94a3b8)", fontSize:"0.78rem", textAlign:"center", paddingTop:"4rem" }}>
                <div style={{ fontSize:"1.5rem", marginBottom:"0.5rem", opacity:0.5 }}>⚙️</div>
                Selecciona un bloque
              </div>
          }
        </aside>
      </div>

      {/* ─── Printer Selection Modal (Top-level) ─── */}
      {isPrinterSelectorOpen && (
        <Portal>
        <div className="modalBackdrop" style={{ zIndex: 2200 }}>
          <div className="modalCard" onClick={e => e.stopPropagation()} style={{ width: '420px' }}>
            <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1rem' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
              Seleccionar Impresoras
            </h3>
            <div style={{ marginBottom: '1rem', position: 'relative' }}>
              <input 
                autoFocus 
                placeholder="Buscar impresora..." 
                value={printerSearch} 
                onChange={e => setPrinterSearch(e.target.value)} 
                style={{ ...INP, paddingLeft: '2.5rem' }} 
              />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ position: 'absolute', left: '0.8rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }}><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            </div>
            <div style={{ maxHeight: '350px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface, #fff)' }}>
              {availableLogicalPrinters.filter(o => o.name.toLowerCase().includes(printerSearch.toLowerCase())).map(o => {
                const isSelected = printers.split(",").map(v => v.trim()).includes(o.name);
                return (
                  <div key={o.id} onClick={() => {
                    const selectedList = printers.split(",").map(v => v.trim()).filter(Boolean);
                    const next = selectedList.includes(o.name) ? selectedList.filter(n => n !== o.name) : [...selectedList, o.name];
                    setPrinters(next.join(", "));
                  }} style={{ 
                    padding: "12px 15px", cursor: "pointer", display: "flex", alignItems: "center", gap: "12px", 
                    borderBottom: '1px solid #f1f5f9', background: isSelected ? "var(--bg-subtle, rgba(15, 118, 110, 0.05))" : "var(--surface, #fff)",
                    transition: 'background 0.2s'
                  }}>
                    <div style={{ 
                      width: '20px', height: '20px', borderRadius: '6px', border: '2px solid', 
                      borderColor: isSelected ? 'var(--accent)' : '#cbd5e1',
                      background: isSelected ? 'var(--accent)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s'
                    }}>
                      {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4"><polyline points="20 6 9 17 4 12"></polyline></svg>}
                    </div>
                    <span style={{ fontSize: "0.88rem", fontWeight: isSelected ? 600 : 500, color: isSelected ? 'var(--accent)' : 'inherit' }}>{o.name}</span>
                  </div>
                );
              })}
              {availableLogicalPrinters.length === 0 && <div style={{ padding: "40px 20px", color: "#94a3b8", fontSize: "0.85rem", textAlign: "center" }}>No hay impresoras configuradas</div>}
            </div>
            <div className="modalActions">
              <button type="button" className="primary" onClick={() => setIsPrinterSelectorOpen(false)} style={{ width: '100%', padding: '0.75rem' }}>Aceptar Selección</button>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </section>
  );
}
