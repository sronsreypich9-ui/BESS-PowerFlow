import { Ess20FileEntry, Ess20Result } from "./ess20-engine";

declare global {
  interface Window {
    electronAPI?: {
      selectFolder: () => Promise<string | null>;
      selectAndReadFolder: () => Promise<{ folderPath: string; files: any[] } | null>;
      saveFile: (filePath: string, base64Data: string) => Promise<{ ok: boolean; error?: string }>;
      saveMatlabFigures: (folder: string, result: any) => Promise<{ ok: boolean; error?: string }>;
      saveMatlabScript: (projectCode: string, scriptContent: string) => Promise<{ ok: boolean; error?: string }>;
      loadMatlabScript: (projectCode: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
      checkExportedFiles: (folderPath: string) => Promise<{ exists: boolean; files: string[]; error?: string }>;
      loadResultJson: (filePath: string) => Promise<{ ok: boolean; data?: any; error?: string }>;
      loadCycleHistory: () => Promise<any>;
      saveCycleHistory: (history: any) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}


export interface SharedState {
  todayFiles: Ess20FileEntry[];
  yesterdayFiles: Ess20FileEntry[];
  result: Ess20Result | null;
  status: string;
  error: string;
  activeView: string;
  outputFolder: string | null;
  scale: string;
  exportLog: any[];
  exported: Set<string>;
  autoSave: boolean;
  uploadedFiles: { name: string; size: string }[];
}

export const ess20SharedState: SharedState = {
  todayFiles: [],
  yesterdayFiles: [],
  result: null,
  status: "",
  error: "",
  activeView: "report",
  outputFolder: typeof localStorage !== "undefined" ? localStorage.getItem("ess_output_folder_path") : null,
  scale: "2",
  exportLog: [],
  exported: new Set<string>(),
  autoSave: true,
  uploadedFiles: [],
};

export interface MatCodeSharedState {
  mCode: string;
  config: any;
  todayFiles: { file: File; path: string }[];
  evalData: any;
  status: string;
  error: string;
  outputFolder: string | null;
  autoSave: boolean;
}

export const matCodeSharedState: MatCodeSharedState = {
  mCode: "",
  config: null,
  todayFiles: [],
  evalData: null,
  status: "",
  error: "",
  outputFolder: typeof localStorage !== "undefined" ? localStorage.getItem("ess_output_folder_path") : null,
  autoSave: true,
};

const DEFAULT_YESTERDAY_CYCLES: Record<string, number> = {
  SNTV: 179.667,
  SNTB: 499.333,
  SNTZ: 141.5,
  SNTD_DMF: 579.0,
  MSGP: 129.35,
};

export function getInitialCycle(projectId: string): number {
  return DEFAULT_YESTERDAY_CYCLES[projectId] ?? 0;
}

export function getCycleHistory(): Record<string, Record<string, number>> {
  try {
    const raw = localStorage.getItem("ess_cycle_tracker_history");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    }
  } catch (err) {
    console.error("Failed to read cycle history:", err);
  }
  return {};
}

export async function syncCycleHistoryFromDisk(): Promise<void> {
  try {
    if (window.electronAPI && typeof window.electronAPI.loadCycleHistory === "function") {
      const diskHistory = await window.electronAPI.loadCycleHistory();
      if (diskHistory && typeof diskHistory === "object") {
        const localRaw = localStorage.getItem("ess_cycle_tracker_history");
        let merged: Record<string, Record<string, number>> = { ...diskHistory };
        if (localRaw) {
          try {
            const localParsed = JSON.parse(localRaw);
            if (localParsed && typeof localParsed === "object") {
              // Symmetrical union of all project keys from both sources
              const allProjectIds = new Set([...Object.keys(diskHistory), ...Object.keys(localParsed)]);
              for (const projId of allProjectIds) {
                merged[projId] = {
                  ...(localParsed[projId] || {}),
                  ...(diskHistory[projId] || {})
                };
              }
            }
          } catch (_) {}
        }
        localStorage.setItem("ess_cycle_tracker_history", JSON.stringify(merged));
        console.log("[INFO] Cycle history successfully synced from physical disk storage!");
      }
    }
  } catch (err) {
    console.error("Failed to sync cycle history from disk:", err);
  }
}

export function saveCycleToHistory(projectId: string, dateStr: string, value: number): void {
  if (!Number.isFinite(value) || Number.isNaN(value)) return;
  try {
    const history = getCycleHistory();
    if (!history[projectId]) {
      history[projectId] = {};
    }
    history[projectId][dateStr] = value;
    localStorage.setItem("ess_cycle_tracker_history", JSON.stringify(history));

    if (window.electronAPI && typeof window.electronAPI.saveCycleHistory === "function") {
      window.electronAPI.saveCycleHistory(history).catch((err) => {
        console.error("Failed to save cycle history to disk:", err);
      });
    }
  } catch (err) {
    console.error("Failed to save cycle history:", err);
  }
}

export function getYesterdayCycleFromHistory(projectId: string, todayDateStr: string): number {
  const history = getCycleHistory();
  const projectHistory = history[projectId] || {};
  
  const todayTime = new Date(todayDateStr).getTime();
  let bestDateStr: string | null = null;
  let bestTime = -Infinity;
  
  for (const dateStr of Object.keys(projectHistory)) {
    const time = new Date(dateStr).getTime();
    if (time < todayTime && time > bestTime) {
      bestTime = time;
      bestDateStr = dateStr;
    }
  }
  
  if (bestDateStr && typeof projectHistory[bestDateStr] === "number") {
    return projectHistory[bestDateStr];
  }
  
  return getInitialCycle(projectId);
}

export function isBaselineMissing(
  projectId: string,
  todayDateStr: string,
  hasYesterdayFiles: boolean,
  hasTodayEssFiles: boolean
): { missing: boolean; yesterdayDateStr: string; isHistoryEmpty: boolean } {
  if (hasYesterdayFiles || hasTodayEssFiles) {
    return { missing: false, yesterdayDateStr: "", isHistoryEmpty: false };
  }

  let yesterdayDateStr = "";
  try {
    const todayDate = new Date(todayDateStr + "T12:00:00");
    const yesterdayDate = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000);
    yesterdayDateStr = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, '0')}-${String(yesterdayDate.getDate()).padStart(2, '0')}`;
  } catch (e) {
    console.error("Failed to parse date to find yesterday:", e);
    return { missing: false, yesterdayDateStr: "", isHistoryEmpty: false };
  }

  const history = getCycleHistory();
  const projectHistory = history[projectId] || {};
  const isHistoryEmpty = Object.keys(projectHistory).length === 0;

  if (projectHistory[yesterdayDateStr] === undefined) {
    return { missing: true, yesterdayDateStr, isHistoryEmpty };
  }

  return { missing: false, yesterdayDateStr, isHistoryEmpty };
}

