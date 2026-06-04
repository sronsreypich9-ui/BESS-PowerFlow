import * as XLSX from "xlsx";
import { getYesterdayCycleFromHistory, saveCycleToHistory } from "./ess20-shared-state";
import { extractDataDate } from "./audit-engine.js";

export type Ess20ProjectId = "SNTB" | "SNTV" | "SNTD_DMF" | "SNTZ" | "MSGP";

export const DEFAULT_YESTERDAY_CYCLES: Record<Ess20ProjectId, number> = {
  SNTV: 179.667,
  SNTB: 499.333,
  SNTZ: 141.5,
  SNTD_DMF: 579.0,
  MSGP: 129.35,
};

export const PROJECT_CAPACITY_MWH: Record<Ess20ProjectId, number> = {
  SNTB: 30,
  SNTV: 12,
  SNTD_DMF: 18,
  SNTZ: 3,
  MSGP: 14
};

export function calculateDailyCycleFromPowerCurve(pMw: number[], capacityMWh: number): number {
  let sumAbsP = 0;
  let count = 0;
  for (const val of pMw) {
    if (Number.isFinite(val) && !Number.isNaN(val)) {
      sumAbsP += Math.abs(val);
      count++;
    }
  }
  if (count === 0) return 0.0;
  const throughputMWh = (sumAbsP / count) * 24;
  return throughputMWh / (capacityMWh * 2);
}

export interface Ess20FileEntry {
  file: File;
  path: string;
}

export interface Ess20ProjectProfile {
  id: Ess20ProjectId;
  label: string;
  title: string;
  subtitle: string;
  outputPrefix: string;
  powerRange: [number, number];
  powerTicks: number[];
  reactiveRange: [number, number];
  reactiveTicks: number[];
  pvMode: "none" | "columns" | "derive";
}

export interface MainSeries {
  times: Date[];
  pMw: number[];
  qMvar: number[];
  soc: number[];
  frequency: number[];
  vab: number[];
  vbc: number[];
  vca: number[];
  vavg: number[];
}

export interface PvSmoothingSeries {
  times: Date[];
  pPccMw: number[];
  pPvMw: number[];
  pEssMw: number[];
  socPct: number[];
}

export interface SmartLoggerSeries {
  times: Date[];
  totalPMw: number[];
  totalQMvar: number[];
}

export interface CycleSeries {
  times: Date[];
  avgCycles: number[];
}

export interface CycleSummary {
  todayAvg: number;
  yesterdayAvg: number;
  dailyAvg: number;
  todayDeviceCount: number;
  yesterdayDeviceCount: number;
  timeline: CycleSeries | null;
}

export interface Ess20Result {
  profile: Ess20ProjectProfile;
  dataDate: string;
  dayTag: string;
  sourceRoot: string;
  files: {
    socVoltage: string;
    activeReactive: string;
    pvSmoothing: string;
    smartLoggerCount: number;
    essTodayCount: number;
    essYesterdayCount: number;
    pcsCount: number;
  };
  main: MainSeries;
  pvs: PvSmoothingSeries | null;
  smartLogger: SmartLoggerSeries | null;
  cycle: CycleSummary;
  warnings: string[];
}

type Aoa = unknown[][];

interface TimedRecord {
  time: Date;
  [key: string]: Date | number;
}

interface ParsedTable {
  headers: string[];
  rows: unknown[][];
  headerRow: number;
}

interface CycleFileData {
  firstCycle: number;
  lastCycle: number;
  rows: { time: Date; cycle: number }[];
}

export const ESS20_PROJECTS: Ess20ProjectProfile[] = [
  {
    id: "SNTB",
    label: "SNTB 30MWH",
    title: "SNTB Daily Vavg Cycle",
    subtitle: "Daily P/F/SOC/Vavg/Q and ESS cycle comparison",
    outputPrefix: "SNTB30MWH",
    powerRange: [-80, 80],
    powerTicks: [-80, -40, 0, 40, 80],
    reactiveRange: [-25, 25],
    reactiveTicks: [-25, -12.5, 0, 12.5, 25],
    pvMode: "none",
  },
  {
    id: "SNTV",
    label: "SNTV 12MWH",
    title: "SNTV Daily V14 Vavg Cycle",
    subtitle: "Adds optional PV smoothing curves from the SNTV data export",
    outputPrefix: "SNTV12MWH",
    powerRange: [-80, 80],
    powerTicks: [-80, -40, 0, 40, 80],
    reactiveRange: [-25, 25],
    reactiveTicks: [-25, -12.5, 0, 12.5, 25],
    pvMode: "columns",
  },
  {
    id: "SNTD_DMF",
    label: "SNTD-DMF 18MWH",
    title: "SNTD-DMF Daily Vavg Cycle",
    subtitle: "Daily P/F/SOC/Vavg/Q and ESS cycle comparison",
    outputPrefix: "SNTD_DMF18MWH",
    powerRange: [-80, 80],
    powerTicks: [-80, -40, 0, 40, 80],
    reactiveRange: [-25, 25],
    reactiveTicks: [-25, -12.5, 0, 12.5, 25],
    pvMode: "columns",
  },
  {
    id: "SNTZ",
    label: "SNTZ 3MWH",
    title: "SNTZ Daily Vavg Cycle",
    subtitle: "10 MW PV plus 3 MWh BESS with derived PV power",
    outputPrefix: "SNTZ",
    powerRange: [-15, 15],
    powerTicks: [-15, -7.5, 0, 7.5, 15],
    reactiveRange: [-25, 25],
    reactiveTicks: [-25, -12.5, 0, 12.5, 25],
    pvMode: "derive",
  },
  {
    id: "MSGP",
    label: "MSGP 14MWH",
    title: "MSGP Daily Vavg Cycle",
    subtitle: "Daily P/F/SOC/Vavg/Q and ESS cycle comparison",
    outputPrefix: "MSGP14MWH",
    powerRange: [-80, 80],
    powerTicks: [-80, -40, 0, 40, 80],
    reactiveRange: [-25, 25],
    reactiveTicks: [-25, -12.5, 0, 12.5, 25],
    pvMode: "columns",
  },
];

export function getEss20Profile(id: Ess20ProjectId) {
  return ESS20_PROJECTS.find((p) => p.id === id) || ESS20_PROJECTS[0];
}

export async function analyzeEss20Project(
  projectId: Ess20ProjectId,
  todayFiles: Ess20FileEntry[],
  yesterdayEssFiles: Ess20FileEntry[],
): Promise<Ess20Result> {
  const profile = getEss20Profile(projectId);
  const warnings: string[] = [];

  // 1. Identify today's SOC/Voltage file to determine today's and yesterday's date bounds
  const normalizedAll = normalizeEntries(todayFiles);
  const socEntry = findSocVoltageFile(profile, normalizedAll);
  if (!socEntry) {
    throw new Error("Cannot find SOC/F/V file. Expected a file containing Voltage/SOC/POC/Point or SOC.");
  }

  const socRows = await parseSocVoltageRows(socEntry, profile, warnings);
  if (!socRows.length) {
    throw new Error("SOC/F/V file does not contain usable timestamps.");
  }

  const firstTime = socRows[0].time;
  const todayDateStr = formatDate(firstTime);

  // Calculate yesterday's dates
  const todayDate = new Date(firstTime);
  const yesterdayDate = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayDateStr = formatDate(yesterdayDate);

  // Format short versions to match folder/file name patterns (e.g. "26-May-2026", "26-May", "26-May-26")
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shortYesterday = `${yesterdayDate.getDate()}-${monthNames[yesterdayDate.getMonth()]}-${yesterdayDate.getFullYear()}`;
  const shortYesterday2 = `${yesterdayDate.getDate()}-${monthNames[yesterdayDate.getMonth()]}-${String(yesterdayDate.getFullYear()).slice(2)}`;

  // 2. Perform intelligent telemetry auto-partitioning:
  // Move any BESS cycle files that belong to yesterday into realYesterdayFiles.
  const allMergedEntries = [...todayFiles, ...yesterdayEssFiles];
  const realTodayFiles: Ess20FileEntry[] = [];
  const realYesterdayFiles: Ess20FileEntry[] = [];

  for (const entry of allMergedEntries) {
    const name = entry.file.name;
    const pathStr = entry.path || name;

    // Check if the path or name explicitly designates it as yesterday's data
    const isYesterday = 
      pathStr.includes(yesterdayDateStr) || 
      pathStr.includes(shortYesterday) || 
      pathStr.includes(shortYesterday2) || 
      pathStr.toLowerCase().includes("yesterday") ||
      pathStr.toLowerCase().includes("/ess_y/") ||
      pathStr.toLowerCase().includes("/yesterday_ess/") ||
      (extractDataDate(pathStr, name) === yesterdayDateStr);

    if (isYesterday) {
      realYesterdayFiles.push(entry);
    } else {
      realTodayFiles.push(entry);
    }
  }

  const normalizedToday = normalizeEntries(realTodayFiles);
  const normalizedYesterday = normalizeEntries(realYesterdayFiles);

  const pqEntry = findActiveReactiveFile(profile, normalizedToday);
  const pvsEntry = findPvSmoothingFile(normalizedToday);
  const smartEntries = normalizedToday.filter(isSmartLoggerFile);
  const essTodayEntries = normalizedToday.filter(isEssFile);
  const essYesterdayEntries = normalizedYesterday.filter(isExcelFile);
  const pcsEntries = normalizedToday.filter(isPcsFile);

  if (!pqEntry) {
    throw new Error("Cannot find P/Q file. Expected P_Q_POC_Point or ActivePower/ReactivePower spreadsheet.");
  }

  const pqRows = await parseActiveReactiveRows(pqEntry, profile, warnings);
  const main = alignMainSeries(socRows, pqRows, warnings);
  if (!main.times.length) {
    throw new Error("SOC/F/V and P/Q files do not contain usable timestamps.");
  }

  const smartLogger = await parseSmartLoggerSum(smartEntries, warnings);
  const pvs = pvsEntry ? await parsePvSmoothing(profile, pvsEntry, main, warnings) : null;
  if (!pvsEntry && profile.pvMode !== "none") {
    warnings.push("PV smoothing file was not found; PV/ESS overlay curves will be hidden.");
  }

  const finalFirstTime = main.times[0];
  const finalTodayDateStr = formatDate(finalFirstTime);
  const cycle = await parseCycleSummary(projectId, finalTodayDateStr, essTodayEntries, essYesterdayEntries, warnings, main.pMw);

  const sourceRoot = detectSourceRoot(normalizedToday);

  return {
    profile,
    dataDate: formatDate(finalFirstTime),
    dayTag: formatDayTag(finalFirstTime),
    sourceRoot,
    files: {
      socVoltage: socEntry.path,
      activeReactive: pqEntry.path,
      pvSmoothing: pvsEntry?.path || "",
      smartLoggerCount: smartEntries.length,
      essTodayCount: essTodayEntries.length,
      essYesterdayCount: essYesterdayEntries.length,
      pcsCount: pcsEntries.length,
    },
    main,
    pvs,
    smartLogger,
    cycle,
    warnings,
  };
}

export function buildEss20Workbook(result: Ess20Result) {
  const wb = XLSX.utils.book_new();
  const summaryRows = [
    ["Project", result.profile.label],
    ["Data Date", result.dataDate],
    ["Source Root", result.sourceRoot],
    ["SOC/F/V File", result.files.socVoltage],
    ["P/Q File", result.files.activeReactive],
    ["PV Smoothing File", result.files.pvSmoothing || "(not loaded)"],
    ["SmartLogger Files", result.files.smartLoggerCount],
    ["Today ESS Files", result.files.essTodayCount],
    ["Yesterday ESS Files", result.files.essYesterdayCount],
    ["PCS Files", result.files.pcsCount],
    ["Daily Cycle Avg", finiteOrBlank(result.cycle.dailyAvg)],
    ["Today Total Cycle Avg", finiteOrBlank(result.cycle.todayAvg)],
    ["Yesterday Total Cycle Avg", finiteOrBlank(result.cycle.yesterdayAvg)],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), "Summary");

  const mainRows = result.main.times.map((time, idx) => ({
    Time: formatDateTime(time),
    P_MW: round(result.main.pMw[idx]),
    Q_MVar: round(result.main.qMvar[idx]),
    SOC_pct: round(result.main.soc[idx]),
    Frequency_Hz: round(result.main.frequency[idx], 4),
    Vab_kV: round(result.main.vab[idx], 4),
    Vbc_kV: round(result.main.vbc[idx], 4),
    Vca_kV: round(result.main.vca[idx], 4),
    Vavg_kV: round(result.main.vavg[idx], 4),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mainRows), "Main_Timeline");

  if (result.pvs) {
    const pvsRows = result.pvs.times.map((time, idx) => ({
      Time: formatDateTime(time),
      P_PCC_MW: round(result.pvs!.pPccMw[idx]),
      P_PV_MW: round(result.pvs!.pPvMw[idx]),
      P_ESS_MW: round(result.pvs!.pEssMw[idx]),
      SOC_pct: round(result.pvs!.socPct[idx]),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pvsRows), "PV_Smoothing");
  }

  if (result.smartLogger) {
    const smartRows = result.smartLogger.times.map((time, idx) => ({
      Time: formatDateTime(time),
      TotalP_MW: round(result.smartLogger!.totalPMw[idx]),
      TotalQ_MVar: round(result.smartLogger!.totalQMvar[idx]),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(smartRows), "SmartLogger_Sum");
  }

  if (result.cycle.timeline) {
    const cycleRows = result.cycle.timeline.times.map((time, idx) => ({
      Time: formatDateTime(time),
      AvgCycles: round(result.cycle.timeline!.avgCycles[idx], 6),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cycleRows), "TTcycle");
  }

  if (result.warnings.length) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(result.warnings.map((warning) => ({ Warning: warning }))),
      "Warnings",
    );
  }

  return wb;
}

function normalizeEntries(entries: Ess20FileEntry[]) {
  return entries
    .filter((entry) => entry.file && entry.file.name && !entry.file.name.startsWith("~$"))
    .map((entry) => ({
      file: entry.file,
      path: normalizePath(entry.path || entry.file.name),
    }));
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isExcelFile(entry: Ess20FileEntry) {
  return /\.xlsx?$/i.test(entry.file.name);
}

function lowerName(entry: Ess20FileEntry) {
  return entry.file.name.toLowerCase();
}

function lowerPath(entry: Ess20FileEntry) {
  return normalizePath(entry.path || entry.file.name).toLowerCase();
}

function isSmartLoggerFile(entry: Ess20FileEntry) {
  const name = lowerName(entry);
  const path = lowerPath(entry);
  return isExcelFile(entry) && (name.startsWith("smartlogger_") || /(^|\/)smartlogger\//i.test(path));
}

function isEssFile(entry: Ess20FileEntry) {
  const name = lowerName(entry);
  const path = lowerPath(entry);
  return isExcelFile(entry) && (name.startsWith("ess_") || /(^|\/)ess\//i.test(path));
}

function isPcsFile(entry: Ess20FileEntry) {
  const name = lowerName(entry);
  const path = lowerPath(entry);
  return isExcelFile(entry) && (name.startsWith("pcs_") || /(^|\/)pcs\//i.test(path));
}

function findSocVoltageFile(profile: Ess20ProjectProfile, entries: Ess20FileEntry[]) {
  const candidates = entries.filter((entry) => {
    const name = lowerName(entry);
    const path = lowerPath(entry);
    if (!isExcelFile(entry) || /(^|\/)(ess|smartlogger|pcs)\//i.test(path)) return false;
    if (profile.id === "SNTB") return name.includes("soc") && !name.includes("smoothing");
    return name.includes("voltage") && name.includes("soc") && name.includes("poc") && name.includes("point");
  });
  return candidates[0] || entries.find((entry) => {
    const path = lowerPath(entry);
    return isExcelFile(entry) && 
      !/(^|\/)(ess|smartlogger|pcs)\//i.test(path) && 
      lowerName(entry).includes("soc") && 
      !lowerName(entry).includes("smoothing");
  });
}

function findActiveReactiveFile(profile: Ess20ProjectProfile, entries: Ess20FileEntry[]) {
  const candidates = entries.filter((entry) => {
    const name = lowerName(entry);
    const path = lowerPath(entry);
    if (!isExcelFile(entry) || /(^|\/)(ess|smartlogger|pcs)\//i.test(path)) return false;
    if (profile.id === "SNTB") return name.includes("activepower") && name.includes("reactivepower");
    return (name.includes("p_q") || name.includes("p-q")) && name.includes("poc") && name.includes("point");
  });
  return candidates[0] || entries.find((entry) => {
    const path = lowerPath(entry);
    return isExcelFile(entry) && 
      !/(^|\/)(ess|smartlogger|pcs)\//i.test(path) && 
      /active.*reactive|p[_-]?q/i.test(entry.file.name);
  });
}

function findPvSmoothingFile(entries: Ess20FileEntry[]) {
  return entries.find((entry) => {
    const name = lowerName(entry);
    return isExcelFile(entry) && name.includes("pv") && name.includes("smoothing");
  });
}

async function readAoa(file: File): Promise<Aoa> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true, raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws["!ref"]) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as Aoa;
}

async function readParsedTable(file: File, mode: "poc" | "smartlogger" | "ess" | "pvs"): Promise<ParsedTable> {
  const aoa = await readAoa(file);
  if (!aoa.length) return { headers: [], rows: [], headerRow: -1 };

  const maxRows = Math.min(10, aoa.length);
  let headerRow = -1;

  if (mode === "smartlogger") {
    headerRow = findHeaderRow(aoa, maxRows, (headers) => hasHeader(headers, "start", "time") || hasHeader(headers, "active", "power"));
    if (headerRow < 0 && aoa[3]) headerRow = 3;
  } else if (mode === "ess") {
    headerRow = findHeaderRow(aoa, maxRows, (headers) => hasHeader(headers, "cycle") || hasHeader(headers, "start", "time"));
    if (headerRow < 0 && aoa[3]) headerRow = 3;
  } else if (mode === "pvs") {
    headerRow = findHeaderRow(aoa, maxRows, (headers) => hasHeader(headers, "time") || hasHeader(headers, "soc"));
    if (headerRow < 0 && aoa[4]) headerRow = 4;
  } else {
    headerRow = findHeaderRow(aoa, maxRows, (headers) => headers.some((h) => /^time$|datetime/i.test(h)));
    if (headerRow < 0) headerRow = 0;
  }

  const headers = rowToStrings(aoa[headerRow] || []);
  return {
    headers,
    rows: aoa.slice(headerRow + 1),
    headerRow,
  };
}

function findHeaderRow(aoa: Aoa, maxRows: number, predicate: (headers: string[]) => boolean) {
  for (let i = 0; i < maxRows; i++) {
    const headers = rowToStrings(aoa[i] || []);
    if (predicate(headers)) return i;
  }
  return -1;
}

function rowToStrings(row: unknown[]) {
  return row.map((cell) => (cell == null ? "" : String(cell).trim()));
}

function hasHeader(headers: string[], ...keywords: string[]) {
  return headers.some((header) => keywords.every((kw) => header.toLowerCase().includes(kw)));
}

async function parseSocVoltageRows(entry: Ess20FileEntry, profile: Ess20ProjectProfile, warnings: string[]): Promise<TimedRecord[]> {
  const table = await readParsedTable(entry.file, "poc");
  const headers = table.headers;

  const idxTime = findColumn(headers, ["time"], 0);
  const idxSoc = profile.id === "SNTZ" ? findColumn(headers, ["soc"], 1) : 1;
  let idxF = findColumn(headers, ["freq"], 2);
  if (idxF < 0) idxF = findColumn(headers, ["hz"], 2);
  const idxVab = profile.id === "SNTZ" ? findVoltageColumn(headers, "ab", 3) : 3;
  const idxVbc = profile.id === "SNTZ" ? findVoltageColumn(headers, "bc", 4) : 4;
  const idxVca = profile.id === "SNTZ" ? findVoltageColumn(headers, "ca", 5) : 5;

  if (idxSoc < 0 || idxF < 0 || idxVab < 0 || idxVbc < 0 || idxVca < 0) {
    warnings.push(`Some SOC/F/V columns were not detected cleanly in ${entry.file.name}; positional fallbacks were used.`);
  }

  const records: TimedRecord[] = [];
  for (const row of table.rows) {
    if (isSummaryRow(row)) continue;
    const time = parseDate(row[idxTime]);
    if (!time) continue;
    records.push({
      time,
      soc: toNumber(row[idxSoc]),
      frequency: toNumber(row[idxF]),
      vab: toNumber(row[idxVab]),
      vbc: toNumber(row[idxVbc]),
      vca: toNumber(row[idxVca]),
    });
  }
  fillRecordColumns(records, ["soc", "frequency", "vab", "vbc", "vca"]);
  return records;
}

async function parseActiveReactiveRows(entry: Ess20FileEntry, profile: Ess20ProjectProfile, warnings: string[]): Promise<TimedRecord[]> {
  const table = await readParsedTable(entry.file, "poc");
  const headers = table.headers;
  const idxTime = findColumn(headers, ["time"], 0);
  let idxP = profile.id === "SNTZ" ? findColumn(headers, ["pcc", "active"], -1) : 1;
  let idxQ = profile.id === "SNTZ" ? findColumn(headers, ["pcc", "reactive"], -1) : 2;
  if (idxP < 0) idxP = findColumn(headers, ["active"], 1);
  if (idxQ < 0) idxQ = findColumn(headers, ["reactive"], 2);

  if (idxP < 0 || idxQ < 0) {
    warnings.push(`P/Q columns were not detected cleanly in ${entry.file.name}; positional fallbacks were used.`);
  }

  const records: TimedRecord[] = [];
  for (const row of table.rows) {
    if (isSummaryRow(row)) continue;
    const time = parseDate(row[idxTime]);
    if (!time) continue;
    records.push({
      time,
      pKw: toNumber(row[idxP]),
      qKvar: toNumber(row[idxQ]),
    });
  }
  fillRecordColumns(records, ["pKw", "qKvar"]);
  return records;
}

function alignMainSeries(socRows: TimedRecord[], pqRows: TimedRecord[], warnings: string[]): MainSeries {
  const socMap = recordsToMap(socRows);
  const pqMap = recordsToMap(pqRows);
  const socTimes = new Set(socRows.map((r) => r.time.getTime()));
  const pqTimes = new Set(pqRows.map((r) => r.time.getTime()));
  let millis = [...socTimes].filter((ms) => pqTimes.has(ms)).sort((a, b) => a - b);

  if (!millis.length) {
    warnings.push("SOC/F/V and P/Q timestamp intersection was empty; using union with forward/back fill.");
    millis = [...new Set([...socTimes, ...pqTimes])].sort((a, b) => a - b);
  }

  const times = millis.map((ms) => new Date(ms));
  const soc = fillNumeric(millis.map((ms) => numberFromRecord(socMap.get(ms), "soc")));
  const frequency = fillNumeric(millis.map((ms) => numberFromRecord(socMap.get(ms), "frequency")));
  const vab = fillNumeric(millis.map((ms) => numberFromRecord(socMap.get(ms), "vab")));
  const vbc = fillNumeric(millis.map((ms) => numberFromRecord(socMap.get(ms), "vbc")));
  const vca = fillNumeric(millis.map((ms) => numberFromRecord(socMap.get(ms), "vca")));
  const pMw = fillNumeric(millis.map((ms) => numberFromRecord(pqMap.get(ms), "pKw") / 1000));
  const qMvar = fillNumeric(millis.map((ms) => numberFromRecord(pqMap.get(ms), "qKvar") / 1000));
  const vavg = vab.map((v, i) => mean([v, vbc[i], vca[i]]));

  return { times, pMw, qMvar, soc, frequency, vab, vbc, vca, vavg };
}

async function parseSmartLoggerSum(entries: Ess20FileEntry[], warnings: string[]): Promise<SmartLoggerSeries | null> {
  if (!entries.length) return null;

  const aggregate = new Map<number, { pKw: number; qKvar: number }>();
  let parsed = 0;

  for (const entry of entries) {
    try {
      const table = await readParsedTable(entry.file, "smartlogger");
      const headers = table.headers;
      const idxTime = findColumn(headers, ["start", "time"], findColumn(headers, ["time"], 0));
      let idxP = 4;
      let idxQ = 25;
      if (headers.length <= idxP) idxP = findColumn(headers, ["active", "power"], 4);
      if (headers.length <= idxQ) idxQ = findColumn(headers, ["reactive", "power"], 25);

      for (const row of table.rows) {
        if (isSummaryRow(row)) continue;
        const time = parseDate(row[idxTime]);
        if (!time) continue;
        const ms = time.getTime();
        const current = aggregate.get(ms) || { pKw: 0, qKvar: 0 };
        current.pKw += zeroIfNaN(toNumber(row[idxP]));
        current.qKvar += zeroIfNaN(toNumber(row[idxQ]));
        aggregate.set(ms, current);
      }
      parsed++;
    } catch (err) {
      warnings.push(`SmartLogger parse failed for ${entry.file.name}: ${errorText(err)}`);
    }
  }

  if (!aggregate.size) {
    warnings.push(`No usable SmartLogger rows were found in ${entries.length} file(s).`);
    return null;
  }

  const millis = [...aggregate.keys()].sort((a, b) => a - b);
  return {
    times: millis.map((ms) => new Date(ms)),
    totalPMw: millis.map((ms) => aggregate.get(ms)!.pKw / 1000),
    totalQMvar: millis.map((ms) => aggregate.get(ms)!.qKvar / 1000),
  };
}

async function parsePvSmoothing(
  profile: Ess20ProjectProfile,
  entry: Ess20FileEntry,
  main: MainSeries,
  warnings: string[],
): Promise<PvSmoothingSeries | null> {
  if (profile.pvMode === "none") return null;
  const table = await readParsedTable(entry.file, "pvs");
  const headers = table.headers;
  const idxTime = findColumn(headers, ["time"], 0);
  const records: { time: Date; pPccMw: number; pPvMw: number; pEssMw: number; socPct: number }[] = [];

  if (profile.pvMode === "columns") {
    for (const row of table.rows) {
      if (isSummaryRow(row)) continue;
      const time = parseDate(row[idxTime]);
      if (!time) continue;
      records.push({
        time,
        pPccMw: toNumber(row[1]) / 1000,
        pPvMw: toNumber(row[3]) / 1000,
        pEssMw: toNumber(row[4]) / 1000,
        socPct: normalizeSoc(toNumber(row[5])),
      });
    }
  } else {
    let idxPess = headers.findIndex((h) => {
      const v = h.toLowerCase();
      return (v.includes("ess") || v.includes("bess")) && !v.includes("soc");
    });
    if (idxPess < 0) idxPess = Math.min(2, Math.max(0, headers.length - 1));
    let idxSoc = findColumn(headers, ["soc"], -1);
    if (idxSoc < 0) idxSoc = Math.min(1, Math.max(0, headers.length - 1));

    const mainByMs = new Map<number, number>();
    main.times.forEach((time, idx) => mainByMs.set(time.getTime(), main.pMw[idx]));

    for (const row of table.rows) {
      if (isSummaryRow(row)) continue;
      const time = parseDate(row[idxTime]);
      if (!time) continue;
      const pPccMw = mainByMs.get(time.getTime());
      if (pPccMw == null) continue;
      const pEssMw = toNumber(row[idxPess]) / 1000;
      let pPvMw = pPccMw - pEssMw;
      if (pPvMw < 0) pPvMw = 0;
      records.push({
        time,
        pPccMw,
        pPvMw,
        pEssMw,
        socPct: normalizeSoc(toNumber(row[idxSoc])),
      });
    }
    if (!records.length) warnings.push("PV smoothing data could not be aligned with the P/Q timeline.");
  }

  if (!records.length) return null;
  records.sort((a, b) => a.time.getTime() - b.time.getTime());
  fillObjectColumns(records, ["pPccMw", "pPvMw", "pEssMw", "socPct"]);
  return {
    times: records.map((r) => r.time),
    pPccMw: records.map((r) => r.pPccMw),
    pPvMw: records.map((r) => r.pPvMw),
    pEssMw: records.map((r) => r.pEssMw),
    socPct: records.map((r) => r.socPct),
  };
}

async function parseCycleSummary(
  projectId: Ess20ProjectId,
  todayDateStr: string,
  todayEntries: Ess20FileEntry[],
  yesterdayEntries: Ess20FileEntry[],
  warnings: string[],
  pMw: number[],
): Promise<CycleSummary> {
  const todayData: CycleFileData[] = [];
  for (const entry of todayEntries) {
    try {
      const data = await parseCycleFile(entry);
      if (data) todayData.push(data);
    } catch (err) {
      warnings.push(`Today ESS cycle parse failed for ${entry.file.name}: ${errorText(err)}`);
    }
  }

  // 1. Calculate yesterday's average directly from uploaded yesterday ESS files if available!
  const yesterdayData: CycleFileData[] = [];
  for (const entry of yesterdayEntries) {
    try {
      const data = await parseCycleFile(entry);
      if (data) yesterdayData.push(data);
    } catch (err) {
      warnings.push(`Yesterday ESS cycle parse failed for ${entry.file.name}: ${errorText(err)}`);
    }
  }

  const yesterdayTotals = yesterdayData.map((item) => item.lastCycle).filter(Number.isFinite);
  let yesterdayAvg = NaN;
  if (yesterdayTotals.length > 0) {
    yesterdayAvg = mean(yesterdayTotals);
    // Proactively save yesterdayAvg to persistent history database under yesterday's date
    try {
      const todayDate = new Date(todayDateStr);
      const yesterdayDate = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayDateStr = formatDate(yesterdayDate);
      saveCycleToHistory(projectId, yesterdayDateStr, yesterdayAvg);
    } catch (e) {
      console.error("Failed to save parsed yesterday cycle to history:", e);
    }
  }

  let todayAvg = NaN;
  let dailyAvg = NaN;

  const todayTotals = todayData.map((item) => item.lastCycle).filter(Number.isFinite);
  const todayFirstTotals = todayData.map((item) => item.firstCycle).filter(Number.isFinite);
  
  if (todayTotals.length > 0) {
    // ESS cycle files are loaded for today
    todayAvg = mean(todayTotals);
    
    // Auto-detect yesterday's cycle from the first row of today's files if yesterday's files weren't uploaded
    if (Number.isNaN(yesterdayAvg)) {
      if (todayFirstTotals.length > 0) {
        yesterdayAvg = mean(todayFirstTotals);
        // Proactively save this detected yesterdayAvg to history under yesterday's date
        try {
          const todayDate = new Date(todayDateStr);
          const yesterdayDate = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000);
          const yesterdayDateStr = formatDate(yesterdayDate);
          saveCycleToHistory(projectId, yesterdayDateStr, yesterdayAvg);
        } catch (e) {
          console.error("Failed to save auto-detected yesterday cycle to history:", e);
        }
      } else {
        // Fallback: Get yesterday's total cycle from history lookup
        yesterdayAvg = getYesterdayCycleFromHistory(projectId, todayDateStr);
      }
    }
    
    dailyAvg = todayAvg - yesterdayAvg;
  } else {
    // ESS cycle files are NOT loaded for today - calculate daily cycle from active power curve!
    if (Number.isNaN(yesterdayAvg)) {
      yesterdayAvg = getYesterdayCycleFromHistory(projectId, todayDateStr);
    }
    const capacity = PROJECT_CAPACITY_MWH[projectId] || 30;
    dailyAvg = calculateDailyCycleFromPowerCurve(pMw, capacity);
    todayAvg = yesterdayAvg + dailyAvg;
    warnings.push(`Today ESS cycle files not loaded. Calculated daily cycle from power curves: ${dailyAvg.toFixed(3)} cycles.`);
  }

  // 2. Save today's calculated total cycle to history automatically
  if (Number.isFinite(todayAvg)) {
    saveCycleToHistory(projectId, todayDateStr, todayAvg);
  }

  if (Number.isFinite(dailyAvg) && dailyAvg < 0) {
    warnings.push("Daily cycle is negative. Check whether today/yesterday ESS folders were selected correctly.");
  }

  return {
    todayAvg,
    yesterdayAvg,
    dailyAvg,
    todayDeviceCount: todayTotals.length,
    yesterdayDeviceCount: yesterdayEntries.length,
    timeline: buildCycleTimeline(todayData),
  };
}

async function parseCycleFile(entry: Ess20FileEntry): Promise<CycleFileData | null> {
  const table = await readParsedTable(entry.file, "ess");
  const headers = table.headers;
  if (!headers.length) return null;

  let idxTime = findColumn(headers, ["start", "time"], findColumn(headers, ["time"], 3));
  if (idxTime < 0) idxTime = 3;
  let idxCycle = headers.findIndex((h) => {
    const v = h.toLowerCase();
    return v.includes("equivalent") && v.includes("cycle");
  });
  if (idxCycle < 0) idxCycle = findColumn(headers, ["cycle"], 5);

  const rows: { time: Date; cycle: number }[] = [];
  for (const row of table.rows) {
    if (isSummaryRow(row)) continue;
    const time = parseDate(row[idxTime]);
    const cycle = toNumber(row[idxCycle]);
    if (!time || !Number.isFinite(cycle)) continue;
    rows.push({ time, cycle });
  }

  if (!rows.length) return null;
  
  // Sort rows chronologically to ensure rows[0] is the earliest and rows[end] is the latest
  rows.sort((a, b) => a.time.getTime() - b.time.getTime());
  
  return { 
    firstCycle: rows[0].cycle,
    lastCycle: rows[rows.length - 1].cycle, 
    rows 
  };
}

function buildCycleTimeline(files: CycleFileData[]): CycleSeries | null {
  const validFiles = files.filter((file) => file.rows.length);
  if (!validFiles.length) return null;

  const millis = [
    ...new Set(validFiles.flatMap((file) => file.rows.map((row) => row.time.getTime()))),
  ].sort((a, b) => a - b);

  const filledColumns = validFiles.map((file) => {
    const map = new Map(file.rows.map((row) => [row.time.getTime(), row.cycle]));
    return fillNumeric(millis.map((ms) => map.get(ms) ?? NaN));
  });

  const avgCycles = millis.map((_, rowIdx) => mean(filledColumns.map((col) => col[rowIdx])));
  return {
    times: millis.map((ms) => new Date(ms)),
    avgCycles,
  };
}

function findColumn(headers: string[], keywords: string[], fallback: number) {
  const idx = headers.findIndex((header) => keywords.every((kw) => header.toLowerCase().includes(kw)));
  if (idx >= 0) return idx;
  return fallback >= 0 && fallback < headers.length ? fallback : -1;
}

function findVoltageColumn(headers: string[], phase: "ab" | "bc" | "ca", fallback: number) {
  const idx = headers.findIndex((header) => {
    const v = header.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (phase === "ab") return (v.includes("ab") || v.includes("alinebline")) && v.includes("volt");
    if (phase === "bc") return (v.includes("bc") || v.includes("blinecline")) && v.includes("volt");
    return (v.includes("ca") || v.includes("clinea")) && v.includes("volt");
  });
  return idx >= 0 ? idx : fallback;
}

function isSummaryRow(row: unknown[]) {
  const first = row[0] == null ? "" : String(row[0]).trim().toLowerCase();
  return first === "average" || first === "max" || first === "min" || first === "total";
}

function parseDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Math.round((value - 25569) * 86400000));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const raw = String(value).trim();
  if (!raw || /^(average|max|min|total)$/i.test(raw)) return null;
  const normalized = raw.replace(/\//g, "-");
  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    return new Date(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  }
  match = normalized.match(/^(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{4})/i);
  if (match) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    return new Date(+match[3], months.indexOf(match[2].toLowerCase().slice(0, 3)), +match[1]);
  }
  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function toNumber(value: unknown) {
  if (value == null || value === "") return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = String(value).trim();
  if (!text || text === "--" || /^n\/?a$/i.test(text) || /^nan$/i.test(text)) return NaN;
  const num = Number.parseFloat(text.replace(/,/g, ""));
  return Number.isFinite(num) ? num : NaN;
}

function fillRecordColumns(records: TimedRecord[], keys: string[]) {
  for (const key of keys) {
    const filled = fillNumeric(records.map((record) => Number(record[key])));
    records.forEach((record, idx) => {
      record[key] = filled[idx];
    });
  }
}

function fillObjectColumns(records: Record<string, any>[], keys: string[]) {
  for (const key of keys) {
    const filled = fillNumeric(records.map((record) => Number(record[key])));
    records.forEach((record, idx) => {
      record[key] = filled[idx];
    });
  }
}

function fillNumeric(values: number[]) {
  const out = values.map((v) => (Number.isFinite(v) ? v : NaN));
  let last = NaN;
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) last = out[i];
    else if (Number.isFinite(last)) out[i] = last;
  }
  const first = out.find((v) => Number.isFinite(v));
  if (first != null) {
    for (let i = 0; i < out.length && !Number.isFinite(out[i]); i++) out[i] = first;
  }
  return out;
}

function recordsToMap(rows: TimedRecord[]) {
  return new Map(rows.map((row) => [row.time.getTime(), row]));
}

function numberFromRecord(record: TimedRecord | undefined, key: string) {
  if (!record) return NaN;
  const value = record[key];
  return typeof value === "number" ? value : NaN;
}

function normalizeSoc(value: number) {
  if (!Number.isFinite(value)) return value;
  return value <= 1 ? value * 100 : value;
}

function zeroIfNaN(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function mean(values: number[]) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : NaN;
}

function detectSourceRoot(entries: Ess20FileEntry[]) {
  const first = entries[0]?.path || "";
  const parts = normalizePath(first).split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : "(selected files)";
}

export function formatDate(dateVal: Date | string) {
  const date = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatDayTag(dateVal: Date | string) {
  const date = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

export function formatTime(dateVal: Date | string) {
  const date = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatDateTime(dateVal: Date | string) {
  const date = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
  return `${formatDate(date)} ${formatTime(date)}:${pad2(date.getSeconds())}`;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function round(value: number, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : "";
}

function finiteOrBlank(value: number) {
  return Number.isFinite(value) ? value : "";
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export async function checkRunBaselineInfo(
  projectId: Ess20ProjectId,
  todayFiles: Ess20FileEntry[],
  yesterdayEssFiles: Ess20FileEntry[],
): Promise<{ todayDateStr: string; yesterdayDateStr: string; hasYesterdayFiles: boolean; hasTodayEssFiles: boolean }> {
  const profile = getEss20Profile(projectId);
  const normalizedAll = normalizeEntries(todayFiles);
  const socEntry = findSocVoltageFile(profile, normalizedAll);
  if (!socEntry) {
    throw new Error("Cannot find SOC/F/V file. Expected a file containing Voltage/SOC/POC/Point or SOC.");
  }

  const socRows = await parseSocVoltageRows(socEntry, profile, []);
  if (!socRows.length) {
    throw new Error("SOC/F/V file does not contain usable timestamps.");
  }

  const firstTime = socRows[0].time;
  const todayDateStr = formatDate(firstTime);

  const todayDate = new Date(firstTime);
  const yesterdayDate = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayDateStr = formatDate(yesterdayDate);

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shortYesterday = `${yesterdayDate.getDate()}-${monthNames[yesterdayDate.getMonth()]}-${yesterdayDate.getFullYear()}`;
  const shortYesterday2 = `${yesterdayDate.getDate()}-${monthNames[yesterdayDate.getMonth()]}-${String(yesterdayDate.getFullYear()).slice(2)}`;

  const allMergedEntries = [...todayFiles, ...yesterdayEssFiles];
  let hasYesterdayFiles = false;
  for (const entry of allMergedEntries) {
    const name = entry.file.name;
    const pathStr = entry.path || name;
    const isYesterday = 
      pathStr.includes(yesterdayDateStr) || 
      pathStr.includes(shortYesterday) || 
      pathStr.includes(shortYesterday2) || 
      pathStr.toLowerCase().includes("yesterday") ||
      pathStr.toLowerCase().includes("/ess_y/") ||
      pathStr.toLowerCase().includes("/yesterday_ess/") ||
      (extractDataDate(pathStr, name) === yesterdayDateStr);
    if (isYesterday) {
      hasYesterdayFiles = true;
      break;
    }
  }

  const hasTodayEssFiles = normalizedAll.some(isEssFile);

  return { todayDateStr, yesterdayDateStr, hasYesterdayFiles, hasTodayEssFiles };
}
