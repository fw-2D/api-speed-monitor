const STORAGE_KEY = "ai-api-speed-monitor-v2";
const MODEL_COLORS = ["#4c7b99", "#be7858", "#829578", "#9b83b0", "#ba9852", "#589692", "#c5747c", "#7b90b7", "#6c7d88", "#98725a"];
const MODEL_PICKER_LIMIT = 200;

const state = {
  history: [],
  demoHistory: [],
  logs: [],
  checks: [],
  running: false,
  monitoring: false,
  timer: null,
  nextRunAt: null,
  suiteAbort: null,
  suiteRunId: 0,
  checksRunId: 0,
  checksRunning: false,
  checksAbort: null,
  progress: 0,
  progressRunId: 0,
  modelCandidates: [],
  modelMatches: [],
  modelSourceKey: "",
  modelFetchId: 0,
  modelFetchAbort: null,
  modelFetching: false,
  modelPickerSignature: null,
  checkChoicesSignature: null,
  demo: false
};

const el = {};
const REQUIRED_IDS = [
  "baseUrl", "apiKey", "rememberKey", "models", "interval", "maxTokens", "effort", "timeout", "prompt",
  "start", "stop", "runOnce", "clear", "export", "import", "fileInput", "fetchModels", "globalStatus",
  "successRate", "medianTtft", "medianTotal", "medianTps", "ttftChart", "tpsChart", "legend", "modelRows",
  "lastRun", "log", "clearLog", "checkModelInput", "checkModelSelect", "runChecks", "copyCheckResult", "checkResult"
];
const OPTIONAL_IDS = [
  "protocol", "transport", "modelCount", "runProgress", "nextRun", "sampleCount", "outputPreview",
  "testProgress", "toast", "emptyState", "protocolHint", "modelSearch", "modelPickerList",
  "selectVisibleModels", "clearSelectedModels", "modelEditorToggle", "modelEditor", "modelListSummary"
];

function readElements() {
  [...REQUIRED_IDS, ...OPTIONAL_IDS].forEach(id => {
    const element = document.getElementById(id);
    if (element) el[id] = element;
  });
  REQUIRED_IDS.forEach(id => {
    if (!el[id]) throw new Error(`Missing required element: ${id}`);
  });
}

function getProtocol() {
  return el.protocol ? el.protocol.value : "responses";
}

function getTransport() {
  return el.transport ? el.transport.value : "proxy";
}

function normalizeBase(value) {
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

function validateConnection() {
  let baseUrl;
  try { baseUrl = new URL(el.baseUrl.value.trim()); } catch { showToast("请填写完整的 API 地址，例如 https://api.example.com/v1"); return false; }
  const localHttp = getTransport() === "direct" && location.protocol !== "https:" && baseUrl.protocol === "http:";
  if ((baseUrl.protocol !== "https:" && !localHttp) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    showToast("API 地址须使用 HTTPS，并且不包含账号、查询参数或锚点");
    return false;
  }
  if (!el.apiKey.value.trim()) { showToast("请填写自己的 API Key"); return false; }
  return true;
}

function validateParameters() {
  const limits = [
    ["interval", 1, 1440, "监控间隔须为 1–1440 分钟"],
    ["maxTokens", 8, 4096, "最大输出须为 8–4096 tokens"],
    ["timeout", 5, 900, "超时须为 5–900 秒"]
  ];
  for (const [id, minimum, maximum, message] of limits) {
    const value = Number(el[id].value);
    if (!Number.isInteger(value) || value < minimum || value > maximum) { showToast(message); return false; }
  }
  if (!el.prompt.value.trim() || el.prompt.value.length > 32000) { showToast("测试指令须为 1–32000 个字符"); return false; }
  return true;
}

function safeStorageGet() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function safeStorageSet(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    showToast("本机存储不可用或已满，数据不会持久保存");
    return false;
  }
}

function forgetSavedKey() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.config && Object.hasOwn(saved.config, "apiKey")) {
      delete saved.config.apiKey;
      saved.config.rememberKey = false;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    }
  } catch {
    showToast("浏览器未允许修改本机存储，无法确认已移除保存的密钥");
  }
}

function showToast(message) {
  if (!el.toast) return;
  el.toast.textContent = message;
  el.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 3600);
  document.dispatchEvent(new CustomEvent("ui:toast", { detail: { message } }));
}

function saveState() {
  const config = {
    baseUrl: el.baseUrl.value,
    models: el.models.value,
    modelCandidates: state.modelCandidates,
    interval: el.interval.value,
    maxTokens: el.maxTokens.value,
    effort: el.effort.value,
    timeout: el.timeout.value,
    prompt: el.prompt.value,
    rememberKey: el.rememberKey.checked,
    protocol: getProtocol(),
    transport: getTransport()
  };
  if (el.rememberKey.checked) config.apiKey = el.apiKey.value;
  safeStorageSet({
    config,
    history: state.history.slice(-5000),
    logs: state.logs.slice(-500),
    checks: state.checks.slice(-100)
  });
  notifyState();
}

function isValidMetric(value) {
  return value == null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isValidTimestamp(value) {
  return typeof value === "number" && value >= 0 && Number.isFinite(new Date(value).getTime());
}

function isValidHistoryRow(row) {
  if (!row || typeof row.model !== "string" || !row.model.trim() || row.model.trim().length > 200) return false;
  if (!isValidTimestamp(row.at)) return false;
  if (typeof row.ok !== "boolean") return false;
  return isValidMetric(row.ttft) && isValidMetric(row.total) && isValidMetric(row.outputTokens) && isValidMetric(row.tokensPerSecond);
}

function sanitizeHistoryRow(row) {
  return {
    model: row.model.trim().slice(0, 200),
    protocol: typeof row.protocol === "string" ? row.protocol.slice(0, 40) : undefined,
    transport: typeof row.transport === "string" ? row.transport.slice(0, 40) : undefined,
    ok: row.ok,
    ttft: isValidMetric(row.ttft) ? row.ttft ?? null : null,
    total: isValidMetric(row.total) ? row.total ?? null : null,
    outputTokens: isValidMetric(row.outputTokens) ? row.outputTokens ?? null : null,
    reasoningTokens: isValidMetric(row.reasoningTokens) ? row.reasoningTokens ?? null : null,
    tokensPerSecond: isValidMetric(row.tokensPerSecond) ? row.tokensPerSecond ?? null : null,
    output: typeof row.output === "string" ? redactText(row.output).slice(0, 800) : "",
    at: Number(row.at),
    error: typeof row.error === "string" ? redactText(row.error).slice(0, 2000) : "",
    demo: Boolean(row.demo)
  };
}

function isValidCheckRecord(record) {
  if (!record || typeof record.model !== "string" || !record.model.trim() || record.model.trim().length > 200) return false;
  if (!isValidTimestamp(record.at)) return false;
  if (typeof record.elapsed !== "number" || !Number.isFinite(record.elapsed) || record.elapsed < 0) return false;
  if (!Array.isArray(record.results)) return false;
  return record.results.every(item => {
    return item && typeof item.name === "string" && item.name.trim().length <= 200
      && ["pass", "warn", "fail"].includes(item.status)
      && (item.detail == null || typeof item.detail === "string");
  });
}

function sanitizeCheckRecord(record) {
  return {
    model: record.model.trim().slice(0, 200),
    protocol: typeof record.protocol === "string" ? record.protocol.slice(0, 40) : undefined,
    at: Number(record.at),
    elapsed: Number(record.elapsed),
    results: record.results.map(item => ({
      name: item.name.trim().slice(0, 200),
      status: ["pass", "warn", "fail"].includes(item.status) ? item.status : "fail",
      detail: typeof item.detail === "string" ? redactText(item.detail).slice(0, 2000) : ""
    }))
  };
}

function loadState() {
  let saved = null;
  try {
    saved = JSON.parse(safeStorageGet() || "null");
  } catch {
    saved = null;
  }
  const config = saved && typeof saved.config === "object" && saved.config ? saved.config : {};
  el.baseUrl.value = typeof config.baseUrl === "string" ? config.baseUrl : "";
  el.models.value = typeof config.models === "string" ? config.models : "";
  state.modelCandidates = normalizeModelCandidates(config.modelCandidates);
  state.modelSourceKey = modelSourceKey(el.baseUrl.value);
  el.interval.value = Number.isFinite(Number(config.interval)) && Number(config.interval) > 0 ? config.interval : 30;
  el.maxTokens.value = Number.isFinite(Number(config.maxTokens)) && Number(config.maxTokens) >= 8 ? config.maxTokens : 256;
  el.effort.value = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(config.effort) ? config.effort : "";
  el.timeout.value = Number.isFinite(Number(config.timeout)) && Number(config.timeout) >= 5 ? config.timeout : 120;
  el.prompt.value = typeof config.prompt === "string" && config.prompt ? config.prompt : el.prompt.value;
  el.rememberKey.checked = Boolean(config.rememberKey);
  el.apiKey.value = el.rememberKey.checked && typeof config.apiKey === "string" ? config.apiKey : "";
  if (el.protocol) el.protocol.value = ["auto", "responses", "chat", "messages"].includes(config.protocol) ? config.protocol : "responses";
  if (el.transport) el.transport.value = location.protocol === "file:" ? "direct" : ["direct", "proxy"].includes(config.transport) ? config.transport : "proxy";
  state.history = Array.isArray(saved?.history) ? saved.history.filter(isValidHistoryRow).map(sanitizeHistoryRow).slice(-5000) : [];
  state.logs = Array.isArray(saved?.logs) ? saved.logs.filter(line => typeof line === "string").slice(-500) : [];
  state.checks = Array.isArray(saved?.checks) ? saved.checks.filter(isValidCheckRecord).map(sanitizeCheckRecord).slice(-100) : [];
  renderModelChoices();
  render();
  renderChecks();
  renderGlobalStatus();
  updateProtocolHint();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function redactText(value) {
  let text = String(value ?? "");
  const apiKey = el.apiKey ? el.apiKey.value.trim() : "";
  if (apiKey) text = text.replaceAll(apiKey, "[REDACTED]");
  return text.replace(/\b(sk|ant|api)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]");
}

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  return seconds >= 1 ? `${seconds.toFixed(2)}s` : `${Math.round(seconds * 1000)}ms`;
}

function median(values) {
  const numbers = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function effectiveHistory() {
  return state.demo ? state.demoHistory : state.history;
}

function appendLog(message, type = "info") {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  state.logs.push(`[${time}] ${redactText(message)}`);
  if (state.logs.length > 500) state.logs.shift();
  renderLog();
  saveState();
}

function renderLog() {
  if (!el.log) return;
  el.log.innerHTML = state.logs.slice(-300).map(line => {
    const safe = escapeHtml(line);
    let className = "muted";
    if (/失败|错误|超时|400|401|403|429|5\d\d/.test(line)) className = "bad";
    else if (/完成|成功/.test(line)) className = "ok";
    return `<div class="${className}">${safe}</div>`;
  }).join("");
  el.log.scrollTop = el.log.scrollHeight;
}

function requestPath(protocol) {
  if (protocol === "chat" || protocol === "chat/completions") return "chat/completions";
  if (protocol === "messages") return "messages";
  return "responses";
}

function buildRelayRequest(endpoint, payload) {
  return {
    baseUrl: normalizeBase(el.baseUrl.value),
    apiKey: el.apiKey.value.trim(),
    endpoint: endpoint === "models" ? "models" : requestPath(endpoint),
    authMode: endpoint === "models" ? modelListAuthMode() : undefined,
    payload
  };
}

function modelListAuthMode() {
  if (getProtocol() === "messages") return "messages";
  try { if (new URL(el.baseUrl.value).hostname === "api.anthropic.com") return "messages"; } catch {}
  return "openai";
}

function protocolHeaders(protocol) {
  const headers = { "Content-Type": "application/json" };
  if (protocol === "messages") {
    headers["x-api-key"] = el.apiKey.value.trim();
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else {
    headers.Authorization = `Bearer ${el.apiKey.value.trim()}`;
  }
  return headers;
}

async function requestJson(endpoint, payload, signal) {
  const request = buildRelayRequest(endpoint, payload);
  if (getTransport() === "proxy") {
    return window.fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(request),
      signal
    });
  }
  return window.fetch(`${request.baseUrl}/v1/${request.endpoint}`, {
    method: endpoint === "models" ? "GET" : "POST",
    headers: protocolHeaders(endpoint === "models" ? modelListAuthMode() : endpoint),
    body: endpoint === "models" ? undefined : JSON.stringify(payload),
    signal
  });
}

async function requestStream(endpoint, payload, signal) {
  const request = buildRelayRequest(endpoint, payload);
  if (getTransport() === "proxy") {
    return window.fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      credentials: "omit",
      body: JSON.stringify(request),
      signal
    });
  }
  return window.fetch(`${request.baseUrl}/v1/${request.endpoint}`, {
    method: "POST",
    headers: { ...protocolHeaders(endpoint), Accept: "text/event-stream" },
    body: JSON.stringify(payload),
    signal
  });
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`HTTP ${response.status} 返回的不是 JSON`);
  }
}

function apiError(body, response) {
  const detail = typeof body?.error === "string" ? body.error : body?.error?.message || body?.message || "请求失败";
  const source = response.headers.get("x-qingce-error") === "relay" ? "网站转发 · " : "";
  return `${source}HTTP ${response.status} ${detail}`;
}

async function fetchModels() {
  if (state.running || state.checksRunning) {
    showToast("请等待当前任务完成或停止");
    return;
  }
  if (!validateConnection()) return;
  syncModelSource();
  state.modelFetchAbort?.abort();
  const fetchId = ++state.modelFetchId;
  const sourceKey = state.modelSourceKey;
  const controller = new AbortController();
  state.modelFetchAbort = controller;
  state.modelFetching = true;
  const timer = window.setTimeout(() => controller.abort(), 45000);
  el.fetchModels.disabled = true;
  try {
    const response = await requestJson("models", null, controller.signal);
    const body = await parseJsonResponse(response);
    if (fetchId !== state.modelFetchId || sourceKey !== modelSourceKey(el.baseUrl.value)) return;
    if (!response.ok) throw new Error(apiError(body, response));
    const models = normalizeModelCandidates((Array.isArray(body.data) ? body.data : []).map(item => item?.id));
    if (!models.length) throw new Error("模型列表为空");
    renderModelChoices(models);
    appendLog(`拉取模型成功：${models.length} 个`, "ok");
    saveState();
  } catch (error) {
    if (fetchId !== state.modelFetchId || sourceKey !== modelSourceKey(el.baseUrl.value)) return;
    appendLog(`拉取模型失败：${error.name === "AbortError" ? "请求超时" : error.message}`, "bad");
  } finally {
    window.clearTimeout(timer);
    if (fetchId === state.modelFetchId) {
      state.modelFetching = false;
      state.modelFetchAbort = null;
      el.fetchModels.disabled = modelPickerLocked();
    }
  }
}

function modelSourceKey(value) {
  try { return new URL(normalizeBase(value)).href.replace(/\/$/, ""); }
  catch { return normalizeBase(value); }
}

function syncModelSource() {
  const sourceKey = modelSourceKey(el.baseUrl.value);
  if (state.modelSourceKey === sourceKey) return;
  state.modelSourceKey = sourceKey;
  state.modelFetchId += 1;
  state.modelFetchAbort?.abort();
  state.modelFetchAbort = null;
  state.modelFetching = false;
  state.modelCandidates = [];
  state.modelMatches = [];
  el.models.value = "";
  el.checkModelInput.value = "";
  el.checkModelSelect.value = "";
  if (el.modelSearch) el.modelSearch.value = "";
  renderModelChoices();
  el.fetchModels.disabled = modelPickerLocked();
}

function selectedModels() {
  return [...new Set(el.models.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
}

function normalizeModelCandidates(models) {
  if (!Array.isArray(models)) return [];
  return [...new Set(models.filter(model => typeof model === "string").map(model => model.trim()).filter(model => model && model.length <= 200))];
}

function modelProviderLabel(model) {
  if (/claude/i.test(model)) return "Claude · 按 ID 分类";
  if (/gemini/i.test(model)) return "Gemini · 按 ID 分类";
  if (/(?:^|[\s/_.-])(?:gpt|chatgpt|openai|o[134])(?:[\d\s/_.-]|$)/i.test(model)) return "OpenAI · 按 ID 分类";
  return "其他 · 按 ID 分类";
}

function modelPickerLocked() {
  return state.running || state.checksRunning || Boolean(state.timer);
}

function updateModelPickerControls() {
  const locked = modelPickerLocked();
  if (el.selectVisibleModels) el.selectVisibleModels.disabled = locked || !state.modelMatches.length;
  if (el.clearSelectedModels) el.clearSelectedModels.disabled = locked || !selectedModels().length;
  if (el.modelPickerList) el.modelPickerList.querySelectorAll('input[type="checkbox"]').forEach(input => { input.disabled = locked; });
}

function renderModelChoices(models) {
  const selected = selectedModels();
  const selectedSet = new Set(selected);
  state.modelCandidates = normalizeModelCandidates([...(Array.isArray(models) ? models : state.modelCandidates), ...selected]);
  const query = el.modelSearch ? el.modelSearch.value.trim().toLowerCase() : "";
  state.modelMatches = state.modelCandidates.filter(model => model.toLowerCase().includes(query));
  const visible = state.modelMatches.slice(0, MODEL_PICKER_LIMIT);
  if (el.modelPickerList) {
    const signature = JSON.stringify([visible, state.modelMatches.length, state.modelCandidates.length]);
    if (signature !== state.modelPickerSignature) {
      state.modelPickerSignature = signature;
      el.modelPickerList.innerHTML = visible.length ? visible.map(model => {
        const safe = escapeHtml(model);
        const checked = selectedSet.has(model);
        return `<label class="model-choice${checked ? " selected" : ""}"><input type="checkbox" value="${safe}"${checked ? " checked" : ""}><span class="model-choice-name" title="${safe}">${safe}</span><small class="model-choice-provider">${modelProviderLabel(model)}</small></label>`;
      }).join("") + (state.modelMatches.length > MODEL_PICKER_LIMIT ? `<div class="model-picker-empty"><svg class="icon" aria-hidden="true"><use href="#i-paw"></use></svg><span>仅显示前 ${MODEL_PICKER_LIMIT} 项，共匹配 ${state.modelMatches.length} 项，请输入关键词缩小范围；「选中匹配项」会选择全部匹配模型。</span></div>` : "")
        : `<div class="model-picker-empty"><span class="empty-paw"><svg class="icon" aria-hidden="true"><use href="#i-paw"></use></svg></span><div><h3>${state.modelCandidates.length ? "没有找到这个模型。" : "先认识一下你的模型。"}</h3><p>${state.modelCandidates.length ? "试试其他关键词，或手动输入完整 ID。" : "填写连接信息并拉取模型，或手动输入模型 ID。"}</p></div></div>`;
    }
    el.modelPickerList.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.checked = selectedSet.has(input.value);
      input.closest(".model-choice").classList.toggle("selected", input.checked);
    });
  }
  const checkSelected = el.checkModelInput.value.trim() || el.checkModelSelect.value;
  const checkChoices = state.modelCandidates.slice(0, MODEL_PICKER_LIMIT);
  if (state.modelCandidates.includes(checkSelected) && !checkChoices.includes(checkSelected)) checkChoices.push(checkSelected);
  const checkSignature = JSON.stringify([checkChoices, state.modelCandidates.length > MODEL_PICKER_LIMIT]);
  if (checkSignature !== state.checkChoicesSignature) {
    state.checkChoicesSignature = checkSignature;
    el.checkModelSelect.innerHTML = '<option value="">从模型列表选择</option>' + checkChoices.map(model => {
      const safe = escapeHtml(model);
      return `<option value="${safe}" title="${safe}">${safe}</option>`;
    }).join("") + (state.modelCandidates.length > MODEL_PICKER_LIMIT ? '<option disabled>更多模型请手工输入完整 ID</option>' : "");
  }
  if (checkChoices.includes(checkSelected)) {
    el.checkModelInput.value = checkSelected;
    el.checkModelSelect.value = checkSelected;
  }
  updateModelCount();
  updateModelPickerControls();
}

function updateModelCount() {
  const count = selectedModels().length;
  if (el.modelCount) el.modelCount.textContent = `${count} 个`;
  if (el.modelListSummary) el.modelListSummary.textContent = `匹配 ${state.modelMatches.length} / 候选 ${state.modelCandidates.length} · 已选 ${count}`;
}

function setSelectedModels(models) {
  if (modelPickerLocked()) return;
  el.models.value = [...new Set(models)].join("\n");
  renderModelChoices();
  saveState();
}

function resolveProtocol(model) {
  const selected = getProtocol();
  const normalized = model.toLowerCase();
  if (/gpt.?6.?astra|gpt.?6\.1.?sol/.test(normalized)) return "responses";
  if (selected !== "auto") return selected;
  if (normalized.includes("claude")) return "messages";
  return "chat";
}

function updateProtocolHint(model = "") {
  if (!el.protocolHint) return;
  const selected = getProtocol();
  if (model) el.protocolHint.dataset.currentModel = model;
  const resolved = model ? resolveProtocol(model) : selected === "auto" ? "按模型自动判断" : selected;
  el.protocolHint.textContent = `当前协议：${selected === "auto" ? `自动（${resolved}）` : resolved}`;
}

function buildPayload(model, protocol, prompt, maxTokens) {
  if (protocol === "responses") {
    const payload = { model, input: prompt, max_output_tokens: maxTokens, stream: true };
    if (el.effort.value) payload.reasoning = { effort: el.effort.value };
    return payload;
  }
  if (protocol === "messages") {
    return { model, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: prompt }] };
  }
  return { model, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: prompt }] };
}

function parseSseBlock(block) {
  const dataLines = block.split(/\r?\n/).filter(line => line.startsWith("data:"));
  if (!dataLines.length) return null;
  return dataLines.map(line => line.slice(5).replace(/^ /, "")).join("\n");
}

async function consumeSse(response, handleEvent) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`HTTP ${response.status} 返回了不支持流式的响应`);
    }
    handleEvent({ type: "non-stream-json", body: parsed });
    return "non-stream-json";
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("浏览器不支持流式读取");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const data = parseSseBlock(block);
      if (!data || data === "[DONE]") continue;
      let event;
      try { event = JSON.parse(data); } catch { throw new Error("流式事件不是有效 JSON"); }
      handleEvent(event);
    }
  }
  buffer += decoder.decode();
  const trailing = parseSseBlock(buffer);
  if (trailing && trailing !== "[DONE]") {
    let event;
    try { event = JSON.parse(trailing); } catch { throw new Error("流式末尾事件不是有效 JSON"); }
    handleEvent(event);
  }
  return "sse";
}

function readResponsesEvent(event, result) {
  if (event.response?.model) result.responseModel = event.response.model;
  if (event.model) result.responseModel = event.model;
  if (event.type === "response.output_text.delta") {
    if (typeof event.delta === "string" && event.delta) {
      result.output += event.delta;
      if (result.ttft == null) result.ttft = (performance.now() - result.started) / 1000;
    }
  }
  if (event.type === "response.completed") {
    result.completed = true;
    const usage = event.response?.usage;
    if (isValidMetric(usage?.output_tokens) && usage?.output_tokens != null) result.outputTokens = usage.output_tokens;
    if (isValidMetric(usage?.output_tokens_details?.reasoning_tokens) && usage?.output_tokens_details?.reasoning_tokens != null) result.reasoningTokens = usage.output_tokens_details.reasoning_tokens;
    const responseModel = event.response?.model || event.model;
    if (responseModel) result.responseModel = responseModel;
  }
  if (event.type === "response.failed" || event.type === "response.error" || event.error) {
    result.failed = true;
    result.errorMessage = event.response?.error?.message || event.error?.message || JSON.stringify(event).slice(0, 300);
  }
  if (event.type === "response.incomplete") {
    result.failed = true;
    result.errorMessage = `响应未完成：${event.response?.incomplete_details?.reason || "上游提前结束"}`;
  }
}

function readChatEvent(event, result) {
  const choice = event.choices?.[0];
  const delta = choice?.delta?.content ?? choice?.message?.content;
  if (typeof delta === "string" && delta) {
    result.output += delta;
    if (result.ttft == null) result.ttft = (performance.now() - result.started) / 1000;
  }
  if (event.usage) {
    const usage = event.usage.output_tokens ?? event.usage.completion_tokens;
    if (isValidMetric(usage) && usage != null) result.outputTokens = usage;
    const reasoningTokens = event.usage.completion_tokens_details?.reasoning_tokens;
    if (isValidMetric(reasoningTokens) && reasoningTokens != null) result.reasoningTokens = reasoningTokens;
  }
  if (event.model) result.responseModel = event.model;
  if (choice?.finish_reason === "stop" || choice?.finish_reason === "length") result.completed = true;
  if (event.error) {
    result.failed = true;
    result.errorMessage = event.error.message || JSON.stringify(event).slice(0, 300);
  }
}

function readMessagesEvent(event, result) {
  if (event.type === "message_start") {
    if (event.message?.model) result.responseModel = event.message.model;
    const outputTokens = event.message?.usage?.output_tokens;
    if (isValidMetric(outputTokens) && outputTokens != null) result.outputTokens = outputTokens;
  }
  if (event.type === "content_block_delta") {
    const text = event.delta?.text;
    if (typeof text === "string" && text) {
      result.output += text;
      if (result.ttft == null) result.ttft = (performance.now() - result.started) / 1000;
    }
  }
  if (event.type === "message_delta") {
    const usage = event.usage?.output_tokens;
    if (isValidMetric(usage) && usage != null) result.outputTokens = usage;
  }
  if (event.type === "message_stop") result.completed = true;
  if (event.model) result.responseModel = event.model;
  if (event.type === "error" || event.error) {
    result.failed = true;
    result.errorMessage = event.error?.message || JSON.stringify(event).slice(0, 300);
  }
}

function readNonStreamBody(protocol, body, result) {
  if (protocol === "responses") {
    result.output = body.output_text || body.output?.map(item => item?.content?.map(part => part?.text || "").join("")).join("") || "";
    const usage = Number(body.usage?.output_tokens);
    if (Number.isFinite(usage)) result.outputTokens = usage;
    result.responseModel = body.model;
    result.completed = Boolean(body.id || body.output);
    if (body.status === "failed" || body.error) {
      result.failed = true;
      result.errorMessage = body.error?.message || "响应状态为 failed";
    }
  } else if (protocol === "chat") {
    result.output = body.choices?.[0]?.message?.content || "";
    const usage = Number(body.usage?.output_tokens ?? body.usage?.completion_tokens);
    if (Number.isFinite(usage)) result.outputTokens = usage;
    result.responseModel = body.model;
    result.completed = Boolean(body.id);
    if (body.error) {
      result.failed = true;
      result.errorMessage = body.error.message || "响应包含错误";
    }
  } else {
    result.output = body.content?.map(item => item?.text || "").join("") || "";
    const usage = Number(body.usage?.output_tokens);
    if (Number.isFinite(usage)) result.outputTokens = usage;
    result.responseModel = body.model;
    result.completed = Boolean(body.id);
    if (body.type === "error" || body.error) {
      result.failed = true;
      result.errorMessage = body.error?.message || "响应包含错误";
    }
  }
}


async function testModel(model, signal) {
  const protocol = resolveProtocol(model);
  const maxTokens = Math.max(Number(el.maxTokens.value) || 256, 8);
  const prompt = el.prompt.value || "Reply with OK";
  const payload = buildPayload(model, protocol, prompt, maxTokens);
  const result = {
    model,
    protocol,
    transport: getTransport(),
    ok: false,
    ttft: null,
    total: 0,
    outputTokens: null,
    reasoningTokens: null,
    tokensPerSecond: null,
    output: "",
    at: Date.now(),
    error: "",
    started: performance.now()
  };
  try {
    const response = await requestStream(protocol, payload, signal);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text.slice(0, 400);
      try {
        const body = JSON.parse(text);
        throw new Error(apiError(body, response));
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      throw new Error(`HTTP ${response.status} ${detail}`.trim());
    }
    const mode = await consumeSse(response, event => {
      if (event.type === "non-stream-json") {
        readNonStreamBody(protocol, event.body, result);
        return;
      }
      if (protocol === "responses") readResponsesEvent(event, result);
      else if (protocol === "chat") readChatEvent(event, result);
      else readMessagesEvent(event, result);
      if (el.outputPreview) el.outputPreview.textContent = redactText(result.output.slice(-300));
      notifyState();
    });
    result.total = (performance.now() - result.started) / 1000;
    if (mode === "non-stream-json") {
      result.nonStream = true;
      result.ok = false;
      result.error = result.failed
        ? redactText(result.errorMessage || "响应包含错误事件")
        : "接口返回 JSON 非流式结果，测速要求 SSE 流式";
      return result;
    }
    if (result.failed) {
      result.error = redactText(result.errorMessage || "流式响应返回错误事件");
      return result;
    }
    if (!result.completed) {
      result.error = "流提前结束，未收到完成事件";
      return result;
    }
    if (!String(result.output).trim()) {
      result.error = "流式响应输出为空";
      return result;
    }
    result.ok = true;
    const generationSeconds = result.ttft == null ? null : Math.max(result.total - result.ttft, 0.001);
    const textTokens = result.outputTokens == null ? null : Math.max(result.outputTokens - (result.reasoningTokens || 0), 0);
    result.tokensPerSecond = textTokens != null && generationSeconds ? textTokens / generationSeconds : null;
    return result;
  } catch (error) {
    result.total = (performance.now() - result.started) / 1000;
    result.error = redactText(error.name === "AbortError" ? "超时或已取消" : error.message);
    return result;
  }
}

function setProgress(progressElement, percent) {
  if (!progressElement) return;
  const bounded = Math.max(0, Math.min(100, percent));
  if (state.suiteRunId === state.progressRunId) state.progress = bounded;
  if (progressElement instanceof HTMLProgressElement) {
    progressElement.value = bounded;
    return;
  }
  const indicator = progressElement.querySelector("span");
  if (indicator) indicator.style.width = `${bounded}%`;
}

function setProgressForSuite(runId, percent) {
  if (state.suiteRunId !== runId) return;
  state.progressRunId = runId;
  setProgress(el.testProgress, percent);
  notifyState();
}

function setRunProgress(message) {
  if (!el.runProgress) return;
  el.runProgress.textContent = message;
}

async function runSuite(trigger = "manual") {
  if (state.running || state.checksRunning) return;
  if (!validateConnection() || !validateParameters()) return;
  const models = [...new Set(el.models.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
  if (!models.length) {
    showToast("请至少填写一个模型");
    return;
  }
  if (!el.apiKey.value.trim()) {
    showToast("请填写 API Key");
    return;
  }
  if (models.some(model => model.length > 200)) { showToast("模型 ID 最长支持 200 个字符"); return; }
  state.running = true;
  state.demo = false;
  state.demoHistory = [];
  state.progress = 0;
  state.suiteRunId += 1;
  const runId = state.suiteRunId;
  state.progressRunId = runId;
  const timeoutMs = Math.max(Number(el.timeout.value) || 120, 5) * 1000;
  renderGlobalStatus();
  setRunProgress("准备测试");
  appendLog(`开始 ${trigger} 测试，共 ${models.length} 个模型`);
  for (let index = 0; index < models.length; index += 1) {
    if (state.suiteRunId !== runId) break;
    const model = models[index];
    const controller = new AbortController();
    state.suiteAbort = controller;
    if (el.outputPreview) el.outputPreview.textContent = "";
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    setProgressForSuite(runId, index / models.length * 100);
    updateProtocolHint(model);
    setRunProgress(`正在测试 ${model}`);
    try {
      const result = await testModel(model, controller.signal);
      if (state.suiteRunId !== runId) break;
      state.history.push(sanitizeHistoryRow(result));
      if (state.history.length > 5000) state.history.shift();
      const speed = result.tokensPerSecond ? `${result.tokensPerSecond.toFixed(1)} tokens/s` : "tokens/s --";
      const detail = `TTFT ${formatSeconds(result.ttft)}，总耗时 ${formatSeconds(result.total)}，输出 ${result.outputTokens ?? "--"} tokens，${speed}`;
      if (result.ok) appendLog(`${model} 完成：${detail}`, "ok");
      else appendLog(`${model} 失败：${result.error}`, "bad");
    } catch (error) {
      if (state.suiteRunId !== runId) break;
      state.history.push({ model, ok: false, ttft: null, total: 0, outputTokens: null, tokensPerSecond: null, at: Date.now(), error: redactText(error.message) });
      appendLog(`${model} 失败：${error.message}`, "bad");
    } finally {
      window.clearTimeout(timer);
      if (state.suiteRunId === runId) {
        render();
        saveState();
      }
    }
  }
  setProgressForSuite(runId, 100);
  if (state.suiteRunId !== runId) return;
  state.suiteAbort = null;
  state.running = false;
  state.progress = 100;
  if (state.suiteRunId === runId) {
    state.suiteAbort = null;
    setRunProgress("本轮完成");
    el.lastRun.textContent = `最近：${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    renderGlobalStatus();
    appendLog(`${trigger} 测试结束`);
  }
}

async function runModelChecks() {
  if (!validateConnection() || !validateParameters()) return;
  const model = (el.checkModelInput.value.trim() || el.checkModelSelect.value).trim();
  if (!model || model.length > 200) {
    showToast("请输入或选择要检测的模型");
    return;
  }
  if (!el.apiKey.value.trim()) {
    showToast("请填写 API Key");
    return;
  }
  if (state.running || state.checksRunning) {
    showToast("已有检测在进行中");
    return;
  }
  state.demo = false;
  state.demoHistory = [];
  state.progress = 0;
  state.progressRunId = state.suiteRunId;
  render();
  state.checksRunning = true;
  if (el.outputPreview) el.outputPreview.textContent = "";
  state.checksRunId += 1;
  const runId = state.checksRunId;
  renderGlobalStatus();
  setRunProgress(`正在检测 ${model}`);
  const started = Date.now();
  el.runChecks.disabled = true;
  el.checkResult.className = "checks muted";
  el.checkResult.textContent = "检测中...";
  appendLog(`开始检测模型 ${model}`);
  const results = [];
  const add = (name, status, detail) => results.push({ name, status, detail });
  try {
    const listController = new AbortController();
    state.checksAbort = listController;
    const listTimer = window.setTimeout(() => listController.abort(), 45000);
    try {
      const response = await requestJson("models", null, listController.signal);
      const body = await parseJsonResponse(response);
      if (!response.ok) throw new Error(apiError(body, response));
      const listed = Array.isArray(body.data) && body.data.some(item => item?.id === model);
      add("模型列表", listed ? "pass" : "warn", listed ? "模型出现在 /v1/models" : "请求成功，但模型不在列表中，可能由路由动态支持");
    } catch (error) {
      add("模型列表", "warn", error.name === "AbortError" ? "请求超时" : `请求失败：${error.message}`);
    } finally {
      window.clearTimeout(listTimer);
      if (state.checksRunId === runId) state.checksAbort = null;
    }

    if (state.checksRunId !== runId) return;
    const protocol = resolveProtocol(model);
    const payload = buildPayload(model, protocol, "Reply with exactly: OK", Number(el.maxTokens.value));
    const controller = new AbortController();
    state.checksAbort = controller;
    const timer = window.setTimeout(() => controller.abort(), Math.max(Number(el.timeout.value) || 120, 5) * 1000);
    try {
      const response = await requestStream(protocol, payload, controller.signal);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        add(`${protocol} 协议`, "fail", `HTTP ${response.status} ${text.slice(0, 400)}`);
      } else {
        add(`${protocol} 协议`, "pass", `HTTP ${response.status}，Content-Type: ${(response.headers.get("content-type") || "unknown").toLowerCase()}`);
        const partial = { output: "", ttft: null, started: performance.now(), outputTokens: null, completed: false, failed: false, responseModel: null };
        const mode = await consumeSse(response, event => {
          if (event.type === "non-stream-json") {
            readNonStreamBody(protocol, event.body, partial);
            return;
          }
          if (protocol === "responses") readResponsesEvent(event, partial);
          else if (protocol === "chat") readChatEvent(event, partial);
          else readMessagesEvent(event, partial);
        });
        if (partial.failed) add("上游错误", "fail", partial.errorMessage || "上游返回错误事件");
        if (mode === "non-stream-json") {
          add("流式完整性", "warn", "接口返回 JSON 非流式结果，说明该模型或中转站不支持 SSE 流式");
          add("输出内容", String(partial.output || "").trim() ? "pass" : "warn", String(partial.output || "").trim() ? `输出：${partial.output.slice(0, 200)}` : "非流式响应没有输出");
        } else {
          const streamOk = partial.completed && !partial.failed && Boolean(String(partial.output).trim());
          add("流式完整性", streamOk ? "pass" : "fail", streamOk ? "收到完整流式结束事件且输出非空" : "流式输出为空、被截断或缺少完成事件");
          add("输出内容", String(partial.output).trim() ? "pass" : "warn", String(partial.output).trim() ? `输出：${partial.output.slice(0, 200)}` : "未收到文本输出");
        }
        if (partial.responseModel != null) {
          const modelMatch = partial.responseModel === model;
          add("模型一致性", modelMatch ? "pass" : "warn", modelMatch ? "响应中的模型 ID 与请求一致" : `响应返回 ${partial.responseModel}，与请求模型不同，可能经过路由映射`);
        } else {
          add("模型一致性", "warn", "响应未返回模型 ID，无法判断是否一致");
        }
      }
    } catch (error) {
      add(`${protocol} 请求`, "fail", error.name === "AbortError" ? "请求超时或被取消" : error.message);
    } finally {
      window.clearTimeout(timer);
    }

    if (state.checksRunId === runId) {
      const safeResults = results.map(item => ({ ...item, detail: redactText(item.detail || "") }));
      const record = { model, protocol, at: started, elapsed: Date.now() - started, results: safeResults };
      state.checks.push(record);
      if (state.checks.length > 100) state.checks.shift();
      renderChecks(record);
      appendLog(`模型 ${model} 检测完成：${results.filter(item => item.status === "pass").length}/${results.length} 项通过`, "ok");
    }
  } catch (error) {
    appendLog(`模型 ${model} 检测异常：${error.message}`, "bad");
  } finally {
    if (state.checksRunId === runId) state.checksRunning = false;
    if (state.checksRunId === runId) {
      state.checksAbort = null;
      el.runChecks.disabled = false;
      setRunProgress("检测完成");
      saveState();
      renderGlobalStatus();
    }
  }
}

function renderChecks(latest) {
  const record = latest || state.checks.at(-1);
  if (!record) {
    el.checkResult.className = "checks muted";
    el.checkResult.replaceChildren();
    const placeholder = document.createElement("div");
    placeholder.className = "detection-empty";
    const heading = document.createElement("h4");
    heading.textContent = "准备好，认识这个模型。";
    const description = document.createElement("p");
    description.textContent = "选择一个模型，开始检测它的接口兼容性。";
    placeholder.append(heading, description);
    el.checkResult.append(placeholder);
    return;
  }
  el.checkResult.className = "checks";
  const title = `<div class="check"><div class="check-row"><span class="check-name">${escapeHtml(record.model)}</span><span class="muted">${escapeHtml(new Date(record.at).toLocaleString("zh-CN", { hour12: false }))} · ${record.elapsed}ms</span></div></div>`;
  el.checkResult.innerHTML = title + record.results.map(item => `
    <div class="check">
      <div class="check-row">
        <span class="check-name">${escapeHtml(item.name)}</span>
        <span class="badge ${escapeHtml(item.status)}">${escapeHtml(item.status === "pass" ? "通过" : item.status === "warn" ? "注意" : "失败")}</span>
      </div>
      <div class="check-detail">${escapeHtml(item.detail || "")}</div>
    </div>`).join("");
}

function startMonitor() {
  if (state.running || state.checksRunning) return;
  if (!validateConnection() || !validateParameters()) return;
  if (!el.models.value.trim()) { showToast("请至少填写一个模型"); return; }
  if (el.models.value.split(/\r?\n/).some(model => model.trim().length > 200)) { showToast("模型 ID 最长支持 200 个字符"); return; }
  stopMonitor(false);
  saveState();
  runSuite("定时");
  const intervalMs = Math.max(Number(el.interval.value) || 30, 1) * 60 * 1000;
  state.monitoring = true;
  state.nextRunAt = Date.now() + intervalMs;
  state.timer = window.setInterval(() => {
    state.nextRunAt = Date.now() + intervalMs;
    runSuite("定时");
  }, intervalMs);
  renderGlobalStatus();
  appendLog(`长期监控已启动，每 ${intervalMs / 60000} 分钟一轮`);
}

function stopMonitor(log = true) {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = null;
  state.monitoring = false;
  state.nextRunAt = null;
  state.suiteRunId += 1;
  state.checksRunId += 1;
  state.checksAbort?.abort();
  state.checksAbort = null;
  state.suiteAbort?.abort();
  state.suiteAbort = null;
  state.running = false;
  state.checksRunning = false;
  state.progress = 0;
  setRunProgress("已停止");
  if (el.outputPreview) el.outputPreview.textContent = "";
  if (log) appendLog("监控已停止");
  renderGlobalStatus();
}

function modelStats() {
  const history = effectiveHistory();
  const map = new Map();
  for (const row of history) {
    if (!map.has(row.model)) map.set(row.model, []);
    map.get(row.model).push(row);
  }
  return [...map.entries()].map(([model, rows], index) => {
    const success = rows.filter(row => row.ok);
    return {
      model,
      color: MODEL_COLORS[index % MODEL_COLORS.length],
      rows,
      latest: rows.at(-1),
      successRate: rows.length ? success.length / rows.length : null,
      medianTtft: median(success.map(row => row.ttft)),
      medianTotal: median(success.map(row => row.total)),
      medianTps: median(success.map(row => row.tokensPerSecond).filter(Boolean))
    };
  });
}

function renderStats(stats) {
  const history = effectiveHistory();
  const successful = history.filter(row => row.ok);
  const rate = history.length ? successful.length / history.length : null;
  el.successRate.textContent = rate == null ? "--" : `${(rate * 100).toFixed(1)}%`;
  el.successRate.className = `value ${rate == null ? "" : rate >= 0.95 ? "ok" : rate >= 0.8 ? "warn" : "bad"}`;
  el.medianTtft.textContent = formatSeconds(median(successful.map(row => row.ttft)));
  el.medianTotal.textContent = formatSeconds(median(successful.map(row => row.total)));
  const speed = median(successful.map(row => row.tokensPerSecond).filter(Boolean));
  el.medianTps.textContent = speed ? speed.toFixed(1) : "--";
  if (el.sampleCount) el.sampleCount.textContent = String(history.length);
  if (el.emptyState) el.emptyState.hidden = history.length > 0;
}

function renderTable(stats) {
  if (!stats.length) {
    el.modelRows.innerHTML = '<tr><td colspan="8" class="muted">还没有测试记录。选择模型，点击「立即测试」开始。</td></tr>';
    return;
  }
  el.modelRows.innerHTML = stats.map(item => {
    const latest = item.latest;
    const status = latest?.ok ? '<span class="model-status ok">正常</span>' : '<span class="model-status bad">失败</span>';
    const rate = item.successRate == null ? "--" : `${(item.successRate * 100).toFixed(1)}%`;
    const rateClass = item.successRate >= 0.95 ? "ok" : item.successRate >= 0.8 ? "warn" : "bad";
    const title = latest?.error ? ` title="${escapeHtml(latest.error)}"` : "";
    const model = escapeHtml(item.model);
    const testedAt = latest ? new Date(latest.at) : null;
    const fullTime = testedAt ? testedAt.toLocaleString("zh-CN", { hour12: false }) : "";
    const time = testedAt ? testedAt.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "--";
    const isoTime = testedAt && Number.isFinite(testedAt.getTime()) ? testedAt.toISOString() : "";
    return `<tr${title}>
      <td class="model" data-label="模型" title="${model}">${model}</td><td data-label="状态">${status}</td><td data-label="首字延迟">${formatSeconds(latest?.ttft)}</td><td data-label="总耗时">${formatSeconds(latest?.total)}</td>
      <td data-label="输出 tokens">${escapeHtml(latest?.outputTokens ?? "--")}</td><td data-label="tokens/s">${latest?.tokensPerSecond ? latest.tokensPerSecond.toFixed(1) : "--"}</td>
      <td class="${rateClass}" data-label="成功率">${rate}</td><td class="muted model-time" data-label="最后测试" title="${escapeHtml(fullTime)}"><time${isoTime ? ` datetime="${isoTime}"` : ""}>${escapeHtml(time)}</time></td>
    </tr>`;
  }).join("");
}

function drawChart(canvas, stats, field) {
  const displayRatio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  canvas.width = Math.round(rect.width * displayRatio);
  canvas.height = Math.round(rect.height * displayRatio);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(displayRatio, 0, 0, displayRatio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const styles = getComputedStyle(document.documentElement);
  const gridColor = styles.getPropertyValue("--chart-grid").trim() || "rgba(39, 77, 57, 0.16)";
  const textColor = styles.getPropertyValue("--chart-text").trim() || "#365b45";
  const padding = { top: 20, right: 24, bottom: 38, left: 68 };
  const width = rect.width - padding.left - padding.right;
  const height = rect.height - padding.top - padding.bottom;
  if (width <= 0 || height <= 0) return;
  const points = stats.flatMap(item => item.rows.filter(row => row.ok && Number.isFinite(row[field])).map(row => ({ row, color: item.color })));
  context.strokeStyle = gridColor;
  context.fillStyle = textColor;
  context.font = "12px system-ui";
  context.lineWidth = 1;
  if (!points.length) {
    context.font = "13px system-ui";
    context.textAlign = "center";
    context.fillText("暂无成功数据", rect.width / 2, rect.height / 2);
    return;
  }
  const times = points.map(point => point.row.at);
  const values = points.map(point => point.row[field]);
  const minX = Math.min(...times);
  const maxX = Math.max(...times);
  const rangeX = Math.max(maxX - minX, 1);
  const maxValue = Math.max(...values) * 1.1 || 1;
  const yTicks = height < 100 ? 2 : height < 160 ? 3 : 4;
  for (let index = 0; index <= yTicks; index += 1) {
    const positionY = padding.top + height - height * index / yTicks;
    const value = maxValue * index / yTicks;
    context.beginPath();
    context.moveTo(padding.left, positionY);
    context.lineTo(padding.left + width, positionY);
    context.stroke();
    context.textAlign = "right";
    const axisLabel = field === "ttft"
      ? `${value.toFixed(value < 1 ? 2 : 1)}s`
      : value.toFixed(1);
    context.fillText(axisLabel, padding.left - 10, positionY + 4);
  }
  context.textAlign = "left";
  context.fillText(new Date(minX).toLocaleTimeString("zh-CN", { hour12: false }), padding.left, rect.height - 12);
  if (minX !== maxX && width >= 140) {
    context.textAlign = "right";
    context.fillText(new Date(maxX).toLocaleTimeString("zh-CN", { hour12: false }), padding.left + width, rect.height - 12);
  }
  for (const item of stats) {
    const rows = item.rows.filter(row => row.ok && Number.isFinite(row[field])).sort((left, right) => left.at - right.at);
    if (!rows.length) continue;
    context.strokeStyle = item.color;
    context.lineWidth = 2;
    context.beginPath();
    rows.forEach((row, index) => {
      const positionX = padding.left + (row.at - minX) / rangeX * width;
      const positionY = padding.top + height - row[field] / maxValue * height;
      if (index) context.lineTo(positionX, positionY); else context.moveTo(positionX, positionY);
    });
    context.stroke();
    rows.forEach(row => {
      const positionX = padding.left + (row.at - minX) / rangeX * width;
      const positionY = padding.top + height - row[field] / maxValue * height;
      context.fillStyle = item.color;
      context.beginPath();
      context.arc(positionX, positionY, 3.2, 0, Math.PI * 2);
      context.fill();
    });
  }
}

function renderCharts(stats) {
  drawChart(el.ttftChart, stats, "ttft");
  drawChart(el.tpsChart, stats, "tokensPerSecond");
  el.legend.innerHTML = stats.map(item => `<span><i style="background:${escapeHtml(item.color)}"></i>${escapeHtml(item.model)}</span>`).join("");
}

function render() {
  const stats = modelStats();
  renderStats(stats);
  renderTable(stats);
  renderCharts(stats);
  renderLog();
  updateModelCount();
  const latest = effectiveHistory().at(-1);
  el.lastRun.textContent = state.demo ? "模拟数据 · 不会消耗额度" : latest ? `最近 ${new Date(latest.at).toLocaleTimeString("zh-CN", { hour12: false })}` : "尚未开始";
  notifyState();
}

function buildCheckReport() {
  const record = state.checks.at(-1);
  if (!record) return "";
  return [
    `模型检测报告 ${record.model}`,
    new Date(record.at).toLocaleString("zh-CN", { hour12: false }),
    ...record.results.map(item => `${item.status.toUpperCase()}: ${item.name} - ${item.detail || ""}`)
  ].join("\n");
}

function notifyState() {
  const models = el.models.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  document.dispatchEvent(new CustomEvent("monitor:update", {
    detail: {
      running: state.running,
      monitoring: state.monitoring,
      checksRunning: state.checksRunning,
      modelCount: models.length,
      samples: Number(effectiveHistory().length),
      demo: state.demo,
      nextRunAt: state.nextRunAt,
      progress: Number(state.progress),
      currentModel: el.protocolHint?.dataset.currentModel || "",
      output: el.outputPreview ? el.outputPreview.textContent : undefined
    }
  }));
}

function renderGlobalStatus() {
  const busy = state.running || state.checksRunning;
  const next = state.timer ? (state.running ? "测试中" : busy ? "检测中" : `等待下轮 · ${Math.max(Number(el.interval.value) || 30, 1)} 分钟`) : busy ? "任务运行中" : "空闲";
  el.globalStatus.querySelector("span:last-child").textContent = next;
  if (el.nextRun) el.nextRun.textContent = state.nextRunAt ? new Date(state.nextRunAt).toLocaleTimeString("zh-CN", { hour12: false }) : "--";
  el.globalStatus.classList.toggle("running", Boolean(state.timer));
  const locked = busy || Boolean(state.timer);
  el.start.disabled = locked;
  el.runOnce.disabled = busy;
  el.runChecks.disabled = busy;
  el.fetchModels.disabled = locked || state.modelFetching;
  el.import.disabled = locked;
  el.clear.disabled = locked;
  ["baseUrl", "apiKey", "rememberKey", "protocol", "transport", "models", "interval", "maxTokens", "effort", "timeout", "prompt", "checkModelInput", "checkModelSelect"].forEach(id => {
    if (el[id]) el[id].disabled = locked;
  });
  updateModelPickerControls();
  el.stop.disabled = !locked;
  notifyState();
}

function exportData() {
  const history = effectiveHistory();
  const blob = new Blob([JSON.stringify({
    version: 2,
    demo: state.demo,
    config: { baseUrl: el.baseUrl.value, models: el.models.value },
    history
  }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `api-speed-history-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  file.text().then(content => {
    const imported = JSON.parse(content);
    if (!imported || typeof imported !== "object") throw new Error("文件格式不正确");
    if (!Array.isArray(imported.history)) throw new Error("文件中缺少历史数组");
    const history = imported.history.filter(isValidHistoryRow).map(sanitizeHistoryRow).slice(-5000);
    if (history.length !== imported.history.length && imported.history.length <= 5000) throw new Error("历史记录包含无效模型或指标");
    state.demo = Boolean(imported.demo);
    if (state.demo) state.demoHistory = history;
    else { state.history = history; state.demoHistory = []; }
    if (!state.demo && typeof imported.config?.baseUrl === "string") el.baseUrl.value = imported.config.baseUrl;
    if (!state.demo) syncModelSource();
    if (!state.demo && typeof imported.config?.models === "string") el.models.value = imported.config.models;
    renderModelChoices();
    saveState();
    render();
    appendLog(`导入完成：${history.length} 条历史`);
  }).catch(error => {
    showToast(`导入失败：${error.message}`);
  }).finally(() => {
    event.target.value = "";
  });
}

function loadDemo() {
  if (state.running || state.checksRunning || state.timer) return;
  const now = Date.now();
  const models = ["demo-astra", "demo-sol", "demo-claude"];
  state.demo = true;
  state.demoHistory = models.flatMap((model, modelIndex) => Array.from({ length: 10 }, (_, sampleIndex) => {
    const ttft = 0.45 + modelIndex * 0.18 + Math.random() * 0.22;
    const outputTokens = 90 + Math.round(Math.random() * 40);
    const total = ttft + outputTokens / (42 + modelIndex * 9 + Math.random() * 10);
    return {
      model,
      ok: Math.random() > (modelIndex === 2 ? 0.22 : 0.06),
      ttft,
      total,
      outputTokens,
      tokensPerSecond: outputTokens / Math.max(total - ttft, 0.001),
      at: now - (9 - sampleIndex) * 5 * 60 * 1000,
      error: "",
      demo: true
    };
  }));
  render();
  renderGlobalStatus();
}

function clearDemo() {
  if (!state.demo) return false;
  state.demo = false;
  state.demoHistory = [];
  render();
  renderGlobalStatus();
  return true;
}

function bindEvents() {
  el.start.onclick = startMonitor;
  el.stop.onclick = () => stopMonitor();
  el.runOnce.onclick = () => runSuite("手动");
  el.clear.onclick = () => {
    if (!window.confirm("确定清空全部历史数据和日志？")) return;
    state.history = [];
    state.logs = [];
    state.demo = false;
    state.demoHistory = [];
    saveState();
    render();
    renderGlobalStatus();
  };
  el.clearLog.onclick = () => {
    state.logs = [];
    renderLog();
    saveState();
  };
  el.export.onclick = exportData;
  el.import.onclick = () => el.fileInput.click();
  el.fileInput.onchange = importData;
  el.fetchModels.onclick = fetchModels;
  el.runChecks.onclick = runModelChecks;
  el.copyCheckResult.onclick = () => {
    const report = buildCheckReport();
    if (!report) {
      showToast("请先执行模型检测");
      return;
    }
    navigator.clipboard.writeText(report).then(() => showToast("检测报告已复制")).catch(() => showToast("浏览器未允许复制，请允许剪贴板访问后重试"));
  };
  el.checkModelSelect.onchange = () => {
    if (el.checkModelSelect.value) el.checkModelInput.value = el.checkModelSelect.value;
  };
  ["baseUrl", "models", "interval", "maxTokens", "effort", "timeout", "prompt", "protocol", "transport"].forEach(id => {
    if (!el[id]) return;
    el[id].addEventListener("change", () => {
      if (id === "baseUrl") syncModelSource();
      saveState();
      if (id === "models") renderModelChoices();
      updateProtocolHint();
    });
  });
  el.baseUrl.addEventListener("input", () => { syncModelSource(); notifyState(); });
  el.apiKey.addEventListener("change", saveState);
  el.rememberKey.addEventListener("change", () => {
    if (!el.rememberKey.checked) forgetSavedKey();
    saveState();
  });
  el.models.addEventListener("input", () => { renderModelChoices(); notifyState(); });
  if (el.modelSearch) el.modelSearch.addEventListener("input", () => renderModelChoices());
  if (el.modelPickerList) el.modelPickerList.addEventListener("change", event => {
    const input = event.target;
    if (!input.matches('input[type="checkbox"]') || !state.modelCandidates.includes(input.value)) return;
    if (modelPickerLocked()) { renderModelChoices(); return; }
    const models = selectedModels().filter(model => model !== input.value);
    if (input.checked) models.push(input.value);
    setSelectedModels(models);
  });
  if (el.selectVisibleModels) el.selectVisibleModels.onclick = () => setSelectedModels([...selectedModels(), ...state.modelMatches]);
  if (el.clearSelectedModels) el.clearSelectedModels.onclick = () => setSelectedModels([]);
  if (el.modelEditorToggle && el.modelEditor) {
    el.modelEditorToggle.setAttribute("aria-controls", "modelEditor");
    el.modelEditorToggle.setAttribute("aria-expanded", String(!el.modelEditor.hidden));
    el.modelEditorToggle.onclick = () => {
      el.modelEditor.hidden = !el.modelEditor.hidden;
      el.modelEditorToggle.setAttribute("aria-expanded", String(!el.modelEditor.hidden));
      if (!el.modelEditor.hidden) el.models.focus();
    };
  }

  const resizeObserver = new ResizeObserver(() => renderCharts(modelStats()));
  resizeObserver.observe(el.ttftChart);
  resizeObserver.observe(el.tpsChart);
  window.addEventListener("resize", render);
}

readElements();
bindEvents();
loadState();
window.ApiMonitor = { render, loadDemo, clearDemo };
