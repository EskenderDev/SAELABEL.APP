import {
  labelsConvertFromGlabels,
  labelsConvertToGlabels,
  labelsParse,
} from "@/lib/api/generated";
import { client as generatedClient } from "@/lib/api/generated/client.gen";

export type XmlRequest = {
  xml: string;
};

export type PrintRequest = {
  xml: string;
  printerName: string;
  copies: number;
  data?: Record<string, string>;
  dataList?: Record<string, string>[];
};

export type LogicalPrinterDto = {
  id: string;
  name: string;
  description?: string | null;
  physicalPrinter: string;
  isActive: boolean;
};

export type UpsertLogicalPrinterRequest = {
  id?: string;
  name: string;
  description?: string | null;
  physicalPrinter: string;
  isActive: boolean;
};

export type EditorElementDefinition = {
  id: string;
  key: string;
  name: string;
  category: string;
  objectType: "text" | "barcode" | "box" | "line" | "ellipse" | "image";
  defaultWidthPt: number;
  defaultHeightPt: number;
  defaultContent: string;
};

export type EditorDocumentSummary = {
  id: string;
  name: string;
  kind: "sae" | "glabels";
  updatedAtUtc: string;
};

export type EditorDocument = {
  id: string;
  name: string;
  kind: "sae" | "glabels";
  xml: string;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type UpsertEditorDocumentPayload = {
  id?: string;
  name: string;
  kind: "sae" | "glabels";
  xml: string;
};

export type UpsertEditorElementPayload = {
  id?: string;
  key: string;
  name: string;
  category: string;
  objectType: "text" | "barcode" | "box" | "line" | "ellipse" | "image";
  defaultWidthPt: number;
  defaultHeightPt: number;
  defaultContent: string;
};

type ApiClientOptions = {
  timeoutMs?: number;
};

const DEFAULT_API_BASE_URL = import.meta.env.PUBLIC_SAELABEL_API_BASE_URL ?? "http://localhost:5117";
const DEFAULT_TIMEOUT_MS = 30000;

function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Tiempo de espera excedido (${timeoutMs} ms)`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") {
    const messageLine = error
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    const explicitMessage = error.match(/Mensaje\s*=\s*(.+)/i)?.[1]?.trim();
    if (explicitMessage) return new Error(explicitMessage);

    const dotnetException = error.match(/System\.[\w.]+:\s*([^\r\n]+)/)?.[1]?.trim();
    if (dotnetException) return new Error(dotnetException);

    return new Error(messageLine || "Error desconocido");
  }
  return new Error("Error desconocido");
}

async function requestApi<T>(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  const bodyText = await response.text();

  if (!response.ok) {
    throw normalizeError(bodyText || `Request failed with status ${response.status}`);
  }

  if (!bodyText) {
    return undefined as T;
  }

  if (contentType.toLowerCase().includes("application/json")) {
    return JSON.parse(bodyText) as T;
  }

  return bodyText as T;
}

export function createLabelsApi(baseUrl: string, options?: ApiClientOptions) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  generatedClient.setConfig({
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    fetch: createTimeoutFetch(timeoutMs),
  });

  return {
    parse: async (payload: XmlRequest) => {
      try {
        return await labelsParse({
          body: payload,
          responseStyle: "data",
          throwOnError: true,
        });
      } catch (error) {
        throw normalizeError(error);
      }
    },
    convertToGlabels: async (payload: XmlRequest) => {
      try {
        return await labelsConvertToGlabels({
          body: payload,
          parseAs: "text",
          responseStyle: "data",
          throwOnError: true,
        });
      } catch (error) {
        throw normalizeError(error);
      }
    },
    convertFromGlabels: async (payload: XmlRequest) => {
      try {
        return await labelsConvertFromGlabels({
          body: payload,
          parseAs: "text",
          responseStyle: "data",
          throwOnError: true,
        });
      } catch (error) {
        throw normalizeError(error);
      }
    },
    print: async (payload: PrintRequest) => {
      const fetchImpl = createTimeoutFetch(timeoutMs);
      const url = `${baseUrl.trim().replace(/\/+$/, "")}/api/labels/print`;
      try {
        return await requestApi<{ printed: boolean; printer: string; copies: number }>(fetchImpl, url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw normalizeError(error);
      }
    },
    // Logical Printers
    getSystemPrinters: async () => {
      const fetchImpl = createTimeoutFetch(timeoutMs);
      const url = `${baseUrl.trim().replace(/\/+$/, "")}/api/logical-printers/system-printers`;
      try {
        return await requestApi<string[]>(fetchImpl, url);
      } catch (error) {
        throw normalizeError(error);
      }
    },
    getLogicalPrinters: async () => {
      const fetchImpl = createTimeoutFetch(timeoutMs);
      const url = `${baseUrl.trim().replace(/\/+$/, "")}/api/logical-printers`;
      try {
        return await requestApi<LogicalPrinterDto[]>(fetchImpl, url);
      } catch (error) {
        throw normalizeError(error);
      }
    },
    getLogicalPrinterById: async (id: string) => {
      const fetchImpl = createTimeoutFetch(timeoutMs);
      const url = `${baseUrl.trim().replace(/\/+$/, "")}/api/logical-printers/${encodeURIComponent(id)}`;
      try {
        return await requestApi<LogicalPrinterDto>(fetchImpl, url);
      } catch (error) {
        throw normalizeError(error);
      }
    },
    upsertLogicalPrinter: async (payload: UpsertLogicalPrinterRequest) => {
      const fetchImpl = createTimeoutFetch(timeoutMs);
      const url = `${baseUrl.trim().replace(/\/+$/, "")}/api/logical-printers`;
      try {
        return await requestApi<LogicalPrinterDto>(fetchImpl, url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw normalizeError(error);
      }
    },
    deleteLogicalPrinter: async (id: string) => {
      const fetchImpl = createTimeoutFetch(timeoutMs);
      const url = `${baseUrl.trim().replace(/\/+$/, "")}/api/logical-printers/${encodeURIComponent(id)}`;
      try {
        return await requestApi<void>(fetchImpl, url, {
          method: "DELETE"
        });
      } catch (error) {
        throw normalizeError(error);
      }
    },
  };
}

export const labelsApi = createLabelsApi(DEFAULT_API_BASE_URL);
export { DEFAULT_API_BASE_URL };

export function createEditorApi(baseUrl: string, options?: ApiClientOptions) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = createTimeoutFetch(timeoutMs);
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const basePath = `${normalizedBaseUrl}/api/editor`;

  return {
    listElements: async () =>
      requestApi<EditorElementDefinition[]>(fetchImpl, `${basePath}/elements`, {
        method: "GET",
      }),

    listDocuments: async () =>
      requestApi<EditorDocumentSummary[]>(fetchImpl, `${basePath}/documents`, {
        method: "GET",
      }),

    getDocument: async (id: string) =>
      requestApi<EditorDocument>(fetchImpl, `${basePath}/documents/${encodeURIComponent(id)}`, {
        method: "GET",
      }),

    saveDocument: async (payload: UpsertEditorDocumentPayload) =>
      requestApi<EditorDocument>(fetchImpl, `${basePath}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),

    deleteDocument: async (id: string) =>
      requestApi<void>(fetchImpl, `${basePath}/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),

    saveElement: async (payload: UpsertEditorElementPayload) =>
      requestApi<EditorElementDefinition>(fetchImpl, `${basePath}/elements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),

    deleteElement: async (id: string) =>
      requestApi<void>(fetchImpl, `${basePath}/elements/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  };
}
