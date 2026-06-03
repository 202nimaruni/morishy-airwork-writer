const STORAGE_KEY = "airwork_writer_history_v1";
const SETTINGS_KEY = "airwork_writer_settings_v1";
const AUTOSAVE_KEY = "airwork_writer_autosave_v1";

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  // Good enough for local drafts
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el;
}

function setExportNote(msg) {
  $("exportNote").textContent = msg ?? "";
}

function setImportNote(msg) {
  const el = document.getElementById("importNote");
  if (el) el.textContent = msg ?? "";
}

function setPasteNote(msg) {
  const el = document.getElementById("pasteNote");
  if (el) el.textContent = msg ?? "";
}

function getOpenAIApiKey() {
  const s = getSettings();
  const key = (s?.openaiApiKey || "").trim();
  return key;
}

async function aiExtractFieldsFromText(rawText) {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) throw new Error("APIキー未設定");

  const schema = {
    companyName: "求人企業名（会社名/企業名）",
    displayName: "求人表示名・店舗名・部署名",
    jobTitle: "職種名",
    employmentType: "雇用形態",
    workAddress: "勤務地住所",
    access: "最寄り駅・アクセス",
    transfer: "転勤の有無",
    salary: "給与",
    fixedOvertime: "固定残業代の有無・詳細",
    bonusRaise: "賞与・昇給",
    workHours: "勤務時間",
    overtimeHours: "残業時間",
    holidays: "休日休暇",
    benefits: "福利厚生",
    trialPeriod: "試用・研修期間",
    mainDuties: "主な仕事内容（箇条書き可）",
    productService: "扱う商品・サービス",
    stakeholders: "仕事で関わる相手",
    constraints: "新規営業・接客・電話対応・ノルマなどの有無（事実のみ）",
    dailyFlow: "1日の流れ・業務の流れ",
    training: "入社後の研修・サポート体制",
    business: "会社の事業内容",
    achievements: "会社の強み・実績（数字/事実がある場合のみ）",
    clients: "取引先・顧客層",
    atmosphere: "職場の雰囲気",
    team: "チーム人数・年齢層",
  };

  const prompt = `あなたは求人ページから事実情報だけを抽出するアシスタントです。
以下のテキストから、次の項目に対応する値を抽出してください。

【重要ルール】
- 推測で補完しない。書かれていないものは空文字にする。
- 誇張・要約しない（原文の言い方をできるだけ保持）。
- 仕事内容/業務の流れ/研修などは改行を含むテキストでOK。
- 返答はJSONのみ。コードブロック禁止。

【抽出項目】（キー: 意味）
${Object.entries(schema)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

【入力テキスト】
${rawText}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error: HTTP ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Sometimes the model returns leading/trailing text; try to recover JSON substring
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("JSON解析に失敗");
    parsed = JSON.parse(m[0]);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("JSON形式が不正");
  return parsed;
}

function stripHtmlToText(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    const text = doc.body?.innerText || doc.documentElement?.innerText || "";
    return text;
  } catch {
    return String(html || "");
  }
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickAfterLabel(text, labels) {
  // labels: ["給与", "給料"] etc
  const t = normalizeText(text);
  const lines = t.split("\n").map((x) => x.trim());
  const labelSet = new Set(labels);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern: "給与：xxx" / "給与: xxx"
    for (const lab of labelSet) {
      const m = line.match(new RegExp(`^${escapeRegExp(lab)}\\s*[：:]\\s*(.+)$`));
      if (m?.[1]) return m[1].trim();
    }

    // Pattern: "給与" then next non-empty line is the value
    if (labelSet.has(line)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const v = lines[j].trim();
        if (v) return v;
      }
    }
  }
  return "";
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFromText(raw, { url } = {}) {
  const text = normalizeText(raw);
  const out = {};

  // Basic
  out.companyName =
    pickAfterLabel(text, ["会社名", "企業名", "法人名"]) ||
    "";
  out.jobTitle =
    pickAfterLabel(text, ["職種", "職種名", "募集職種", "仕事内容（職種）"]) ||
    "";
  out.employmentType = pickAfterLabel(text, ["雇用形態"]) || "";
  out.salary = pickAfterLabel(text, ["給与", "給料", "報酬"]) || "";
  out.workAddress = pickAfterLabel(text, ["勤務地", "勤務地住所", "勤務地（住所）", "住所"]) || "";
  out.access = pickAfterLabel(text, ["アクセス", "最寄り駅", "交通", "通勤"]) || "";
  out.workHours = pickAfterLabel(text, ["勤務時間", "勤務時間帯", "勤務"] ) || "";
  out.overtimeHours = pickAfterLabel(text, ["残業", "残業時間"]) || "";
  out.holidays = pickAfterLabel(text, ["休日", "休日休暇", "休暇"]) || "";
  out.benefits = pickAfterLabel(text, ["福利厚生", "待遇", "制度"]) || "";
  out.trialPeriod = pickAfterLabel(text, ["試用期間", "研修期間", "試用・研修期間"]) || "";
  out.fixedOvertime = pickAfterLabel(text, ["固定残業", "固定残業代"]) || "";
  out.bonusRaise = pickAfterLabel(text, ["賞与", "昇給", "賞与・昇給"]) || "";
  out.transfer = pickAfterLabel(text, ["転勤"]) || "";
  out.clients = pickAfterLabel(text, ["取引先", "顧客層", "取引先・顧客層"]) || "";

  // Longer fields (heuristic)
  const duties = pickAfterLabel(text, ["仕事内容", "主な仕事内容", "業務内容"]);
  if (duties && duties.length > 10) out.mainDuties = duties;

  const training = pickAfterLabel(text, ["研修", "教育", "サポート", "入社後の研修", "サポート体制"]);
  if (training && training.length > 6) out.training = training;

  // If companyName empty, try title-like cues from URL
  if (!out.companyName && url) {
    try {
      const u = new URL(url);
      if (u.hostname) out.companyName = "";
    } catch {}
  }

  // Clean: remove obvious noise
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (typeof v === "string") out[k] = v.replace(/\s+/g, " ").trim();
  }
  return out;
}

function applyImportedFields(fields, { onlyEmpty }) {
  const mapping = {
    companyName: "companyName",
    displayName: "displayName",
    jobTitle: "jobTitle",
    employmentType: "employmentType",
    workAddress: "workAddress",
    access: "access",
    transfer: "transfer",
    salary: "salary",
    fixedOvertime: "fixedOvertime",
    bonusRaise: "bonusRaise",
    workHours: "workHours",
    overtimeHours: "overtimeHours",
    holidays: "holidays",
    benefits: "benefits",
    trialPeriod: "trialPeriod",
    clients: "clients",
    mainDuties: "mainDuties",
    training: "training",
  };

  const touched = [];
  for (const [key, id] of Object.entries(mapping)) {
    const value = fields[key];
    if (!value) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    const current = (el.value || "").trim();
    if (onlyEmpty && current) continue;
    el.value = value;
    el.classList.add("is-imported");
    touched.push(id);
  }
  // remove highlight later
  setTimeout(() => {
    for (const id of touched) document.getElementById(id)?.classList.remove("is-imported");
  }, 1800);
}

function setSettingsNote(msg) {
  const el = document.getElementById("settingsNote");
  if (el) el.textContent = msg ?? "";
}

function setBackupNote(msg) {
  const el = document.getElementById("backupNote");
  if (el) el.textContent = msg ?? "";
}

function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function setSettings(next) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next ?? {}));
}

function maskKey(key) {
  if (!key) return "";
  const k = String(key);
  if (k.length <= 10) return "********";
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

function readForm() {
  const styleType = document.querySelector("#styleType .segmented__item.is-active")?.dataset?.value ?? "MVV型";
  const styleStrength =
    document.querySelector("#styleStrength .segmented__item.is-active")?.dataset?.value ?? "標準";

  return {
    id: currentId,
    savedAt: currentSavedAt,
    updatedAt: nowIso(),
    companyName: $("companyName").value.trim(),
    displayName: $("displayName").value.trim(),
    jobTitle: $("jobTitle").value.trim(),
    employmentType: $("employmentType").value.trim(),
    workAddress: $("workAddress").value.trim(),
    access: $("access").value.trim(),
    transfer: $("transfer").value.trim(),
    salary: $("salary").value.trim(),
    fixedOvertime: $("fixedOvertime").value.trim(),
    bonusRaise: $("bonusRaise").value.trim(),
    workHours: $("workHours").value.trim(),
    overtimeHours: $("overtimeHours").value.trim(),
    holidays: $("holidays").value.trim(),
    benefits: $("benefits").value.trim(),
    trialPeriod: $("trialPeriod").value.trim(),
    mainDuties: $("mainDuties").value.trim(),
    productService: $("productService").value.trim(),
    stakeholders: $("stakeholders").value.trim(),
    constraints: $("constraints").value.trim(),
    dailyFlow: $("dailyFlow").value.trim(),
    training: $("training").value.trim(),
    business: $("business").value.trim(),
    achievements: $("achievements").value.trim(),
    clients: $("clients").value.trim(),
    atmosphere: $("atmosphere").value.trim(),
    team: $("team").value.trim(),

    styleType,
    styleStrength,
    vibeWant: $("vibeWant").value.trim(),
    vibeAvoid: $("vibeAvoid").value.trim(),

    targetMain: $("targetMain").value.trim(),
    targetSub: $("targetSub").value.trim(),
    appealMain: $("appealMain").value.trim(),
    appealSub: $("appealSub").value.trim(),
    worries: $("worries").value.trim(),
    allowFacts: $("allowFacts").value.trim(),
    applyPolicy: $("applyPolicy").value.trim(),
    catchDirection: $("catchDirection").value.trim(),
    avoidPhrases: $("avoidPhrases").value.trim(),
    cannotAssert: $("cannotAssert").value.trim(),
  };
}

function writeForm(d) {
  $("companyName").value = d.companyName ?? "";
  $("displayName").value = d.displayName ?? "";
  $("jobTitle").value = d.jobTitle ?? "";
  $("employmentType").value = d.employmentType ?? "";
  $("workAddress").value = d.workAddress ?? "";
  $("access").value = d.access ?? "";
  $("transfer").value = d.transfer ?? "";
  $("salary").value = d.salary ?? "";
  $("fixedOvertime").value = d.fixedOvertime ?? "";
  $("bonusRaise").value = d.bonusRaise ?? "";
  $("workHours").value = d.workHours ?? "";
  $("overtimeHours").value = d.overtimeHours ?? "";
  $("holidays").value = d.holidays ?? "";
  $("benefits").value = d.benefits ?? "";
  $("trialPeriod").value = d.trialPeriod ?? "";
  $("mainDuties").value = d.mainDuties ?? "";
  $("productService").value = d.productService ?? "";
  $("stakeholders").value = d.stakeholders ?? "";
  $("constraints").value = d.constraints ?? "";
  $("dailyFlow").value = d.dailyFlow ?? "";
  $("training").value = d.training ?? "";
  $("business").value = d.business ?? "";
  $("achievements").value = d.achievements ?? "";
  $("clients").value = d.clients ?? "";
  $("atmosphere").value = d.atmosphere ?? "";
  $("team").value = d.team ?? "";

  setSegmented("#styleType", d.styleType ?? "MVV型");
  setSegmented("#styleStrength", d.styleStrength ?? "標準");
  $("vibeWant").value = d.vibeWant ?? "";
  $("vibeAvoid").value = d.vibeAvoid ?? "";

  $("targetMain").value = d.targetMain ?? "";
  $("targetSub").value = d.targetSub ?? "";
  $("appealMain").value = d.appealMain ?? "";
  $("appealSub").value = d.appealSub ?? "";
  $("worries").value = d.worries ?? "";
  $("allowFacts").value = d.allowFacts ?? "";
  $("applyPolicy").value = d.applyPolicy ?? "";
  $("catchDirection").value = d.catchDirection ?? "";
  $("avoidPhrases").value = d.avoidPhrases ?? "";
  $("cannotAssert").value = d.cannotAssert ?? "";
}

function getHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function setHistory(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function getAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function setAutosave(draft) {
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(draft));
}

function clearAutosave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}

function upsertHistory(draft) {
  const items = getHistory();
  const idx = items.findIndex((x) => x.id === draft.id);
  if (idx >= 0) items[idx] = draft;
  else items.unshift(draft);
  setHistory(items.slice(0, 50));
  renderHistory();
}

function removeHistory(id) {
  const items = getHistory().filter((x) => x.id !== id);
  setHistory(items);
  renderHistory();
}

function renderHistory() {
  const root = $("historyList");
  root.innerHTML = "";
  const items = getHistory();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "historyItem";
    empty.innerHTML =
      '<div class="historyItem__title">まだ保存がありません</div><div class="historyItem__meta">右上の「履歴に保存」で追加できます。</div>';
    root.appendChild(empty);
    return;
  }

  for (const it of items) {
    const el = document.createElement("div");
    el.className = "historyItem";
    const title = `${it.jobTitle || "（職種未入力）"} / ${it.companyName || "（企業未入力）"}`;
    const meta = `${new Date(it.updatedAt || it.savedAt || Date.now()).toLocaleString()} ・ ${
      it.styleType || "文体未選択"
    }／${it.styleStrength || "標準"}`;
    el.innerHTML = `
      <div class="historyItem__title">${escapeHtml(title)}</div>
      <div class="historyItem__meta">${escapeHtml(meta)}</div>
      <div class="historyItem__actions">
        <button class="btn btn--ghost" data-action="load" data-id="${it.id}" type="button">開く</button>
        <button class="btn btn--ghost" data-action="dup" data-id="${it.id}" type="button">複製</button>
        <button class="btn btn--ghost" data-action="del" data-id="${it.id}" type="button">削除</button>
      </div>
    `;
    root.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

function setSegmented(rootSelector, value) {
  const root = document.querySelector(rootSelector);
  if (!root) return;
  for (const btn of root.querySelectorAll(".segmented__item")) {
    btn.classList.toggle("is-active", btn.dataset.value === value);
  }
}

function bindSegmented(rootSelector, onChange) {
  const root = document.querySelector(rootSelector);
  if (!root) return;
  root.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__item");
    if (!btn) return;
    setSegmented(rootSelector, btn.dataset.value);
    onChange(btn.dataset.value);
  });
}

function styleHelp(type) {
  switch (type) {
    case "MVV型":
      return "思想・世界観・仕事の意義で共感をつくる。条件だけで比較されない原稿に。";
    case "プレーン型":
      return "事実ベースでわかりやすく。安心材料を整理して応募ハードルを下げる。";
    case "ベンチャー型":
      return "挑戦・成長・稼ぐ理由を明確に。背中を押すが、根拠のない煽りはしない。";
    default:
      return "";
  }
}

function renderPreview(d) {
  const company = d.companyName || "企業名（未入力）";
  const job = d.jobTitle || "職種名（未入力）";
  $("prevCompany").textContent = company;
  $("prevJobTitle").textContent = job;

  const catchCopy = buildCatchCopy(d);
  $("prevCatch").textContent = catchCopy;

  $("styleTypeHelp").textContent = styleHelp(d.styleType);

  $("prevBody").innerHTML = buildJobPostHtml(d);
}

function firstNonEmptyLine(text) {
  return (text || "")
    .split("\n")
    .map((x) => x.trim())
    .find((x) => x.length > 0);
}

function buildCatchCopy(d) {
  // デザインのたたき台：実際の生成はAI側で行うが、プレビューには“それっぽい見出し”を出す
  const vibe = d.styleType || "プレーン型";
  const job = d.jobTitle || "この仕事";
  const hint = d.worries ? `（悩み: ${d.worries}）` : "";

  if (vibe === "MVV型") return `${job}は、ただの作業ではありません。あなたの探求心が価値になる仕事です。${hint}`.trim();
  if (vibe === "ベンチャー型") return `正直に言います。${job}で「稼ぐ力」と「成長」を取りにいきませんか。${hint}`.trim();
  return `未経験から始めやすい${job}。仕事内容がわかりやすく、安心して続けられます。${hint}`.trim();
}

function bulletsFromTextarea(text) {
  const lines = (text || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  return lines.map((x) => x.replace(/^[・\-*]\s?/, ""));
}

function buildJobPostHtml(d) {
  const duties = bulletsFromTextarea(d.mainDuties);
  const flow = bulletsFromTextarea(d.dailyFlow);
  const training = bulletsFromTextarea(d.training);
  const business = bulletsFromTextarea(d.business);
  const achievements = bulletsFromTextarea(d.achievements);

  const pills = [
    d.employmentType ? `雇用形態: ${d.employmentType}` : null,
    d.salary ? `給与: ${d.salary}` : null,
    d.holidays ? `休日: ${d.holidays}` : null,
    d.workHours ? `勤務時間: ${d.workHours}` : null,
  ].filter(Boolean);

  const html = [];
  html.push(`<h3>お仕事について／仕事内容</h3>`);
  html.push(`<p>${escapeHtml(buildIntro(d))}</p>`);
  if (pills.length) {
    html.push(`<p>${pills.map((p) => `<span class="pill">${escapeHtml(p)}</span>`).join(" ")}</p>`);
  }

  html.push(`<div class="hr"></div>`);
  html.push(`<h3>業務内容（事実ベース）</h3>`);
  if (duties.length) html.push(`<ul>${duties.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`);
  else html.push(`<p>主な仕事内容を入力すると、ここに表示されます。</p>`);

  if (d.constraints) html.push(`<p><b>補足（事実）:</b> ${escapeHtml(d.constraints)}</p>`);

  if (flow.length) {
    html.push(`<h3>業務の流れ</h3>`);
    html.push(`<ul>${flow.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`);
  }

  if (training.length) {
    html.push(`<h3>研修・サポート</h3>`);
    html.push(`<ul>${training.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`);
  } else if (d.training) {
    html.push(`<h3>研修・サポート</h3>`);
    html.push(`<p>${escapeHtml(d.training)}</p>`);
  }

  html.push(`<div class="hr"></div>`);
  html.push(`<h3>会社概要</h3>`);
  const companyLine = d.companyName ? `${d.companyName}${d.displayName ? `（${d.displayName}）` : ""}` : "（企業名未入力）";
  html.push(`<p><b>${escapeHtml(companyLine)}</b></p>`);
  if (business.length) html.push(`<ul>${business.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`);
  else if (d.business) html.push(`<p>${escapeHtml(d.business)}</p>`);
  else html.push(`<p>会社の事業内容を入力すると、ここに表示されます。</p>`);

  if (achievements.length) {
    html.push(`<h3>実績・強み（入力された事実のみ）</h3>`);
    html.push(`<ul>${achievements.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`);
  } else if (d.achievements) {
    html.push(`<h3>実績・強み（入力された事実のみ）</h3>`);
    html.push(`<p>${escapeHtml(d.achievements)}</p>`);
  }

  if (d.atmosphere || d.team) {
    html.push(`<h3>職場環境</h3>`);
    if (d.atmosphere) html.push(`<p><b>雰囲気:</b> ${escapeHtml(d.atmosphere)}</p>`);
    if (d.team) html.push(`<p><b>チーム:</b> ${escapeHtml(d.team)}</p>`);
  }

  html.push(`<div class="hr"></div>`);
  html.push(`<h3>応募導線</h3>`);
  html.push(`<p>${escapeHtml(buildOutro(d))}</p>`);
  html.push(`<p class="pill">文体: ${escapeHtml(d.styleType)}／強度: ${escapeHtml(d.styleStrength)}</p>`);
  return html.join("");
}

function buildIntro(d) {
  // ここは最終的に「AIが生成」するが、デザイン確認用の仮文として文体だけ反映
  const job = d.jobTitle || "この仕事";
  if (d.styleType === "MVV型") {
    return `私たちが大切にしているのは、${job}を通じて生まれる価値です。経験よりも「学び続けたい」という姿勢を歓迎します。`;
  }
  if (d.styleType === "ベンチャー型") {
    return `今の働き方に燻っているなら、環境を変えるタイミングかもしれません。${job}で成長と成果を取りにいきましょう。`;
  }
  return `仕事内容・環境・条件を、わかりやすく整理してお伝えします。未経験の方も安心して検討できるように構成しています。`;
}

function buildOutro(d) {
  if (d.styleType === "MVV型") {
    return "少しでも想いに共感してくださった方は、ぜひ一度お話ししましょう。経験よりも大切なのは、学び続ける姿勢です。";
  }
  if (d.styleType === "ベンチャー型") {
    return "まずは一度、カジュアルに話しましょう。学歴や経歴ではなく、これからどうなりたいかを聞かせてください。";
  }
  return "未経験の方も、最初は先輩と一緒に進めていくので安心です。少しでも気になった方は、お気軽にご応募ください。";
}

function buildPromptText(d) {
  // 完全版（原文どおり）を返す：フォーム入力値は「→」の行に差し込み。
  // NOTE: ここではユーザーが貼った原文をテンプレ化しており、未入力は空欄のままにします。
  const v = (x) => (x ?? "");
  const vm = (x) => (x ?? "");
  const styleTypeNo = d.styleType === "MVV型" ? "1" : d.styleType === "プレーン型" ? "2" : "3";
  const styleStrengthNo = d.styleStrength === "弱め" ? "1" : d.styleStrength === "標準" ? "2" : "3";

  return `# AirWork求人原稿作成用プロンプト

## 人間入力フォーム＋AI生成指示セット

以下のフォーマットは、AirWork掲載用の求人原稿をAIで作成するための入力フォーム兼プロンプトです。

目的は、AIが勝手に情報を補完せず、人間が入力した事実情報と選択した訴求方針に基づいて、応募につながりやすい求人原稿を作成することです。

---

# 使い方

以下の【STEP1：人間が入力する情報】を埋めてください。

入力方法は2種類あります。

1. 自由記述
   会社名、職種名、給与、勤務地、勤務時間など、正確性が必要な情報を入力します。

2. 番号選択
   ターゲット、訴求軸、不安解消ポイント、文章トーンなどを番号で選びます。
   複数選択可能な項目は、該当する番号をカンマ区切りで入力してください。

その後、【STEP2：AIへの指示】以下を含めてAIに渡してください。

AIは、入力された情報だけをもとにAirWork掲載用の求人原稿を作成してください。

---

# STEP1：人間が入力する情報

## 1. 基本情報

【求人企業名】
例：京商株式会社、株式会社〇〇
→ ${v(d.companyName)}

【求人表示名・店舗名・部署名】
例：京商株式会社 トイホビー事業部、駿河屋ビル
→ ${v(d.displayName)}

【職種名】
例：法人営業、買取査定スタッフ、一般事務、配送ドライバー
→ ${v(d.jobTitle)}

【雇用形態】
例：正社員、アルバイト・パート、業務委託、契約社員
→ ${v(d.employmentType)}

【勤務地住所】
例：東京都中央区日本橋富沢町7-15 2F
→ ${v(d.workAddress)}

【最寄り駅・アクセス】
例：人形町駅から徒歩3分
→ ${v(d.access)}

【転勤の有無】
例：転勤なし、可能性あり、要確認
→ ${v(d.transfer)}

【給与】
例：月給28万5000円〜45万円、時給1,300円〜
→ ${v(d.salary)}

【固定残業代の有無・詳細】
例：固定残業代あり／月2万円・12時間分／超過分別途支給
→ ${v(d.fixedOvertime)}

【賞与・昇給】
例：賞与年2回、昇給あり、業績による
→ ${v(d.bonusRaise)}

【勤務時間】
例：8:45〜17:20、8:00〜17:00
→ ${v(d.workHours)}

【残業時間】
例：月平均20時間以内、ほぼなし、繁忙期あり、要確認
→ ${v(d.overtimeHours)}

【休日休暇】
例：土日祝休み、年間休日124日、週休2日制、シフト制
→ ${v(d.holidays)}

【福利厚生】
例：社会保険完備、交通費支給、住宅手当、退職金、服装自由
→ ${v(d.benefits)}

【試用・研修期間】
例：試用期間3ヶ月／条件同じ
→ ${v(d.trialPeriod)}

---

## 2. 仕事内容に関する事実情報

【主な仕事内容】
なるべく箇条書きで入力してください。
例：
・既存取引先への新商品の提案
・売場づくりの提案
・展示会の運営
・商品状態の確認
・PCでの商品検索
→
${vm(d.mainDuties)}

【扱う商品・サービス】
例：ラジコン、ミニカー、フィギュア、アニメグッズ、食品、住宅設備など
→ ${v(d.productService)}

【仕事で関わる相手】
例：法人バイヤー、問屋、一般のお客様、社内スタッフのみ、ほぼ商品と向き合う
→ ${v(d.stakeholders)}

【新規営業・接客・電話対応・ノルマなどの有無】
事実として正しいものだけ書いてください。
例：新規飛び込みなし、接客なし、電話対応なし、ノルマあり、個人ノルマなし
→ ${v(d.constraints)}

【1日の流れ・業務の流れ】
わかる範囲で入力してください。
例：

1. 商品を受け取る
2. PCで型番を検索
3. キズや付属品を確認
4. システムに登録
   →
${vm(d.dailyFlow)}

【入社後の研修・サポート体制】
例：座学研修あり、OJTあり、マニュアルあり、先輩が隣でサポート
→
${vm(d.training)}

---

## 3. 会社に関する事実情報

【会社の事業内容】
例：ホビー商品の企画・製造・販売、リユース商品の買取・販売
→
${vm(d.business)}

【会社の強み・実績】
数字や事実がある場合のみ入力してください。
例：創業60年以上、世界50カ国以上で展開、業界トップクラス、駅徒歩5分
→
${vm(d.achievements)}

【取引先・顧客層】
例：大手小売店、有名家電量販店、法人顧客、一般消費者
→ ${v(d.clients)}

【職場の雰囲気】
例：穏やか、黙々作業中心、少人数チーム、20代活躍中、中途入社多数
→ ${v(d.atmosphere)}

【チーム人数・年齢層】
例：チーム7名、30代〜40代中心、未経験入社多数
→ ${v(d.team)}

---

## 4. 採用ターゲット選択

この求人で最も応募してほしい人物像を選んでください。
主ターゲットを1つ、必要に応じて副ターゲットを2つまで選んでください。

【主ターゲット番号】
→ ${v(d.targetMain)}

【副ターゲット番号】
→ ${v(d.targetSub)}

1. 未経験から新しい仕事に挑戦したい人
2. 経験を活かして転職したい人
3. 接客・販売・飲食などの対人業務に疲れている人
4. 営業経験はあるが、今の商材に興味を持てていない人
5. 黙々とコツコツ作業する方が得意な人
6. 好きな商品・趣味に関わる仕事がしたい人
7. 安定企業で長く働きたい人
8. 収入を上げたい人
9. 休日や働き方を改善したい人
10. 人間関係のストレスが少ない環境で働きたい人
11. 裁量を持って働きたい人
12. 地元・駅近など通いやすさを重視する人
13. 育児・家庭と両立したい人
14. 正社員として安定したいフリーター・離職中の人
15. キャリアアップ・スキルアップしたい人

---

## 5. メイン訴求軸選択

この求人で一番強く打ち出したい魅力を選んでください。
主訴求を1つ、副訴求を3つまで選んでください。

【主訴求番号】
→ ${v(d.appealMain)}

【副訴求番号】
→ ${v(d.appealSub)}

1. 好きなもの・興味ある商材に関われる
2. 接客なし・電話なし・対人ストレスが少ない
3. 黙々と作業に集中できる
4. 未経験でも始めやすい
5. 経験を正当に活かせる
6. 新規開拓・飛び込みがない
7. 既存顧客中心で関係構築に集中できる
8. 給与が高い・安定収入が得られる
9. 休日が多い・ワークライフバランスが良い
10. フレックス・直行直帰など働き方の自由度が高い
11. 会社の安定性・知名度がある
12. 駅近・通いやすい
13. 髪色・服装など自由度が高い
14. 研修・マニュアル・サポートがある
15. 裁量が大きく、自分の工夫が活かせる
16. ノルマやクレーム対応が少ない
17. 手に職・専門性が身につく
18. 地域密着で働ける
19. チームの雰囲気が良い
20. 入社後のミスマッチが起きにくい仕事のわかりやすさ

---

## 6. 求職者の悩み・本音選択

この求人で代弁したい求職者の悩みを選んでください。
3つまで選択してください。

【選択番号】
→ ${v(d.worries)}

1. 接客やお客様対応に疲れている
2. 電話対応やクレーム対応が苦手
3. 営業ノルマや新規開拓に疲れている
4. 今扱っている商材に興味を持てない
5. 人間関係に気を遣いすぎて疲れている
6. 未経験でも本当にできるか不安
7. 正社員として安定したい
8. 給与を上げたい
9. 休みが少なく、生活リズムを整えたい
10. 自分に向いている仕事がわからない
11. 好きなことを仕事にしたい
12. 今の仕事にやりがいや楽しさを感じにくい
13. 将来のキャリアが見えない
14. 体力的に無理のない仕事をしたい
15. もっと自分のペースで働きたい
16. 細かい作業や確認作業の方が得意
17. 人と話すより、もの・データ・商品と向き合う方が好き
18. これまでの経験を無駄にしたくない
19. 大きすぎる会社より、裁量ある環境で働きたい
20. 長く安心して働ける職場を探している

---

## 7. 事実として必ず入れてよい安心材料

以下のうち、事実として正しいものだけ選んでください。
選択されていないものは、AIは原稿に書いてはいけません。

【選択番号】
→ ${v(d.allowFacts)}

1. 未経験歓迎
2. 業界未経験歓迎
3. 学歴不問
4. ブランクOK
5. 第二新卒歓迎
6. 既存顧客中心
7. 新規飛び込みなし
8. テレアポなし
9. 個人ノルマなし
10. 接客なし
11. 電話対応なし
12. 営業トークなし
13. クレーム対応なし
14. 一人作業が多い
15. 黙々作業が多い
16. マニュアルあり
17. 商品データ・システムあり
18. 研修あり
19. OJTあり
20. 先輩に相談できる
21. 試用期間中も条件同じ
22. 残業月20時間以内
23. 土日祝休み
24. 年間休日120日以上
25. 長期休暇あり
26. フレックス制度あり
27. 直行直帰可能
28. 転勤なし
29. 駅徒歩5分以内
30. 車通勤可
31. 服装自由
32. 髪色自由
33. ピアス・ネイル自由
34. 住宅手当あり
35. 家族手当あり
36. 退職金あり
37. 賞与あり
38. 昇給あり
39. 交通費支給
40. 入社時引越し補助あり

---

## 8. 文体・トーンマナ選択

この求人原稿で使用したい文体を、以下から1つ選択してください。

【文体タイプ番号】
→ ${styleTypeNo}

1. MVV型
2. プレーン型
3. ベンチャー型

---

## 8-1. 文体タイプの説明

### 1. MVV型

ミッション・ビジョン・バリュー、会社の思想、仕事への情熱、目指す世界観を強く打ち出す文体です。

単なる条件訴求ではなく、
「なぜこの仕事をするのか」
「この会社は何を目指しているのか」
「この仕事を通じて、どんな価値を生み出すのか」
を丁寧に伝えます。

求職者に対して、給与や条件だけではなく、会社の想いや仕事の意義に共感してもらうことを目的とします。

#### 向いている求人

* 会社の理念や世界観が強い求人
* 商品・サービスへの愛情やこだわりが重要な求人
* 職人性、専門性、探求心が求められる求人
* ブランドやプロダクトに熱量がある求人
* 「好き」を仕事にする求人
* 採用数よりも、カルチャーフィットを重視したい求人
* 長く一緒に会社を作っていく仲間を採用したい求人

#### 刺さりやすい求職者

* 仕事に意味や使命感を求める人
* 好きなことを深く追求したい人
* 専門性や技術を極めたい人
* 会社の理念に共感して働きたい人
* 自己実現や成長意欲がある人
* 単なる作業ではなく、価値ある仕事がしたい人

#### 文体の特徴

* 情緒的・物語的な表現を使う
* 「私たち」「一緒に」「目指す」「挑戦」「探求」「極める」などの言葉を使う
* 会社の歴史や実績を、未来への挑戦につなげる
* 仕事内容を「作業」ではなく「価値を生む行為」として描く
* 求職者を単なる労働力ではなく、未来を一緒につくる仲間として扱う
* やや長めの文章でもよい
* 冒頭に世界観・思想・ビジョンを入れる

#### よく使う表現

* 私たちが目指しているのは、〇〇です
* この仕事は、単なる〇〇ではありません
* 〇〇を通じて、私たちは□□を届けています
* 一つのことを突き詰めることに喜びを感じる方へ
* あなたの探求心が、次の〇〇をつくります
* まだ世の中にない〇〇を、一緒に生み出しませんか
* 本気でワクワクできる仕事に挑戦しませんか
* 私たちは、〇〇な仲間を求めています

#### 避けるべきこと

* 理念だけで終わり、仕事内容が曖昧になること
* 情熱的すぎて、実態より誇張した表現になること
* 給与・休日・勤務条件の説明が薄くなること
* 誰にでも刺さるようにしすぎて、思想がぼやけること

---

### 2. プレーン型

条件・仕事内容・働きやすさ・安心材料を、淡々とわかりやすく伝える文体です。

情緒的な表現や強い煽りは抑え、
「何をする仕事か」
「どんな環境か」
「なぜ未経験でもできるのか」
「なぜ長く働きやすいのか」
を事実ベースで整理します。

幅広い求職者に受け入れられやすく、応募ハードルを下げやすい文体です。

#### 向いている求人

* 清掃、軽作業、事務、物流、施設管理などの求人
* 年齢層を広く採用したい求人
* 未経験歓迎の求人
* 安定・定時・屋内・体力負担少なめなどが魅力の求人
* 強いキャラ付けよりも、安心感を優先したい求人
* 応募数を広く集めたい求人
* 求人内容に大きなクセがない求人

#### 刺さりやすい求職者

* 安定して働きたい人
* 仕事内容を事前にしっかり知りたい人
* 未経験で不安がある人
* 無理なく長く働きたい人
* 年齢や経験に不安がある人
* 強い熱量よりも、安心材料を重視する人
* 落ち着いた職場を探している人

#### 文体の特徴

* わかりやすく、簡潔で、事実ベース
* 強すぎるキャッチコピーや煽り表現を避ける
* 「なぜ安心か」「なぜ働きやすいか」を理由付きで説明する
* 箇条書きや番号を多めに使い、スマホで読みやすくする
* 業務内容を具体的に分解する
* 条件面・職場環境・研修体制を丁寧に書く
* 求職者が不安に思う点を一つずつ消す

#### よく使う表現

* この求人のポイント
* 未経験の方も安心して始められます
* いきなり一人で任せることはありません
* 担当範囲と手順が決まっているため、進めやすい仕事です
* 屋内業務のため、天候に左右されにくい環境です
* 重いものを運ぶ作業は少なめです
* 生活リズムを整えながら、無理なく働けます
* 長く続けやすい環境を整えています

#### 避けるべきこと

* 熱量を出しすぎること
* 「人生を変える」「本気で挑戦」など、強すぎる表現
* 会社の理念を長く語りすぎること
* 条件や業務内容より感情訴求が先行すること
* 誇張した高収入訴求
* ベンチャー的な勢いのある表現

---

### 3. ベンチャー型

成長、挑戦、稼ぐ力、キャリアアップ、代表直下、人生を変えるきっかけなどを強く打ち出す文体です。

求職者の現状への不満や燻り感を代弁し、
「ここに来れば変われる」
「本気ならチャンスを渡す」
「稼ぎながら成長できる」
というメッセージで背中を押します。

熱量が高く、やや尖った表現も使います。
応募数を増やすだけでなく、上昇志向のある人を惹きつけることが目的です。

#### 向いている求人

* ベンチャー企業の求人
* 営業職、買取営業、広告営業、人材営業など成果が収入に反映される求人
* 若手未経験を採用したい求人
* 稼げる理由やキャリアアップが明確な求人
* 代表直下、幹部候補、事業責任者候補の求人
* 独立・起業志向の人を採りたい求人
* 学歴・経歴より本気度や人柄を見たい求人
* 応募者に一定の覚悟や熱量を求める求人

#### 刺さりやすい求職者

* 今の自分に満足していない人
* 学歴や経歴に自信はないが、見返したい気持ちがある人
* 稼ぎたい人
* 早くキャリアアップしたい人
* 独立・起業を考えている人
* ベンチャー企業で裁量を持って働きたい人
* 代表や経営陣の近くで学びたい人
* 普通の会社員で終わりたくない人

#### 文体の特徴

* 熱量高め
* 語りかけるような表現を使う
* 「正直に言います」「全部話します」など、透明性のある言い方を使う
* 求職者の現状への不満を強く代弁する
* 会社の成長率、年商、離職率、給与実績など具体的な数字を見せる
* 高収入やキャリアアップの理由を必ず説明する
* 代表メッセージや社員インタビューとの相性が良い
* 「楽ではないが、得られるものが大きい」という正直さを入れる

#### よく使う表現

* 今、何者でもないあなたへ
* 正直に言います
* 今の仕事に燻っていませんか？
* 自分にはもっとできるはずだと思っていませんか？
* 学歴や過去の実績ではなく、本気度で見ます
* 本気の人には、どんどん仕事を任せます
* なぜ未経験でも稼げるのか、理由を説明します
* 稼げる仕組みがちゃんとあります
* ただし、決して楽な仕事ではありません
* 人生を変えるきっかけを、本気で渡します
* まずは一度、カジュアルに話しましょう

#### 避けるべきこと

* 根拠のない高収入表現
* 稼げる理由を説明しないこと
* 煽りすぎて怪しく見えること
* きつさや努力が必要な点を隠すこと
* 会社の実績や制度がないのにベンチャー感だけ出すこと
* 全員に向けた無難な文章にしてしまうこと

---

# 8-2. 文体の強度選択

選択した文体を、どの程度強く出すかを選んでください。

【文体強度番号】
→ ${styleStrengthNo}

1. 弱め
2. 標準
3. 強め

---

## 8-4. 求人で特に出したい雰囲気

文体タイプに加えて、必要に応じて雰囲気を選択してください。
最大2つまで選択可能です。

【選択番号】
→ ${v(d.vibeWant)}

1. 情熱的
2. 誠実
3. 落ち着いた
4. やさしい
5. 力強い
6. 透明性がある
7. 高級感がある
8. 親しみやすい
9. スピード感がある
10. 堅実
11. ワクワク感がある
12. 職人気質
13. 挑戦的
14. 安心感重視
15. 数字・実績重視

---

## 8-5. 求人で避けたい雰囲気

この求人で避けたい雰囲気を選択してください。
最大3つまで選択可能です。

【選択番号】
→ ${v(d.vibeAvoid)}

1. 煽りすぎ
2. 怪しい高収入求人に見える
3. 体育会系すぎる
4. 意識高い系すぎる
5. 情緒的すぎる
6. 淡々としすぎる
7. 軽すぎる
8. 硬すぎる
9. 若者向けすぎる
10. 年配向けすぎる
11. 会社理念が強すぎる
12. 条件訴求が弱すぎる
13. 仕事内容が抽象的すぎる
14. 誰にでも向けすぎてぼやける
15. 強い言葉で応募者を選別しすぎる

---

## 9. 応募方針選択

応募数とマッチ度のバランスを選んでください。

【選択番号】
→ ${v(d.applyPolicy)}

1. 応募数を最大化したい
2. 応募数よりもマッチ度を重視したい
3. 応募数とマッチ度のバランスを取りたい

---

## 10. キャッチコピーの方向性選択

求人冒頭のキャッチコピーの方向性を選んでください。
1つ選択してください。迷う場合はAIが最適なものを選んでください。

【選択番号】
→ ${v(d.catchDirection)}

1. 求職者の悩みを代弁する
   例：接客に疲れたあなたへ。

2. 好きなものを仕事にする魅力を打ち出す
   例：「好きなもの」を売る営業は、こんなにも強い。

3. 経験を肯定する
   例：その営業経験、もっと好きになれる商材で活かしませんか？

4. 働き方・条件の良さを打ち出す
   例：年間休日120日以上。無理なく長く続けられる仕事です。

5. 転職後の変化を打ち出す
   例：人と話す毎日から、コツコツ集中できる毎日へ。

6. 安定性を打ち出す
   例：業界トップクラスの安定企業で、腰を据えて働く。

7. 未経験からの挑戦を打ち出す
   例：知識ゼロから、安心して始められる正社員の仕事。

8. AIに最適な方向性を選ばせる

---

## 11. 入れてはいけない表現・注意点

【避けたい表現】
例：誰とも話さない、という表現は強すぎるので避けたい／男性限定に見える表現は避けたい
→
${vm(d.avoidPhrases)}

【事実として言い切れないこと】
例：ノルマなしは不明、残業時間は未確認、トップクラス表現は避けたい
→
${vm(d.cannotAssert)}

【その他注意点】
→

---

# STEP2：AIへの指示

ここから下は、AIに対する指示です。
あなたは、プロの広告マーケター兼採用ライターです。
上記の入力情報をもとに、AirWork掲載用の求人原稿を作成してください。

---

## 最重要ルール

1. 入力されていない事実を勝手に補完しないでください。
2. 番号選択されていない安心材料は、原稿内で使用しないでください。
3. 給与、休日、勤務地、勤務時間、福利厚生、会社実績は、入力された情報だけを使ってください。
4. 不明な情報は断定せず、【要確認】と記載してください。
5. 「業界トップクラス」「安定企業」「未経験歓迎」「ノルマなし」「接客なし」「電話対応なし」「残業少なめ」などは、入力情報または番号選択がある場合のみ使用してください。
6. 求人原稿は、企業目線ではなく求職者目線で作成してください。
7. 求職者の悩みや願望を冒頭で言語化してください。
8. 仕事内容は、抽象的にせず、行動単位で具体化してください。
9. 会社の強みは、求職者にとってのメリットに変換してください。
10. 最後は応募ハードルを下げる文章で締めてください。

---

## 原稿作成の基本思想

この求人では、職種そのものを売るのではなく、求職者にとっての「転職後の変化」を売ってください。

例えば、営業職の場合は、

悪い例：
法人営業スタッフを募集します。

良い例：
その営業経験、もっと好きになれる商材で活かしませんか？
新規開拓に追われる営業ではなく、長年のお客様と関係を築きながら提案できる仕事です。

作業職の場合は、

悪い例：
買取査定スタッフを募集します。

良い例：
接客に疲れたあなたへ。
この仕事は、お客様対応なし・電話対応なし。好きな商品に囲まれながら、黙々と作業に集中できる仕事です。

必ず、選択されたターゲット・訴求軸・悩みに合わせて、求職者が「これは自分のことかも」と感じる原稿にしてください。

---

# STEP2追加指示：AIへの文体反映ルール

AIは求人原稿を作成する際、選択された文体タイプに応じて、以下のルールを必ず守ってください。

---

## 1. 文体タイプを原稿全体に反映すること

選択された文体は、冒頭コピーだけでなく、以下すべてに反映してください。

* 求人キャッチコピー
* 冒頭導入文
* 求人point
* 会社概要
* 業務内容
* 働く魅力
* こんな方におすすめ
* 応募導線
* 原稿作成上の狙い

ただし、給与・勤務地・勤務時間・休日・福利厚生などの事実情報は、文体によって内容を変えず、入力情報どおりに記載してください。

---

## 2. 文体タイプ別に、求職者への呼びかけ方を変えること

### MVV型の場合

求職者を「会社の未来を一緒につくる仲間」として扱ってください。

使うべき方向性：

* 共感
* 探求
* 使命
* 技術
* こだわり
* 世界観
* 好きなことを極める

避ける方向性：

* 過度な高収入アピール
* 短期的な稼ぎ訴求
* 軽すぎる表現
* 煽りすぎる表現

---

### プレーン型の場合

求職者を「安心して働ける職場を探している人」として扱ってください。

使うべき方向性：

* 安心
* 具体性
* わかりやすさ
* 無理なく続けられる
* 研修
* 手順
* 定時
* 屋内
* 働きやすさ

避ける方向性：

* 熱すぎる理念訴求
* 人生を変える系の表現
* 稼げることを強く煽る表現
* ベンチャー感の強い表現
* 情緒的すぎる長文

---

### ベンチャー型の場合

求職者を「今の自分を変えたい人」「本気で稼ぎたい人」「早く成長したい人」として扱ってください。

使うべき方向性：

* 挑戦
* 変化
* 本気度
* 稼ぐ力
* 成長
* 代表直下
* キャリアアップ
* 独立
* 人生のきっかけ
* 透明性

避ける方向性：

* 根拠のない高収入アピール
* 怪しいほどの煽り
* きつさを隠す表現
* 誰にでも合うような無難すぎる表現
* 会社の実績がないのに成長企業と断定すること

---

## 3. 同じ事実でも、文体によって表現を変えること

以下のように、同じ求人情報でも文体によって見せ方を変えてください。

---

### 例：未経験歓迎

#### MVV型

未経験でも大丈夫です。
大切なのは、経験よりも「学び続けたい」という姿勢と、この仕事に本気で向き合う情熱です。

#### プレーン型

未経験の方も歓迎します。
入社後は研修と先輩のサポートがあるため、基礎から順番に覚えられます。

#### ベンチャー型

学歴も経験も問いません。
これまでよりも、これから本気で変わりたいかを見ています。

---

### 例：給与が高い

#### MVV型

日々の努力や技術の習得を、待遇面でもきちんと還元できる環境を整えています。

#### プレーン型

月給〇万円からスタートできます。
安定した収入を得ながら、長く働ける環境です。

#### ベンチャー型

初年度から月収〇万円を目指せる理由があります。
仕組みとチーム体制があるから、未経験でも収入を伸ばしやすい環境です。

---

### 例：残業が少ない

#### MVV型

仕事に本気で向き合うためにも、休む時間を大切にしています。
メリハリをつけて働ける環境です。

#### プレーン型

残業は月平均〇時間程度です。
勤務時間内に業務が終わるよう、担当範囲や手順を整えています。

#### ベンチャー型

稼げる環境でありながら、残業はほとんどありません。
成果を出すために、無駄な長時間労働はさせない設計です。

---

### 例：好きな商材に関われる

#### MVV型

好きという気持ちは、仕事に向き合ううえで大きな力になります。
その情熱が、商品やサービスの価値をさらに高めていきます。

#### プレーン型

〇〇が好きな方にとっては、興味のある商品に関わりながら働ける環境です。

#### ベンチャー型

好きなものに関わりながら、しっかり稼ぐ力も身につけられます。
ただの趣味で終わらせず、仕事として成果につなげていける環境です。

---

### 例：会社の成長性

#### MVV型

私たちは、〇〇という実績に満足せず、さらに高い目標に挑戦し続けています。

#### プレーン型

〇〇事業を中心に、安定した運営を続けています。
長く働きたい方にも安心していただける環境です。

#### ベンチャー型

今まさに事業が伸びているフェーズです。
だからこそ、これから入る人にも大きなポジションを任せるチャンスがあります。

---

# STEP2追加指示：文体選択後の最終チェック

求人原稿を出力した後、最後に以下を必ず記載してください。

---

## 文体反映チェック

【選択された文体】
例：MVV型／プレーン型／ベンチャー型

【文体強度】
例：標準

【この文体を反映した箇所】
・冒頭コピー
・会社概要
・働く魅力
・応募導線
など

【文体上、あえて避けた表現】
例：プレーン型のため、「人生を変える」「本気で挑戦」などの強い表現は避けました。
例：ベンチャー型ですが、怪しい高収入求人に見えないよう、稼げる理由を説明する構成にしました。
例：MVV型ですが、理念だけで終わらないよう、業務内容を具体的に記載しました。

---

# 3文体の使い分け早見表

## MVV型を選ぶべき求人

* 会社の理念や世界観が強い
* 商品やサービスに独自性がある
* 採用したい人に情熱や探求心を求める
* 条件だけで比較されたくない
* カルチャーフィットを重視したい
* 求人自体をブランド発信にしたい

## プレーン型を選ぶべき求人

* 幅広い層から応募がほしい
* 仕事内容をわかりやすく伝えることが重要
* 未経験者の不安を下げたい
* 年齢層を広く採用したい
* 安定・定時・屋内・負担少なめなどが魅力
* 強い思想や熱量よりも、安心感で応募を取りたい

## ベンチャー型を選ぶべき求人

* 若手・未経験を採用したい
* 稼ぎたい人を採用したい
* 上昇志向や独立志向のある人を採りたい
* 代表直下や幹部候補の求人
* 会社の成長性を強く打ち出したい
* 応募者に一定の覚悟や熱量を求めたい

---

# 注意事項

文体は、求人の中身と必ず一致させてください。

例えば、以下のような使い方は避けてください。

* 実際には裁量が少ないのに、ベンチャー型で「大きな裁量」と書く
* 会社の理念が明確でないのに、MVV型で思想を作り込む
* 高収入の根拠がないのに、ベンチャー型で稼げると強く打ち出す
* 業務が複雑なのに、プレーン型で「簡単」と書きすぎる
* 忙しい現場なのに、安心感だけを強調して負荷を隠す

文体はあくまで見せ方であり、事実を変えてはいけません。
入力された事実を、選択された文体に合わせて適切に表現してください。

---

# 出力形式

以下の順番で出力してください。

---

## 1. 求人キャッチコピー

AirWorkの求人タイトル・冒頭に使えるキャッチコピーを作成してください。

以下を出力してください。

【推奨キャッチコピー】
1本

【代替キャッチコピー】
2本

条件：

* 1文〜2文で作成
* 職種名だけで終わらせない
* 選択されたターゲット・訴求軸に合わせる
* 求職者の悩み、願望、転職後の変化が伝わるようにする
* 事実として確認できない情報は入れない

---

## 2. お仕事について／仕事内容

AirWorkの「仕事内容」欄にそのまま貼れる本文を作成してください。

以下の構成で作成してください。

---

### 2-1. 冒頭コピー

最初に、求職者の感情に刺さる導入文を入れてください。

いきなり会社説明から入らないでください。
選択されたターゲット、悩み、訴求軸をもとに、求職者の本音を代弁してください。

---

### 2-2. 求人point

✅を使って、求人の魅力を6〜8個に整理してください。

ただし、選択されていない事実は入れないでください。

例：

✅ 未経験歓迎！マニュアル・研修完備で安心スタート
✅ 接客なし・電話対応なし。黙々と作業に集中できる環境
✅ 既存顧客中心／新規飛び込み営業はありません
✅ 年間休日120日以上。無理なく長く働ける環境
✅ 好きな商品・サービスに関わりながら働ける仕事
✅ 業界トップクラスの安定企業で、腰を据えて働けます

---

### 2-3. 求職者の本音を代弁する段落

選択された「求職者の悩み・本音」をもとに、求職者が感じていそうなことを自然な文章で書いてください。

例：

「今の営業商材に、正直あまり興味が持てない」
「でも、これまで積み上げた営業経験は活かしたい」
「できれば、好きなものに関わりながら、長く働ける仕事がしたい」

または、

「接客が苦手で、毎日のコミュニケーションに疲れてしまった」
「電話対応やクレーム対応のプレッシャーから解放されたい」
「人と話すより、コツコツ作業に集中できる仕事がしたい」

---

### 2-4. この仕事ならどう変わるか

次に、この求人が求職者の悩みをどう解決するのかを書いてください。

仕事内容をそのまま説明するのではなく、求職者にとってのメリットに変換してください。

例：

* 接客が苦手な人に対して
  → 接客なし・電話なしで、自分のペースで働ける

* 営業経験者に対して
  → 飛び込みではなく、既存顧客との関係構築に集中できる

* 好きなものを仕事にしたい人に対して
  → 商材への興味が、提案力や日々の楽しさにつながる

* 未経験で不安な人に対して
  → 研修やマニュアルがあるため、知識ゼロからでも始められる

---

### 2-5. 会社概要

会社概要を作成してください。

ただし、単なる会社紹介にしないでください。
会社の事実情報を、求職者にとっての安心材料・魅力に変換してください。

例：

悪い例：
当社は創業60年の会社です。

良い例：
当社は創業60年以上の歴史を持ち、大手企業との取引も多数あります。長年の信頼関係があるため、新規開拓に追われるのではなく、既存のお客様とじっくり関係を築きながら提案できる環境です。

会社実績が入力されていない場合は、無理に会社の安定性を強調しないでください。

---

### 2-6. 業務内容

業務内容は、実際の行動がイメージできるように具体的に書いてください。

営業職の場合は、以下を意識してください。

* 誰に提案するのか
* 何を提案するのか
* 新規営業か既存営業か
* 飛び込み・テレアポの有無
* 提案内容
* 取引先との関係性
* 裁量の範囲
* 入社後の流れ

作業職・事務職の場合は、以下を意識してください。

* 1日の業務の流れ
* 使うツール
* チェックする内容
* 作業のステップ
* 人とのやり取りの有無
* 未経験でもできる理由
* 慣れるまでのサポート

可能であれば、以下のようにステップ形式で書いてください。

＜業務の流れ＞
▼ 〇〇を確認
▼ 〇〇を入力・チェック
▼ 〇〇を判断
▼ 〇〇を登録・報告
→ この流れを繰り返しながら、少しずつ業務に慣れていきます。

---

### 2-7. この仕事ならではの働きがい

仕事の魅力を3つに整理してください。

見出しは、求職者メリットが伝わるものにしてください。

例：

①「好き」が仕事の武器になる
②これまでの経験を、正当に活かせる
③無理なく長く続けられる働き方がある

または、

①接客ストレスから解放される
②未経験でも安心して始められる
③好きなものに囲まれて働ける

それぞれの見出しの下に、3〜5行程度で説明を入れてください。

---

### 2-8. 未経験者・経験者への安心材料

選択されたターゲットに合わせて、応募前の不安を解消してください。

未経験者向けの場合は、以下を意識してください。

* 知識がなくても始められる理由
* 研修・マニュアル・データベースの有無
* 先輩に相談できる環境
* 最初に任せる業務
* 徐々に覚えればよいこと
* 試用期間中の条件

経験者向けの場合は、以下を意識してください。

* これまでの経験がどう活きるか
* 業界経験が不問かどうか
* 裁量の大きさ
* 評価されるスキル
* 既存顧客中心・飛び込みなしなどの営業スタイル
* 入社後のキャッチアップ方法

ただし、入力情報にない安心材料は書かないでください。

---

### 2-9. こんな方におすすめ

以下の形式で作成してください。

＼こんな方におすすめ／
✓ 〇〇に疲れている方
✓ 〇〇な環境で働きたい方
✓ 〇〇が好きな方
✓ 〇〇よりも、〇〇の方が得意な方
✓ 〇〇を活かして働きたい方
✓ 安定した会社で、長く働きたい方

企業目線の「こういう人が欲しい」ではなく、求職者目線の「こういう人には合っている」という表現にしてください。

---

### 2-10. 応募導線

最後は、応募ハードルを下げる文章で締めてください。

例：

少しでも「これ、自分に合っているかも」と感じた方は、ぜひ一度お話ししてみませんか？
まずは話を聞いてみたい、というだけでも大歓迎です。
お気軽にご応募ください。

または、

今の働き方を少し変えたい。
そんな気持ちがある方にこそ、知ってほしい仕事です。
まずはお気軽にご応募ください。

---

## 3. 求める人材

AirWorkの「求める人材」欄を作成してください。

以下の構成にしてください。

【必須条件】
・〇〇
・〇〇

【歓迎条件】
・〇〇
・〇〇

【こんな方が活躍できます】
◎ 〇〇な方
◎ 〇〇を大切にできる方
◎ 〇〇に興味がある方
◎ 〇〇な働き方をしたい方

注意点：

* 必須条件は増やしすぎない
* 入力された必須条件以外を勝手に追加しない
* 未経験歓迎の場合は、応募ハードルを下げる
* 経験者募集の場合は、経験がどう活きるかを書く
* 「明るく元気な方」など曖昧な表現だけで終わらせない

---

## 4. スキル・経験・資格

AirWorkの項目に合わせて、該当しそうなキーワードを整理してください。

ただし、入力情報から明らかに関連するものだけにしてください。

【スキル】
・〇〇
・〇〇

【経験】
・〇〇
・〇〇

【資格】
・〇〇
・〇〇

---

## 5. 勤務地

入力された情報をもとに、AirWorkの「勤務地」欄を整理してください。

以下を含めてください。

* 勤務地名
* 住所
* 最寄り駅
* アクセス
* 転勤の有無
* 車通勤・自転車通勤の可否
* 直行直帰の可否

入力がないものは書かないでください。

---

## 6. 給与

入力された情報をもとに、AirWorkの「給与」欄を整理してください。

以下を含めてください。

* 月給または時給
* 基本給
* 固定残業代の有無
* 固定残業時間
* 超過分支給の有無
* 賞与
* 昇給
* 手当
* 試用期間中の給与
* 給与例

入力がないものは推測で書かないでください。

---

## 7. 勤務時間

入力された情報をもとに、AirWorkの「勤務時間」欄を作成してください。

以下を含めてください。

* 勤務形態
* 勤務時間
* 実働時間
* 休憩時間
* 残業時間
* フレックスの有無
* シフト制の場合はシフト例
* 直行直帰の可否

---

## 8. 休日休暇

入力された情報をもとに、AirWorkの「休日休暇」欄を作成してください。

以下を含めてください。

* 休日制度
* 年間休日数
* 土日祝休みの有無
* 週休2日制／完全週休2日制
* 有給休暇
* 年末年始休暇
* 慶弔休暇
* 産前産後休暇
* 育児休暇
* 介護休暇
* 特別休暇
* 休日出勤がある場合の代休取得

---

## 9. 社会保険・福利厚生

入力された情報をもとに、AirWorkの「社会保険／福利厚生」欄を作成してください。

入力されていない制度は書かないでください。

---

## 10. 職場環境

入力された情報をもとに、AirWorkの「職場環境」欄を作成してください。

以下を意識してください。

* 職場の雰囲気
* チーム人数
* 年齢層
* 未経験者の割合
* 中途入社者の割合
* 1人作業が多いか
* お客様対応が多いか少ないか
* 教育体制
* 相談しやすさ
* 静かな環境か、活気ある環境か
* 服装や髪色の自由度

入力情報にないことは書かないでください。

---

## 11. 試用・研修期間

入力された情報をもとに、AirWorkの「試用・研修期間」欄を作成してください。

以下を含めてください。

* 試用期間の長さ
* 試用期間中の条件
* 研修内容
* 入社後の流れ

---

## 12. この求人で刺しているターゲット

最後に、作成した原稿がどのターゲットに刺さる設計なのかを簡潔に説明してください。

例：

この原稿では、接客や電話対応に疲れている方に対して、「対人ストレスが少なく、黙々と働ける環境」を前面に出しています。
また、好きなホビー商品に囲まれて働ける点を加えることで、単なる作業職ではなく、日々の楽しさも感じられる求人として設計しています。

---

## 13. 原稿作成上の狙い

最後に、原稿の狙いを3点で説明してください。

例：

1. 冒頭で求職者の悩みを代弁し、自分ごと化を促す
2. 仕事内容をステップ化し、未経験者の不安を下げる
3. 給与・勤務地・会社の安定性を見せ、応募前の安心感を高める

---

# 表現上の注意

以下の表現は、入力情報に明確な根拠がある場合のみ使用してください。

* 誰とも話さなくていい
* 接客ゼロ
* 電話対応なし
* ノルマなし
* 残業ほぼなし
* 業界トップクラス
* 安定企業
* 未経験歓迎
* 研修完備
* 完全週休2日制
* 年間休日120日以上
* 高収入
* 裁量が大きい
* 自由に働ける
* 人間関係が良い

根拠がない場合は、以下のような柔らかい表現にしてください。

* 接客対応は少なめです
* 電話対応は限定的です
* 基本は一人で進める作業が中心です
* 落ち着いて作業しやすい環境です
* 先輩に確認しながら進められます
* 長く働きやすい制度があります

---

# 最終チェック

原稿作成後、最後に以下のチェックリストを出してください。

【事実確認が必要な項目】
・〇〇
・〇〇

【入力情報だけで作成できた項目】
・〇〇
・〇〇

【AIが推測で書かなかった項目】
・〇〇
・〇〇

---

## 文体反映チェック

【選択された文体】
例：${v(d.styleType)}

【文体強度】
例：${v(d.styleStrength)}

【この文体を反映した箇所】
・冒頭コピー
・会社概要
・働く魅力
・応募導線
など

【文体上、あえて避けた表現】
例：プレーン型のため、「人生を変える」「本気で挑戦」などの強い表現は避けました。
例：ベンチャー型ですが、怪しい高収入求人に見えないよう、稼げる理由を説明する構成にしました。
例：MVV型ですが、理念だけで終わらないよう、業務内容を具体的に記載しました。
`;
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  setExportNote("コピーしました。");
  setTimeout(() => setExportNote(""), 1800);
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setExportNote(`${filename} を保存しました。`);
  setTimeout(() => setExportNote(""), 2200);
}

function downloadJson(filename, obj) {
  downloadText(filename, JSON.stringify(obj, null, 2));
}

async function readJsonFile(file) {
  const text = await file.text();
  return JSON.parse(text);
}

function setGenerated(meta, body) {
  const metaEl = document.getElementById("genMeta");
  const bodyEl = document.getElementById("genBody");
  if (metaEl) metaEl.textContent = meta ?? "";
  if (bodyEl) bodyEl.textContent = body ?? "";
}

async function generateJobPostWithAI(promptText) {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) throw new Error("APIキー未設定（右上の「設定」から保存してください）");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.6,
      messages: [{ role: "user", content: promptText }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error: HTTP ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  return String(content || "").trim();
}

function toMarkdownFromPreview(d) {
  const title = buildCatchCopy(d);
  const body = $("prevBody").innerText;
  const md = [];
  md.push(`# ${title}`);
  md.push("");
  md.push(`- 企業: ${d.companyName || ""}`);
  md.push(`- 職種: ${d.jobTitle || ""}`);
  md.push(`- 文体: ${d.styleType}／${d.styleStrength}`);
  md.push("");
  md.push(body);
  md.push("");
  return md.join("\n");
}

function setActiveTab(tabId, paneId) {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("is-active", t.id === tabId);
  for (const p of document.querySelectorAll(".tabpane")) p.classList.toggle("is-active", p.id === paneId);
}

let currentId = uuid();
let currentSavedAt = null;

function newDraft() {
  currentId = uuid();
  currentSavedAt = null;
  writeForm({
    id: currentId,
    styleType: "MVV型",
    styleStrength: "標準",
  });
  setExportNote("新規ドラフトを作成しました。");
  setTimeout(() => setExportNote(""), 1500);
  renderPreview(readForm());
}

function loadDraft(id) {
  const it = getHistory().find((x) => x.id === id);
  if (!it) return;
  currentId = it.id;
  currentSavedAt = it.savedAt || it.updatedAt || null;
  writeForm(it);
  // Restore generated result if present
  if (typeof it.generatedText === "string") {
    // These are captured in init() closure variables as well; update DOM directly here.
    const meta = it.generatedAt ? `生成済み: ${new Date(it.generatedAt).toLocaleString()}` : "生成済み";
    setGenerated(meta, it.generatedText || "");
  } else {
    setGenerated("未生成", "ここに生成結果が表示されます。");
  }
  renderPreview(readForm());
  setExportNote("履歴から読み込みました。");
  setTimeout(() => setExportNote(""), 1500);
}

function duplicateDraft(id) {
  const it = getHistory().find((x) => x.id === id);
  if (!it) return;
  const dup = { ...it, id: uuid(), savedAt: null, updatedAt: nowIso() };
  currentId = dup.id;
  currentSavedAt = null;
  writeForm(dup);
  renderPreview(readForm());
  setExportNote("複製しました（未保存）。");
  setTimeout(() => setExportNote(""), 1500);
}

function init() {
  // Tabs
  $("tabBasic").addEventListener("click", () => setActiveTab("tabBasic", "paneBasic"));
  $("tabStyle").addEventListener("click", () => setActiveTab("tabStyle", "paneStyle"));
  $("tabOptions").addEventListener("click", () => setActiveTab("tabOptions", "paneOptions"));

  bindSegmented("#styleType", () => renderPreview(readForm()));
  bindSegmented("#styleStrength", () => renderPreview(readForm()));

  // Form live preview
  const inputs = document.querySelectorAll("input, textarea");
  let autosaveTimer = null;
  const scheduleAutosave = () => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      const d = readForm();
      setAutosave({ ...d, id: currentId, savedAt: currentSavedAt, autosavedAt: nowIso() });
    }, 700);
  };

  for (const el of inputs) {
    el.addEventListener("input", () => {
      renderPreview(readForm());
      scheduleAutosave();
    });
  }

  $("btnSave").addEventListener("click", () => {
    const d = readForm();
    const saved = { ...d, id: currentId, savedAt: currentSavedAt || nowIso(), updatedAt: nowIso() };
    currentSavedAt = saved.savedAt;
    upsertHistory(saved);
    clearAutosave();
    setExportNote("履歴に保存しました。");
    setTimeout(() => setExportNote(""), 1500);
  });

  $("btnNew").addEventListener("click", () => newDraft());

  $("historyList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === "load") loadDraft(id);
    if (action === "dup") duplicateDraft(id);
    if (action === "del") removeHistory(id);
  });

  $("btnCopyPost").addEventListener("click", async () => {
    const text = $("prevBody").innerText;
    await copyText(text);
  });

  $("btnCopyPrompt").addEventListener("click", () => {
    const d = readForm();
    $("promptText").value = buildPromptText(d);
    $("modalPrompt").showModal();
  });
  $("btnCopyPrompt2").addEventListener("click", async () => {
    await copyText($("promptText").value);
  });

  // AI generate (job post)
  let generatedText = "";
  let generatedAtIso = "";

  const refreshGenerated = () => {
    const meta = generatedAtIso ? `生成済み: ${new Date(generatedAtIso).toLocaleString()}` : "未生成";
    setGenerated(meta, generatedText || "ここに生成結果が表示されます。");
  };
  refreshGenerated();

  $("btnGenerateAi").addEventListener("click", async () => {
    const d = readForm();
    const promptText = buildPromptText(d);
    setExportNote("AI生成中…（数秒〜）");
    try {
      const out = await generateJobPostWithAI(promptText);
      generatedText = out;
      generatedAtIso = new Date().toISOString();
      refreshGenerated();

      // Save into history as well (non-destructive)
      const saved = {
        ...d,
        id: currentId,
        savedAt: currentSavedAt || nowIso(),
        updatedAt: nowIso(),
        generatedText,
        generatedAt: generatedAtIso,
      };
      currentSavedAt = saved.savedAt;
      upsertHistory(saved);

      setExportNote("生成完了（履歴にも保存しました）");
      setTimeout(() => setExportNote(""), 2200);
    } catch (e) {
      setExportNote(`生成失敗: ${e?.message || "不明なエラー"}`);
      setTimeout(() => setExportNote(""), 3500);
    }
  });

  $("btnCopyGenerated").addEventListener("click", async () => {
    if (!generatedText) {
      setExportNote("まだ生成結果がありません");
      setTimeout(() => setExportNote(""), 1500);
      return;
    }
    await copyText(generatedText);
  });

  // Import from URL / Paste
  const importOnlyEmpty = () => Boolean(document.getElementById("importOnlyEmpty")?.checked);

  $("btnImportPaste").addEventListener("click", () => {
    setPasteNote("");
    $("modalPaste").showModal();
  });
  $("btnClearPaste").addEventListener("click", () => {
    $("pasteText").value = "";
    setPasteNote("クリアしました");
    setTimeout(() => setPasteNote(""), 1000);
  });
  $("btnExtractPaste").addEventListener("click", () => {
    const raw = $("pasteText").value;
    if (!raw.trim()) {
      setPasteNote("貼り付け内容が空です");
      return;
    }
    const extracted = extractFromText(stripHtmlToText(raw));
    applyImportedFields(extracted, { onlyEmpty: importOnlyEmpty() });
    renderPreview(readForm());
    setPasteNote("抽出してフォームに反映しました");
    setTimeout(() => setPasteNote(""), 1500);
  });

  $("btnExtractPasteAi").addEventListener("click", async () => {
    const raw = $("pasteText").value;
    if (!raw.trim()) {
      setPasteNote("貼り付け内容が空です");
      return;
    }
    setPasteNote("AIで抽出中…");
    try {
      const text = normalizeText(stripHtmlToText(raw));
      const extracted = await aiExtractFieldsFromText(text);
      applyImportedFields(extracted, { onlyEmpty: importOnlyEmpty() });
      renderPreview(readForm());
      setPasteNote("AI抽出してフォームに反映しました");
      setTimeout(() => setPasteNote(""), 1800);
    } catch (e) {
      setPasteNote(`AI抽出に失敗: ${e?.message || "不明なエラー"}`);
      setTimeout(() => setPasteNote(""), 3500);
    }
  });

  $("btnImportUrl").addEventListener("click", async () => {
    const url = ($("jobUrl").value || "").trim();
    if (!url) {
      setImportNote("URLが空です");
      return;
    }
    setImportNote("取得中…（失敗したら貼り付け抽出を使ってください）");
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const text = stripHtmlToText(html);
      const extracted = extractFromText(text, { url });
      applyImportedFields(extracted, { onlyEmpty: importOnlyEmpty() });
      renderPreview(readForm());
      setImportNote("抽出してフォームに反映しました");
      setTimeout(() => setImportNote(""), 1800);
    } catch (e) {
      setImportNote("URL取得に失敗しました。ログイン/CORSの可能性があります（貼り付け抽出を使用してください）。");
      setTimeout(() => setImportNote(""), 3500);
    }
  });

  $("btnImportAi").addEventListener("click", () => {
    // URLから取得できないサイトが多いので、まず貼り付け抽出を促す。
    // ここでは「貼り付けモーダル」を開いてAI抽出を使う導線にする。
    setPasteNote("URLページの本文/HTMLを貼って「AIで抽出」を押してください。");
    $("modalPaste").showModal();
  });

  // Settings (API key for future integration)
  $("btnSettings").addEventListener("click", () => {
    const s = getSettings();
    $("apiKey").value = s.openaiApiKey || "";
    setSettingsNote(s.openaiApiKey ? `保存済み: ${maskKey(s.openaiApiKey)}` : "未保存");
    $("modalSettings").showModal();
  });
  $("btnSaveSettings").addEventListener("click", () => {
    const next = { ...getSettings(), openaiApiKey: $("apiKey").value.trim() };
    setSettings(next);
    setSettingsNote(next.openaiApiKey ? `保存しました: ${maskKey(next.openaiApiKey)}` : "空のため保存しませんでした");
  });
  $("btnClearSettings").addEventListener("click", () => {
    const next = { ...getSettings() };
    delete next.openaiApiKey;
    setSettings(next);
    $("apiKey").value = "";
    setSettingsNote("削除しました");
  });

  // Backup (JSON)
  $("btnExportJson").addEventListener("click", () => {
    const payload = {
      version: 1,
      exportedAt: nowIso(),
      history: getHistory(),
      autosave: getAutosave(),
      settings: { ...getSettings(), openaiApiKey: undefined }, // APIキーは含めない
    };
    downloadJson(`morishy_backup_${new Date().toISOString().slice(0, 10)}.json`, payload);
    setBackupNote("書き出しました（APIキーは含めていません）");
    setTimeout(() => setBackupNote(""), 2200);
  });

  $("btnImportJson").addEventListener("click", () => {
    $("importJsonFile").click();
  });

  $("importJsonFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const payload = await readJsonFile(file);
      if (payload?.history && Array.isArray(payload.history)) setHistory(payload.history);
      if (payload?.autosave) setAutosave(payload.autosave);
      renderHistory();

      // Restore autosave to form if present (safest)
      const a = getAutosave();
      if (a) {
        currentId = a.id || uuid();
        currentSavedAt = a.savedAt || null;
        writeForm(a);
        renderPreview(readForm());
      }

      setBackupNote("読み込みました（履歴/下書きを復元）");
      setTimeout(() => setBackupNote(""), 2500);
    } catch (err) {
      setBackupNote("読み込みに失敗しました（JSON形式を確認してください）");
      setTimeout(() => setBackupNote(""), 3500);
    } finally {
      e.target.value = "";
    }
  });

  // Restore autosave on startup when form is basically empty
  const a = getAutosave();
  if (a) {
    const emptyNow =
      !$("companyName").value.trim() &&
      !$("jobTitle").value.trim() &&
      !$("workAddress").value.trim() &&
      !$("salary").value.trim();
    if (emptyNow) {
      currentId = a.id || uuid();
      currentSavedAt = a.savedAt || null;
      writeForm(a);
    }
  }

  renderHistory();
  renderPreview(readForm());
}

init();

