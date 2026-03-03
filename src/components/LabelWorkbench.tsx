import { useMemo, useState } from "react";
import { labelsApi } from "@/lib/api/client";

const sampleXml = `<saelabels version="1.0"><template brand="SAE" description="Demo" part="P-1" size="custom"><label_rectangle width_pt="144" height_pt="72" round_pt="0" x_waste_pt="0" y_waste_pt="0" /><layout dx_pt="0" dy_pt="0" nx="1" ny="1" x0_pt="0" y0_pt="0" /></template><objects /><variables /></saelabels>`;

type Action = "parse" | "convert-to-glabels" | "convert-from-glabels";

export default function LabelWorkbench() {
  const [xml, setXml] = useState(sampleXml);
  const [action, setAction] = useState<Action>("parse");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const buttonLabel = useMemo(() => {
    if (action === "parse") return "Probar parse";
    if (action === "convert-to-glabels") return "Convertir a glabels";
    return "Convertir desde glabels";
  }, [action]);

  const run = async () => {
    setLoading(true);
    setError("");
    setResult("");

    try {
      if (action === "parse") {
        const parsed = await labelsApi.parse({ xml });
        setResult(JSON.stringify(parsed, null, 2));
      } else if (action === "convert-to-glabels") {
        const converted = await labelsApi.convertToGlabels({ xml });
        setResult(converted);
      } else {
        const converted = await labelsApi.convertFromGlabels({ xml });
        setResult(converted);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error desconocido";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel">
      <h1>SAELABEL App</h1>
      <p>Cliente base Tauri 2 + Astro + React conectado al backend C#.</p>

      <label>
        Accion
        <select value={action} onChange={(e) => setAction(e.target.value as Action)}>
          <option value="parse">parse</option>
          <option value="convert-to-glabels">convert-to-glabels</option>
          <option value="convert-from-glabels">convert-from-glabels</option>
        </select>
      </label>

      <label>
        XML
        <textarea value={xml} onChange={(e) => setXml(e.target.value)} rows={9} />
      </label>

      <button onClick={run} disabled={loading}>{loading ? "Procesando..." : buttonLabel}</button>

      {error ? <pre className="error">{error}</pre> : null}
      {result ? <pre>{result}</pre> : null}

      <style>{`
        h1 {
          margin-top: 0;
        }
        p {
          color: #4d5a66;
        }
        label {
          display: block;
          margin-bottom: 0.75rem;
          font-weight: 600;
        }
        select, textarea {
          margin-top: 0.35rem;
          width: 100%;
          border: 1px solid #d8dee4;
          border-radius: 8px;
          font-family: Consolas, "Courier New", monospace;
          font-size: 0.9rem;
          padding: 0.6rem;
          box-sizing: border-box;
        }
        textarea {
          min-height: 220px;
        }
        button {
          background: #0f7b6c;
          color: white;
          border: 0;
          border-radius: 8px;
          padding: 0.6rem 1rem;
          font-weight: 700;
          cursor: pointer;
        }
        button:disabled {
          opacity: 0.7;
          cursor: default;
        }
        pre {
          margin-top: 0.85rem;
          background: #f2f6fa;
          border: 1px solid #d8dee4;
          border-radius: 8px;
          padding: 0.75rem;
          overflow: auto;
          max-height: 360px;
        }
        .error {
          border-color: #dd3b3b;
          color: #a11f1f;
          background: #fff0f0;
        }
      `}</style>
    </section>
  );
}
