import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { promises as dnsPromises } from "node:dns";

const maximumRequestBytes = 65536;
const maximumModelLength = 200;
const maximumPromptCharacters = 32000;
const maximumUpstreamMilliseconds = 55000;
const maximumOutputTokens = 8192;
const rateLimitPerMinute = 30;
const maximumActiveRequestsPerIp = 2;
const maximumTrackedIps = 5000;

const endpointDefinitions = {
  "models": { method: "GET", path: "/models" },
  "responses": { method: "POST", path: "/responses" },
  "chat/completions": { method: "POST", path: "/chat/completions" },
  "messages": { method: "POST", path: "/messages" }
};

const rateLimitsByIp = new Map();
const activeRequestsByIp = new Map();

function isJsonRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(status, message, headers = {}) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Qingce-Error": "relay",
        ...headers
      }
    }
  );
}

function addressToBigint(address) {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets.reduce((total, octet) => total * 256n + BigInt(octet), 0n);
  }

  const normalizedAddress = address.replace(/^\[|\]$/g, "");
  const mappedMatch = normalizedAddress.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) {
    return addressToBigint(mappedMatch[1]);
  }

  const sections = normalizedAddress.split("::");
  if (sections.length > 2) {
    return null;
  }

  const leftParts = sections[0] === "" ? [] : sections[0].split(":");
  const rightParts = sections.length === 2
    ? (sections[1] === "" ? [] : sections[1].split(":"))
    : [];
  if (sections.length === 2) {
    const missingParts = 8 - leftParts.length - rightParts.length;
    if (missingParts < 1) {
      return null;
    }
  }

  const parts = [
    ...leftParts,
    ...Array.from(
      { length: sections.length === 2 ? 8 - leftParts.length - rightParts.length : 0 },
      () => "0"
    ),
    ...rightParts
  ];
  if (parts.length !== 8) {
    return null;
  }

  let result = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) {
      return null;
    }
    result = result * 65536n + BigInt(parseInt(part, 16));
  }
  return result;
}

function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  const [first, second, third] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 0 && (third === 0 || third === 2)) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 192 && second === 88 && third === 99) {
    return true;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return true;
  }
  if (first === 198 && second === 51 && third === 100) {
    return true;
  }
  if (first === 203 && second === 0 && third === 113) {
    return true;
  }
  return first >= 240 && address !== "255.255.255.255";
}

function isPrivateIpv6(address) {
  const value = addressToBigint(address);
  if (value === null) {
    return true;
  }
  const ipv4MappedMask = 0xffffffffffffffffffffffff00000000n;
  const uniqueLocalStart = 0xfc000000000000000000000000000000n;
  const uniqueLocalEnd = 0xfdffffffffffffffffffffffffffffffffn;
  const linkLocalStart = 0xfe800000000000000000000000000000n;
  const linkLocalEnd = 0xfebfffffffffffffffffffffffffffffn;
  const multicastStart = 0xff000000000000000000000000000000n;
  const documentationPrefix = 0x20010db8n << 96n;
  const documentationPrefixMask = ((1n << 32n) - 1n) << 96n;

  if (value === 0n || value === 1n) {
    return true;
  }
  if ((value & ipv4MappedMask) === 0n) {
    return true;
  }
  if (value >= uniqueLocalStart && value <= uniqueLocalEnd) {
    return true;
  }
  if (value >= linkLocalStart && value <= linkLocalEnd) {
    return true;
  }
  if (value >= multicastStart) {
    return true;
  }
  if ((value & documentationPrefixMask) === documentationPrefix) {
    return true;
  }
  if (value < (0x2000n << 112n) || value >= (0x4000n << 112n)) return true;
  if ((value >> 112n) === 0x2002n || (value >> 96n) === 0x20010000n) return true;
  if ((value >> 108n) === 0x3fff0n) return true;
  return false;
}

function isPrivateAddress(address) {
  const addressFamily = isIP(address);
  if (addressFamily === 4) {
    return isPrivateIpv4(address);
  }
  if (addressFamily === 6) {
    return isPrivateIpv6(address);
  }
  return true;
}

function isPublicHostname(hostname) {
  if (isIP(hostname) !== 0 || hostname.endsWith(".") || hostname.length > 253) {
    return false;
  }
  const normalizedHostname = hostname.toLowerCase();
  const blockedSuffixes = [".localhost", ".local", ".internal", ".home", ".lan"];
  if (normalizedHostname === "localhost" || blockedSuffixes.some((suffix) => normalizedHostname.endsWith(suffix))) {
    return false;
  }
  const labels = normalizedHostname.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63)) {
    return false;
  }
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function normalizeBaseUrl(input) {
  let targetUrl;
  try {
    targetUrl = new URL(input);
  } catch {
    return null;
  }

  if (targetUrl.protocol !== "https:" || targetUrl.username || targetUrl.password || targetUrl.search || targetUrl.hash) {
    return null;
  }
  if (!isPublicHostname(targetUrl.hostname)) {
    return null;
  }
  if (targetUrl.port !== "" && targetUrl.port !== "443") {
    return null;
  }

  targetUrl.port = "";
  targetUrl.pathname = targetUrl.pathname.replace(/\/+$/, "") || "/v1";
  if (!targetUrl.pathname.endsWith("/v1")) {
    targetUrl.pathname = `${targetUrl.pathname}/v1`;
  }
  return targetUrl;
}

async function resolvePublicAddresses(hostname) {
  let timeoutHandle;
  let records;
  try {
    records = await Promise.race([
      dnsPromises.lookup(hostname, { all: true, verbatim: true }),
      new Promise((resolve, reject) => { timeoutHandle = setTimeout(() => reject(new Error("域名解析超时")), 5000); })
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (records.length === 0 || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("目标域名没有可用的公网地址");
  }
  return records;
}

function createPinnedLookup(targetRecords) {
  return function pinnedLookup(hostname, options, callback) {
    const requestedFamily = options?.family ?? 0;
    const selectedRecords = requestedFamily === 4
      ? targetRecords.filter((record) => record.family === 4)
      : requestedFamily === 6
        ? targetRecords.filter((record) => record.family === 6)
        : targetRecords;

    if (selectedRecords.length === 0) {
      callback(new Error("没有匹配的已解析公网地址"));
      return;
    }
    if (options?.all) {
      callback(null, selectedRecords);
      return;
    }
    callback(null, selectedRecords[0].address, selectedRecords[0].family);
  };
}

function validateModel(model) {
  if (typeof model !== "string" || model.trim().length === 0 || model.length > maximumModelLength) {
    return `model 必须是 1 到 ${maximumModelLength} 个字符的非空字符串。`;
  }
  if (/[\u0000-\u001f\u007f]/.test(model)) {
    return "model 不能包含控制字符。";
  }
  return null;
}

function validatePrompt(prompt, fieldName) {
  if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > maximumPromptCharacters) {
    return `${fieldName} 必须是 1 到 ${maximumPromptCharacters} 个字符的非空字符串。`;
  }
  return null;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length !== 1) {
    return "messages 必须是仅包含一条用户消息的数组。";
  }
  const message = messages[0];
  if (!isJsonRecord(message) || Object.keys(message).length !== 2) {
    return "messages 只允许 role 和 content 字段。";
  }
  if (message.role !== "user") {
    return "messages 只支持一条 role 为 user 的消息。";
  }
  return validatePrompt(message.content, "messages[0].content");
}

function buildRelayRequest(baseUrl, endpoint, payload) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { error: "Base URL 必须是 https 公网域名，只能使用 443 端口，并且不能包含用户名、密码、查询或片段。" };
  }

  const definition = endpointDefinitions[endpoint];
  if (!definition) {
    return { error: "endpoint 只支持 models、responses、chat/completions 或 messages。" };
  }

  if (definition.method === "GET") {
    if (payload !== null) {
      return { error: "models 请求不能携带 payload。" };
    }
    return { definition, targetUrl: new URL(`${normalizedBaseUrl.href}${definition.path}`) };
  }

  if (!isJsonRecord(payload) || payload.stream !== true || Object.keys(payload).length === 0) {
    return { error: "POST 请求必须使用 stream: true 的 JSON 对象。" };
  }

  const modelError = validateModel(payload.model);
  if (modelError) {
    return { error: modelError };
  }

  const tokenField = endpoint === "responses" ? "max_output_tokens" : "max_tokens";
  const maximumTokens = payload[tokenField];
  if (typeof maximumTokens !== "number" || !Number.isInteger(maximumTokens) || maximumTokens < 1 || maximumTokens > maximumOutputTokens) {
    return { error: `${tokenField} 必须是 1 到 ${maximumOutputTokens} 的整数。` };
  }

  if (endpoint === "responses") {
    const promptError = validatePrompt(payload.input, "input");
    if (promptError) {
      return { error: promptError };
    }
    const allowedKeys = payload.reasoning === undefined
      ? ["model", "input", "max_output_tokens", "stream"]
      : ["model", "input", "max_output_tokens", "stream", "reasoning"];
    if (Object.keys(payload).some((key) => !allowedKeys.includes(key))) {
      return { error: "responses 请求只允许 model、input、max_output_tokens、stream 和 reasoning.effort。" };
    }
    if (payload.reasoning !== undefined) {
      if (!isJsonRecord(payload.reasoning) || Object.keys(payload.reasoning).length !== 1) {
        return { error: "reasoning 只允许 effort 字段。" };
      }
      if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(payload.reasoning.effort)) {
        return { error: "reasoning.effort 无效；具体可用档位由上游模型决定。" };
      }
    }
    return { definition, targetUrl: new URL(`${normalizedBaseUrl.href}${definition.path}`) };
  }

  const messagesError = validateMessages(payload.messages);
  if (messagesError) {
    return { error: messagesError };
  }
  if (Object.keys(payload).some((key) => !["model", "max_tokens", "stream", "messages"].includes(key))) {
    return { error: "chat 或 messages 请求只允许 model、max_tokens、stream 和 messages。" };
  }
  return { definition, targetUrl: new URL(`${normalizedBaseUrl.href}${definition.path}`) };
}

function isAllowedOrigin(request) {
  const originHeader = request.headers.get("origin");
  if (!originHeader) {
    return false;
  }
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin") {
    return false;
  }

  let requestOrigin;
  try {
    requestOrigin = new URL(originHeader);
  } catch {
    return false;
  }

  const requestUrl = new URL(request.url);
  return requestOrigin.origin === requestUrl.origin;
}

function getClientIp(request, context = {}) {
  if (typeof context.ip === "string" && isIP(context.ip)) return context.ip;
  const netlifyIp = request.headers.get("x-nf-client-connection-ip")?.trim();
  if (netlifyIp && isIP(netlifyIp)) {
    return netlifyIp;
  }
  return "unknown";
}

function pruneRateLimits(now) {
  for (const [ip, entry] of rateLimitsByIp) {
    if (entry.resetAt <= now) {
      rateLimitsByIp.delete(ip);
    }
  }
  for (const [ip, entry] of activeRequestsByIp) {
    if (entry.expiresAt <= now) {
      activeRequestsByIp.delete(ip);
    }
  }
}

function takeRateLimitSlot(ip) {
  const now = Date.now();
  pruneRateLimits(now);

  if (rateLimitsByIp.size >= maximumTrackedIps && !rateLimitsByIp.has(ip)) {
    return { allowed: false, retryAfter: 60 };
  }

  const rateEntry = rateLimitsByIp.get(ip);
  if (!rateEntry || rateEntry.resetAt <= now) {
    rateLimitsByIp.set(ip, { count: 1, resetAt: now + 60000 });
  } else if (rateEntry.count >= rateLimitPerMinute) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((rateEntry.resetAt - now) / 1000)) };
  } else {
    rateEntry.count += 1;
  }

  return { allowed: true, retryAfter: 0 };
}

function takeActiveSlot(ip) {
  const now = Date.now();
  const entry = activeRequestsByIp.get(ip);
  if (entry && entry.expiresAt > now) {
    if (entry.count >= maximumActiveRequestsPerIp) {
      return null;
    }
    entry.count += 1;
    return () => {
      entry.count -= 1;
      if (entry.count <= 0) {
        activeRequestsByIp.delete(ip);
      }
    };
  }

  const newEntry = { count: 1, expiresAt: now + maximumUpstreamMilliseconds + 10000 };
  activeRequestsByIp.set(ip, newEntry);
  return () => {
    newEntry.count -= 1;
    if (newEntry.count <= 0) {
      activeRequestsByIp.delete(ip);
    }
  };
}

async function requestUpstream(requestDefinition, requestSignal) {
  let timeoutHandle;
  let upstreamRequest;
  let receivedResponse;
  let settled = false;
  const abortRequest = () => upstreamRequest.destroy(new Error("客户端已取消"));
  const dispose = () => {
    clearTimeout(timeoutHandle);
    requestSignal?.removeEventListener("abort", abortRequest);
  };

  return new Promise((resolve, reject) => {
    upstreamRequest = httpsRequest(requestDefinition.options, (upstreamResponse) => {
      receivedResponse = upstreamResponse;
      settled = true;
      resolve({ request: upstreamRequest, response: upstreamResponse, dispose });
    });

    timeoutHandle = setTimeout(() => {
      upstreamRequest.destroy(new Error("上游请求超时"));
    }, requestDefinition.timeoutMs ?? maximumUpstreamMilliseconds);

    upstreamRequest.on("error", (error) => {
      dispose();
      receivedResponse?.destroy(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    if (requestSignal) {
      if (requestSignal.aborted) {
        upstreamRequest.destroy(new Error("客户端已取消"));
      } else {
        requestSignal.addEventListener("abort", abortRequest, { once: true });
      }
    }

    if (requestDefinition.body !== undefined) {
      upstreamRequest.write(requestDefinition.body);
    }
    upstreamRequest.end();
  });
}

function createResponseBody(upstreamResponse, upstreamRequest, cleanup) {
  const nodeReader = Readable.toWeb(upstreamResponse).getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await nodeReader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        cleanup();
        controller.error(new Error("上游响应中断"));
      }
    },
    cancel() {
      cleanup();
      nodeReader.cancel().catch(() => {});
    }
  });
}

async function handler(request, context = {}) {
  const startedAt = Date.now();
  if (request.method !== "POST") {
    return jsonError(405, "只允许 POST 请求。");
  }

  const relayPath = new URL(request.url).pathname;
  if (relayPath !== "/api/relay" && relayPath !== "/.netlify/functions/relay") {
    return jsonError(404, "接口路径无效。");
  }
  if (!isAllowedOrigin(request)) {
    return jsonError(403, "只允许同源页面调用。");
  }
  if (request.headers.has("authorization")) {
    return jsonError(400, "本接口不接受 Cookie 或浏览器凭据。");
  }

  const clientIp = getClientIp(request, context);
  const rateLimit = takeRateLimitSlot(clientIp);
  if (!rateLimit.allowed) {
    return jsonError(429, "请求过于频繁，请稍后再试。", { "Retry-After": String(rateLimit.retryAfter) });
  }

  const releaseActiveSlot = takeActiveSlot(clientIp);
  if (!releaseActiveSlot) {
    return jsonError(429, "同一 IP 的活动请求过多。", { "Retry-After": "10" });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maximumRequestBytes) {
    releaseActiveSlot();
    return jsonError(413, "请求体过大。");
  }

  let requestText;
  try {
    requestText = await request.text();
  } catch {
    releaseActiveSlot();
    return jsonError(400, "无法读取请求体。");
  }
  if (Buffer.byteLength(requestText, "utf8") > maximumRequestBytes) {
    releaseActiveSlot();
    return jsonError(413, "请求体过大。");
  }

  let requestBody;
  try {
    requestBody = JSON.parse(requestText);
  } catch {
    releaseActiveSlot();
    return jsonError(400, "请求体必须是 JSON。");
  }
  if (!isJsonRecord(requestBody)) {
    releaseActiveSlot();
    return jsonError(400, "请求体必须是 JSON 对象。");
  }

  const baseUrl = requestBody.baseUrl;
  const apiKey = requestBody.apiKey;
  const endpoint = requestBody.endpoint;
  const payload = requestBody.payload ?? null;
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 2048) {
    releaseActiveSlot();
    return jsonError(400, "baseUrl 长度无效。");
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0 || apiKey.length > 4096) {
    releaseActiveSlot();
    return jsonError(400, "apiKey 必须是非空字符串。");
  }
  if (/[\r\n]/.test(apiKey)) { releaseActiveSlot(); return jsonError(400, "apiKey 不能包含换行。"); }
  if (requestBody.authMode !== undefined && !["openai", "messages"].includes(requestBody.authMode)) {
    releaseActiveSlot();
    return jsonError(400, "模型列表认证方式无效。");
  }
  if (Object.keys(requestBody).some((key) => !["baseUrl", "apiKey", "endpoint", "payload", "authMode"].includes(key))) {
    releaseActiveSlot();
    return jsonError(400, "请求体只允许 baseUrl、apiKey、endpoint 和 payload。");
  }

  const relayRequest = buildRelayRequest(baseUrl, endpoint, payload);
  if (relayRequest.error) {
    releaseActiveSlot();
    return jsonError(400, relayRequest.error);
  }

  let targetRecords;
  try {
    targetRecords = await resolvePublicAddresses(relayRequest.targetUrl.hostname);
  } catch {
    releaseActiveSlot();
    return jsonError(502, "无法解析目标域名的公网地址。");
  }

  const upstreamHeaders = {
    accept: endpoint === "models" ? "application/json" : "application/json, text/event-stream",
    "accept-encoding": "identity"
  };
  if (endpoint === "messages" || (endpoint === "models" && requestBody.authMode === "messages")) {
    upstreamHeaders["x-api-key"] = apiKey;
    upstreamHeaders["anthropic-version"] = "2023-06-01";
  } else {
    upstreamHeaders.authorization = `Bearer ${apiKey}`;
  }
  if (endpoint !== "models") {
    upstreamHeaders["content-type"] = "application/json";
  }

  const serializedPayload = endpoint === "models" ? undefined : JSON.stringify(payload);
  const requestDefinition = {
    options: {
      method: relayRequest.definition.method,
      hostname: relayRequest.targetUrl.hostname,
      port: 443,
      path: `${relayRequest.targetUrl.pathname}${relayRequest.targetUrl.search}`,
      headers: upstreamHeaders,
      lookup: createPinnedLookup(targetRecords)
    },
    body: serializedPayload
  };
  requestDefinition.timeoutMs = Math.max(1000, maximumUpstreamMilliseconds - (Date.now() - startedAt));

  let upstreamResult;
  try {
    upstreamResult = await requestUpstream(requestDefinition, request.signal);
  } catch {
    releaseActiveSlot();
    return jsonError(502, "无法连接上游 API。");
  }

  const { request: upstreamRequest, response: upstreamResponse, dispose } = upstreamResult;
  if (upstreamResponse.statusCode >= 300 && upstreamResponse.statusCode < 400) {
    upstreamResponse.destroy();
    upstreamRequest.destroy();
    dispose();
    releaseActiveSlot();
    return jsonError(502, "上游 API 返回了不允许的重定向。");
  }

  let released = false;
  const cleanup = () => {
    if (released) {
      return;
    }
    released = true;
    dispose();
    request.signal?.removeEventListener("abort", cleanup);
    upstreamResponse.destroy();
    upstreamRequest.destroy();
    releaseActiveSlot();
  };

  if (request.signal) {
    request.signal.addEventListener("abort", cleanup, { once: true });
  }

  if (upstreamResponse.statusCode === 204) {
    cleanup();
    return jsonError(502, "上游返回空响应。");
  }

  return new Response(createResponseBody(upstreamResponse, upstreamRequest, cleanup), {
    status: upstreamResponse.statusCode,
    headers: new Headers({
      "Cache-Control": "no-store",
      "Content-Type": upstreamResponse.headers["content-type"] ?? (endpoint === "models" ? "application/json" : "text/plain; charset=utf-8"),
      "X-Content-Type-Options": "nosniff"
    })
  });
}

export default handler;
export {
  addressToBigint,
  buildRelayRequest,
  createPinnedLookup,
  getClientIp,
  isAllowedOrigin,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  isPublicHostname,
  normalizeBaseUrl,
  resolvePublicAddresses,
  takeActiveSlot,
  takeRateLimitSlot
};
