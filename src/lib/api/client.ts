export type XmlRequest = {
  xml: string;
};

export type JsonMap = Record<string, string>;

const API_BASE_URL = import.meta.env.PUBLIC_SAELABEL_API_BASE_URL ?? "https://localhost:7097";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorBody}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }

  return (await response.text()) as T;
}

export const labelsApi = {
  parse: (payload: XmlRequest) => postJson<unknown>("/api/labels/parse", payload),
  convertToGlabels: (payload: XmlRequest) => postJson<string>("/api/labels/convert-to-glabels", payload),
  convertFromGlabels: (payload: XmlRequest) => postJson<string>("/api/labels/convert-from-glabels", payload),
};
