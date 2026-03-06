"use strict";

/* ===== CONFIG ===== */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ===== CONFIG SUPABASE =====
const SUPABASE_URL = "https://ydypdeafbcdcamwigjuq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_lg9teAniku65cd2dnZJvIQ_Zii0XneZ";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== "TABELAS" (nomes no Supabase) =====
// Ajuste se suas tabelas tiverem outros nomes!
const DB = {
  AUTH: "Auth",
  TESTS: "tests",
  PATIENTS: "patients",
  TOKENS: "link_tokens",
  RESPONSES: "respostas"
};

let allDonePatientsCache = [];
let allDonePatientsCacheLoaded = false;

// ===== HELPERS DB =====
async function dbSearch(table, filters = {}) {
  let q = supabase.from(table).select("*");
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function dbCreate(table, row) {
  const { data, error } = await supabase.from(table).insert([row]).select();
  if (error) throw error;
  return data?.[0] || null;
}

async function dbPatchBy(table, column, value, patch) {
  const { data, error } = await supabase
    .from(table)
    .update(patch)
    .eq(column, value)
    .select();
  if (error) throw error;
  return data?.[0] || null;
}


const PATIENT_PORTAL_URL = "https://integradaneuropsicologia.github.io/area-do-paciente-v2/";

/* ===== HELPERS DOM ===== */
const $ = (s) => document.querySelector(s);
const el = (t, o = {}) => Object.assign(document.createElement(t), o);

function show(n) {
  n && n.classList.remove("hidden");
}

function hide(n) {
  n && n.classList.add("hidden");
}

function setMsg(box, text, type = "") {
  if (!box) return;
  box.textContent = text || "";
  box.className = "msg" + (type ? " " + type : "");
  if (text) show(box);
  else hide(box);
}

function formatDateTimeBR(v) {
  if (!v) return "sem data";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("pt-BR");
}

function normalizePdfValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(normalizePdfValue).join(", ");
  return JSON.stringify(v);
}

function humanizeKey(k) {
  return String(k || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenJsonToRows(value, prefix = "", out = []) {
  const label = prefix ? prefix : "Resposta";

  if (value === null || value === undefined) {
    out.push([label, ""]);
    return out;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      out.push([label, "[]"]);
      return out;
    }

    // Se array simples, junta numa linha
    const allPrimitive = value.every(
      (x) => x == null || ["string", "number", "boolean"].includes(typeof x)
    );

    if (allPrimitive) {
      out.push([label, value.map(normalizePdfValue).join(", ")]);
      return out;
    }

    // Se array de objetos, explode por índice
    value.forEach((item, i) => {
      flattenJsonToRows(item, `${label} [${i + 1}]`, out);
    });
    return out;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) {
      out.push([label, "{}"]);
      return out;
    }

    for (const [k, v] of entries) {
      const next = prefix ? `${prefix} › ${humanizeKey(k)}` : humanizeKey(k);
      flattenJsonToRows(v, next, out);
    }
    return out;
  }

  out.push([label, normalizePdfValue(value)]);
  return out;
}

function inferResponseCode(row) {
  return String(
    getAnyField(row, [
      "formulario",
      "form_code",
      "codigo_formulario",
      "teste",
      "test_code",
      "code"
    ]) || ""
  ).trim();
}

function inferResponseTitle(row) {
  const explicit = getAnyField(row, [
    "formulario_nome",
    "form_name",
    "titulo",
    "nome_formulario",
    "label"
  ]);
  if (explicit) return String(explicit).trim();

  const code = inferResponseCode(row);
  if (!code) return "Formulário sem nome";

  // tenta usar o catálogo de testes já carregado
  const found = (testsCatalog || []).find((t) => String(t.code).trim() === code);
  if (found?.label) return found.label;

  return code;
}

function inferResponsePayload(row) {
  // jsonb normalmente já vem como objeto; se vier string, safeJsonParse resolve
  const raw =
    getAnyField(row, ["results", "answers", "payload", "json", "response_json"]) ??
    null;

  const parsed = safeJsonParse(raw);
  return parsed ?? raw;
}

function inferResponseMeta(row) {
  // results_meta normalmente já vem como objeto; se vier string, safeJsonParse resolve
  const raw =
    getAnyField(row, [
      "results_meta",
      "result_meta",
      "meta",
      "meta_json",
      "resultsMeta"
    ]) ?? null;

  const parsed = safeJsonParse(raw);
  return parsed ?? raw;
}


function inferResponseDate(row) {
  return (
    getAnyField(row, [
      "created_at",
      "updated_at",
      "data_envio",
      "submitted_at",
      "timestamp"
    ]) || null
  );
}

function normalizeResponseRow(row, idx = 0) {
  const payload = inferResponsePayload(row);
  const meta = inferResponseMeta(row);
  const code = inferResponseCode(row);
  const title = inferResponseTitle(row);
  const submittedAt = inferResponseDate(row);

  const rawId =
    getAnyField(row, ["id", "uuid", "response_id"]) ||
    `${code || "sem-codigo"}-${submittedAt || "sem-data"}-${idx}`;

  return {
    uid: String(rawId),
    code,
    title,
    submittedAt,
    payload,
    meta,
    raw: row
  };
}

async function fetchResponsesByCPF(cpfDigits) {
  const d = onlyDigits(cpfDigits).padStart(11, "0");
  if (!d) return [];

  // tenta colunas comuns (ajuste se no seu banco o nome for outro)
  const cpfColumns = ["cpf", "CPF", "paciente_cpf", "cpf_paciente"];
  let lastError = null;

  for (const col of cpfColumns) {
    try {
      const { data, error } = await supabase
        .from(DB.RESPONSES)
        .select("*")
        .or(`${col}.eq.${d},${col}.ilike.${cpfPattern(d)}`);

      if (error) throw error;

      return (data || []).filter(Boolean);
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("Não consegui consultar a tabela de respostas.");
}

function renderFilledFormsMenu() {
  const wrap = $("#anamnesePicker");
  const list = $("#anamneseList");
  const count = $("#anamneseCount");

  if (!wrap || !list || !count) return;

  show(wrap);
  list.innerHTML = "";

  count.textContent = String(filledFormsCache.length);
  count.className = "tag " + (filledFormsCache.length ? "ok" : "new");

  if (!filledFormsCache.length) {
    const empty = el("div", { className: "anamnese-empty" });
    empty.textContent = "Nenhum formulário preenchido encontrado para este CPF.";
    list.appendChild(empty);
    return;
  }

  for (const item of filledFormsCache) {
    const row = el("div", { className: "anamnese-item" });

    // Coluna de opções de exportação
    const opts = el("div", { className: "anamnese-item-checks" });

    // 1) Perguntas/Respostas (results)
    const optQA = el("label", { className: "anamnese-opt" });
    const cbQA = el("input", { type: "checkbox" });
    cbQA.checked = true;
    cbQA.dataset.uid = item.uid;
    cbQA.dataset.part = "qa";
    optQA.appendChild(cbQA);
    optQA.appendChild(el("span", { textContent: "Perguntas/Respostas" }));

    // 2) Resultados (results_meta)
    const optMeta = el("label", { className: "anamnese-opt" });
    const cbMeta = el("input", { type: "checkbox" });
    cbMeta.dataset.uid = item.uid;
    cbMeta.dataset.part = "meta";

    const hasMeta =
      item.meta !== undefined &&
      item.meta !== null &&
      (typeof item.meta === "string" ? item.meta.trim() !== "" : true);
    cbMeta.checked = !!hasMeta;
    if (!hasMeta) {
      cbMeta.checked = false;
      cbMeta.disabled = true;
    }

    optMeta.appendChild(cbMeta);
    optMeta.appendChild(el("span", { textContent: hasMeta ? "Resultados" : "Resultados (sem dados)" }));

    opts.appendChild(optQA);
    opts.appendChild(optMeta);

    // Corpo
    const body = el("div", { className: "anamnese-item-body" });

    const title = el("div", { className: "anamnese-item-title" });
    title.textContent = item.title + (item.code ? ` (${item.code})` : "");

    const meta = el("div", { className: "anamnese-item-meta" });
    meta.textContent = `Preenchido em: ${formatDateTimeBR(item.submittedAt)}`;

    body.appendChild(title);
    body.appendChild(meta);

    row.appendChild(opts);
    row.appendChild(body);

    list.appendChild(row);
  }
}

function toggleAnamneseSelection(checked) {
  document
    .querySelectorAll('#anamneseList input[type="checkbox"][data-uid][data-part]')
    .forEach((cb) => {
      if (cb.disabled) return;
      cb.checked = !!checked;
    });
}

function getSelectedFilledForms() {
  const opts = new Map();

  // captura escolhas (qa / meta) por uid
  document
    .querySelectorAll('#anamneseList input[type="checkbox"][data-uid][data-part]')
    .forEach((cb) => {
      const uid = cb.dataset.uid;
      const part = cb.dataset.part; // "qa" | "meta"
      if (!opts.has(uid)) opts.set(uid, { includeQA: false, includeMeta: false });

      const cur = opts.get(uid);
      if (part === "qa") cur.includeQA = !!cb.checked;
      if (part === "meta") cur.includeMeta = !!cb.checked;
    });

  // seleciona formulários onde pelo menos 1 opção esteja marcada
  return filledFormsCache
    .map((x) => {
      const o = opts.get(x.uid) || { includeQA: false, includeMeta: false };
      return { ...x, includeQA: !!o.includeQA, includeMeta: !!o.includeMeta };
    })
    .filter((x) => x.includeQA || x.includeMeta);
}

async function loadFilledFormsForCurrentCPF() {
  const msgBox = $("#pacMsg");
  const wrap = $("#anamnesePicker");

  const cpf = onlyDigits($("#pacCPF")?.value || currentPatient?.cpf || "");
  if (!cpf) {
    if (wrap) hide(wrap);
    filledFormsCache = [];
    return;
  }

  try {
    setMsg(msgBox, "Buscando formulários preenchidos…");

    const rows = await fetchResponsesByCPF(cpf);

    filledFormsCache = rows
      .map((r, i) => normalizeResponseRow(r, i))
      .filter((x) => (x.payload !== undefined && x.payload !== null) || (x.meta !== undefined && x.meta !== null));

    // ordena mais recentes primeiro
    filledFormsCache.sort((a, b) => {
      const da = new Date(a.submittedAt || 0).getTime() || 0;
      const db = new Date(b.submittedAt || 0).getTime() || 0;
      return db - da;
    });

    renderFilledFormsMenu();

    if (!filledFormsCache.length) {
      setMsg(msgBox, "CPF encontrado, mas sem formulários preenchidos na tabela respostas.", "warn");
    } else {
      setMsg(msgBox, `${filledFormsCache.length} formulário(s) preenchido(s) encontrado(s).`, "ok");
    }
  } catch (e) {
    console.error("Erro ao buscar respostas:", e);
    filledFormsCache = [];
    renderFilledFormsMenu();
    setMsg(
      msgBox,
      "Erro ao buscar formulários na tabela respostas: " + (e?.message || e),
      "err"
    );
  }
}

async function generateSelectedFormsPdf(selectedItems) {
  const JsPDF = window.jspdf?.jsPDF;
  if (!JsPDF) {
    throw new Error(
      "Biblioteca de PDF não carregou. Verifique os scripts do jsPDF no index.html."
    );
  }

  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const cpfDigits = onlyDigits($("#pacCPF")?.value || currentPatient?.cpf || "");
  const patientName =
    (currentPatient?.nome || $("#pacNome")?.value || "Paciente").trim() ||
    "Paciente";
  const patientCPF = cpfDigits ? maskCPF(cpfDigits) : "";
  const exportedAt = new Date();

  const M = { left: 40, right: 40, top: 34, bottom: 36 };
  const contentWidth = pageWidth - M.left - M.right;

  function drawPageHeader({ formTitle, formDate, index, total }) {
    let y = M.top;

    // Título principal
    doc.setFont("verdana", "bold");
    doc.setFontSize(15);
    doc.text("Questionários e Formulários", M.left, y);

    y += 18;

    // Infos do paciente
    doc.setFont("verdana", "normal");
    doc.setFontSize(9.5);

    const line1 = `Paciente: ${patientName}${
      patientCPF ? `  |  CPF: ${patientCPF}` : ""
    }`;
    const line2 = `Exportado em: ${exportedAt.toLocaleString(
      "pt-BR"
    )}  |  Formulário ${index + 1} de ${total}`;

    doc.text(line1, M.left, y);
    y += 14;
    doc.text(line2, M.left, y);
    y += 18;

    // Linha divisória
    doc.setDrawColor(180);
    doc.line(M.left, y, pageWidth - M.right, y);

    y += 14;

    // Título do formulário (com quebra de linha automática)
    doc.setFont("verdana", "bold");
    doc.setFontSize(12);
    const titleLines = doc.splitTextToSize(
      formTitle || "Formulário",
      contentWidth
    );
    doc.text(titleLines, M.left, y);
    y += titleLines.length * 14;

    // Data do formulário
    doc.setFont("verdana", "normal");
    doc.setFontSize(9.5);
    doc.text(`Preenchido em: ${formatDateTimeBR(formDate)}`, M.left, y);
    y += 12;

    // Linha divisória leve
    doc.setDrawColor(220);
    doc.line(M.left, y, pageWidth - M.right, y);

    return y + 12;
  }

  function ensureSpace(y, needed, headerArgs) {
    if (y + needed <= pageHeight - M.bottom) return y;
    doc.addPage();
    return drawPageHeader(headerArgs);
  }

  function buildQARows(payload) {
    const isPerguntaRespostaArray =
      Array.isArray(payload) &&
      payload.every(
        (x) =>
          x &&
          typeof x === "object" &&
          !Array.isArray(x) &&
          "pergunta" in x &&
          "resposta" in x
      );

    if (isPerguntaRespostaArray) {
      return payload.map((x, i) => [
        String(x.pergunta || `Pergunta ${i + 1}`),
        String(normalizePdfValue(x.resposta))
      ]);
    }

    return flattenJsonToRows(payload).map(([campo, resposta]) => [
      String(campo || ""),
      String(resposta ?? "")
    ]);
  }

  function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function buildMetaRows(meta) {
  if (meta === null || meta === undefined || meta === "") {
    return [["(sem resultados)", ""]];
  }

  // =========================
  // 1) NOVO FORMATO: results_meta como ARRAY
  // =========================
  if (Array.isArray(meta)) {
    if (!meta.length) return [["(sem resultados)", ""]];

    const allPrimitive = meta.every(
      (x) => x == null || ["string", "number", "boolean"].includes(typeof x)
    );
    if (allPrimitive) {
      return [["Resultados", meta.map(normalizePdfValue).join(", ")]];
    }

    // meta-array típico: [{key,label,sum,percent,interpretacao...}, ...]
    const looksLikeMetaArray = meta.every(
      (x) =>
        isPlainObject(x) &&
        (("key" in x) || ("label" in x)) &&
        (("sum" in x) || ("value" in x))
    );

    if (looksLikeMetaArray) {
      const rows = [];

      meta.forEach((it) => {
        const key = String(it.key || "").trim();
        const label = String(it.label || humanizeKey(key) || "Indicador").trim();

        const val = ("sum" in it) ? it.sum : it.value;
        let valueTxt = normalizePdfValue(val);

        // se tiver percent, anexa (opcional, mas fica bem)
        if (it.percent !== null && it.percent !== undefined && it.percent !== "") {
          valueTxt += ` (${normalizePdfValue(it.percent)}%)`;
        }

        rows.push([label, valueTxt]);

        // se tiver interpretação, coloca logo abaixo
        if (it.interpretacao) {
          rows.push([`${label} › Interpretação`, normalizePdfValue(it.interpretacao)]);
        }
      });

      return rows.length ? rows : [["(sem resultados)", ""]];
    }

    // array “qualquer” -> fallback genérico
    return flattenJsonToRows(meta).map(([campo, resposta]) => [
      String(campo || ""),
      String(resposta ?? "")
    ]);
  }

  // =========================
  // 2) FORMATO ANTIGO: results_meta como OBJETO (JSON)
  // =========================
  if (isPlainObject(meta)) {
    const entries = Object.entries(meta);

    // caso “flat”: chave -> número/string/bool e possivelmente *_interpretacao
    const isFlat = entries.every(
      ([_, v]) => v == null || ["string", "number", "boolean"].includes(typeof v)
    );

    if (isFlat) {
      const rows = [];
      const keys = Object.keys(meta);

      const baseKeys = keys
        .filter((k) => !String(k).endsWith("_interpretacao"))
        .sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));

      const used = new Set();

      for (const k of baseKeys) {
        rows.push([humanizeKey(k), normalizePdfValue(meta[k])]);
        used.add(k);

        const ik = `${k}_interpretacao`;
        if (ik in meta && meta[ik] !== null && meta[ik] !== undefined && String(meta[ik]).trim() !== "") {
          rows.push([`${humanizeKey(k)} › Interpretação`, normalizePdfValue(meta[ik])]);
          used.add(ik);
        }
      }

      // sobras (qualquer outra chave fora do padrão)
      const leftovers = keys
        .filter((k) => !used.has(k))
        .sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));

      for (const k of leftovers) {
        rows.push([humanizeKey(k), normalizePdfValue(meta[k])]);
      }

      return rows.length ? rows : [["(sem resultados)", ""]];
    }

    // objeto complexo -> fallback genérico
    return flattenJsonToRows(meta).map(([campo, resposta]) => [
      String(campo || ""),
      String(resposta ?? "")
    ]);
  }

  // =========================
  // 3) PRIMITIVO
  // =========================
  return [["Resultado", String(normalizePdfValue(meta))]];
}

  selectedItems.forEach((item, idx) => {
    if (idx > 0) doc.addPage();

    const headerArgs = {
      formTitle: item.title,
      formDate: item.submittedAt,
      index: idx,
      total: selectedItems.length
    };

    let y = drawPageHeader(headerArgs);

    const includeQA = item.includeQA !== false; // default true
    const includeMeta = !!item.includeMeta;

    // =======================
    // Perguntas / Respostas
    // =======================
    if (includeQA) {
      const rows = buildQARows(item.payload ?? null);

      // Se não tiver payload, registra no PDF
      if (!rows || !rows.length) {
        y = ensureSpace(y, 22, headerArgs);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.text("Perguntas/Respostas: sem dados.", M.left, y);
        y += 14;
      } else if (typeof doc.autoTable === "function") {
        doc.autoTable({
          startY: y,
          margin: { left: M.left, right: M.right, bottom: M.bottom },
          head: [["Pergunta", "Resposta"]],
          body: rows,
          theme: "grid",
          styles: {
            font: "helvetica",
            fontSize: 9,
            cellPadding: 4,
            overflow: "linebreak",
            valign: "top",
            textColor: 40,
            lineColor: 225,
            lineWidth: 0.5
          },
          headStyles: {
            fillColor: [41, 128, 185],
            textColor: 255,
            fontStyle: "bold",
            fontSize: 9.5
          },
          alternateRowStyles: { fillColor: [248, 250, 252] },
          columnStyles: {
            0: { cellWidth: contentWidth * 0.78, fontStyle: "bold" },
            1: { cellWidth: contentWidth * 0.22 }
          },
          didDrawPage: () => {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            doc.setTextColor(120);
            doc.text(
              `Página ${doc.internal.getNumberOfPages()}`,
              pageWidth - M.right - 40,
              pageHeight - 14
            );
          }
        });

        y = (doc.lastAutoTable?.finalY || y) + 16;
      } else {
        // Fallback sem autoTable
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);

        for (const [campo, resposta] of rows) {
          const txt = `${campo}: ${resposta}`;
          const lines = doc.splitTextToSize(txt, contentWidth);

          y = ensureSpace(y, lines.length * 12 + 8, headerArgs);
          doc.text(lines, M.left, y);
          y += lines.length * 12 + 6;
        }

        y += 8;
      }
    }

    // =======================
    // Resultados (results_meta)
    // =======================
    if (includeMeta) {
      const metaPayload = item.meta ?? null;
      const rowsMeta = buildMetaRows(metaPayload);

      y = ensureSpace(y, 26, headerArgs);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(40);
      doc.text("Resultados (indicadores)", M.left, y);
      y += 10;

      if (typeof doc.autoTable === "function") {
        doc.autoTable({
          startY: y,
          margin: { left: M.left, right: M.right, bottom: M.bottom },
          head: [["Indicador", "Valor"]],
          body: rowsMeta,
          theme: "grid",
          styles: {
            font: "helvetica",
            fontSize: 9,
            cellPadding: 4,
            overflow: "linebreak",
            valign: "top",
            textColor: 40,
            lineColor: 225,
            lineWidth: 0.5
          },
          headStyles: {
            fillColor: [99, 102, 241],
            textColor: 255,
            fontStyle: "bold",
            fontSize: 9.5
          },
          alternateRowStyles: { fillColor: [248, 250, 252] },
          columnStyles: {
            0: { cellWidth: contentWidth * 0.62, fontStyle: "bold" },
            1: { cellWidth: contentWidth * 0.38 }
          }
        });

        y = (doc.lastAutoTable?.finalY || y) + 10;
      } else {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        for (const [k, v] of rowsMeta) {
          const txt = `${k}: ${v}`;
          const lines = doc.splitTextToSize(txt, contentWidth);

          y = ensureSpace(y, lines.length * 12 + 8, headerArgs);
          doc.text(lines, M.left, y);
          y += lines.length * 12 + 6;
        }
      }
    }

    // Se o usuário desmarcar tudo e mesmo assim passar no filtro (não deveria),
    // deixa uma nota
    if (!includeQA && !includeMeta) {
      y = ensureSpace(y, 18, headerArgs);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text("Nada selecionado para este formulário.", M.left, y);
    }
  });

  const ts = exportedAt.toISOString().replace(/\D/g, "").slice(0, 14);
  const filename = `Formulários_${patientName}_${onlyDigits(cpfDigits) || "sem_cpf"}.pdf`;
  doc.save(filename);
}

/* ===== TEMA (DARK/LIGHT) ===== */
(function initThemeToggle() {
  const body = document.body;
  const toggle = $("#themeToggle");

  function applyTheme(theme) {
    body.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("integrada-theme", theme);
    } catch (e) {}
    if (toggle) {
      toggle.textContent =
        theme === "light" ? "🌙" : "☀️";
    }
  }

  let saved = null;
  try {
    saved = localStorage.getItem("integrada-theme");
  } catch (e) {}

  if (saved === "light" || saved === "dark") {
    applyTheme(saved);
  } else {
    applyTheme("dark");
  }

  if (toggle) {
    toggle.addEventListener("click", () => {
      const current = body.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(current);
    });
  }
})();

/* ===== HELPERS VALIDAÇÃO ===== */
function onlyDigits(s) {
  return (s || "").replace(/\D+/g, "");
}

function cpfDbValue(cpfInput) {
  const d = onlyDigits(cpfInput).padStart(11, "0");
  return d || null;
}



function validaCPF(cpf) {
  cpf = onlyDigits(cpf);
  if (!cpf || cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;

  let soma = 0;
  for (let i = 1; i <= 9; i++) soma += parseInt(cpf.substring(i - 1, i)) * (11 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf.substring(9, 10))) return false;

  soma = 0;
  for (let i = 1; i <= 10; i++) soma += parseInt(cpf.substring(i - 1, i)) * (12 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  return resto === parseInt(cpf.substring(10, 11));
}
function maskCPF(cpfDigits) {
  const d = onlyDigits(cpfDigits).padStart(11, "0");
  return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9,11)}`;
}

function cpfPattern(cpfDigits) {
  // funciona se o banco estiver com "000.000.000-00" ou "000 000 000 00"
  const d = onlyDigits(cpfDigits).padStart(11, "0");
  return `${d.slice(0,3)}%${d.slice(3,6)}%${d.slice(6,9)}%${d.slice(9,11)}`;
}

async function findPatientByCPF(cpfDigits) {
  const d = onlyDigits(cpfDigits).padStart(11, "0");
  const tries = [d, maskCPF(d)];

  // 1) tenta match exato (mais confiável)
  for (const v of tries) {
    const { data, error } = await supabase
      .from(DB.PATIENTS)
      .select("*")
      .eq("cpf", v)
      .limit(1);

    if (error) throw error;
    if (data && data.length) return data[0];
  }

  // 2) tenta "parecido" (pega casos com espaços/pontuação diferente)
  // OBS: se cpf for numérico, ilike pode falhar; aí ele só ignora e retorna null.
  try {
    const { data, error } = await supabase
      .from(DB.PATIENTS)
      .select("*")
      .ilike("cpf", cpfPattern(d))
      .limit(1);

    if (error) throw error;
    if (data && data.length) return data[0];
  } catch (_) {}

  return null;
}

async function probePatientsVisibility() {
  // Serve pra diagnosticar RLS: se isso vier vazio, você não enxerga NENHUM paciente pelo front.
  const { data, error } = await supabase
    .from(DB.PATIENTS)
    .select("cpf")
    .limit(1);

  if (error) return { ok: false, error };
  return { ok: true, hasAnyVisibleRow: (data?.length || 0) > 0 };
}


function toISODateFromInput(s) {
  return s || "";
}

function nowDateTimeLocal() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" : "") + n;
  return (
    d.getFullYear() +
    "-" +
    p(d.getMonth() + 1) +
    "-" +
    p(d.getDate()) +
    " " +
    p(d.getHours()) +
    ":" +
    p(d.getMinutes()) +
    ":" +
    p(d.getSeconds())
  );
}

function isValidEmail(s) {
  return !!(s && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim()));
}

function normalizeWhats(input) {
  if (!input) return "";
  let d = onlyDigits(input);
  if (!d) return "";
  if (d.startsWith("55") && d.length >= 12 && d.length <= 13) return "+" + d;
  if (d.length === 10 || d.length === 11) return "+55" + d;
  if (d.length >= 12 && d.length <= 13) return "+" + d;
  return "";
}

function formatWhatsInput(inputEl) {
  if (!inputEl) return;
  let d = onlyDigits(inputEl.value).slice(0, 13);
  if (d.startsWith("55")) d = d.slice(2);
  if (d.length <= 2) {
    inputEl.value = d;
    return;
  }
  const ddd = d.slice(0, 2);
  let rest = d.slice(2);
  if (rest.length >= 9) {
    inputEl.value = `(${ddd}) ${rest[0]} ${rest.slice(1, 5)}-${rest.slice(5, 9)}`;
  } else if (rest.length >= 5) {
    inputEl.value = `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4, 8)}`;
  } else {
    inputEl.value = `(${ddd}) ${rest}`;
  }
}


/* ===== TOKENS / LINK PACIENTE ===== */
function randomToken(len = 22) {
  const a =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++) {
    s += a[Math.floor(Math.random() * a.length)];
  }
  return s;
}

function toISODate(d = new Date()) {
  return d.toISOString();
}

function plusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function getActiveTokenForCPF(cpf) {
  try {
    const rows = await sheetSearch(SHEETS.TOKENS, { cpf });
    const now = new Date();
    const valid = (rows || []).filter((r) => {
      const notDisabled =
        String(r.disabled || "não").toLowerCase() !== "sim";
      const okDate = !r.expires_at || new Date(r.expires_at) > now;
      return notDisabled && okDate;
    });
    return valid[0] || null;
  } catch (e) {
    return null;
  }
}

async function getOrCreatePatientLink(cpf) {
  const clean = onlyDigits(cpf);

  if (!clean) throw new Error("Digite um CPF.");
  if (!validaCPF(clean)) throw new Error("CPF inválido.");
  return `${PATIENT_PORTAL_URL}?${encodeURIComponent(clean)}`;
}


/* ===== LOGIN ===== */
async function tryAuthVariants(user, pass) {
  const combos = [
    { u: "login", p: "senha" },
    { u: "usuario", p: "senha" },
    { u: "email", p: "senha" },
    { u: "Login", p: "Senha" }
  ];
  for (const c of combos) {
    try {
      const rows = await sheetSearch(SHEETS.AUTH, {
        [c.u]: user,
        [c.p]: pass
      });
      if (rows && rows.length) return true;
    } catch (e) {
      // ignora e tenta próximo
    }
  }
  return false;
}

/* ===== ESTADO GLOBAL ===== */
let testsCatalog = [];
let currentPatient = null;
let mode = "create";
let statusFilter = "todos";
let testsLoadError = null;
let filledFormsCache = [];

let testsUiRestore = null;

function escapeAttrValue(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\"');
}

function captureTestsUiRestore(anchorCode = "", anchorGroupKey = "") {
  const grid = $("#testsGrid");
  const open = new Set();

  if (grid) {
    grid.querySelectorAll('details.test-group[open]').forEach((d) => {
      const k = d.dataset.groupKey;
      if (k) open.add(k);
    });
  }

  if (anchorGroupKey) open.add(String(anchorGroupKey).trim());

  return {
    openGroups: Array.from(open),
    anchorCode: String(anchorCode || "").trim(),
    anchorGroupKey: String(anchorGroupKey || "").trim(),
    scrollY: window.scrollY || 0
  };
}


// Seleções temporárias de testes (quando o paciente ainda não existe no banco)
let pendingLiberados = new Set();
/* ===== SOURCE NORMALIZATION ===== */
function normalizeSourceLabel(raw) {
  const s = (raw || "").trim();
  return s || "Outros";
}

function normalizeSourceKey(raw) {
  let s = (raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (!s) return "outros";
  if (s.startsWith("paciente")) return "paciente";
  if (s.includes("famil")) return "familiares";
  if (s.includes("pais") || s.includes("cuidad")) return "pais";
  if (s.includes("profis")) return "profissional";
  if (s.includes("prof")) return "professores";
  return "outros";
}

/* ===== AGE / ACTIVE HELPERS ===== */
function isActiveValue(v) {
  // aceita: true, "sim", "ativo", 1, "1", "yes"
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "sim" || s === "ativo" || s === "true" || s === "1" || s === "yes";
}

function parseNumOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function getBirthdateISOFromPatientOrInput() {
  // prioridade: paciente carregado; senão, o que está digitado no input
  const p = currentPatient?.data_nascimento;
  const inp = $("#pacNasc")?.value;
  const raw = (p || inp || "").trim();
  if (!raw) return "";
  return raw.slice(0, 10); // yyyy-mm-dd
}

function calcAgeYears(yyyy_mm_dd) {
  if (!yyyy_mm_dd) return null;
  const [y, m, d] = yyyy_mm_dd.split("-").map((x) => Number(x));
  if (!y || !m || !d) return null;

  const today = new Date();
  let age = today.getFullYear() - y;

  const thisYearBirthday = new Date(today.getFullYear(), m - 1, d);
  if (today < thisYearBirthday) age--;

  return age >= 0 ? age : null;
}

function withinAgeRange(test, ageYears) {
  // se não dá pra calcular idade, não filtra (para não travar o fluxo)
  if (ageYears === null) return true;

  const min = parseNumOrNull(test.ageMin);
  const max = parseNumOrNull(test.ageMax);

  if (min !== null && ageYears < min) return false;
  if (max !== null && ageYears > max) return false;
  return true;
}

function patientAlreadyHasTest(code) {
  const c = String(code || "").trim();
  if (!c) return false;

  // Modo update: vem do banco (JSONB)
  if (currentPatient) return patientHasLiberado(c) || patientHasFeito(c);

  // Modo create: considera as seleções locais (antes de salvar)
  return mode === "create" && pendingLiberados.has(c);
}


function patientIsHiddenFromDoneList(p) {
  const v = getAnyField(p, ["ocultar_concluido"]);
  if (v === true) return true;
  if (v === false || v == null) return false;

  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "sim" || s === "yes";
}

async function setPatientDoneListCheck(cpfDigits, checked) {
  const found = await findPatientByCPF(cpfDigits);
  if (!found?.cpf) {
    throw new Error("Não consegui localizar o paciente para atualizar o campo ocultar_concluido.");
  }

  const patched = await dbPatchBy(DB.PATIENTS, "cpf", found.cpf, { ocultar_concluido: !!checked });
  return patched;
}


/* ===== JSONB (tests_liberados / tests_feitos) ===== */
function safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function jsonbToCodeSet(v) {
  const raw = safeJsonParse(v);
  const set = new Set();

  // aceita array: ["BDEFS", "SRS2"]
  if (Array.isArray(raw)) {
    for (const it of raw) {
      const code = String(it || "").trim();
      if (code) set.add(code);
    }
    return set;
  }

  // aceita objeto: {"BDEFS": true, "SRS2": true} ou {"BDEFS": {..}}
  if (raw && typeof raw === "object") {
    for (const [k, val] of Object.entries(raw)) {
      const code = String(k || "").trim();
      if (!code) continue;
      // se for boolean false, ignora; se for qualquer coisa truthy, conta
      if (val === false || val === 0 || val === "0") continue;
      set.add(code);
    }
    return set;
  }

  return set;
}

function patientLiberadosSet(p = currentPatient) {
  return jsonbToCodeSet(p?.tests_liberados);
}

function patientFeitosSet(p = currentPatient) {
  return jsonbToCodeSet(p?.tests_feitos);
}

function patientHasLiberado(code) {
  return patientLiberadosSet().has(String(code || "").trim());
}

function patientHasFeito(code) {
  return patientFeitosSet().has(String(code || "").trim());
}

function setToSortedArray(set) {
  return Array.from(set || [])
    .map(String)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function getAnyField(row, candidates = []) {
  if (!row) return undefined;

  // 1) tenta direto (nome exato)
  for (const k of candidates) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") {
      return row[k];
    }
  }

  // 2) tenta case-insensitive (Active vs active, etc.)
  const map = {};
  for (const key of Object.keys(row)) map[key.toLowerCase()] = key;

  for (const k of candidates) {
    const real = map[String(k).toLowerCase()];
    if (real && row[real] !== undefined && row[real] !== null && String(row[real]).trim() !== "") {
      return row[real];
    }
  }

  return undefined;
}

function asTrimmedString(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function patientFilledAllLiberados(p) {
  const liberados = patientLiberadosSet(p);
  if (!liberados.size) return false; // ignora quem não tem nada liberado

  const feitos = patientFeitosSet(p);
  for (const code of liberados) {
    if (!feitos.has(code)) return false;
  }
  return true;
}

async function refreshAllDonePatientsCache() {
  try {
    // sem filtro = pega todos os pacientes visíveis pela policy
    const rows = await dbSearch(DB.PATIENTS);

    allDonePatientsCache = (rows || [])
  .filter((p) => p && p.cpf)
  .filter((p) => patientFilledAllLiberados(p))
  .filter((p) => !patientIsHiddenFromDoneList(p)) // <-- NOVO: oculta marcados
  .map((p) => {
    const liberados = patientLiberadosSet(p);
    const feitos = patientFeitosSet(p);
    const cpfDigits = onlyDigits(p.cpf || "");

    return {
      nome: String(p.nome || "Sem nome").trim(),
      cpf: cpfDigits,
      liberadosCount: liberados.size,
      feitosCount: feitos.size
    };
  })
  .sort((a, b) =>
    a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" })
  );

    allDonePatientsCacheLoaded = true;
  } catch (e) {
    console.error("Erro ao montar lista de pacientes com tudo preenchido:", e);
    allDonePatientsCache = [];
    allDonePatientsCacheLoaded = false;
  }
}

function renderAllDonePatientsDropdown() {
  const grid = $("#testsGrid");
  if (!grid) return;

  // remove bloco anterior (pra não duplicar)
  document.getElementById("allDonePatientsWrap")?.remove();

  const wrap = el("details", { className: "test-group", id: "allDonePatientsWrap" });
  wrap.open = false;

  const head = el("summary", { className: "group-head" });
  const title = el("div", { className: "group-title" });
  const dot = el("span", { className: "group-dot" });
  const name = el("span", {
    textContent: "Pacientes com todos os formulários preenchidos"
  });

  title.appendChild(dot);
  title.appendChild(name);

  const counter = el("span", {
    className: "tag ok",
    textContent: String(allDonePatientsCache.length)
  });

  head.appendChild(title);
  head.appendChild(counter);

  const body = el("div", {
    style: "padding: 10px; display:flex; flex-direction:column; gap:8px;"
  });

  const hint = el("div", {
    style: "font-size:12px; opacity:.85;",
    textContent: allDonePatientsCacheLoaded
      ? "Clique em Carregar para abrir o cadastro. Marque Ocultar para remover da lista."
      : "Carregando lista..."
  });
  body.appendChild(hint);

  if (!allDonePatientsCache.length) {
    const empty = el("div", {
      style: "font-size:13px; opacity:.9; padding:6px 0;",
      textContent: allDonePatientsCacheLoaded
        ? "Nenhum paciente concluído disponível na lista."
        : "Carregando..."
    });
    body.appendChild(empty);
  } else {
    for (const p of allDonePatientsCache) {
      const row = el("div", {
        style: `
          display:grid;
          grid-template-columns:auto 1fr auto;
          gap:8px;
          align-items:center;
          border:1px solid var(--line);
          border-radius:10px;
          padding:8px;
          background: rgba(148,163,184,.03);
        `
      });

      // Botão carregar
      const btnLoad = el("button", {
        type: "button",
        textContent: "Carregar",
        className: "btn small"
      });

      btnLoad.addEventListener("click", async () => {
        $("#pacCPF").value = maskCPF(p.cpf);
        await carregarPorCPF();
      });

      // Info
      const cpfLabel = p.cpf && p.cpf.length === 11 ? maskCPF(p.cpf) : (p.cpf || "sem CPF");
      const info = el("div");
      const line1 = el("div", {
        style: "font-weight:700; font-size:13px;",
        textContent: p.nome
      });
      const line2 = el("div", {
        style: "font-size:12px; opacity:.85;",
        textContent: `${cpfLabel} • ${p.liberadosCount} liberado(s)`
      });
      info.appendChild(line1);
      info.appendChild(line2);

      // Checkbox ocultar
      const hideLabel = el("label", {
        style: "display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;"
      });
      const hideCb = el("input", { type: "checkbox" });
      const hideTxt = el("span", { textContent: "Ocultar" });

      hideCb.addEventListener("change", async () => {
        try {
          hideCb.disabled = true;

          await setPatientDoneListCheck(p.cpf, hideCb.checked);

          // some da lista imediatamente
          await refreshAllDonePatientsCache();
          renderAllDonePatientsDropdown();

          setMsg($("#pacMsg"), hideCb.checked
            ? "Paciente ocultado da lista de concluídos."
            : "Paciente voltou para a lista de concluídos.", "ok");
        } catch (e) {
          console.error(e);
          hideCb.checked = !hideCb.checked;
          setMsg($("#pacMsg"), "Erro ao atualizar o campo check: " + (e?.message || e), "err");
        } finally {
          hideCb.disabled = false;
        }
      });

      hideLabel.appendChild(hideCb);
      hideLabel.appendChild(hideTxt);

      row.appendChild(btnLoad);
      row.appendChild(info);
      row.appendChild(hideLabel);

      body.appendChild(row);
    }
  }

  wrap.appendChild(head);
  wrap.appendChild(body);

  // entra depois dos grupos
  grid.appendChild(wrap);
}
  
/* ===== TESTES ===== */
async function loadTests() {
  const info = $("#testsInfo");
  testsLoadError = null;

  if (info) {
    info.className = "tag new";
    info.textContent = "carregando catálogo…";
  }

  try {
    const { data, error } = await supabase.from(DB.TESTS).select("*");
    if (error) throw error;

    testsCatalog = (data || [])
      .map((r) => {
        const code = (r.code || "").trim();
        const label = (r.label || "").trim();
        const order = Number(r.order ?? 9999);

        const srcLabel = normalizeSourceLabel(r.source);
        const srcKey = normalizeSourceKey(r.source);

        // active é boolean no seu banco (TRUE/FALSE)
        const active = isActiveValue(r.active);

        const ageMin = r.age_min ?? null;
        const ageMax = r.age_max ?? null;

        return { code, label, order, srcLabel, srcKey, active, ageMin, ageMax };
      })
      .filter((r) => r.code && r.label)
      .sort((a, b) => a.order - b.order);

  } catch (e) {
    console.error("Falha ao carregar tests:", e);
    testsCatalog = [];
    testsLoadError = e;

    if (info) {
      info.className = "tag new";
      info.textContent = "ERRO ao carregar tests: " + (e?.message || e);
    }
  }

  await refreshAllDonePatientsCache();
renderTests();
  
}

function testStatus(t) {
  const code = String(t?.code || "").trim();
  if (!code) return "cadastrar";

  // Modo update: baseado em JSONB
  const liberado = !!(currentPatient && patientHasLiberado(code));
  const feito = !!(currentPatient && patientHasFeito(code));

  if (feito) return "preenchido";
  if (liberado) return "ja";

  // Modo create: seleção local
  if (!currentPatient && mode === "create" && pendingLiberados.has(code)) return "ja";

  return "cadastrar";
}



function isPendingTest(code) {
  const c = String(code || "").trim();
  return !currentPatient && mode === "create" && pendingLiberados.has(c);
}

async function patchPatientTests(nextLiberadosSet, nextFeitosSet) {
  const msgBox = $("#pacMsg");

  const cpfDigits = onlyDigits($("#pacCPF")?.value || currentPatient?.cpf || "");
  if (!cpfDigits) throw new Error("CPF não informado.");

  // usa a chave real do banco (pode estar com máscara)
  let cpfKey = currentPatient?.cpf || cpfDigits.padStart(11, "0");
  if (!currentPatient?.cpf) {
    const exists = await findPatientByCPF(cpfDigits);
    if (exists?.cpf) cpfKey = exists.cpf;
  }

  const patch = { tests_liberados: setToSortedArray(nextLiberadosSet) };
  if (nextFeitosSet) patch.tests_feitos = setToSortedArray(nextFeitosSet);

  const patched = await dbPatchBy(DB.PATIENTS, "cpf", cpfKey, patch);
  if (patched) currentPatient = patched;

  // atualiza lista de concluídos (depende de liberados/feitos)
  await refreshAllDonePatientsCache();

  setMsg(msgBox, "Testes atualizados.", "ok");
  renderTests();
}

async function cadastrarTeste(code) {
  const c = String(code || "").trim();
  if (!c) return;

  // Modo create (antes de salvar o paciente)
  if (!currentPatient) {
    pendingLiberados.add(c);
    setMsg($("#pacMsg"), `Teste ${c} selecionado. (Vai salvar quando você clicar em Salvar)`, "ok");
    renderTests();
    return;
  }

  try {
    setMsg($("#pacMsg"), `Cadastrando ${c}…`);
    const nextLiberados = new Set(patientLiberadosSet(currentPatient));
    nextLiberados.add(c);

    await patchPatientTests(nextLiberados);
  } catch (e) {
    console.error(e);
    setMsg($("#pacMsg"), "Erro ao cadastrar teste: " + (e?.message || e), "err");
  }
}

async function descadastrarTeste(code, status = "") {
  const c = String(code || "").trim();
  if (!c) return;

  // Modo create (antes de salvar o paciente)
  if (!currentPatient) {
    pendingLiberados.delete(c);
    setMsg($("#pacMsg"), `Teste ${c} removido da seleção.`, "ok");
    renderTests();
    return;
  }

  const isPreenchido = status === "preenchido";
  if (isPreenchido) {
    const ok = confirm(
      `O teste ${c} está como "preenchido".\n\nDescadastrar vai remover o teste e apagar o status de preenchimento.\n\nConfirma?`
    );
    if (!ok) { testsUiRestore = null; return; }
  }

  try {
    setMsg($("#pacMsg"), `Descadastrando ${c}…`);

    const nextLiberados = new Set(patientLiberadosSet(currentPatient));
    const nextFeitos = new Set(patientFeitosSet(currentPatient));

    nextLiberados.delete(c);
    nextFeitos.delete(c);

    await patchPatientTests(nextLiberados, nextFeitos);
  } catch (e) {
    console.error(e);
    setMsg($("#pacMsg"), "Erro ao descadastrar teste: " + (e?.message || e), "err");
  }
}

function renderTests() {
  const grid = $("#testsGrid");
  const info = $("#testsInfo");
  if (!grid || !info) return;

  // preserva posição e grupos abertos para não "voltar pro topo" ao re-renderizar
  const prevScrollY = window.scrollY || 0;
  const prevOpenGroups = new Set();
  grid.querySelectorAll("details.test-group[open]").forEach((d) => {
    const k = d.dataset.groupKey;
    if (k) prevOpenGroups.add(k);
  });

  const restore = testsUiRestore;
  testsUiRestore = null;

  grid.innerHTML = "";
    if (testsLoadError) {
    info.className = "tag new";
    info.textContent = "ERRO ao carregar tests: " + (testsLoadError?.message || testsLoadError);
    return;
  }


  if (!testsCatalog.length) {
    info.className = "tag new";
    info.textContent = "Nenhum teste cadastrado na tabela tests.";
    return;
  }

  const birthISO = getBirthdateISOFromPatientOrInput();
  const ageYears = calcAgeYears(birthISO);

  // Regras de visibilidade:
  // - só mostra active
  // - filtra por idade (age_min/age_max)
  // - EXCEÇÃO: se paciente já tem o teste liberado/preenchido, mostra mesmo fora da faixa (pra você conseguir gerenciar)
  const visible = testsCatalog.filter((t) => {
    if (!t.active) return false;

    const ageOk = withinAgeRange(t, ageYears);
    if (ageOk) return true;

    // se já liberado/preenchido, mantém visível
    return patientAlreadyHasTest(t.code);
  });

  if (!visible.length) {
  info.className = "tag new";
  info.textContent =
    ageYears === null
      ? "Nenhum teste ativo para listar (preencha a data de nascimento para filtrar por idade)."
      : `Nenhum teste ativo compatível com ${ageYears} anos.`;

  renderAllDonePatientsDropdown(); // <-- adiciona isso
  return;
}

  // Contagens por status (apenas dos visíveis)
  let cCadastrar = 0, cJa = 0, cDone = 0;
  for (const t of visible) {
    const st = testStatus(t);
    if (st === "cadastrar") cCadastrar++;
    else if (st === "ja") cJa++;
    else cDone++;
  }

  const lblMap = {
    todos: "Todos",
    cadastrar: "Cadastrar",
    ja: "Já registrados",
    preenchido: "Preenchido"
  };

  info.className = "tag";
  info.textContent = `Ativos (visíveis): ${visible.length} • Cadastrar: ${cCadastrar} • Já: ${cJa} • Preenchido: ${cDone} • Idade: ${
    ageYears === null ? "—" : ageYears + " anos"
  } • Filtro: ${lblMap[statusFilter] || "Todos"}`;

  // Ordem dos grupos (do jeito que você pediu)
  const groupOrder = ["paciente", "pais", "profissional", "professores", "outros", "familiares"];
  const groupLabel = {
    paciente: "Paciente",
    pais: "Pais/Cuidadores",
    profissional: "Profissional",
    professores: "Professores",
    familiares: "Familiares",
    outros: "Outros"
  };

  // Agrupa por source
  const groups = new Map();
  for (const t of visible) {
    const k = t.srcKey || "outros";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  // Render por grupo
  // Render por grupo
for (const k of groupOrder) {
  const items = groups.get(k);
  if (!items || !items.length) continue;

  // aplica filtro de status por item dentro do grupo
  const itemsFiltered = items.filter((t) => {
    const st = testStatus(t);
    if (statusFilter === "todos") return true;
    return st === statusFilter;
  });

  if (!itemsFiltered.length) continue;

  // AGORA: grupo vira <details> (fechado por padrão)
  const groupWrap = el("details", { className: "test-group" });
  groupWrap.dataset.groupKey = k;
  groupWrap.classList.add(`source-${k}`);
  groupWrap.open = ((restore?.openGroups || []).includes(k) || prevOpenGroups.has(k));

  // Cabeçalho clicável
  const head = el("summary", { className: "group-head" });

  const title = el("div", { className: "group-title" });
  const dot = el("span", { className: "group-dot" });
  const name = el("span", { textContent: groupLabel[k] || "Outros" });
  title.appendChild(dot);
  title.appendChild(name);

  const counter = el("span", {
    className: "tag new",
    textContent: `${itemsFiltered.length}`
  });

  head.appendChild(title);
  head.appendChild(counter);

  const inner = el("div", { className: "group-grid" });

  for (const t of itemsFiltered) {
    const st = testStatus(t);

    const wrap = el("div", { className: "check" });
    wrap.dataset.testCode = t.code;
    wrap.classList.add(`source-${t.srcKey}`);

    // Botão ação (Cadastrar / Descadastrar)
    const actionBtn = el("button", {
      type: "button",
      className: "btn small test-action" + (st === "cadastrar" ? "" : " danger"),
      textContent: st === "cadastrar" ? "Cadastrar" : "Descadastrar"
    });

    actionBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      // guarda posição e grupo aberto para não pular pro topo ao re-renderizar
      testsUiRestore = captureTestsUiRestore(t.code, k);

      if (st === "cadastrar") cadastrarTeste(t.code);
      else descadastrarTeste(t.code, st);
    });

    // Meio (somente código + título)
    const box = el("div", { className: "box" });
    const codeEl = el("div", { className: "code", textContent: t.code });
    const labelEl = el("div", { className: "title", textContent: t.label });
    box.appendChild(codeEl);
    box.appendChild(labelEl);

    // Ações no rodapé do card
    const actions = el("div", { className: "test-actions" });
    actions.appendChild(actionBtn);

    wrap.appendChild(box);
    wrap.appendChild(actions);

    inner.appendChild(wrap);
  }

  groupWrap.appendChild(head);
  groupWrap.appendChild(inner);
  grid.appendChild(groupWrap);
  
}
renderAllDonePatientsDropdown();

  // restaura scroll (e mantém o card clicado "na tela")
  requestAnimationFrame(() => {
    const targetCode = restore?.anchorCode;
    const y = (restore?.scrollY ?? prevScrollY) || 0;

    if (targetCode) {
      const card = grid.querySelector(`[data-test-code="${escapeAttrValue(targetCode)}"]`);
      if (card && typeof card.scrollIntoView === "function") {
        card.scrollIntoView({ block: "center" });
        return;
      }
    }

    window.scrollTo({ top: y });
  });
}

/* ===== LOOKUP MODE ===== */
function enterLookupMode() {
  hide($("#pacForm"));
  hide($("#testsWrap"));
  show($("#lookupBar"));
  setMsg($("#pacMsg"), "");

  $("#pacNome").value = "";
  $("#pacNasc").value = "";
  $("#pacEmail").value = "";
  $("#pacWhats").value = "";

  pendingLiberados = new Set();
}

/* ===== PACIENTE ===== */
async function carregarPorCPF() {
  const cpf = onlyDigits($("#pacCPF").value);

  if (!cpf) {
    setMsg($("#pacMsg"), "Digite um CPF.", "warn");
    return;
  }
  if (!validaCPF(cpf)) {
    setMsg($("#pacMsg"), "CPF inválido.", "err");
    return;
  }

  setMsg($("#pacMsg"), "Buscando cadastro…");

  let patient = null;
  try {
    patient = await findPatientByCPF(cpf);
  } catch (e) {
    console.error("Erro no Supabase (patients select):", e);
    setMsg($("#pacMsg"), "Erro ao buscar no Supabase: " + (e.message || e), "err");
    return;
  }

  if (patient) {
    currentPatient = patient;
    mode = "update";
    pendingLiberados = new Set();

    $("#pacNome").value = currentPatient.nome || "";
    $("#pacNasc").value = (currentPatient.data_nascimento || "").slice(0, 10);
    $("#pacEmail").value = currentPatient.email || "";

    const w = currentPatient.whatsapp || "";
    $("#pacWhats").value = w || "";
    if (w) formatWhatsInput($("#pacWhats"));

    setMsg($("#pacMsg"), "Cadastro encontrado.", "ok");
    show($("#pacForm"));
    show($("#testsWrap"));
  } else {
    // diagnóstico extra (RLS costuma cair aqui)
    const probe = await probePatientsVisibility();
    if (probe.ok && !probe.hasAnyVisibleRow) {
      setMsg(
        $("#pacMsg"),
        "Não encontrei esse CPF. E atenção: seu front não está enxergando nenhum paciente no Supabase. Isso costuma ser RLS/política de SELECT bloqueando o anon key.",
        "warn"
      );
    } else {
      setMsg(
        $("#pacMsg"),
        "CPF sem cadastro. Preencha os dados e selecione os testes para cadastrar.",
        "warn"
      );
    }

    currentPatient = null;
    mode = "create";
    pendingLiberados = new Set();
    pendingLiberados = new Set();

    $("#pacNome").value = "";
    $("#pacNasc").value = "";
    $("#pacEmail").value = "";
    $("#pacWhats").value = "";

    show($("#pacForm"));
    show($("#testsWrap"));
  }

    await loadTests();
    await loadFilledFormsForCurrentCPF();
    await refreshAllDonePatientsCache();
    renderAllDonePatientsDropdown();
}


async function salvar() {
  const btn = $("#btnSalvar");
  try {
    btn.disabled = true;
    btn.textContent = "Salvando…";

    const nome = $("#pacNome").value.trim();
    const cpf = onlyDigits($("#pacCPF").value).padStart(11, "0");
    const nascISO = toISODateFromInput($("#pacNasc").value);
    const email = $("#pacEmail").value.trim();
    const whatsRaw = $("#pacWhats").value;
    const whatsE164 = normalizeWhats(whatsRaw);

    if (!nome) {
      setMsg($("#pacMsg"), "Informe o nome.", "warn");
      throw new Error("sem nome");
    }
    if (!validaCPF(cpf)) {
      setMsg($("#pacMsg"), "CPF inválido.", "err");
      throw new Error("cpf inválido");
    }
    if (!nascISO) {
      setMsg($("#pacMsg"), "Informe a data de nascimento.", "warn");
      throw new Error("sem data");
    }
    if (email && !isValidEmail(email)) {
      setMsg($("#pacMsg"), "E-mail inválido.", "warn");
      throw new Error("email inválido");
    }
    if (whatsRaw && !whatsE164) {
      setMsg($("#pacMsg"), "WhatsApp inválido. Use DDD + número.", "warn");
      throw new Error("whats inválido");
    }

    // Confirma modo
    let exists = null;
    try {
      const f = await dbSearch(DB.PATIENTS, { cpf });
      if (f && f.length) exists = f[0];
    } catch (e) {}

    if (mode === "create" && exists) {
      currentPatient = exists;
      mode = "update";
    }

    if (mode === "create") {
      const row = {
        nome,
        cpf,
        data_nascimento: nascISO,
        created_at: nowDateTimeLocal(),
        email,
        whatsapp: whatsE164,
        // NOVO: JSONB
        tests_liberados: [],
        tests_feitos: []
      };
      // Testes selecionados (modo create) ficam no Set pendingLiberados
      row.tests_liberados = setToSortedArray(pendingLiberados);
      const created = await dbCreate(DB.PATIENTS, row);
      currentPatient = created || row;
      mode = "update";
      pendingLiberados = new Set();
      setMsg($("#pacMsg"), "Cadastro criado com sucesso.", "ok");
      renderTests();
    } else {
      const update = {
        nome,
        data_nascimento: nascISO,
        email,
        whatsapp: whatsE164
      };

      // Observação: agora os testes são cadastrados/descadastrados pelos botões do card.
      let cpfKey = cpf;

      if (currentPatient && currentPatient.cpf) {
        cpfKey = currentPatient.cpf;
      } else {
        const exists = await findPatientByCPF(cpf);
        if (exists && exists.cpf) cpfKey = exists.cpf;
      }

      const patched = await dbPatchBy(DB.PATIENTS, "cpf", cpfKey, update);
      if (patched) currentPatient = patched;

      setMsg($("#pacMsg"), "Cadastro atualizado.", "ok");

      await carregarPorCPF();
    }  } catch (e) {
    if (e && e.message && !e.message.startsWith("sem ")) {
      console.error(e.message);
      setMsg($("#pacMsg"), "Erro ao salvar: " + e.message, "err");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar";
  }
}

/* ===== EVENTOS INICIAIS ===== */
window.addEventListener("DOMContentLoaded", async () => {
  const pacWhats = $("#pacWhats");
  if (pacWhats) {
    pacWhats.addEventListener("input", () => formatWhatsInput(pacWhats));
  }

    // Re-renderiza testes ao mudar data de nascimento (pra filtrar por idade)
  $("#pacNasc")?.addEventListener("change", () => renderTests());
  $("#pacNasc")?.addEventListener("input", () => renderTests());

  // Login
  $("#btnLogin")?.addEventListener("click", doLogin);
  ["loginUser", "loginPass"].forEach((id) => {
    const inp = document.getElementById(id);
    if (inp) {
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doLogin();
      });
    }
  });

  // Logout
  $("#btnLogout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();

    currentPatient = null;
    mode = "create";
    $("#loginUser").value = "";
    $("#loginPass").value = "";
    hide($("#viewApp"));
    hide($("#btnLogout"));
    show($("#viewLogin"));
    setMsg($("#loginMsg"), "");
  });

  // CPF: Enter para buscar + blur inteligente
  $("#pacCPF")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") carregarPorCPF();
  });
  $("#pacCPF")?.addEventListener("blur", () => {
    const d = onlyDigits($("#pacCPF").value);
    if (d.length === 11 && validaCPF(d)) carregarPorCPF();
  });

  // Botões principais
  $("#btnBuscar")?.addEventListener("click", carregarPorCPF);
  $("#btnSalvar")?.addEventListener("click", salvar);
  $("#btnAtualizarAnamneses")?.addEventListener("click", loadFilledFormsForCurrentCPF);
$("#btnSelecionarTodosAnam")?.addEventListener("click", () => toggleAnamneseSelection(true));
$("#btnLimparSelecaoAnam")?.addEventListener("click", () => toggleAnamneseSelection(false));

  // Filtro status
  $("#statusFilter")?.addEventListener("change", (e) => {
    statusFilter = e.target.value;
    renderTests();
  });

  // Copiar link (CPF)
$("#btnCopyLink")?.addEventListener("click", async () => {
  const msgBox = $("#pacMsg");

  try {
    const cpfBase = currentPatient?.cpf || $("#pacCPF")?.value || "";
    const url = await getOrCreatePatientLink(cpfBase);

    // tenta clipboard moderno
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }

    setMsg(msgBox, "Link copiado! Cole e envie para o paciente.", "ok");
  } catch (e) {
    console.error(e);
    setMsg(msgBox, e?.message || "Não consegui copiar o link.", "err");
  }
});


  // Baixar anamnese
 $("#btnBaixarAnamnese")?.addEventListener("click", async () => {
  const btn = $("#btnBaixarAnamnese");
  const msgBox = $("#pacMsg");

  try {
    btn.disabled = true;
    btn.textContent = "Gerando PDF…";

    // Se ainda não carregou a lista, carrega agora
    if (!filledFormsCache.length) {
      await loadFilledFormsForCurrentCPF();
    }

    const selected = getSelectedFilledForms();
    if (!selected.length) {
      throw new Error("Selecione pelo menos um formulário preenchido para baixar.");
    }

    await generateSelectedFormsPdf(selected);

    setMsg(msgBox, `PDF gerado com ${selected.length} formulário(s).`, "ok");
  } catch (e) {
    console.error(e);
    setMsg(msgBox, e?.message || "Não consegui gerar o PDF.", "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Baixar PDF dos formulários";
  }
});

  // ==========================
  // RESTAURA SESSÃO (AUTO-LOGIN)
  // ==========================
  try {
    const { data: sessionData, error } = await supabase.auth.getSession();
    if (error) throw error;

    if (sessionData?.session) {
      hide($("#viewLogin"));
      show($("#viewApp"));
      show($("#btnLogout"));

      await loadTests();
      enterLookupMode();
      $("#pacCPF")?.focus();
    }
  } catch (e) {
    console.warn("Falha ao restaurar sessão:", e?.message || e);
  }
});



async function checkAuthTable(user, pass) {
  const tables = ["Auth", "auth"];
  const combos = [
    { login: user, Senha: pass },
    { login: user, senha: pass },
    { Login: user, Senha: pass },
    { Login: user, senha: pass }
  ];

  for (const t of tables) {
    for (const filters of combos) {
      try {
        const rows = await dbSearch(t, filters);
        if (rows && rows.length) return rows[0];
      } catch (e) {
        // tenta próxima variação
      }
    }
  }
  return null;
}

async function doLogin() {
  const email = $("#loginUser").value.trim();   // agora é e-mail
  const password = $("#loginPass").value;
  const msg = $("#loginMsg");

  if (!email || !password) {
    setMsg(msg, "Preencha usuário e senha.", "warn");
    return;
  }

  setMsg(msg, "Entrando…");

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error || !data?.session) {
    setMsg(msg, "Usuário ou senha inválidos.", "err");
    return;
  }

  setMsg(msg, "Login ok.", "ok");
  hide($("#viewLogin"));
  show($("#viewApp"));
  show($("#btnLogout"));

  await loadTests();
  enterLookupMode();
  $("#pacCPF").focus();
}



