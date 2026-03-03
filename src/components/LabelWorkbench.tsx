import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createLabelsApi, DEFAULT_API_BASE_URL, createEditorApi } from "@/lib/api/client";
import type { EditorDocumentSummary, UpsertEditorDocumentPayload } from "@/lib/api/client";
import VisualCanvasEditor from "@/components/VisualCanvasEditor";

type Action = "parse" | "convert-to-glabels" | "convert-from-glabels";
type DocKind = "sae" | "glabels";
type Unit = "mm" | "cm" | "in" | "pt";

const sampleSaeXml =
  `<saelabels version="1.0"><template brand="SAE" description="Demo" part="P-1" size="custom"><label_rectangle width_pt="144" height_pt="72" round_pt="0" x_waste_pt="0" y_waste_pt="0" /><layout dx_pt="0" dy_pt="0" nx="1" ny="1" x0_pt="0" y0_pt="0" /></template><objects /><variables /></saelabels>`;
const sampleGlabelsXml =
  `<Glabels-document version="4.0"><Template brand="Demo" description="Demo" part="P-1" size="custom"><Label-rectangle width="144pt" height="72pt"><Layout dx="144pt" dy="72pt" nx="1" ny="1" x0="0pt" y0="0pt"/></Label-rectangle></Template><Objects/><Variables/><Data/></Glabels-document>`;

const STORAGE = {
  apiBaseUrl: "saelabel.app.apiBaseUrl",
  action: "saelabel.app.action",
  xml: "saelabel.app.xml",
  history: "saelabel.app.history",
  timeoutMs: "saelabel.app.timeoutMs",
  sessions: "saelabel.app.sessions",
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
  const [xml, setXml] = useState(sampleSaeXml);
  const [action, setAction] = useState<Action>("parse");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pingStatus, setPingStatus] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [showApiConfigModal, setShowApiConfigModal] = useState(false);
  const [apiBaseUrlDraft, setApiBaseUrlDraft] = useState("");
  const [showResultModal, setShowResultModal] = useState(false);
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
  const [docId, setDocId] = useState("");
  const [docName, setDocName] = useState("Sin titulo");
  const [documents, setDocuments] = useState<EditorDocumentSummary[]>([]);
  const [metaVersion, setMetaVersion] = useState("1.0");
  const [metaBrand, setMetaBrand] = useState("SAE");
  const [metaDescription, setMetaDescription] = useState("Etiqueta");
  const [metaPart, setMetaPart] = useState("P-1");
  const [metaSize, setMetaSize] = useState("custom");

  const [propertiesModalOpen, setPropertiesModalOpen] = useState(false);
  const [saveAsModalOpen, setSaveAsModalOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedApiBaseUrl = window.localStorage.getItem(STORAGE.apiBaseUrl);
    const savedAction = window.localStorage.getItem(STORAGE.action) as Action | null;
    const savedXml = window.localStorage.getItem(STORAGE.xml);
    const savedHistory = window.localStorage.getItem(STORAGE.history);
    const savedTimeoutMs = window.localStorage.getItem(STORAGE.timeoutMs);
    const savedSessions = window.localStorage.getItem(STORAGE.sessions);

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
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.apiBaseUrl, apiBaseUrl);
  }, [apiBaseUrl]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.action, action);
  }, [action]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE.xml, xml);
  }, [xml]);

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
      console.error("Failed to refresh documents:", e);
    }
  };

  useEffect(() => {
    void refreshDocuments();
  }, [editorApi]);

  const saveDoc = async () => {
    if (!fileHandle) {
      await saveAsDoc();
      return;
    }

    try {
      const writable = await (fileHandle as any).createWritable();
      await writable.write(xml);
      await writable.close();
      
      if (docId) {
        await editorApi.saveDocument({ id: docId, name: docName, kind: newDocumentDraft.kind, xml });
      }
      setResult("Guardado exitosamente.");
      setShowResultModal(true);
    } catch (e) {
      console.error("Failed to save:", e);
      setError("Error al guardar archivo.");
    }
  };

  const saveAsDoc = async () => {
    // Priority: Local Save via Picker
    if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: docName || "etiqueta.xml",
          types: [{
            description: 'XML Files',
            accept: { 'application/xml': ['.xml'] },
          }],
        });
        setFileHandle(handle);
        const writable = await handle.createWritable();
        await writable.write(xml);
        await writable.close();
        setResult("Guardado como nuevo archivo local.");
        setShowResultModal(true);
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
        kind: newDocumentDraft.kind,
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
      setDocId(full.id);
      setDocName(full.name);
      setXml(full.xml);
      setNewDocumentDraft(p => ({ ...p, kind: full.kind as DocKind }));
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
      
      const targetKind = newDocumentDraft.kind === "sae" ? "glabels" : "sae";
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
      setXml(sanitizeXmlInput(text));
      setError("");
      setResult("");
    } catch {
      setError("No se pudo leer el archivo.");
    } finally {
      event.target.value = "";
    }
  };

  const pingBackend = async (targetBaseUrl?: string) => {
    const base = (targetBaseUrl ?? apiBaseUrl).replace(/\/+$/, "");
    setPingStatus("Probando conexion...");
    try {
      const response = await fetch(`${base}/openapi/v1.json`, {
        method: "GET",
      });
      if (response.ok) {
        setPingStatus(`Conexion OK (${response.status})`);
      } else {
        setPingStatus(`Backend responde con ${response.status}`);
      }
    } catch {
      setPingStatus("No hay conexion con el backend.");
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

  const closeAllMenus = () => {
    if (typeof document === "undefined") return;
    document.querySelectorAll(".appMenu details[open]").forEach((el) => {
      (el as HTMLDetailsElement).open = false;
    });
  };

  return (
    <section className="panel visualMode">
      <div className="studioWrapper">
        <nav className="appMenu" data-tauri-drag-region>
          <details className="menuDropdown">
            <summary className="menuItem active">Archivo</summary>
            <div className="menuDropdownList">
              <button type="button" className="menuDropdownItem" onClick={() => { openNewDocumentTypeModal(); closeAllMenus(); }}>
                Nuevo...
              </button>
              <button type="button" className="menuDropdownItem" onClick={() => { setPropertiesModalOpen(true); closeAllMenus(); }}>
                Propiedades
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
              <button type="button" className="menuDropdownItem" onClick={() => { exportToSaeSystem(); closeAllMenus(); }}>
                Exportar a SAE System
              </button>
              <div className="menuDivider" />
              <details className="menuSubDropdown">
                <summary className="menuDropdownItem">Etiquetas recientes</summary>
                <div className="menuSubDropdownList">
                  {documents.length > 0 ? documents.slice(0, 10).map(d => (
                    <button key={d.id} type="button" className="menuDropdownItem" onClick={() => { loadDocument(d.id); closeAllMenus(); }}>
                      {d.name}
                    </button>
                  )) : <div className="menuDropdownItem disabled">No hay etiquetas</div>}
                </div>
              </details>
              <div className="menuDivider" />
              <button type="button" className="menuDropdownItem" onClick={() => { openApiConfigModal(); closeAllMenus(); }}>
                Config API
              </button>
            </div>
          </details>
          <details className="menuDropdown">
            <summary className="menuItem">Editar</summary>
            <div className="menuDropdownList">
              <details className="menuSubDropdown">
                <summary className="menuDropdownItem">Procesar</summary>
                <div className="menuSubDropdownList">
                  <button type="button" className={`menuDropdownItem ${action === "parse" ? "active" : ""}`} onClick={() => { setAction("parse"); closeAllMenus(); }}>
                    parse
                  </button>
                  <button type="button" className={`menuDropdownItem ${action === "convert-to-glabels" ? "active" : ""}`} onClick={() => { setAction("convert-to-glabels"); closeAllMenus(); }}>
                    convert-to-glabels
                  </button>
                  <button type="button" className={`menuDropdownItem ${action === "convert-from-glabels" ? "active" : ""}`} onClick={() => { setAction("convert-from-glabels"); closeAllMenus(); }}>
                    convert-from-glabels
                  </button>
                </div>
              </details>
              <button type="button" className="menuDropdownItem" onClick={() => { setShowResultModal(true); closeAllMenus(); }}>
                Ver resultado
              </button>
            </div>
          </details>
          <details className="menuDropdown">
            <summary className="menuItem">Vista</summary>
            <div className="menuDropdownList">
              <button type="button" className="menuDropdownItem" onClick={restorePanels}>
                Restaurar paneles
              </button>
            </div>
          </details>
          <div className="menuItem" onClick={() => window.open("https://github.com/EskenderDev/SAELABEL", "_blank")}>GitHub</div>
          <div className="menuItem" onClick={() => alert("SAELABEL App Studio v1.0.0")}>Acerca de</div>

          <div style={{ flex: 1, minWidth: '20px' }} data-tauri-drag-region />

          <div className="windowControls">
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
        <footer className="studioFooter">
          <div className="footerStatus">
            <span className="dot" /> Ready
          </div>
          <div className="footerMeta">
            {docName || "Untitled"} • {metaSize || "custom"} • SAE Studio v1.0.0
          </div>
        </footer>
      </div>

      {showNewTypeModal && (
        <div className="modalBackdrop">
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <h3>Nuevo documento</h3>
            <p style={{ marginBottom: "0.8rem" }}>Selecciona el tipo de documento.</p>
            <div className="typeChoiceRow">
              <button type="button" className="secondary" onClick={() => selectNewDocumentType("sae")}>SAELABEL</button>
              <button type="button" className="secondary" onClick={() => selectNewDocumentType("glabels")}>glabels</button>
            </div>
            <div className="modalActions">
              <button type="button" className="secondary" onClick={() => setShowNewTypeModal(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
      {showNewConfigModal && (
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
      )}
      {showApiConfigModal && (
        <div className="modalBackdrop" onClick={() => setShowApiConfigModal(false)}>
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <h3>Configurar API Base URL</h3>
            <label className="menuField" style={{ marginBottom: "0.6rem" }}>
              API Base URL
              <input
                type="text"
                value={apiBaseUrlDraft}
                onChange={(e) => setApiBaseUrlDraft(e.target.value)}
                placeholder="https://localhost:7097"
              />
            </label>
            <div className="modalActions">
              <button type="button" className="secondary" onClick={() => setShowApiConfigModal(false)}>Cancelar</button>
              <button type="button" className="secondary" onClick={async () => {
                const next = apiBaseUrlDraft.trim();
                if (!next) {
                  setError("API Base URL no puede estar vacio.");
                  return;
                }
                await pingBackend(next);
              }}>Probar</button>
              <button type="button" onClick={saveApiConfig}>Guardar</button>
            </div>
          </div>
        </div>
      )}
      {showResultModal && (
        <div className="modalBackdrop" onClick={() => setShowResultModal(false)}>
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <h3>Resultado actual</h3>
            <pre style={{ maxHeight: "55vh", marginBottom: "0.6rem" }}>{result || "Sin resultado todavia."}</pre>
            <div className="modalActions">
              <button type="button" className="secondary" onClick={() => setShowResultModal(false)}>Cerrar</button>
              <button type="button" className="secondary" onClick={copyResult} disabled={!result}>Copiar</button>
            </div>
          </div>
        </div>
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
          background: #e2e8f0;
          cursor: col-resize;
          position: relative;
          z-index: 5;
        }
        .sidebarResizer::before {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(to right, transparent, rgba(15, 118, 110, 0.25), transparent);
          opacity: 0;
          transition: opacity 0.12s ease;
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
        .sidebarTab.active {
          background: #fff;
          color: var(--accent);
          box-shadow: 0 2px 6px rgba(0,0,0,0.06);
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
          margin: 0 0 1rem;
          font-size: 0.9rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--muted);
        }
        .studioBody h4 {
          margin: 1.5rem 0 0.75rem;
          font-size: 0.9rem;
          color: var(--text);
        }
        
        .paletteGrid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.75rem;
        }
        .paletteCard {
          background: #fff;
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 0.5rem;
          transition: all 0.2s ease;
        }
        .paletteCard:hover {
          border-color: var(--accent);
          box-shadow: 0 4px 12px rgba(15, 118, 110, 0.05);
        }
        .iconBtn {
          display: flex;
          width: 100%;
          background: #f8fafc;
          border: 1px solid transparent;
          color: var(--text);
          padding: 0.75rem 0.5rem;
          border-radius: 8px;
          cursor: grab;
          flex-direction: column;
          align-items: center;
          gap: 0.25rem;
          user-select: none;
        }
        .iconBtn .ico {
          font-size: 1.2rem;
          font-weight: 800;
          color: var(--accent);
        }
        .iconBtn small {
          font-size: 0.7rem;
          font-weight: 600;
          color: var(--muted);
        }
        .iconBtn .eid {
          font-size: 0.62rem;
          font-weight: 500;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          opacity: 0.8;
        }
        .paletteActions {
          margin-top: 0.5rem;
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
          border: 1px solid var(--border);
          border-radius: 6px;
          background: #f8fafc;
          color: var(--muted);
          font-size: 0.72rem;
          font-weight: 700;
          padding: 0.22rem 0.35rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .editHint {
          margin-top: 1rem;
          margin-bottom: 0;
          font-size: 0.8rem;
          color: var(--muted);
          background: #f8fafc;
          border: 1px dashed var(--border);
          border-radius: 8px;
          padding: 0.6rem 0.75rem;
        }
        .editModeSwitch {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          margin-bottom: 0;
          user-select: none;
          cursor: pointer;
          color: var(--muted);
        }
        .editModeSwitch input {
          display: none;
        }
        .editModeSwitch .track {
          width: 30px;
          height: 16px;
          border-radius: 999px;
          background: #cbd5e1;
          position: relative;
          transition: background 0.15s ease;
        }
        .editModeSwitch .thumb {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 2px rgba(0,0,0,0.22);
          transition: transform 0.15s ease;
        }
        .editModeSwitch small {
          font-size: 0.72rem;
          font-weight: 700;
          letter-spacing: 0.02em;
          text-transform: uppercase;
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
          padding: 0.75rem 1.25rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex: 0 0 auto;
          box-shadow: 0 -4px 12px rgba(0,0,0,0.03);
          z-index: 50;
        }
        .footerMeta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
        }
        .metaStats {
          display: flex;
          gap: 1.5rem;
          font-size: 0.85rem;
          color: var(--muted);
          font-weight: 500;
        }
        .metaToggle {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          color: var(--muted);
          cursor: pointer;
        }
        .metaToggle small {
          font-weight: 700;
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.02em;
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
          padding: 0.5rem;
          font-size: 0.75rem;
          cursor: move;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          user-select: none;
          transition: none !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.05);
        }
        .canvasObject:hover {
          background: rgba(255, 255, 255, 0.95);
          border-color: var(--accent);
          box-shadow: 0 6px 16px rgba(0,0,0,0.1);
          z-index: 15;
        }
        .canvasObject.ellipse {
          border-radius: 50%;
        }
        .canvasObject.line, 
        .canvasObject.barcode { 
          padding: 0; 
          background: transparent;
          border-color: transparent;
          box-shadow: none;
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
        .canvasObject span { font-weight: 700; text-transform: uppercase; font-size: 0.65rem; color: var(--accent); }
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
          padding: 8px 0.5rem 0;
          flex: 0 0 auto;
          z-index: 100;
          width: 100%;
          margin-bottom: 0;
          user-select: none;
          height: 48px;
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
          gap: 0.2rem;
        }
        .menuField input,
        .menuField select {
          margin-top: 0.2rem;
          padding: 0.45rem 0.6rem;
          font-size: 0.82rem;
        }
        .menuField.grow {
          flex: 1;
          min-width: 260px;
        }
        .modalBackdrop {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.45);
          z-index: 1200;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
        }
        .modalCard {
          width: min(560px, 95vw);
          background: #fff;
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: 0 18px 40px rgba(0,0,0,0.2);
          padding: 1rem;
        }
        .modalCard h3 {
          margin: 0 0 0.8rem;
          font-size: 1rem;
          text-transform: none;
          letter-spacing: normal;
          color: var(--text);
        }
        .modalActions {
          display: flex;
          justify-content: start;
          gap: 0.5rem;
          margin-top: 0.5rem;
        }
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
          color: var(--text);
          cursor: pointer;
          border-bottom: 2px solid transparent;
          transition: all 0.2s ease;
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
          z-index: 30;
          text-transform: capitalize;
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
          padding: 0.45rem 0.55rem;
          font-size: 0.82rem;
          font-weight: 600;
          text-align: left;
        }
        .menuDropdownItem:hover {
          background: #f1f5f9;
          color: var(--accent);
        }
        .menuDropdownItem.active {
          background: #e6fffb;
          color: var(--accent);
        }
        .menuSubDropdown {
          position: relative;
        }
        .menuSubDropdown summary {
          list-style: none;
        }
        .menuSubDropdown summary::-webkit-details-marker {
          display: none;
        }
        .menuSubDropdownList {
          margin-top: 0.2rem;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: #f8fafc;
          padding: 0.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
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
          background: repeating-linear-gradient(
            90deg,
            rgba(15, 23, 42, 0.95) 0 1px,
            rgba(255, 255, 255, 0) 1px 3px
          );
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
          gap: 0.75rem;
          flex: 1;
          min-height: 0;
        }
        .layersList {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          height: 100%;
          max-height: none;
          overflow: auto;
          padding-right: 0.25rem;
        }
        .inspectorPanel {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          flex: 1;
        }
        .layerGroupWrap {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .layerItem {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: #fff;
          color: var(--text);
          padding: 0.35rem 0.45rem;
          font-size: 0.8rem;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .layerItem:hover {
          border-color: #94a3b8;
          background: #f8fafc;
        }
        .layerItem.selected {
          border-color: var(--accent);
          background: rgba(15, 118, 110, 0.08);
          box-shadow: inset 0 0 0 1px rgba(15, 118, 110, 0.14);
        }
        .layerGroup {
          font-weight: 700;
          background: #eef2ff;
        }
        .layerChild {
          margin-left: 0.9rem;
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
      `}</style>
      {propertiesModalOpen && (
        <div className="modalBackdrop" onClick={() => setPropertiesModalOpen(false)}>
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <h3>Propiedades del Documento</h3>
            <div className="newDocGrid" style={{ marginTop: "1rem" }}>
              <label className="menuField">
                Nombre
                <input value={docName} onChange={(e) => setDocName(e.target.value)} />
              </label>
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
            </div>
            <div className="modalActions">
              <button type="button" className="primary" onClick={() => setPropertiesModalOpen(false)}>Aceptar</button>
            </div>
          </div>
        </div>
      )}

      {saveAsModalOpen && (
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
      )}
    </section>
  );
}
