const STORAGE_KEYS = {
  SETTINGS: "magnet_fetcher_settings",
  HISTORY: "magnet_fetcher_history"
};

const DEFAULT_SETTINGS = {
  minSizeGB: 4,
  maxSizeGB: 20,
  includeTitleTokens: ["中文字幕", "[FHDC]", "[HD]"],
  excludeTitleTokens: ["[4K]", "[720P]"]
};

const HISTORY_LIMIT = 500;

const codesEl = document.getElementById("codes");
const fetchBtn = document.getElementById("fetchBtn");
const copyBtn = document.getElementById("copyBtn");
const copyMagnetsBtn = document.getElementById("copyMagnetsBtn");
const statusEl = document.getElementById("status");
const resultTable = document.getElementById("resultTable");
const tbody = resultTable.querySelector("tbody");
const debugTable = document.getElementById("debugTable");
const debugTbody = debugTable.querySelector("tbody");
const debugEmptyEl = document.getElementById("debugEmpty");

const minSizeEl = document.getElementById("minSize");
const maxSizeEl = document.getElementById("maxSize");
const titleIncludeChineseEl = document.getElementById("titleIncludeChinese");
const titleIncludeFHDCEl = document.getElementById("titleIncludeFHDC");
const titleIncludeHDEl = document.getElementById("titleIncludeHD");
const titleExclude4kEl = document.getElementById("titleExclude4k");
const titleExclude720pEl = document.getElementById("titleExclude720p");
const activeRuleEl = document.getElementById("activeRule");

const historyTable = document.getElementById("historyTable");
const historyTbody = historyTable.querySelector("tbody");
const historyEmptyEl = document.getElementById("historyEmpty");
const exportHistoryBtn = document.getElementById("exportHistoryBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

let lastResults = [];
let historyList = [];

init().catch((error) => {
  renderStatus(`初始化失败：${String(error)}`, true);
});

fetchBtn.addEventListener("click", onFetch);
copyBtn.addEventListener("click", onCopy);
copyMagnetsBtn.addEventListener("click", onCopyMagnets);
exportHistoryBtn.addEventListener("click", onExportHistory);
clearHistoryBtn.addEventListener("click", onClearHistory);
minSizeEl.addEventListener("input", onSettingChanged);
maxSizeEl.addEventListener("input", onSettingChanged);
titleIncludeChineseEl.addEventListener("change", onSettingChanged);
titleIncludeFHDCEl.addEventListener("change", onSettingChanged);
titleIncludeHDEl.addEventListener("change", onSettingChanged);
titleExclude4kEl.addEventListener("change", onSettingChanged);
titleExclude720pEl.addEventListener("change", onSettingChanged);

async function init() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.HISTORY]);
  const settings = normalizeSettings(data[STORAGE_KEYS.SETTINGS]);
  applySettingsToUI(settings);

  historyList = Array.isArray(data[STORAGE_KEYS.HISTORY]) ? data[STORAGE_KEYS.HISTORY] : [];
  historyList = sortHistory(historyList);
  renderHistory(historyList);
}

async function onFetch() {
  const codes = parseCodes(codesEl.value);
  if (!codes.length) {
    renderStatus("请先输入番号（每行一个）", true);
    return;
  }

  const settings = await saveSettingsFromUI();
  setLoading(true);
  renderStatus(`正在抓取 ${codes.length} 个番号... 规则：${formatRuleText(settings)}`);

  const response = await chrome.runtime.sendMessage({
    type: "FETCH_MAGNETS",
    codes,
    filters: settings
  });

  setLoading(false);

  if (!response?.ok) {
    renderStatus(`抓取失败：${response?.error || "未知错误"}`, true);
    return;
  }

  lastResults = enforceSelectedSizeRange(response.results, settings);
  renderTable(lastResults);
  renderDebugLogs(lastResults);

  const okCount = lastResults.filter((item) => item.status === "ok").length;
  const filteredOutCount = lastResults.filter((item) => item.status === "filtered_out").length;
  renderStatus(`完成：成功 ${okCount}/${lastResults.length}，被筛选过滤 ${filteredOutCount}`);
  copyBtn.disabled = false;
  copyMagnetsBtn.disabled = false;

  await persistHistory(lastResults, settings);
}

function onCopy() {
  if (!lastResults.length) {
    return;
  }

  const lines = ["code\tstatus\tmatch_count\tselected_size\tselected_title\tselected_magnet"];
  for (const item of lastResults) {
    const selected = item.selected || null;
    lines.push([
      item.code,
      item.status,
      item.allMatches?.length || 0,
      selected?.sizeText || "",
      selected?.title || "",
      selected?.magnet || ""
    ].join("\t"));
  }

  navigator.clipboard.writeText(lines.join("\n"))
    .then(() => renderStatus("结果已复制到剪贴板"))
    .catch(() => renderStatus("复制失败，请检查浏览器权限", true));
}

function onCopyMagnets() {
  if (!lastResults.length) {
    return;
  }

  const magnets = [...new Set(
    lastResults
      .map((item) => item.selected?.magnet || "")
      .filter(Boolean)
  )];

  if (!magnets.length) {
    renderStatus("当前没有可复制的磁力链接", true);
    return;
  }

  navigator.clipboard.writeText(magnets.join("\n"))
    .then(() => renderStatus(`已复制 ${magnets.length} 条磁力链接`))
    .catch(() => renderStatus("复制失败，请检查浏览器权限", true));
}

async function onSettingChanged() {
  await saveSettingsFromUI();
}

function onExportHistory() {
  if (!historyList.length) {
    renderStatus("暂无可导出的历史记录", true);
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    count: historyList.length,
    items: historyList
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const fileDate = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `magnet-history-${fileDate}.json`;
  a.click();
  URL.revokeObjectURL(url);
  renderStatus(`历史已导出，共 ${historyList.length} 条`);
}

async function onClearHistory() {
  if (!historyList.length) {
    renderStatus("当前没有可清除的历史", true);
    return;
  }

  const confirmed = window.confirm(`确认清除全部历史记录吗？当前共 ${historyList.length} 条。`);
  if (!confirmed) {
    return;
  }

  historyList = [];
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: historyList });
  renderHistory(historyList);
  renderStatus("历史记录已清除");
}

function parseCodes(raw) {
  return [...new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\s+/g, "").toUpperCase())
      .filter(Boolean)
  )];
}

function renderTable(results) {
  tbody.textContent = "";

  for (const item of results) {
    const tr = document.createElement("tr");

    const codeTd = document.createElement("td");
    codeTd.textContent = item.code;

    const statusTd = document.createElement("td");
    statusTd.textContent = formatStatus(item.status);
    if (item.message) {
      statusTd.title = item.message;
    }

    const sizeTd = document.createElement("td");
    sizeTd.textContent = item.selected?.sizeText || "";

    const selectedTd = document.createElement("td");
    selectedTd.textContent = item.selected?.magnet || "";

    const countTd = document.createElement("td");
    countTd.textContent = String(item.allMatches?.length || 0);

    tr.append(codeTd, statusTd, sizeTd, selectedTd, countTd);
    tbody.appendChild(tr);
  }

  resultTable.hidden = false;
}

function renderDebugLogs(results) {
  const logs = [];
  for (const item of results) {
    const rows = Array.isArray(item.debugLogs) && item.debugLogs.length
      ? item.debugLogs
      : buildFallbackDebugLogs(item);
    logs.push(...rows);
  }

  debugTbody.textContent = "";
  if (!logs.length) {
    debugTable.hidden = true;
    debugEmptyEl.hidden = false;
    return;
  }

  debugEmptyEl.hidden = true;
  debugTable.hidden = false;

  for (const log of logs) {
    const tr = document.createElement("tr");
    tr.append(
      createCell(log.code),
      createCell(String(log.index)),
      createCell(log.sizeText || ""),
      createCell(String(log.priorityScore || 0)),
      createCell(formatDebugReason(log.reason)),
      createCell(log.title || "")
    );
    debugTbody.appendChild(tr);
  }
}

function buildFallbackDebugLogs(item) {
  const code = item?.code || "";
  const allMatches = Array.isArray(item?.allMatches) ? item.allMatches : [];

  if (allMatches.length) {
    return allMatches.map((candidate, idx) => ({
      code,
      index: idx + 1,
      sizeText: candidate?.sizeText || "",
      priorityScore: 0,
      reason: "no_debug_from_worker",
      title: candidate?.title || ""
    }));
  }

  return [{
    code,
    index: 1,
    sizeText: "",
    priorityScore: 0,
    reason: item?.status === "not_found" ? "not_found" : "no_candidates",
    title: item?.message || ""
  }];
}

function formatStatus(status) {
  if (status === "ok") {
    return "成功";
  }
  if (status === "filtered_out") {
    return "已过滤";
  }
  if (status === "not_found") {
    return "未找到";
  }
  if (status === "error") {
    return "错误";
  }
  return status || "";
}

function formatDebugReason(reason) {
  if (reason === "selected") {
    return "selected";
  }
  if (reason === "size_out_of_range") {
    return "size_out_of_range";
  }
  if (reason === "title_excluded") {
    return "title_excluded";
  }
  if (reason === "not_selected_by_priority") {
    return "not_selected_by_priority";
  }
  if (reason === "no_debug_from_worker") {
    return "no_debug_from_worker";
  }
  if (reason === "not_found") {
    return "not_found";
  }
  if (reason === "no_candidates") {
    return "no_candidates";
  }
  return reason || "";
}

async function persistHistory(results, settings) {
  const now = new Date().toISOString();
  const newRows = results.map((item) => ({
    timestamp: now,
    code: item.code,
    status: item.status,
    source: item.source || "",
    selectedMagnet: item.selected?.magnet || "",
    selectedTitle: item.selected?.title || "",
    selectedSize: item.selected?.sizeText || "",
    matchCount: item.allMatches?.length || 0,
    filters: settings
  }));

  historyList = sortHistory([...newRows, ...historyList]).slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: historyList });
  renderHistory(historyList);
}

function renderHistory(rows) {
  historyTbody.textContent = "";

  if (!rows.length) {
    historyTable.hidden = true;
    historyEmptyEl.hidden = false;
    return;
  }

  historyEmptyEl.hidden = true;
  historyTable.hidden = false;

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(
      createCell(formatTime(row.timestamp)),
      createCell(row.code),
      createCell(formatStatus(row.status)),
      createCell(row.selectedSize || ""),
      createCell(row.selectedMagnet || "")
    );
    historyTbody.appendChild(tr);
  }
}

function createCell(value) {
  const td = document.createElement("td");
  td.textContent = value || "";
  return td;
}

function setLoading(loading) {
  fetchBtn.disabled = loading;
}

function renderStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function readSettingsFromUI() {
  const raw = {
    minSizeGB: Number(minSizeEl.value),
    maxSizeGB: Number(maxSizeEl.value),
    includeTitleTokens: readIncludedTokens(),
    excludeTitleTokens: readExcludedTokens()
  };
  return normalizeSettings(raw);
}

function enforceSelectedSizeRange(results, settings) {
  const normalized = normalizeSettings(settings);
  const min = normalized.minSizeGB;
  const max = normalized.maxSizeGB;
  const minBytes = gbToBytes(min);
  const maxBytes = gbToBytes(max);

  return results.map((item) => {
    const selectedSizeText = item?.selected?.sizeText || "";
    const sizeBytes = parseSizeToBytes(selectedSizeText);
    const inRange = sizeBytes >= minBytes && sizeBytes <= maxBytes;

    if (item.status === "ok" && !inRange) {
      return {
        ...item,
        status: "filtered_out",
        selected: null,
        magnets: [],
        message: `selected_size(${selectedSizeText || "N/A"}) 不在区间 ${min}~${max} GB`
      };
    }

    return item;
  });
}

function applySettingsToUI(settings) {
  const normalized = normalizeSettings(settings);
  minSizeEl.value = String(normalized.minSizeGB);
  maxSizeEl.value = String(normalized.maxSizeGB);
  titleIncludeChineseEl.checked = normalized.includeTitleTokens.includes("中文字幕");
  titleIncludeFHDCEl.checked = normalized.includeTitleTokens.includes("[FHDC]");
  titleIncludeHDEl.checked = normalized.includeTitleTokens.includes("[HD]");
  titleExclude4kEl.checked = normalized.excludeTitleTokens.includes("[4K]");
  titleExclude720pEl.checked = normalized.excludeTitleTokens.includes("[720P]");
  renderActiveRule(normalized);
}

async function saveSettingsFromUI() {
  const settings = readSettingsFromUI();
  minSizeEl.value = String(settings.minSizeGB);
  maxSizeEl.value = String(settings.maxSizeGB);
  renderActiveRule(settings);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  return settings;
}

function normalizeSettings(settings) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(settings || {})
  };

  const minSizeGB = Number.isFinite(Number(merged.minSizeGB)) ? Number(merged.minSizeGB) : DEFAULT_SETTINGS.minSizeGB;
  const maxSizeGB = Number.isFinite(Number(merged.maxSizeGB)) ? Number(merged.maxSizeGB) : DEFAULT_SETTINGS.maxSizeGB;
  const safeMin = Math.max(0, minSizeGB);
  const safeMax = Math.max(safeMin, maxSizeGB);

  return {
    minSizeGB: Number(safeMin.toFixed(1)),
    maxSizeGB: Number(safeMax.toFixed(1)),
    includeTitleTokens: normalizeTokenList(merged.includeTitleTokens, ["中文字幕", "[FHDC]", "[HD]"]),
    excludeTitleTokens: normalizeTokenList(merged.excludeTitleTokens, ["[4K]", "[720P]"])
  };
}

function renderActiveRule(settings) {
  const include = settings.includeTitleTokens.length ? settings.includeTitleTokens.join(", ") : "无";
  const exclude = settings.excludeTitleTokens.length ? settings.excludeTitleTokens.join(", ") : "无";
  activeRuleEl.textContent = `当前生效规则：selected_size ${settings.minSizeGB}~${settings.maxSizeGB} GB，优先=${include}，屏蔽=${exclude}`;
}

function formatRuleText(settings) {
  const include = settings.includeTitleTokens.length ? settings.includeTitleTokens.join("/") : "none";
  const exclude = settings.excludeTitleTokens.length ? settings.excludeTitleTokens.join("/") : "none";
  return `selected_size ${settings.minSizeGB}~${settings.maxSizeGB} GB, include=${include}, exclude=${exclude}`;
}

function readIncludedTokens() {
  const tokens = [];
  if (titleIncludeChineseEl.checked) {
    tokens.push("中文字幕");
  }
  if (titleIncludeFHDCEl.checked) {
    tokens.push("[FHDC]");
  }
  if (titleIncludeHDEl.checked) {
    tokens.push("[HD]");
  }
  return tokens;
}

function readExcludedTokens() {
  const tokens = [];
  if (titleExclude4kEl.checked) {
    tokens.push("[4K]");
  }
  if (titleExclude720pEl.checked) {
    tokens.push("[720P]");
  }
  return tokens;
}

function normalizeTokenList(input, allowed) {
  const allowedSet = new Set(allowed);
  const source = Array.isArray(input) ? input : [];
  const normalized = source
    .map((v) => String(v || "").toUpperCase())
    .map((v) => {
      if (v === "中文字幕") {
        return "中文字幕";
      }
      return v;
    })
    .filter((v) => allowedSet.has(v));
  return [...new Set(normalized)];
}

function sortHistory(rows) {
  return [...rows].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function formatTime(value) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return value || "";
  }
  return time.toLocaleString();
}

function gbToBytes(gbValue) {
  return Number(gbValue) * 1024 ** 3;
}

function parseSizeToBytes(sizeText) {
  const match = String(sizeText || "")
    .trim()
    .toUpperCase()
    .match(/(\d+(?:\.\d+)?)\s*([KMGT])(?:I?B)?/i);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const factor = {
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4
  }[unit] || 1;

  return Math.round(value * factor);
}
