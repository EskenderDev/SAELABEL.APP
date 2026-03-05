import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createLabelsApi, DEFAULT_API_BASE_URL, createEditorApi } from "@/lib/api/client";
import type { EditorDocumentSummary, UpsertEditorDocumentPayload } from "@/lib/api/client";
import VisualCanvasEditor from "@/components/VisualCanvasEditor";
import TicketDesigner from "@/components/TicketDesigner";
import LogicalPrintersManagerModal from "@/components/LogicalPrintersManagerModal";
import { Portal } from "@/components/Portal";

type Action = "parse" | "convert-to-glabels" | "convert-from-glabels";
type DocKind = "sae" | "glabels" | "saetickets";
type Unit = "mm" | "cm" | "in" | "pt";

const sampleSaeXml =
  `<saelabels version="1.0"><template brand="SAE" description="Demo" part="P-1" size="custom"><label_rectangle width_pt="144" height_pt="72" round_pt="0" x_waste_pt="0" y_waste_pt="0" /><layout dx_pt="0" dy_pt="0" nx="1" ny="1" x0_pt="0" y0_pt="0" /></template><objects /><variables /></saelabels>`;
const sampleGlabelsXml =
  `<Glabels-document version="4.0"><Template brand="Demo" description="Demo" part="P-1" size="custom"><Label-rectangle width="144pt" height="72pt"><Layout dx="144pt" dy="72pt" nx="1" ny="1" x0="0pt" y0="0pt"/></Label-rectangle></Template><Objects/><Variables/><Data/></Glabels-document>`;

const STORAGE = {
  apiBaseUrl: "saestudio.app.apiBaseUrl",
  action: "saestudio.app.action",
  xml: "saestudio.app.xml",
  history: "saestudio.app.history",
  timeoutMs: "saestudio.app.timeoutMs",
  sessions: "saestudio.app.sessions",
  autoSaveEnabled: "saestudio.app.autoSaveEnabled",
};

type HistoryItem = {
  id: string;
  createdAt: string;
  action: Action;
  ok: boolean;
  elapsedMs: number;
  errorMessage?: string;
};

type SessionItem = {
  id: string;
  name: string;
  createdAt: string;
  apiBaseUrl: string;
  action: Action;
  xml: string;
  timeoutMs: number;
};

type NewDocumentDraft = {
  kind: DocKind;
  name: string;
  width: number;
  height: number;
  unit: Unit;
  brand: string;
  description: string;
  part: string;
  size: string;
};

type LabelPreset = {
  id: string;
  name: string;
  width: number;
  height: number;
  unit: Unit;
  brand: string;
  part: string;
  size: string;
  description: string;
};

const PT_PER_IN = 72;
const MM_PER_IN = 25.4;
const toPt = (value: number, unit: Unit): number => {
  if (unit === "pt") return value;
  if (unit === "in") return value * PT_PER_IN;
  if (unit === "mm") return (value / MM_PER_IN) * PT_PER_IN;
  return (value / 2.54) * PT_PER_IN;
};
const fmt = (n: number) => n.toFixed(4).replace(/\.?0+$/, "");
const xesc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const LABEL_PRESETS: LabelPreset[] = [
  { id: "custom", name: "Custom", width: 50, height: 25, unit: "mm", brand: "Custom", part: "P-1", size: "custom", description: "Tamano personalizado" },
  { id: "avery-5160", name: "Avery 5160 (Address)", width: 66.675, height: 25.4, unit: "mm", brand: "Avery", part: "5160", size: "US Letter", description: "30 etiquetas por hoja" },
  { id: "avery-5163", name: "Avery 5163 (Shipping)", width: 101.6, height: 50.8, unit: "mm", brand: "Avery", part: "5163", size: "US Letter", description: "10 etiquetas por hoja" },
  { id: "avery-5164", name: "Avery 5164 (Shipping)", width: 101.6, height: 84.667, unit: "mm", brand: "Avery", part: "5164", size: "US Letter", description: "6 etiquetas por hoja" },
  { id: "dymo-30252", name: "DYMO 30252 (Address)", width: 54, height: 25, unit: "mm", brand: "DYMO", part: "30252", size: "Roll", description: "Address label" },
  { id: "brother-dk-11201", name: "Brother DK-11201", width: 29, height: 90, unit: "mm", brand: "Brother", part: "DK-11201", size: "Roll", description: "Address label" },
  { id: "zebra-4x6", name: "Zebra 4x6 Shipping", width: 4, height: 6, unit: "in", brand: "Zebra", part: "4x6", size: "Roll", description: "Envio estandar" },
];

function buildNewDocumentXml(draft: NewDocumentDraft): string {
  const widthPt = Math.max(1, toPt(draft.width, draft.unit));
  const heightPt = Math.max(1, toPt(draft.height, draft.unit));
  const brand = xesc(draft.brand.trim() || "Custom");
  const description = xesc((draft.description.trim() || draft.name.trim() || "Nuevo documento"));
  const part = xesc(draft.part.trim() || "P-1");
  const size = xesc(draft.size.trim() || "custom");
  if (draft.kind === "sae") {
    return `<saelabels version="1.0"><template brand="${brand}" description="${description}" part="${part}" size="${size}"><label_rectangle width_pt="${fmt(widthPt)}" height_pt="${fmt(heightPt)}" round_pt="0" x_waste_pt="0" y_waste_pt="0" /><layout dx_pt="0" dy_pt="0" nx="1" ny="1" x0_pt="0" y0_pt="0" /></template><objects /><variables /></saelabels>`;
  }
  return `<Glabels-document version="4.0"><Template brand="${brand}" description="${description}" part="${part}" size="${size}"><Label-rectangle width="${fmt(widthPt)}pt" height="${fmt(heightPt)}pt"><Layout dx="${fmt(widthPt)}pt" dy="${fmt(heightPt)}pt" nx="1" ny="1" x0="0pt" y0="0pt"/></Label-rectangle></Template><Objects/><Variables/><Data/></Glabels-document>`;
}

function sanitizeXmlInput(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/^\s*```(?:xml)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function getExpectedRoots(action: Action): string[] {
  if (action === "convert-from-glabels") {
    return ["glabels-document", "glabels-template", "template"];
  }
  return ["saelabels"];
}

function validateXmlInput(action: Action, rawXml: string): { ok: true; normalizedXml: string } | { ok: false; error: string } {
  const normalizedXml = sanitizeXmlInput(rawXml);
  if (!normalizedXml) {
    return { ok: false, error: "Debes ingresar XML para procesar." };
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(normalizedXml, "application/xml");
  const parserError = document.querySelector("parsererror");
  if (parserError) {
    return { ok: false, error: "XML invalido. Revisa formato y etiquetas." };
  }

  const rootName = document.documentElement?.nodeName?.toLowerCase() ?? "";
  const expectedRoots = getExpectedRoots(action);
  if (!expectedRoots.includes(rootName)) {
    return {
      ok: false,
      error: `Raiz invalida para '${action}'. Esperado: ${expectedRoots.map((x) => `<${x}>`).join(", ")} y llego <${rootName || "vacia"}>.`,
    };
  }

  return { ok: true, normalizedXml };
}

export default function LabelWorkbench() {
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [labelXml, setLabelXml] = useState(sampleSaeXml);
  const [ticketXml, setTicketXml] = useState(`<?xml version="1.0" encoding="utf-8"?><saetickets version="1.0"><setup width="42"/><commands/></saetickets>`);
  
  const [docKind, setDocKind] = useState<"sae" | "glabels" | "saetickets">("sae");

  // Contextual Getters
  const xml = docKind === 'saetickets' ? ticketXml : labelXml;
  const setXml = docKind === 'saetickets' ? setTicketXml : setLabelXml;

  const [labelDocId, setLabelDocId] = useState("");
  const [ticketDocId, setTicketDocId] = useState("");
  const docId = docKind === 'saetickets' ? ticketDocId : labelDocId;
  const setDocId = docKind === 'saetickets' ? setTicketDocId : setLabelDocId;

  const [labelDocName, setLabelDocName] = useState("Sin titulo");
  const [ticketDocName, setTicketDocName] = useState("Nuevo Tiquete");
  const docName = docKind === 'saetickets' ? ticketDocName : labelDocName;
  const setDocName = docKind === 'saetickets' ? setTicketDocName : setLabelDocName;

  const [labelFileHandle, setLabelFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [ticketFileHandle, setTicketFileHandle] = useState<FileSystemFileHandle | null>(null);
  const fileHandle = docKind === 'saetickets' ? ticketFileHandle : labelFileHandle;
  const setFileHandle = docKind === 'saetickets' ? setTicketFileHandle : setLabelFileHandle;

  const [action, setAction] = useState<Action>("parse");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pingStatus, setPingStatus] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [showApiConfigModal, setShowApiConfigModal] = useState(false);
  const [showPrintersManagerModal, setShowPrintersManagerModal] = useState(false);
  const [apiBaseUrlDraft, setApiBaseUrlDraft] = useState("");
  const [showResultModal, setShowResultModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showTemplatesGallery, setShowTemplatesGallery] = useState(false);
  const [showOpenDocModal, setShowOpenDocModal] = useState(false);
  const [openDocSearch, setOpenDocSearch] = useState("");
  const [showNewTypeModal, setShowNewTypeModal] = useState(false);
  const [showNewConfigModal, setShowNewConfigModal] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState("custom");
  const [newDocumentDraft, setNewDocumentDraft] = useState<NewDocumentDraft>({
    kind: "sae",
    name: "Nueva etiqueta",
    width: 50,
    height: 25,
    unit: "mm",
    brand: "Custom",
    description: "Etiqueta personalizada",
    part: "P-1",
    size: "custom",
  });

  const [documents, setDocuments] = useState<EditorDocumentSummary[]>([]);
  const [metaVersion, setMetaVersion] = useState("1.0");
  const [metaBrand, setMetaBrand] = useState("SAE");
  const [metaDescription, setMetaDescription] = useState("Etiqueta");
  const [metaPart, setMetaPart] = useState("P-1");
  const [metaSize, setMetaSize] = useState("custom");

  const [propertiesModalOpen, setPropertiesModalOpen] = useState(false);
  const [saveAsModalOpen, setSaveAsModalOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "modified" | "error">("saved");
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('theme') === 'dark';
  });

  // Sync dark mode to <html data-theme>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.setAttribute('data-theme', 'dark');
      window.localStorage.setItem('theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
      window.localStorage.setItem('theme', 'light');
    }
  }, [darkMode]);


  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedApiBaseUrl = window.localStorage.getItem(STORAGE.apiBaseUrl);
    const savedAction = window.localStorage.getItem(STORAGE.action) as Action | null;
    const savedXml = window.localStorage.getItem(STORAGE.xml);
    const savedHistory = window.localStorage.getItem(STORAGE.history);
    const savedTimeoutMs = window.localStorage.getItem(STORAGE.timeoutMs);
    const savedSessions = window.localStorage.getItem(STORAGE.sessions);
    const savedAutoSave = window.localStorage.getItem(STORAGE.autoSaveEnabled);

    if (savedApiBaseUrl) setApiBaseUrl(savedApiBaseUrl);
    if (savedAction) setAction(savedAction);
    if (savedXml) setXml(savedXml);
    if (savedTimeoutMs && !Number.isNaN(Number(savedTimeoutMs))) setTimeoutMs(Number(savedTimeoutMs));
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory) as HistoryItem[]);
      } catch {
        setHistory([]);
      }
    }
    if (savedSessions) {
      try {
        setSessions(JSON.parse(savedSessions) as SessionItem[]);
      } catch {
        setSessions([]);
      }
    }
    if (savedAutoSave !== null) setAutoSaveEnabled(savedAutoSave === "true");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.apiBaseUrl, apiBaseUrl);
    // Sync the global API client in client.ts
    import("@/lib/api/client").then(m => m.setApiBaseUrl(apiBaseUrl));
  }, [apiBaseUrl]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.action, action);
  }, [action]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.xml, labelXml);
    window.localStorage.setItem('saestudio.app.ticketXml', ticketXml);
  }, [labelXml, ticketXml]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.history, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.timeoutMs, String(timeoutMs));
  }, [timeoutMs]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.sessions, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.autoSaveEnabled, String(autoSaveEnabled));
  }, [autoSaveEnabled]);

  // Global Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toUpperCase();
      const isTyping = tag === 'TEXTAREA'; // don't intercept textarea Enter

      // ── Ctrl shortcuts (always active) ──────────────────────────────────────
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveDoc();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'p' && docKind === 'saetickets') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('ticket-trigger-print'));
        return;
      }

      // ── Modal keyboard shortcuts ─────────────────────────────────────────────
      const anyModalOpen =
        saveAsModalOpen || propertiesModalOpen || showNewConfigModal ||
        showNewTypeModal || showApiConfigModal || showOpenDocModal ||
        showResultModal || showTemplatesGallery || showAboutModal || showPrintersManagerModal;

      if (!anyModalOpen) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        // Close in priority order (topmost/most recently opened first)
        if (saveAsModalOpen)         { setSaveAsModalOpen(false); return; }
        if (propertiesModalOpen)     { setPropertiesModalOpen(false); return; }
        if (showNewConfigModal)      { setShowNewConfigModal(false); return; }
        if (showNewTypeModal)        { setShowNewTypeModal(false); return; }
        if (showApiConfigModal)      { setShowApiConfigModal(false); return; }
        if (showOpenDocModal)        { setShowOpenDocModal(false); return; }
        if (showResultModal)         { setShowResultModal(false); return; }
        if (showTemplatesGallery)    { setShowTemplatesGallery(false); return; }
        if (showAboutModal)          { setShowAboutModal(false); return; }
        if (showPrintersManagerModal){ setShowPrintersManagerModal(false); return; }
      }

      if (e.key === 'Enter' && !isTyping) {
        e.preventDefault();
        // Trigger primary action for the topmost modal
        if (saveAsModalOpen) {
          void saveAsDoc();
          return;
        }
        if (showNewConfigModal) {
          // click the primary button
          (document.querySelector('.modalCard button.primary') as HTMLButtonElement)?.click();
          return;
        }
        if (showApiConfigModal) {
          (document.querySelector('.modalCard button.primary') as HTMLButtonElement)?.click();
          return;
        }
        // For info-only modals just close them
        if (showResultModal  || showAboutModal) {
          setShowResultModal(false);
          setShowAboutModal(false);
          return;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    labelXml, ticketXml, labelDocId, ticketDocId, labelDocName, ticketDocName,
    docKind, labelFileHandle, ticketFileHandle,
    saveAsModalOpen, propertiesModalOpen, showNewConfigModal, showNewTypeModal,
    showApiConfigModal, showOpenDocModal, showResultModal, showTemplatesGallery,
    showAboutModal, showPrintersManagerModal,
  ]);

  // Auto-save effect Label
  useEffect(() => {
    if (!autoSaveEnabled || !labelDocId) return;
    setSaveStatus("modified");
    const timer = setTimeout(async () => {
      try {
        setSaveStatus("saving");
        await editorApi.saveDocument({ id: labelDocId, name: labelDocName, kind: (docKind === 'saetickets' ? 'sae' : docKind) as any, xml: labelXml });
        setSaveStatus("saved");
      } catch (err) {
        console.error("Auto-save failed label:", err);
        setSaveStatus("error");
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [labelXml, labelDocId, labelDocName, autoSaveEnabled]);

  // Auto-save effect Ticket
  useEffect(() => {
    if (!autoSaveEnabled || !ticketDocId) return;
    setSaveStatus("modified");
    const timer = setTimeout(async () => {
      try {
        setSaveStatus("saving");
        await editorApi.saveDocument({ id: ticketDocId, name: ticketDocName, kind: 'saetickets', xml: ticketXml });
        setSaveStatus("saved");
      } catch (err) {
        console.error("Auto-save failed ticket:", err);
        setSaveStatus("error");
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [ticketXml, ticketDocId, ticketDocName, autoSaveEnabled]);

  const buttonLabel = useMemo(() => {
    if (action === "parse") return "Probar parse";
    if (action === "convert-to-glabels") return "Convertir a glabels";
    return "Convertir desde glabels";
  }, [action]);
  const resultExtension = action === "parse" ? "json" : "xml";
  const labelsApi = useMemo(() => createLabelsApi(apiBaseUrl, { timeoutMs }), [apiBaseUrl, timeoutMs]);
  const editorApi = useMemo(() => createEditorApi(apiBaseUrl, { timeoutMs }), [apiBaseUrl, timeoutMs]);

  const refreshDocuments = async () => {
    try {
      const docs = await editorApi.listDocuments();
      setDocuments(docs);
    } catch (e) {
      // Ignorar error para no mostrar mensajes al cargar
    }
  };

  useEffect(() => {
    void refreshDocuments();
  }, [editorApi]);

  const saveDoc = async () => {
    setSaveStatus("saving");
    const currentFileHandle = docKind === 'saetickets' ? ticketFileHandle : labelFileHandle;
    if (!currentFileHandle) {
      await saveAsDoc();
      return;
    }

    try {
      const writable = await (currentFileHandle as any).createWritable();
      await writable.write(xml);
      await writable.close();
      
      if (docId) {
        await editorApi.saveDocument({ id: docId, name: docName, kind: docKind, xml });
      }
      setSaveStatus("saved");
    } catch (e) {
      console.error("Failed to save:", e);
      setSaveStatus("error");
      setError("Error al guardar archivo.");
    }
  };

  const deleteDocument = async (id: string) => {
    if (!window.confirm("¿Estás seguro de que deseas eliminar este documento?")) return;
    try {
      await editorApi.deleteDocument(id);
      if (docId === id) {
        setDocId("");
        setDocName(docKind === 'saetickets' ? "Nuevo Tiquete" : "Sin título");
        setXml(docKind === 'saetickets' ? `<?xml version="1.0" encoding="utf-8"?><saetickets version="1.0"><setup width="42"/><commands/></saetickets>` : sampleSaeXml);
      }
      void refreshDocuments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al eliminar.");
    }
  };

  const openLocalFile = async () => {
    if (typeof window !== "undefined" && "showOpenFilePicker" in window) {
      try {
        const [handle] = await (window as any).showOpenFilePicker({
          types: [{
            description: 'XML Files',
            accept: { 'application/xml': ['.xml', '.saelabels', '.saetickets'] },
          }],
        });
        setFileHandle(handle);
        const file = await handle.getFile();
        const text = await file.text();
        const sanitized = sanitizeXmlInput(text);
        
        // Infer kind from content or extension
        let kind: DocKind = "sae";
        if (sanitized.includes("<saetickets") || file.name.endsWith(".saetickets")) kind = "saetickets";
        else if (sanitized.includes("<saelabels") || file.name.endsWith(".saelabels")) kind = "sae";
        else if (sanitized.includes("<Glabels-document")) kind = "glabels";
        
        setDocKind(kind);
        
        // Contextual updates
        if (kind === "saetickets") {
          setTicketXml(sanitized);
          setTicketDocName(file.name.replace(/\.(xml|saetickets)$/i, ""));
          setTicketDocId("");
          setTicketFileHandle(handle);
        } else {
          setLabelXml(sanitized);
          setLabelDocName(file.name.replace(/\.(xml|saelabels)$/i, ""));
          setLabelDocId("");
          setLabelFileHandle(handle);
        }
        
        setSaveStatus("saved");
        setError("");
        setResult("");
      } catch (e: any) {
        if (e.name === "AbortError") return;
        console.error("File Picker failed:", e);
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const saveAsDoc = async () => {
    // Priority: Local Save via Picker
    if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
      try {
        const ext = docKind === 'saetickets' ? '.saetickets' : '.saelabels';
        const desc = docKind === 'saetickets' ? 'SAE Ticket' : 'SAE Label';
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: (docName || "documento") + ext,
          types: [{
            description: desc,
            accept: { 'application/xml': [ext] },
          }],
        });
        setFileHandle(handle);
        const writable = await handle.createWritable();
        await writable.write(xml);
        await writable.close();
        
        // Update name from picker
        const file = await handle.getFile();
        setDocName(file.name.replace(/\.(saelabels|saetickets|xml)$/i, ""));
        
        setSaveStatus("saved");
        return;
      } catch (e: any) {
        if (e.name === "AbortError") return;
        console.error("File Picker failed:", e);
      }
    }

    // Fallback: Virtual Save As in Backend
    if (!saveAsName.trim()) {
      setSaveAsModalOpen(true);
      return;
    }
    try {
      const payload: UpsertEditorDocumentPayload = {
        name: saveAsName.trim(),
        kind: docKind,
        xml,
      };
      const res = await editorApi.saveDocument(payload);
      setDocId(res.id);
      setDocName(res.name);
      setSaveAsModalOpen(false);
      setSaveAsName("");
      setError("");
      void refreshDocuments();
      setResult("Copia guardada exitosamente en el servidor.");
      setShowResultModal(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar como.");
    }
  };

  const loadDocument = async (id: string) => {
    try {
      const full = await editorApi.getDocument(id);
      const kind = full.kind as DocKind;
      setDocKind(kind);
      
      if (kind === 'saetickets') {
        setTicketDocId(full.id);
        setTicketDocName(full.name);
        setTicketXml(full.xml);
        setTicketFileHandle(null);
      } else {
        setLabelDocId(full.id);
        setLabelDocName(full.name);
        setLabelXml(full.xml);
        setLabelFileHandle(null);
        setNewDocumentDraft(p => ({ ...p, kind: (kind as any) === 'saetickets' ? 'sae' : kind }));
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar.");
    }
  };

  const exportDoc = async () => {
    setLoading(true);
    try {
      let xmlToExport = xml;
      // If we are in SAE and want to export, we might want to offer conversion
      // For now, let's just make sure it descends or stays in kind.
      // But user asked for SAE/GLabels transformations.
      
      const targetKind = (newDocumentDraft.kind as any) === "sae" ? "glabels" : "sae";
      const confirmConversion = window.confirm(`Deseas convertir el documento a ${targetKind} antes de exportar?`);
      
      if (confirmConversion) {
        if (newDocumentDraft.kind === "sae") {
          const res = await labelsApi.convertToGlabels({ xml }) as any;
          xmlToExport = res.data || res;
        } else {
          const res = await labelsApi.convertFromGlabels({ xml }) as any;
          xmlToExport = res.data || res;
        }
      }

      const blob = new Blob([xmlToExport], { type: "application/xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `export_${docName || "documento"}.xml`;
      a.click();
      URL.revokeObjectURL(url);
      setResult("Documento exportado exitosamente.");
      setShowResultModal(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al exportar.");
    } finally {
      setLoading(false);
    }
  };

  const exportToSaeSystem = async () => {
    setLoading(true);
    try {
      // Ensure we export in SAE format
      let saeXml = xml;
      if (newDocumentDraft.kind === "glabels") {
        const res = await labelsApi.convertFromGlabels({ xml }) as any;
        saeXml = res.data || res;
      }

      const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/api/editor/export/saesystem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xml: saeXml, fileName: docName }),
      });

      if (!response.ok) {
        const txt = await response.text();
        throw new Error(txt || `Error ${response.status}`);
      }

      const data = await response.json();
      setResult(`Exportado a SAE System con éxito!\nUbicación: ${data.path}`);
      setShowResultModal(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al exportar a SAE System.");
    } finally {
      setLoading(false);
    }
  };

  const applyExample = () => {
    setXml(action === "convert-from-glabels" ? sampleGlabelsXml : sampleSaeXml);
    setError("");
    setResult("");
    setPingStatus("");
  };

  const handleSwitchKind = (target: DocKind) => {
    if (docKind === target) return;
    setDocKind(target);
  };


  const createNewDocument = (kind: "sae" | "glabels") => {
    setXml(kind === "sae" ? sampleSaeXml : sampleGlabelsXml);
    setAction(kind === "sae" ? "parse" : "convert-from-glabels");
    setError("");
    setResult("");
    setPingStatus("");
  };

  const openNewDocumentTypeModal = () => {
    setShowNewTypeModal(true);
  };

  const selectNewDocumentType = (kind: DocKind) => {
    setNewDocumentDraft((prev) => ({ ...prev, kind }));
    setSelectedPresetId("custom");
    setShowNewTypeModal(false);
    setShowNewConfigModal(true);
  };

  const applyPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    const preset = LABEL_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    if (preset.id === "custom") return;
    setNewDocumentDraft((prev) => ({
      ...prev,
      width: preset.width,
      height: preset.height,
      unit: preset.unit,
      brand: preset.brand,
      part: preset.part,
      size: preset.size,
      description: preset.description,
    }));
  };

  const createConfiguredDocument = () => {
    if (!newDocumentDraft.name.trim()) {
      setError("Nombre requerido para el documento.");
      return;
    }
    if (newDocumentDraft.width <= 0 || newDocumentDraft.height <= 0) {
      setError("Ancho y alto deben ser mayores a cero.");
      return;
    }
    const xmlDraft = buildNewDocumentXml(newDocumentDraft);
    setXml(xmlDraft);
    setAction(newDocumentDraft.kind === "sae" ? "parse" : "convert-from-glabels");
    setError("");
    setResult("");
    setPingStatus("");
    setShowNewConfigModal(false);
  };

  const addHistoryItem = (item: HistoryItem) => {
    setHistory((prev) => [item, ...prev].slice(0, 20));
  };

  const saveSession = () => {
    if (typeof window === "undefined") return;
    const name = window.prompt("Nombre de la sesion");
    if (!name || !name.trim()) return;
    setSessions((prev) => [
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        createdAt: new Date().toISOString(),
        apiBaseUrl,
        action,
        xml,
        timeoutMs,
      },
      ...prev,
    ].slice(0, 30));
  };

  const loadSession = () => {
    const selected = sessions.find((x) => x.id === selectedSessionId);
    if (!selected) return;
    setApiBaseUrl(selected.apiBaseUrl);
    setAction(selected.action);
    setXml(selected.xml);
    setTimeoutMs(selected.timeoutMs);
    setError("");
    setResult("");
    setPingStatus("");
  };

  const deleteSession = () => {
    if (!selectedSessionId) return;
    setSessions((prev) => prev.filter((x) => x.id !== selectedSessionId));
    setSelectedSessionId("");
  };

  const run = async () => {
    const validation = validateXmlInput(action, xml);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    const normalizedXml = validation.normalizedXml;
    setXml(normalizedXml);
    const startedAt = Date.now();
    setLoading(true);
    setError("");
    setResult("");
    setPingStatus("");

    try {
      if (action === "parse") {
        const parsed = await labelsApi.parse({ xml: normalizedXml });
        setResult(JSON.stringify(parsed, null, 2));
      } else if (action === "convert-to-glabels") {
        const converted = await labelsApi.convertToGlabels({ xml: normalizedXml });
        setResult(converted.data);
      } else {
        const converted = await labelsApi.convertFromGlabels({ xml: normalizedXml });
        setResult(converted.data);
      }
      addHistoryItem({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        action,
        ok: true,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error desconocido";
      setError(message);
      addHistoryItem({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        action,
        ok: false,
        elapsedMs: Date.now() - startedAt,
        errorMessage: message,
      });
    } finally {
      setLoading(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
    } catch {
      setError("No se pudo copiar al portapapeles.");
    }
  };

  const downloadResult = () => {
    if (!result || typeof window === "undefined") return;
    const mimeType = action === "parse" ? "application/json;charset=utf-8" : "application/xml;charset=utf-8";
    const blob = new Blob([result], { type: mimeType });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `resultado.${resultExtension}`;
    anchor.click();
    window.URL.revokeObjectURL(url);
  };

  const downloadInput = () => {
    if (!xml || typeof window === "undefined") return;
    const cleanXml = sanitizeXmlInput(xml);
    if (!cleanXml) {
      setError("No hay XML valido para descargar.");
      return;
    }

    const blob = new Blob([cleanXml], { type: "application/xml;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "entrada.xml";
    anchor.click();
    window.URL.revokeObjectURL(url);
  };

  const importInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const sanitized = sanitizeXmlInput(text);
      
      // Infer kind
      let kind: DocKind = "sae";
      if (sanitized.includes("<saetickets") || file.name.endsWith(".saetickets")) kind = "saetickets";
      else if (sanitized.includes("<saelabels") || file.name.endsWith(".saelabels")) kind = "sae";
      else if (sanitized.includes("<Glabels-document")) kind = "glabels";
      
      setDocKind(kind);

      if (kind === "saetickets") {
        setTicketXml(sanitized);
        setTicketDocName(file.name.replace(/\.(xml|saetickets)$/i, ""));
        setTicketDocId("");
        setTicketFileHandle(null);
      } else {
        setLabelXml(sanitized);
        setLabelDocName(file.name.replace(/\.(xml|saelabels)$/i, ""));
        setLabelDocId("");
        setLabelFileHandle(null);
      }

      setError("");
      setResult("");
    } catch {
      setError("No se pudo leer el archivo.");
    } finally {
      event.target.value = "";
    }
  };

  const pingBackend = async (targetBaseUrl?: string): Promise<boolean> => {
    const base = (targetBaseUrl ?? apiBaseUrl).replace(/\/+$/, "");
    setPingStatus("Probando conexión...");
    try {
      const response = await fetch(`${base}/openapi/v1.json`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        setPingStatus(`✅ Conexión OK (HTTP ${response.status}) — ${base}`);
        return true;
      } else {
        setPingStatus(`⚠️ Backend responde con HTTP ${response.status}`);
        return false;
      }
    } catch (err: any) {
      if (err?.name === "TimeoutError") {
        setPingStatus(`❌ Timeout — el servidor no respondió en 5s`);
      } else {
        setPingStatus(`❌ Sin conexión: ${err?.message || "Failed to fetch"}`);
      }
      return false;
    }
  };

  const openApiConfigModal = () => {
    setApiBaseUrlDraft(apiBaseUrl);
    setShowApiConfigModal(true);
  };

  const saveApiConfig = () => {
    const next = apiBaseUrlDraft.trim();
    if (!next) {
      setError("API Base URL no puede estar vacio.");
      return;
    }
    setApiBaseUrl(next);
    setShowApiConfigModal(false);
  };

  const restorePanels = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event("saelabel:restore-panels"));
    closeAllMenus();
  };

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".appMenu")) {
        closeAllMenus();
      }
    };
    window.addEventListener("click", handleOutsideClick);
    return () => window.removeEventListener("click", handleOutsideClick);
  }, []);

  // Menu state and logic
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [activeSubMenu, setActiveSubMenu] = useState<string | null>(null);

  const toggleMenu = (menuName: string) => {
    setActiveMenu(prev => prev === menuName ? null : menuName);
    setActiveSubMenu(null);
    if (menuName === 'archivo') {
      void refreshDocuments();
    }
  };

  const toggleSubMenu = (subMenuName: string) => {
    setActiveSubMenu(prev => prev === subMenuName ? null : subMenuName);
  };

  const closeAllMenus = () => {
    setActiveMenu(null);
    setActiveSubMenu(null);
    if (typeof document !== "undefined") {
      document.querySelectorAll(".appMenu details[open]").forEach((el) => {
        (el as HTMLDetailsElement).open = false;
      });
    }
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".appMenu details")) {
        closeAllMenus();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <section className="panel visualMode">
      <div className="studioWrapper">
        <nav className="appMenu" data-tauri-drag-region>
          <details className="menuDropdown" open={activeMenu === 'archivo'}>
            <summary className="menuItem" style={{ textAlign: 'left' }} onClick={(e) => { e.preventDefault(); toggleMenu('archivo'); }}>Archivo</summary>
            <div className="menuDropdownList">
              <button type="button" className="menuDropdownItem" onClick={() => { openNewDocumentTypeModal(); closeAllMenus(); }}>
                Nuevo...
              </button>
              <button type="button" className="menuDropdownItem" onClick={() => { refreshDocuments(); setShowOpenDocModal(true); closeAllMenus(); }}>
                Abrir de biblioteca...
              </button>
              <button type="button" className="menuDropdownItem" onClick={() => { openLocalFile(); closeAllMenus(); }}>
                Abrir Archivo Local...
              </button>
              <button type="button" className="menuDropdownItem" onClick={() => { setShowTemplatesGallery(true); closeAllMenus(); }}>
                Plantillas
              </button>
              <button type="button" className="menuDropdownItem" onClick={() => { setPropertiesModalOpen(true); closeAllMenus(); }}>
                Propiedades Documento
              </button>
              <div className="menuDivider" />
              <button type="button" className="menuDropdownItem" onClick={() => { saveDoc(); closeAllMenus(); }}>
                Guardar
              </button>
              <button type="button" className="menuDropdownItem" onClick={() => { setSaveAsName(docName + " (Copia)"); setSaveAsModalOpen(true); closeAllMenus(); }}>
                Guardar como...
              </button>
              <button type="button" className="menuDropdownItem" onClick={() => { exportDoc(); closeAllMenus(); }}>
                Exportar
              </button>
              <button type="button" className="menuDropdownItem danger" style={{ color: '#ef4444' }} onClick={() => { if (docId) deleteDocument(docId); closeAllMenus(); }} disabled={!docId}>
                Eliminar documento
              </button>
              <div className="menuDivider" />
              <details className="menuSubDropdown" open={activeSubMenu === 'labels'}>
                <summary className="menuDropdownItem" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', padding: '0.65rem 1.25rem', boxSizing: 'border-box' }} onClick={(e) => { e.preventDefault(); toggleSubMenu('labels'); }}>
                  <span>Etiquetas recientes</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, flexShrink: 0 }}><polyline points="9 18 15 12 9 6"/></svg>
                </summary>
                <div className="menuSubDropdownList">
                  {documents.filter(d => d.kind !== 'saetickets').length > 0 ? documents.filter(d => d.kind !== 'saetickets').slice(0, 10).map(d => (
                    <button key={d.id} type="button" className="menuDropdownItem" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', width: '100%', padding: '0.5rem 0.75rem' }} onClick={() => { loadDocument(d.id); closeAllMenus(); }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontSize: '0.8rem' }}>{d.name}</span>
                      <small style={{ opacity: 0.4, fontSize: '0.62rem', flexShrink: 0, fontWeight: 700 }}>{new Date(d.updatedAtUtc || Date.now()).toLocaleDateString()}</small>
                    </button>
                  )) : <div className="menuDropdownItem disabled">No hay etiquetas</div>}
                </div>
              </details>
              <details className="menuSubDropdown" open={activeSubMenu === 'tickets'}>
                <summary className="menuDropdownItem" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', padding: '0.65rem 1.25rem', boxSizing: 'border-box' }} onClick={(e) => { e.preventDefault(); toggleSubMenu('tickets'); }}>
                  <span>Tiquetes recientes</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, flexShrink: 0 }}><polyline points="9 18 15 12 9 6"/></svg>
                </summary>
                <div className="menuSubDropdownList">
                  {documents.filter(d => d.kind === 'saetickets').length > 0 ? documents.filter(d => d.kind === 'saetickets').slice(0, 10).map(d => (
                    <button key={d.id} type="button" className="menuDropdownItem" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', width: '100%', padding: '0.5rem 0.75rem' }} onClick={() => { loadDocument(d.id); closeAllMenus(); }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontSize: '0.8rem' }}>{d.name}</span>
                      <small style={{ opacity: 0.4, fontSize: '0.62rem', flexShrink: 0, fontWeight: 700 }}>{new Date(d.updatedAtUtc || Date.now()).toLocaleDateString()}</small>
                    </button>
                  )) : <div className="menuDropdownItem disabled">No hay tiquetes</div>}
                </div>
              </details>
            </div>
          </details>
          <details className="menuDropdown" open={activeMenu === 'editar'}>
            <summary className="menuItem" style={{ textAlign: 'left' }} onClick={(e) => { e.preventDefault(); toggleMenu('editar'); }}>Editar</summary>
            <div className="menuDropdownList">
              <button type="button" className="menuDropdownItem" onClick={() => { 
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
                closeAllMenus(); 
              }}>
                Deshacer <span style={{ float:'right', opacity:0.5 }}>Ctrl+Z</span>
              </button>
              <button type="button" className="menuDropdownItem" onClick={() => { 
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
                closeAllMenus(); 
              }}>
                Rehacer <span style={{ float:'right', opacity:0.5 }}>Ctrl+Y</span>
              </button>
              <div className="menuDivider" />
              <button type="button" className="menuDropdownItem" onClick={() => { 
                setResult(xml);
                setShowResultModal(true); 
                closeAllMenus(); 
              }}>
                Ver resultado XML
              </button>
            </div>
          </details>
          <details className="menuDropdown" open={activeMenu === 'config'}>
            <summary className="menuItem" style={{ textAlign: 'left' }} onClick={(e) => { e.preventDefault(); toggleMenu('config'); }}>Configuraciones</summary>
            <div className="menuDropdownList">
              <button type="button" className="menuDropdownItem" onClick={() => { openApiConfigModal(); closeAllMenus(); }}>
                Config API
              </button>
              <button type="button" className="menuDropdownItem" onClick={() => { setShowPrintersManagerModal(true); closeAllMenus(); }}>
                Impresoras Lógicas
              </button>
              <div className="menuDropdownItem" style={{ cursor: 'default', padding: '0.65rem 1.25rem', boxSizing: 'border-box', width: 'auto' }} onClick={(e) => e.stopPropagation()}>
                <label className="toggleLabel" style={{ padding: 0, width: 'auto', flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', pointerEvents: 'none', gap: '2rem' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text)' }}>Auto-guardado</span>
                  <span
                    className="toggleTrack mini"
                    style={{ pointerEvents: 'auto', flexShrink: 0 }}
                    data-checked={String(autoSaveEnabled)}
                    onClick={() => setAutoSaveEnabled(!autoSaveEnabled)}
                    role="switch"
                    aria-checked={autoSaveEnabled}
                  >
                    <span className="toggleThumb" />
                  </span>
                </label>
              </div>
            </div>
          </details>
          <div className="menuItem" onClick={() => setShowAboutModal(true)}>Acerca de</div>

          <div style={{ flex: 1, minWidth: '20px' }} data-tauri-drag-region />

          {/* Centered Brand Logo & Title */}
          <div style={{ 
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            pointerEvents: 'none', userSelect: 'none',
            display: 'flex', alignItems: 'center', gap: '0.6rem'
          }} data-tauri-drag-region>
            <div style={{
              background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
              width: '24px', height: '24px', borderRadius: '6px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 4px rgba(22, 163, 74, 0.2)'
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <span className="studioLogoText" style={{ 
              fontSize: '0.9rem', fontWeight: 800, 
              background: 'linear-gradient(to right, #111, #444)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              letterSpacing: '-0.01em', fontFamily: 'Inter, system-ui, sans-serif'
            }}>
              SAE <span style={{ color: '#16a34a', WebkitTextFillColor: '#16a34a' }}>Studio</span>
            </span>
          </div>

          <div className="windowControls">
            <span
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginRight: '0.25rem', userSelect: 'none' }}
              title={darkMode ? 'Modo oscuro activo — click para cambiar a claro' : 'Modo claro activo — click para cambiar a oscuro'}
            >
              {/* Sun / Moon SVG icon */}
              <span style={{ opacity: 0.6, display: 'flex', alignItems: 'center', color: 'var(--muted)' }}>
                {darkMode ? (
                  // Moon icon
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                ) : (
                  // Sun icon
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5"/>
                    <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                    <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                  </svg>
                )}
              </span>
              <span
                className="toggleTrack"
                data-checked={String(darkMode)}
                onClick={() => setDarkMode(d => !d)}
                role="switch"
                aria-checked={darkMode}
                style={{ cursor: 'pointer' }}
              >
                <span className="toggleThumb" />
              </span>
            </span>
            <button className="winBtn" onClick={() => getCurrentWindow().minimize()}>
              <svg width="10" height="1" viewBox="0 0 10 1"><line x1="0" y1="0.5" x2="10" y2="0.5" stroke="currentColor" strokeWidth="1"/></svg>
            </button>
            <button className="winBtn" onClick={() => getCurrentWindow().toggleMaximize()}>
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
            </button>
            <button className="winBtn close" onClick={() => getCurrentWindow().close()}>
              <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
            </button>
          </div>
        </nav>

        {/* ── Conmutador de Vistas (Tabs) ── */}
        <div className="tabBarContainer" style={{
          display: 'flex', alignItems: 'center', gap: '2px',
          padding: '0 8px', borderBottom: '1px solid var(--border,#e2e8f0)',
          background: 'var(--bg-tabs, #f8fafc)', flexShrink: 0, height: '36px'
        }}>
          {(['sae', 'saetickets'] as const).map(k => (
              <button key={k} onClick={() => handleSwitchKind(k)}
              className={`designerTab ${docKind === k ? 'active' : ''}`}
              style={{
                padding: '0 24px', fontSize: '0.82rem', height: '100%',
                border: 'none', 
                borderBottom: docKind === k ? '2.5px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer', fontWeight: docKind === k ? 800 : 500,
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                background: docKind === k ? 'transparent' : 'transparent',
                color: docKind === k ? 'var(--accent)' : 'var(--muted)',
                display: 'flex', alignItems: 'center', gap: '0.65rem',
                position: 'relative',
                textTransform: 'none',
                letterSpacing: '0.01em'
              }}>
              {k === 'saetickets' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="6" y1="16" x2="6" y2="16"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
              )}
              {k === 'saetickets' ? 'Diseñador de Tiquetes' : 'Diseñador de Etiquetas'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#fff' }}>
          {docKind === 'saetickets' ? (
            <TicketDesigner
              initialXml={xml}
              onUpdate={(newXml) => {
                setXml(newXml);
                setError("");
              }}
              apiBaseUrl={apiBaseUrl}
            />
          ) : (
            <VisualCanvasEditor
              xml={xml}
              apiBaseUrl={apiBaseUrl}
              timeoutMs={timeoutMs}
              docId={docId}
              docName={docName}
              metadata={{
                version: metaVersion,
                brand: metaBrand,
                description: metaDescription,
                part: metaPart,
                size: metaSize,
              }}
              onXmlChange={(nextXml) => {
                setXml(nextXml);
                setError("");
              }}
              onDocNameChange={setDocName}
              onMetadataChange={(m: any) => {
                if (m.version !== undefined) setMetaVersion(m.version);
                if (m.brand !== undefined) setMetaBrand(m.brand);
                if (m.description !== undefined) setMetaDescription(m.description);
                if (m.part !== undefined) setMetaPart(m.part);
                if (m.size !== undefined) setMetaSize(m.size);
              }}
            />
          )}
        </div>

        <footer className="studioFooter">
          <div className="footerStatus">
            <span className={`dot ${saveStatus}`} /> 
            <span style={{ fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {saveStatus === "saved" && "Guardado"}
              {saveStatus === "saving" && "Guardando..."}
              {saveStatus === "modified" && "Cambios pendientes"}
              {saveStatus === "error" && "Error al guardar"}
            </span>
          </div>

          <div className="metaStats">
            <div className="metaItem">
              <span className="metaLabel">Documento:</span>
              <span className="metaValue">{docName || "Sin título"}</span>
            </div>
            <div className="metaDivider" />
            <div className="metaItem">
              <span className="metaLabel">Tamaño:</span>
              <span className="metaValue">{metaSize || "custom"}</span>
            </div>
            <div className="metaDivider" />
            <div className="metaItem">
              <span className="metaValue" style={{ opacity: 0.8 }}>SAE Studio v1.0.0</span>
            </div>
          </div>
        </footer>
      </div>

      {showTemplatesGallery && (
        <Portal>
        <div className="modalBackdrop">
          <div className="modalCard" onClick={(e) => e.stopPropagation()} style={{ width: '800px', maxWidth: '95vw', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.5rem' }}>Galería de Plantillas</h2>
                <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b' }}>Selecciona un diseño base para tu nuevo documento</p>
              </div>
              <button className="winBtn" onClick={() => setShowTemplatesGallery(false)} style={{ background: '#eee', borderRadius: '50%', padding: '8px' }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
              {/* Categoría: Tiquetes y Órdenes */}
              <section>
                <h3 style={{ fontSize: '0.75rem', fontWeight: 800, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem', borderBottom: '2px solid #dcfce7', paddingBottom: '0.5rem' }}>
                  🎫 Tiquetes y Órdenes (POS)
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
                  <button type="button" style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.25rem', textAlign: 'left', cursor: 'pointer', transition: 'all 0.2s' }} 
                    onMouseOver={(e) => e.currentTarget.style.borderColor = '#16a34a'}
                    onMouseOut={(e) => e.currentTarget.style.borderColor = '#e2e8f0'}
                    onClick={() => { selectNewDocumentType("saetickets"); setShowTemplatesGallery(false); }}>
                    <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                      <span style={{ fontSize: '2rem' }}>📄</span>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>Tiquete Estándar</div>
                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Diseño básico de 80mm para ventas generales</div>
                      </div>
                    </div>
                  </button>

                  <button type="button" style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.25rem', textAlign: 'left', cursor: 'pointer', transition: 'all 0.2s' }}
                    onMouseOver={(e) => e.currentTarget.style.borderColor = '#16a34a'}
                    onMouseOut={(e) => e.currentTarget.style.borderColor = '#e2e8f0'}
                    onClick={() => {
                      selectNewDocumentType("saetickets");
                      setTimeout(() => {
                        setXml(`<?xml version="1.0" encoding="utf-8"?>
<saetickets version="1.0">
  <setup width="42"/>
  <commands>
    <text align="center" bold="true" size="extra-large">ORDEN #\${ID}</text>
    <separator char="="/>
    <text align="left" bold="false" size="normal">Mesa: \${MESA}</text>
    <separator char="-"/>
    <each listVar="ITEMS" header="false" childField="EXTRAS">
      <column field="QTY" label="" width="4" align="left"/>
      <column field="DESC" label="" width="auto" align="left"/>
    </each>
    <separator char="-"/>
    <feed lines="2"/>
    <cut/>
  </commands>
</saetickets>`);
                        setDocName("Orden de Cocina");
                      }, 50);
                      setShowTemplatesGallery(false);
                    }}>
                    <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                      <span style={{ fontSize: '2rem' }}>🍳</span>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>Orden de Cocina</div>
                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Optimizado para barra y cocina con sub-items para extras</div>
                      </div>
                    </div>
                  </button>
                </div>
              </section>

              {/* Categoría: Etiquetas */}
              <section>
                <h3 style={{ fontSize: '0.75rem', fontWeight: 800, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem', borderBottom: '2px solid #dbeafe', paddingBottom: '0.5rem' }}>
                  🏷️ Etiquetas y Logística
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.75rem' }}>
                  {LABEL_PRESETS.map(p => (
                    <button key={p.id} type="button" style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '0.75rem 1rem', textAlign: 'left', cursor: 'pointer', transition: 'all 0.15s' }}
                      onMouseOver={(e) => e.currentTarget.style.borderColor = '#3b82f6'}
                      onMouseOut={(e) => e.currentTarget.style.borderColor = '#e2e8f0'}
                      onClick={() => {
                        setNewDocumentDraft({ ...newDocumentDraft, ...p, kind: "sae" });
                        selectNewDocumentType("sae");
                        setShowTemplatesGallery(false);
                      }}>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{p.name}</div>
                      <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{p.width}x{p.height}{p.unit} • {p.brand}</div>
                    </button>
                  ))}
                </div>
              </section>
            </div>
            
            <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="secondary" onClick={() => setShowTemplatesGallery(false)}>Cerrar Galería</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {showNewTypeModal && (
        <Portal>
        <div className="modalBackdrop">
          <div className="modalCard" onClick={(e) => e.stopPropagation()} style={{ width: '560px', maxWidth: '95vw', padding: '2rem' }}>
            <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.75rem', fontWeight: 800 }}>Nuevo Documento</h2>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.95rem' }}>Selecciona el tipo de proyecto para comenzar</p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
              {/* Opción: Etiqueta SAE */}
              <button type="button" 
                style={{ 
                  background: 'var(--bg-card)', border: '2px solid var(--border)', borderRadius: '16px', 
                  padding: '1.5rem', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem'
                }}
                onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 10px 20px rgba(0,0,0,0.05)'; }}
                onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
                onClick={() => {
                  setNewDocumentDraft({ ...newDocumentDraft, ...LABEL_PRESETS[0], kind: "sae" });
                  selectNewDocumentType("sae");
                  setShowNewTypeModal(false);
                }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: '#f0fdfa', color: '#0f766e', display: 'flex', alignItems: 'center', justifyCenter: 'center', fontSize: '1.5rem' }}>🏷️</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.25rem' }}>Etiqueta SAE</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.4 }}>ZPL/TSPL Estándar</div>
                </div>
              </button>

              {/* Opción: Tiquete Estándar */}
              <button type="button" 
                style={{ 
                  background: 'var(--bg-card)', border: '2px solid var(--border)', borderRadius: '16px', 
                  padding: '1.5rem', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem'
                }}
                onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 10px 20px rgba(0,0,0,0.05)'; }}
                onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
                onClick={() => { selectNewDocumentType("saetickets"); setShowNewTypeModal(false); }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: '#f0f9ff', color: '#0369a1', display: 'flex', alignItems: 'center', justifyCenter: 'center', fontSize: '1.5rem' }}>🎟️</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.25rem' }}>Tiquete POS</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.4 }}>Punto de Venta 80mm</div>
                </div>
              </button>

              {/* Opción: Orden de Cocina */}
              <button type="button" 
                style={{ 
                  background: 'var(--bg-card)', border: '2px solid var(--border)', borderRadius: '16px', 
                  padding: '1.5rem', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem'
                }}
                onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 10px 20px rgba(0,0,0,0.05)'; }}
                onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
                onClick={() => {
                  selectNewDocumentType("saetickets");
                  setTimeout(() => {
                    setXml(`<?xml version="1.0" encoding="utf-8"?>
<saetickets version="1.0">
  <setup width="42"/>
  <commands>
    <text align="center" bold="true" size="extra-large">ORDEN #\${ID}</text>
    <separator char="="/>
    <text align="left" bold="false" size="normal">Mesa: \${MESA}</text>
    <separator char="-"/>
    <each listVar="ITEMS" header="false">
      <column field="QTY" label="" width="4" align="left"/>
      <column field="DESC" label="" width="auto" align="left"/>
    </each>
    <separator char="-"/>
    <feed lines="2"/>
    <cut/>
  </commands>
</saetickets>`);
                    setDocName("Orden de Cocina");
                  }, 50);
                  setShowNewTypeModal(false);
                }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: '#fefce8', color: '#a16207', display: 'flex', alignItems: 'center', justifyCenter: 'center', fontSize: '1.5rem' }}>🍳</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.25rem' }}>Orden Cocina</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.4 }}>Comandas y Pedidos</div>
                </div>
              </button>

              {/* Opción: Configuración Personalizada */}
              <button type="button" 
                style={{ 
                  background: 'var(--bg-card)', border: '2px solid var(--border)', borderRadius: '16px', 
                  padding: '1.5rem', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem'
                }}
                onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 10px 20px rgba(0,0,0,0.05)'; }}
                onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
                onClick={() => {
                  setNewDocumentDraft(p => ({ ...p, kind: "sae", name: "Nuevo Documento" }));
                  setShowNewTypeModal(false);
                  setShowNewConfigModal(true);
                }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: '#f5f3ff', color: '#5b21b6', display: 'flex', alignItems: 'center', justifyCenter: 'center', fontSize: '1.5rem' }}>⚙️</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.25rem' }}>Personalizado</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.4 }}>Configurar dimensiones</div>
                </div>
              </button>
            </div>

            <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'center' }}>
              <button type="button" className="secondary" style={{ padding: '0.75rem 2.5rem', borderRadius: '12px' }} onClick={() => setShowNewTypeModal(false)}>Cancelar</button>
            </div>
          </div>
        </div>
        </Portal>
      )}
      {showNewConfigModal && (
        <Portal>
        <div className="modalBackdrop">
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <h3>Configurar etiqueta ({newDocumentDraft.kind})</h3>
            <div className="newDocGrid">
              <label className="menuField">
                Plantilla
                <select value={selectedPresetId} onChange={(e) => applyPreset(e.target.value)}>
                  {LABEL_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="menuField">
                Nombre
                <input value={newDocumentDraft.name} onChange={(e) => setNewDocumentDraft((p) => ({ ...p, name: e.target.value }))} />
              </label>
              <label className="menuField">
                Ancho
                <input type="number" min={0.1} step={0.1} value={newDocumentDraft.width} onChange={(e) => setNewDocumentDraft((p) => ({ ...p, width: Math.max(0.1, Number(e.target.value) || 0.1) }))} />
              </label>
              <label className="menuField">
                Alto
                <input type="number" min={0.1} step={0.1} value={newDocumentDraft.height} onChange={(e) => setNewDocumentDraft((p) => ({ ...p, height: Math.max(0.1, Number(e.target.value) || 0.1) }))} />
              </label>
              <label className="menuField">
                Unidad
                <select value={newDocumentDraft.unit} onChange={(e) => setNewDocumentDraft((p) => ({ ...p, unit: e.target.value as Unit }))}>
                  <option value="mm">mm</option>
                  <option value="cm">cm</option>
                  <option value="in">in</option>
                  <option value="pt">pt</option>
                </select>
              </label>
              <label className="menuField">
                Brand
                <input value={newDocumentDraft.brand} onChange={(e) => setNewDocumentDraft((p) => ({ ...p, brand: e.target.value }))} />
              </label>
              <label className="menuField">
                Description
                <input value={newDocumentDraft.description} onChange={(e) => setNewDocumentDraft((p) => ({ ...p, description: e.target.value }))} />
              </label>
              <label className="menuField">
                Part
                <input value={newDocumentDraft.part} onChange={(e) => setNewDocumentDraft((p) => ({ ...p, part: e.target.value }))} />
              </label>
              <label className="menuField">
                Size
                <input value={newDocumentDraft.size} onChange={(e) => setNewDocumentDraft((p) => ({ ...p, size: e.target.value }))} />
              </label>
            </div>
            <div className="modalActions">
              <button type="button" className="secondary" onClick={() => { setShowNewConfigModal(false); setShowNewTypeModal(true); }}>Atras</button>
              <button type="button" className="secondary" onClick={() => setShowNewConfigModal(false)}>Cancelar</button>
              <button type="button" onClick={createConfiguredDocument}>Crear documento</button>
            </div>
          </div>
        </div>
        </Portal>
      )}
      {showApiConfigModal && (
        <Portal>
        <div className="modalBackdrop">
          <div className="modalCard" onClick={(e) => e.stopPropagation()} style={{ width: '460px', maxWidth: '95vw' }}>
            <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
              Configuración de API
            </h3>
            
            <div style={{ background: 'var(--bg-subtle)', borderRadius: '6px', padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.82rem', color: 'var(--muted)', border: '1px solid var(--border)' }}>
              <strong>URL del servidor SAELABEL.Api local.</strong><br />
              Por defecto: <code style={{ background: 'var(--bg-card)', padding: '0.1rem 0.3rem', borderRadius: '3px' }}>http://localhost:5117</code>
            </div>

            <label style={{ display: 'block', margin: '0 0 0.5rem', fontSize: '0.85rem', fontWeight: 500 }}>API Base URL
              <input
                type="text"
                value={apiBaseUrlDraft}
                onChange={(e) => { setApiBaseUrlDraft(e.target.value); setPingStatus(""); }}
                placeholder="http://localhost:5117"
                style={{ display: 'block', width: '100%', marginTop: '0.4rem', padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.9rem' }}
                onKeyDown={(e) => { if (e.key === 'Enter') pingBackend(apiBaseUrlDraft.trim()); }}
              />
            </label>

            {pingStatus && (
              <div style={{
                padding: '0.6rem 0.8rem',
                borderRadius: '5px',
                fontSize: '0.82rem',
                marginTop: '0.5rem',
                background: pingStatus.startsWith('✅') ? '#dcfce7' : pingStatus.startsWith('❌') ? '#fee2e2' : '#fef9c3',
                color: pingStatus.startsWith('✅') ? '#166534' : pingStatus.startsWith('❌') ? '#991b1b' : '#854d0e',
              }}>
                {pingStatus}
              </div>
            )}

            <div className="modalActions" style={{ marginTop: '1.5rem' }}>
              <button type="button" className="secondary" onClick={() => setShowApiConfigModal(false)}>Cancelar</button>
              <button type="button" className="secondary" onClick={async () => {
                const next = apiBaseUrlDraft.trim();
                if (!next) { setPingStatus("❌ La URL no puede estar vacía."); return; }
                await pingBackend(next);
              }}>Probar conexión</button>
              <button type="button" className="primary" onClick={async () => {
                const next = apiBaseUrlDraft.trim();
                if (!next) { setPingStatus("❌ La URL no puede estar vacía."); return; }
                const ok = await pingBackend(next);
                if (ok) {
                  setApiBaseUrl(next);
                  setShowApiConfigModal(false);
                  setPingStatus("");
                }
              }}>Probar y Guardar</button>
            </div>
          </div>
        </div>
        </Portal>
      )}
      {showOpenDocModal && (
        <Portal>
        <div className="modalBackdrop">
          <div className="modalCard" onClick={(e) => e.stopPropagation()} style={{ width: '600px', maxWidth: '95vw', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Abrir documento de base de datos</h3>
              <button className="winBtn" onClick={() => setShowOpenDocModal(false)}>✕</button>
            </div>
            <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem' }}>
              <input 
                type="text" 
                placeholder="Buscar documento..." 
                value={openDocSearch}
                onChange={(e) => setOpenDocSearch(e.target.value)}
                autoFocus
                style={{ flex: 1, padding: '0.75rem 1rem', borderRadius: '10px', border: '1px solid var(--border)' }}
              />
            </div>
            <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px', background: '#fff' }}>
              {documents.filter(d => d.name.toLowerCase().includes(openDocSearch.toLowerCase())).length > 0 ? (
                documents.filter(d => d.name.toLowerCase().includes(openDocSearch.toLowerCase())).map(d => (
                  <button 
                    key={d.id} 
                    type="button" 
                    onClick={() => { loadDocument(d.id); setShowOpenDocModal(false); }}
                    style={{
                      width: '100%', textAlign: 'left', padding: '0.8rem 1rem', background: 'none', border: '0',
                      borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: '0.75rem',
                      cursor: 'pointer', transition: 'background 0.2s'
                    }}
                    onMouseOver={(e) => e.currentTarget.style.background = '#f8fafc'}
                    onMouseOut={(e) => e.currentTarget.style.background = 'none'}
                  >
                    <span style={{ fontSize: '1.2rem' }}>{d.kind === 'saetickets' ? '🎫' : '🏷️'}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#1e293b' }}>{d.name}</div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Tipo: {d.kind} • Actualizado: {new Date(d.updatedAtUtc).toLocaleString()}</div>
                    </div>
                    <button 
                      type="button" 
                      onClick={(e) => { e.stopPropagation(); deleteDocument(d.id); }}
                      className="winBtn"
                      style={{ padding: '0.4rem', color: '#ef4444', opacity: 0.6 }}
                      onMouseOver={(e) => e.currentTarget.style.opacity = '1'}
                      onMouseOut={(e) => e.currentTarget.style.opacity = '0.6'}
                      title="Eliminar documento"
                    >
                      🗑️
                    </button>
                  </button>
                ))
              ) : (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>No se encontraron documentos</div>
              )}
            </div>
          </div>
        </div>
        </Portal>
      )}
      {showResultModal && (
        <Portal>
        <div className="modalBackdrop">
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <h3>Resultado actual</h3>
            <pre style={{ maxHeight: "55vh", marginBottom: "0.6rem" }}>{result || "Sin resultado todavia."}</pre>
            <div className="modalActions">
              <button type="button" className="secondary" onClick={() => setShowResultModal(false)}>Cerrar</button>
              <button type="button" className="secondary" onClick={copyResult} disabled={!result}>Copiar</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      <style>{`
        .panel.visualMode {
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-height: 0;
          background: transparent !important;
          height: 100vh;
          width: 100%;
          align-items: center;
          justify-content: center;
          padding: 0;
          margin: 0;
          border-radius: 12px;
        }
        h1 {
          margin-top: 0;
          margin-bottom: 0.25rem;
          font-weight: 800;
          letter-spacing: -0.02em;
          color: var(--text);
        }
        h2 {
          margin: 0;
          font-size: 1rem;
          font-weight: 700;
          color: var(--text);
        }
        p {
          color: var(--muted);
          margin-top: 0;
          margin-bottom: 1.5rem;
          line-height: 1.6;
        }
        .hint {
          margin: -0.75rem 0 1rem;
          font-size: 0.85rem;
          color: var(--accent);
          font-weight: 500;
        }
        .viewToggle {
          display: flex;
          gap: 0.5rem;
          margin: 1.25rem 0;
          background: #f1f5f9;
          padding: 0.25rem;
          border-radius: 10px;
          width: fit-content;
        }
        label {
          display: block;
          margin-bottom: 0.85rem;
          font-weight: 600;
          font-size: 0.9rem;
          color: var(--text);
        }
        input, select, textarea {
          margin-top: 0.4rem;
          width: 100%;
          border: 1px solid var(--border);
          border-radius: 8px;
          font-family: inherit;
          font-size: 0.9rem;
          padding: 0.65rem 0.75rem;
          box-sizing: border-box;
          background: #fff;
          transition: all 0.2s ease;
          color: var(--text);
        }
        textarea, pre {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
        }
        input:focus, select:focus, textarea:focus {
          outline: none;
          border-color: var(--accent);
          box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.1);
        }
        textarea {
          min-height: 280px;
          resize: vertical;
          line-height: 1.5;
        }
        .row {
          display: flex;
          gap: 0.75rem;
          align-items: end;
          margin-bottom: 1rem;
        }
        .grow {
          flex: 1;
        }
        .actions {
          display: flex;
          gap: 0.75rem;
          margin: 1.5rem 0;
        }
        .resultHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin: 1.5rem 0 0.75rem;
        }
        .historyHeader {
          margin-top: 2rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .resultActions {
          display: flex;
          gap: 0.5rem;
        }
        button {
          background: var(--accent);
          color: white;
          border: 0;
          border-radius: 8px;
          padding: 0.65rem 1.25rem;
          font-weight: 600;
          font-size: 0.9rem;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        button:hover:not(:disabled) {
          filter: brightness(1.1);
          transform: translateY(-1px);
        }
        button:active:not(:disabled) {
          transform: translateY(0);
        }
        button.secondary {
          background: #ffffff;
          color: var(--text);
          border: 1px solid var(--border);
          box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        button.secondary:hover:not(:disabled) {
          background: #f8fafc;
          border-color: #cbd5e1;
        }
        button.active {
          background: var(--accent);
          color: #fff;
          box-shadow: 0 4px 12px rgba(15, 118, 110, 0.2);
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        pre {
          margin-top: 0;
          background: #f8fafc;
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 1rem;
          overflow: auto;
          max-height: 400px;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 0.85rem;
          color: var(--text);
        }
        .error {
          border-color: #fca5a5;
          color: #991b1b;
          background: #fef2f2;
          font-weight: 500;
        }
        .history {
          margin: 0.75rem 0 0;
          padding: 0;
          list-style: none;
          border: 1px solid var(--border);
          border-radius: 10px;
          overflow: hidden;
          background: #fff;
        }
        .history li {
          display: grid;
          grid-template-columns: 1.4fr 1.2fr 0.8fr 2fr;
          gap: 0.75rem;
          padding: 0.75rem 1rem;
          border-top: 1px solid var(--border);
          font-size: 0.85rem;
          align-items: center;
        }
        .history li:first-child {
          border-top: 0;
        }
        .history li.ok {
          border-left: 4px solid var(--accent);
        }
        .history li.fail {
          border-left: 4px solid #ef4444;
          background: #fffafa;
        }
        .history span:first-child {
          color: var(--muted);
          font-size: 0.8rem;
        }
        .history .empty {
          display: block;
          padding: 2rem;
          text-align: center;
          color: var(--muted);
        }
        
        /* Studio & Editor Styles */
        .editorStudio {
          display: grid;
          grid-template-rows: auto minmax(0, 1fr) auto;
          border: 1px solid var(--border);
          border-radius: 0;
          overflow: hidden;
          background: #f8fafc;
          min-height: 0;
          flex: 1 1 auto;
        }
        .studioTopbar {
          background: #ffffff;
          border-bottom: 1px solid var(--border);
          padding: 0.8rem 1.5rem;
          display: flex;
          justify-content: flex-start;
          align-items: center;
          flex-wrap: wrap;
          gap: 1.5rem;
          flex: 0 0 auto;
        }
        .zoomControlContainer, .sizeControlsContainer {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }
        .controlIcon {
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
          opacity: 0.8;
        }
        .unitSelect {
          padding: 0.35rem 0.5rem;
          font-size: 0.8rem;
          font-weight: 600;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: #f8fafc;
          color: var(--text);
          cursor: pointer;
          outline: none;
          transition: all 0.2s;
        }
        .unitSelect:hover {
          border-color: var(--accent);
          background: #fff;
        }
        .toolbarGroup {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }
        .toolbarDivider {
          width: 1px;
          height: 1.5rem;
          background: var(--border);
          margin: 0 0.5rem;
        }
        .fileMenuContainer {
          position: relative;
        }
        .fileMenuDropdown {
          position: absolute;
          top: 100%;
          left: 0;
          margin-top: 0.5rem;
          background: #ffffff;
          border: 1px solid var(--border);
          border-radius: 8px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.1);
          min-width: 200px;
          padding: 0.5rem 0;
          z-index: 100;
          display: flex;
          flex-direction: column;
        }
        .fileMenuDropdown button {
          background: transparent;
          color: var(--text);
          border: 0;
          padding: 0.65rem 1rem;
          text-align: left;
          font-size: 0.85rem;
          cursor: pointer;
          transition: background 0.15s;
          width: 100%;
          border-radius: 0;
        }
        .fileMenuDropdown button:hover {
          background: #f1f5f9;
        }
        .fileMenuDropdown .menuDivider {
          height: 1px;
          background: var(--border);
          margin: 0.4rem 0;
        }
        .fileMenuDropdown .menuLabel {
          padding: 0.4rem 1rem 0.2rem;
          font-size: 0.7rem;
          font-weight: 700;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .fileMenuDropdown .recentItem {
          font-size: 0.8rem;
          color: var(--muted);
          padding: 0.5rem 1rem;
        }
        .fileMenuDropdown .recentItem:hover {
          color: var(--accent);
        }

        /* Modal Properties */
        .modalOverlay {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.65);
          backdrop-filter: blur(4px);
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2rem;
        }
        .propertiesModal {
          background: #ffffff;
          border-radius: 12px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
          width: 100%;
          max-width: 500px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          animation: modalSlide 0.3s ease-out;
        }
        @keyframes modalSlide {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .modalHeader {
          padding: 1.25rem 1.5rem;
          border-bottom: 1px solid var(--border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #f8fafc;
        }
        .modalHeader h3 {
          margin: 0;
          font-size: 1.1rem;
          color: var(--text);
          font-weight: 700;
        }
        .closeBtn {
          background: transparent;
          border: 0;
          font-size: 1.5rem;
          color: var(--muted);
          cursor: pointer;
          padding: 0;
          line-height: 1;
        }
        .closeBtn:hover {
          color: var(--text);
        }
        .modalBody {
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }
        .fieldGroup {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .fieldRow {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
        }
        .fieldGroup label {
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.025em;
        }
        .fieldGroup input {
          padding: 0.6rem 0.75rem;
          border: 1px solid var(--border);
          border-radius: 6px;
          font-size: 0.9rem;
          transition: border-color 0.2s;
        }
        .fieldGroup input:focus {
          border-color: var(--accent);
          outline: none;
          box-shadow: 0 0 0 2px rgba(15, 118, 110, 0.1);
        }
        .modalFooter {
          padding: 1.25rem 1.5rem;
          border-top: 1px solid var(--border);
          background: #f8fafc;
          display: flex;
          justify-content: flex-start;
          gap: 0.75rem;
        }
        .modalFooter button {
          padding: 0.6rem 1.25rem;
          font-size: 0.9rem;
          font-weight: 600;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: #ffffff;
          color: var(--text);
          cursor: pointer;
          transition: all 0.2s;
        }
        .modalFooter button.primary {
          background: var(--accent);
          color: #ffffff;
          border-color: var(--accent);
        }
        .modalFooter button:hover {
          filter: brightness(0.95);
        }
        .zoomLabel {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.8rem;
          font-weight: 600;
          margin-bottom: 0;
        }
        .zoomBadge {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 0.8rem;
          background: #f1f5f9;
          padding: 0.2rem 0.4rem;
          border-radius: 4px;
          color: var(--muted);
        }
        .sizeLabel {
          gap: 0.35rem;
          min-width: 112px;
        }
        .sizeAxis {
          font-size: 0.72rem;
          font-weight: 800;
          color: var(--muted);
          min-width: 12px;
          text-align: center;
        }
        .unitInput {
          position: relative;
          display: inline-flex;
          align-items: center;
        }
        .unitInput input {
          width: 6.2rem;
          margin-top: 0;
          padding-right: 2.05rem;
        }
        .unitInput small {
          position: absolute;
          right: 0.55rem;
          font-size: 0.7rem;
          font-weight: 700;
          color: var(--muted);
          pointer-events: none;
          text-transform: lowercase;
        }
        .studioWrapper {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          background: transparent;
          border: none;
          border-radius: 12px;
          box-shadow: none;
          overflow: hidden;
          margin: 0;
        }
        .editorStudio {
          display: flex;
          flex-direction: column;
          flex: 1;
          width: 100%;
          max-width: none;
          overflow: hidden;
          background: transparent;
          border: none;
        }
        .studioBody {
          display: grid;
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }
        .sidebarResizer {
          background: #cbd5e1;
          cursor: col-resize;
          position: relative;
          z-index: 5;
          transition: background 0.2s ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .sidebarResizer::after {
          content: "";
          width: 2px;
          height: 24px;
          background: rgba(0, 0, 0, 0.15);
          border-radius: 2px;
          box-shadow: 0 4px 0 rgba(0, 0, 0, 0.15), 0 -4px 0 rgba(0, 0, 0, 0.15);
        }
        .sidebarResizer:hover {
          background: #3b82f6;
        }
        .sidebarResizer:hover::after {
          background: rgba(255, 255, 255, 0.8);
          box-shadow: 0 4px 0 rgba(255, 255, 255, 0.8), 0 -4px 0 rgba(255, 255, 255, 0.8);
        }
        .sidebarResizer::before {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(to right, transparent, rgba(59, 130, 246, 0.2), transparent);
          opacity: 0;
          transition: opacity 0.2s ease;
        }
        .sidebarResizer:hover::before {
          opacity: 1;
        }
        .leftSidebar, .rightSidebar {
          background: #fff;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-height: 0;
          height: 100%;
          border-color: var(--border);
        }
        .leftSidebar { border-right: 1px solid var(--border); border-radius: 0; }
        .rightSidebar { border-left: 1px solid var(--border); border-radius: 0; }
        
        .sidebarHeader {
          padding: 1rem 1.25rem 0.5rem;
          flex: 0 0 auto;
        }
        .sidebarTabs {
          display: flex;
          background: #f1f5f9;
          padding: 0.35rem;
          gap: 0.25rem;
          flex: 0 0 auto;
        }
        .sidebarTab {
          flex: 1;
          padding: 0.5rem 0.25rem;
          font-size: 0.75rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.02em;
          border-radius: 6px;
          border: 0;
          background: transparent;
          color: var(--muted);
          cursor: pointer;
          transition: all 0.2s ease;
          white-space: nowrap;
        }
        .sidebarTab:hover {
          color: var(--text);
          background: rgba(255,255,255,0.5);
        }
        .sidebarTabs.vertical {
          flex-direction: column;
          padding: 0.5rem 0.35rem;
          width: 44px;
          border-right: 1px solid var(--border);
          background: #f8fafc;
        }
        .sidebarTab.vertical {
          flex: 0 0 auto;
          width: 32px;
          height: 32px;
          padding: 0;
          margin-bottom: 0.5rem;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
        }
        .sidebarTab.vertical .tabText {
          display: none; /* Hide text, use tooltip or just icons */
        }
        .sidebarTab.vertical:hover {
          background: rgba(15, 118, 110, 0.1);
        }
        .sidebarTab.vertical.active {
          background: var(--accent);
          color: #fff;
          box-shadow: 0 4px 12px rgba(15, 118, 110, 0.25);
        }
        .sidebarTab.vertical.active .tabIcon svg {
          stroke: #fff;
        }
        
        .sidebarScroll {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }
        /* Custom scrollbar */
        .sidebarScroll::-webkit-scrollbar { width: 6px; }
        .sidebarScroll::-webkit-scrollbar-track { background: transparent; }
        .sidebarScroll::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        .sidebarScroll::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
        
        .studioBody h3 {
          margin: 0;
          font-size: 0.9rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--muted);
          display: flex;
          align-items: center;
          height: 100%;
        }
        .studioBody h4 {
          margin: 0 0 1rem;
          font-size: 0.9rem;
          color: var(--text);
        }
        
        .paletteGrid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(55px, 1fr));
          gap: 0.35rem;
        }
        .paletteCard {
          display: flex;
          flex-direction: column;
        }
        .iconBtn {
          display: flex;
          width: 100%;
          background: #fff;
          border: 1px solid var(--border);
          color: var(--text);
          padding: 0.35rem 0.15rem;
          border-radius: 6px;
          cursor: grab;
          flex-direction: column;
          align-items: center;
          gap: 0.15rem;
          user-select: none;
          transition: all 0.2s ease;
        }
        .iconBtn:hover {
          border-color: var(--accent);
          box-shadow: 0 2px 8px rgba(15, 118, 110, 0.08);
          background: #f8fafc;
        }
        .iconBtn .ico {
          font-size: 0.95rem;
          font-weight: 800;
          color: var(--accent);
        }
        .iconBtn small {
          font-size: 0.6rem;
          font-weight: 600;
          color: var(--muted);
          text-align: center;
        }
        .iconBtn .eid {
          display: none;
        }
        .paletteActions {
          margin-top: 0.25rem;
          display: flex;
          gap: 0.25rem;
          align-items: center;
        }
        .paletteActions button {
          flex: 1;
        }
        .baseTag {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          border: 1px dashed var(--border);
          border-radius: 6px;
          background: transparent;
          color: var(--muted);
          padding: 0.35rem;
        }

        .editModeSwitch {
          display: inline-flex;
          align-items: center;
          cursor: pointer;
          user-select: none;
        }
        .editModeSwitch input {
          display: none;
        }
        .editModeSwitch .track {
          display: inline-block;
          width: 32px;
          height: 18px;
          background: #cbd5e1;
          border-radius: 9999px;
          position: relative;
          transition: background 0.2s ease;
        }
        .editModeSwitch .thumb {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 14px;
          height: 14px;
          background: #fff;
          border-radius: 50%;
          transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .editModeSwitch input:checked + .track {
          background: var(--accent);
        }
        .editModeSwitch input:checked + .track .thumb {
          transform: translateX(14px);
        }
        
        .editModeSwitch.mini .track {
          width: 24px;
          height: 12px;
        }
        .editModeSwitch.mini .thumb {
          width: 8px;
          height: 8px;
        }
        .editModeSwitch.mini input:checked + .track .thumb {
          transform: translateX(12px);
        }
        
        .elementForm {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          padding: 1rem;
          background: #f8fafc;
          border-radius: 10px;
          border: 1px solid var(--border);
        }
        .elementForm input, .elementForm select {
          margin-top: 0;
          padding: 0.5rem;
          font-size: 0.85rem;
        }
        .sizeRow {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.5rem;
        }
        .formActions {
          display: flex;
          gap: 0.5rem;
        }
        
        .canvasArea {
          background: #f1f5f9;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-height: 0;
          position: relative;
        }
        .canvasLayout {
          display: grid;
          grid-template-columns: 24px 1fr;
          grid-template-rows: 24px 1fr;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: #f8fafc;
        }
        .rulerCorner {
          grid-area: 1 / 1;
          background: #f8fafc;
          border-right: 1px solid var(--border);
          border-bottom: 1px solid var(--border);
          z-index: 60;
        }
        .ruler {
          background: #fff;
          position: relative;
          z-index: 55;
          user-select: none;
        }
        .ruler.horizontal {
          grid-area: 1 / 2;
          height: 24px;
          border-bottom: 1px solid var(--border);
        }
        .ruler.vertical {
          grid-area: 2 / 1;
          width: 24px;
          border-right: 1px solid var(--border);
        }
        .rulerTick {
          position: absolute;
          background: #cbd5e1;
        }
        .ruler.horizontal .rulerTick { width: 1px; bottom: 0; }
        .ruler.vertical .rulerTick { height: 1px; right: 0; }
        
        .rulerTick.major { background: #64748b; }
        .ruler.horizontal .rulerTick.major { height: 12px; }
        .ruler.vertical .rulerTick.major { width: 12px; }
        
        .rulerTick.mid { background: #94a3b8; }
        .ruler.horizontal .rulerTick.mid { height: 8px; }
        .ruler.vertical .rulerTick.mid { width: 8px; }
        
        .rulerTick.small { background: #e2e8f0; }
        .ruler.horizontal .rulerTick.small { height: 5px; }
        .ruler.vertical .rulerTick.small { width: 5px; }
        
        .rulerLabel {
          position: absolute;
          font-size: 9px;
          color: #64748b;
          font-weight: 600;
        }
        .ruler.horizontal .rulerLabel { top: 2px; transform: translateX(-50%); }
        .ruler.vertical .rulerLabel { left: 2px; transform: translateY(-50%); }

        .canvasViewport {
          grid-area: 2 / 2;
          position: relative;
          flex: 1;
          min-height: 0;
          padding: 3rem;
          overflow: auto;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #e2e8f0;
          background-image: radial-gradient(#cbd5e1 1px, transparent 1px);
          background-size: 20px 20px;
        }
        .studioFooter {
          border-top: 1px solid var(--border);
          background: #fff;
          padding: 0.5rem 1.25rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex: 0 0 auto;
          height: 28px;
          z-index: 50;
        }
        .footerStatus {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          color: var(--text);
        }
        .metaStats {
          display: flex;
          align-items: center;
          gap: 1rem;
          height: 100%;
        }
        .metaItem {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.72rem;
          font-weight: 500;
        }
        .metaLabel {
          color: var(--muted);
          font-weight: 700;
          text-transform: uppercase;
          font-size: 0.65rem;
          letter-spacing: 0.02em;
        }
        .metaValue {
          color: var(--text);
          font-weight: 600;
        }
        .metaDivider {
          width: 1px;
          height: 12px;
          background: var(--border);
          opacity: 0.6;
        }
        .canvasBoard {
          position: relative;
          background: #ffffff;
          box-shadow: 0 20px 50px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05);
          border-radius: 4px;
          transform-origin: center;
          transition: box-shadow 0.3s ease;
        }
        .canvasBoard.dragOver {
          box-shadow: 0 0 0 2px rgba(15, 118, 110, 0.45), 0 10px 30px rgba(0,0,0,0.1);
        }
        .canvasBoard.transform-rotate {
          cursor: grab;
        }
        .canvasBoard.transform-skewAuto,
        .canvasBoard.transform-skewX {
          cursor: ew-resize;
        }
        .canvasBoard.transform-skewY {
          cursor: ns-resize;
        }
        .selectionRect {
          position: absolute;
          pointer-events: none;
          z-index: 25;
        }
        .selectionRect.touch {
          border: 1px dashed #1784d0;
          background: rgba(23, 132, 208, 0.16);
        }
        .selectionRect.contain {
          border: 1px solid #0f7b6c;
          background: rgba(15, 123, 108, 0.12);
        }
        .groupOutline {
          position: absolute;
          pointer-events: none;
          border: 1px dashed rgba(15, 118, 110, 0.55);
          background: rgba(15, 118, 110, 0.04);
          border-radius: 0;
          z-index: 12;
        }
        .groupOutline.selected {
          border: 1.5px solid rgba(245, 158, 11, 0.8);
          background: rgba(245, 158, 11, 0.06);
        }
        .canvasObject {
          position: absolute;
          border: 1.5px solid var(--accent);
          background: rgba(255, 255, 255, 0.8);
          backdrop-filter: blur(4px);
          color: var(--text);
          border-radius: 0;
          padding: 0;
          font-size: 0.75rem;
          cursor: move;
          display: flex;
          flex-direction: column;
          user-select: none;
          transition: none !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.05);
          box-sizing: border-box;
        }
        .canvasObject:hover {
          background: rgba(255, 255, 255, 0.95);
          border-color: var(--accent);
          box-shadow: 0 6px 16px rgba(0,0,0,0.1);
          z-index: 15;
        }
        .canvasObject.box,
        .canvasObject.ellipse,
        .canvasObject.line, 
        .canvasObject.path,
        .canvasObject.barcode { 
          padding: 0; 
          background: transparent;
          border-color: transparent;
          box-shadow: none;
          backdrop-filter: none;
        }
        .canvasObject.path svg {
          width: 100%;
          height: 100%;
          display: block;
        }
        .canvasObject.line:hover,
        .canvasObject.barcode:hover {
          border-color: var(--accent);
        }
        .canvasObject.selected.line,
        .canvasObject.selected.barcode {
          border-color: #f59e0b;
        }
        .lineViz {
          width: 100%;
          height: 100%;
          background: #000;
        }
        .canvasObject > span:not(.resizeHandle) { 
          position: absolute;
          top: -16px;
          left: 0;
          font-weight: 700; 
          text-transform: uppercase; 
          font-size: 0.65rem; 
          color: #475569;
          white-space: nowrap;
          pointer-events: none;
          z-index: 30;
        }
        .canvasObject.selected {
          border-color: #f59e0b;
          background: rgba(245, 158, 11, 0.1);
          box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.2);
          z-index: 20;
        }
        .canvasObject.transforming.rotate,
        .canvasObject.transforming.skewAuto,
        .canvasObject.transforming.skewX,
        .canvasObject.transforming.skewY {
          border-color: #f97316;
          box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.3);
        }
        .resizeHandle {
          position: absolute;
          width: 8px;
          height: 8px;
          background: #fff;
          border: 1.5px solid var(--accent);
          border-radius: 50%;
          z-index: 30;
          transition: transform 0.1s;
        }
        .resizeHandle:hover { transform: scale(1.5); }
        .resizeHandle.transform {
          border-color: #f59e0b;
          background: #fff7ed;
        }
        .resizeHandle.transform.rotateMode {
          cursor: grab !important;
          border-color: #f97316;
        }
        .resizeHandle.transform.skewMode {
          cursor: ew-resize !important;
          border-color: #0ea5e9;
          background: #eff6ff;
        }
        .resizeHandle.n { top: -4px; left: calc(50% - 4px); cursor: ns-resize; }
        .resizeHandle.s { bottom: -4px; left: calc(50% - 4px); cursor: ns-resize; }
        .resizeHandle.e { right: -4px; top: calc(50% - 4px); cursor: ew-resize; }
        .resizeHandle.w { left: -4px; top: calc(50% - 4px); cursor: ew-resize; }
        .resizeHandle.ne { top: -4px; right: -4px; cursor: nesw-resize; }
        .resizeHandle.nw { top: -4px; left: -4px; cursor: nwse-resize; }
        .resizeHandle.se { right: -4px; bottom: -4px; cursor: nwse-resize; }
        .resizeHandle.sw { left: -4px; bottom: -4px; cursor: nesw-resize; }
        
        /* App Menu */
        .appMenu {
          display: flex;
          align-items: center;
          background: #ffffff;
          border-bottom: 1px solid var(--border);
          padding: 12px 0.5rem 8px;
          flex: 0 0 auto;
          z-index: 100;
          width: 100%;
          margin-bottom: 0;
          user-select: none;
        }
        .windowControls {
          display: flex;
          align-items: center;
          height: 100%;
          -webkit-app-region: no-drag;
          margin-right: 12px;
        }
        .winBtn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 100%;
          background: transparent;
          border: none;
          color: var(--text);
          cursor: pointer;
          transition: background 0.2s, color 0.2s;
          padding: 0;
          border-radius: 0;
        }
        .winBtn:hover {
          background: rgba(0,0,0,0.05);
        }
        .winBtn.close:hover {
          background: #e81123;
          color: white;
        }
        .menuItem, .menuDropdown summary {
          -webkit-app-region: no-drag;
        }
        .menuField {
          margin-bottom: 0;
          font-size: 0.75rem;
          color: var(--muted);
          min-width: 180px;
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }
        .menuField input,
        .menuField select {
          margin-top: 0;
          padding: 0.6rem 0.75rem;
          font-size: 0.85rem;
          border-radius: 8px;
          border: 1px solid var(--border);
          transition: all 0.2s;
          background: #f8fafc;
        }
        .menuField input:focus,
        .menuField select:focus {
          outline: none;
          border-color: var(--accent);
          background: #fff;
          box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.1);
        }
        .menuField.grow {
          flex: 1;
          min-width: 260px;
        }
        
        /* Premium styles now global in Layout.astro */
        .typeChoiceRow {
          display: flex;
          gap: 0.6rem;
          margin-bottom: 0.75rem;
        }
        .newDocGrid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 0.6rem;
        }
        .newDocGrid .menuField {
          min-width: 0;
        }
        .menuItem {
          padding: 0.6rem 1.2rem;
          font-size: 0.85rem;
          font-weight: 500;
          color: #4b5563;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          transition: all 0.2s ease;
          letter-spacing: 0.01em;
        }
        .menuItem:hover {
          background: #f8fafc;
          color: var(--accent);
        }
        .menuItem.active {
          border-bottom-color: var(--accent);
          color: var(--accent);
          font-weight: 700;
        }
        .menuDropdown {
          position: relative;
        }
        .menuDropdown summary {
          list-style: none;
        }
        .menuDropdown summary::-webkit-details-marker {
          display: none;
        }
        .menuDropdownList {
          position: absolute;
          top: calc(100% + 2px);
          left: 0;
          min-width: 210px;
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          background: #fff;
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 0.3rem;
          box-shadow: 0 10px 24px rgba(0,0,0,0.12);
          z-index: 200;
          text-transform: none;
        }
        .menuDivider {
          height: 1px;
          background: var(--border);
          margin: 0.4rem 0.5rem;
          opacity: 0.6;
        }
        .menuDropdownItem {
          background: transparent;
          border: 0;
          color: var(--text);
          border-radius: 6px;
          padding: 0.5rem 0.8rem;
          font-size: 0.85rem;
          font-weight: 500;
          text-align: left;
          display: flex;
          align-items: center;
          justify-content: flex-start;
          width: auto;
          box-sizing: border-box;
          cursor: pointer;
          border-left: 3.5px solid transparent;
          transition: all 0.2s ease;
        }
        .menuDropdownItem:hover {
          background: var(--hover-bg, #f1f5f9);
          color: var(--accent);
          border-left-color: var(--accent);
        }
        .menuDropdownItem.active {
          background: #e6fffb;
          color: var(--accent);
        }
        .menuSubDropdown {
          position: relative;
          overflow: visible;
        }
        .menuSubDropdown summary {
          list-style: none;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .menuSubDropdown summary::-webkit-details-marker {
          display: none;
        }
        .menuSubDropdownList {
          position: absolute;
          left: 100%;
          top: 0;
          margin-left: 2px;
          min-width: 180px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: #fff;
          padding: 0.3rem;
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          box-shadow: 0 8px 20px rgba(0,0,0,0.1);
          z-index: 210;
        }
        
        .inspectorFields {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
        }
        .inspectorFields label {
          margin-bottom: 0;
        }
        .inspectorFields input {
          margin-top: 0.25rem;
        }
        .inspectorFields .full {
          grid-column: 1 / -1;
        }
        .previewPanel {
          border: 1px solid var(--border);
          border-radius: 0;
          background: #f8fafc;
          padding: 0.6rem;
          margin-bottom: 1rem;
        }
        .previewViewport {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 170px;
          background: #e2e8f0;
          border-radius: 8px;
          padding: 0.6rem;
          overflow: auto;
        }
        .previewLabel {
          position: relative;
          background: #fff;
          border: 1px solid #cbd5e1;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08);
          overflow: hidden;
        }
        .previewObject {
          position: absolute;
          border: 1px solid #0f766e;
          background: rgba(15, 118, 110, 0.06);
          color: #0f172a;
          border-radius: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding: 1px 2px;
          pointer-events: none;
          transform-origin: center center;
        }
        .previewObject.line {
          background: transparent;
          border-top: 1px solid #0f766e;
          border-right: 0;
          border-left: 0;
          border-bottom: 0;
          padding: 0;
          min-height: 1px;
        }
        .previewObject.image {
          background: rgba(59, 130, 246, 0.08);
          border-color: #2563eb;
        }
        .previewObject.barcode {
          background: transparent;
          border: none;
          color: transparent;
        }

        .iconBtn * { pointer-events: none; }
        
        .contextMenu {
          position: fixed;
          background: #fff;
          border: 1px solid var(--border);
          border-radius: 8px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.15);
          padding: 0.25rem;
          z-index: 1000;
          min-width: 160px;
        }
        .contextMenu .menuItem {
          padding: 0.6rem 0.75rem;
          font-size: 0.85rem;
          border-bottom: 0;
          border-radius: 6px;
          margin: 0;
          display: block;
        }
        .contextMenu .menuItem:hover {
          background: #f1f5f9;
          color: var(--accent);
        }
        .contextMenu .menuItem.danger {
          color: #ef4444;
        }
        .contextMenu .menuItem.danger:hover {
          background: #fef2f2;
        }
        .contextMenu .menuLine {
          height: 1px;
          background: var(--border);
          margin: 0.25rem 0.5rem;
        }
        
        .contextMenu .menuItem.disabled {
          opacity: 0.4;
          cursor: not-allowed;
          pointer-events: none;
        }
        
        /* Layer Panel Styles */
        .layersPanel {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
        }
        .layersList {
          flex: 1;
          overflow: auto;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          padding: 0.5rem;
        }
        .layerGroupWrap {
          display: flex;
          flex-direction: column;
        }
        .layerItem {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 0.75rem;
          background: #fff;
          border-bottom: 1px solid #e2e8f0;
          font-size: 0.82rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s;
        }
        .layerItem:hover {
          background: #f8fafc;
        }
        .layerItem.selected {
          background: #f0fdfa;
          border-left: 3px solid var(--accent);
          padding-left: calc(0.75rem - 3px);
          color: var(--accent);
        }
        .layerItem.layerGroup {
          background: #f1f5f9;
          font-weight: 700;
        }
        .layerItem.layerChild {
          padding-left: 2.25rem;
          font-size: 0.78rem;
          background: #fff;
        }
        .layerItem.layerChild.selected {
          padding-left: calc(2.25rem - 3px);
        }
        .layerIcon {
          display: flex;
          align-items: center;
          justify-content: center;
          color: #64748b;
          opacity: 0.8;
        }
        .selected .layerIcon {
          color: var(--accent);
          opacity: 1;
        }
        .layersToolbar {
          display: flex;
          align-items: center;
          gap: 0.15rem;
          padding: 0.3rem 0.4rem;
          background: #fff;
          border-top: 1px solid var(--border);
          border-radius: 0 0 8px 8px;
        }
        .toolBtn {
          flex: 1;
          height: 28px;
          min-width: 0;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 4px;
          color: #64748b;
          cursor: pointer;
          transition: all 0.2s;
        }
        .toolBtn svg {
          stroke: currentColor;
        }
        .toolBtn:hover:not(:disabled) {
          background: #f1f5f9;
          border-color: #cbd5e1;
          color: var(--accent);
        }
        .toolBtn.danger {
          color: #e74c3c;
        }
        .toolBtn.danger:hover:not(:disabled) {
          background: #fef2f2;
          border-color: #fca5a5;
          color: #ef4444;
        }
          opacity: 0.3;
          cursor: not-allowed;
        }
        .toolBtn.danger:hover:not(:disabled) {
          background: #fef2f2;
          border-color: #fecaca;
          color: #ef4444;
        }
        .toolDivider {
          width: 1px;
          height: 16px;
          background: #e2e8f0;
          margin: 0 0.2rem;
        }

        .visualMode {
          flex: 1;
          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
          border: none !important;
          border-radius: 0 !important;
        }

        /* Inspector Panel Styles */
        .inspectorPanel {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
        }
        .inspectorScroll {
          flex: 1;
          overflow: auto;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          padding: 1rem;
        }
        .inspectorSection {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .sectionHeader {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.72rem;
          font-weight: 800;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border-bottom: 1px solid #f1f5f9;
          padding-bottom: 0.4rem;
        }
        .inspectorFields.grid2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.75rem 1rem;
        }
        .inspectorFields.grid3 {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 0.75rem;
        }
        .inspectorFields label {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          font-size: 0.75rem;
          font-weight: 600;
          color: #475569;
        }
        .inspectorFields label.full {
          grid-column: 1 / -1;
        }
        .inspectorFields input, 
        .inspectorFields select,
        .inspectorFields textarea {
          width: 100%;
          padding: 0.4rem 0.5rem;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 0.8rem;
          background: #fff;
          transition: border-color 0.2s;
        }
        .inspectorFields input:focus {
          border-color: var(--accent);
          outline: none;
        }
        .colorInput {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.2rem;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          background: #fff;
        }
        .colorInput input[type="color"] {
          width: 24px;
          height: 24px;
          padding: 0;
          border: 0;
          border-radius: 4px;
          cursor: pointer;
        }
        .colorInput span {
          font-family: monospace;
          font-size: 0.75rem;
          color: #64748b;
        }
        
        /* Sidebar Edit Mode Styles */
        .mini.active {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
        }
        
        .paletteCard {
          position: relative;
          transition: transform 0.2s ease;
        }
        .paletteCard:hover {
          transform: translateY(-2px);
        }

        .status {
          margin-top: 1rem;
          padding: 0.75rem;
          background: #eff6ff;
          color: #1e40af;
          border-radius: 8px;
          font-size: 0.8rem;
          font-weight: 500;
        }
        .meta {
          margin-top: 2rem;
          padding-top: 1rem;
          border-top: 1px solid var(--border);
          display: grid;
          gap: 0.5rem;
          font-size: 0.8rem;
          color: var(--muted);
        }
        .editorError {
          margin: 1rem;
          padding: 1rem;
          background: #fef2f2;
          color: #991b1b;
          border: 1px solid #fca5a5;
          border-radius: 8px;
          font-weight: 500;
        }
        
        @media (max-width: 1200px) {
          .studioBody {
            grid-template-columns: 240px 6px minmax(0, 1fr) 6px 240px;
          }
        }
        @media (max-width: 760px) {
          .studioBody {
            grid-template-columns: 220px 6px minmax(0, 1fr) 6px 220px;
          }
        }
        @media (max-width: 640px) {
          .row { flex-direction: column; align-items: stretch; }
          .history li { grid-template-columns: 1fr; gap: 0.25rem; }
          .menuField,
          .menuField.grow {
            min-width: 0;
            width: 100%;
          }
        }
        /* Premium Rulers & Guidelines */
        .ruler {
          background: #f1f5f9;
          color: #64748b;
          font-size: 9px;
          border-color: #cbd5e1;
          user-select: none;
        }
        .ruler.horizontal { border-bottom: 1px solid #cbd5e1; }
        .ruler.vertical { border-right: 1px solid #cbd5e1; }
        .rulerTick { stroke: #94a3b8; }
        .rulerTick.major { stroke: #64748b; }
        .rulerLabel { fill: #64748b; }
        
        .guideline {
          position: absolute;
          z-index: 50;
          pointer-events: auto;
          transition: border-color 0.2s;
        }
        .guideline.horizontal {
          width: 5000px;
          height: 0;
          border-top: 1px dashed #38bdf8;
          cursor: ns-resize;
          margin-left: -24px;
        }
        .guideline.vertical {
          width: 0;
          height: 5000px;
          border-left: 1px dashed #38bdf8;
          cursor: ew-resize;
          margin-top: -24px;
        }
        .guideline:hover {
          border-color: #0ea5e9;
          border-style: solid;
        }
        
        /* Barcode Visualization */
        .barcodeViz {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: #fff;
          padding: 4px;
          box-sizing: border-box;
          overflow: hidden;
        }
        .barcodeViz .bars {
          flex: 1;
          width: 100%;
          display: flex;
          align-items: stretch;
          justify-content: center;
          gap: 1px;
        }
        .barcodeViz .bar {
          background: #000;
        }
        .barcodeViz small {
          font-family: 'Courier New', Courier, monospace;
          font-weight: bold;
          font-size: 8px;
          margin-top: 2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .barcodeViz .kindBadge {
          position: absolute;
          top: 2px;
          right: 2px;
          background: rgba(0,0,0,0.05);
          padding: 1px 3px;
          border-radius: 2px;
          font-size: 6px;
          font-weight: bold;
          text-transform: uppercase;
        }
        .studioFooter {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.4rem 1rem;
          background: #f8fafc;
          border-top: 1px solid var(--border);
          font-size: 0.75rem;
          color: var(--muted);
          flex: 0 0 auto;
        }
        .footerStatus {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .footerStatus .dot {
          width: 8px;
          height: 8px;
          background: #22c55e;
          border-radius: 50%;
        }
        .footerMeta {
          font-weight: 500;
        }

        /* ═══════════════════════════════════════════════
           DARK MODE OVERRIDES (all component CSS classes)
           ═══════════════════════════════════════════════ */
        [data-theme="dark"] .ruler {
          background: #0d1525 !important;
          color: #475569 !important;
          border-color: #2d3f55 !important;
        }
        [data-theme="dark"] .ruler.horizontal { border-bottom-color: #2d3f55 !important; }
        [data-theme="dark"] .ruler.vertical { border-right-color: #2d3f55 !important; }
        [data-theme="dark"] .rulerTick { stroke: #334155 !important; }
        [data-theme="dark"] .rulerTick.major { stroke: #475569 !important; }
        [data-theme="dark"] .rulerLabel { fill: #475569 !important; }

        /* Canvas / viewport */
        [data-theme="dark"] .previewViewport { background: #1a2035 !important; }
        [data-theme="dark"] .previewPanel { background: #0d1525 !important; border-color: #2d3f55 !important; }
        [data-theme="dark"] .previewLabel { background: #1e293b !important; border-color: #2d3f55 !important; }
        [data-theme="dark"] .previewObject { color: #e2e8f0 !important; }

        /* Studio footer */
        [data-theme="dark"] .studioFooter { background: #0d1525 !important; border-color: #2d3f55 !important; }

        /* Layer panel */
        [data-theme="dark"] .layerItem { background: #162032 !important; border-color: #2d3f55 !important; color: #e2e8f0 !important; }
        [data-theme="dark"] .layerItem:hover { background: #1e2d42 !important; }
        [data-theme="dark"] .layerItem.selected { background: #0f2e2b !important; color: var(--accent) !important; }
        [data-theme="dark"] .layerItem.layerGroup { background: #0d1525 !important; color: #94a3b8 !important; }
        [data-theme="dark"] .layerItem.layerChild { background: #162032 !important; }
        [data-theme="dark"] .layersToolbar { background: #0d1525 !important; border-color: #2d3f55 !important; }
        [data-theme="dark"] .layerIcon { color: #475569 !important; }

        /* Tool buttons (layer toolbar) */
        [data-theme="dark"] .toolBtn { background: #1e293b !important; border-color: #2d3f55 !important; color: #94a3b8 !important; }
        [data-theme="dark"] .toolBtn:hover:not(:disabled) { background: #2d3f55 !important; color: var(--accent) !important; }
        [data-theme="dark"] .toolDivider { background: #2d3f55 !important; }

        /* Inspector panel */
        [data-theme="dark"] .sectionHeader { color: #64748b !important; border-color: #2d3f55 !important; }
        [data-theme="dark"] .inspectorFields label { color: #64748b !important; }
        [data-theme="dark"] .inspectorFields input,
        [data-theme="dark"] .inspectorFields select,
        [data-theme="dark"] .inspectorFields textarea { background: #0d1525 !important; border-color: #2d3f55 !important; color: #e2e8f0 !important; }
        [data-theme="dark"] .colorInput { background: #0d1525 !important; border-color: #2d3f55 !important; }
        [data-theme="dark"] .colorInput span { color: #94a3b8 !important; }

        /* Context menu */
        [data-theme="dark"] .contextMenu { background: #162032 !important; border-color: #2d3f55 !important; }
        [data-theme="dark"] .contextMenu .menuItem:hover { background: #2d3f55 !important; }
        [data-theme="dark"] .contextMenu .menuItem.danger:hover { background: #450a0a !important; }
        [data-theme="dark"] .contextMenu .menuLine { background: #2d3f55 !important; }

        /* Dropdowns (scoped hardcoded bg) */
        [data-theme="dark"] .menuDropdownList,
        [data-theme="dark"] .menuSubDropdownList { background: #162032 !important; border-color: #2d3f55 !important; }
        [data-theme="dark"] .menuDropdownItem:hover { background: #2d3f55 !important; }
        [data-theme="dark"] .menuDropdownItem.active { background: #0f2e2b !important; }

        /* Editor error */
        [data-theme="dark"] .editorError { background: #2d0a0a !important; border-color: #7f1d1d !important; color: #fca5a5 !important; }

        /* Status */
        [data-theme="dark"] .status { background: #0f1e38 !important; color: #7dd3fc !important; }

        /* SAE Logo visibility in dark mode */
        [data-theme="dark"] .studioLogoText {
          background: linear-gradient(to right, #fff, #cbd5e1) !important;
          -webkit-background-clip: text !important;
          -webkit-text-fill-color: transparent !important;
        }

        /* Improved Grid Dots in dark mode */
        [data-theme="dark"] .canvasViewport {
          background: #0f172a !important;
          background-image: radial-gradient(#475569 1px, transparent 1px) !important;
          background-size: 20px 20px !important;
        }

        /* Sidebar resizers visibility */
        [data-theme="dark"] .sidebarResizer {
          background: transparent !important;
        }
        [data-theme="dark"] .sidebarResizer:hover {
          background: var(--accent) !important;
          opacity: 0.3;
        }

      `}</style>
      {propertiesModalOpen && (
        <Portal>
        <div className="modalBackdrop" onClick={() => setPropertiesModalOpen(false)}>
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: '1.25rem' }}>Propiedades del Documento</h3>
            <div className="newDocGrid">
              <label className="menuField full">
                Nombre
                <input value={docName} onChange={(e) => setDocName(e.target.value)} />
              </label>
              
              {docKind !== 'saetickets' ? (
                <>
                  <label className="menuField">
                    Version
                    <input value={metaVersion} onChange={(e) => setMetaVersion(e.target.value)} />
                  </label>
                  <label className="menuField">
                    Brand
                    <input value={metaBrand} onChange={(e) => setMetaBrand(e.target.value)} />
                  </label>
                  <label className="menuField">
                    Part
                    <input value={metaPart} onChange={(e) => setMetaPart(e.target.value)} />
                  </label>
                  <label className="menuField">
                    Size
                    <input value={metaSize} onChange={(e) => setMetaSize(e.target.value)} />
                  </label>
                  <label className="menuField full">
                    Description
                    <textarea rows={2} value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)} />
                  </label>
                </>
              ) : (
                <div style={{ gridColumn: '1 / -1', padding: '1rem', background: '#f1f5f9', borderRadius: '8px', fontSize: '0.85rem', color: '#475569' }}>
                   <strong>Configuración de Tiquete</strong><br/>
                   Las dimensiones se definen en el bloque Setup del XML como 42 (80mm) o 32 (58mm).
                </div>
              )}
            </div>
            <div className="modalActions">
              <button type="button" className="primary" onClick={() => setPropertiesModalOpen(false)}>Aceptar</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {saveAsModalOpen && (
        <Portal>
        <div className="modalBackdrop" onClick={() => setSaveAsModalOpen(false)}>
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <h3>Guardar como</h3>
            <div className="newDocGrid" style={{ marginTop: "1rem" }}>
              <label className="menuField full">
                Nuevo nombre
                <input autoFocus value={saveAsName} onChange={(e) => setSaveAsName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveAsDoc()} />
              </label>
            </div>
            <div className="modalActions">
              <button type="button" className="secondary" onClick={() => setSaveAsModalOpen(false)}>Cancelar</button>
              <button type="button" className="primary" onClick={saveAsDoc}>Guardar</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {showAboutModal && (
        <Portal>
        <div className="modalBackdrop" onClick={() => setShowAboutModal(false)}>
          <div className="modalCard" onClick={(e) => e.stopPropagation()} style={{ width: '400px', textAlign: 'center' }}>
            <div style={{ marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: '84px', height: '84px', background: 'var(--primary,#16a34a)', borderRadius: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '2.5rem', marginBottom: '1rem', boxShadow: '0 8px 20px rgba(22,163,74,0.2)' }}>
                🏷️
              </div>
              <h2 style={{ margin: 0 }}>SAE Studio</h2>
              <p style={{ margin: '0.2rem 0', opacity: 0.6, fontSize: '0.85rem' }}>Versión 1.2.0-stable</p>
            </div>
            
            <div style={{ background: '#f8fafc', padding: '1.25rem', borderRadius: '12px', marginBottom: '1.5rem', border: '1px solid #e2e8f0' }}>
              <p style={{ margin: '0 0 1rem 0', fontSize: '0.9rem', color: '#475569' }}>
                Suite profesional de diseño de etiquetas y tiquetes para motores de impresión SAE.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' }}>
                <a href="https://github.com/EskenderDev/SAELABEL" target="_blank" style={{ color: 'var(--primary,#16a34a)', fontWeight: 600, textDecoration: 'none', fontSize: '0.85rem' }}>
                  🌐 Ver en GitHub
                </a>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>Licencia MIT</span>
              </div>
            </div>

            <button type="button" className="primary" onClick={() => setShowAboutModal(false)} style={{ width: '100%' }}>
              Cerrar
            </button>
          </div>
        </div>
        </Portal>
      )}

      {showPrintersManagerModal && (
        <Portal>
          <LogicalPrintersManagerModal apiBaseUrl={apiBaseUrl} onClose={() => setShowPrintersManagerModal(false)} />
        </Portal>
      )}
    </section>
  );
}
