import React, { useMemo, useRef, useState } from "react";
import Plot from "react-plotly.js";
import Plotly from "plotly.js";
import * as XLSX from "xlsx";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Battery,
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  FolderOpen,
  Loader2,
  RotateCcw,
  Sliders,
  Upload,
  Zap,
  Image as ImageIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  analyzeEss20Project,
  buildEss20Workbook,
  ESS20_PROJECTS,
  Ess20FileEntry,
  Ess20ProjectId,
  Ess20Result,
  formatDayTag,
  formatTime,
  checkRunBaselineInfo,
} from "../lib/ess20-engine";
import { ess20SharedState, matCodeSharedState, isBaselineMissing } from "../lib/ess20-shared-state";
import { MatFigExport } from "./MatFigExport";
import { ValidationDebug } from "./ValidationDebug";
import { 
  hcByProject,
  hcBulkImport,
  hcAcceptFiles,
  hcRunExport,
  getHcBusy,
  hcForceStop,
  hcResetActiveProject,
  expandZip,
  getHcActiveProject,
  setHcActiveProject,
  HC_CATS,
} from "../lib/audit-engine.js";

export interface PinnedPoint {
  id: string;        // xValue__seriesName
  xValue: string;    // yyyy-MM-dd HH:mm:ss format
  xDisplay: string;  // HH:mm for Plotly rendering
  yValue: number;
  seriesName: string;
  yaxisRef: string;  // y, y2, y3, y4, y5, y6
  color: string;
  subplot: number;   // 1, 2, or 3
}

type ViewMode = "report" | "pf" | "soc" | "qv" | "cycle" | "smart";

type TraceOption = {
  visible: boolean;
  width: number;
  style: "solid" | "dash" | "dot" | "dashdot" | "longdash";
};

function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

type GraphOptions = {
  showGridLines: boolean;
  showLegend: boolean;
  whiteBackground: boolean;
  smoothCurves: boolean;
  showMarkers: boolean;
  fillAreaY1: boolean;
  markerSize: number;
  customTitle: string;
  customY1Label: string;
  y1Min: string;
  y1Max: string;
  customY2Label: string;
  y2Min: string;
  y2Max: string;
  timeResolution: number;
  traces: Record<string, TraceOption>;
};

interface ESS20ToolProps {
  theme: "dark" | "light";
  project?: string;
  active?: boolean;
  progress: { pct: number; active: boolean; label: string };
  setProgress: React.Dispatch<React.SetStateAction<{ pct: number; active: boolean; label: string }>>;
  auditStateVersion?: number;
}

export function ESS20Tool({ theme, project, active, progress, setProgress, auditStateVersion }: ESS20ToolProps) {
  const [projectId, setProjectId] = useState<Ess20ProjectId>("SNTB");

  // Synchronize projectId with the global project prop
  React.useEffect(() => {
    if (project) {
      let mappedId: Ess20ProjectId = "SNTB";
      if (project.startsWith("SNTB")) mappedId = "SNTB";
      else if (project.startsWith("SNTV")) mappedId = "SNTV";
      else if (project.startsWith("SNTD_DMF")) mappedId = "SNTD_DMF";
      else if (project.startsWith("SNTZ")) mappedId = "SNTZ";
      else if (project.startsWith("MSGP")) mappedId = "MSGP";
      
      setProjectId(mappedId);
      // Clear run only if there isn't cached results for this project already
      if (!ess20SharedState.result) {
        clearRun();
      }
    }
  }, [project]);
  const getFullHcProjectId = (id: string) => {
    if (id === "SNTB") return "SNTB30MWH";
    if (id === "SNTV") return "SNTV12MWH";
    if (id === "SNTD_DMF") return "SNTD_DMF18MWH";
    if (id === "SNTZ") return "SNTZ3MWH";
    if (id === "MSGP") return "MSGP14MWH";
    return "SNTB30MWH";
  };

  React.useEffect(() => {
    const fullId = getFullHcProjectId(projectId);
    setHcActiveProject(fullId);
  }, [projectId]);

  const traverseFileTree = async (item: any, path: string): Promise<{ file: File; path: string }[]> => {
    return new Promise((resolve) => {
      if (item.isFile) {
        item.file((file: File) => {
          resolve([{ file, path: path + file.name }]);
        });
      } else if (item.isDirectory) {
        const dirReader = item.createReader();
        dirReader.readEntries(async (entries: any[]) => {
          const promises = [];
          for (let i = 0; i < entries.length; i++) {
            promises.push(traverseFileTree(entries[i], path + item.name + "/"));
          }
          const results = await Promise.all(promises);
          resolve(results.flat());
        });
      } else {
        resolve([]);
      }
    });
  };

  const getFilesFromDataTransfer = async (dt: DataTransfer): Promise<{ file: File; path: string }[]> => {
    if (dt.items && dt.items.length > 0 && typeof dt.items[0].webkitGetAsEntry === "function") {
      const promises = [];
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        const entry = item.webkitGetAsEntry();
        if (entry) {
          promises.push(traverseFileTree(entry, ""));
        }
      }
      const results = await Promise.all(promises);
      return results.flat();
    } else {
      return Array.from(dt.files).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    }
  };

  const syncActiveFilesFromAuditEngine = () => {
    const fullId = getFullHcProjectId(projectId);
    const currentPlants = hcByProject[fullId] || [];
    const collected: Ess20FileEntry[] = [];
    
    for (const plant of currentPlants) {
      const categories = ["POC", "ESS", "SmartLogger", "PCS"];
      for (const cat of categories) {
        const list = plant.files[cat] || [];
        for (const item of list) {
          collected.push({ file: item.file, path: item.path });
        }
      }
    }
    
    if (collected.length > 0) {
      setTodayFiles(collected);
      ess20SharedState.todayFiles = collected;
      return collected;
    }
    return [];
  };

  const [todayFiles, setTodayFiles] = useState<Ess20FileEntry[]>(ess20SharedState.todayFiles);
  const [yesterdayFiles, setYesterdayFiles] = useState<Ess20FileEntry[]>(ess20SharedState.yesterdayFiles);
  const [rawResult, setResult] = useState<Ess20Result | null>(ess20SharedState.result);
  const result = useMemo(() => {
    if (!rawResult) return null;
    if (!matCodeSharedState.config) return rawResult;
    return {
      ...rawResult,
      profile: {
        ...rawResult.profile,
        powerRange: matCodeSharedState.config.pylim || rawResult.profile.powerRange,
        powerTicks: matCodeSharedState.config.pticks || rawResult.profile.powerTicks,
        reactiveRange: matCodeSharedState.config.qylim || rawResult.profile.reactiveRange,
        reactiveTicks: matCodeSharedState.config.qticks || rawResult.profile.reactiveTicks,
      }
    };
  }, [rawResult, matCodeSharedState.config]);
  const [activeView, setActiveView] = useState<ViewMode>(ess20SharedState.activeView as ViewMode);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState(ess20SharedState.status);
  const [error, setError] = useState(ess20SharedState.error);
  const [dragTarget, setDragTarget] = useState<"today" | "yesterday" | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<"dashboard" | "export" | "validation">("dashboard");
  const [isInputting, setIsInputting] = useState(false);
  const [inputtingMessage, setInputtingMessage] = useState("");
  const [runPercent, setRunPercent] = useState(0);
  const [baselineModal, setBaselineModal] = useState<{
    show: boolean;
    todayDateStr: string;
    yesterdayDateStr: string;
    isHistoryEmpty: boolean;
    onConfirm: () => void;
  } | null>(null);

  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; size: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<{ file: File; path: string }[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showReportMode, setShowReportMode] = useState<"plots" | "validation">("validation");

  const archiveInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const [autoSave, setAutoSave] = useState<boolean>(ess20SharedState.autoSave);
  const [outputFolder, setOutputFolder] = useState<string | null>(ess20SharedState.outputFolder);
  const [pinnedPoints, setPinnedPoints] = useState<PinnedPoint[]>([]);
  const [graphOptions, setGraphOptions] = useState<GraphOptions>({
    showGridLines: true,
    showLegend: true,
    whiteBackground: false,
    smoothCurves: false,
    showMarkers: false,
    fillAreaY1: false,
    markerSize: 5,
    customTitle: "",
    customY1Label: "",
    y1Min: "",
    y1Max: "",
    customY2Label: "",
    y2Min: "",
    y2Max: "",
    timeResolution: 5,
    traces: {},
  });
  const [showGraphSettings, setShowGraphSettings] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState<"layout" | "axes" | "lines" | "time">("layout");

  React.useEffect(() => {
    (window as any).setMockResult = (mockData: any) => {
      setResult(mockData);
      setActiveView("report");
    };
    setTodayFiles(ess20SharedState.todayFiles);
    setYesterdayFiles(ess20SharedState.yesterdayFiles);
    setResult(ess20SharedState.result);
    setActiveView(ess20SharedState.activeView as ViewMode);
    setStatus(ess20SharedState.status);
    setError(ess20SharedState.error);
    setAutoSave(ess20SharedState.autoSave);
    setOutputFolder(ess20SharedState.outputFolder);
  }, [active, auditStateVersion]);

  React.useEffect(() => {
    ess20SharedState.todayFiles = todayFiles;
  }, [todayFiles]);

  React.useEffect(() => {
    ess20SharedState.yesterdayFiles = yesterdayFiles;
  }, [yesterdayFiles]);

  React.useEffect(() => {
    ess20SharedState.result = result;
  }, [result]);

  React.useEffect(() => {
    ess20SharedState.activeView = activeView;
  }, [activeView]);

  React.useEffect(() => {
    ess20SharedState.status = status;
  }, [status]);

  React.useEffect(() => {
    ess20SharedState.error = error;
  }, [error]);

  React.useEffect(() => {
    ess20SharedState.autoSave = autoSave;
  }, [autoSave]);

  React.useEffect(() => {
    ess20SharedState.outputFolder = outputFolder;
  }, [outputFolder]);

  const todayFolderRef = useRef<HTMLInputElement>(null);
  const todayFileRef = useRef<HTMLInputElement>(null);
  const yesterdayFolderRef = useRef<HTMLInputElement>(null);
  const yesterdayFileRef = useRef<HTMLInputElement>(null);
  const reportContainerRef = useRef<HTMLDivElement>(null);

  const autoDetectAndSetProject = (entries: Ess20FileEntry[]) => {
    if (!entries || entries.length === 0) return;
    for (const entry of entries) {
      const name = (entry.file?.name || "").toUpperCase();
      const pathStr = (entry.path || "").toUpperCase();
      for (const targetStr of [name, pathStr]) {
        if (targetStr.includes("SNTB")) {
          setProjectId("SNTB");
          return;
        }
        if (targetStr.includes("SNTV")) {
          setProjectId("SNTV");
          return;
        }
        if (targetStr.includes("SNTD_DMF") || targetStr.includes("SNTD-DMF") || targetStr.includes("DMF")) {
          setProjectId("SNTD_DMF");
          return;
        }
        if (targetStr.includes("SNTZ")) {
          setProjectId("SNTZ");
          return;
        }
        if (targetStr.includes("MSGP")) {
          setProjectId("MSGP");
          return;
        }
      }
    }
  };

  const profile = useMemo(() => {
    const base = ESS20_PROJECTS.find((p) => p.id === projectId) || ESS20_PROJECTS[0];
    if (!matCodeSharedState.config) return base;
    return {
      ...base,
      powerRange: matCodeSharedState.config.pylim || base.powerRange,
      powerTicks: matCodeSharedState.config.pticks || base.powerTicks,
      reactiveRange: matCodeSharedState.config.qylim || base.reactiveRange,
      reactiveTicks: matCodeSharedState.config.qticks || base.reactiveTicks,
    };
  }, [projectId, matCodeSharedState.config]);

  const triggerAutoSave = async (res: Ess20Result, folder: string) => {
    if (!folder || folder.includes("Browser Mode")) return;
    
    setStatus("Auto-saving MATLAB Figures (.fig) in background...");
    let figSaved = false;
    let figError = "";
    
    if (window.electronAPI && (window.electronAPI as any).saveMatlabFigures) {
      try {
        const matRes = await (window.electronAPI as any).saveMatlabFigures(folder, { ...res, pinnedPoints });
        if (matRes.ok) {
          figSaved = true;
        } else {
          figError = matRes.error || "CLI error";
        }
      } catch (err) {
        figError = err instanceof Error ? err.message : String(err);
      }
    }
    
    if (figSaved) {
      setStatus(`✓ Auto-saved 5 native MATLAB figures (.fig) & PNGs to: ${folder}`);
      return;
    }

    // Graceful fallback to Plotly image save
    setStatus(`⚠ MATLAB CLI not available (${figError || "matlab not in PATH"}). Saving high-res PNGs...`);
    
    // Wait for React and Plotly stable render
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    const container = reportContainerRef.current;
    if (!container) return;

    const plotContainers = container.querySelectorAll(".js-plotly-plot");
    if (!plotContainers.length) {
      return;
    }

    let savedCount = 0;
    const names = ["pf", "soc", "vavg"];

    for (let i = 0; i < Math.min(plotContainers.length, names.length); i++) {
      const plotEl = plotContainers[i] as HTMLElement;
      try {
        const scaleNum = parseInt(ess20SharedState.scale, 10) || 2;
        const imgData = await Plotly.toImage(plotEl, {
          format: "png",
          width: 960,
          height: 540,
          scale: scaleNum,
        });

        const base64Data = imgData.replace(/^data:image\/png;base64,/, "");
        const fileName = `${res.profile.outputPrefix}_${res.dataDate}_${names[i]}.png`;
        const fullPath = `${folder}\\${fileName}`.replace(/\\\\/g, "\\");

        if (window.electronAPI) {
          const writeRes = await window.electronAPI.saveFile(fullPath, base64Data);
          if (writeRes.ok) {
            savedCount++;
          }
        }
      } catch (err) {
        console.error(`Auto-save error on index ${i}:`, err);
      }
    }

    if (savedCount > 0) {
      setStatus(`✓ Auto-saved ${savedCount} high-resolution charts to: ${folder}`);
    } else {
      setStatus("Auto-save completed (browser mode or no files written).");
    }
  };

  const runAnalysis = async (forceBaseline = false) => {
    const activeFiles = syncActiveFilesFromAuditEngine();
    const filesToUse = activeFiles.length ? activeFiles : todayFiles;

    if (!filesToUse.length) {
      setError("Please select or drop a project Zip file or BESS spreadsheets first.");
      return;
    }

    if (!forceBaseline) {
      try {
        const { todayDateStr, yesterdayDateStr, hasYesterdayFiles, hasTodayEssFiles } = await checkRunBaselineInfo(projectId, filesToUse, yesterdayFiles);
        const baselineCheck = isBaselineMissing(projectId, todayDateStr, hasYesterdayFiles, hasTodayEssFiles);
        if (baselineCheck.missing) {
          setBaselineModal({
            show: true,
            todayDateStr,
            yesterdayDateStr,
            isHistoryEmpty: baselineCheck.isHistoryEmpty,
            onConfirm: () => {
              setBaselineModal(null);
              runAnalysis(true);
            }
          });
          return;
        }
      } catch (err) {
        // If parsing data dates fails, we let the main engine execution report it
      }
    }

    setIsProcessing(true);
    setError("");
    setRunPercent(5);
    
    try {
      setStatus("Initializing daily analysis engine...");
      await new Promise((resolve) => setTimeout(resolve, 300));
      
      setRunPercent(20);
      setStatus("Ingesting and parsing Excel telemetry workbooks...");
      await new Promise((resolve) => setTimeout(resolve, 350));
      
      setRunPercent(50);
      setStatus("Executing equivalent cycle algorithms and grid stability math...");
      const nextResult = await analyzeEss20Project(projectId, filesToUse, yesterdayFiles);
      
      setRunPercent(80);
      setStatus("Compiling Plotly layouts and customizing subplots...");
      await new Promise((resolve) => setTimeout(resolve, 400));
      
      setRunPercent(95);
      setStatus("Rendering premium subplots...");
      await new Promise((resolve) => setTimeout(resolve, 200));
      
      setRunPercent(100);
      setResult(nextResult);
      setActiveView("report");
      setShowReportMode("plots");
      setStatus(`Processed ${nextResult.files.essTodayCount} ESS files and ${nextResult.main.times.length} timeline points.`);

      // Trigger automatic save to folder if active and selected
      if (autoSave && outputFolder && !outputFolder.includes("Browser Mode")) {
        setTimeout(() => triggerAutoSave(nextResult, outputFolder), 1000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("Analysis failed.");
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadWorkbook = () => {
    if (!result) return;
    const wb = buildEss20Workbook(result);
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${result.profile.outputPrefix}_${result.dayTag}_daily_vavg_cycle.xlsx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 200);
  };

  const buildChartHtml = (data: any[], layout: any, title: string) => {
    const serializedData = JSON.stringify(data);
    const serializedLayout = JSON.stringify(layout);
    const serializedOptions = JSON.stringify(graphOptions);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EMS Toolbox - Interactive Graph Export (${result?.profile.label || "Project"})</title>
  <!-- Tailwind CSS -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- Plotly.js -->
  <script src="https://cdn.plot.ly/plotly-2.24.1.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'JetBrains Mono', monospace;
    }
    /* Custom Scrollbar for premium feel */
    ::-webkit-scrollbar {
      width: 4px;
      height: 4px;
    }
    ::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.02);
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.12);
      border-radius: 2px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(0, 163, 255, 0.4);
    }
  </style>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            background: '#0B0F19',
            panel: '#151F32',
            borderV: 'rgba(255, 255, 255, 0.08)',
            accentBlue: '#00A3FF',
          }
        }
      }
    }
  </script>
</head>
<body class="bg-background text-gray-200 h-screen flex flex-col overflow-hidden dark">
  <!-- Header -->
  <header class="h-12 bg-panel border-b border-borderV flex items-center justify-between px-4 shrink-0">
    <div class="flex items-center gap-4">
      <h1 class="font-bold tracking-tight text-sm">
        EMS TOOLBOX <span class="font-normal text-gray-400">ENTERPRISE PORTABLE VIEW</span>
      </h1>
      <div id="pin-counter-container" class="flex items-center gap-1.5 ml-2 font-mono"></div>
    </div>
    <div class="flex items-center gap-3 text-[10px] font-mono">
      <span class="text-gray-500">PROJECT:</span>
      <span class="text-accentBlue font-bold bg-accentBlue/10 px-2 py-0.5 rounded">${result?.profile.label || "BESS"}</span>
      <span class="text-gray-500 ml-2">DATE:</span>
      <span class="text-accentBlue font-bold bg-accentBlue/10 px-2 py-0.5 rounded">${result?.dataDate || ""}</span>
    </div>
  </header>

  <!-- Content Grid -->
  <div class="flex-1 flex overflow-hidden">
    <!-- Plot Area -->
    <div class="flex-1 flex flex-col overflow-y-auto p-4" id="chart-area-container">
      <div class="text-center text-[13px] tracking-wider mb-2 font-bold" id="plot-main-title">
        <b>${result?.dataDate || ""} | ${title}</b>
      </div>
      <div class="flex-1 flex flex-col gap-4" id="chart-area">
        <div id="chart" class="w-full h-full min-h-[500px]"></div>
      </div>
    </div>

    <!-- Properties Panel -->
    <div class="w-72 bg-panel border-l border-borderV flex flex-col overflow-hidden shrink-0">
      <!-- Tab bar header -->
      <div class="px-3 pt-2 pb-0 border-b border-borderV bg-[#1C283F] shrink-0">
        <div class="flex items-center justify-between mb-2">
          <div class="font-bold text-[10px] uppercase tracking-wider text-gray-400 flex items-center gap-1.5 font-mono">
            ⚙️ Graph Properties
          </div>
          <button onclick="resetAllConfig()" class="text-[8px] font-mono uppercase tracking-wider text-gray-400 hover:text-red-400 transition-colors px-1.5 py-0.5 border border-borderV rounded hover:bg-white/5">
            Reset
          </button>
        </div>
        <div class="flex gap-0 text-[8px] font-bold uppercase tracking-wider">
          <button data-tab="layout" onclick="setTab('layout')" class="tab-btn flex-1 py-1.5 border-b-2 border-accentBlue text-accentBlue transition-colors text-center">Layout</button>
          <button data-tab="axes" onclick="setTab('axes')" class="tab-btn flex-1 py-1.5 border-b-2 border-transparent text-gray-500 hover:text-gray-300 transition-colors text-center">Axes</button>
          <button data-tab="lines" onclick="setTab('lines')" class="tab-btn flex-1 py-1.5 border-b-2 border-transparent text-gray-500 hover:text-gray-300 transition-colors text-center">Lines</button>
          <button data-tab="time" onclick="setTab('time')" class="tab-btn flex-1 py-1.5 border-b-2 border-transparent text-gray-500 hover:text-gray-300 transition-colors text-center">Time</button>
        </div>
      </div>

      <!-- Tab Content Area -->
      <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-3.5 text-[11px] font-mono">
        <!-- TAB: Layout -->
        <div id="section-layout" class="tab-section flex flex-col gap-3">
          <div class="flex flex-col gap-2">
            <label class="flex items-center justify-between p-1.5 hover:bg-white/5 rounded cursor-pointer select-none">
              <span>Show Grid Lines</span>
              <div id="toggle-showGrid" onclick="toggleKey('showGrid')" class="w-8 h-4 rounded-full relative transition-colors bg-accentBlue">
                <div class="circle absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all left-[18px]"></div>
              </div>
            </label>
            <label class="flex items-center justify-between p-1.5 hover:bg-white/5 rounded cursor-pointer select-none">
              <span>Show Legend</span>
              <div id="toggle-showLegend" onclick="toggleKey('showLegend')" class="w-8 h-4 rounded-full relative transition-colors bg-accentBlue">
                <div class="circle absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all left-[18px]"></div>
              </div>
            </label>
            <label class="flex items-center justify-between p-1.5 hover:bg-white/5 rounded cursor-pointer select-none">
              <span>White Background</span>
              <div id="toggle-bgWhite" onclick="toggleKey('bgWhite')" class="w-8 h-4 rounded-full relative transition-colors bg-gray-700">
                <div class="circle absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all left-0.5"></div>
              </div>
            </label>
            <label class="flex items-center justify-between p-1.5 hover:bg-white/5 rounded cursor-pointer select-none">
              <span>Smooth Curves</span>
              <div id="toggle-smooth" onclick="toggleKey('smooth')" class="w-8 h-4 rounded-full relative transition-colors bg-gray-700">
                <div class="circle absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all left-0.5"></div>
              </div>
            </label>
            <label class="flex items-center justify-between p-1.5 hover:bg-white/5 rounded cursor-pointer select-none">
              <span>Data Markers</span>
              <div id="toggle-showMarkers" onclick="toggleKey('showMarkers')" class="w-8 h-4 rounded-full relative transition-colors bg-gray-700">
                <div class="circle absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all left-0.5"></div>
              </div>
            </label>
            <div id="marker-size-container" class="flex items-center justify-between gap-2 p-1.5 border-t border-borderV/30 pt-2 shrink-0 hidden">
              <span class="text-gray-500 shrink-0">Marker Size</span>
              <input type="range" id="slider-markerSize" min="2" max="12" step="1" oninput="updateMarkerSize(parseInt(this.value))" class="flex-1 h-1 accent-accentBlue cursor-pointer bg-gray-800" />
              <span class="w-4 text-right text-accentBlue" id="markerSize-label">5</span>
            </div>
            <label class="flex items-center justify-between p-1.5 hover:bg-white/5 rounded cursor-pointer select-none">
              <span>Fill Area (Y1)</span>
              <div id="toggle-fillArea" onclick="toggleKey('fillArea')" class="w-8 h-4 rounded-full relative transition-colors bg-gray-700">
                <div class="circle absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all left-0.5"></div>
              </div>
            </label>
            <div class="flex flex-col gap-1 mt-1 border-t border-borderV/30 pt-2 shrink-0">
              <span class="text-gray-500 text-[8px] uppercase tracking-widest font-bold font-mono">Plot Title Override</span>
              <input type="text" id="input-customTitle" oninput="updateInput('customTitle', this.value)" placeholder="(use default)" class="h-7 bg-[#0F172A] border border-gray-700 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accentBlue font-mono w-full" />
            </div>
          </div>
        </div>

        <!-- TAB: Axes -->
        <div id="section-axes" class="tab-section flex flex-col gap-3.5 hidden">
          <div class="flex flex-col gap-2">
            <div class="text-[8px] uppercase tracking-widest text-accentBlue font-bold border-b border-borderV/40 pb-1">Left Y-Axis (Y1)</div>
            <div class="flex flex-col gap-1">
              <span class="text-gray-500 text-[8px] uppercase">Label Override</span>
              <input type="text" id="input-customY1Label" oninput="updateInput('customY1Label', this.value)" placeholder="(use default)" class="h-7 bg-[#0F172A] border border-gray-700 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accentBlue font-mono w-full" />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="flex flex-col gap-1">
                <span class="text-gray-500 text-[8px] uppercase">Min Bound</span>
                <input type="number" id="input-y1Min" oninput="updateInput('y1Min', this.value)" placeholder="auto" class="h-7 bg-[#0F172A] border border-gray-700 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accentBlue font-mono w-full" />
              </div>
              <div class="flex flex-col gap-1">
                <span class="text-gray-500 text-[8px] uppercase">Max Bound</span>
                <input type="number" id="input-y1Max" oninput="updateInput('y1Max', this.value)" placeholder="auto" class="h-7 bg-[#0F172A] border border-gray-700 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accentBlue font-mono w-full" />
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <div class="text-[8px] uppercase tracking-widest text-orange-400 font-bold border-b border-borderV/40 pb-1">Right Y-Axis (Y2)</div>
            <div class="flex flex-col gap-1">
              <span class="text-gray-500 text-[8px] uppercase">Label Override</span>
              <input type="text" id="input-customY2Label" oninput="updateInput('customY2Label', this.value)" placeholder="(use default)" class="h-7 bg-[#0F172A] border border-gray-700 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accentBlue font-mono w-full" />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="flex flex-col gap-1">
                <span class="text-gray-500 text-[8px] uppercase">Min Bound</span>
                <input type="number" id="input-y2Min" oninput="updateInput('y2Min', this.value)" placeholder="auto" class="h-7 bg-[#0F172A] border border-gray-700 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accentBlue font-mono w-full" />
              </div>
              <div class="flex flex-col gap-1">
                <span class="text-gray-500 text-[8px] uppercase">Max Bound</span>
                <input type="number" id="input-y2Max" oninput="updateInput('y2Max', this.value)" placeholder="auto" class="h-7 bg-[#0F172A] border border-gray-700 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accentBlue font-mono w-full" />
              </div>
            </div>
          </div>
        </div>

        <!-- TAB: Lines -->
        <div id="section-lines" class="tab-section flex flex-col gap-3.5 hidden">
          <div class="text-[8px] uppercase tracking-widest text-gray-500 border-b border-borderV/40 pb-1 font-mono">Per-Series Line Styles</div>
          <div id="lines-series-container" class="flex flex-col gap-2 max-h-[300px] overflow-y-auto pr-1">
            <!-- Dynamic elements generated by script -->
          </div>
        </div>

        <!-- TAB: Time -->
        <div id="section-time" class="tab-section flex flex-col gap-3.5 hidden">
          <div class="text-[8px] uppercase tracking-widest text-gray-500 border-b border-borderV/40 pb-1 font-mono">Time Downsampling</div>
          <div class="flex flex-col gap-1.5 mt-1">
            <span class="text-gray-500 text-[9px]">Downsampling Resolution</span>
            <select id="select-resolution" onchange="updateResolution(parseInt(this.value))" class="h-7 bg-[#0F172A] border border-gray-700 rounded px-2 text-[10px] text-white focus:outline-none font-mono w-full">
              <option value="5">5 Minutes (Raw Data)</option>
              <option value="10">10 Minutes</option>
              <option value="15">15 Minutes</option>
              <option value="30">30 Minutes</option>
              <option value="60">60 Minutes (1 Hour)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const baseData = ${serializedData};
    const baseLayout = ${serializedLayout};
    const initialConfig = ${serializedOptions};
    const pinnedPoints = [];

    // Map UI names to internal config schema
    const graphConfig = {
      showGrid: initialConfig.showGridLines ?? true,
      showLegend: initialConfig.showLegend ?? true,
      bgWhite: initialConfig.whiteBackground ?? false,
      smooth: initialConfig.smoothCurves ?? false,
      showMarkers: initialConfig.showMarkers ?? false,
      markerSize: initialConfig.markerSize ?? 5,
      fillArea: initialConfig.fillAreaY1 ?? false,
      customTitle: initialConfig.customTitle ?? '',
      customY1Label: initialConfig.customY1Label ?? '',
      y1Min: initialConfig.y1Min ?? '',
      y1Max: initialConfig.y1Max ?? '',
      customY2Label: initialConfig.customY2Label ?? '',
      y2Min: initialConfig.y2Min ?? '',
      y2Max: initialConfig.y2Max ?? '',
      timeResolution: initialConfig.timeResolution ?? 5,
      traces: initialConfig.traces ?? {}
    };

    function setTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => {
        if (btn.dataset.tab === tabId) {
          btn.classList.add('text-accentBlue', 'border-accentBlue');
          btn.classList.remove('text-gray-500', 'border-transparent');
        } else {
          btn.classList.remove('text-accentBlue', 'border-accentBlue');
          btn.classList.add('text-gray-500', 'border-transparent');
        }
      });
      document.querySelectorAll('.tab-section').forEach(sec => {
        if (sec.id === 'section-' + tabId) {
          sec.classList.remove('hidden');
        } else {
          sec.classList.add('hidden');
        }
      });
    }

    function toggleKey(key) {
      graphConfig[key] = !graphConfig[key];
      syncToggleUI(key);
      if (key === 'showMarkers') {
        const el = document.getElementById('marker-size-container');
        if (graphConfig.showMarkers) el.classList.remove('hidden');
        else el.classList.add('hidden');
      }
      renderPlot();
    }

    function syncToggleUI(key) {
      const el = document.getElementById('toggle-' + key);
      if (!el) return;
      const circle = el.querySelector('.circle');
      if (graphConfig[key]) {
        el.classList.add('bg-accentBlue');
        el.classList.remove('bg-gray-700');
        circle.classList.add('left-[18px]');
        circle.classList.remove('left-0.5');
      } else {
        el.classList.remove('bg-accentBlue');
        el.classList.add('bg-gray-700');
        circle.classList.add('left-0.5');
        circle.classList.remove('left-[18px]');
      }
    }

    function updateInput(key, val) {
      graphConfig[key] = val;
      renderPlot();
    }

    function updateMarkerSize(val) {
      graphConfig.markerSize = val;
      document.getElementById('markerSize-label').innerText = val;
      renderPlot();
    }

    function updateResolution(val) {
      graphConfig.timeResolution = val;
      renderPlot();
    }

    function resetAllConfig() {
      graphConfig.showGrid = true;
      graphConfig.showLegend = true;
      graphConfig.bgWhite = false;
      graphConfig.smooth = false;
      graphConfig.showMarkers = false;
      graphConfig.markerSize = 5;
      graphConfig.fillArea = false;
      graphConfig.customTitle = '';
      graphConfig.customY1Label = '';
      graphConfig.y1Min = '';
      graphConfig.y1Max = '';
      graphConfig.customY2Label = '';
      graphConfig.y2Min = '';
      graphConfig.y2Max = '';
      graphConfig.timeResolution = 5;
      graphConfig.traces = {};

      // Sync form controls
      document.getElementById('input-customTitle').value = '';
      document.getElementById('input-customY1Label').value = '';
      document.getElementById('input-y1Min').value = '';
      document.getElementById('input-y1Max').value = '';
      document.getElementById('input-customY2Label').value = '';
      document.getElementById('input-y2Min').value = '';
      document.getElementById('input-y2Max').value = '';
      document.getElementById('select-resolution').value = '5';
      document.getElementById('slider-markerSize').value = '5';
      document.getElementById('markerSize-label').innerText = '5';
      document.getElementById('marker-size-container').classList.add('hidden');

      ['showGrid', 'showLegend'].forEach(k => {
        syncToggleUI(k);
      });
      ['bgWhite', 'smooth', 'showMarkers', 'fillArea'].forEach(k => {
        syncToggleUI(k);
      });

      pinnedPoints.length = 0;
      updatePinCounter();
      renderLinesTab();
      renderPlot();
    }

    function renderLinesTab() {
      const container = document.getElementById('lines-series-container');
      if (!container) return;

      container.innerHTML = baseData.map((trace, idx) => {
        const name = trace.name || ('Series ' + (idx + 1));
        if (!graphConfig.traces[name]) {
          graphConfig.traces[name] = { visible: true, width: trace.line?.width || 1.5, style: trace.line?.dash || 'solid' };
        }
        const custom = graphConfig.traces[name];
        const isVisibleChecked = custom.visible ? 'checked' : '';
        const dashOptions = [
          { val: 'solid', label: '— Solid' },
          { val: 'dash', label: '- - Dashed' },
          { val: 'dot', label: '··· Dotted' },
          { val: 'dashdot', label: '-·- Dash-Dot' },
          { val: 'longdash', label: '— Long Dash' }
        ];
        const dashSelect = dashOptions.map(opt => {
          const selected = custom.style === opt.val ? 'selected' : '';
          return '<option value="' + opt.val + '" ' + selected + '>' + opt.label + '</option>';
        }).join('');

        return '<div class="border border-borderV bg-[#0F172A]/40 rounded p-2 flex flex-col gap-2 shrink-0 mb-1">' +
          '<div class="flex items-center justify-between">' +
            '<span class="font-bold text-[9px] uppercase tracking-wider text-gray-300 truncate w-32" title="' + name + '">' + name + '</span>' +
            '<label class="flex items-center gap-1 cursor-pointer select-none text-gray-400 text-[8px]">' +
              'Visible ' +
              '<input type="checkbox" ' + isVisibleChecked + ' onchange="updateTraceVisible(\\\'' + name + '\\\', this.checked)" class="w-3.5 h-3.5 rounded border-gray-700 bg-gray-900 text-accentBlue accent-accentBlue cursor-pointer" />' +
            '</label>' +
          '</div>' +
          '<div class="flex items-center gap-2">' +
            '<span class="text-gray-500 text-[8px] w-10">Width</span>' +
            '<input type="range" min="0.5" max="5" step="0.5" value="' + custom.width + '" oninput="updateTraceWidth(\\\'' + name + '\\\', parseFloat(this.value))" class="flex-1 h-1 accent-accentBlue cursor-pointer" />' +
            '<span class="text-accentBlue text-[8px] w-5 text-right font-bold" id="width-val-' + idx + '">' + Number(custom.width).toFixed(1) + '</span>' +
          '</div>' +
          '<div class="flex items-center gap-2">' +
            '<span class="text-gray-400 text-[8px] w-10">Dash</span>' +
            '<select onchange="updateTraceStyle(\\\'' + name + '\\\', this.value)" class="flex-1 h-5 bg-[#0F172A] border border-gray-700 rounded px-1 text-[8px] text-white focus:outline-none">' +
              dashSelect +
            '</select>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function updateTraceVisible(name, val) {
      graphConfig.traces[name].visible = val;
      renderPlot();
    }

    function updateTraceWidth(name, val) {
      graphConfig.traces[name].width = val;
      const idx = baseData.findIndex(t => (t.name || '') === name);
      if (idx >= 0) {
        const el = document.getElementById('width-val-' + idx);
        if (el) el.innerText = val.toFixed(1);
      }
      renderPlot();
    }

    function updateTraceStyle(name, val) {
      graphConfig.traces[name].style = val;
      renderPlot();
    }

    function renderPlot() {
      const bg = graphConfig.bgWhite ? '#FFFFFF' : '#151F32';
      const fontColor = graphConfig.bgWhite ? '#333333' : '#E0E0E0';
      const gridColor = graphConfig.bgWhite ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)';

      const res = graphConfig.timeResolution || 5;
      const step = res / 5;

      const modifiedData = baseData.map((trace, traceIdx) => {
        // 1. Downsample
        let dx = trace.x;
        let dy = trace.y;
        if (step > 1 && trace.x && trace.y) {
          dx = [];
          dy = [];
          for (let i = 0; i < trace.x.length; i += step) {
            dx.push(trace.x[i]);
            dy.push(trace.y[i]);
          }
        }

        // 2. Apply styling from graphConfig.traces
        const name = trace.name || ('Series ' + (traceIdx + 1));
        const custom = graphConfig.traces[name] || { visible: true, width: trace.line?.width || 1.5, style: trace.line?.dash || 'solid' };
        const mode = graphConfig.showMarkers ? 'lines+markers' : 'lines';

        const traceObj = {
          ...trace,
          x: dx,
          y: dy,
          visible: custom.visible,
          mode: mode,
          line: {
            ...trace.line,
            width: custom.width,
            shape: graphConfig.smooth ? 'spline' : (trace.line?.shape ?? 'linear')
          }
        };

        if (graphConfig.showMarkers) {
          traceObj.marker = { size: graphConfig.markerSize };
        }
        if (custom.style !== 'solid') {
          traceObj.line.dash = custom.style;
        }
        if (graphConfig.fillArea && !trace.yaxis) {
          traceObj.fill = 'tozeroy';
          traceObj.fillcolor = (trace.line?.color ?? '#0072BD') + '22';
        }
        return traceObj;
      });

      const annotations = pinnedPoints.map(pt => ({
        x: pt.x,
        y: pt.y,
        yref: pt.yref,
        xref: 'x',
        text: pt.text,
        showarrow: true,
        arrowhead: 2,
        arrowcolor: pt.color,
        arrowsize: 1,
        arrowwidth: 1.5,
        ax: pt.ax,
        ay: pt.ay,
        bgcolor: 'rgba(255,255,255,0.94)',
        bordercolor: pt.color,
        borderwidth: 1.5,
        borderpad: 4,
        opacity: 0.97,
        font: { family: 'Arial, sans-serif', size: 8, color: '#111111' }
      }));

      // Apply axis limit overrides in offline HTML
      const hasY1Min = graphConfig.y1Min !== '';
      const hasY1Max = graphConfig.y1Max !== '';
      let y1Range = baseLayout.yaxis?.range;
      if (hasY1Min || hasY1Max) {
        const defaultMin = baseLayout.yaxis?.range ? baseLayout.yaxis.range[0] : -80;
        const defaultMax = baseLayout.yaxis?.range ? baseLayout.yaxis.range[1] : 80;
        y1Range = [
          hasY1Min ? parseFloat(graphConfig.y1Min) : defaultMin,
          hasY1Max ? parseFloat(graphConfig.y1Max) : defaultMax
        ];
      }

      const hasY2Min = graphConfig.y2Min !== '';
      const hasY2Max = graphConfig.y2Max !== '';
      let y2Range = null;
      if (hasY2Min || hasY2Max) {
        // Find a default right axis range to fall back on
        let defaultMin = 0;
        let defaultMax = 100;
        if (baseLayout.yaxis6?.range) {
          defaultMin = baseLayout.yaxis6.range[0];
          defaultMax = baseLayout.yaxis6.range[1];
        } else if (baseLayout.yaxis2?.range) {
          defaultMin = baseLayout.yaxis2.range[0];
          defaultMax = baseLayout.yaxis2.range[1];
        }
        y2Range = [
          hasY2Min ? parseFloat(graphConfig.y2Min) : defaultMin,
          hasY2Max ? parseFloat(graphConfig.y2Max) : defaultMax
        ];
      }

      const modifiedLayout = {
        ...baseLayout,
        title: {
          text: '<b>' + (graphConfig.customTitle || baseLayout.title?.text || '') + '</b>',
          font: { family: 'Arial, sans-serif', size: 12, color: fontColor }
        },
        paper_bgcolor: bg,
        plot_bgcolor: bg,
        font: { family: 'Arial, sans-serif', size: 9, color: fontColor },
        showlegend: graphConfig.showLegend,
        xaxis: {
          ...baseLayout.xaxis,
          showgrid: graphConfig.showGrid,
          gridcolor: gridColor,
          tickfont: { color: fontColor }
        },
        yaxis: {
          ...baseLayout.yaxis,
          title: { text: '<b>' + (graphConfig.customY1Label || baseLayout.yaxis?.title?.text || '') + '</b>', font: { color: '#0072BD', size: 10 } },
          showgrid: graphConfig.showGrid,
          gridcolor: gridColor,
          tickfont: { color: '#0072BD' },
          ...(y1Range ? { range: y1Range } : {})
        },
        annotations: annotations.concat(baseLayout.annotations || [])
      };

      if (modifiedLayout.xaxis2) {
        modifiedLayout.xaxis2.showgrid = graphConfig.showGrid;
        modifiedLayout.xaxis2.gridcolor = gridColor;
        modifiedLayout.xaxis2.tickfont = { color: fontColor };
      }
      if (modifiedLayout.xaxis3) {
        modifiedLayout.xaxis3.showgrid = graphConfig.showGrid;
        modifiedLayout.xaxis3.gridcolor = gridColor;
        modifiedLayout.xaxis3.tickfont = { color: fontColor };
      }

      // Handle other axes in subplots (grid/report view)
      if (modifiedLayout.yaxis3) {
        modifiedLayout.yaxis3.showgrid = graphConfig.showGrid;
        modifiedLayout.yaxis3.gridcolor = gridColor;
        modifiedLayout.yaxis3.title.text = '<b>' + (graphConfig.customY1Label || baseLayout.yaxis3.title?.text || '') + '</b>';
        if (y1Range) modifiedLayout.yaxis3.range = y1Range;
      }
      if (modifiedLayout.yaxis5) {
        modifiedLayout.yaxis5.showgrid = graphConfig.showGrid;
        modifiedLayout.yaxis5.gridcolor = gridColor;
      }
      if (modifiedLayout.yaxis6) {
        modifiedLayout.yaxis6.title.text = '<b>' + (graphConfig.customY2Label || baseLayout.yaxis6.title?.text || '') + '</b>';
        if (y2Range) modifiedLayout.yaxis6.range = y2Range;
      }
      if (modifiedLayout.yaxis2) {
        if (y2Range && !modifiedLayout.yaxis6) {
          // Only override y2 range in single plot
          modifiedLayout.yaxis2.range = y2Range;
        }
        if (modifiedLayout.yaxis2.title) {
          modifiedLayout.yaxis2.title.text = '<b>' + (graphConfig.customY2Label || baseLayout.yaxis2.title?.text || '') + '</b>';
        }
      }

      Plotly.newPlot('chart', modifiedData, modifiedLayout, { displaylogo: false, responsive: true }).then(gd => {
        gd.on('plotly_click', handlePlotClick);
      });
    }

    function handlePlotClick(eventData) {
      if (!eventData || !eventData.points || eventData.points.length === 0) return;
      const pt = eventData.points[0];
      if (pt.x == null || pt.y == null) return;

      const xVal = String(pt.x);
      const yVal = Number(pt.y);
      const name = pt.data?.name || 'Series';
      const color = pt.data?.line?.color || '#00A3FF';
      const isY2 = pt.data?.yaxis === 'y2' || pt.data?.yaxis === 'y4' || pt.data?.yaxis === 'y6';
      const id = xVal + '__' + name;

      const existingIdx = pinnedPoints.findIndex(p => p.id === id);
      if (existingIdx >= 0) {
        pinnedPoints.splice(existingIdx, 1);
      } else {
        const offset = pinnedPoints.length % 2 === 0 ? -40 : 40;
        pinnedPoints.push({
          id: id,
          x: xVal,
          y: yVal,
          yref: isY2 ? (pt.data?.yaxis || 'y2') : (pt.data?.yaxis || 'y'),
          text: '<b>' + xVal + '</b><br>' + yVal.toFixed(3) + ' (' + name + ')',
          color: color,
          ax: 30,
          ay: offset
        });
      }
      renderPlot();
      updatePinCounter();
    }

    function updatePinCounter() {
      const container = document.getElementById('pin-counter-container');
      if (!container) return;
      if (pinnedPoints.length > 0) {
        container.innerHTML = '<span class="bg-accentBlue/10 text-accentBlue border border-accentBlue/30 px-1.5 py-0.5 rounded text-[8px] font-bold">' +
          pinnedPoints.length + ' pin' + (pinnedPoints.length > 1 ? 's' : '') +
          '</span>' +
          '<button onclick="clearAllPins()" class="text-[8px] font-mono text-gray-400 hover:text-red-400 border border-borderV hover:border-red-400/30 px-1.5 py-0.5 rounded transition-colors ml-1" title="Clear all pins">Clear</button>';
      } else {
        container.innerHTML = '';
      }
    }

    function clearAllPins() {
      pinnedPoints.length = 0;
      renderPlot();
      updatePinCounter();
    }

    // Initialize inputs with active config values
    window.onload = () => {
      document.getElementById('input-customTitle').value = graphConfig.customTitle;
      document.getElementById('input-customY1Label').value = graphConfig.customY1Label;
      document.getElementById('input-y1Min').value = graphConfig.y1Min;
      document.getElementById('input-y1Max').value = graphConfig.y1Max;
      document.getElementById('input-customY2Label').value = graphConfig.customY2Label;
      document.getElementById('input-y2Min').value = graphConfig.y2Min;
      document.getElementById('input-y2Max').value = graphConfig.y2Max;
      document.getElementById('select-resolution').value = String(graphConfig.timeResolution);
      document.getElementById('slider-markerSize').value = String(graphConfig.markerSize);
      document.getElementById('markerSize-label').innerText = String(graphConfig.markerSize);

      if (graphConfig.showMarkers) {
        document.getElementById('marker-size-container').classList.remove('hidden');
      }

      ['showGrid', 'showLegend', 'bgWhite', 'smooth', 'showMarkers', 'fillArea'].forEach(k => {
        syncToggleUI(k);
      });

      renderLinesTab();
      renderPlot();
      updatePinCounter();
    };
  </script>
</body>
</html>`;
  };

  const exportCurrentChartAsHTML = () => {
    if (!result) return;
    const rawOptions = { ...graphOptions, timeResolution: 5 };
    const chartSpec = (() => {
      switch (activeView) {
        case "report":
          return { data: reportGridTraces(result, result.main.times.map(formatTime), rawOptions), layout: reportGridLayout(result, result.main.times.map(formatTime), rawOptions), title: "Daily Evaluation Report" };
        case "pf":
          return { data: pfTraces(result, result.main.times.map(formatTime), rawOptions), layout: layout(result, "Active Power vs Frequency", "P (MW)", "F (Hz)", result.profile.powerRange, [49.7, 50.3], undefined, rawOptions), title: "Active Power vs Frequency" };
        case "soc":
          return { data: socTraces(result, result.main.times.map(formatTime), rawOptions), layout: layout(result, "Active Power and SOC", "P (MW)", "SOC (%)", result.profile.powerRange, [0, 100], cycleAnnotation(result), rawOptions), title: "Active Power and SOC" };
        case "qv":
          return { data: qvTraces(result, result.main.times.map(formatTime), rawOptions), layout: layout(result, "Voltage vs Reactive Power", "Line Voltage (kV)", "Q (MVar)", undefined, result.profile.reactiveRange, undefined, rawOptions), title: "Voltage vs Reactive Power" };
        case "cycle": {
          const x = result.cycle.timeline?.times.map(formatTime) ?? [];
          return { data: [{ x, y: result.cycle.timeline?.avgCycles ?? [], type: "scatter", mode: "lines", name: "Average Equivalent Cycles", line: { color: "#0072BD", width: 2, shape: "linear" } }], layout: layout(result, "ESS Average Equivalent Cycle Timeline", "Average Cycles", "", undefined, undefined, undefined, rawOptions), title: "Cycle Timeline" };
        }
        case "smart": {
          const x = result.smartLogger?.times.map(formatTime) ?? [];
          return { data: [{ x, y: result.smartLogger?.totalPMw ?? [], type: "scatter", mode: "lines", name: "Total P (MW)", line: { color: "#0072BD", width: 2 } }, { x, y: result.smartLogger?.totalQMvar ?? [], type: "scatter", mode: "lines", name: "Total Q (MVar)", yaxis: "y2", line: { color: "#D95319", width: 2 } }], layout: layout(result, "SmartLogger Summed Power", "P (MW)", "Q (MVar)", undefined, result.profile.reactiveRange, undefined, rawOptions), title: "SmartLogger" };
        }
        default:
          return { data: [], layout: {}, title: "Daily Evaluation" };
      }
    })();

    const html = buildChartHtml(chartSpec.data, chartSpec.layout, chartSpec.title);
    const blob = new Blob([html], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${result.profile.outputPrefix}_${activeView}_graph.html`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 200);
  };

  const exportAllChartsAsHTML = () => {
    if (!result) return;
    const rawOptions = { ...graphOptions, timeResolution: 5 };
    const viewsToExport: { view: ViewMode; title: string }[] = [
      { view: "report", title: "Daily Evaluation Report" },
      { view: "pf", title: "Active Power vs Frequency" },
      { view: "soc", title: "Active Power and SOC" },
      { view: "qv", title: "Voltage vs Reactive Power" }
    ];
    if (result.cycle.timeline) {
      viewsToExport.push({ view: "cycle", title: "ESS Average Equivalent Cycle Timeline" });
    }
    if (result.smartLogger) {
      viewsToExport.push({ view: "smart", title: "SmartLogger Summed Power" });
    }

    viewsToExport.forEach(({ view, title }, index) => {
      const chartSpec = (() => {
        switch (view) {
          case "report":
            return { data: reportGridTraces(result, result.main.times.map(formatTime), rawOptions), layout: reportGridLayout(result, result.main.times.map(formatTime), rawOptions) };
          case "pf":
            return { data: pfTraces(result, result.main.times.map(formatTime), rawOptions), layout: layout(result, "Active Power vs Frequency", "P (MW)", "F (Hz)", result.profile.powerRange, [49.7, 50.3], undefined, rawOptions) };
          case "soc":
            return { data: socTraces(result, result.main.times.map(formatTime), rawOptions), layout: layout(result, "Active Power and SOC", "P (MW)", "SOC (%)", result.profile.powerRange, [0, 100], cycleAnnotation(result), rawOptions) };
          case "qv":
            return { data: qvTraces(result, result.main.times.map(formatTime), rawOptions), layout: layout(result, "Voltage vs Reactive Power", "Line Voltage (kV)", "Q (MVar)", undefined, result.profile.reactiveRange, undefined, rawOptions) };
          case "cycle": {
            const x = result.cycle.timeline?.times.map(formatTime) ?? [];
            return { data: [{ x, y: result.cycle.timeline?.avgCycles ?? [], type: "scatter", mode: "lines", name: "Average Equivalent Cycles", line: { color: "#0072BD", width: 2, shape: "linear" } }], layout: layout(result, "ESS Average Equivalent Cycle Timeline", "Average Cycles", "", undefined, undefined, undefined, rawOptions) };
          }
          case "smart": {
            const x = result.smartLogger?.times.map(formatTime) ?? [];
            return { data: [{ x, y: result.smartLogger?.totalPMw ?? [], type: "scatter", mode: "lines", name: "Total P (MW)", line: { color: "#0072BD", width: 2 } }, { x, y: result.smartLogger?.totalQMvar ?? [], type: "scatter", mode: "lines", name: "Total Q (MVar)", yaxis: "y2", line: { color: "#D95319", width: 2 } }], layout: layout(result, "SmartLogger Summed Power", "P (MW)", "Q (MVar)", undefined, result.profile.reactiveRange, undefined, rawOptions) };
          }
          default:
            return { data: [], layout: {} };
        }
      })();

      const html = buildChartHtml(chartSpec.data, chartSpec.layout, title);
      const blob = new Blob([html], { type: "text/html" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${result.profile.outputPrefix}_${view}_graph.html`;
      
      setTimeout(() => {
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      }, index * 250);
    });
  };

  const clearRun = () => {
    setResult(null);
    setStatus("");
    setError("");
  };

  const handleFullReset = () => {
    setTodayFiles([]);
    setYesterdayFiles([]);
    setResult(null);
    setPinnedPoints([]);
    setUploadedFiles([]);
    setPendingFiles([]);
    setStatus("");
    setError("");
    setUploadMessage("");
    
    if (todayFileRef.current) todayFileRef.current.value = "";
    if (yesterdayFileRef.current) yesterdayFileRef.current.value = "";
    if (todayFolderRef.current) todayFolderRef.current.value = "";
    if (yesterdayFolderRef.current) yesterdayFolderRef.current.value = "";

    ess20SharedState.todayFiles = [];
    ess20SharedState.yesterdayFiles = [];
    ess20SharedState.result = null;
    ess20SharedState.uploadedFiles = [];
    ess20SharedState.status = "";
    ess20SharedState.error = "";
    ess20SharedState.exported = new Set<string>();
    ess20SharedState.exportLog = [];

    window.dispatchEvent(new CustomEvent("ess-reset"));
  };

  const handleTodayInput = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    // CAPTURE REFERENCE SYNCHRONOUSLY BEFORE FIRST AWAIT!
    const entries = fileListToEntries(files);
    
    setIsInputting(true);
    setInputtingMessage("Holographic file input scan active...");
    await new Promise((resolve) => setTimeout(resolve, 450));
    
    setInputtingMessage(`Traversing directory entries... [${entries.length} spreadsheet files found]`);
    
    await new Promise((resolve) => setTimeout(resolve, 350));
    setTodayFiles(entries);
    autoDetectAndSetProject(entries);
    clearRun();
    setIsInputting(false);
    setInputtingMessage("");
  };

  const handleYesterdayInput = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    // CAPTURE REFERENCE SYNCHRONOUSLY BEFORE FIRST AWAIT!
    const entries = fileListToEntries(files);
    
    setIsInputting(true);
    setInputtingMessage("Scanning yesterday ESS folder directory...");
    await new Promise((resolve) => setTimeout(resolve, 450));
    
    setInputtingMessage(`Traversing sheet metrics... [${entries.length} ESS files found]`);
    
    await new Promise((resolve) => setTimeout(resolve, 350));
    setYesterdayFiles(entries);
    clearRun();
    setIsInputting(false);
    setInputtingMessage("");
  };

  const handleFolderSelect = async (target: "today" | "yesterday") => {
    if (!window.electronAPI || !(window.electronAPI as any).selectAndReadFolder) {
      if (target === "today") todayFolderRef.current?.click();
      else yesterdayFolderRef.current?.click();
      return;
    }

    try {
      setIsInputting(true);
      setInputtingMessage("Opening native folder selector...");
      const res = await (window.electronAPI as any).selectAndReadFolder();
      if (!res) {
        setIsInputting(false);
        setInputtingMessage("");
        return;
      }

      if (res.error) {
        throw new Error(res.error);
      }

      setInputtingMessage(`Natively loading ${res.files.length} spreadsheet files...`);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const entries: Ess20FileEntry[] = res.files.map((f: any) => {
        let uint8: Uint8Array;
        if (f.content instanceof Uint8Array) {
          uint8 = f.content;
        } else if (f.content && f.content.type === "Buffer" && Array.isArray(f.content.data)) {
          uint8 = new Uint8Array(f.content.data);
        } else {
          uint8 = new Uint8Array(f.content);
        }

        return {
          file: {
            name: f.name,
            size: f.size,
            arrayBuffer: async () => {
              return uint8.buffer.slice(
                uint8.byteOffset,
                uint8.byteOffset + uint8.byteLength
              );
            }
          } as unknown as File,
          path: f.path
        };
      });

      if (target === "today") {
        setTodayFiles(entries);
        autoDetectAndSetProject(entries);
      } else {
        setYesterdayFiles(entries);
      }
      clearRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInputting(false);
      setInputtingMessage("");
    }
  };

  const resetAllConfig = () => {
    setGraphOptions({
      showGridLines: true,
      showLegend: true,
      whiteBackground: false,
      smoothCurves: false,
      showMarkers: false,
      fillAreaY1: false,
      markerSize: 5,
      customTitle: "",
      customY1Label: "",
      y1Min: "",
      y1Max: "",
      customY2Label: "",
      y2Min: "",
      y2Max: "",
      timeResolution: 5,
      traces: {},
    });
  };

  const getTraceNamesForView = (view: ViewMode): string[] => {
    if (!result) return [];
    if (view === "pf") return ["P (POC) (MW)", "F (Hz)"];
    if (view === "soc") {
      if (result.pvs) return ["P (POC) (MW)", "P (PV) (MW)", "P (BESS) (MW)", "SOC (%)"];
      return ["P (POC) (MW)", "SOC (%)"];
    }
    if (view === "qv") {
      const names = ["Vab", "Vbc", "Vca", "Q (POC) (MVar)"];
      if (result.smartLogger) names.push("Q (BESS) (MVar)");
      return names;
    }
    if (view === "cycle") return ["Average Equivalent Cycles"];
    if (view === "smart") return ["Total P (MW)", "Total Q (MVar)"];
    if (view === "report") {
      const names = ["P (POC) (Subplot 1)", "F (Subplot 1)"];
      if (result.pvs) {
        names.push("P (POC) (Subplot 2)", "P (PV) (Subplot 2)", "P (BESS) (Subplot 2)", "SOC (Subplot 2)");
      } else {
        names.push("P (POC) (Subplot 2)", "SOC (Subplot 2)");
      }
      names.push("Vavg (Subplot 3)", "Q (POC) (Subplot 3)");
      return names;
    }
    return [];
  };

  const handleDrop = async (event: React.DragEvent, target: "today" | "yesterday") => {
    event.preventDefault();
    setDragTarget(null);
    setIsInputting(true);
    setInputtingMessage("Holographic folder tree drop ingestion active...");
    await new Promise((resolve) => setTimeout(resolve, 450));
    
    setInputtingMessage("Traversing directory entries in background...");
    const entries = await getFilesFromDrop(event.dataTransfer);
    
    setInputtingMessage(`Aligned ${entries.length} Excel datasets successfully!`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    
    if (target === "today") {
      setTodayFiles(entries);
      autoDetectAndSetProject(entries);
    } else {
      setYesterdayFiles(entries);
    }
    clearRun();
    setIsInputting(false);
    setInputtingMessage("");
  };

  return (
    <section className="flex-1 min-h-0 bg-panel border border-border-v rounded-sm flex flex-col relative overflow-hidden">
      <div className="px-3 py-2 border-b border-border-v flex items-center justify-between bg-surface/50 shrink-0 gap-3">
        <div className="flex items-center gap-3">
          <div className="font-bold text-[11px] uppercase tracking-wider flex items-center gap-2">
            <Battery size={14} className="text-accent-blue animate-pulse" />
            Daily Evaluation <span className="text-accent-blue opacity-80 pl-1 font-mono">({profile.label})</span>
          </div>

          {/* Back to Dashboard Button when in Export sub-tab */}
          {activeSubTab === "export" && (
            <button
              onClick={() => setActiveSubTab("dashboard")}
              className="ml-3 px-2.5 py-1 rounded bg-accent-blue/10 hover:bg-accent-blue/20 text-accent-blue text-[9px] font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer transition-all border border-accent-blue/20"
            >
              ← Back to Dashboard
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Active project dropdown selector */}
          <Select value={projectId} onValueChange={(value) => {
            setProjectId(value as Ess20ProjectId);
            clearRun();
          }}>
            <SelectTrigger className="h-7 text-[10px] bg-background border-border-v text-foreground focus:ring-0 w-[140px] font-mono font-bold">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ESS20_PROJECTS.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-[10px] font-mono font-bold">{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(result || todayFiles.length > 0) && (
            <Button
              onClick={handleFullReset}
              variant="outline"
              className="border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 h-7 text-[10px] font-bold flex items-center gap-1.5 cursor-pointer font-mono shrink-0 transition-colors"
            >
              <RotateCcw size={12} />
              RESET
            </Button>
          )}

          {result && activeSubTab === "dashboard" && (
            <div className="flex border border-border-v bg-background/50 rounded p-[2px] font-mono text-[9px] font-bold uppercase tracking-wider select-none shrink-0 animate-fade-in">
              <button
                onClick={() => setShowReportMode("validation")}
                className={cn(
                  "px-2.5 py-0.5 rounded-sm transition-colors border-0 cursor-pointer outline-none font-bold text-[9px]",
                  showReportMode === "validation" ? "bg-amber-500 text-white" : "text-foreground/45 hover:text-foreground/75 bg-transparent"
                )}
              >
                Validation Grid
              </button>
              <button
                onClick={() => setShowReportMode("plots")}
                className={cn(
                  "px-2.5 py-0.5 rounded-sm transition-colors border-0 cursor-pointer outline-none font-bold text-[9px]",
                  showReportMode === "plots" ? "bg-accent-blue text-white" : "text-foreground/45 hover:text-foreground/75 bg-transparent"
                )}
              >
                Curves Plots
              </button>
            </div>
          )}

          {!result && (
            <Button
              onClick={runAnalysis}
              disabled={isProcessing}
              className="bg-accent-blue text-white hover:bg-blue-600 h-7 text-[10px] font-bold flex items-center gap-1.5 cursor-pointer border-0"
            >
              {isProcessing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              Run
            </Button>
          )}

          {false && (
            <>
              <Button
                onClick={downloadWorkbook}
                variant="outline"
                className="border-green-500/30 bg-green-500/10 text-green-500 hover:bg-green-500/20 h-7 text-[10px] font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <Download size={12} />
                Export XLSX
              </Button>

              <div className="h-5 w-[1px] bg-border-v mx-1 shrink-0" />

              <Button
                onClick={exportCurrentChartAsHTML}
                className="bg-[#10B981] hover:bg-[#059669] text-white h-7 text-[10px] font-bold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed border-0 transition-colors cursor-pointer"
              >
                <Download size={12} />
                Export HTML
              </Button>

              <Button
                onClick={exportAllChartsAsHTML}
                className="bg-[#3B82F6] hover:bg-[#2563EB] text-white h-7 text-[10px] font-bold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed border-0 transition-colors cursor-pointer"
              >
                <Download size={12} />
                Export All as HTML
              </Button>

              <div className="relative">
                <Button
                  onClick={() => setShowGraphSettings(!showGraphSettings)}
                  variant="outline"
                  className={cn(
                    "border border-[#3B82F6] text-[#3B82F6] hover:bg-[#3B82F6]/10 bg-transparent h-7 text-[10px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer",
                    showGraphSettings && "bg-[#3B82F6]/20"
                  )}
                >
                  <Sliders size={12} />
                  Customize
                </Button>
            
            {showGraphSettings && (
              <>
                <div 
                  className="fixed inset-0 z-40" 
                  onClick={() => setShowGraphSettings(false)} 
                />
                <div className="absolute right-0 mt-1.5 w-80 border border-border-v bg-panel shadow-2xl rounded-md p-3 flex flex-col gap-3 z-50 select-text max-h-[520px] overflow-y-auto">
                  <div className="flex items-center justify-between border-b border-border-v/50 pb-1.5 shrink-0">
                    <div className="text-[10px] uppercase font-bold tracking-widest text-accent-blue font-mono">
                      ⚙️ Graph Properties
                    </div>
                    <button 
                      onClick={resetAllConfig} 
                      className="text-[8px] font-mono uppercase tracking-wider text-foreground/50 hover:text-red-400 border border-border-v/80 rounded px-1.5 py-0.5 hover:bg-foreground/5 transition-colors"
                    >
                      Reset
                    </button>
                  </div>

                  {/* Tabs bar */}
                  <div className="flex border-b border-border-v/50 text-[9px] uppercase font-mono tracking-wider shrink-0">
                    {(["layout", "axes", "lines", "time"] as const).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => setActiveSettingsTab(tab)}
                        className={cn(
                          "flex-1 py-1 text-center font-bold border-b-2 transition-colors",
                          activeSettingsTab === tab
                            ? "border-accent-blue text-accent-blue"
                            : "border-transparent text-foreground/50 hover:text-foreground/80"
                        )}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>

                  {/* Tab Contents */}
                  <div className="flex-1 overflow-y-auto text-[10px] font-mono text-foreground/80 flex flex-col gap-3">
                    
                    {/* TAB: Layout */}
                    {activeSettingsTab === "layout" && (
                      <div className="flex flex-col gap-2.5">
                        <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                          <span>Show Grid Lines</span>
                          <input
                            type="checkbox"
                            checked={graphOptions.showGridLines}
                            onChange={(e) => setGraphOptions({ ...graphOptions, showGridLines: e.target.checked })}
                            className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                          />
                        </label>
                        <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                          <span>Show Legend</span>
                          <input
                            type="checkbox"
                            checked={graphOptions.showLegend}
                            onChange={(e) => setGraphOptions({ ...graphOptions, showLegend: e.target.checked })}
                            className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                          />
                        </label>
                        <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                          <span>White Background</span>
                          <input
                            type="checkbox"
                            checked={graphOptions.whiteBackground}
                            onChange={(e) => setGraphOptions({ ...graphOptions, whiteBackground: e.target.checked })}
                            className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                          />
                        </label>
                        <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                          <span>Smooth Curves</span>
                          <input
                            type="checkbox"
                            checked={graphOptions.smoothCurves}
                            onChange={(e) => setGraphOptions({ ...graphOptions, smoothCurves: e.target.checked })}
                            className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                          />
                        </label>
                        <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                          <span>Data Markers</span>
                          <input
                            type="checkbox"
                            checked={graphOptions.showMarkers}
                            onChange={(e) => setGraphOptions({ ...graphOptions, showMarkers: e.target.checked })}
                            className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                          />
                        </label>
                        {graphOptions.showMarkers && (
                          <div className="flex items-center justify-between gap-2 p-1.5 border-t border-border-v/30 pt-2 shrink-0">
                            <span className="text-foreground/60 shrink-0">Marker Size</span>
                            <input
                              type="range"
                              min="2"
                              max="12"
                              step="1"
                              value={graphOptions.markerSize}
                              onChange={(e) => setGraphOptions({ ...graphOptions, markerSize: parseInt(e.target.value) })}
                              className="flex-1 h-1 accent-accent-blue cursor-pointer"
                            />
                            <span className="w-4 text-right text-accent-blue">{graphOptions.markerSize}</span>
                          </div>
                        )}
                        <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                          <span>Fill Area (Y1)</span>
                          <input
                            type="checkbox"
                            checked={graphOptions.fillAreaY1}
                            onChange={(e) => setGraphOptions({ ...graphOptions, fillAreaY1: e.target.checked })}
                            className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                          />
                        </label>
                        <div className="flex flex-col gap-1 mt-1 border-t border-border-v/30 pt-2 shrink-0">
                          <span className="text-foreground/55 uppercase text-[8px] tracking-widest font-bold font-mono">Plot Title Override</span>
                          <input
                            type="text"
                            value={graphOptions.customTitle}
                            onChange={(e) => setGraphOptions({ ...graphOptions, customTitle: e.target.value })}
                            placeholder="(use default)"
                            className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue font-mono"
                          />
                        </div>
                      </div>
                    )}

                    {/* TAB: Axes */}
                    {activeSettingsTab === "axes" && (
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-2">
                          <div className="text-[8px] uppercase tracking-widest text-accent-blue font-bold border-b border-border-v/40 pb-1">Left Y-Axis (Y1)</div>
                          <div className="flex flex-col gap-1">
                            <span className="text-foreground/50 text-[8px] uppercase">Label Override</span>
                            <input
                              type="text"
                              value={graphOptions.customY1Label}
                              onChange={(e) => setGraphOptions({ ...graphOptions, customY1Label: e.target.value })}
                              placeholder="(use default)"
                              className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue font-mono"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col gap-1">
                              <span className="text-foreground/50 text-[8px] uppercase">Min Bound</span>
                              <input
                                type="number"
                                value={graphOptions.y1Min}
                                onChange={(e) => setGraphOptions({ ...graphOptions, y1Min: e.target.value })}
                                placeholder="auto"
                                className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue font-mono"
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <span className="text-foreground/50 text-[8px] uppercase">Max Bound</span>
                              <input
                                type="number"
                                value={graphOptions.y1Max}
                                onChange={(e) => setGraphOptions({ ...graphOptions, y1Max: e.target.value })}
                                placeholder="auto"
                                className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue font-mono"
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-col gap-2">
                          <div className="text-[8px] uppercase tracking-widest text-orange-400 font-bold border-b border-border-v/40 pb-1">Right Y-Axis (Y2)</div>
                          <div className="flex flex-col gap-1">
                            <span className="text-foreground/50 text-[8px] uppercase">Label Override</span>
                            <input
                              type="text"
                              value={graphOptions.customY2Label}
                              onChange={(e) => setGraphOptions({ ...graphOptions, customY2Label: e.target.value })}
                              placeholder="(use default)"
                              className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue font-mono"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col gap-1">
                              <span className="text-foreground/50 text-[8px] uppercase">Min Bound</span>
                              <input
                                type="number"
                                value={graphOptions.y2Min}
                                onChange={(e) => setGraphOptions({ ...graphOptions, y2Min: e.target.value })}
                                placeholder="auto"
                                className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue font-mono"
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <span className="text-foreground/50 text-[8px] uppercase">Max Bound</span>
                              <input
                                type="number"
                                value={graphOptions.y2Max}
                                onChange={(e) => setGraphOptions({ ...graphOptions, y2Max: e.target.value })}
                                placeholder="auto"
                                className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue font-mono"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* TAB: Lines */}
                    {activeSettingsTab === "lines" && (
                      <div className="flex flex-col gap-3 max-h-[300px] overflow-y-auto pr-1">
                        <div className="text-[8px] uppercase tracking-widest text-foreground/45 border-b border-border-v/40 pb-1">Per-Series Line Styles</div>
                        {getTraceNamesForView(activeView).map((traceName, idx) => {
                          const custom = graphOptions.traces[traceName] || { visible: true, width: 1.5, style: "solid" };
                          return (
                            <div key={idx} className="border border-border-v/80 bg-background/20 rounded p-2 flex flex-col gap-2 shrink-0">
                              <div className="flex items-center justify-between">
                                <span className="font-bold text-[9px] uppercase tracking-wider text-foreground/80 truncate w-36" title={traceName}>{traceName}</span>
                                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                  <span className="text-foreground/45 text-[8px]">Visible</span>
                                  <input
                                    type="checkbox"
                                    checked={custom.visible}
                                    onChange={(e) => {
                                      const current = graphOptions.traces[traceName] || { visible: true, width: 1.5, style: "solid" as const };
                                      setGraphOptions({
                                        ...graphOptions,
                                        traces: {
                                          ...graphOptions.traces,
                                          [traceName]: { ...current, visible: e.target.checked }
                                        }
                                      });
                                    }}
                                    className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                                  />
                                </label>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-foreground/60 shrink-0 text-[8px] w-12">Width</span>
                                <input
                                  type="range"
                                  min="0.5"
                                  max="5"
                                  step="0.5"
                                  value={custom.width}
                                  onChange={(e) => {
                                    const current = graphOptions.traces[traceName] || { visible: true, width: 1.5, style: "solid" as const };
                                    setGraphOptions({
                                      ...graphOptions,
                                      traces: {
                                        ...graphOptions.traces,
                                        [traceName]: { ...current, width: parseFloat(e.target.value) }
                                      }
                                    });
                                  }}
                                  className="flex-1 h-1 accent-accent-blue cursor-pointer"
                                />
                                <span className="text-accent-blue text-[8px] w-5 text-right font-bold">{custom.width.toFixed(1)}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-foreground/60 shrink-0 text-[8px] w-12">Dash Style</span>
                                <select
                                  value={custom.style}
                                  onChange={(e) => {
                                    const current = graphOptions.traces[traceName] || { visible: true, width: 1.5, style: "solid" as const };
                                    setGraphOptions({
                                      ...graphOptions,
                                      traces: {
                                        ...graphOptions.traces,
                                        [traceName]: { ...current, style: e.target.value as any }
                                      }
                                    });
                                  }}
                                  className="flex-1 h-6 bg-[#0F172A] border border-border-v/80 rounded px-1 text-[9px] text-white focus:outline-none"
                                >
                                  <option value="solid">— Solid</option>
                                  <option value="dash">- - Dashed</option>
                                  <option value="dot">··· Dotted</option>
                                  <option value="dashdot">-·- Dash-Dot</option>
                                  <option value="longdash">— Long Dash</option>
                                </select>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* TAB: Time */}
                    {activeSettingsTab === "time" && (
                      <div className="flex flex-col gap-2.5">
                        <div className="text-[8px] uppercase tracking-widest text-foreground/45 border-b border-border-v/40 pb-1 font-mono font-bold">Time downsampling</div>
                        <div className="flex flex-col gap-1.5 mt-1">
                          <span className="text-foreground/60 text-[9px]">Downsampling Resolution</span>
                          <select
                            value={graphOptions.timeResolution}
                            onChange={(e) => setGraphOptions({ ...graphOptions, timeResolution: parseInt(e.target.value) })}
                            className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none font-mono"
                          >
                            <option value="5">5 Minutes (Raw Data)</option>
                            <option value="10">10 Minutes</option>
                            <option value="15">15 Minutes</option>
                            <option value="30">30 Minutes</option>
                            <option value="60">60 Minutes (1 Hour)</option>
                          </select>
                        </div>
                      </div>
                    )}

                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  </div>

      <div className="flex-1 min-h-0 flex">
        {activeSubTab === "export" ? (
          <main className="flex-1 min-w-0 flex flex-col bg-background/40 overflow-auto">
            <MatFigExport
              theme={theme}
              result={result}
              projectId={projectId}
              active={activeSubTab === "export"}
              pinnedPoints={pinnedPoints}
              setPinnedPoints={setPinnedPoints}
              onLoadResult={(loadedResult) => {
                setProjectId(loadedResult.profile.id);
                setResult(loadedResult);
              }}
            />
          </main>
        ) : (
          <main className="flex-1 min-w-0 flex flex-col bg-background/40 overflow-hidden">
            {isProcessing ? (
              <ProcessingOverlay status={status} percent={runPercent} />
            ) : result ? (
              <>
                <ResultKpis result={result} />
                
                {/* Unified Tab Bar (Row 2) */}
                <div className="h-10 px-4 border-y border-border-v bg-surface/40 flex items-center justify-between shrink-0 select-none backdrop-blur-md">
                  {/* Left curve view tabs */}
                  <div className="h-full flex items-center gap-2 overflow-x-auto select-none py-1 scrollbar-none">
                    {showReportMode === "plots" ? (
                      <>
                        <ModeButton active={activeView === "report"} icon={<BarChart3 size={12} />} onClick={() => setActiveView("report")}>Power Flow Curve</ModeButton>
                        <ModeButton active={activeView === "pf"} icon={<Activity size={12} />} onClick={() => setActiveView("pf")}>P/F</ModeButton>
                        <ModeButton active={activeView === "soc"} icon={<Battery size={12} />} onClick={() => setActiveView("soc")}>SOC/P</ModeButton>
                        <ModeButton active={activeView === "qv"} icon={<Zap size={12} />} onClick={() => setActiveView("qv")}>Q/V</ModeButton>
                        <ModeButton active={activeView === "cycle"} icon={<CheckCircle2 size={12} />} onClick={() => setActiveView("cycle")}>Cycle</ModeButton>
                        <ModeButton active={activeView === "smart"} icon={<Database size={12} />} onClick={() => setActiveView("smart")}>SmartLogger</ModeButton>
                      </>
                    ) : (
                      <div className="text-[12px] font-bold uppercase tracking-wider text-[var(--text-primary)] px-2 font-mono flex items-center gap-2">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500"></span>
                        </span>
                        Validation Debug Grid
                      </div>
                    )}
                  </div>

                  {/* Right side action buttons */}
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={runAnalysis}
                      disabled={isProcessing}
                      className="bg-[var(--accent-green)] hover:bg-[var(--accent-green)]/90 text-white h-7 px-3 text-[11px] font-bold rounded flex items-center gap-1.5 cursor-pointer border-0 transition-colors hover-btn-micro animate-fade-in"
                    >
                      {isProcessing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                      Run
                    </Button>

                    <Button
                      onClick={() => setActiveSubTab("export")}
                      className="border border-purple-500/30 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 h-7 px-3 text-[11px] font-bold rounded flex items-center gap-1.5 cursor-pointer transition-all hover-btn-micro animate-fade-in"
                    >
                      <ImageIcon size={12} />
                      MatFig
                    </Button>

                    <div className="h-5 w-[1px] bg-border-v mx-1 shrink-0" />

                    <Button
                      onClick={exportCurrentChartAsHTML}
                      disabled={showReportMode === "validation"}
                      className="border border-border-v bg-transparent hover:bg-foreground/[0.04] text-[var(--text-primary)] h-7 px-2.5 text-[11px] font-medium rounded flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all hover-btn-micro"
                    >
                      <Download size={12} />
                      Export HTML
                    </Button>

                    <Button
                      onClick={exportAllChartsAsHTML}
                      disabled={showReportMode === "validation"}
                      className="border border-border-v bg-transparent hover:bg-foreground/[0.04] text-[var(--text-primary)] h-7 px-2.5 text-[11px] font-medium rounded flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all hover-btn-micro"
                    >
                      <Download size={12} />
                      Export All
                    </Button>

                    {pinnedPoints.length > 0 && showReportMode === "plots" && (
                      <button
                        onClick={() => setPinnedPoints([])}
                        className="h-7 px-2.5 border border-red-500/30 bg-red-500/10 text-red-500 hover:bg-red-500/20 text-[10px] font-bold rounded font-mono transition-all flex items-center gap-1 cursor-pointer"
                        title="Clear all active data tips"
                      >
                        {pinnedPoints.length} Pin{pinnedPoints.length > 1 ? "s" : ""} ×
                      </button>
                    )}

                    {showReportMode === "plots" && (
                      <div className="relative">
                        <Button
                          onClick={() => setShowGraphSettings(!showGraphSettings)}
                          variant="outline"
                          className={cn(
                            "border border-accent-blue/30 text-[var(--accent-blue)] hover:bg-accent-blue/10 bg-transparent h-7 w-7 p-0 rounded flex items-center justify-center transition-colors cursor-pointer hover-btn-micro",
                            showGraphSettings && "bg-accent-blue/20"
                          )}
                          title="Customize Graph Options"
                          aria-label="Customize"
                        >
                          <Sliders size={12} />
                        </Button>
                        
                        {showGraphSettings && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setShowGraphSettings(false)} />
                            <div className="absolute right-0 mt-1.5 w-80 border border-border-v bg-panel shadow-2xl rounded-md p-3 flex flex-col gap-3 z-50 select-text max-h-[520px] overflow-y-auto">
                              <div className="flex items-center justify-between border-b border-border-v/50 pb-1.5 shrink-0">
                                <div className="text-[10px] uppercase font-bold tracking-widest text-accent-blue font-mono">
                                  ⚙️ Graph Properties
                                </div>
                                <button 
                                  onClick={resetAllConfig} 
                                  className="text-[8px] font-mono uppercase tracking-wider text-foreground/50 hover:text-red-400 border border-border-v/80 rounded px-1.5 py-0.5 hover:bg-foreground/5 transition-colors"
                                >
                                  Reset
                                </button>
                              </div>

                              {/* Tabs bar */}
                              <div className="flex border-b border-border-v/50 text-[9px] uppercase font-mono tracking-wider shrink-0">
                                {(["layout", "axes", "lines", "time"] as const).map((tab) => (
                                  <button
                                    key={tab}
                                    onClick={() => setActiveSettingsTab(tab)}
                                    className={cn(
                                      "flex-1 py-1 text-center font-bold border-b-2 transition-colors",
                                      activeSettingsTab === tab
                                        ? "border-accent-blue text-accent-blue"
                                        : "border-transparent text-foreground/50 hover:text-foreground/80"
                                    )}
                                  >
                                    {tab}
                                  </button>
                                ))}
                              </div>

                              {/* Tab Contents */}
                              <div className="flex-1 overflow-y-auto text-[10px] font-mono text-foreground/80 flex flex-col gap-3">
                                
                                {/* TAB: Layout */}
                                {activeSettingsTab === "layout" && (
                                  <div className="flex flex-col gap-2.5">
                                    <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                                      <span>Show Grid Lines</span>
                                      <input
                                        type="checkbox"
                                        checked={graphOptions.showGridLines}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, showGridLines: e.target.checked })}
                                        className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                                      />
                                    </label>
                                    <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                                      <span>Show Legend</span>
                                      <input
                                        type="checkbox"
                                        checked={graphOptions.showLegend}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, showLegend: e.target.checked })}
                                        className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                                      />
                                    </label>
                                    <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                                      <span>White Background</span>
                                      <input
                                        type="checkbox"
                                        checked={graphOptions.whiteBackground}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, whiteBackground: e.target.checked })}
                                        className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                                      />
                                    </label>
                                    <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                                      <span>Smooth Curves</span>
                                      <input
                                        type="checkbox"
                                        checked={graphOptions.smoothCurves}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, smoothCurves: e.target.checked })}
                                        className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                                      />
                                    </label>
                                    <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                                      <span>Data Markers</span>
                                      <input
                                        type="checkbox"
                                        checked={graphOptions.showMarkers}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, showMarkers: e.target.checked })}
                                        className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                                      />
                                    </label>
                                    {graphOptions.showMarkers && (
                                      <div className="flex items-center justify-between gap-2 p-1.5 border-t border-border-v/30 pt-2 shrink-0">
                                        <span className="text-foreground/45 shrink-0">Marker Size</span>
                                        <input
                                          type="range"
                                          min="2"
                                          max="12"
                                          step="1"
                                          value={graphOptions.markerSize}
                                          onChange={(e) => setGraphOptions({ ...graphOptions, markerSize: parseInt(e.target.value) })}
                                          className="flex-1 h-1 accent-accent-blue cursor-pointer bg-gray-800"
                                        />
                                        <span className="w-4 text-right text-accent-blue" id="markerSize-label">{graphOptions.markerSize}</span>
                                      </div>
                                    )}
                                    <label className="flex items-center justify-between p-1.5 hover:bg-foreground/5 rounded cursor-pointer select-none">
                                      <span>Fill Area (Y1)</span>
                                      <input
                                        type="checkbox"
                                        checked={graphOptions.fillAreaY1}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, fillAreaY1: e.target.checked })}
                                        className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                                      />
                                    </label>
                                    <div className="flex flex-col gap-1 mt-1 border-t border-border-v/30 pt-2 shrink-0">
                                      <span className="text-foreground/45 text-[8px] uppercase tracking-widest font-bold">Plot Title Override</span>
                                      <input
                                        type="text"
                                        value={graphOptions.customTitle}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, customTitle: e.target.value })}
                                        placeholder="(use default)"
                                        className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue w-full"
                                      />
                                    </div>
                                  </div>
                                )}

                                {/* TAB: Axes */}
                                {activeSettingsTab === "axes" && (
                                  <div className="flex flex-col gap-2.5">
                                    <div className="text-[8px] uppercase tracking-widest text-accent-blue font-bold border-b border-border-v/40 pb-1">Left Y-Axis (Y1)</div>
                                    <div className="flex flex-col gap-1">
                                      <span className="text-foreground/45 text-[8px] uppercase">Label Override</span>
                                      <input
                                        type="text"
                                        value={graphOptions.customY1Label}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, customY1Label: e.target.value })}
                                        placeholder="(use default)"
                                        className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue w-full"
                                      />
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                      <div className="flex flex-col gap-1">
                                        <span className="text-foreground/45 text-[8px] uppercase">Min Bound</span>
                                        <input
                                          type="number"
                                          value={graphOptions.y1Min}
                                          onChange={(e) => setGraphOptions({ ...graphOptions, y1Min: e.target.value })}
                                          placeholder="auto"
                                          className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue w-full"
                                        />
                                      </div>
                                      <div className="flex flex-col gap-1">
                                        <span className="text-foreground/45 text-[8px] uppercase">Max Bound</span>
                                        <input
                                          type="number"
                                          value={graphOptions.y1Max}
                                          onChange={(e) => setGraphOptions({ ...graphOptions, y1Max: e.target.value })}
                                          placeholder="auto"
                                          className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue w-full"
                                        />
                                      </div>
                                    </div>

                                    <div className="text-[8px] uppercase tracking-widest text-orange-400 font-bold border-b border-border-v/40 pb-1 mt-1">Right Y-Axis (Y2)</div>
                                    <div className="flex flex-col gap-1">
                                      <span className="text-foreground/45 text-[8px] uppercase">Label Override</span>
                                      <input
                                        type="text"
                                        value={graphOptions.customY2Label}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, customY2Label: e.target.value })}
                                        placeholder="(use default)"
                                        className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue w-full"
                                      />
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                      <div className="flex flex-col gap-1">
                                        <span className="text-foreground/45 text-[8px] uppercase">Min Bound</span>
                                        <input
                                          type="number"
                                          value={graphOptions.y2Min}
                                          onChange={(e) => setGraphOptions({ ...graphOptions, y2Min: e.target.value })}
                                          placeholder="auto"
                                          className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue w-full"
                                        />
                                      </div>
                                      <div className="flex flex-col gap-1">
                                        <span className="text-foreground/45 text-[8px] uppercase">Max Bound</span>
                                        <input
                                          type="number"
                                          value={graphOptions.y2Max}
                                          onChange={(e) => setGraphOptions({ ...graphOptions, y2Max: e.target.value })}
                                          placeholder="auto"
                                          className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none focus:border-accent-blue w-full"
                                        />
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {/* TAB: Lines */}
                                {activeSettingsTab === "lines" && (
                                  <div className="flex flex-col gap-2">
                                    <div className="text-[8px] uppercase tracking-widest text-foreground/45 border-b border-border-v/40 pb-1 font-mono font-bold">Per-series styles</div>
                                    {Object.keys(graphOptions.traces).map((traceName) => {
                                      const custom = graphOptions.traces[traceName] || { visible: true, width: 1.5, style: "solid" as const };
                                      return (
                                        <div key={traceName} className="flex flex-col gap-1 bg-foreground/[0.02] border border-border-v/50 rounded p-1.5">
                                          <div className="flex items-center justify-between gap-2 border-b border-border-v/30 pb-1">
                                            <span className="font-bold text-[9px] uppercase tracking-wider text-foreground/80 truncate w-36" title={traceName}>{traceName}</span>
                                            <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                              <span className="text-foreground/45 text-[8px]">Visible</span>
                                              <input
                                                type="checkbox"
                                                checked={custom.visible}
                                                onChange={(e) => {
                                                  const current = graphOptions.traces[traceName] || { visible: true, width: 1.5, style: "solid" as const };
                                                  setGraphOptions({
                                                    ...graphOptions,
                                                    traces: {
                                                      ...graphOptions.traces,
                                                      [traceName]: { ...current, visible: e.target.checked }
                                                    }
                                                  });
                                                }}
                                                className="w-3.5 h-3.5 rounded border-border-v text-accent-blue bg-background focus:ring-0 cursor-pointer accent-accent-blue"
                                              />
                                            </label>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <span className="text-foreground/60 shrink-0 text-[8px] w-12">Width</span>
                                            <input
                                              type="range"
                                              min="0.5"
                                              max="5"
                                              step="0.5"
                                              value={custom.width}
                                              onChange={(e) => {
                                                const current = graphOptions.traces[traceName] || { visible: true, width: 1.5, style: "solid" as const };
                                                setGraphOptions({
                                                  ...graphOptions,
                                                  traces: {
                                                    ...graphOptions.traces,
                                                    [traceName]: { ...current, width: parseFloat(e.target.value) }
                                                  }
                                                });
                                              }}
                                              className="flex-1 h-1 accent-accent-blue cursor-pointer"
                                            />
                                            <span className="text-accent-blue text-[8px] w-5 text-right font-bold">{custom.width.toFixed(1)}</span>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <span className="text-foreground/60 shrink-0 text-[8px] w-12">Dash Style</span>
                                            <select
                                              value={custom.style}
                                              onChange={(e) => {
                                                const current = graphOptions.traces[traceName] || { visible: true, width: 1.5, style: "solid" as const };
                                                setGraphOptions({
                                                  ...graphOptions,
                                                  traces: {
                                                    ...graphOptions.traces,
                                                    [traceName]: { ...current, style: e.target.value as any }
                                                  }
                                                });
                                              }}
                                              className="flex-1 h-6 bg-[#0F172A] border border-border-v/80 rounded px-1 text-[9px] text-white focus:outline-none"
                                            >
                                              <option value="solid">— Solid</option>
                                              <option value="dash">- - Dashed</option>
                                              <option value="dot">··· Dotted</option>
                                              <option value="dashdot">-·- Dash-Dot</option>
                                              <option value="longdash">— Long Dash</option>
                                            </select>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}

                                {/* TAB: Time */}
                                {activeSettingsTab === "time" && (
                                  <div className="flex flex-col gap-2.5">
                                    <div className="text-[8px] uppercase tracking-widest text-foreground/45 border-b border-border-v/40 pb-1 font-mono font-bold">Time downsampling</div>
                                    <div className="flex flex-col gap-1.5 mt-1">
                                      <span className="text-foreground/60 text-[9px]">Downsampling Resolution</span>
                                      <select
                                        value={graphOptions.timeResolution}
                                        onChange={(e) => setGraphOptions({ ...graphOptions, timeResolution: parseInt(e.target.value) })}
                                        className="h-7 bg-[#0F172A] border border-border-v/80 rounded px-2 text-[10px] text-white focus:outline-none font-mono"
                                      >
                                        <option value="5">5 Minutes (Raw Data)</option>
                                        <option value="10">10 Minutes</option>
                                        <option value="15">15 Minutes</option>
                                        <option value="30">30 Minutes</option>
                                        <option value="60">60 Minutes (1 Hour)</option>
                                      </select>
                                    </div>
                                  </div>
                                )}

                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {showReportMode === "plots" ? (
                  <div className="flex-1 min-h-0 w-full overflow-hidden flex flex-col p-1.5 grid-overlay animate-fade-in" ref={reportContainerRef}>
                    <ChartView result={result} view={activeView} theme={theme} graphOptions={graphOptions} pinnedPoints={pinnedPoints} setPinnedPoints={setPinnedPoints} />
                  </div>
                ) : (
                  <ValidationDebug progress={progress} setProgress={setProgress} />
                )}
              </>
            ) : (
              <ValidationDebug progress={progress} setProgress={setProgress} />
            )}
          </main>
        )}
      </div>

      {baselineModal && baselineModal.show && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#0B0F19]/60 backdrop-blur-xs transition-all duration-300">
          <div className={cn(
            "w-[420px] rounded-xl border p-6 flex flex-col gap-4 shadow-2xl transition-all duration-300 transform scale-100",
            theme === "dark" 
              ? "bg-[#152033] border-slate-700 text-white" 
              : "bg-white border-slate-200 text-slate-800"
          )}>
            {/* Alert Header */}
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-500">
                <AlertTriangle size={22} className="animate-pulse" />
              </div>
              <div>
                <h3 className="text-sm font-bold uppercase tracking-wider font-mono">
                  {baselineModal.isHistoryEmpty ? "Baseline Needed" : "Gap in History"}
                </h3>
                <p className="text-[9px] opacity-60 uppercase tracking-widest font-mono">
                  Daily Cycle Calibration
                </p>
              </div>
            </div>

            {/* Description */}
            <div className="text-xs leading-relaxed opacity-90 select-text">
              {baselineModal.isHistoryEmpty ? (
                <>
                  A new installation/device has been detected for this project. To calculate the daily cycle count for <strong className="text-accent-blue">{baselineModal.todayDateStr}</strong> automatically, you should first run the telemetry for the previous day (<strong className="opacity-80">{baselineModal.yesterdayDateStr}</strong>) as a baseline.
                </>
              ) : (
                <>
                  Yesterday's data (<strong className="text-accent-blue">{baselineModal.yesterdayDateStr}</strong>) was not found in the run history. To maintain continuous daily cycle calculation, please load and run <strong className="opacity-80">{baselineModal.yesterdayDateStr}</strong> first.
                </>
              )}
            </div>

            {/* Recommendations */}
            <div className="bg-slate-500/5 dark:bg-[#0B0F19]/35 border border-border-v/50 rounded-lg p-3 text-[11px] flex flex-col gap-2 font-mono">
              <div className="text-amber-500/80 font-bold uppercase text-[9px] tracking-wider">
                Recommended Action:
              </div>
              <div className="opacity-80">
                1. Cancel this run.<br />
                2. Select/Drop files for <strong>{baselineModal.yesterdayDateStr}</strong> and click RUN.<br />
                3. Then run <strong>{baselineModal.todayDateStr}</strong>.
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2.5 mt-2 shrink-0">
              <Button
                variant="outline"
                className="h-9 px-4 text-xs font-mono border-slate-600/50 hover:bg-slate-700/20 hover:text-white"
                onClick={baselineModal.onConfirm}
              >
                Proceed as Baseline
              </Button>
              <Button
                className="h-9 px-4 text-xs font-mono bg-gradient-to-r from-accent-blue to-purple-500 hover:from-accent-blue/90 hover:to-purple-500/90 text-white"
                onClick={() => setBaselineModal(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ProcessingOverlay({ status, percent }: { status: string; percent: number }) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center relative overflow-hidden bg-background/50 backdrop-blur-xs">
      {/* Animated background waves */}
      <div className="absolute inset-0 opacity-15 pointer-events-none">
        <div className="wave-line wave-1" />
        <div className="wave-line wave-2" />
        <div className="wave-line wave-3" />
      </div>

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center gap-5">
        {/* Pulsing ring SVG */}
        <div className="relative w-20 h-20">
          <svg className="w-full h-full animate-spin-slow" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor"
              className="text-accent-blue/10 dark:text-accent-blue/20" strokeWidth="3.5" />
            <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor"
              className="text-accent-blue" strokeWidth="3.5"
              strokeDasharray={`${percent * 2.6} 260`} strokeLinecap="round" />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <Zap size={24} className="text-accent-blue animate-pulse" />
          </div>
          {/* Glow effect */}
          <div className="absolute inset-0 rounded-full bg-accent-blue/5 dark:bg-accent-blue/10 blur-xl animate-pulse" />
        </div>

        {/* Title */}
        <div className="text-xs font-bold uppercase tracking-[0.25em] text-foreground font-mono">
          Analyzing Telemetry
        </div>

        {/* Live status text */}
        <div className="text-[11px] font-mono text-accent-blue animate-pulse max-w-xs text-center h-7 flex items-center justify-center select-text">
          {status || "Preparing algorithms..."}
        </div>

        {/* Progress Bar */}
        <div className="w-64 mt-1.5 flex flex-col gap-1 font-mono">
          <div className="h-1.5 w-full rounded-full bg-foreground/10 overflow-hidden relative border border-border-v/10">
            <div 
              className="h-full rounded-full transition-all duration-300 bg-gradient-to-r from-accent-blue to-purple-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex justify-between text-[8px] mt-0.5 text-foreground/45">
            <span>{percent}% COMPLETE</span>
            <span>{percent < 25 ? "PARSING..." : percent < 75 ? "CALCULATING..." : percent < 95 ? "FORMATTING..." : "MOUNTING..."}</span>
          </div>
        </div>

        {/* Animated progress dots */}
        <div className="flex gap-1.5 mt-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i}
              className="w-1.5 h-1.5 rounded-full bg-accent-blue"
              style={{ animation: `dotBounce 1.2s ${i * 0.15}s infinite ease-in-out` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function UploadZone({
  title,
  count,
  active,
  optional,
  onDragEnter,
  onDragLeave,
  onDrop,
  onFolderClick,
  onFilesClick,
  isInputting,
  inputtingMessage,
}: {
  title: string;
  count: number;
  active: boolean;
  optional?: boolean;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
  onFolderClick: () => void;
  onFilesClick: () => void;
  isInputting?: boolean;
  inputtingMessage?: string;
}) {
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        onDragEnter();
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        onDragLeave();
      }}
      onDrop={onDrop}
      className={cn(
        "border border-dashed rounded-md p-3 bg-surface/30 transition-colors relative overflow-hidden",
        active ? "border-accent-blue bg-accent-blue/10" : "border-border-v hover:border-accent-blue/60",
      )}
    >
      {isInputting && (
        <div className="absolute inset-0 bg-white/90 dark:bg-[#0B0F19]/90 backdrop-blur-xs flex flex-col items-center justify-center p-2 text-center z-20 transition-all duration-300">
          <Loader2 size={16} className="text-accent-blue animate-spin mb-1.5" />
          <div className="text-[8px] font-mono text-accent-blue dark:text-accent-blue font-bold tracking-normal animate-pulse leading-tight max-w-[150px] select-text">
            {inputtingMessage || "Scanning files..."}
          </div>
          {/* Glowing laser scan beam line */}
          <div className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#00A3FF] to-transparent animate-scan z-10" />
        </div>
      )}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <div className="text-[10px] uppercase font-bold tracking-widest text-foreground/75">{title}</div>
          <div className="text-[9px] font-mono text-foreground/40 mt-0.5">
            {count ? `${count} files selected` : optional ? "optional for total-only run" : "required"}
          </div>
        </div>
        <Upload size={16} className="text-accent-blue/70" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={onFolderClick} className="h-7 text-[9px] font-bold bg-accent-blue text-white hover:bg-blue-600">
          Folder
        </Button>
        <Button onClick={onFilesClick} variant="outline" className="h-7 text-[9px] font-bold border-border-v bg-transparent text-foreground">
          Files
        </Button>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel border border-border-v rounded-md p-2 hover-card-redesign hover:scale-[1.01] transition-all">
      <div className="text-[7.5px] uppercase font-bold tracking-widest text-foreground/45 font-sans">{label}</div>
      <div className="text-[11px] font-mono font-bold text-foreground mt-0.5 truncate">{value}</div>
    </div>
  );
}

function ResultKpis({ result }: { result: Ess20Result }) {
  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 p-3 shrink-0">
      <Kpi title="Daily Cycle" value={formatValue(result.cycle.dailyAvg, 4)} unit="cycles" tone={Number.isFinite(result.cycle.dailyAvg) && result.cycle.dailyAvg >= 0 ? "green" : "yellow"} />
      <Kpi title="Total Cycle Avg" value={formatValue(result.cycle.todayAvg, 4)} unit="cycles" tone="blue" />
      <Kpi title="Yesterday Avg" value={formatValue(result.cycle.yesterdayAvg, 4)} unit="cycles" tone="purple" />
      <Kpi title="Loaded Sources" value={String(result.files.smartLoggerCount + result.files.essTodayCount + 2)} unit="files" tone="slate" />
    </div>
  );
}

function BessFlowDiagram({ result }: { result: Ess20Result }) {
  if (!result) return null;

  const len = result.main.times.length;
  const pccPower = result.main.pMw[len - 1] || 0;
  const soc = result.main.soc[len - 1] || 0;

  const essPower = result.pvs 
    ? result.pvs.pEssMw[result.pvs.pEssMw.length - 1] || 0
    : pccPower * 0.35;
  
  const pvPower = result.pvs
    ? result.pvs.pPvMw[result.pvs.pPvMw.length - 1] || 0
    : Math.max(0, pccPower * 0.65);

  const loadPower = Math.max(0.5, pvPower + (essPower < 0 ? Math.abs(essPower) : -essPower) + (pccPower < 0 ? Math.abs(pccPower) : 0));

  const essMode = essPower < 0 ? "charging" : essPower > 0 ? "discharging" : "idle";
  const isPulsing = essPower !== 0;

  // Dynamic battery fill color based on state limits
  const batteryColor = soc > 50 
    ? "var(--accent-green)" 
    : soc >= 20 
      ? "var(--accent-orange)" 
      : "var(--accent-red)";

  // Compute stroke thickness proportional to magnitude
  const pvStroke = Math.max(1.5, Math.min(6, 1.5 + Math.abs(pvPower) * 0.5));
  const essStroke = Math.max(1.5, Math.min(6, 1.5 + Math.abs(essPower) * 0.5));
  const loadStroke = Math.max(1.5, Math.min(6, 1.5 + Math.abs(loadPower) * 0.5));

  return (
    <div className="mx-3 my-2 p-3 bg-surface/30 border border-border-v rounded-lg flex flex-col md:flex-row items-center justify-between gap-4 font-mono text-[10px] select-none hover-card-redesign shrink-0">
      {/* Inline styles for custom flow particles keyframes */}
      <style>{`
        @keyframes flow-particles {
          0% { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: -32; }
        }
        .animate-particles {
          animation: flow-particles 1.2s linear infinite;
        }
      `}</style>

      <div className="flex flex-col gap-1.5 shrink-0 max-w-xs">
        <div className="text-[10px] uppercase font-bold text-accent-blue tracking-wider flex items-center gap-1.5 font-sans">
          <Activity size={12} className="animate-pulse text-[--accent-blue]" />
          Live BESS Energy Flow Diagram
        </div>
        <p className="text-[9px] text-foreground/45 leading-relaxed font-sans">
          Simulated particle animations powered directly by live telemetry. Animate-fills and flow states update inside the SVGs dynamically.
        </p>
      </div>

      <div className="flex-1 w-full max-w-2xl h-24 relative">
        <svg className="w-full h-full" viewBox="0 0 600 120" fill="none">
          {/* Defs for glow filters, gradients, and arrowheads */}
          <defs>
            <filter id="glow-effect" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>

            {/* Dynamic Arrowheads pointing in path direction */}
            <marker id="arrow-orange" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M 0 2 L 8 5 L 0 8 z" fill="var(--accent-orange)" />
            </marker>
            <marker id="arrow-blue" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M 0 2 L 8 5 L 0 8 z" fill="var(--accent-blue)" />
            </marker>
            <marker id="arrow-green" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M 0 2 L 8 5 L 0 8 z" fill="var(--accent-green)" />
            </marker>
            <marker id="arrow-red" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M 0 2 L 8 5 L 0 8 z" fill="var(--accent-red)" />
            </marker>
          </defs>

          {/* PV ➔ BESS Connection */}
          <path 
            d="M 89 60 L 185 60" 
            stroke="var(--accent-orange)" 
            strokeWidth={pvStroke} 
            strokeLinecap="round" 
            opacity={pvPower > 0.1 ? 0.25 : 0.08}
            markerEnd={pvPower > 0.1 ? "url(#arrow-orange)" : undefined}
          />
          {pvPower > 0.1 && (
            <path 
              d="M 89 60 L 185 60" 
              stroke="var(--accent-orange)" 
              strokeWidth="6" 
              strokeLinecap="round"
              strokeDasharray="0, 32"
              className="animate-particles"
            />
          )}

          {/* BESS ➔ Grid Connection */}
          <path 
            d={essPower < 0 ? "M 345 60 L 249 60" : "M 249 60 L 345 60"} 
            stroke={essMode === "charging" ? "var(--accent-blue)" : essMode === "discharging" ? "var(--accent-green)" : "var(--border-v)"} 
            strokeWidth={essStroke} 
            strokeLinecap="round" 
            opacity={isPulsing ? 0.25 : 0.08}
            markerEnd={isPulsing ? (essPower < 0 ? "url(#arrow-blue)" : "url(#arrow-green)") : undefined}
          />
          {isPulsing && (
            <path 
              d={essPower < 0 ? "M 345 60 L 249 60" : "M 249 60 L 345 60"} 
              stroke={essPower < 0 ? "var(--accent-blue)" : "var(--accent-green)"} 
              strokeWidth="6" 
              strokeLinecap="round"
              strokeDasharray="0, 32"
              className="animate-particles"
            />
          )}

          {/* Grid ➔ Load Connection */}
          <path 
            d="M 409 60 L 505 60" 
            stroke="var(--accent-red)" 
            strokeWidth={loadStroke} 
            strokeLinecap="round" 
            opacity={loadPower > 0.1 ? 0.25 : 0.08}
            markerEnd={loadPower > 0.1 ? "url(#arrow-red)" : undefined}
          />
          {loadPower > 0.1 && (
            <path 
              d="M 409 60 L 505 60" 
              stroke="var(--accent-red)" 
              strokeWidth="6" 
              strokeLinecap="round"
              strokeDasharray="0, 32"
              className="animate-particles"
            />
          )}

          {/* 1. SOLAR PV NODE (64x48px) */}
          <g transform="translate(25, 36)" className="hover-card-redesign transition-all duration-300">
            <rect width="64" height="48" rx="6" fill="var(--panel)" stroke="var(--border)" strokeWidth="1.2" />
            
            {/* Solar sun icon */}
            <circle cx="18" cy="24" r="5" fill="var(--accent-orange)" className={pvPower > 0.1 ? "animate-pulse" : ""} />
            {Array.from({ length: 8 }).map((_, i) => {
              const angle = (i * 45 * Math.PI) / 180;
              const x1 = 18 + 7 * Math.cos(angle);
              const y1 = 24 + 7 * Math.sin(angle);
              const x2 = 18 + 10 * Math.cos(angle);
              const y2 = 24 + 10 * Math.sin(angle);
              return (
                <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--accent-orange)" strokeWidth="1.2" strokeLinecap="round" />
              );
            })}
            <text x="34" y="20" fill="var(--text-secondary)" className="font-bold text-[7px] tracking-wider uppercase font-sans">PV</text>
            <text x="34" y="32" fill="var(--accent-orange)" className="font-bold font-mono text-[8px]">{pvPower.toFixed(2)} MW</text>
          </g>

          {/* 2. BESS NODE (64x48px) */}
          <g transform="translate(185, 36)" className="hover-card-redesign transition-all duration-300">
            <rect width="64" height="48" rx="6" fill="var(--panel)" stroke="var(--border)" strokeWidth="1.2" />
            
            {/* Mini vertical battery outline */}
            <rect x="8" y="14" width="12" height="20" rx="2" stroke="var(--border-v)" strokeWidth="1.5" fill="none" />
            <rect x="12" y="11" width="4" height="3" rx="0.5" fill="var(--border-v)" />
            {/* Dynamic battery SOC level fill */}
            <rect 
              x="10" 
              y={16 + 16 * (1 - soc / 100)} 
              width="8" 
              height={Math.max(1, 16 * (soc / 100))} 
              rx="0.5" 
              fill={batteryColor} 
              className={isPulsing ? "animate-battery-charging" : "transition-all duration-500"} 
            />

            <text x="26" y="20" fill="var(--text-secondary)" className="font-bold text-[7px] tracking-wider uppercase font-sans">BESS</text>
            <text x="26" y="32" fill={batteryColor} className="font-bold font-mono text-[8px]">{soc.toFixed(0)}%</text>
          </g>

          {/* 3. UTILITY GRID NODE (64x48px) */}
          <g transform="translate(345, 36)" className="hover-card-redesign transition-all duration-300">
            <rect width="64" height="48" rx="6" fill="var(--panel)" stroke="var(--border)" strokeWidth="1.2" />
            
            {/* Grid Tower outline */}
            <path d="M 10 32 L 20 32 M 15 14 L 11 32 M 15 14 L 19 32 M 12 20 L 18 20 M 11 26 L 19 26" stroke="var(--accent-blue)" strokeWidth="1.2" strokeLinecap="round" />
            
            <text x="26" y="20" fill="var(--text-secondary)" className="font-bold text-[7px] tracking-wider uppercase font-sans">Grid</text>
            <text x="26" y="32" fill="var(--accent-blue)" className="font-bold font-mono text-[7.5px]">{Math.abs(pccPower).toFixed(2)} M</text>
          </g>

          {/* 4. FACILITY LOAD NODE (64x48px) */}
          <g transform="translate(505, 36)" className="hover-card-redesign transition-all duration-300">
            <rect width="64" height="48" rx="6" fill="var(--panel)" stroke="var(--border)" strokeWidth="1.2" />
            
            {/* Factory outlines */}
            <path d="M 8 32 L 8 22 L 12 25 L 12 18 L 16 21 L 16 14 L 20 17 L 20 32 Z" stroke="var(--accent-red)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            
            <text x="26" y="20" fill="var(--text-secondary)" className="font-bold text-[7px] tracking-wider uppercase font-sans">Load</text>
            <text x="26" y="32" fill="var(--accent-red)" className="font-bold font-mono text-[8px]">{loadPower.toFixed(2)} MW</text>
          </g>
        </svg>
      </div>
    </div>
  );
}

function Kpi({ title, value, unit, tone }: { title: string; value: string; unit: string; tone: "green" | "yellow" | "blue" | "purple" | "slate" }) {
  const color = {
    green: "border-t-[--accent-green] bg-[--accent-green]/5 text-[--accent-green]",
    yellow: "border-t-[--accent-orange] bg-[--accent-orange]/5 text-[--accent-orange]",
    blue: "border-t-[--accent-blue] bg-[--accent-blue]/5 text-[--accent-blue]",
    purple: "border-t-purple-400 bg-purple-400/5 text-purple-400",
    slate: "border-t-foreground/40 bg-foreground/5 text-foreground/80",
  }[tone];

  const numericVal = parseFloat(value);
  const isPositive = Number.isFinite(numericVal) && numericVal > 0;

  return (
    <div className={cn("border border-border-v border-t-2 rounded-lg p-3 hover-card-redesign relative overflow-hidden flex flex-col justify-between h-20 select-text", color)}>
      <div>
        <div className="text-[9px] uppercase font-bold text-foreground/50 tracking-wider font-sans">{title}</div>
        <div className="text-2xl font-mono font-bold mt-1 tracking-tight flex items-baseline gap-1.5 text-foreground">
          {value}
          <span className="text-[10px] font-sans font-normal text-foreground/50 tracking-normal select-none">{unit}</span>
        </div>
      </div>
      {/* Decorative trend micro-indicator ▲▼ arrow */}
      <div className="absolute right-3 bottom-2.5 flex items-center gap-1 select-none">
        {title.includes("Cycle") || title.includes("Avg") ? (
          <span className={cn("text-[9px] font-bold flex items-center font-sans", 
            tone === "green" || isPositive ? "text-green-500" : "text-amber-500"
          )}>
            {tone === "green" || isPositive ? "▲" : "▼"}{" "}
            {tone === "green" || isPositive ? "+1.8%" : "-0.4%"}
          </span>
        ) : (
          <span className="text-[9px] font-mono text-foreground/35 font-bold">ACTIVE</span>
        )}
      </div>
    </div>
  );
}

function ModeButton({ active, icon, onClick, children }: { active: boolean; icon: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-7.5 px-4 rounded-full text-[12px] font-semibold flex items-center gap-2 transition-all duration-300 shrink-0 border-0 cursor-pointer relative overflow-hidden select-none",
        active 
          ? "bg-gradient-to-r from-[#0072BD] to-[#0096FF] text-white font-bold shadow-md shadow-blue-500/20 scale-[1.04]" 
          : "bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-foreground/[0.04] font-medium hover:scale-[1.02]",
      )}
    >
      <span className={cn(
        "transition-transform duration-300", 
        active ? "scale-110 rotate-[2deg] text-white" : "text-[var(--text-secondary)]"
      )}>
        {icon}
      </span>
      <span>{children}</span>
      {active && (
        <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-3/5 h-[2px] bg-white rounded-full opacity-80 shadow-[0_0_8px_#ffffff]" />
      )}
    </button>
  );
}

function cleanUndefined(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(cleanUndefined);
  }
  if (obj !== null && typeof obj === "object") {
    const clean: any = {};
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val !== undefined) {
        clean[key] = cleanUndefined(val);
      }
    }
    return clean;
  }
  return obj;
}

function ChartView({ 
  result, 
  view, 
  theme, 
  graphOptions,
  pinnedPoints,
  setPinnedPoints
}: { 
  result: Ess20Result; 
  view: ViewMode; 
  theme: "dark" | "light"; 
  graphOptions: GraphOptions;
  pinnedPoints: PinnedPoint[];
  setPinnedPoints: React.Dispatch<React.SetStateAction<PinnedPoint[]>>;
}) {
  const timeX = useMemo(() => result.main.times.map(formatTime), [result]);
  const [chartError, setChartError] = React.useState<string | null>(null);

  const handlePlotClick = (eventData: any) => {
    if (!eventData || !eventData.points || eventData.points.length === 0) return;
    const pt = eventData.points[0];
    if (pt.x == null || pt.y == null) return;

    const xDisplay = String(pt.x);
    const yValue = Number(pt.y);
    const seriesName = pt.data?.name || "Series";
    const color = pt.data?.line?.color || "#00A3FF";
    
    const ptIndex = pt.pointIndex;
    let xValue = "";
    if (ptIndex !== undefined && ptIndex >= 0 && ptIndex < result.main.times.length) {
      const originalDate = new Date(result.main.times[ptIndex]);
      if (!isNaN(originalDate.getTime())) {
        const pad = (n: number) => String(n).padStart(2, "0");
        xValue = `${originalDate.getFullYear()}-${pad(originalDate.getMonth() + 1)}-${pad(originalDate.getDate())} ${pad(originalDate.getHours())}:${pad(originalDate.getMinutes())}:${pad(originalDate.getSeconds())}`;
      }
    }
    
    if (!xValue) {
      const foundIdx = result.main.times.findIndex(t => formatTime(t) === xDisplay);
      if (foundIdx >= 0) {
        const originalDate = new Date(result.main.times[foundIdx]);
        const pad = (n: number) => String(n).padStart(2, "0");
        xValue = `${originalDate.getFullYear()}-${pad(originalDate.getMonth() + 1)}-${pad(originalDate.getDate())} ${pad(originalDate.getHours())}:${pad(originalDate.getMinutes())}:${pad(originalDate.getSeconds())}`;
      } else {
        xValue = `${result.dataDate} ${xDisplay}:00`;
      }
    }

    const yaxisRef = pt.data?.yaxis || "y";
    let subplot = 1;
    if (yaxisRef === "y3" || yaxisRef === "y4") subplot = 2;
    else if (yaxisRef === "y5" || yaxisRef === "y6") subplot = 3;

    const id = `${xValue}__${seriesName}`;

    setPinnedPoints((prev) => {
      const existingIdx = prev.findIndex((p) => p.id === id);
      if (existingIdx >= 0) {
        return prev.filter((p) => p.id !== id);
      } else {
        return [
          ...prev,
          {
            id,
            xValue,
            xDisplay,
            yValue,
            seriesName,
            yaxisRef,
            color,
            subplot,
          },
        ];
      }
    });
  };

  // Debug: log trace data on every render
  React.useEffect(() => {
    console.log("[ChartView] view:", view);
    console.log("[ChartView] timeX length:", timeX.length);
    if (view === "report") {
      try {
        const traces = reportGridTraces(result, timeX, graphOptions).filter(Boolean);
        const lay = reportGridLayout(result, timeX, graphOptions, pinnedPoints);
        console.log("[ChartView] report traces count:", traces.length);
      } catch (err) {
        console.error("[ChartView] Error building traces/layout:", err);
      }
    }
  }, [view, result, timeX, graphOptions, pinnedPoints]);

  if (view === "report") {
    let traces: any[] = [];
    let lay: any = {};
    try {
      traces = reportGridTraces(result, timeX, graphOptions).filter(Boolean);
      lay = reportGridLayout(result, timeX, graphOptions, pinnedPoints);
    } catch (err) {
      return (
        <div style={{ padding: 20, color: "red", fontFamily: "monospace", fontSize: 12 }}>
          <strong>Error building report chart data:</strong>
          <pre>{err instanceof Error ? err.stack : String(err)}</pre>
        </div>
      );
    }

    return (
      <div className="flex-1 flex flex-col w-full h-full min-h-0 relative">
        {chartError && (
          <div style={{ padding: 8, background: "#ff000020", color: "#ff4444", fontSize: 11, fontFamily: "monospace", borderBottom: "1px solid #ff000040" }} className="shrink-0">
            ⚠ Plotly Error: {chartError}
          </div>
        )}
        <div 
          className="flex items-center gap-2 select-text font-mono text-[11px] px-3 py-1.5 shrink-0"
          style={{
            background: theme === "dark" ? "rgba(0, 200, 100, 0.08)" : "rgba(0, 150, 80, 0.06)",
            color: theme === "dark" ? "#34D399" : "#16A34A",
            borderTop: `0.5px solid ${theme === "dark" ? "rgba(52,211,153,0.2)" : "rgba(22,163,74,0.2)"}`,
            borderBottom: `0.5px solid ${theme === "dark" ? "rgba(52,211,153,0.2)" : "rgba(22,163,74,0.2)"}`,
          }}
        >
          <span className="text-[12px] leading-none shrink-0" style={{ color: theme === "dark" ? "#34D399" : "#16A34A" }}>◉</span>
          <span>
            DEBUG: {traces.length} traces | timeX: {timeX.length} pts | pMw: {result.main.pMw.length} pts | trace0.x: {traces[0]?.x?.length || 0} | trace0.y: {traces[0]?.y?.length || 0}
          </span>
        </div>
        <div className="flex-grow min-h-0 relative w-full h-full" style={{ background: graphOptions.whiteBackground ? "#FFFFFF" : "#F5F5F5" }}>
          <Plot
            data={cleanUndefined(traces)}
            layout={cleanUndefined(lay)}
            useResizeHandler
            style={{ width: "100%", height: "100%" }}
            config={{ displayModeBar: true, responsive: true, displaylogo: false }}
            onClick={handlePlotClick}
            onError={(err) => {
              console.error("Plotly error in ChartView:", err);
              setChartError(String(err));
            }}
          />
        </div>
      </div>
    );
  }

  if (view === "pf") {
    return <SinglePlot data={pfTraces(result, timeX, graphOptions)} result={result} title="Active Power vs Frequency" y1="P (MW)" y2="F (Hz)" y1Range={result.profile.powerRange} y2Range={[49.7, 50.3]} graphOptions={graphOptions} pinnedPoints={pinnedPoints} setPinnedPoints={setPinnedPoints} subplot={1} />;
  }

  if (view === "soc") {
    return <SinglePlot data={socTraces(result, timeX, graphOptions)} result={result} title="Active Power and SOC" y1="P (MW)" y2="SOC (%)" y1Range={result.profile.powerRange} y2Range={[0, 100]} annotations={cycleAnnotation(result)} graphOptions={graphOptions} pinnedPoints={pinnedPoints} setPinnedPoints={setPinnedPoints} subplot={2} />;
  }

  if (view === "qv") {
    return <SinglePlot data={qvTraces(result, timeX, graphOptions)} result={result} title="Voltage vs Reactive Power" y1="Line Voltage (kV)" y2="Q (MVar)" y2Range={result.profile.reactiveRange} graphOptions={graphOptions} pinnedPoints={pinnedPoints} setPinnedPoints={setPinnedPoints} subplot={3} />;
  }

  if (view === "cycle") {
    if (!result.cycle.timeline) return <EmptyPanel message="No ESS cycle timeline available." />;
    const x = result.cycle.timeline.times.map(formatTime);
    const res = graphOptions.timeResolution || 5;
    const cycleDown = downsampleTrace(x, result.cycle.timeline.avgCycles, result.cycle.timeline.times, res);
    const style = getTraceStyle("Average Equivalent Cycles", "#0072BD", 2, graphOptions.smoothCurves ? "spline" : "linear", graphOptions);
    return (
      <SinglePlot
        data={[{
          x: cycleDown.x,
          y: cycleDown.y,
          type: "scatter",
          mode: style.mode,
          name: "Average Equivalent Cycles",
          visible: style.visible,
          line: style.line,
          marker: style.marker
        }]}
        result={result}
        title="ESS Average Equivalent Cycle Timeline"
        y1="Average Cycles"
        y2=""
        graphOptions={graphOptions}
        pinnedPoints={pinnedPoints}
        setPinnedPoints={setPinnedPoints}
        subplot={2}
      />
    );
  }

  if (!result.smartLogger) return <EmptyPanel message="No SmartLogger files were loaded." />;
  const x = result.smartLogger.times.map(formatTime);
  const res = graphOptions.timeResolution || 5;
  const pDown = downsampleTrace(x, result.smartLogger.totalPMw, result.smartLogger.times, res);
  const qDown = downsampleTrace(x, result.smartLogger.totalQMvar, result.smartLogger.times, res);
  const pStyle = getTraceStyle("Total P (MW)", "#0072BD", 2, graphOptions.smoothCurves ? "spline" : "linear", graphOptions);
  const qStyle = getTraceStyle("Total Q (MVar)", "#D95319", 2, graphOptions.smoothCurves ? "spline" : "linear", graphOptions);
  return (
    <SinglePlot
      data={[
        { x: pDown.x, y: pDown.y, type: "scatter", mode: pStyle.mode, name: "Total P (MW)", visible: pStyle.visible, line: pStyle.line, marker: pStyle.marker },
        { x: qDown.x, y: qDown.y, type: "scatter", mode: qStyle.mode, name: "Total Q (MVar)", visible: qStyle.visible, yaxis: "y2", line: qStyle.line, marker: qStyle.marker },
      ]}
      result={result}
      title="SmartLogger Summed Power"
      y1="P (MW)"
      y2="Q (MVar)"
      y2Range={result.profile.reactiveRange}
      graphOptions={graphOptions}
      pinnedPoints={pinnedPoints}
      setPinnedPoints={setPinnedPoints}
      subplot={3}
    />
  );
}

function downsampleTrace<T>(x: string[], y: T[], times: any[], resolutionMinutes: number): { x: string[]; y: T[] } {
  if (!resolutionMinutes || resolutionMinutes <= 5 || !times || times.length === 0) {
    return { x, y };
  }
  const nextX: string[] = [];
  const nextY: T[] = [];
  for (let i = 0; i < times.length; i++) {
    const tVal = times[i];
    const t = typeof tVal === "string" ? new Date(tVal) : tVal;
    if (t && t.getMinutes() % resolutionMinutes === 0) {
      nextX.push(x[i]);
      nextY.push(y[i]);
    }
  }
  if (nextX.length === 0 && x.length > 0) {
    return { x, y };
  }
  return { x: nextX, y: nextY };
}

function getTraceStyle(
  name: string,
  defaultColor: string,
  defaultWidth: number,
  defaultShape: string,
  graphOptions: GraphOptions
) {
  const tracesObj = graphOptions?.traces || {};
  const custom = tracesObj[name] || { visible: true, width: 1.5, style: "solid" };
  const visible = custom.visible ?? true;
  const width = custom.width ?? 1.5;
  const dash = custom.style === "solid" ? undefined : custom.style;
  const mode = graphOptions.showMarkers ? "lines+markers" : "lines";

  const isDark = document.documentElement.classList.contains("dark");
  let traceColor = defaultColor;

  if (isDark && !graphOptions?.whiteBackground) {
    if (name.includes("P (POC)") || name.includes("Total P") || name.includes("Average Equivalent Cycles")) {
      traceColor = "#38BDF8"; // Accent Blue
    } else if (name.includes("F (Hz)")) {
      traceColor = "#FB923C"; // Accent Orange
    } else if (name.includes("SOC")) {
      traceColor = "#F87171"; // Accent Red/Coral
    } else if (name.includes("P (PV)")) {
      traceColor = "#FBBF24"; // Accent Amber/Yellow
    } else if (name.includes("P (BESS)") || name.includes("Q (BESS)")) {
      traceColor = "#34D399"; // Accent Green
    } else if (name.includes("Q (POC)") || name.includes("Total Q")) {
      traceColor = "#EF4444"; // Accent Red (vibrant red for dark background)
    } else if (name === "Vab") {
      traceColor = "#38BDF8";
    } else if (name === "Vbc") {
      traceColor = "#34D399";
    } else if (name === "Vca") {
      traceColor = "#A78BFA";
    } else if (name === "Vavg" || name.includes("Vavg") || name.includes("Voltage")) {
      // Dynamic project-aware average voltage styling
      if (defaultColor === "#0072BD" || defaultColor === "rgb(0,114,189)" || defaultColor === "#0072bd") {
        traceColor = "#38BDF8"; // Accent Blue (for SNTV)
      } else {
        traceColor = "#34D399"; // Accent Green (for SNTB)
      }
    }
  } else {
    if (name.includes("P (POC)") || name.includes("Total P") || name.includes("Average Equivalent Cycles")) {
      traceColor = "#2563EB"; // Royal Blue
    } else if (name.includes("F (Hz)")) {
      traceColor = "#EA580C"; // Accent Orange
    } else if (name.includes("SOC")) {
      traceColor = "#DC2626"; // Accent Red
    } else if (name.includes("P (PV)")) {
      traceColor = "#EA580C"; // Accent Orange/Amber
    } else if (name.includes("P (BESS)") || name.includes("Q (BESS)")) {
      traceColor = "#16A34A"; // Accent Green
    } else if (name.includes("Q (POC)") || name.includes("Total Q")) {
      traceColor = "#CC0000"; // Deep MATLAB Red
    } else if (name === "Vab") {
      traceColor = "#2563EB";
    } else if (name === "Vbc") {
      traceColor = "#16A34A";
    } else if (name === "Vca") {
      traceColor = "#8B5CF6";
    } else if (name === "Vavg" || name.includes("Vavg") || name.includes("Voltage")) {
      // Dynamic project-aware average voltage styling
      if (defaultColor === "#0072BD" || defaultColor === "rgb(0,114,189)" || defaultColor === "#0072bd") {
        traceColor = "#0072BD"; // MATLAB Royal Blue (for SNTV)
      } else {
        traceColor = "#77AC30"; // MATLAB Green (for SNTB)
      }
    }
  }

  const line: any = {
    color: traceColor,
    shape: defaultShape
  };
  if (width !== undefined) {
    line.width = width;
  }
  if (dash !== undefined) {
    line.dash = dash;
  }

  const trace: any = {
    visible,
    mode,
    line
  };

  if (graphOptions.showMarkers) {
    trace.marker = { size: graphOptions.markerSize };
  }

  // Elegant area fill for active power
  if (graphOptions.fillAreaY1 && (name.includes("P (POC)") || name.includes("Total P"))) {
    trace.fill = "tozeroy";
    trace.fillcolor = isDark && !graphOptions.whiteBackground
      ? "rgba(0, 212, 255, 0.08)"
      : "rgba(37, 99, 235, 0.06)";
  }

  return trace;
}

function reportGridTraces(result: Ess20Result, x: string[], graphOptions: GraphOptions): any[] {
  const reportOptions = { ...graphOptions, whiteBackground: true };
  const traces: any[] = [];
  const res = reportOptions.timeResolution || 5;
  const smooth = reportOptions.smoothCurves;
  const fill = reportOptions.fillAreaY1;
  const isSNTB = result.profile.label && result.profile.label.includes("SNTB");

  // --- Subplot 1: Active Power and Frequency ---
  const p1 = downsampleTrace(x, result.main.pMw, result.main.times, res);
  const p1Style = getTraceStyle("P (POC) (Subplot 1)", "#0072BD", 1.4, smooth ? "spline" : "hv", reportOptions);
  traces.push({
    x: p1.x,
    y: p1.y,
    type: "scatter",
    mode: p1Style.mode,
    name: "P (POC) (Subplot 1)",
    legendgroup: "sub1",
    showlegend: false,
    visible: p1Style.visible,
    fill: fill ? "tozeroy" : undefined,
    line: p1Style.line,
    marker: p1Style.marker,
    xaxis: "x",
    yaxis: "y"
  });

  const f1 = downsampleTrace(x, result.main.frequency, result.main.times, res);
  // Frequency F is a normal plot, NOT a stairs plot! (shape "linear" or "spline" instead of "hv")
  const f1Style = getTraceStyle("F (Hz) (Subplot 1)", "#D95319", 1.2, smooth ? "spline" : "linear", reportOptions);
  traces.push({
    x: f1.x,
    y: f1.y,
    type: "scatter",
    mode: f1Style.mode,
    name: "F (Subplot 1)",
    legendgroup: "sub1",
    showlegend: false,
    visible: f1Style.visible,
    line: f1Style.line,
    marker: f1Style.marker,
    xaxis: "x",
    yaxis: "y2"
  });

  // --- Subplot 2: Active Power and SOC ---
  if (result.pvs) {
    const xp = result.pvs.times.map(formatTime);
    const p2 = downsampleTrace(xp, result.pvs.pPccMw, result.pvs.times, res);
    const p2Style = getTraceStyle("P (POC) (Subplot 2)", "#0072BD", 1.3, smooth ? "spline" : "linear", reportOptions);
    traces.push({
      x: p2.x, y: p2.y,
      type: "scatter", mode: p2Style.mode,
      name: "P (POC) (Subplot 2)",
      legendgroup: "sub2", showlegend: false,
      visible: p2Style.visible,
      fill: fill ? "tozeroy" : undefined,
      line: p2Style.line,
      marker: p2Style.marker,
      xaxis: "x2", yaxis: "y3"
    });

    const pv2 = downsampleTrace(xp, result.pvs.pPvMw, result.pvs.times, res);
    const pv2Style = getTraceStyle("P (PV) (Subplot 2)", "#CC9900", 1.3, smooth ? "spline" : "linear", reportOptions);
    traces.push({
      x: pv2.x, y: pv2.y,
      type: "scatter", mode: pv2Style.mode,
      name: "P (PV) (Subplot 2)",
      legendgroup: "sub2", showlegend: false,
      visible: pv2Style.visible,
      line: pv2Style.line,
      marker: pv2Style.marker,
      xaxis: "x2", yaxis: "y3"
    });

    const bess2 = downsampleTrace(xp, result.pvs.pEssMw, result.pvs.times, res);
    const bess2Style = getTraceStyle("P (BESS) (Subplot 2)", "#008000", 1.3, smooth ? "spline" : "linear", reportOptions);
    traces.push({
      x: bess2.x, y: bess2.y,
      type: "scatter", mode: bess2Style.mode,
      name: "P (BESS) (Subplot 2)",
      legendgroup: "sub2", showlegend: false,
      visible: bess2Style.visible,
      line: bess2Style.line,
      marker: bess2Style.marker,
      xaxis: "x2", yaxis: "y3"
    });

    const soc2 = downsampleTrace(xp, result.pvs.socPct, result.pvs.times, res);
    const soc2Style = getTraceStyle("SOC (Subplot 2)", "#D95319", 1.2, smooth ? "spline" : "linear", reportOptions);
    traces.push({
      x: soc2.x, y: soc2.y,
      type: "scatter", mode: soc2Style.mode,
      name: "SOC (Subplot 2)",
      legendgroup: "sub2", showlegend: false,
      visible: soc2Style.visible,
      line: soc2Style.line,
      marker: soc2Style.marker,
      xaxis: "x2", yaxis: "y4"
    });
  } else {
    const p2 = downsampleTrace(x, result.main.pMw, result.main.times, res);
    const p2Style = getTraceStyle("P (POC) (Subplot 2)", "#0072BD", 1.3, smooth ? "spline" : "linear", reportOptions);
    traces.push({
      x: p2.x, y: p2.y,
      type: "scatter", mode: p2Style.mode,
      name: "P (POC) (Subplot 2)",
      legendgroup: "sub2", showlegend: false,
      visible: p2Style.visible,
      fill: fill ? "tozeroy" : undefined,
      line: p2Style.line,
      marker: p2Style.marker,
      xaxis: "x2", yaxis: "y3"
    });

    const soc2 = downsampleTrace(x, result.main.soc, result.main.times, res);
    const soc2Style = getTraceStyle("SOC (Subplot 2)", "#D95319", 1.2, smooth ? "spline" : "linear", reportOptions);
    traces.push({
      x: soc2.x, y: soc2.y,
      type: "scatter", mode: soc2Style.mode,
      name: "SOC (Subplot 2)",
      legendgroup: "sub2", showlegend: false,
      visible: soc2Style.visible,
      line: soc2Style.line,
      marker: soc2Style.marker,
      xaxis: "x2", yaxis: "y4"
    });
  }

  // --- Subplot 3: Reactive Power and Average Voltage ---
  const q3 = downsampleTrace(x, result.main.qMvar, result.main.times, res);
  const q3Style = getTraceStyle("Q (POC) (Subplot 3)", "#CC0000", 1.5, smooth ? "spline" : "hv", reportOptions);
  traces.push({
    x: q3.x,
    y: q3.y,
    type: "scatter",
    mode: q3Style.mode,
    name: "Q (POC) (Subplot 3)",
    legendgroup: "sub3",
    showlegend: false,
    visible: q3Style.visible,
    line: q3Style.line,
    marker: q3Style.marker,
    xaxis: "x3",
    yaxis: "y6"
  });

  // Plot Q (BESS) if SmartLogger data is loaded
  if (result.smartLogger) {
    const qb3 = downsampleTrace(x, result.smartLogger.totalQMvar, result.smartLogger.times, res);
    const qb3Style = getTraceStyle("Q (BESS) (Subplot 3)", "#000000", 1.4, smooth ? "spline" : "hv", reportOptions);
    traces.push({
      x: qb3.x,
      y: qb3.y,
      type: "scatter",
      mode: qb3Style.mode,
      name: "Q (BESS) (Subplot 3)",
      legendgroup: "sub3",
      showlegend: false,
      visible: qb3Style.visible,
      line: qb3Style.line,
      marker: qb3Style.marker,
      xaxis: "x3",
      yaxis: "y6"
    });
  }

  // Average Voltage Vavg style is project-dependent: Green/0.8 for SNTB, Blue/1.2 for SNTV
  const vavgColor = isSNTB ? "#77AC30" : "#0072BD";
  const vavgWidth = isSNTB ? 0.8 : 1.2;
  const v3 = downsampleTrace(x, result.main.vavg, result.main.times, res);
  const v3Style = getTraceStyle("Vavg (Subplot 3)", vavgColor, vavgWidth, smooth ? "spline" : "linear", reportOptions);
  traces.push({
    x: v3.x,
    y: v3.y,
    type: "scatter",
    mode: v3Style.mode,
    name: "Vavg (Subplot 3)",
    legendgroup: "sub3",
    showlegend: false,
    visible: v3Style.visible,
    line: v3Style.line,
    marker: v3Style.marker,
    xaxis: "x3",
    yaxis: "y5"
  });

  return traces;
}

function reportGridLayout(result: Ess20Result, timeX: string[], graphOptions: GraphOptions, pinnedPoints?: PinnedPoint[]): any {
  const isSNTB = result.profile.label && result.profile.label.includes("SNTB");

  // 30-minute tick marks matching MATLAB: dtTick = minutes(30)
  const tickVals: string[] = [];
  for (let h = 0; h < 24; h++) {
    const padH = String(h).padStart(2, "0");
    const idx00 = timeX.findIndex(t => t.startsWith(`${padH}:00`));
    if (idx00 >= 0) {
      tickVals.push(timeX[idx00]);
    }
    const idx30 = timeX.findIndex(t => t.startsWith(`${padH}:30`));
    if (idx30 >= 0) {
      tickVals.push(timeX[idx30]);
    }
  }

  // Subplot vertical domains — 3 rows with compact spacing
  const gap = 0.08;
  const topPad = 0.04;
  const botPad = 0.07;
  const plotH = (1 - topPad - botPad - 2 * gap) / 3;

  const d3bot = botPad;
  const d3top = d3bot + plotH;
  const d2bot = d3top + gap;
  const d2top = d2bot + plotH;
  const d1bot = d2top + gap;
  const d1top = d1bot + plotH;

  // Force pure white background for exact MATLAB look
  const bg = "#FFFFFF";
  const gridColor = "#E5E7EB";
  const textColor = "#000000";
  const textColorSecondary = "#000000";
  const axisLineColor = "#000000"; // Solid black axes matching MATLAB "box on"

  const pColor = "#0072BD";
  const fColor = "#D95319";
  const pvColor = "#CC9900";
  const bessColor = "#008000";
  const socColor = "#D95319";
  const qColor = "#CC0000";
  const vColor = isSNTB ? "#77AC30" : "#0072BD";

  const buildXAxis = (anchorY: string, domain: [number, number], showTickLabels: boolean) => ({
    showgrid: graphOptions.showGridLines,
    gridcolor: gridColor,
    linecolor: axisLineColor,
    linewidth: 1,
    mirror: true,
    tickangle: -45, // Rotated X ticks matching Matfig sample
    tickfont: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor },
    tickvals: tickVals,
    ticktext: tickVals,
    showticklabels: showTickLabels,
    anchor: anchorY,
    domain: [0.04, 0.96],
  });

  // Calculate customized ranges if they exist
  let finalY1Range = result.profile.powerRange;
  const hasY1Min = graphOptions.y1Min !== "";
  const hasY1Max = graphOptions.y1Max !== "";
  if (hasY1Min || hasY1Max) {
    finalY1Range = [
      hasY1Min ? parseFloat(graphOptions.y1Min) : result.profile.powerRange[0],
      hasY1Max ? parseFloat(graphOptions.y1Max) : result.profile.powerRange[1]
    ];
  }

  let finalY2Range = result.profile.reactiveRange;
  const hasY2Min = graphOptions.y2Min !== "";
  const hasY2Max = graphOptions.y2Max !== "";
  if (hasY2Min || hasY2Max) {
    finalY2Range = [
      hasY2Min ? parseFloat(graphOptions.y2Min) : result.profile.reactiveRange[0],
      hasY2Max ? parseFloat(graphOptions.y2Max) : result.profile.reactiveRange[1]
    ];
  }

  const layoutObj: any = {
    autosize: true,
    margin: { t: 55, r: 70, l: 70, b: 65 },
    paper_bgcolor: bg,
    plot_bgcolor: bg,
    font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor },
    showlegend: false, // We use custom Northwest legends
    hovermode: "x unified",

    // ===== X-AXES =====
    xaxis:  buildXAxis("y",  [0.06, 0.94], true),
    xaxis2: buildXAxis("y3", [0.06, 0.94], true),
    xaxis3: buildXAxis("y5", [0.06, 0.94], true),

    // ===== SUBPLOT 1: P & F =====
    yaxis: {
      title: { text: "P (MW)", font: { color: pColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
      tickfont: { color: pColor, size: 8, family: "Helvetica, Arial, sans-serif" },
      showgrid: graphOptions.showGridLines,
      gridcolor: gridColor,
      linecolor: axisLineColor,
      linewidth: 1,
      mirror: true,
      zeroline: false,
      domain: [d1bot, d1top],
      range: finalY1Range,
      tickvals: result.profile.powerTicks,
    },
    yaxis2: {
      title: { text: "F (Hz)", font: { color: fColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
      tickfont: { color: fColor, size: 8, family: "Helvetica, Arial, sans-serif" },
      overlaying: "y",
      side: "right",
      showgrid: false,
      linecolor: axisLineColor,
      linewidth: 1,
      zeroline: false,
      range: [49.6, 50.4],
      tickvals: [49.6, 49.8, 50.0, 50.2, 50.4]
    },

    // ===== SUBPLOT 2: P & SOC =====
    yaxis3: {
      title: { text: "P (MW)", font: { color: pColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
      tickfont: { color: pColor, size: 8, family: "Helvetica, Arial, sans-serif" },
      showgrid: graphOptions.showGridLines,
      gridcolor: gridColor,
      linecolor: axisLineColor,
      linewidth: 1,
      mirror: true,
      zeroline: false,
      domain: [d2bot, d2top],
      range: finalY1Range,
      tickvals: result.profile.powerTicks,
    },
    yaxis4: {
      title: { text: "SOC (%)", font: { color: socColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
      tickfont: { color: socColor, size: 8, family: "Helvetica, Arial, sans-serif" },
      overlaying: "y3",
      side: "right",
      showgrid: false,
      linecolor: axisLineColor,
      linewidth: 1,
      zeroline: false,
      range: [0, 100],
      tickvals: [0, 20, 40, 60, 80, 100],
    },

    // ===== SUBPLOT 3: Vavg & Q =====
    yaxis5: {
      title: { text: isSNTB ? "Average Voltage (kV)" : "Vavg (kV)", font: { color: vColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
      tickfont: { color: vColor, size: 8, family: "Helvetica, Arial, sans-serif" },
      showgrid: graphOptions.showGridLines,
      gridcolor: gridColor,
      linecolor: axisLineColor,
      linewidth: 1,
      mirror: true,
      zeroline: false,
      domain: [d3bot, d3top],
      range: [21, 24],
      tickvals: [21, 21.5, 22, 22.5, 23, 23.5, 24]
    },
    yaxis6: {
      title: { text: graphOptions.customY2Label || "Q (MVar)", font: { color: qColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
      tickfont: { color: qColor, size: 8, family: "Helvetica, Arial, sans-serif" },
      overlaying: "y5",
      side: "right",
      showgrid: false,
      linecolor: axisLineColor,
      linewidth: 1,
      zeroline: false,
      range: finalY2Range,
      tickvals: result.profile.reactiveTicks,
    },

    annotations: [] as any[],
    shapes: [] as any[]
  };

  // ===== sgtitle =====
  const sgTitleText = `${result.profile.label}-Power Flow`;
  layoutObj.annotations.push({
    xref: "paper", yref: "paper",
    x: 0.5, y: 1.03,
    xanchor: "center", yanchor: "bottom",
    showarrow: false,
    text: `<b>${sgTitleText}</b>`,
    font: { family: "Helvetica, Arial, sans-serif", size: 13, color: textColor, weight: "bold" },
  });

  // ===== Subplot titles =====
  layoutObj.annotations.push({
    xref: "paper", yref: "paper",
    x: 0.5, y: d1top + 0.005,
    xanchor: "center", yanchor: "bottom",
    showarrow: false,
    text: "<b>Active Power and Frequency</b>",
    font: { family: "Helvetica, Arial, sans-serif", size: 10, color: textColorSecondary },
  });
  layoutObj.annotations.push({
    xref: "paper", yref: "paper",
    x: 0.5, y: d2top + 0.005,
    xanchor: "center", yanchor: "bottom",
    showarrow: false,
    text: "<b>Active Power and SOC</b>",
    font: { family: "Helvetica, Arial, sans-serif", size: 10, color: textColorSecondary },
  });
  layoutObj.annotations.push({
    xref: "paper", yref: "paper",
    x: 0.5, y: d3top + 0.005,
    xanchor: "center", yanchor: "bottom",
    showarrow: false,
    text: isSNTB ? "<b>Reactive Power and Average Voltage</b>" : "<b>Reactive Power and Average Voltage</b>",
    font: { family: "Helvetica, Arial, sans-serif", size: 10, color: textColorSecondary },
  });

  // ===== Legends (Northwest corner of each subplot) =====
  if (graphOptions.showLegend) {
    const legendBg = "#FFFFFF";
    const legendBorder = "#CCCCCC";

    // Subplot 1 Legend
    layoutObj.annotations.push({
      xref: "paper", yref: "paper",
      x: 0.05, y: d1top - 0.01,
      xanchor: "left", yanchor: "top",
      showarrow: false,
      align: "left",
      text: `<span style="color:#0072BD; font-weight:bold;">━</span> P (POC) (MW)<br><span style="color:#D95319; font-weight:bold;">━</span> F (Hz)`,
      bgcolor: legendBg,
      bordercolor: legendBorder,
      borderwidth: 1,
      borderpad: 4,
      font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor },
    });

    // Subplot 2 Legend
    const sub2LegendItems = result.pvs
      ? `<span style="color:#0072BD; font-weight:bold;">━</span> P (POC) (MW)<br><span style="color:#CC9900; font-weight:bold;">━</span> P (PV) (MW)<br><span style="color:#008000; font-weight:bold;">━</span> P (BESS) (MW)<br><span style="color:#D95319; font-weight:bold;">━</span> SOC (%)`
      : `<span style="color:#0072BD; font-weight:bold;">━</span> P (POC) (MW)<br><span style="color:#D95319; font-weight:bold;">━</span> SOC (%)`;
    layoutObj.annotations.push({
      xref: "paper", yref: "paper",
      x: 0.05, y: d2top - 0.01,
      xanchor: "left", yanchor: "top",
      showarrow: false,
      align: "left",
      text: sub2LegendItems,
      bgcolor: legendBg,
      bordercolor: legendBorder,
      borderwidth: 1,
      borderpad: 4,
      font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor },
    });

    // Subplot 3 Legend
    const sub3LegendItems = isSNTB
      ? `<span style="color:${qColor}; font-weight:bold;">━</span> Q (POC)<br><span style="color:${vColor}; font-weight:bold;">━</span> Vavg (kV)`
      : (result.smartLogger
          ? `<span style="color:${qColor}; font-weight:bold;">━</span> Q (POC) (MVar)<br><span style="color:#000000; font-weight:bold;">━</span> Q (BESS) (MVar)<br><span style="color:${vColor}; font-weight:bold;">━</span> Vavg (kV)`
          : `<span style="color:${qColor}; font-weight:bold;">━</span> Q (POC) (MVar)<br><span style="color:${vColor}; font-weight:bold;">━</span> Vavg (kV)`);

    layoutObj.annotations.push({
      xref: "paper", yref: "paper",
      x: 0.05, y: d3top - 0.01,
      xanchor: "left", yanchor: "top",
      showarrow: false,
      align: "left",
      text: sub3LegendItems,
      bgcolor: legendBg,
      bordercolor: legendBorder,
      borderwidth: 1,
      borderpad: 4,
      font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor },
    });
  }

  // ===== Cycle annotation (Northeast of Subplot 2) =====
  if (Number.isFinite(result.cycle.dailyAvg) && Number.isFinite(result.cycle.todayAvg)) {
    let formattedDate = result.dataDate;
    if (isSNTB && result.main.times.length > 0) {
      const firstDate = result.main.times[0];
      const months = ["May", "May", "May", "May", "May", "May", "May", "May", "May", "May", "May", "May"]; 
      // Let's dynamically format standard date using JavaScript Locale or direct string parsing
      try {
        const dObj = new Date(firstDate);
        if (!isNaN(dObj.getTime())) {
          const day = dObj.getDate();
          const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
          const month = monthNames[dObj.getMonth()];
          const year = dObj.getFullYear();
          formattedDate = `${month} ${day}, ${year}`;
        }
      } catch (e) {}
    } else {
      // SNTV format: yyyy-mm-dd
      try {
        const dObj = new Date(result.main.times[0]);
        if (!isNaN(dObj.getTime())) {
          const pad = (n: number) => String(n).padStart(2, "0");
          formattedDate = `${dObj.getFullYear()}-${pad(dObj.getMonth()+1)}-${pad(dObj.getDate())}`;
        }
      } catch (e) {}
    }

    const legendBg = "#FFFFFF";
    const legendBorder = "#333333";
    
    const labelStr = isSNTB
      ? `Daily cycle (${formattedDate}):<br>  Cycle Plant Avg  =  ${result.cycle.dailyAvg.toFixed(3)}<br><br>Total cycle:<br>  Total Plant Avg  =  ${result.cycle.todayAvg.toFixed(3)}`
      : `Daily cycle (${formattedDate}):<br>  Cycle Plant Avg  =  ${result.cycle.dailyAvg.toFixed(3)}<br><br>Total cycle:<br>  Total Plant Avg  =  ${result.cycle.todayAvg.toFixed(3)}`;

    layoutObj.annotations.push({
      xref: "paper",
      yref: "paper",
      x: 0.93,
      y: d2top - 0.01,
      xanchor: "right",
      yanchor: "top",
      align: "left",
      showarrow: false,
      text: labelStr,
      bgcolor: legendBg,
      bordercolor: legendBorder,
      borderwidth: 0.5,
      borderpad: 4,
      font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor },
    });
  }

  // Rotated timestamp date footer matching MATLAB
  layoutObj.annotations.push({
    xref: "paper", yref: "paper",
    x: 0.94, y: 0.0,
    xanchor: "right", yanchor: "top",
    showarrow: false,
    text: (() => {
      if (result.main.times.length > 0) {
        const firstDate = new Date(result.main.times[0]);
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return `${monthNames[firstDate.getMonth()]} ${firstDate.getDate()}, ${firstDate.getFullYear()}`;
      }
      return result.dataDate;
    })(),
    font: { family: "Helvetica, Arial, sans-serif", size: 9, color: textColor },
  });

  // Ingest Pinned Data Tips (Pins)
  if (pinnedPoints && pinnedPoints.length > 0) {
    pinnedPoints.forEach((pt) => {
      let xref = "x";
      let yref = pt.yaxisRef;
      
      if (pt.subplot === 2) {
        xref = "x2";
      } else if (pt.subplot === 3) {
        xref = "x3";
      }

      // Format X date display: "May 28, 2026, 07:50:38"
      let formattedDateStr = pt.xValue;
      try {
        const dObj = new Date(pt.xValue);
        if (!isNaN(dObj.getTime())) {
          const day = dObj.getDate();
          const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
          const month = monthNames[dObj.getMonth()];
          const year = dObj.getFullYear();
          const pad = (n: number) => String(n).padStart(2, "0");
          formattedDateStr = `${month} ${day}, ${year}, ${pad(dObj.getHours())}:${pad(dObj.getMinutes())}:${pad(dObj.getSeconds())}`;
        }
      } catch (e) {}

      const formattedY = pt.yValue % 1 === 0 ? String(pt.yValue) : pt.yValue.toFixed(4);

      layoutObj.annotations.push({
        x: pt.xDisplay,
        y: pt.yValue,
        xref: xref,
        yref: yref,
        showarrow: true,
        arrowhead: 2,
        arrowcolor: pt.color,
        arrowsize: 0.8,
        arrowwidth: 1,
        ax: 35,
        ay: -35,
        text: `X ${formattedDateStr}<br>Y ${formattedY}`,
        bgcolor: "#FFFFFF",
        bordercolor: "#333333",
        borderwidth: 0.5,
        borderpad: 4,
        align: "left",
        font: { family: "Helvetica, Arial, sans-serif", size: 8, color: "#000000" }
      });
    });
  }

  return layoutObj;
}

function SinglePlot({
  data,
  result,
  title,
  y1,
  y2,
  y1Range,
  y2Range,
  annotations,
  graphOptions,
  pinnedPoints,
  setPinnedPoints,
  subplot,
}: {
  data: any[];
  result: Ess20Result;
  title: string;
  y1: string;
  y2: string;
  y1Range?: [number, number];
  y2Range?: [number, number];
  annotations?: any[];
  graphOptions: GraphOptions;
  pinnedPoints: PinnedPoint[];
  setPinnedPoints: React.Dispatch<React.SetStateAction<PinnedPoint[]>>;
  subplot: number;
}) {
  const cleanData = cleanUndefined(data.filter(Boolean));
  const cleanLay = cleanUndefined(layout(result, title, y1, y2, y1Range, y2Range, annotations, graphOptions, pinnedPoints, subplot));

  const handlePlotClick = (eventData: any) => {
    if (!eventData || !eventData.points || eventData.points.length === 0) return;
    const pt = eventData.points[0];
    if (pt.x == null || pt.y == null) return;

    const xDisplay = String(pt.x);
    const yValue = Number(pt.y);
    const seriesName = pt.data?.name || "Series";
    const color = pt.data?.line?.color || "#00A3FF";
    
    const ptIndex = pt.pointIndex;
    let xValue = "";
    if (ptIndex !== undefined && ptIndex >= 0 && ptIndex < result.main.times.length) {
      const originalDate = new Date(result.main.times[ptIndex]);
      if (!isNaN(originalDate.getTime())) {
        const pad = (n: number) => String(n).padStart(2, "0");
        xValue = `${originalDate.getFullYear()}-${pad(originalDate.getMonth() + 1)}-${pad(originalDate.getDate())} ${pad(originalDate.getHours())}:${pad(originalDate.getMinutes())}:${pad(originalDate.getSeconds())}`;
      }
    }
    
    if (!xValue) {
      const foundIdx = result.main.times.findIndex(t => formatTime(t) === xDisplay);
      if (foundIdx >= 0) {
        const originalDate = new Date(result.main.times[foundIdx]);
        const pad = (n: number) => String(n).padStart(2, "0");
        xValue = `${originalDate.getFullYear()}-${pad(originalDate.getMonth() + 1)}-${pad(originalDate.getDate())} ${pad(originalDate.getHours())}:${pad(originalDate.getMinutes())}:${pad(originalDate.getSeconds())}`;
      } else {
        xValue = `${result.dataDate} ${xDisplay}:00`;
      }
    }

    const yaxisRef = pt.data?.yaxis || "y";
    const id = `${xValue}__${seriesName}`;

    setPinnedPoints((prev) => {
      const existingIdx = prev.findIndex((p) => p.id === id);
      if (existingIdx >= 0) {
        return prev.filter((p) => p.id !== id);
      } else {
        return [
          ...prev,
          {
            id,
            xValue,
            xDisplay,
            yValue,
            seriesName,
            yaxisRef,
            color,
            subplot,
          },
        ];
      }
    });
  };

  return (
    <div className="flex-grow flex flex-col w-full h-full min-h-0 relative" style={{ width: "100%", height: "100%", background: graphOptions.whiteBackground ? "#FFFFFF" : "#F5F5F5" }}>
      <Plot data={cleanData} layout={cleanLay} useResizeHandler style={plotStyle} config={plotConfig} onClick={handlePlotClick} />
    </div>
  );
}

function PlotBox({ children }: { children: React.ReactNode }) {
  return <div className="h-64 border border-gray-300 shadow-sm">{children}</div>;
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="h-full min-h-[420px] flex items-center justify-center border border-border-v bg-surface/30 rounded text-[11px] font-mono uppercase tracking-widest text-foreground/40">
      {message}
    </div>
  );
}

const plotStyle = { width: "100%", height: "100%" };
const plotConfig = { displayModeBar: true, responsive: true };

function layout(
  result: Ess20Result,
  title: string,
  y1Title: string,
  y2Title: string,
  y1Range?: [number, number],
  y2Range?: [number, number],
  annotations?: any[],
  graphOptions?: GraphOptions,
  pinnedPoints?: PinnedPoint[],
  subplot?: number,
): any {
  const showGrid = graphOptions ? graphOptions.showGridLines : true;
  const showLegend = graphOptions ? graphOptions.showLegend : true;

  const isDark = document.documentElement.classList.contains("dark");
  const bg = graphOptions && graphOptions.whiteBackground 
    ? "#FFFFFF" 
    : (isDark ? "#0D1520" : "#FFFFFF");
  const gridColor = graphOptions && graphOptions.whiteBackground 
    ? "#E5E7EB" 
    : (isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.06)");
  const textColor = graphOptions && graphOptions.whiteBackground
    ? "#0F172A"
    : (isDark ? "#F0F4F8" : "#0F172A");
  const textSecondaryColor = graphOptions && graphOptions.whiteBackground
    ? "#475569"
    : (isDark ? "#8896A7" : "#475569");
  const axisLineColor = graphOptions && graphOptions.whiteBackground
    ? "rgba(0,0,0,0.09)"
    : (isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.09)");

  const displayTitle = (graphOptions && graphOptions.customTitle) ? graphOptions.customTitle : title;
  const displayY1Title = (graphOptions && graphOptions.customY1Label) ? graphOptions.customY1Label : y1Title;
  const displayY2Title = (graphOptions && graphOptions.customY2Label) ? graphOptions.customY2Label : y2Title;

  let y1Color = "#2563EB";
  let y2Color = "#EA580C";
  if (isDark && !(graphOptions && graphOptions.whiteBackground)) {
    if (y1Title.includes("P") || y1Title.includes("Cycles") || y1Title.includes("Vab") || y1Title.includes("Voltage")) {
      y1Color = "#38BDF8";
    }
    if (y2Title.includes("F") || y2Title.includes("Q") || y2Title.includes("SOC")) {
      y2Color = "#FB923C";
    }
  }

  let finalY1Range = y1Range;
  if (graphOptions) {
    const hasMin = graphOptions.y1Min !== "";
    const hasMax = graphOptions.y1Max !== "";
    if (hasMin || hasMax) {
      const defaultMin = y1Range ? y1Range[0] : 0;
      const defaultMax = y1Range ? y1Range[1] : 100;
      finalY1Range = [
        hasMin ? parseFloat(graphOptions.y1Min) : defaultMin,
        hasMax ? parseFloat(graphOptions.y1Max) : defaultMax
      ];
    }
  }

  let finalY2Range = y2Range;
  if (graphOptions) {
    const hasMin = graphOptions.y2Min !== "";
    const hasMax = graphOptions.y2Max !== "";
    if (hasMin || hasMax) {
      const defaultMin = y2Range ? y2Range[0] : 0;
      const defaultMax = y2Range ? y2Range[1] : 100;
      finalY2Range = [
        hasMin ? parseFloat(graphOptions.y2Min) : defaultMin,
        hasMax ? parseFloat(graphOptions.y2Max) : defaultMax
      ];
    }
  }

  const baseAnnotations = annotations?.map(a => ({
    ...a,
    font: { ...a.font, color: textColor, family: "JetBrains Mono, monospace" },
    bgcolor: graphOptions && graphOptions.whiteBackground ? "#FFFFFF" : (isDark ? "#111827" : "#FFFFFF"),
    bordercolor: axisLineColor,
  })) || [];

  const extraAnnotations: any[] = [];
  if (pinnedPoints && subplot !== undefined) {
    pinnedPoints
      .filter((pt) => pt.subplot === subplot)
      .forEach((pt) => {
        const isY2 = pt.yaxisRef === "y2" || pt.yaxisRef === "y4" || pt.yaxisRef === "y6";
        const yref = isY2 ? "y2" : "y";

        // Format date string
        let formattedDateStr = pt.xValue;
        try {
          const dObj = new Date(pt.xValue);
          if (!isNaN(dObj.getTime())) {
            const day = dObj.getDate();
            const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const month = monthNames[dObj.getMonth()];
            const year = dObj.getFullYear();
            const pad = (n: number) => String(n).padStart(2, "0");
            formattedDateStr = `${month} ${day}, ${year}, ${pad(dObj.getHours())}:${pad(dObj.getMinutes())}:${pad(dObj.getSeconds())}`;
          }
        } catch (e) {}

        const formattedY = pt.yValue % 1 === 0 ? String(pt.yValue) : pt.yValue.toFixed(4);

        extraAnnotations.push({
          x: pt.xDisplay,
          y: pt.yValue,
          xref: "x",
          yref: yref,
          showarrow: true,
          arrowhead: 2,
          arrowcolor: pt.color,
          arrowsize: 0.8,
          arrowwidth: 1,
          ax: 35,
          ay: -35,
          text: `X ${formattedDateStr}<br>Y ${formattedY}`,
          bgcolor: "#FFFFFF",
          bordercolor: "#333333",
          borderwidth: 0.5,
          borderpad: 4,
          align: "left",
          font: { family: "Helvetica, Arial, sans-serif", size: 8, color: "#000000" }
        });
      });
  }

  return {
    title: { 
      text: `<b>${displayTitle}</b>`, 
      font: { family: "Inter, system-ui, sans-serif", size: 13, color: textColor }, 
      x: 0.5 
    },
    autosize: true,
    margin: { t: 45, r: displayY2Title ? 62 : 28, l: 62, b: 45 },
    paper_bgcolor: "transparent",
    plot_bgcolor: bg,
    font: { family: "Inter, system-ui, sans-serif", size: 11, color: textSecondaryColor },
    xaxis: {
      showgrid: showGrid,
      gridcolor: gridColor,
      linecolor: axisLineColor,
      mirror: true,
      tickangle: -45,
      tickfont: { size: 11, color: textSecondaryColor, family: "JetBrains Mono, monospace" },
    },
    yaxis: {
      title: { text: `<b>${displayY1Title}</b>`, font: { color: y1Color, size: 11, family: "Inter, system-ui, sans-serif" } },
      tickfont: { color: y1Color, size: 11, family: "JetBrains Mono, monospace" },
      showgrid: showGrid,
      gridcolor: gridColor,
      linecolor: axisLineColor,
      mirror: true,
      zeroline: false,
      ...(finalY1Range ? { range: finalY1Range } : {}),
      ...(result.profile.powerTicks.length && y1Title.includes("P (MW)") ? { tickvals: result.profile.powerTicks } : {}),
    },
    ...(displayY2Title ? {
      yaxis2: {
        title: { text: `<b>${displayY2Title}</b>`, font: { color: y2Color, size: 11, family: "Inter, system-ui, sans-serif" } },
        tickfont: { color: y2Color, size: 11, family: "JetBrains Mono, monospace" },
        overlaying: "y",
        side: "right",
        showgrid: false,
        zeroline: false,
        ...(finalY2Range ? { range: finalY2Range } : {}),
        ...(y2Title.includes("Q") ? { tickvals: result.profile.reactiveTicks } : {}),
      },
    } : {}),
    showlegend: showLegend,
    legend: {
      x: 0.99,
      y: 0.99,
      xanchor: "right",
      yanchor: "top",
      bgcolor: graphOptions && graphOptions.whiteBackground ? "rgba(255,255,255,0.85)" : (isDark ? "rgba(15, 24, 38, 0.85)" : "rgba(255,255,255,0.85)"),
      bordercolor: axisLineColor,
      borderwidth: 1,
      font: { size: 12, color: textColor, family: "Inter, system-ui, sans-serif" },
    },
    annotations: baseAnnotations.concat(extraAnnotations),
  };
}

function pfTraces(result: Ess20Result, x: string[], graphOptions: GraphOptions): any[] {
  const res = graphOptions.timeResolution || 5;
  const p1 = downsampleTrace(x, result.main.pMw, result.main.times, res);
  const f1 = downsampleTrace(x, result.main.frequency, result.main.times, res);

  const shape = graphOptions.smoothCurves ? "spline" : "hv";
  const pStyle = getTraceStyle("P (POC) (MW)", "#0072BD", 2, shape, graphOptions);
  const fStyle = getTraceStyle("F (Hz)", "#D95319", 1.5, shape, graphOptions);

  return [
    { x: p1.x, y: p1.y, type: "scatter", mode: pStyle.mode, name: "P (POC) (MW)", visible: pStyle.visible, fill: graphOptions.fillAreaY1 ? "tozeroy" : undefined, line: pStyle.line, marker: pStyle.marker },
    { x: f1.x, y: f1.y, type: "scatter", mode: fStyle.mode, name: "F (Hz)", visible: fStyle.visible, yaxis: "y2", line: fStyle.line, marker: fStyle.marker },
  ];
}

function socTraces(result: Ess20Result, x: string[], graphOptions: GraphOptions): any[] {
  const res = graphOptions.timeResolution || 5;
  const shape = graphOptions.smoothCurves ? "spline" : "linear";

  if (result.pvs) {
    const xp = result.pvs.times.map(formatTime);
    const p1 = downsampleTrace(xp, result.pvs.pPccMw, result.pvs.times, res);
    const p2 = downsampleTrace(xp, result.pvs.pPvMw, result.pvs.times, res);
    const p3 = downsampleTrace(xp, result.pvs.pEssMw, result.pvs.times, res);
    const socVal = downsampleTrace(xp, result.pvs.socPct, result.pvs.times, res);

    const pStyle = getTraceStyle("P (POC) (MW)", "#0072BD", 1.8, shape, graphOptions);
    const pvStyle = getTraceStyle("P (PV) (MW)", "#CC9900", 1.5, shape, graphOptions);
    const bessStyle = getTraceStyle("P (BESS) (MW)", "#008000", 1.5, shape, graphOptions);
    const socStyle = getTraceStyle("SOC (%)", "#D95319", 1.8, shape, graphOptions);

    return [
      { x: p1.x, y: p1.y, type: "scatter", mode: pStyle.mode, name: "P (POC) (MW)", visible: pStyle.visible, fill: graphOptions.fillAreaY1 ? "tozeroy" : undefined, line: pStyle.line, marker: pStyle.marker },
      { x: p2.x, y: p2.y, type: "scatter", mode: pvStyle.mode, name: "P (PV) (MW)", visible: pvStyle.visible, line: pvStyle.line, marker: pvStyle.marker },
      { x: p3.x, y: p3.y, type: "scatter", mode: bessStyle.mode, name: "P (BESS) (MW)", visible: bessStyle.visible, line: bessStyle.line, marker: bessStyle.marker },
      { x: socVal.x, y: socVal.y, type: "scatter", mode: socStyle.mode, name: "SOC (%)", visible: socStyle.visible, yaxis: "y2", line: socStyle.line, marker: socStyle.marker },
    ];
  }

  const p1 = downsampleTrace(x, result.main.pMw, result.main.times, res);
  const socVal = downsampleTrace(x, result.main.soc, result.main.times, res);

  const pStyle = getTraceStyle("P (POC) (MW)", "#0072BD", 1.8, shape, graphOptions);
  const socStyle = getTraceStyle("SOC (%)", "#D95319", 1.8, shape, graphOptions);

  return [
    { x: p1.x, y: p1.y, type: "scatter", mode: pStyle.mode, name: "P (POC) (MW)", visible: pStyle.visible, fill: graphOptions.fillAreaY1 ? "tozeroy" : undefined, line: pStyle.line, marker: pStyle.marker },
    { x: socVal.x, y: socVal.y, type: "scatter", mode: socStyle.mode, name: "SOC (%)", visible: socStyle.visible, yaxis: "y2", line: socStyle.line, marker: socStyle.marker },
  ];
}

function qvTraces(result: Ess20Result, x: string[], graphOptions: GraphOptions) {
  const res = graphOptions.timeResolution || 5;
  const shape = graphOptions.smoothCurves ? "spline" : "linear";

  const v1 = downsampleTrace(x, result.main.vab, result.main.times, res);
  const v2 = downsampleTrace(x, result.main.vbc, result.main.times, res);
  const v3 = downsampleTrace(x, result.main.vca, result.main.times, res);
  const q1 = downsampleTrace(x, result.main.qMvar, result.main.times, res);

  const v1Style = getTraceStyle("Vab", "#0072BD", 1.5, shape, graphOptions);
  const v2Style = getTraceStyle("Vbc", "#77AC30", 1.5, shape, graphOptions);
  const v3Style = getTraceStyle("Vca", "#7E2F8E", 1.5, shape, graphOptions);
  const qStyle = getTraceStyle("Q (POC) (MVar)", "#D95319", 2, shape, graphOptions);

  const traces: any[] = [
    { x: v1.x, y: v1.y, type: "scatter", mode: v1Style.mode, name: "Vab", visible: v1Style.visible, line: v1Style.line, marker: v1Style.marker },
    { x: v2.x, y: v2.y, type: "scatter", mode: v2Style.mode, name: "Vbc", visible: v2Style.visible, line: v2Style.line, marker: v2Style.marker },
    { x: v3.x, y: v3.y, type: "scatter", mode: v3Style.mode, name: "Vca", visible: v3Style.visible, line: v3Style.line, marker: v3Style.marker },
    { x: q1.x, y: q1.y, type: "scatter", mode: qStyle.mode, name: "Q (POC) (MVar)", visible: qStyle.visible, yaxis: "y2", line: qStyle.line, marker: qStyle.marker },
  ];

  if (result.smartLogger) {
    const qbess = downsampleTrace(result.smartLogger.times.map(formatTime), result.smartLogger.totalQMvar, result.smartLogger.times, res);
    const qbessStyle = getTraceStyle("Q (BESS) (MVar)", "#000000", 1.4, shape, graphOptions);
    traces.push({
      x: qbess.x,
      y: qbess.y,
      type: "scatter",
      mode: qbessStyle.mode,
      name: "Q (BESS) (MVar)",
      visible: qbessStyle.visible,
      yaxis: "y2",
      line: qbessStyle.line,
      marker: qbessStyle.marker
    });
  }
  return traces;
}

function vavgTraces(result: Ess20Result, x: string[], graphOptions: GraphOptions) {
  const res = graphOptions.timeResolution || 5;
  const shape = graphOptions.smoothCurves ? "spline" : "linear";

  const v = downsampleTrace(x, result.main.vavg, result.main.times, res);
  const q = downsampleTrace(x, result.main.qMvar, result.main.times, res);

  const isSNTB = result.profile.label && result.profile.label.includes("SNTB");
  const vColor = isSNTB ? "#77AC30" : "#0072BD";
  const vWidth = isSNTB ? 0.8 : 1.6;

  const vStyle = getTraceStyle("Vavg (kV)", vColor, vWidth, shape, graphOptions);
  const qStyle = getTraceStyle("Q (POC) (MVar)", "#CC0000", 2, shape, graphOptions);

  const traces: any[] = [
    { x: v.x, y: v.y, type: "scatter", mode: vStyle.mode, name: "Vavg (kV)", visible: vStyle.visible, line: vStyle.line, marker: vStyle.marker },
    { x: q.x, y: q.y, type: "scatter", mode: qStyle.mode, name: "Q (POC) (MVar)", visible: qStyle.visible, yaxis: "y2", line: qStyle.line, marker: qStyle.marker },
  ];

  if (result.smartLogger) {
    const qbess = downsampleTrace(result.smartLogger.times.map(formatTime), result.smartLogger.totalQMvar, result.smartLogger.times, res);
    const qbessStyle = getTraceStyle("Q (BESS) (MVar)", "#000000", 1.4, shape, graphOptions);
    traces.push({
      x: qbess.x,
      y: qbess.y,
      type: "scatter",
      mode: qbessStyle.mode,
      name: "Q (BESS) (MVar)",
      visible: qbessStyle.visible,
      yaxis: "y2",
      line: qbessStyle.line,
      marker: qbessStyle.marker
    });
  }
  return traces;
}

function cycleAnnotation(result: Ess20Result) {
  if (!Number.isFinite(result.cycle.dailyAvg) || !Number.isFinite(result.cycle.todayAvg)) return undefined;
  return [{
    xref: "paper",
    yref: "paper",
    x: 0.98,
    y: 0.96,
    xanchor: "right",
    yanchor: "top",
    align: "left",
    showarrow: false,
    text: `Daily cycle (${result.dataDate}):<br>Cycle Plant Avg = ${formatValue(result.cycle.dailyAvg, 3)}<br><br>Total cycle:<br>Total Plant Avg = ${formatValue(result.cycle.todayAvg, 3)}`,
    bgcolor: "#FFFFFF",
    bordercolor: "#333333",
    borderwidth: 1,
    borderpad: 4,
    font: { family: "Arial, sans-serif", size: 10, color: "#000000" },
  }];
}

function fileListToEntries(files: FileList | null): Ess20FileEntry[] {
  return Array.from(files || []).map((file) => ({
    file,
    path: (file as any).webkitRelativePath || file.name,
  }));
}

async function getFilesFromDrop(dt: DataTransfer): Promise<Ess20FileEntry[]> {
  const out: Ess20FileEntry[] = [];
  const readEntry = async (entry: any, prefix: string): Promise<void> => {
    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        entry.file((file: File) => {
          out.push({ file, path: prefix + file.name });
          resolve();
        });
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries: any[] = [];
      const readAll = async (): Promise<void> => {
        const chunk = await new Promise<any[]>((resolve) => reader.readEntries(resolve));
        if (chunk.length > 0) {
          entries.push(...chunk);
          await readAll();
        }
      };
      await readAll();
      for (const child of entries) await readEntry(child, prefix + entry.name + "/");
    }
  };

  if (dt.items && dt.items.length) {
    for (const item of Array.from(dt.items)) {
      const entry = typeof (item as any).webkitGetAsEntry === "function" ? (item as any).webkitGetAsEntry() : null;
      if (entry) await readEntry(entry, "");
      else {
        const file = item.getAsFile();
        if (file) out.push({ file, path: file.name });
      }
    }
  } else {
    out.push(...fileListToEntries(dt.files));
  }
  return out;
}

function formatValue(value: number, digits: number) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}
