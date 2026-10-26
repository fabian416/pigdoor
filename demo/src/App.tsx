import { useEffect, useRef, useState } from "react";
import {
  health,
  sha256Hex,
  toBase64,
  verify,
  verifyCanned,
  evidenceSample,
  VERIFIER,
  type Criterion,
  type VerifyResponse,
} from "./api";
import condition from "./condition.json";
import readingGood from "./reading-good.json";
import readingWrong from "./reading-wrong-shop.json";

const AGREEMENT = "demo";
const MILESTONE = "1";

// La factura viene en pesos y el tope está en USDC, así que el servicio necesita
// una tasa para comparar peras con peras. Sin ella el chequeo del monto se abstiene
// en vez de inventar la conversión, y el demo mostraría un "no sé" justo en el
// control que importa. Los dos caminos, cámara y enlatado, mandan la misma.
const FX = { currency: "ARS", unitsPerAsset: 1450 };

const c = condition as Record<string, any>;
const STORE = c.receiverName as string;
const ITEM = (c.items?.[0] ?? "producto") as string;
const CAP = c.maxAmount as string;

const TERMS = [
  { days: 7, back: "299.74", rate: "3.36%" },
  { days: 14, back: "314.36", rate: "6.40%" },
  { days: 21, back: "333.85", rate: "10.12%" },
];

const STEPS = ["Score", "Plazo", "Destino", "Factura", "Veredicto"];

export default function App() {
  const [step, setStep] = useState(0);
  const [term, setTerm] = useState(1);
  const [shot, setShot] = useState<{ url: string; bytes: ArrayBuffer; mime: string } | null>(null);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void health();
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  // La cámara se abre al entrar al paso de la factura y se apaga al salir.
  useEffect(() => {
    if (step !== 3 || shot) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setLive(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setLive(true);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      } catch {
        // Sin cámara o sin permiso. Subir el archivo es el mismo papel.
        setLive(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, shot]);

  async function capture() {
    const v = videoRef.current;
    if (!v) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.92));
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setLive(false);
    await useShot(blob);
  }

  async function useShot(blob: Blob) {
    const bytes = await blob.arrayBuffer();
    const mime = blob.type || "image/jpeg";
    setShot({ url: URL.createObjectURL(blob), bytes, mime });
    await run(bytes, mime);
  }

  async function run(bytes: ArrayBuffer, mime: string) {
    setBusy(true);
    setError(null);
    try {
      // La evidencia nombra los bytes exactos que el modelo va a mirar: si el hash
      // no coincide el servicio devuelve 422. Ese binding es el punto, no un detalle.
      const hash = await sha256Hex(bytes);
      const res = await verify({
        agreementId: AGREEMENT,
        milestoneId: MILESTONE,
        condition,
        evidence: [
          {
            type: "invoice_photo",
            uri: `camera://${hash.slice(0, 12)}`,
            sha256: hash,
            mimeType: mime,
            uploader: c.receiver,
            createdAt: new Date().toISOString(),
          },
        ],
        image: { base64: toBase64(bytes), mediaType: mime },
        fx: FX,
      });
      setResult(res);
      setStep(4);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function runCanned(reading: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await verifyCanned({
        agreementId: AGREEMENT,
        milestoneId: MILESTONE,
        condition,
        evidence: evidenceSample,
        reading,
        fx: FX,
      });
      setResult(res);
      setStep(4);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    setShot(null);
    setResult(null);
    setError(null);
    setStep(0);
  }

  const verdict = result?.envelope.verdict;
  const crits = result?.envelope.criteria ?? [];
  const semantic = crits.filter((k) => k.verifier !== "deterministic");
  const matched = semantic.filter((k) => k.result === "PASS").length;
  const allow = verdict?.decision === "ALLOW";

  return (
    <div className="page">
      <div className="top">
        <span className="eyebrow">Live · Lendoor × Witness</span>
        <h1>Ana compra su lavarropas.</h1>
        <p>Crédito con destino: la plata se libera cuando la factura dice lo que tiene que decir.</p>
      </div>

      <nav className="steps">
        {STEPS.map((s, i) => (
          <button
            key={s}
            className={i === step ? "on" : i < step ? "done" : ""}
            onClick={() => i <= step && setStep(i)}
          >
            0{i + 1} {s}
          </button>
        ))}
      </nav>

      <div className={`phone${step === 3 ? " hot" : ""}`}>
        {/* ───── 01 · score ───── */}
        {step === 0 && (
          <div className="screen">
            <div className="bar"><span>12:00</span><span>▮▮▮</span></div>
            <div className="head"><span className="t">Lendoor score</span><span className="x">✕</span></div>
            <div className="body">
              <div className="gauge">
                <svg className="arc" viewBox="0 0 200 100">
                  <path d="M12 96 A88 88 0 0 1 188 96" fill="none" stroke="#eef1f5" strokeWidth="13" strokeLinecap="round" />
                  <path d="M12 96 A88 88 0 0 1 188 96" fill="none" stroke="#f97415" strokeWidth="13" strokeLinecap="round"
                        strokeDasharray="276" strokeDashoffset="181" />
                </svg>
                <span className="n">343</span>
                <span className="of">de 1000</span>
              </div>
              <p className="when">Última actualización: 14/07/2026</p>
              <span className="label">Cuentas conectadas</span>
              <div className="accs">
                {[
                  { n: "Lemon", a: "0x1d35…de61", bg: "#111827" },
                  { n: "Lendoor", a: "0xfb3c…d9d8", bg: "#f97415" },
                  { n: "Wallet", a: "0xAcc1…e185", bg: "#4f46e5" },
                ].map((w) => (
                  <div className="acc" key={w.n}>
                    <span className="ic" style={{ background: w.bg }}>{w.n[0]}</span>
                    <span>
                      <span className="nm">{w.n}</span>
                      <span className="ad">{w.a}</span>
                    </span>
                    <span className="ok">✓</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="foot">
              <button className="cta" onClick={() => setStep(1)}>Pedir crédito</button>
            </div>
          </div>
        )}

        {/* ───── 02 · plazo ───── */}
        {step === 1 && (
          <div className="screen">
            <div className="bar"><span>12:00</span><span>▮▮▮</span></div>
            <div className="head"><span className="t">Elegí tu plazo</span><span className="x">✕</span></div>
            <div className="body">
              <p className="amount">${CAP}.00</p>
              <div className="terms">
                {TERMS.map((t, i) => (
                  <button key={t.days} className={`term${i === term ? " on" : ""}`} onClick={() => setTerm(i)}>
                    <span className="d">{t.days}<small>días</small></span>
                    <span className="r">
                      Devolvés ${t.back}
                      <small>Tu tasa: {t.rate}</small>
                    </span>
                    <span style={{ color: "#9aa5b4" }}>›</span>
                  </button>
                ))}
              </div>
              <p className="fine">
                El interés se calcula sobre el monto y el plazo elegido. Si repagás antes, pagás menos.
              </p>
            </div>
            <div className="foot">
              <button className="cta" onClick={() => setStep(2)}>Continuar</button>
            </div>
          </div>
        )}

        {/* ───── 03 · destino ───── */}
        {step === 2 && (
          <div className="screen">
            <div className="bar"><span>12:00</span><span>▮▮▮</span></div>
            <div className="head"><span className="t">Crédito con destino</span><span className="x">✕</span></div>
            <div className="body">
              <span className="pill orange">◉ Crédito con destino</span>
              <div>
                <span className="label">Aprobado para</span>
                <p style={{ margin: "3px 0 0", fontSize: 17, fontWeight: 700 }}>Un {ITEM}</p>
                <p className="big" style={{ margin: "2px 0 0" }}>${CAP}.00</p>
                <p className="muted">En {STORE} · guardado en el escrow</p>
              </div>
              <span className="label">Se libera cuando la factura muestre</span>
              <div className="unlock">
                <div className="it"><span className="g">🧺</span><span><b>Un {ITEM}</b><span>El producto que pediste</span></span></div>
                <div className="it"><span className="g">↑</span><span><b>Total hasta ${CAP}.00</b><span>El tope del crédito</span></span></div>
                <div className="it"><span className="g">🏪</span><span><b>Comercio: {STORE}</b><span>El que marcaste al pedir</span></span></div>
              </div>
              <p className="note">
                <span>⏱</span>
                <span>Si no se paga a la tienda, no se libera y vuelve al fondo. Nadie aprueba a mano.</span>
              </p>
            </div>
            <div className="foot">
              <button className="cta" onClick={() => setStep(3)}>Escanear factura</button>
            </div>
          </div>
        )}

        {/* ───── 04 · factura ───── */}
        {step === 3 && (
          <div className="screen dark">
            <div className="bar"><span>12:00</span><span>▮▮▮</span></div>
            <div className="head">
              <span className="x" style={{ cursor: "pointer" }} onClick={() => setStep(2)}>✕</span>
              <span className="t">{ITEM} · ${CAP}.00</span>
              <span style={{ width: 14 }} />
            </div>
            <div className="cam">
              {live && <video ref={videoRef} playsInline muted />}
              {shot && !live && <img src={shot.url} alt="factura" />}
              {!live && !shot && (
                <p className="hint">
                  Sin cámara disponible.
                  <br />
                  Tocá el botón para subir la foto de la factura.
                </p>
              )}
              <div className="camtop"><span>La IA lee la factura</span></div>
              <div className="frame"><i /><i /><i /><i /></div>
              {busy ? (
                <div className="tally">leyendo…</div>
              ) : (
                <>
                  <div className="chips">
                    <span className="chip">✓ Comercio</span>
                    <span className="chip">✓ Producto: {ITEM}</span>
                    <span className="chip">✓ Total ≤ ${CAP}</span>
                  </div>
                  <div className="tally">lo que tiene que encontrar</div>
                </>
              )}
              <button
                className="shutter"
                disabled={busy}
                onClick={() => (live ? void capture() : fileRef.current?.click())}
              />
            </div>
            {error && <p className="err" style={{ padding: "10px 16px" }}>{error}</p>}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void useShot(f);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {/* ───── 05 · veredicto ───── */}
        {step === 4 && result && verdict && (
          <div className="screen">
            <div className="bar"><span>12:00</span><span>▮▮▮</span></div>
            <div className="head"><span className="t">Veredicto firmado</span><span className="x">✕</span></div>
            <div className="body">
              <span className={`pill ${allow ? "green" : "orange"}`}>
                {allow ? "✓ Veredicto firmado" : "✕ No se libera"}
              </span>
              <div className="released">
                <span className="label">{allow ? "Crédito liberado" : "Crédito retenido"}</span>
                <p className="big" style={{ margin: 0 }}>${CAP}.00</p>
                <p className="muted">
                  {allow ? `Pagado a ${STORE} · nadie apretó aprobar` : verdict.reasons.join(" · ")}
                </p>
              </div>
              {allow && (
                <button
                  className="cta sec"
                  onClick={() => window.open(`${VERIFIER}/envelopes/${result.id}`, "_blank")}
                >
                  Ver el sobre firmado
                </button>
              )}
              <span className="label">Por qué {allow ? "se liberó" : "no se liberó"}</span>
              <div className="why">
                {crits.map((k: Criterion) => (
                  <div key={k.id} className={`r ${k.result === "PASS" ? "ok" : "no"}`}>
                    <span className="m">{k.result === "PASS" ? "✓" : k.result === "FAIL" ? "✕" : "?"}</span>
                    <span>
                      <b style={{ fontWeight: 600 }}>{k.reason}</b>
                      <span>{k.id}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="sig">
                <span className="label">Firmado por el verificador</span>
                <div className="kv">
                  <b>firmó</b><span className="v">{result.envelope.verifier}</span>
                  <b>sobre</b><span className="v">{result.id}</span>
                  <b>condición</b><span className="v">{result.envelope.conditionHash}</span>
                  <b>paso</b><span className="v">{result.nextStep.action}</span>
                </div>
              </div>
              <p className="muted">
                El modelo sólo leyó campos. Cada comparación la hizo código, y {matched} de{" "}
                {semantic.length} coincidieron.
              </p>
            </div>
            <div className="foot">
              <button className="cta sec" onClick={restart}>Empezar de nuevo</button>
            </div>
          </div>
        )}
      </div>

      <details className="alt">
        <summary>Sin cámara a mano</summary>
        <p className="muted" style={{ margin: "8px 0 0" }}>
          Dos facturas de ejemplo. El servicio corre las mismas reglas y firma el mismo sobre; lo
          único enlatado son los ojos del modelo.
        </p>
        <div className="row">
          <button onClick={() => void runCanned(readingGood)} disabled={busy}>Factura correcta</button>
          <button onClick={() => void runCanned(readingWrong)} disabled={busy}>Factura de otra tienda</button>
        </div>
      </details>
    </div>
  );
}
