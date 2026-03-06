const NYAA_HOST = "https://sukebei.nyaa.si";
const DEFAULT_FILTERS = {
  minSizeGB: 4,
  maxSizeGB: 20,
  includeTitleTokens: ["中文字幕", "[FHDC]", "[HD]"],
  excludeTitleTokens: ["[4K]", "[720P]"]
};

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/popup.html") });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FETCH_MAGNETS") {
    return;
  }

  fetchBatch(message.codes, message.filters || {})
    .then((results) => sendResponse({ ok: true, results }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));

  return true;
});

async function fetchBatch(rawCodes = [], filters = {}) {
  const codes = [...new Set(rawCodes.map(normalizeCode).filter(Boolean))];
  const results = [];

  for (const code of codes) {
    try {
      const result = await fetchSingleCode(code, filters);
      results.push(result);
    } catch (error) {
      results.push({
        code,
        status: "error",
        source: "",
        allMatches: [],
        magnets: [],
        selected: null,
        message: String(error)
      });
    }
  }

  return results;
}

async function fetchSingleCode(code, filters) {
  const normalizedFilters = normalizeFilterSettings(filters);
  const queryCandidates = buildQueryCandidates(code);
  const filterDesc = describeFilters(normalizedFilters);
  const { minSizeBytes, maxSizeBytes } = getSizeRangeBytes(normalizedFilters);

  for (const query of queryCandidates) {
    const url = `${NYAA_HOST}/?f=0&c=0_0&q=${encodeURIComponent(query)}&s=seeders&o=desc`;
    const html = await tryFetchText(url);
    if (!html) {
      continue;
    }

    const allMatches = extractEntriesByCode(html, code);
    if (!allMatches.length) {
      continue;
    }

    const filtered = applyFilters(allMatches, code, normalizedFilters);
    const selected = filtered[0] || null;
    const inRangeSelected = selected && isSelectedSizeInRange(selected, minSizeBytes, maxSizeBytes) ? selected : null;
    const debugLogs = buildDebugLogs(code, allMatches, normalizedFilters, inRangeSelected);
    const status = inRangeSelected ? "ok" : "filtered_out";

    return {
      code,
      status,
      source: url,
      allMatches,
      magnets: filtered.map((item) => item.magnet),
      selected: inRangeSelected,
      debugLogs,
      message: inRangeSelected
        ? `匹配 ${allMatches.length} 条，筛选后 ${filtered.length} 条；规则：${filterDesc}`
        : `匹配 ${allMatches.length} 条，但 selected_size 与区间不匹配或被筛选过滤；规则：${filterDesc}`
    };
  }

  return {
    code,
    status: "not_found",
    source: "",
    allMatches: [],
    magnets: [],
    selected: null,
    debugLogs: [],
    message: `未找到匹配记录；规则：${filterDesc}`
  };
}

function normalizeCode(input) {
  return String(input || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function buildQueryCandidates(code) {
  const pureCode = code.replace(/[^A-Z0-9]/g, "");
  return [...new Set([code, pureCode].filter(Boolean))];
}

async function tryFetchText(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit"
    });

    if (!response.ok) {
      return "";
    }

    return await response.text();
  } catch {
    return "";
  }
}

function extractEntriesByCode(html, code) {
  const normalizedCode = normalizeForMatch(code);
  const entries = [];
  const rowPattern = /<tr[\s\S]*?<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(html))) {
    const rowHtml = rowMatch[0];
    const title = extractTitleFromRow(rowHtml);
    const magnet = extractMagnetFromRow(rowHtml);
    const sizeText = extractSizeTextFromRow(rowHtml);

    if (!title || !magnet) {
      continue;
    }

    if (!normalizeForMatch(title).includes(normalizedCode)) {
      continue;
    }

    const decodedMagnet = decodeHtmlEntity(magnet);
    const sizeBytes = parseSizeToBytes(sizeText);
    entries.push({
      title,
      magnet: decodedMagnet,
      sizeText,
      sizeBytes
    });
  }

  return dedupeEntries(entries);
}

function extractTitleFromRow(rowHtml) {
  const titleMatch = rowHtml.match(/href=["']\/view\/\d+["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!titleMatch) {
    return "";
  }

  return decodeHtmlEntity(stripHtml(titleMatch[1])).trim();
}

function extractMagnetFromRow(rowHtml) {
  const magnetMatch = rowHtml.match(/href=["'](magnet:\?[^"']+)["']/i);
  return magnetMatch ? magnetMatch[1] : "";
}

function extractSizeTextFromRow(rowHtml) {
  const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripHtml(m[1]).trim());
  for (const cell of cells) {
    if (/\b\d+(?:\.\d+)?\s*(?:K|M|G|T)i?B\b/i.test(cell)) {
      return cell;
    }
  }
  return "";
}

function applyFilters(entries, code, filters) {
  const { minSizeBytes, maxSizeBytes } = getSizeRangeBytes(filters);
  const includeTokens = filters.includeTitleTokens || [];
  const excludeTokens = filters.excludeTitleTokens || [];

  let filtered = entries.filter((item) => isSelectedSizeInRange(item, minSizeBytes, maxSizeBytes));
  filtered = filtered.filter((item) => !hasExcludedTitleToken(item.title, excludeTokens));

  return filtered.sort((a, b) => {
    const aPriority = getTitlePriorityScore(a.title, includeTokens);
    const bPriority = getTitlePriorityScore(b.title, includeTokens);
    if (aPriority !== bPriority) {
      return bPriority - aPriority;
    }
    return b.sizeBytes - a.sizeBytes;
  });
}

function describeFilters(filters) {
  const { safeMin, safeMax } = getSizeRangeGB(filters);
  const include = filters.includeTitleTokens.length ? filters.includeTitleTokens.join("/") : "none";
  const exclude = filters.excludeTitleTokens.length ? filters.excludeTitleTokens.join("/") : "none";
  return `selected_size ${safeMin}~${safeMax} GB, include=${include}, exclude=${exclude}`;
}

function getSizeRangeGB(filters) {
  const minSizeGB = Number.isFinite(Number(filters.minSizeGB)) ? Number(filters.minSizeGB) : DEFAULT_FILTERS.minSizeGB;
  const maxSizeGB = Number.isFinite(Number(filters.maxSizeGB)) ? Number(filters.maxSizeGB) : DEFAULT_FILTERS.maxSizeGB;
  const safeMin = Math.max(0, minSizeGB);
  const safeMax = Math.max(safeMin, maxSizeGB);
  return { safeMin, safeMax };
}

function getSizeRangeBytes(filters) {
  const { safeMin, safeMax } = getSizeRangeGB(filters);
  return {
    minSizeBytes: gbToBytes(safeMin),
    maxSizeBytes: gbToBytes(safeMax)
  };
}

function normalizeFilterSettings(filters) {
  const merged = {
    ...DEFAULT_FILTERS,
    ...(filters || {})
  };
  const { safeMin, safeMax } = getSizeRangeGB(merged);
  return {
    minSizeGB: Number(safeMin.toFixed(1)),
    maxSizeGB: Number(safeMax.toFixed(1)),
    includeTitleTokens: normalizeTokenList(merged.includeTitleTokens, ["中文字幕", "[FHDC]", "[HD]"]),
    excludeTitleTokens: normalizeTokenList(merged.excludeTitleTokens, ["[4K]", "[720P]"])
  };
}

function isSelectedSizeInRange(item, minSizeBytes, maxSizeBytes) {
  const sizeFromSelectedField = parseSizeToBytes(item.sizeText);
  return sizeFromSelectedField >= minSizeBytes && sizeFromSelectedField <= maxSizeBytes;
}

function hasExcludedTitleToken(title, tokens) {
  const text = normalizeTitleText(title);
  return tokens.some((token) => text.includes(normalizeTokenText(token)));
}

function getTitlePriorityScore(title, tokens) {
  const text = normalizeTitleText(title);
  if (!tokens.length) {
    return 0;
  }

  // Earlier token in config gets higher weight.
  let score = 0;
  const total = tokens.length;
  tokens.forEach((token, index) => {
    if (text.includes(normalizeTokenText(token))) {
      score += (total - index) * 100;
    }
  });
  return score;
}

function buildDebugLogs(code, entries, filters, selected) {
  const { minSizeBytes, maxSizeBytes } = getSizeRangeBytes(filters);
  const includeTokens = filters.includeTitleTokens || [];
  const excludeTokens = filters.excludeTitleTokens || [];
  const selectedMagnet = selected ? selected.magnet : "";

  return entries.map((item, index) => {
    const inSizeRange = isSelectedSizeInRange(item, minSizeBytes, maxSizeBytes);
    const excluded = hasExcludedTitleToken(item.title, excludeTokens);
    const priorityScore = getTitlePriorityScore(item.title, includeTokens);
    const pass = inSizeRange && !excluded;
    const isSelected = selectedMagnet && item.magnet === selectedMagnet;

    let reason = "selected";
    if (!inSizeRange) {
      reason = "size_out_of_range";
    } else if (excluded) {
      reason = "title_excluded";
    } else if (!isSelected) {
      reason = "not_selected_by_priority";
    }

    return {
      code,
      index: index + 1,
      title: item.title,
      sizeText: item.sizeText,
      priorityScore,
      inSizeRange,
      excluded,
      pass,
      selected: Boolean(isSelected),
      reason
    };
  });
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

function gbToBytes(gbValue) {
  return Number(gbValue) * 1024 ** 3;
}

function normalizeTitleText(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeTokenText(token) {
  return String(token || "")
    .toUpperCase()
    .replace(/\s+/g, "");
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

function dedupeEntries(entries) {
  const seen = new Set();
  const out = [];

  for (const item of entries) {
    if (seen.has(item.magnet)) {
      continue;
    }
    seen.add(item.magnet);
    out.push(item);
  }

  return out;
}

function normalizeForMatch(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function stripHtml(text) {
  return String(text || "").replace(/<[^>]+>/g, "");
}

function decodeHtmlEntity(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&#58;/g, ":");
}
