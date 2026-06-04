import React, { useRef, useState } from "react";
import Plot from "react-plotly.js";
import Plotly from "plotly.js";
import {
  Download,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Zap,
  Activity,
  Battery,
  BarChart3,
  Database,
  ArrowRight,
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
  ESS20_PROJECTS,
  Ess20ProjectId,
  Ess20Result,
  formatTime,
} from "../lib/ess20-engine";
import { ess20SharedState } from "../lib/ess20-shared-state";
import { PinnedPoint } from "./ESS20Tool";

/* ── Export types ───────────────────────────────────────────────────────── */
interface ChartSpec {
  id: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
}

const CHART_SPECS: ChartSpec[] = [
  { id: "pf",    label: "Active Power & Frequency", icon: <BarChart3 size={20} />, color: "text-blue-400 dark:text-blue-400",   bgColor: "bg-blue-500/5 dark:bg-blue-500/10",   borderColor: "border-blue-500/20 dark:border-blue-500/30" },
  { id: "soc",   label: "Active Power & SOC",       icon: <Battery size={20} />,   color: "text-green-400 dark:text-green-400",  bgColor: "bg-green-500/5 dark:bg-green-500/10",  borderColor: "border-green-500/20 dark:border-green-500/30" },
  { id: "qv",    label: "Reactive Power & Voltage",  icon: <Zap size={20} />,       color: "text-purple-400 dark:text-purple-400", bgColor: "bg-purple-500/5 dark:bg-purple-500/10", borderColor: "border-purple-500/20 dark:border-purple-500/30" },
  { id: "vavg",  label: "Reactive Power & Vavg",     icon: <Activity size={20} />,  color: "text-orange-400 dark:text-orange-400", bgColor: "bg-orange-500/5 dark:bg-orange-500/10", borderColor: "border-orange-500/20 dark:border-orange-500/30" },
  { id: "cycle", label: "ESS Equivalent Cycle",      icon: <CheckCircle2 size={20} />, color: "text-cyan-400 dark:text-cyan-400",   bgColor: "bg-cyan-500/5 dark:bg-cyan-500/10",   borderColor: "border-cyan-500/20 dark:border-cyan-500/30" },
  { id: "smart", label: "SmartLogger Summed Power",   icon: <Database size={20} />,  color: "text-yellow-400 dark:text-yellow-400", bgColor: "bg-yellow-500/5 dark:bg-yellow-500/10", borderColor: "border-yellow-500/20 dark:border-yellow-500/30" },
];

interface ExportLogEntry {
  ts: string;
  file: string;
  status: "ok" | "error";
  message: string;
}

export interface MatFigExportProps {
  theme: "dark" | "light";
  result: Ess20Result | null;
  projectId: Ess20ProjectId;
  active?: boolean;
  pinnedPoints: PinnedPoint[];
  setPinnedPoints: React.Dispatch<React.SetStateAction<PinnedPoint[]>>;
  onLoadResult?: (res: Ess20Result) => void;
}



const reconstructResult = (jsonData: any, folderName: string, activeProjectId: Ess20ProjectId): Ess20Result => {
  const projName = jsonData.metadata?.project || "";
  let profile = ESS20_PROJECTS.find(p => p.id === activeProjectId) || ESS20_PROJECTS[0];
  if (projName) {
    const found = ESS20_PROJECTS.find(p => p.id === projName || p.label.toLowerCase().includes(projName.toLowerCase()) || p.outputPrefix.toLowerCase().includes(projName.toLowerCase()));
    if (found) profile = found;
  }

  const rawTimestamps = jsonData.data?.timestamps || [];
  const times = rawTimestamps.map((t: string) => new Date(t));
  const firstTime = times[0] || new Date();
  
  const pad = (n: number) => String(n).padStart(2, "0");
  const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dataDate = jsonData.metadata?.date || formatDate(firstTime);

  let dayTag = "";
  const match = folderName.match(/^(\d{8})_/);
  if (match) {
    dayTag = match[1];
  } else {
    dayTag = `${firstTime.getFullYear()}${pad(firstTime.getMonth() + 1)}${pad(firstTime.getDate())}`;
  }

  const pMw = jsonData.data?.pMw || [];
  const frequency = jsonData.data?.frequency || [];
  const soc = jsonData.data?.soc || [];
  const vab = jsonData.data?.vab || [];
  const vbc = jsonData.data?.vbc || [];
  const vca = jsonData.data?.vca || [];
  const vavg = jsonData.data?.vavg || (vab.length ? vab.map((v: number, i: number) => (v + (vbc[i] || v) + (vca[i] || v)) / 3) : []);
  const qMvar = jsonData.data?.qTotal || [];

  const main = {
    times,
    pMw,
    qMvar,
    soc,
    frequency,
    vab,
    vbc,
    vca,
    vavg
  };

  let pvs = null;
  if (jsonData.data?.pPv && jsonData.data?.pBess) {
    pvs = {
      times,
      pPccMw: pMw,
      pPvMw: jsonData.data.pPv,
      pEssMw: jsonData.data.pBess,
      socPct: soc
    };
  }

  let smartLogger = null;
  if (jsonData.data?.qBess) {
    smartLogger = {
      times,
      totalPMw: jsonData.data.pBess || pMw.map(() => 0),
      totalQMvar: jsonData.data.qBess
    };
  }

  const capacityMap: Record<Ess20ProjectId, number> = {
    SNTB: 30,
    SNTV: 12,
    SNTD_DMF: 18,
    SNTZ: 3,
    MSGP: 14
  };
  const capacity = capacityMap[profile.id] || 30;

  let sumAbsP = 0;
  let count = 0;
  for (const val of pMw) {
    if (Number.isFinite(val) && !Number.isNaN(val)) {
      sumAbsP += Math.abs(val);
      count++;
    }
  }
  const dailyAvg = count > 0 ? ((sumAbsP / count) * 24) / (capacity * 2) : 0.0;
  const yesterdayAvg = 0.0;
  const todayAvg = dailyAvg;

  const cycle = {
    todayAvg,
    yesterdayAvg,
    dailyAvg,
    todayDeviceCount: 0,
    yesterdayDeviceCount: 0,
    timeline: null
  };

  return {
    profile,
    dataDate,
    dayTag,
    sourceRoot: folderName,
    files: {
      socVoltage: "result_output.json",
      activeReactive: "result_output.json",
      pvSmoothing: pvs ? "result_output.json" : "",
      smartLoggerCount: smartLogger ? 1 : 0,
      essTodayCount: 0,
      essYesterdayCount: 0,
      pcsCount: 0
    },
    main,
    pvs,
    smartLogger,
    cycle,
    warnings: []
  };
};

export function MatFigExport({ theme, result: propsResult, projectId, active, pinnedPoints, setPinnedPoints, onLoadResult }: MatFigExportProps) {
  const [outputFolder, setOutputFolder] = useState<string | null>(ess20SharedState.outputFolder);
  const [scale, setScale] = useState(ess20SharedState.scale);
  const [exportLog, setExportLog] = useState<ExportLogEntry[]>(ess20SharedState.exportLog);
  const [exporting, setExporting] = useState<Set<string>>(new Set());
  const [exported, setExported] = useState<Set<string>>(ess20SharedState.exported);
  const [format, setFormat] = useState<"png" | "fig">("fig");
  const [exportingAll, setExportingAll] = useState(false);

  const [detectedSubfolders, setDetectedSubfolders] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);

  // Local state for result, synchronized with prop but updatable locally
  const [result, setResult] = useState<Ess20Result | null>(propsResult);

  React.useEffect(() => {
    setResult(propsResult);
  }, [propsResult]);

  const handlePlotClick = (eventData: any, forcedSubplot?: number) => {
    if (!result || !eventData || !eventData.points || eventData.points.length === 0) return;
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
    if (forcedSubplot !== undefined) {
      subplot = forcedSubplot;
    } else {
      if (yaxisRef === "y3" || yaxisRef === "y4") subplot = 2;
      else if (yaxisRef === "y5" || yaxisRef === "y6") subplot = 3;
    }

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

  // Export overlay state for premium animations
  const [exportProgress, setExportProgress] = useState<{
    active: boolean;
    total: number;
    current: number;
    name: string;
    status: "exporting" | "success" | "idle";
  }>({ active: false, total: 0, current: 0, name: "", status: "idle" });

  React.useEffect(() => {
    if (active) {
      setOutputFolder(ess20SharedState.outputFolder);
      setScale(ess20SharedState.scale);
      setExportLog(ess20SharedState.exportLog);
      setExported(ess20SharedState.exported);
    }
  }, [active]);

  React.useEffect(() => {
    ess20SharedState.outputFolder = outputFolder;
    if (outputFolder && typeof localStorage !== "undefined") {
      localStorage.setItem("ess_output_folder_path", outputFolder);
    }
  }, [outputFolder]);

  React.useEffect(() => {
    ess20SharedState.scale = scale;
  }, [scale]);

  React.useEffect(() => {
    ess20SharedState.exportLog = exportLog;
  }, [exportLog]);

  React.useEffect(() => {
    ess20SharedState.exported = exported;
  }, [exported]);

  const chartRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const unifiedChartRef = useRef<HTMLDivElement | null>(null);
  const profile = ESS20_PROJECTS.find((p) => p.id === projectId) || ESS20_PROJECTS[0];
  const hasElectronAPI = typeof window !== "undefined" && !!window.electronAPI;

  const getThemeColor = (name: string, defaultColor: string) => {
    const isDark = theme === "dark";
    if (isDark) {
      if (name.includes("P (POC)") || name.includes("Total P") || name.includes("Average Equivalent Cycles") || name === "Vavg" || name.includes("Vavg") || name === "Vab" || name.includes("Subplot 1") && name.includes("P")) {
        return "#00D4FF"; // Cyber Cyan
      } else if (name.includes("F (Hz)") || name.includes("Total Q") || name.includes("Q (POC)")) {
        return "#FF9F43"; // Vibrant Amber
      } else if (name.includes("SOC") || name.includes("P (BESS)") || name.includes("Q (BESS)") || name === "Vbc") {
        return "#00FF9C"; // Neon Mint
      } else if (name.includes("P (PV)")) {
        return "#FFD700"; // Glowing Gold
      } else if (name === "Vca") {
        return "#a78bfa"; // Lavender
      }
    } else {
      // Light Mode colors
      if (name.includes("P (POC)") || name.includes("Total P") || name.includes("Average Equivalent Cycles") || name === "Vavg" || name.includes("Vavg") || name === "Vab") {
        return "#2563EB"; // Royal Blue
      } else if (name.includes("F (Hz)") || name.includes("Total Q") || name.includes("Q (POC)")) {
        return "#EA580C"; // Warm Amber
      } else if (name.includes("SOC") || name.includes("P (BESS)") || name.includes("Q (BESS)") || name === "Vbc") {
        return "#16A34A"; // Emerald
      } else if (name.includes("P (PV)")) {
        return "#D97706"; // Gold
      } else if (name === "Vca") {
        return "#8B5CF6"; // Purple
      }
    }
    return defaultColor;
  };

  const getTargetSubfolder = () => {
    if (!result) return null;
    const label = result.profile.label;
    const cleanLabel = label.replace(/ /g, "_").replace(/MWH/i, "MWh");
    const subfolderName = `${result.dayTag}_${cleanLabel}_PowerFlow`;
    if (!outputFolder) return subfolderName;
    if (outputFolder.startsWith("(")) return outputFolder;
    return `${outputFolder}/${subfolderName}`.replace(/\\/g, "/");
  };

  const scanForSubfolders = async () => {
    if (!window.electronAPI || !outputFolder || outputFolder.startsWith("(")) return;
    setScanning(true);
    try {
      const res = await window.electronAPI.checkExportedFiles(outputFolder);
      if (res.exists && res.files) {
        const subdirs = res.files.filter(name => name.endsWith("_PowerFlow") || name.includes("_PowerFlow"));
        const validDirs: string[] = [];
        for (const dir of subdirs) {
          const subDirPath = `${outputFolder}/${dir}`;
          const subres = await window.electronAPI.checkExportedFiles(subDirPath);
          if (subres.exists && subres.files && subres.files.includes("result_output.json")) {
            validDirs.push(dir);
          }
        }
        setDetectedSubfolders(validDirs);
      }
    } catch (e) {
      console.error("Scanning subfolders failed:", e);
    } finally {
      setScanning(false);
    }
  };

  const handleLoadSubfolder = async (subdirName: string) => {
    if (!window.electronAPI || !outputFolder) return;
    const jsonPath = `${outputFolder}/${subdirName}/result_output.json`;
    setExportProgress({
      active: true,
      total: 1,
      current: 0,
      name: `Reading exported data: ${subdirName}...`,
      status: "exporting"
    });
    try {
      const res = await window.electronAPI.loadResultJson(jsonPath);
      if (res.ok && res.data) {
        const loadedResult = reconstructResult(res.data, subdirName, projectId);
        setResult(loadedResult); // Update local result state
        if (onLoadResult) {
          onLoadResult(loadedResult);
        }
        setExportProgress(prev => ({ ...prev, current: 1, name: "✓ Data loaded successfully!", status: "success" }));
        setTimeout(() => setExportProgress(prev => ({ ...prev, active: false })), 1000);
      } else {
        alert("Failed to load result JSON: " + (res.error || "Unknown error"));
        setExportProgress(prev => ({ ...prev, active: false }));
      }
    } catch (e) {
      alert("Error loading data: " + String(e));
      setExportProgress(prev => ({ ...prev, active: false }));
    }
  };

  React.useEffect(() => {
    scanForSubfolders();
  }, [outputFolder, result]);

  React.useEffect(() => {
    const checkExistingFiles = async () => {
      const subFolder = getTargetSubfolder();
      if (!subFolder || !window.electronAPI || subFolder.startsWith("(")) return;
      try {
        const res = await window.electronAPI.checkExportedFiles(subFolder);
        if (res.exists && res.files) {
          const files = res.files;
          const detected = new Set<string>();
          
          if (files.some(f => f.endsWith("_Powerflow_Unified.html"))) {
            detected.add("unified-html");
          }
          if (files.some(f => f.endsWith("_Powerflow_Unified.png"))) {
            detected.add("unified-png");
          }
          
          for (const spec of CHART_SPECS) {
            const basePrefix = `${profile.outputPrefix}_${result?.dataDate}_${spec.id}`;
            if (files.some(f => f.startsWith(basePrefix) || f.includes(`_${spec.id}.png`) || f.includes(`_${spec.id}.fig`))) {
              detected.add(spec.id);
            }
          }
          
          if (files.some(f => f.endsWith("_Powerflow.fig"))) {
            detected.add("pf");
          }
          if (files.some(f => f.endsWith("_Frequency_Vs_ActivePower.fig"))) {
            detected.add("pf");
          }
          if (files.some(f => f.endsWith("_SOC_Vs_ActivePower.fig"))) {
            detected.add("soc");
          }
          if (files.some(f => f.endsWith("_Voltage_Vs_ReactivePower.fig"))) {
            detected.add("qv");
          }
          if (files.some(f => f.endsWith("_Powerflow_Vavg.fig"))) {
            detected.add("vavg");
          }
          
          if (detected.size > 0) {
            setExported(prev => {
              const next = new Set(prev);
              detected.forEach(item => next.add(item));
              return next;
            });
          }
        }
      } catch (e) {
        console.error("Checking existing files failed:", e);
      }
    };
    checkExistingFiles();
  }, [outputFolder, result, format]);

  /* ── Folder Selection ──────────────────────────────────────────────────── */
  const handleSelectFolder = async () => {
    if (window.electronAPI) {
      const folder = await window.electronAPI.selectFolder();
      if (folder) setOutputFolder(folder);
    } else {
      setOutputFolder("(Browser Mode — saved to Downloads)");
    }
  };

  /* ── Export Single Chart ───────────────────────────────────────────────── */
  const exportChart = async (chartId: string, isSilent = false) => {
    if (!result) return;
    const now = new Date().toLocaleTimeString();
    const spec = CHART_SPECS.find(s => s.id === chartId) || { label: "Chart" };

    if (!isSilent) {
      setExportProgress({
        active: true,
        total: 1,
        current: 0,
        name: format === "fig" ? "Preparing MATLAB figure capture..." : `Rendering ${spec.label}...`,
        status: "exporting"
      });
    }

    if (format === "fig") {
      setExporting((prev) => new Set(prev).add(chartId));
      try {
        if (window.electronAPI && (window.electronAPI as any).saveMatlabFigures && outputFolder && !outputFolder.startsWith("(")) {
          const subFolder = getTargetSubfolder() || outputFolder;
          const saveResult = await (window.electronAPI as any).saveMatlabFigures(subFolder, { ...result, pinnedPoints });
          if (saveResult.ok && !saveResult.error) {
            setExportLog((prev) => [{ ts: now, file: `${subFolder} (All 5 .fig files)`, status: "ok", message: "Saved MATLAB figures successfully" }, ...prev]);
            setExported(new Set(CHART_SPECS.map(s => s.id)));
            if (!isSilent) {
              setExportProgress(prev => ({ ...prev, current: 1, name: "✓ MATLAB figures exported!", status: "success" }));
              setTimeout(() => setExportProgress(prev => ({ ...prev, active: false })), 1500);
            }
          } else {
            const errorMsg = saveResult.error || "MATLAB execution failed";
            setExportLog((prev) => [{ ts: now, file: `${profile.outputPrefix}_${result.dataDate}`, status: "error", message: errorMsg }, ...prev]);
            if (!isSilent) {
              setExportProgress(prev => ({ ...prev, active: false }));
              alert("MATLAB Figures capture failed: " + errorMsg);
            }
          }
        } else {
          const msg = "MATLAB (.fig) export only supported in Electron environment with a valid local folder.";
          setExportLog((prev) => [{ ts: now, file: `${profile.outputPrefix}_${result.dataDate}`, status: "error", message: msg }, ...prev]);
          if (!isSilent) {
            setExportProgress(prev => ({ ...prev, active: false }));
            alert(msg);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        setExportLog((prev) => [{ ts: now, file: chartId, status: "error", message: errMsg }, ...prev]);
        if (!isSilent) setExportProgress(prev => ({ ...prev, active: false }));
      } finally {
        setExporting(new Set());
      }
      return;
    }

    // Capture HTML node and render PNG
    const el = chartRefs.current[chartId];
    if (!el) {
      if (!isSilent) setExportProgress(prev => ({ ...prev, active: false }));
      return;
    }

    const plotEl = el.querySelector(".js-plotly-plot") as HTMLElement | null;
    if (!plotEl) {
      if (!isSilent) setExportProgress(prev => ({ ...prev, active: false }));
      return;
    }

    setExporting((prev) => new Set(prev).add(chartId));

    try {
      const scaleNum = parseInt(scale, 10);
      const imgData = await (Plotly as any).toImage(plotEl, {
        format: "png",
        width: 1920,
        height: 1080,
        scale: scaleNum,
      });

      const base64 = imgData.split(",")[1];
      const fileName = `${profile.outputPrefix}_${result.dataDate}_${chartId}.png`;

      const subFolder = getTargetSubfolder() || outputFolder;
      if (window.electronAPI && subFolder && !subFolder.startsWith("(")) {
        const filePath = `${subFolder}/${fileName}`;
        const saveResult = await window.electronAPI.saveFile(filePath, base64);
        if (saveResult.ok) {
          setExportLog((prev) => [{ ts: now, file: filePath, status: "ok", message: "Saved successfully" }, ...prev]);
          setExported((prev) => new Set(prev).add(chartId));
          if (!isSilent) {
            setExportProgress(prev => ({ ...prev, current: 1, name: "✓ PNG saved successfully!", status: "success" }));
            setTimeout(() => setExportProgress(prev => ({ ...prev, active: false })), 1500);
          }
        } else {
          setExportLog((prev) => [{ ts: now, file: fileName, status: "error", message: saveResult.error || "Unknown error" }, ...prev]);
          if (!isSilent) setExportProgress(prev => ({ ...prev, active: false }));
        }
      } else {
        // Browser fallback: trigger download
        const link = document.createElement("a");
        link.href = imgData;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => link.remove(), 200);
        setExportLog((prev) => [{ ts: now, file: fileName, status: "ok", message: "Downloaded to browser" }, ...prev]);
        setExported((prev) => new Set(prev).add(chartId));
        if (!isSilent) {
          setExportProgress(prev => ({ ...prev, current: 1, name: "✓ File downloaded to browser!", status: "success" }));
          setTimeout(() => setExportProgress(prev => ({ ...prev, active: false })), 1500);
        }
      }
    } catch (err) {
      setExportLog((prev) => [{ ts: now, file: chartId, status: "error", message: err instanceof Error ? err.message : String(err) }, ...prev]);
      if (!isSilent) setExportProgress(prev => ({ ...prev, active: false }));
    } finally {
      setExporting((prev) => {
        const next = new Set(prev);
        next.delete(chartId);
        return next;
      });
    }
  };

  /* ── Export All Charts (Staggered Capturing Progress) ──────────────────── */
  const exportAll = async () => {
    if (!result) return;
    setExportingAll(true);
    const now = new Date().toLocaleTimeString();

    if (format === "fig") {
      setExportProgress({
        active: true,
        total: 5,
        current: 0,
        name: "Compiling and exporting all MATLAB .fig files...",
        status: "exporting"
      });
      try {
        if (window.electronAPI && (window.electronAPI as any).saveMatlabFigures && outputFolder && !outputFolder.startsWith("(")) {
          const subFolder = getTargetSubfolder() || outputFolder;
          const saveResult = await (window.electronAPI as any).saveMatlabFigures(subFolder, { ...result, pinnedPoints });
          if (saveResult.ok && !saveResult.error) {
            setExportLog((prev) => [{ ts: now, file: `${subFolder} (All 5 .fig files)`, status: "ok", message: "Saved MATLAB figures successfully" }, ...prev]);
            setExported(new Set(CHART_SPECS.map(s => s.id)));
            setExportProgress(prev => ({ ...prev, current: 5, name: "✓ All MATLAB figures saved!", status: "success" }));
            setTimeout(() => setExportProgress(prev => ({ ...prev, active: false })), 1500);
          } else {
            const errorMsg = saveResult.error || "MATLAB execution failed";
            setExportLog((prev) => [{ ts: now, file: `${profile.outputPrefix}_${result.dataDate}`, status: "error", message: errorMsg }, ...prev]);
            setExportProgress(prev => ({ ...prev, active: false }));
            alert("MATLAB batch save failed: " + errorMsg);
          }
        } else {
          const msg = "MATLAB export only supported in Electron mode with a local folder selected.";
          setExportLog((prev) => [{ ts: now, file: `${profile.outputPrefix}_${result.dataDate}`, status: "error", message: msg }, ...prev]);
          setExportProgress(prev => ({ ...prev, active: false }));
          alert(msg);
        }
      } catch (err) {
        setExportLog((prev) => [{ ts: now, file: "Export All", status: "error", message: err instanceof Error ? err.message : String(err) }, ...prev]);
        setExportProgress(prev => ({ ...prev, active: false }));
      } finally {
        setExportingAll(false);
      }
      return;
    }

    // Export all PNGs with staggered timing and premium progress overlay
    const activeSpecs = CHART_SPECS.filter(s => getChartProps(s.id) !== null);
    
    setExportProgress({
      active: true,
      total: activeSpecs.length,
      current: 0,
      name: `Initializing batch image render... [0 / ${activeSpecs.length}]`,
      status: "exporting"
    });

    try {
      for (let i = 0; i < activeSpecs.length; i++) {
        const spec = activeSpecs[i];
        setExportProgress({
          active: true,
          total: activeSpecs.length,
          current: i,
          name: `Rendering ${spec.label}... [Scale ${scale}x]`,
          status: "exporting"
        });
        // Stagger slightly to ensure stable Plotly rendering captured
        await new Promise(r => setTimeout(r, 200));
        await exportChart(spec.id, true);
      }

      setExportProgress({
        active: true,
        total: activeSpecs.length,
        current: activeSpecs.length,
        name: "✓ All active subplots saved successfully!",
        status: "success"
      });

      setTimeout(() => {
        setExportProgress(prev => ({ ...prev, active: false }));
      }, 1500);
    } catch (err) {
      console.error(err);
    } finally {
      setExportingAll(false);
    }
  };



  const getUnifiedChartProps = (): { data: any[]; layout: any } | null => {
    if (!result) return null;

    const timeX = result.main.times.map(formatTime);
    const hasPVS = !!result.pvs;
    const hasSmart = !!result.smartLogger;

    const isSNTB = profile.label && profile.label.includes("SNTB");
    const paperBg = "#FFFFFF";
    const plotBg = "#FFFFFF";
    const gridColor = "#E5E7EB";
    const textColor = "#000000";
    const axisLineColor = "#000000";

    const pColor = "#0072BD";
    const fColor = "#D95319";
    const pvColor = "#CC9900";
    const bessColor = "#008000";
    const socColor = "#D95319";
    const qColor = "#CC0000";
    const vColor = isSNTB ? "#77AC30" : "#0072BD";

    const data: any[] = [];
    const isDark = theme === "dark";

    // Area fill options
    const areaFillP1 = {
      fill: "tozeroy",
      fillcolor: isDark ? "rgba(0, 212, 255, 0.08)" : "rgba(37, 99, 235, 0.06)",
    };

    // --- Subplot 1 (Top): Active Power and Frequency ---
    data.push({
      x: timeX,
      y: result.main.pMw,
      type: "scatter",
      mode: "lines",
      name: "P (POC) (MW)",
      xaxis: "x3",
      yaxis: "y",
      line: { color: getThemeColor("P (POC) (MW)", "#0072BD"), width: 2, shape: "hv" },
      ...areaFillP1
    });
    data.push({
      x: timeX,
      y: result.main.frequency,
      type: "scatter",
      mode: "lines",
      name: "F (Hz)",
      xaxis: "x3",
      yaxis: "y2",
      line: { color: getThemeColor("F (Hz)", "#D95319"), width: 1.5 }
    });

    // --- Subplot 2 (Middle): Active Power and SOC ---
    if (hasPVS && result.pvs) {
      const xp = result.pvs.times.map(formatTime);
      data.push({
        x: xp,
        y: result.pvs.pPccMw,
        type: "scatter",
        mode: "lines",
        name: "P (POC) (MW)",
        xaxis: "x2",
        yaxis: "y3",
        line: { color: getThemeColor("P (POC) (MW)", "#0072BD"), width: 1.8 }
      });
      data.push({
        x: xp,
        y: result.pvs.pPvMw,
        type: "scatter",
        mode: "lines",
        name: "P (PV) (MW)",
        xaxis: "x2",
        yaxis: "y3",
        line: { color: getThemeColor("P (PV) (MW)", "#CC9900"), width: 1.5 }
      });
      data.push({
        x: xp,
        y: result.pvs.pEssMw,
        type: "scatter",
        mode: "lines",
        name: "P (BESS) (MW)",
        xaxis: "x2",
        yaxis: "y3",
        line: { color: getThemeColor("P (BESS) (MW)", "#008000"), width: 1.5 }
      });
      data.push({
        x: xp,
        y: result.pvs.socPct,
        type: "scatter",
        mode: "lines",
        name: "SOC (%)",
        xaxis: "x2",
        yaxis: "y4",
        line: { color: getThemeColor("SOC (%)", "#D95319"), width: 1.8 }
      });
    } else {
      data.push({
        x: timeX,
        y: result.main.pMw,
        type: "scatter",
        mode: "lines",
        name: "P (POC) (MW)",
        xaxis: "x2",
        yaxis: "y3",
        line: { color: getThemeColor("P (POC) (MW)", "#0072BD"), width: 1.8 }
      });
      data.push({
        x: timeX,
        y: result.main.soc,
        type: "scatter",
        mode: "lines",
        name: "SOC (%)",
        xaxis: "x2",
        yaxis: "y4",
        line: { color: getThemeColor("SOC (%)", "#D95319"), width: 1.8 }
      });
    }

    // --- Subplot 3 (Bottom): Reactive Power and Average Voltage ---
    data.push({
      x: timeX,
      y: result.main.vavg,
      type: "scatter",
      mode: "lines",
      name: "Vavg (kV)",
      xaxis: "x",
      yaxis: "y5",
      line: { color: vColor, width: isSNTB ? 0.8 : 1.6 }
    });
    data.push({
      x: timeX,
      y: result.main.qMvar,
      type: "scatter",
      mode: "lines",
      name: "Q (POC) (MVar)",
      xaxis: "x",
      yaxis: "y6",
      line: { color: qColor, width: 2, shape: "hv" }
    });
    if (hasSmart && result.smartLogger) {
      data.push({
        x: result.smartLogger.times.map(formatTime),
        y: result.smartLogger.totalQMvar,
        type: "scatter",
        mode: "lines",
        name: "Q (BESS) (MVar)",
        xaxis: "x",
        yaxis: "y6",
        line: { color: getThemeColor("Q (BESS) (MVar)", "#000000"), width: 1.4, shape: "hv" }
      });
    }


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

    const layout = {
      title: {
        text: `<b>${profile.label}-Power Flow</b>`,
        font: { family: "Helvetica, Arial, sans-serif", size: 13, color: textColor },
        x: 0.5
      },
      autosize: true,
      height: 900,
      margin: { t: 80, r: 80, l: 80, b: 65 },
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor },

      // Linked time axes
      xaxis: {
        domain: [0.04, 0.96],
        showgrid: true,
        gridcolor: gridColor,
        linecolor: axisLineColor,
        linewidth: 1,
        mirror: true,
        tickangle: -45,
        tickfont: { size: 8, color: textColor, family: "Helvetica, Arial, sans-serif" },
        tickvals: tickVals,
        ticktext: tickVals,
        anchor: "y5"
      },
      xaxis2: {
        domain: [0.04, 0.96],
        showgrid: true,
        gridcolor: gridColor,
        linecolor: axisLineColor,
        linewidth: 1,
        mirror: true,
        tickfont: { size: 8, color: textColor, family: "Helvetica, Arial, sans-serif" },
        tickvals: tickVals,
        ticktext: tickVals,
        anchor: "y3",
        matches: "x",
        showticklabels: false
      },
      xaxis3: {
        domain: [0.04, 0.96],
        showgrid: true,
        gridcolor: gridColor,
        linecolor: axisLineColor,
        linewidth: 1,
        mirror: true,
        tickfont: { size: 8, color: textColor, family: "Helvetica, Arial, sans-serif" },
        tickvals: tickVals,
        ticktext: tickVals,
        anchor: "y1",
        matches: "x",
        showticklabels: false
      },

      // Subplot 1 (Top): Active Power and Frequency
      yaxis: {
        title: { text: "P (MW)", font: { color: pColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
        tickfont: { color: pColor, size: 8, family: "Helvetica, Arial, sans-serif" },
        showgrid: true,
        gridcolor: gridColor,
        linecolor: axisLineColor,
        linewidth: 1,
        mirror: true,
        zeroline: false,
        domain: [0.7166, 0.96],
        range: result.profile.powerRange,
        tickvals: result.profile.powerTicks
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

      // Subplot 2 (Middle): Active Power and SOC
      yaxis3: {
        title: { text: "P (MW)", font: { color: pColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
        tickfont: { color: pColor, size: 8, family: "Helvetica, Arial, sans-serif" },
        showgrid: true,
        gridcolor: gridColor,
        linecolor: axisLineColor,
        linewidth: 1,
        mirror: true,
        zeroline: false,
        domain: [0.3933, 0.6366],
        range: result.profile.powerRange,
        tickvals: result.profile.powerTicks
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
        tickvals: [0, 20, 40, 60, 80, 100]
      },

      // Subplot 3 (Bottom): Reactive Power and Average Voltage
      yaxis5: {
        title: { text: isSNTB ? "Average Voltage (kV)" : "Vavg (kV)", font: { color: vColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
        tickfont: { color: vColor, size: 8, family: "Helvetica, Arial, sans-serif" },
        showgrid: true,
        gridcolor: gridColor,
        linecolor: axisLineColor,
        linewidth: 1,
        mirror: true,
        zeroline: false,
        domain: [0.07, 0.3133],
        range: [21, 24],
        tickvals: [21, 21.5, 22, 22.5, 23, 23.5, 24]
      },
      yaxis6: {
        title: { text: "Q (MVar)", font: { color: qColor, size: 9, family: "Helvetica, Arial, sans-serif" }, standoff: 5 },
        tickfont: { color: qColor, size: 8, family: "Helvetica, Arial, sans-serif" },
        overlaying: "y5",
        side: "right",
        showgrid: false,
        linecolor: axisLineColor,
        linewidth: 1,
        zeroline: false,
        range: result.profile.reactiveRange,
        tickvals: result.profile.reactiveTicks
      },

      showlegend: false, // Disables native legend in favor of northwest ones
      annotations: [
        {
          xref: "paper", yref: "paper",
          x: 0.5, y: 0.965,
          xanchor: "center", yanchor: "bottom",
          text: "<b>Active Power and Frequency</b>",
          showarrow: false,
          font: { size: 10, color: textColor, family: "Helvetica, Arial, sans-serif" }
        },
        {
          xref: "paper", yref: "paper",
          x: 0.5, y: 0.625,
          xanchor: "center", yanchor: "bottom",
          text: "<b>Active Power and SOC</b>",
          showarrow: false,
          font: { size: 10, color: textColor, family: "Helvetica, Arial, sans-serif" }
        },
        {
          xref: "paper", yref: "paper",
          x: 0.5, y: 0.285,
          xanchor: "center", yanchor: "bottom",
          text: "<b>Reactive Power and Average Voltage</b>",
          showarrow: false,
          font: { size: 10, color: textColor, family: "Helvetica, Arial, sans-serif" }
        },
        // Northwest Legend 1
        {
          xref: "paper", yref: "paper",
          x: 0.05, y: 0.94,
          xanchor: "left", yanchor: "top",
          showarrow: false,
          align: "left",
          text: `<span style="color:#0072BD; font-weight:bold;">━</span> P (POC) (MW)<br><span style="color:#D95319; font-weight:bold;">━</span> F (Hz)`,
          bgcolor: "#FFFFFF",
          bordercolor: "#CCCCCC",
          borderwidth: 1,
          borderpad: 4,
          font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor }
        },
        // Northwest Legend 2
        {
          xref: "paper", yref: "paper",
          x: 0.05, y: 0.60,
          xanchor: "left", yanchor: "top",
          showarrow: false,
          align: "left",
          text: result.pvs
            ? `<span style="color:#0072BD; font-weight:bold;">━</span> P (POC) (MW)<br><span style="color:#CC9900; font-weight:bold;">━</span> P (PV) (MW)<br><span style="color:#008000; font-weight:bold;">━</span> P (BESS) (MW)<br><span style="color:#D95319; font-weight:bold;">━</span> SOC (%)`
            : `<span style="color:#0072BD; font-weight:bold;">━</span> P (POC) (MW)<br><span style="color:#D95319; font-weight:bold;">━</span> SOC (%)`,
          bgcolor: "#FFFFFF",
          bordercolor: "#CCCCCC",
          borderwidth: 1,
          borderpad: 4,
          font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor }
        },
        // Northwest Legend 3
        {
          xref: "paper", yref: "paper",
          x: 0.05, y: 0.26,
          xanchor: "left", yanchor: "top",
          showarrow: false,
          align: "left",
          text: isSNTB
            ? `<span style="color:#CC0000; font-weight:bold;">━</span> Q (POC)<br><span style="color:#77AC30; font-weight:bold;">━</span> Vavg (kV)`
            : (hasSmart && result.smartLogger
                ? `<span style="color:#CC0000; font-weight:bold;">━</span> Q (POC) (MVar)<br><span style="color:#000000; font-weight:bold;">━</span> Q (BESS) (MVar)<br><span style="color:#0072BD; font-weight:bold;">━</span> Vavg (kV)`
                : `<span style="color:#CC0000; font-weight:bold;">━</span> Q (POC) (MVar)<br><span style="color:#0072BD; font-weight:bold;">━</span> Vavg (kV)`),
          bgcolor: "#FFFFFF",
          bordercolor: "#CCCCCC",
          borderwidth: 1,
          borderpad: 4,
          font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor }
        },
        // Northeast Subplot 2 Cycle Box
        ...(Number.isFinite(result.cycle.dailyAvg) && Number.isFinite(result.cycle.todayAvg) ? [
          {
            xref: "paper", yref: "paper",
            x: 0.93, y: 0.60,
            xanchor: "right", yanchor: "top",
            align: "left",
            showarrow: false,
            text: (() => {
              let formattedDate = result.dataDate;
              if (isSNTB && result.main.times.length > 0) {
                const firstDate = new Date(result.main.times[0]);
                try {
                  const day = firstDate.getDate();
                  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                  const month = monthNames[firstDate.getMonth()];
                  const year = firstDate.getFullYear();
                  formattedDate = `${month} ${day}, ${year}`;
                } catch (e) {}
              } else {
                try {
                  const firstDate = new Date(result.main.times[0]);
                  const pad = (n: number) => String(n).padStart(2, "0");
                  formattedDate = `${firstDate.getFullYear()}-${pad(firstDate.getMonth()+1)}-${pad(firstDate.getDate())}`;
                } catch (e) {}
              }
              return `Daily cycle (${formattedDate}):<br>  Cycle Plant Avg  =  ${result.cycle.dailyAvg.toFixed(3)}<br><br>Total cycle:<br>  Total Plant Avg  =  ${result.cycle.todayAvg.toFixed(3)}`;
            })(),
            bgcolor: "#FFFFFF",
            bordercolor: "#333333",
            borderwidth: 0.5,
            borderpad: 4,
            font: { family: "Helvetica, Arial, sans-serif", size: 8, color: textColor }
          }
        ] : []),
        // Rotated date footer
        {
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
          font: { family: "Helvetica, Arial, sans-serif", size: 9, color: textColor }
        }
      ]
    };

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

        layout.annotations.push({
          x: pt.xDisplay as any,
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
        } as any);
      });
    }

    return { data, layout };
  };

  const exportUnifiedHtml = async () => {
    if (!result) return;
    const now = new Date().toLocaleTimeString();
    const props = getUnifiedChartProps();
    if (!props) return;

    setExportProgress({
      active: true,
      total: 1,
      current: 0,
      name: "Compiling HTML template...",
      status: "exporting"
    });

    try {
      const fileName = `${profile.outputPrefix}_${result.dataDate}_Powerflow_Unified.html`;
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${profile.label} Daily Evaluation Dashboard - ${result.dataDate}</title>
  <script src="https://cdn.plot.ly/plotly-2.24.1.min.js"></script>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background-color: #f8fafc;
      font-family: Arial, sans-serif;
    }
    .container {
      display: flex;
      flex-direction: column;
      width: 96%;
      max-width: 1400px;
      height: 95%;
      margin: 20px auto;
      background: white;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #e2e8f0;
    }
    .chart-container {
      flex: 1;
      width: 100%;
      min-height: 800px;
    }
    #chart {
      flex: 1;
      width: 100%;
      min-height: 800px;
    }
    .header {
      padding: 15px 25px;
      background: #0f172a;
      color: white;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 {
      margin: 0;
      font-size: 16px;
      letter-spacing: 0.05em;
    }
    .header span {
      font-size: 12px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${profile.label} EVALUATION DASHBOARD</h1>
      <span>Date: ${result.dataDate} | Generated at: ${new Date().toLocaleString()}</span>
    </div>
    <div id="chart"></div>
  </div>
  <script>
    const data = ${JSON.stringify(props.data)};
    const layout = ${JSON.stringify(props.layout)};
    
    // Customize interactive layout properties for browser
    layout.autosize = true;
    
    Plotly.newPlot('chart', data, layout, { 
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['select2d', 'lasso2d']
    });
  </script>
</body>
</html>`;

      const base64Data = btoa(unescape(encodeURIComponent(htmlContent)));

      const subFolder = getTargetSubfolder() || outputFolder;
      if (window.electronAPI && subFolder && !subFolder.startsWith("(")) {
        const filePath = `${subFolder}/${fileName}`;
        const saveResult = await window.electronAPI.saveFile(filePath, base64Data);
        if (saveResult.ok) {
          setExportLog((prev) => [{ ts: now, file: filePath, status: "ok", message: "Saved HTML dashboard successfully" }, ...prev]);
          setExported((prev) => new Set(prev).add("unified-html"));
          setExportProgress(prev => ({ ...prev, current: 1, name: "✓ HTML dashboard saved successfully!", status: "success" }));
          setTimeout(() => setExportProgress(prev => ({ ...prev, active: false })), 1500);
        } else {
          setExportLog((prev) => [{ ts: now, file: fileName, status: "error", message: saveResult.error || "Failed to write file" }, ...prev]);
          setExportProgress(prev => ({ ...prev, active: false }));
        }
      } else {
        const blob = new Blob([htmlContent], { type: "text/html" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 200);
        
        setExportLog((prev) => [{ ts: now, file: fileName, status: "ok", message: "Downloaded HTML to browser" }, ...prev]);
        setExported((prev) => new Set(prev).add("unified-html"));
        setExportProgress(prev => ({ ...prev, current: 1, name: "✓ HTML downloaded successfully!", status: "success" }));
        setTimeout(() => setExportProgress(prev => ({ ...prev, active: false })), 1500);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportLog((prev) => [{ ts: now, file: "HTML Export", status: "error", message: msg }, ...prev]);
      setExportProgress(prev => ({ ...prev, active: false }));
    }
  };

  const exportUnifiedPng = async () => {
    if (!result) return;
    const now = new Date().toLocaleTimeString();
    
    setExportProgress({
      active: true,
      total: 1,
      current: 0,
      name: "Rendering Unified PNG...",
      status: "exporting"
    });

    const el = unifiedChartRef.current;
    if (!el) {
      setExportProgress(prev => ({ ...prev, active: false }));
      return;
    }

    const plotEl = el.querySelector(".js-plotly-plot") as HTMLElement | null;
    if (!plotEl) {
      setExportProgress(prev => ({ ...prev, active: false }));
      return;
    }

    try {
      const scaleNum = parseInt(scale, 10);
      const imgData = await (Plotly as any).toImage(plotEl, {
        format: "png",
        width: 1920,
        height: 1080,
        scale: scaleNum,
      });

      const base64 = imgData.split(",")[1];
      const fileName = `${profile.outputPrefix}_${result.dataDate}_Powerflow_Unified.png`;

      const subFolder = getTargetSubfolder() || outputFolder;
      if (window.electronAPI && subFolder && !subFolder.startsWith("(")) {
        const filePath = `${subFolder}/${fileName}`;
        const saveResult = await window.electronAPI.saveFile(filePath, base64);
        if (saveResult.ok) {
          setExportLog((prev) => [{ ts: now, file: filePath, status: "ok", message: "Saved Unified PNG successfully" }, ...prev]);
          setExported((prev) => new Set(prev).add("unified-png"));
          setExportProgress(prev => ({ ...prev, current: 1, name: "✓ Unified PNG saved successfully!", status: "success" }));
          setTimeout(() => setExportProgress(prev => ({ ...prev, active: false })), 1500);
        } else {
          setExportLog((prev) => [{ ts: now, file: fileName, status: "error", message: saveResult.error || "Unknown error" }, ...prev]);
          setExportProgress(prev => ({ ...prev, active: false }));
        }
      } else {
        const link = document.createElement("a");
        link.href = imgData;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => link.remove(), 200);
        
        setExportLog((prev) => [{ ts: now, file: fileName, status: "ok", message: "Downloaded PNG to browser" }, ...prev]);
        setExported((prev) => new Set(prev).add("unified-png"));
        setExportProgress(prev => ({ ...prev, current: 1, name: "✓ PNG downloaded successfully!", status: "success" }));
        setTimeout(() => setExportProgress(prev => ({ ...prev, active: false })), 1500);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportLog((prev) => [{ ts: now, file: "Unified PNG Export", status: "error", message: msg }, ...prev]);
      setExportProgress(prev => ({ ...prev, active: false }));
    }
  };

  const timeX = result ? result.main.times.map(formatTime) : [];

  const getChartProps = (chartId: string): { data: any[]; layout: any } | null => {
    if (!result) return null;
    const isDark = theme === "dark";
    const areaFillP = {
      fill: "tozeroy",
      fillcolor: isDark ? "rgba(0, 212, 255, 0.08)" : "rgba(37, 99, 235, 0.06)",
    };

    switch (chartId) {
      case "pf":
        return {
          data: [
            { x: timeX, y: result.main.pMw, type: "scatter", mode: "lines", name: "P (POC) (MW)", line: { color: getThemeColor("P (POC) (MW)", "#0072BD"), width: 2, shape: "hv" }, ...areaFillP },
            { x: timeX, y: result.main.frequency, type: "scatter", mode: "lines", name: "F (Hz)", yaxis: "y2", line: { color: getThemeColor("F (Hz)", "#D95319"), width: 1.5 } },
          ],
          layout: buildLayout(result, "Active Power and Frequency", "P (MW)", "F (Hz)", result.profile.powerRange, [49.7, 50.3], undefined, pinnedPoints, 1),
        };
      case "soc": {
        if (result.pvs) {
          const xp = result.pvs.times.map(formatTime);
          return {
            data: [
              { x: xp, y: result.pvs.pPccMw, type: "scatter", mode: "lines", name: "P (POC) (MW)", line: { color: getThemeColor("P (POC) (MW)", "#0072BD"), width: 1.8 } },
              { x: xp, y: result.pvs.pPvMw, type: "scatter", mode: "lines", name: "P (PV) (MW)", line: { color: getThemeColor("P (PV) (MW)", "#CC9900"), width: 1.5 } },
              { x: xp, y: result.pvs.pEssMw, type: "scatter", mode: "lines", name: "P (BESS) (MW)", line: { color: getThemeColor("P (BESS) (MW)", "#008000"), width: 1.5 } },
              { x: xp, y: result.pvs.socPct, type: "scatter", mode: "lines", name: "SOC (%)", yaxis: "y2", line: { color: getThemeColor("SOC (%)", "#D95319"), width: 1.8 } },
            ],
            layout: buildLayout(result, "Active Power and SOC", "P (MW)", "SOC (%)", result.profile.powerRange, [0, 100], cycleAnnotation(result), pinnedPoints, 2),
          };
        }
        return {
          data: [
            { x: timeX, y: result.main.pMw, type: "scatter", mode: "lines", name: "P (POC) (MW)", line: { color: getThemeColor("P (POC) (MW)", "#0072BD"), width: 1.8 } },
            { x: timeX, y: result.main.soc, type: "scatter", mode: "lines", name: "SOC (%)", yaxis: "y2", line: { color: getThemeColor("SOC (%)", "#D95319"), width: 1.8 } },
          ],
          layout: buildLayout(result, "Active Power and SOC", "P (MW)", "SOC (%)", result.profile.powerRange, [0, 100], cycleAnnotation(result), pinnedPoints, 2),
        };
      }
      case "qv":
        return {
          data: [
            { x: timeX, y: result.main.vab, type: "scatter", mode: "lines", name: "Vab", line: { color: getThemeColor("Vab", "#0072BD"), width: 1.5 } },
            { x: timeX, y: result.main.vbc, type: "scatter", mode: "lines", name: "Vbc", line: { color: getThemeColor("Vbc", "#77AC30"), width: 1.5 } },
            { x: timeX, y: result.main.vca, type: "scatter", mode: "lines", name: "Vca", line: { color: getThemeColor("Vca", "#7E2F8E"), width: 1.5 } },
            { x: timeX, y: result.main.qMvar, type: "scatter", mode: "lines", name: "Q (POC) (MVar)", yaxis: "y2", line: { color: getThemeColor("Q (POC) (MVar)", "#D95319"), width: 2, shape: "hv" } },
            ...(result.smartLogger ? [{
              x: result.smartLogger.times.map(formatTime),
              y: result.smartLogger.totalQMvar,
              type: "scatter", mode: "lines", name: "Q (BESS) (MVar)", yaxis: "y2", line: { color: getThemeColor("Q (BESS) (MVar)", "#000000"), width: 1.4, shape: "hv" },
            }] : []),
          ],
          layout: buildLayout(result, "Voltage vs Reactive Power", "Line Voltage (kV)", "Q (MVar)", undefined, result.profile.reactiveRange, undefined, pinnedPoints, 3),
        };
      case "vavg":
        const isSNTBVal = profile.label && profile.label.includes("SNTB");
        const vColorVal = isSNTBVal ? "#77AC30" : "#0072BD";
        const qColorVal = "#CC0000";
        return {
          data: [
            { x: timeX, y: result.main.vavg, type: "scatter", mode: "lines", name: "Vavg (kV)", line: { color: vColorVal, width: isSNTBVal ? 0.8 : 1.6 } },
            { x: timeX, y: result.main.qMvar, type: "scatter", mode: "lines", name: "Q (POC) (MVar)", yaxis: "y2", line: { color: qColorVal, width: 2, shape: "hv" } },
            ...(result.smartLogger ? [{
              x: result.smartLogger.times.map(formatTime),
              y: result.smartLogger.totalQMvar,
              type: "scatter", mode: "lines", name: "Q (BESS) (MVar)", yaxis: "y2", line: { color: getThemeColor("Q (BESS) (MVar)", "#000000"), width: 1.4, shape: "hv" },
            }] : []),
          ],
          layout: buildLayout(result, "Reactive Power and Average Voltage", "Vavg (kV)", "Q (MVar)", undefined, result.profile.reactiveRange, undefined, pinnedPoints, 3),
        };
      case "cycle":
        if (!result.cycle.timeline) return null;
        return {
          data: [{
            x: result.cycle.timeline.times.map(formatTime),
            y: result.cycle.timeline.avgCycles,
            type: "scatter", mode: "lines", name: "Average Equivalent Cycles", line: { color: getThemeColor("Average Equivalent Cycles", "#0072BD"), width: 2 },
          }],
          layout: buildLayout(result, "ESS Average Equivalent Cycle Timeline", "Average Cycles", "", undefined, undefined, undefined, pinnedPoints, 2),
        };
      case "smart":
        if (!result.smartLogger) return null;
        return {
          data: [
            { x: result.smartLogger.times.map(formatTime), y: result.smartLogger.totalPMw, type: "scatter", mode: "lines", name: "Total P (MW)", line: { color: getThemeColor("Total P (MW)", "#0072BD"), width: 2 } },
            { x: result.smartLogger.times.map(formatTime), y: result.smartLogger.totalQMvar, type: "scatter", mode: "lines", name: "Total Q (MVar)", yaxis: "y2", line: { color: getThemeColor("Total Q (MVar)", "#D95319"), width: 2 } },
          ],
          layout: buildLayout(result, "SmartLogger Summed Power", "P (MW)", "Q (MVar)", undefined, result.profile.reactiveRange, undefined, pinnedPoints, 3),
        };
      default:
        return null;
    }
  };

  return (
    <div className="flex-1 min-h-0 flex w-full h-full text-foreground select-none relative">
      
      {/* 1. Left Config Column inside sub-tab */}
      <aside className="w-80 border-r border-border-v bg-background/20 p-3 flex flex-col gap-3 overflow-y-auto shrink-0">
        
        {/* Output folder settings card */}
        <div className="bg-gradient-to-br from-[#8B5CF6]/5 to-[#3B82F6]/5 dark:from-[#8B5CF6]/10 dark:to-[#3B82F6]/10 border border-purple-500/20 rounded-md p-3">
          <div className="text-[10px] uppercase font-bold tracking-widest text-[#8B5CF6] dark:text-[#a78bfa] mb-2 flex items-center gap-1.5 font-mono">
            <FolderOpen size={12} />
            Output Folder
          </div>
          <Button
            onClick={handleSelectFolder}
            className="w-full h-8 text-[10px] font-bold bg-[#8B5CF6]/10 border border-[#8B5CF6]/30 text-[#8B5CF6] hover:bg-[#8B5CF6]/20 hover:text-purple-600 dark:bg-[#8B5CF6]/20 dark:text-purple-300 dark:hover:text-purple-200 dark:hover:bg-[#8B5CF6]/30 mb-2"
            variant="outline"
          >
            <FolderOpen size={12} />
            {outputFolder ? "Change Folder" : "Select Folder"}
          </Button>
          {outputFolder && (
            <div className="text-[9px] font-mono text-foreground/60 bg-background/50 rounded p-1.5 break-all leading-relaxed border border-border-v">
              {outputFolder}
            </div>
          )}
          {!hasElectronAPI && (
            <div className="text-[8px] text-yellow-600 dark:text-yellow-400 mt-1.5 font-mono">
              ⚠ Web browser mode — assets will save to your Downloads folder
            </div>
          )}
        </div>

        {/* MATLAB Export strictly configured */}

        {/* Live capture logs column */}
        {exportLog.length > 0 && (
          <div className="bg-surface/30 border border-border-v rounded-md p-3 flex-1 flex flex-col overflow-hidden">
            <div className="text-[9px] uppercase font-bold tracking-widest text-foreground/40 border-b border-border-v/50 pb-1.5 mb-2 font-mono">Export Log</div>
            <div className="flex-1 overflow-y-auto space-y-1.5 pr-0.5">
              {exportLog.map((entry, idx) => (
                <div key={idx} className={cn(
                  "text-[9px] font-mono leading-normal flex items-start gap-2 p-1.5 rounded-sm border border-border-v/30",
                  entry.status === "ok" ? "text-green-600 bg-green-500/5 dark:text-green-400/80 border-green-500/10" : "text-red-500 bg-red-500/5 dark:text-red-400/80 border-red-500/10"
                )}>
                  {entry.status === "ok" ? <CheckCircle2 size={11} className="shrink-0 mt-0.5" /> : <AlertTriangle size={11} className="shrink-0 mt-0.5" />}
                  <div className="min-w-0 flex-1">
                    <span className="text-foreground/30 font-semibold">[{entry.ts}]</span>{" "}
                    <span className="break-all font-mono">{entry.file}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* 2. Right grid capture columns inside sub-tab */}
      <main className="flex-1 min-w-0 flex flex-col bg-background/10 overflow-hidden">
        {result ? (
          <div className="flex-1 flex flex-col overflow-hidden h-full">
            {/* Top bulk exporter controls header bar */}
            <div className="px-4 py-2 border-b border-border-v bg-surface/30 flex items-center justify-between shrink-0 font-mono">
              <div className="flex items-center gap-3">
                <div className="text-[11px] font-bold uppercase tracking-wider text-foreground/75 flex items-center gap-1.5">
                  <span className="text-[#8B5CF6] font-bold">BATCH EXPORTER:</span>
                  <span className="bg-foreground/5 border border-border-v rounded px-1.5 py-0.5 text-[10px] text-foreground/60">{result.dayTag}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={exportUnifiedHtml}
                  disabled={exportingAll || (!outputFolder && hasElectronAPI)}
                  variant="outline"
                  className="border-[#8B5CF6]/30 text-[#8B5CF6] bg-[#8B5CF6]/5 hover:bg-[#8B5CF6]/15 h-7 text-[10px] font-bold flex items-center gap-1.5 px-3"
                >
                  <Download size={13} />
                  Export HTML Dashboard
                </Button>
                <Button
                  onClick={exportAll}
                  disabled={exportingAll || (!outputFolder && hasElectronAPI)}
                  className="bg-gradient-to-r from-[#8B5CF6] to-[#3B82F6] text-white hover:opacity-90 h-7 text-[10px] font-bold flex items-center gap-1.5 px-4 shadow-md shadow-purple-500/10 border-0"
                >
                  {exportingAll ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  Export MATLAB (.fig)
                </Button>
              </div>
            </div>

            {/* Grid or Unified view of export cards */}
            <div className="flex-1 p-4 overflow-y-auto">
              {/* Unified 3-Subplot View */}
              <div className="flex flex-col gap-4 max-w-5xl mx-auto">
                <div className="border border-purple-500/20 bg-surface/30 rounded-lg p-4 shadow-lg flex flex-col">
                  <div className="flex items-center justify-between border-b border-border-v/50 pb-2 mb-4 font-mono">
                    <div className="flex items-center gap-2">
                      <Activity size={18} className="text-[#8B5CF6]" />
                      <span className="text-[11px] uppercase font-bold tracking-widest text-foreground">
                        Unified Power Flow Dashboard (3-Subplots)
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-foreground/50">
                        Interactive Plotly preview aligned with MATLAB layout
                      </span>
                    </div>
                  </div>

                  {/* Aligned 3-Subplot Plot */}
                  <div
                    ref={unifiedChartRef}
                    className="bg-white border rounded-lg overflow-hidden flex flex-col p-4 shadow-inner"
                    style={{ minHeight: "850px" }}
                  >
                    {getUnifiedChartProps() && (
                      <Plot
                        data={getUnifiedChartProps()!.data}
                        layout={getUnifiedChartProps()!.layout}
                        useResizeHandler
                        style={{ width: "100%", height: "800px" }}
                        config={{ 
                          responsive: true,
                          displaylogo: false,
                          modeBarButtonsToRemove: ['select2d', 'lasso2d']
                        }}
                        onClick={(e) => handlePlotClick(e)}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Empty state when result is null */
          <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-y-auto">
            <div className="max-w-md w-full text-center flex flex-col items-center">
              <div className="relative inline-block mb-4">
                <div className="h-16 w-16 rounded-xl bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-purple-500/30 flex items-center justify-center text-purple-500">
                  <ImageIcon size={30} className="animate-pulse" />
                </div>
                <div className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center text-green-400">
                  <Download size={12} />
                </div>
              </div>
              <div className="text-[12px] font-bold uppercase tracking-widest text-foreground font-mono">Export Center Ready</div>
              <p className="text-[10px] text-foreground/50 leading-relaxed mt-2 font-mono max-w-xs">
                To activate capture cards, load the project datasets in the left sidebar and click the blue <span className="text-accent-blue font-bold">RUN</span> button to calculate telemetry.
              </p>
              
              <div className="flex items-center gap-1 text-[8px] uppercase tracking-widest text-foreground/35 mt-6 font-mono font-bold">
                <span>Ingest files</span> <ArrowRight size={10} /> <span>Click Run</span> <ArrowRight size={10} /> <span>Batch Save PNG/FIG</span>
              </div>

              {detectedSubfolders.length > 0 && (
                <div className="w-full mt-6 bg-[#152033]/40 border border-purple-500/20 rounded-lg p-3 text-left">
                  <div className="text-[10px] uppercase font-bold tracking-widest text-[#8B5CF6] dark:text-[#a78bfa] mb-2 flex items-center justify-between font-mono">
                    <span>📂 Detected Output Folders</span>
                    {scanning && <Loader2 size={10} className="animate-spin" />}
                  </div>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                    {detectedSubfolders.map((dir) => (
                      <div key={dir} className="flex items-center justify-between p-2 rounded bg-background/50 hover:bg-background/80 border border-border-v/50 transition-colors">
                        <span className="text-[10px] font-mono text-foreground/80 truncate flex-1 pr-2" title={dir}>
                          {dir}
                        </span>
                        <Button
                          onClick={() => handleLoadSubfolder(dir)}
                          className="h-6 text-[9px] font-bold bg-[#8B5CF6]/20 border border-[#8B5CF6]/35 text-[#8B5CF6] hover:bg-[#8B5CF6]/35 font-mono px-2 py-0 shrink-0 cursor-pointer"
                          variant="outline"
                        >
                          Load Result
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* 3. PREMIUM ANIMATED EXPORT OVERLAY DIALOG */}
      {exportProgress.active && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#0B0F19]/40 backdrop-blur-sm transition-all duration-300">
          <div className={cn(
            "w-96 rounded-lg border p-6 flex flex-col items-center gap-4 shadow-2xl transition-all duration-300 transform scale-100",
            theme === "dark" 
              ? "bg-[#152033] border-slate-700 text-white" 
              : "bg-white border-slate-200 text-slate-800"
          )}>
            {/* Holographic icon container */}
            <div className="relative w-16 h-16">
              <div className={cn(
                "absolute inset-0 rounded-full blur-lg opacity-40 animate-pulse",
                exportProgress.status === "success" ? "bg-green-500" : "bg-[#8B5CF6]"
              )} />
              
              {exportProgress.status === "success" ? (
                <div className="w-full h-full rounded-full border-2 border-green-500 bg-green-500/10 flex items-center justify-center text-green-500">
                  <CheckCircle2 size={28} className="animate-[scaleIn_0.3s_ease-out]" />
                </div>
              ) : (
                <div className="w-full h-full rounded-full border-2 border-dashed border-[#8B5CF6] bg-purple-500/5 flex items-center justify-center text-[#8B5CF6] animate-spin-slow">
                  <Download size={24} className="animate-pulse" />
                </div>
              )}
            </div>

            {/* Step Label */}
            <div className="text-[10px] uppercase font-bold tracking-widest text-foreground/40 font-mono">
              {exportProgress.status === "success" ? "Export Complete" : "Exporting Assets"}
            </div>

            {/* Action details */}
            <div className="text-[11px] font-mono font-bold text-center h-8 flex items-center justify-center max-w-xs px-2 select-text">
              {exportProgress.name}
            </div>

            {/* Percentage Bar */}
            <div className="w-full mt-1">
              <div className="h-2 w-full rounded-full bg-foreground/10 overflow-hidden relative border border-border-v/10">
                <div 
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    exportProgress.status === "success" 
                      ? "bg-green-500" 
                      : "bg-gradient-to-r from-[#8B5CF6] to-[#3B82F6]"
                  )}
                  style={{ width: `${(exportProgress.current / exportProgress.total) * 100}%` }}
                />
              </div>
              <div className="flex justify-between text-[8px] font-mono mt-1 text-foreground/45">
                <span>{Math.round((exportProgress.current / exportProgress.total) * 100)}%</span>
                <span>{exportProgress.current} / {exportProgress.total} plots</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Standard Chart Layout Builder ───────────────────────────────────────── */
function buildLayout(
  result: Ess20Result, title: string, y1Title: string, y2Title: string,
  y1Range?: [number, number], y2Range?: [number, number], annotations?: any[],
  pinnedPoints?: PinnedPoint[], subplot?: number
): any {
  const isDark = document.documentElement.classList.contains("dark");
  const paperBg = isDark ? "#0B1220" : "#FFFFFF";
  const plotBg = isDark ? "#0B1220" : "#FFFFFF";
  const gridColor = isDark ? "rgba(255, 255, 255, 0.05)" : "#E5E7EB";
  const textColor = isDark ? "#F8FAFC" : "#000000";
  const linecolor = isDark ? "rgba(0, 212, 255, 0.3)" : "#000000";

  let y1Color = "#0072BD";
  let y2Color = "#D95319";

  if (isDark) {
    if (y1Title.includes("P") || y1Title.includes("Cycles") || y1Title.includes("Vab") || y1Title.includes("Voltage") || y1Title.includes("Vavg")) {
      y1Color = "#00D4FF"; // Cyber Cyan
    }
    if (y2Title.includes("F") || y2Title.includes("Q") || y2Title.includes("SOC")) {
      y2Color = "#FF9F43"; // Vibrant Amber
    }
  } else {
    y1Color = "#2563EB"; // Royal Blue
    y2Color = "#EA580C"; // Warm Orange
  }

  const baseAnnotations = annotations?.map(a => ({
    ...a,
    font: { ...a.font, color: textColor, family: "JetBrains Mono, monospace" },
    bgcolor: isDark ? "#111827" : "#FFFFFF",
    bordercolor: isDark ? "rgba(0, 212, 255, 0.2)" : "#333333",
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
    title: { text: `<b>${title}</b>`, font: { family: "JetBrains Mono, monospace", size: 11, color: textColor }, x: 0.5 },
    autosize: true,
    margin: { t: 42, r: y2Title ? 62 : 28, l: 62, b: 42 },
    paper_bgcolor: paperBg,
    plot_bgcolor: plotBg,
    font: { family: "JetBrains Mono, monospace", size: 8, color: textColor },
    xaxis: {
      showgrid: true, gridcolor: gridColor, linecolor: linecolor,
      mirror: true, tickangle: -45, tickfont: { size: 8, color: textColor, family: "JetBrains Mono, monospace" },
    },
    yaxis: {
      title: { text: `<b>${y1Title}</b>`, font: { color: y1Color, size: 9, family: "JetBrains Mono, monospace" } },
      tickfont: { color: y1Color, size: 8, family: "JetBrains Mono, monospace" },
      showgrid: true, gridcolor: gridColor, linecolor: linecolor,
      mirror: true, zeroline: false,
      ...(y1Range ? { range: y1Range } : {}),
      ...(result.profile.powerTicks.length && y1Title === "P (MW)" ? { tickvals: result.profile.powerTicks } : {}),
    },
    ...(y2Title ? {
      yaxis2: {
        title: { text: `<b>${y2Title}</b>`, font: { color: y2Color, size: 9, family: "JetBrains Mono, monospace" } },
        tickfont: { color: y2Color, size: 8, family: "JetBrains Mono, monospace" },
        overlaying: "y", side: "right",
        showgrid: false, mirror: false, linecolor: linecolor, zeroline: false,
        ...(y2Range ? { range: y2Range } : {}),
        ...(y2Title.includes("Q") ? { tickvals: result.profile.reactiveTicks } : {}),
      },
    } : {}),
    showlegend: true,
    legend: {
      x: 0.99, y: 0.99, xanchor: "right", yanchor: "top",
      bgcolor: isDark ? "rgba(17, 24, 39, 0.85)" : "rgba(255,255,255,0.85)",
      bordercolor: isDark ? "rgba(0, 212, 255, 0.2)" : "#D1D5DB",
      borderwidth: 1,
      font: { size: 8, color: textColor, family: "JetBrains Mono, monospace" },
    },
    annotations: baseAnnotations.concat(extraAnnotations),
  };
}

function cycleAnnotation(result: Ess20Result) {
  if (!Number.isFinite(result.cycle.dailyAvg) || !Number.isFinite(result.cycle.todayAvg)) return undefined;
  const isDark = document.documentElement.classList.contains("dark");
  const textColor = isDark ? "#F8FAFC" : "#000000";
  return [{
    xref: "paper", yref: "paper", x: 0.98, y: 0.96,
    xanchor: "right", yanchor: "top", align: "left", showarrow: false,
    text: `Daily cycle (${result.dataDate}):<br>Cycle Plant Avg = ${fmtVal(result.cycle.dailyAvg, 3)}<br><br>Total cycle:<br>Total Plant Avg = ${fmtVal(result.cycle.todayAvg, 3)}`,
    bgcolor: isDark ? "#111827" : "#FFFFFF",
    bordercolor: isDark ? "rgba(0, 212, 255, 0.2)" : "#333333",
    borderwidth: 1,
    borderpad: 4,
    font: { family: "JetBrains Mono, monospace", size: 9, color: textColor },
  }];
}

function fmtVal(v: number, d: number) {
  return Number.isFinite(v) ? v.toFixed(d) : "--";
}
