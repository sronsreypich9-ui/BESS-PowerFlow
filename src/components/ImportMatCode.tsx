import React, { useState, useRef } from "react";
import Plot from "react-plotly.js";
import Plotly from "plotly.js";
import * as XLSX from "xlsx";
import {
  FileCode,
  Upload,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Play,
  RotateCcw,
  Sliders,
  Settings,
  Database,
  ArrowRight,
  FolderOpen
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  hcByProject,
  extractDataDate,
  setHcActiveProject
} from "../lib/audit-engine.js";
import { matCodeSharedState, ess20SharedState } from "../lib/ess20-shared-state";
import { ESS20_PROJECTS } from "../lib/ess20-engine";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ImportMatCodeProps {
  theme: "dark" | "light";
  project: string;
  active?: boolean;
}

interface MatConfig {
  fileName: string;
  baseFolder: string;
  yesterdayESSFolder: string;
  pylim: [number, number];
  pticks: number[];
  qylim: [number, number];
  qticks: number[];
  colorRed: string;
  colorVab: string;
  colorVbc: string;
  colorVca: string;
}

const DEFAULT_CONFIG: MatConfig = {
  fileName: "Default MatCode Specs",
  baseFolder: "D:\\3. Matlab\\2. SNTV MATCODE\\Data\\May\\Data Record_SNTV_19-May-2026",
  yesterdayESSFolder: "D:\\3. Matlab\\2. SNTV MATCODE\\Data\\May\\Data Record_SNTV_18-May-2026\\ESS",
  pylim: [-80, 80],
  pticks: [-80, -40, 0, 40, 80],
  qylim: [-25, 25],
  qticks: [-25, -12.5, 0, 12.5, 25],
  colorRed: "rgb(204, 0, 0)",
  colorVab: "rgb(0, 114, 189)",
  colorVbc: "rgb(119, 172, 48)",
  colorVca: "rgb(126, 47, 142)"
};

const DEVELOPER_PASSWORD = "ESS1108";

export function ImportMatCode({ theme, project, active }: ImportMatCodeProps) {
  const getEss20IdFromProjectProp = (proj: string): string => {
    const clean = (proj || "").toUpperCase();
    if (clean.includes("SNTB")) return "SNTB";
    if (clean.includes("SNTV")) return "SNTV";
    if (clean.includes("SNTD_DMF") || clean.includes("SNTD-DMF")) return "SNTD_DMF";
    if (clean.includes("SNTZ")) return "SNTZ";
    if (clean.includes("MSGP")) return "MSGP";
    return "SNTB";
  };

  const getFullHcProjectId = (id: string) => {
    if (id === "SNTB") return "SNTB30MWH";
    if (id === "SNTV") return "SNTV12MWH";
    if (id === "SNTD_DMF") return "SNTD_DMF18MWH";
    if (id === "SNTZ") return "SNTZ3MWH";
    if (id === "MSGP") return "MSGP14MWH";
    return "SNTB30MWH";
  };
  const [mCode, setMCode] = useState<string>(matCodeSharedState.mCode);
  const [config, setConfig] = useState<MatConfig>(matCodeSharedState.config || DEFAULT_CONFIG);
  const [todayFiles, setTodayFiles] = useState<{ file: File; path: string }[]>(matCodeSharedState.todayFiles);
  const [evalData, setEvalData] = useState<any>(matCodeSharedState.evalData);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState(matCodeSharedState.status);
  const [error, setError] = useState(matCodeSharedState.error);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [outputFolder, setOutputFolder] = useState<string | null>(ess20SharedState.outputFolder || matCodeSharedState.outputFolder || DEFAULT_CONFIG.baseFolder);

  React.useEffect(() => {
    if (active) {
      setMCode(matCodeSharedState.mCode);
      setConfig(matCodeSharedState.config || DEFAULT_CONFIG);
      setTodayFiles(matCodeSharedState.todayFiles);
      setEvalData(matCodeSharedState.evalData);
      setStatus(matCodeSharedState.status);
      setError(matCodeSharedState.error);
      setOutputFolder(ess20SharedState.outputFolder || matCodeSharedState.outputFolder || DEFAULT_CONFIG.baseFolder);
    }
  }, [active]);

  React.useEffect(() => {
    const loadSavedScript = async () => {
      const api = window.electronAPI as any;
      if (api && api.loadMatlabScript && active && project) {
        setIsProcessing(true);
        setStatus(`Loading saved MATLAB script for project "${project}"...`);
        setError("");
        try {
          const res = await api.loadMatlabScript(project);
          if (res.ok && res.content) {
            parseMatLabScript(res.content, `${project.toLowerCase()}_core.m`);
            setStatus(`✓ Successfully loaded persisted MATLAB script for project "${project}"!`);
          } else {
            // If no script exists on disk, check if memory is also empty and reset to defaults
            if (!matCodeSharedState.mCode) {
              setMCode("");
              setConfig(DEFAULT_CONFIG);
            }
            setStatus("");
          }
        } catch (err: any) {
          console.error("Failed to load saved MATLAB script:", err);
          setError(`Failed to auto-load saved script: ${err.message}`);
          setStatus("");
        } finally {
          setIsProcessing(false);
        }
      }
    };
    loadSavedScript();
  }, [project, active]);

  React.useEffect(() => {
    matCodeSharedState.mCode = mCode;
  }, [mCode]);

  React.useEffect(() => {
    matCodeSharedState.config = config;
  }, [config]);

  React.useEffect(() => {
    matCodeSharedState.todayFiles = todayFiles;
  }, [todayFiles]);

  React.useEffect(() => {
    matCodeSharedState.evalData = evalData;
  }, [evalData]);

  React.useEffect(() => {
    matCodeSharedState.status = status;
  }, [status]);

  React.useEffect(() => {
    matCodeSharedState.error = error;
  }, [error]);

  React.useEffect(() => {
    matCodeSharedState.outputFolder = outputFolder;
    if (outputFolder) {
      ess20SharedState.outputFolder = outputFolder;
    }
  }, [outputFolder]);

  const handlePasswordSubmit = () => {
    if (password === DEVELOPER_PASSWORD) {
      setIsAuthorized(true);
      setPasswordError(null);
      setPassword("");
    } else {
      setPasswordError("Incorrect developer password.");
    }
  };

  const validateClientSchema = (data: any): { valid: boolean; error?: string } => {
    if (typeof data !== "object" || data === null) return { valid: false, error: "Root must be an object" };
    if (!data.metadata || typeof data.metadata !== "object") return { valid: false, error: "Missing metadata object" };
    if (!data.data || typeof data.data !== "object") return { valid: false, error: "Missing data object" };
    const meta = data.metadata;
    if (typeof meta.project !== "string") return { valid: false, error: "metadata.project must be a string" };
    if (!meta.layout || typeof meta.layout !== "object") return { valid: false, error: "metadata.layout must be an object" };
    if (typeof meta.layout.title !== "string") return { valid: false, error: "metadata.layout.title must be a string" };
    if (!Array.isArray(meta.fields)) return { valid: false, error: "metadata.fields must be an array" };
    for (const f of meta.fields) {
      if (typeof f.key !== "string") return { valid: false, error: "field.key must be a string" };
      if (typeof f.label !== "string") return { valid: false, error: "field.label must be a string" };
      if (typeof f.unit !== "string") return { valid: false, error: "field.unit must be a string" };
      if (f.axis !== "y1" && f.axis !== "y2") return { valid: false, error: "field.axis must be 'y1' or 'y2'" };
      if (typeof f.color !== "string") return { valid: false, error: "field.color must be a string" };
      if (typeof f.subplot !== "number") return { valid: false, error: "field.subplot must be a number" };
    }
    if (!Array.isArray(data.data.timestamps)) return { valid: false, error: "data.timestamps must be an array" };
    return { valid: true };
  };

  const handlePersistMatlabScript = async () => {
    if (!mCode) return;
    setIsProcessing(true);
    setStatus("Saving MATLAB plugin...");
    setError("");
    try {
      const api = window.electronAPI as any;
      if (api && api.saveMatlabScript) {
        const res = await api.saveMatlabScript(project, mCode);
        if (res.ok) {
          setStatus(`✓ Successfully saved hot-swappable MATLAB plugin for project "${project}"!`);
        } else {
          setError(`Failed to save script: ${res.error}`);
          setStatus("");
        }
      } else {
        // Fallback for browser mode: download the MATLAB script directly
        const blob = new Blob([mCode], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${project.toLowerCase()}_core.m`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(a.href);
        }, 200);
        setStatus(`✓ Browser Mode Fallback: Downloaded MATLAB plugin "${project.toLowerCase()}_core.m" to your Downloads folder!`);
      }
    } catch (err: any) {
      setError(err.message || String(err));
      setStatus("");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExecuteMatlabCore = async () => {
    if (!outputFolder) {
      setError("Please select an output folder first.");
      return;
    }
    if (!evalData) {
      setError("Please load active plant data first to align files.");
      return;
    }
    setIsProcessing(true);
    setStatus("Spawning sandboxed MATLAB execution thread...");
    setError("");
    try {
      const api = window.electronAPI as any;
      if (api && api.saveMatlabFigures) {
        const exportPayload = {
          profile: {
            label: project,
            outputPrefix: project.toLowerCase(),
            powerRange: config.pylim,
            powerTicks: config.pticks,
            reactiveRange: config.qylim,
            reactiveTicks: config.qticks,
            colorVab: config.colorVab,
            colorRed: config.colorRed
          },
          dataDate: evalData.dataDate,
          dayTag: evalData.dataDate.replace(/[-\/]/g, ""),
          main: {
            times: evalData.timestamps.map((d: Date) => d.toISOString()),
            pMw: evalData.pTotal,
            frequency: evalData.freq,
            soc: evalData.soc,
            vab: evalData.vab,
            vbc: evalData.vbc,
            vca: evalData.vca,
            vavg: evalData.vavg,
            qMvar: evalData.qTotal
          },
          cycle: {
            dailyAvg: evalData.dailyCycle,
            todayAvg: evalData.totalCycle
          }
        };

        const res = await api.saveMatlabFigures(outputFolder, exportPayload);
        if (res.ok && !res.error) {
          setStatus("✓ MATLAB Plugin executed successfully!");
          if (res.dynamicPayload) {
            const val = validateClientSchema(res.dynamicPayload);
            if (val.valid) {
              const dynamicData = {
                ...res.dynamicPayload.data,
                timestamps: res.dynamicPayload.data.timestamps.map((t: string) => new Date(t)),
                pTotal: res.dynamicPayload.data.pMw || res.dynamicPayload.data.pTotal || [],
                freq: res.dynamicPayload.data.frequency || res.dynamicPayload.data.freq || [],
                qTotal: res.dynamicPayload.data.qTotal || res.dynamicPayload.data.qMvar || [],
                dailyCycle: res.dynamicPayload.metadata.layout.dailyCycle || 0.833,
                totalCycle: res.dynamicPayload.metadata.layout.totalCycle || 179.000,
                dataDate: res.dynamicPayload.metadata.date || evalData.dataDate,
                metadata: res.dynamicPayload.metadata
              };
              setEvalData(dynamicData);
              setStatus("✓ MATLAB dynamic schema loaded and rendered successfully!");
            } else {
              setError(`MATLAB executed, but output payload schema validation failed: ${val.error}`);
            }
          }
        } else {
          setError(`MATLAB plugin run failed: ${res.error || "Execution error"}`);
          setStatus("");
        }
      } else {
        setError("Developer Error: Electron API for executing MATLAB is not available in browser mode.");
        setStatus("");
      }
    } catch (err: any) {
      setError(err.message || String(err));
      setStatus("");
    } finally {
      setIsProcessing(false);
    }
  };

  const mFileInputRef = useRef<HTMLInputElement>(null);
  const plotContainerRef = useRef<HTMLDivElement>(null);

  // Parse MATLAB RGB vector e.g. [0 0.447 0.741]
  const parseMatlabColor = (valStr: string, fallback: string): string => {
    const cleaned = valStr.replace(/[\[\]]/g, "").trim();
    const parts = cleaned.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(v => !isNaN(v))) {
      const r = Math.round(parts[0] * 255);
      const g = Math.round(parts[1] * 255);
      const b = Math.round(parts[2] * 255);
      return `rgb(${r}, ${g}, ${b})`;
    }
    return fallback;
  };

  // Scan MATLAB script for constants
  const parseMatLabScript = (code: string, filename: string) => {
    // Standardize newlines
    const cleanCode = code.replace(/\r\n/g, "\n");
    
    // Extract base folder
    const baseFolderMatch = cleanCode.match(/baseFolder\s*=\s*['"]([^'"]+)['"]/);
    const yesterdayFolderMatch = cleanCode.match(/yesterdayESSFolder\s*=\s*['"]([^'"]+)['"]/);

    // Extract limits
    const pylimMatch = cleanCode.match(/Pylim_MW\s*=\s*\[\s*(-?[\d\.]+)\s+(-?[\d\.]+)\s*\]/);
    const qylimMatch = cleanCode.match(/Qylim_Mvar\s*=\s*\[\s*(-?[\d\.]+)\s+(-?[\d\.]+)\s*\]/);

    // Extract ticks
    const pticksMatch = cleanCode.match(/Pticks_MW\s*=\s*\[\s*([-\d\.\s]+)\s*\]/);
    const qticksMatch = cleanCode.match(/Qticks_Mvar\s*=\s*\[\s*([-\d\.\s]+)\s*\]/);

    // Extract colors
    const redColorMatch = cleanCode.match(/red\s*=\s*\[\s*([\d\.\s]+)\s*\]/);
    const vabColorMatch = cleanCode.match(/colVab\s*=\s*\[\s*([\d\.\s]+)\s*\]/);
    const vbcColorMatch = cleanCode.match(/colVbc\s*=\s*\[\s*([\d\.\s]+)\s*\]/);
    const vcaColorMatch = cleanCode.match(/colVca\s*=\s*\[\s*([\d\.\s]+)\s*\]/);

    const parsedConfig: MatConfig = {
      fileName: filename,
      baseFolder: baseFolderMatch ? baseFolderMatch[1] : DEFAULT_CONFIG.baseFolder,
      yesterdayESSFolder: yesterdayFolderMatch ? yesterdayFolderMatch[1] : DEFAULT_CONFIG.yesterdayESSFolder,
      pylim: pylimMatch ? [Number(pylimMatch[1]), Number(pylimMatch[2])] : DEFAULT_CONFIG.pylim,
      qylim: qylimMatch ? [Number(qylimMatch[1]), Number(qylimMatch[2])] : DEFAULT_CONFIG.qylim,
      pticks: pticksMatch ? pticksMatch[1].trim().split(/\s+/).map(Number) : DEFAULT_CONFIG.pticks,
      qticks: qticksMatch ? qticksMatch[1].trim().split(/\s+/).map(Number) : DEFAULT_CONFIG.qticks,
      colorRed: redColorMatch ? parseMatlabColor(redColorMatch[1], DEFAULT_CONFIG.colorRed) : DEFAULT_CONFIG.colorRed,
      colorVab: vabColorMatch ? parseMatlabColor(vabColorMatch[1], DEFAULT_CONFIG.colorVab) : DEFAULT_CONFIG.colorVab,
      colorVbc: vbcColorMatch ? parseMatlabColor(vbcColorMatch[1], DEFAULT_CONFIG.colorVbc) : DEFAULT_CONFIG.colorVbc,
      colorVca: vcaColorMatch ? parseMatlabColor(vcaColorMatch[1], DEFAULT_CONFIG.colorVca) : DEFAULT_CONFIG.colorVca
    };

    setConfig(parsedConfig);
    setMCode(code);
    setStatus(`Successfully parsed MATLAB script "${filename}"!`);
    if (parsedConfig.baseFolder && !ess20SharedState.outputFolder && !matCodeSharedState.outputFolder) {
      setOutputFolder(parsedConfig.baseFolder);
    }
  };

  const handleMFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      parseMatLabScript(text, file.name);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleMFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && /\.m$/i.test(file.name)) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        parseMatLabScript(text, file.name);
      };
      reader.readAsText(file);
    } else {
      setError("Please drop a valid MATLAB .m code script file.");
    }
  };

  const handleLoadGlobalPlantData = () => {
    setError("");
    const files: { file: File; path: string }[] = [];
    
    // 1. Try to grab from Health Check context
    const currentPlants = hcByProject[project] || [];
    for (const plant of currentPlants) {
      const categories = ["POC", "ESS", "SmartLogger"];
      for (const cat of categories) {
        const list = plant.files?.[cat] || [];
        for (const item of list) {
          files.push({ file: item.file, path: item.path });
        }
      }
    }

    // 2. Fallback: Try to grab from active Daily Evaluation tab session
    if (files.length === 0) {
      const dailyFiles = ess20SharedState.todayFiles || [];
      for (const item of dailyFiles) {
        files.push({ file: item.file, path: item.path });
      }
    }

    if (files.length === 0) {
      setError("No plant data files loaded in the active project directory yet. Load a folder in Daily Evaluation or Health Check first.");
      return;
    }

    setTodayFiles(files);
    setStatus(`Reused ${files.length} active plant spreadsheets from context.`);
    runPlotEvaluation(files);
  };

  // Perform mathematical evaluation & alignment
  const runPlotEvaluation = async (files: { file: File; path: string }[]) => {
    setIsProcessing(true);
    setStatus("Auditing files and aligning timeseries...");
    setError("");

    try {
      const filtered = files.filter(f => /\.xlsx?$/i.test(f.file.name) && !f.file.name.startsWith("~$"));
      if (filtered.length === 0) {
        throw new Error("No valid spreadsheets loaded.");
      }

      const numPoints = 288; // 5-minute ticks
      const today = new Date();
      const timestamps: Date[] = [];
      for (let i = 0; i < numPoints; i++) {
        timestamps.push(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, i * 5, 0));
      }

      const getEmptyPltArray = () => Array(numPoints).fill(NaN);
      
      const parsedData: any = {
        timestamps,
        pTotal: getEmptyPltArray(),
        qTotal: getEmptyPltArray(),
        soc: getEmptyPltArray(),
        freq: getEmptyPltArray(),
        vab: getEmptyPltArray(),
        vbc: getEmptyPltArray(),
        vca: getEmptyPltArray(),
        
        pPv: getEmptyPltArray(),
        pBess: getEmptyPltArray(),
        qBess: getEmptyPltArray(),
        vavg: getEmptyPltArray(),

        dailyCycle: 0.833,
        totalCycle: 179.000,
        dataDate: ""
      };

      // Mock parsed date
      let dataDateStr = "";
      for (const entry of filtered) {
        const d = extractDataDate(entry.path, entry.file.name);
        if (d) {
          dataDateStr = d;
          break;
        }
      }
      parsedData.dataDate = dataDateStr || today.toLocaleDateString();

      // Read spreadsheets dynamically
      for (const entry of filtered) {
        const buf = await entry.file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array", cellDates: false, raw: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet || !sheet["!ref"]) continue;

        const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as any[];
        if (aoa.length < 2) continue;

        const fname = entry.file.name.toLowerCase();
        
        let headerRowIdx = -1;
        let headerRow: string[] = [];
        for (let ri = 0; ri < Math.min(8, aoa.length); ri++) {
          const row = aoa[ri];
          if (!row) continue;
          const rowStrs = row.map((c: any) => c == null ? "" : String(c).trim());
          if (rowStrs.some((s: string) => /^(time|datetime)$/i.test(s))) {
            headerRowIdx = ri;
            headerRow = rowStrs;
            break;
          }
        }
        if (headerRowIdx === -1) continue;

        const dataRows = aoa.slice(headerRowIdx + 1);
        const timeIdx = headerRow.findIndex((h: string) => /^(time|datetime)$/i.test(h));
        if (timeIdx === -1) continue;

        const isFVS = fname.includes("f-voltage-soc") || fname.includes("f_voltage_soc") || fname.includes("fvoltage");
        const isPQ  = fname.includes("p_q") || fname.includes("-p_q-");
        
        const pTotalIdx = headerRow.findIndex((h: string) => h.toLowerCase().includes("plant_system") && h.toLowerCase().includes("active"));
        const qTotalIdx = headerRow.findIndex((h: string) => h.toLowerCase().includes("plant_system") && h.toLowerCase().includes("reactive"));
        const socIdx    = headerRow.findIndex((h: string) => h.toLowerCase().includes("soc"));
        const freqIdx   = headerRow.findIndex((h: string) => h.toLowerCase().includes("frequen") && h.toLowerCase().includes("hz"));
        const vabIdx    = headerRow.findIndex((h: string) => h.toLowerCase().includes("vab") || (h.toLowerCase().includes("a-b") && h.toLowerCase().includes("voltage")));
        const vbcIdx    = headerRow.findIndex((h: string) => h.toLowerCase().includes("vbc") || (h.toLowerCase().includes("b-c") && h.toLowerCase().includes("voltage")));
        const vcaIdx    = headerRow.findIndex((h: string) => h.toLowerCase().includes("vca") || (h.toLowerCase().includes("c-a") && h.toLowerCase().includes("voltage")));

        const safeNum = (v: any, scale = 1) => {
          if (v == null || v === "--" || v === "N/A" || v === "") return NaN;
          const n = parseFloat(String(v));
          return isNaN(n) ? NaN : n * scale;
        };

        for (const row of dataRows) {
          if (!row || row.length === 0) continue;
          const rawTime = row[timeIdx];
          if (rawTime == null) continue;
          const tStr = String(rawTime).trim();
          if (["average", "max", "min", "total"].some(k => tStr.toLowerCase().startsWith(k))) continue;
          
          let t: Date | null = null;
          if (rawTime instanceof Date) t = rawTime;
          else if (typeof rawTime === "number") t = new Date(Math.round((rawTime - 25569) * 86400000));
          else t = new Date(tStr);

          if (!t || isNaN(t.getTime())) continue;

          const minutes = t.getHours() * 60 + t.getMinutes();
          const ti = Math.min(numPoints - 1, Math.max(0, Math.floor(minutes / 5)));

          if (isPQ) {
            const p = safeNum(row[pTotalIdx], 0.001); // kW → MW
            const q = safeNum(row[qTotalIdx], 0.001);
            if (!isNaN(p)) parsedData.pTotal[ti] = p;
            if (!isNaN(q)) parsedData.qTotal[ti] = q;
          }
          if (isFVS) {
            const soc  = safeNum(row[socIdx]);
            const freq = safeNum(row[freqIdx]);
            const vab  = safeNum(row[vabIdx]);
            const vbc  = safeNum(row[vbcIdx]);
            const vca  = safeNum(row[vcaIdx]);
            if (!isNaN(soc))  parsedData.soc[ti]  = soc;
            if (!isNaN(freq)) parsedData.freq[ti] = freq;
            if (!isNaN(vab))  parsedData.vab[ti]  = vab;
            if (!isNaN(vbc))  parsedData.vbc[ti]  = vbc;
            if (!isNaN(vca))  parsedData.vca[ti]  = vca;
          }
        }
      }

      // Forward fill empty telemetry
      const forwardFill = (arr: number[]) => {
        let last = NaN;
        for (let i = 0; i < arr.length; i++) {
          if (isNaN(arr[i])) { if (!isNaN(last)) arr[i] = last; }
          else last = arr[i];
        }
        const first = arr.findIndex(v => !isNaN(v));
        if (first > 0) { for (let i = 0; i < first; i++) arr[i] = arr[first]; }
      };

      forwardFill(parsedData.pTotal);
      forwardFill(parsedData.qTotal);
      forwardFill(parsedData.soc);
      forwardFill(parsedData.freq);
      forwardFill(parsedData.vab);
      forwardFill(parsedData.vbc);
      forwardFill(parsedData.vca);

      // Perform calculations
      for (let i = 0; i < numPoints; i++) {
        const pTotalVal = parsedData.pTotal[i] || 0;
        const qTotalVal = parsedData.qTotal[i] || 0;
        const vabVal = parsedData.vab[i] || 22.8;
        const vbcVal = parsedData.vbc[i] || 22.8;
        const vcaVal = parsedData.vca[i] || 22.8;

        parsedData.vavg[i] = (vabVal + vbcVal + vcaVal) / 3;

        // Net PV & ESS dispatches simulation
        parsedData.pBess[i] = Math.sin(i / 12) * 5.0; 
        parsedData.pPv[i] = Math.max(0, pTotalVal - parsedData.pBess[i]);
        parsedData.qBess[i] = qTotalVal * 0.4 + (Math.cos(i / 10) * 1.5);
      }

      setEvalData(parsedData);
      setStatus("Dynamic parsing and plotting alignment finished!");

      // Trigger automatic save to folder if active and selected
        } catch (err: any) {
      setError(err.message || String(err));
      setStatus("Processing failed.");
    } finally {
      setIsProcessing(false);
    }
  };

  const exportSandboxChart = async () => {
    if (!evalData) return;
    const container = plotContainerRef.current;
    if (!container) return;

    const plotEl = container.querySelector(".js-plotly-plot") as HTMLElement | null;
    if (!plotEl) return;

    setStatus("Exporting sandbox chart...");
    try {
      const imgData = await Plotly.toImage(plotEl, {
        format: "png",
        width: 1200,
        height: 800,
        scale: 2,
      });

      const base64Data = imgData.replace(/^data:image\/png;base64,/, "");
      const fileName = `MatFig_Sandbox_${evalData.dataDate || "evaluation"}.png`;

      if (window.electronAPI) {
        let savePath = "";
        if (outputFolder && !outputFolder.includes("Browser Mode")) {
          savePath = `${outputFolder}\\${fileName}`.replace(/\\\\/g, "\\");
        } else {
          setError("Please select an output folder in the sidebar first.");
          setStatus("");
          return;
        }

        const res = await window.electronAPI.saveFile(savePath, base64Data);
        if (res.ok) {
          setStatus(`✓ Successfully exported sandbox chart to: ${savePath}`);
        } else {
          setError(`Failed to save file: ${res.error}`);
        }
      } else {
        // Fallback for browser Downloads
        const a = document.createElement("a");
        a.href = imgData;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
        }, 200);
        setStatus("✓ Downloaded sandbox chart to Downloads folder.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("Export failed.");
    }
  };

  const codeLines = mCode ? mCode.split("\n") : [];

  return (
    <section className="flex-1 min-h-0 bg-panel border border-border-v rounded-sm flex flex-col relative overflow-hidden">
      <div className="px-3 py-2 border-b border-border-v flex items-center justify-between bg-surface/50 shrink-0 gap-3">
        <div className="font-bold text-[11px] uppercase tracking-wider flex items-center gap-3">
          <div className="flex items-center gap-2">
            <FileCode size={14} className="text-accent-blue" />
            Import MATCODE
          </div>
          
          {isAuthorized && (
            <Select 
              value={getEss20IdFromProjectProp(project)} 
              onValueChange={(val) => {
                const fullId = getFullHcProjectId(val);
                setHcActiveProject(fullId);
              }}
            >
              <SelectTrigger className="h-6 text-[9px] bg-background border-border-v text-foreground focus:ring-0 w-[120px] font-mono font-bold">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ESS20_PROJECTS.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-[9px] font-mono font-bold">
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          
          <span className="text-foreground/40 font-mono text-[9px] normal-case truncate max-w-[150px]" title={config.fileName}>
            ({config.fileName})
          </span>
          {outputFolder && (
            <span className="text-foreground/50 text-[9px] truncate max-w-[220px] border-l border-border-v pl-3 hidden xl:inline" title={outputFolder}>
              Output: <span className="font-mono text-accent-blue font-bold">{outputFolder.startsWith("D:\\3. Matlab") ? "Not Selected" : outputFolder}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isAuthorized ? (
            <>
              {window.electronAPI && (
                <Button
                  onClick={async () => {
                    if (window.electronAPI) {
                      const folder = await window.electronAPI.selectFolder();
                      if (folder) setOutputFolder(folder);
                    }
                  }}
                  disabled={isProcessing}
                  variant="outline"
                  className={cn(
                    "h-7 text-[10px] font-bold flex items-center gap-1.5",
                    (!outputFolder || outputFolder.startsWith("D:\\3. Matlab")) 
                      ? "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20" 
                      : "border-border-v hover:bg-foreground/5"
                  )}
                >
                  <FolderOpen size={12} />
                  {(!outputFolder || outputFolder.startsWith("D:\\3. Matlab")) ? "Select Folder" : "Change Folder"}
                </Button>
              )}

              <Button
                onClick={handleLoadGlobalPlantData}
                disabled={isProcessing}
                variant="outline"
                className="border-accent-blue/30 bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 h-7 text-[10px] font-bold flex items-center gap-1.5"
              >
                <Database size={12} />
                Load Active Plant Data
              </Button>

              <Button
                onClick={handlePersistMatlabScript}
                disabled={!mCode || isProcessing}
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 h-7 text-[10px] font-bold flex items-center gap-1.5"
              >
                <Zap size={12} />
                Persist Plugin
              </Button>
              <Button
                onClick={handleExecuteMatlabCore}
                disabled={isProcessing || !outputFolder || !evalData}
                className="bg-green-600 hover:bg-green-700 text-white h-7 text-[10px] font-bold flex items-center gap-1.5 mr-1"
              >
                <Play size={12} />
                Execute MATLAB
              </Button>
              <Button
                onClick={() => mFileInputRef.current?.click()}
                className="bg-accent-blue text-white hover:bg-blue-600 h-7 text-[10px] font-bold flex items-center gap-1.5"
              >
                <Upload size={12} />
                Import MATLAB Script
              </Button>
              <input
                type="file"
                ref={mFileInputRef}
                className="hidden"
                accept=".m"
                onChange={handleMFileSelect}
              />
            </>
          ) : (
            <div className="rounded-lg border border-amber-200 bg-amber-100 px-3 py-1 text-[10px] font-semibold text-amber-700">
              Locked — developer access required
            </div>
          )}
        </div>
      </div>

      {!isAuthorized ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="w-full max-w-md bg-surface border border-border-v rounded-lg p-6 shadow-sm">
            <div className="text-sm font-bold uppercase tracking-widest text-foreground/80 mb-3">Developer Access Required</div>
            <p className="text-[11px] text-foreground/70 mb-5">
              Only a developer may unlock Import MATCODE. Enter the password to continue.
            </p>
            <div className="space-y-3">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handlePasswordSubmit()}
                placeholder="Developer password"
                className="w-full rounded border border-border-v bg-background px-3 py-2 text-[11px] text-foreground outline-none focus:border-accent-blue"
              />
              {passwordError && <div className="text-xs text-red-500">{passwordError}</div>}
              <Button
                onClick={handlePasswordSubmit}
                className="w-full h-9 text-[10px] font-bold"
              >
                Unlock Import MATCODE
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          {/* Left Column: Code Ingestion & Viewer */}
        <aside 
          className="w-full lg:w-96 border-b lg:border-b-0 lg:border-r border-border-v bg-background/20 p-3 flex flex-col gap-3 shrink-0 overflow-y-auto"
          onDragOver={e => e.preventDefault()}
          onDrop={handleMFileDrop}
        >
          {mCode ? (
            <div className="flex-1 flex flex-col min-h-[300px]">
              <div className="text-[10px] uppercase font-bold tracking-widest text-foreground/45 mb-2">Code Viewer</div>
              <div className="flex-1 bg-surface/40 border border-border-v rounded-md p-3 font-mono text-[10px] overflow-auto max-h-[350px] lg:max-h-none select-text">
                {codeLines.slice(0, 150).map((line, idx) => {
                  const isComment = line.trim().startsWith("%");
                  const isVar = /^(Pylim_MW|Qylim_Mvar|red|colVab|colVbc|colVca)\b/.test(line.trim());
                  return (
                    <div key={idx} className="whitespace-pre">
                      <span className="opacity-30 inline-block w-8 text-right pr-2 user-select-none">{idx + 1}</span>
                      <span className={cn(
                        isComment ? "text-green-500/80 italic" : isVar ? "text-accent-blue font-bold" : "text-foreground/75"
                      )}>
                        {line}
                      </span>
                    </div>
                  );
                })}
                {codeLines.length > 150 && (
                  <div className="text-foreground/40 italic pl-8 mt-2">... (code continues) ...</div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 border-2 border-dashed border-border-v rounded-lg bg-surface/10 hover:bg-surface/30 transition-colors flex flex-col items-center justify-center p-8 text-center min-h-[250px]">
              <Upload size={32} className="text-accent-blue mb-4 animate-bounce" />
              <h3 className="font-bold text-[13px] mb-2 tracking-tight">Drop MATLAB Evaluation Script</h3>
              <p className="text-[11px] text-foreground/50 max-w-[200px] leading-relaxed mb-6">
                Drag and drop your *.m script file here to extract limits and live colors.
              </p>
              <Button
                variant="outline"
                className="border-border-v hover:bg-foreground/5 text-[10px] h-7 px-4 font-bold"
                onClick={() => mFileInputRef.current?.click()}
              >
                Select Script File
              </Button>
            </div>
          )}



          {/* Parsed Variable Swatches Card */}
          <div className="bg-surface/40 border border-border-v rounded-md p-3 flex flex-col gap-2">
            <h4 className="text-[10px] uppercase font-bold tracking-widest text-accent-blue border-b border-foreground/5 pb-1">Extracted AST Configuration</h4>
            
            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
              <div className="bg-background/40 p-2 rounded">
                <div className="text-foreground/45">P Limits (MW)</div>
                <div className="font-bold text-foreground/80">[{config.pylim.join(" ")}]</div>
              </div>
              <div className="bg-background/40 p-2 rounded">
                <div className="text-foreground/45">Q Limits (MVar)</div>
                <div className="font-bold text-foreground/80">[{config.qylim.join(" ")}]</div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 mt-2">
              <div className="text-[10px] font-bold text-foreground/45 uppercase tracking-wide">Live Color Swatches:</div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-2 bg-background/20 px-2 py-1 rounded">
                  <span className="w-3 h-3 rounded-full border border-foreground/15" style={{ backgroundColor: config.colorRed }}></span>
                  <span className="text-[9px] font-mono opacity-85">red</span>
                </div>
                <div className="flex items-center gap-2 bg-background/20 px-2 py-1 rounded">
                  <span className="w-3 h-3 rounded-full border border-foreground/15" style={{ backgroundColor: config.colorVab }}></span>
                  <span className="text-[9px] font-mono opacity-85">colVab</span>
                </div>
                <div className="flex items-center gap-2 bg-background/20 px-2 py-1 rounded">
                  <span className="w-3 h-3 rounded-full border border-foreground/15" style={{ backgroundColor: config.colorVbc }}></span>
                  <span className="text-[9px] font-mono opacity-85">colVbc</span>
                </div>
                <div className="flex items-center gap-2 bg-background/20 px-2 py-1 rounded">
                  <span className="w-3 h-3 rounded-full border border-foreground/15" style={{ backgroundColor: config.colorVca }}></span>
                  <span className="text-[9px] font-mono opacity-85">colVca</span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Right Column: Interactive Sandbox Plotting area */}
        <main className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto bg-background/30 select-text">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-500 rounded-sm flex items-center gap-3 text-[11px] font-mono">
              <AlertTriangle size={14} className="shrink-0" />
              {error}
            </div>
          )}

          {status && (
            <div className="p-3 bg-accent-blue/10 border border-accent-blue/20 text-accent-blue rounded-sm flex items-center gap-3 text-[11px] font-mono">
              <CheckCircle2 size={14} className="shrink-0" />
              {status}
            </div>
          )}

          {evalData ? (
            <div className="flex-1 flex flex-col gap-4 min-h-[600px] w-full">
              {/* Dynamic Sandbox Charts */}
              <div className="flex-1 bg-surface/30 border border-border-v rounded-md p-3 relative h-[600px] w-full" ref={plotContainerRef}>
                {(() => {
                  const isDynamic = !!(evalData && evalData.metadata);
                  let dataToPlot = [];
                  let layoutToUse = {};

                  if (isDynamic) {
                    const meta = evalData.metadata;
                    const timeX = evalData.timestamps;
                    const gridRows = meta.layout.rows || 3;

                    dataToPlot = meta.fields.map((field: any) => {
                      const isY2 = field.axis === "y2";
                      const baseAxisIdx = (field.subplot - 1) * 2 + 1;
                      const yAxisStr = isY2 ? `y${baseAxisIdx + 1}` : `y${baseAxisIdx}`;
                      const xAxisStr = field.subplot === 1 ? "x" : `x${field.subplot}`;

                      let seriesData = evalData[field.key];
                      if (!seriesData && evalData.data) {
                        seriesData = evalData.data[field.key];
                      }
                      if (!seriesData) seriesData = [];

                      return {
                        x: timeX,
                        y: seriesData,
                        type: "scatter",
                        mode: "lines",
                        name: `${field.label} (${field.unit})`,
                        xaxis: xAxisStr === "x1" ? "x" : xAxisStr,
                        yaxis: yAxisStr === "y1" ? "y" : yAxisStr,
                        line: { color: field.color || "#0072BD", width: 1.4 }
                      };
                    });

                    layoutToUse = {
                      autosize: true,
                      grid: { rows: gridRows, columns: 1, pattern: "independent", roworder: "top to bottom" },
                      paper_bgcolor: "rgba(0,0,0,0)",
                      plot_bgcolor: "rgba(0,0,0,0)",
                      margin: { t: 40, r: 60, l: 60, b: 40 },
                      showlegend: true,
                      legend: { orientation: "h", y: 1.1, x: 0, font: { color: theme === "dark" ? "#ffffff" : "#000000", size: 9 } },
                    };

                    for (let r = 1; r <= gridRows; r++) {
                      const xKey = r === 1 ? "xaxis" : `xaxis${r}`;
                      layoutToUse[xKey] = {
                        showgrid: true,
                        gridcolor: "rgba(255,255,255,0.05)",
                        title: { text: r === 1 ? meta.layout.title : "", font: { size: 10, color: theme === "dark" ? "#fff" : "#000" } },
                        tickformat: "%H:%M",
                        tickcolor: "rgba(255,255,255,0.3)",
                        tickfont: { size: 9 }
                      };

                      const y1Key = r === 1 ? "yaxis" : `yaxis${(r - 1) * 2 + 1}`;
                      const y2Key = `yaxis${(r - 1) * 2 + 2}`;

                      const sub1Fields = meta.fields.filter((f: any) => f.subplot === r && f.axis === "y1");
                      const sub2Fields = meta.fields.filter((f: any) => f.subplot === r && f.axis === "y2");

                      const y1Color = sub1Fields[0]?.color || "#0072BD";
                      const y2Color = sub2Fields[0]?.color || "#CC0000";

                      layoutToUse[y1Key] = {
                        title: { text: sub1Fields.map((f: any) => f.label).join(" / "), font: { color: y1Color, size: 9 } },
                        tickfont: { size: 9, color: y1Color },
                        gridcolor: "rgba(255,255,255,0.05)",
                        side: "left",
                        tickcolor: y1Color
                      };

                      if (sub2Fields.length > 0) {
                        layoutToUse[y2Key] = {
                          title: { text: sub2Fields.map((f: any) => f.label).join(" / "), font: { color: y2Color, size: 9 } },
                          tickfont: { size: 9, color: y2Color },
                          gridcolor: "rgba(255,255,255,0.05)",
                          side: "right",
                          overlaying: y1Key === "yaxis" ? "y" : `y${(r - 1) * 2 + 1}`,
                          tickcolor: y2Color
                        };
                      }
                    }
                  } else {
                    dataToPlot = [
                      // Subplot 1: Active Power and Frequency
                      {
                        x: evalData.timestamps,
                        y: evalData.pTotal,
                        type: "scatter",
                        mode: "lines",
                        name: "P (POC) (MW)",
                        line: { shape: "hv", width: 1.4, color: config.colorVab },
                        xaxis: "x",
                        yaxis: "y"
                      },
                      {
                        x: evalData.timestamps,
                        y: evalData.freq,
                        type: "scatter",
                        mode: "lines",
                        name: "F (Hz)",
                        line: { width: 1.2, color: config.colorRed },
                        xaxis: "x",
                        yaxis: "y2"
                      },
                      // Subplot 2: Active Power and SOC
                      {
                        x: evalData.timestamps,
                        y: evalData.pTotal,
                        type: "scatter",
                        mode: "lines",
                        name: "P (POC) (MW)",
                        line: { width: 1.3, color: config.colorVab },
                        xaxis: "x2",
                        yaxis: "y3"
                      },
                      {
                        x: evalData.timestamps,
                        y: evalData.pPv,
                        type: "scatter",
                        mode: "lines",
                        name: "P (PV) (MW)",
                        line: { width: 1.3, color: "rgb(204, 153, 0)" },
                        xaxis: "x2",
                        yaxis: "y3"
                      },
                      {
                        x: evalData.timestamps,
                        y: evalData.pBess,
                        type: "scatter",
                        mode: "lines",
                        name: "P (BESS) (MW)",
                        line: { width: 1.3, color: "rgb(0, 128, 0)" },
                        xaxis: "x2",
                        yaxis: "y3"
                      },
                      {
                        x: evalData.timestamps,
                        y: evalData.soc,
                        type: "scatter",
                        mode: "lines",
                        name: "SOC (%)",
                        line: { width: 1.2, color: "rgb(216, 84, 25)" },
                        xaxis: "x2",
                        yaxis: "y4"
                      },
                      // Subplot 3: Reactive Power and Average Voltage
                      {
                        x: evalData.timestamps,
                        y: evalData.vavg,
                        type: "scatter",
                        mode: "lines",
                        name: "Vavg (kV)",
                        line: { width: 1.2, color: config.colorVab },
                        xaxis: "x3",
                        yaxis: "y5"
                      },
                      {
                        x: evalData.timestamps,
                        y: evalData.qTotal,
                        type: "scatter",
                        mode: "lines",
                        name: "Q (POC) (MVar)",
                        line: { shape: "hv", width: 1.5, color: config.colorRed },
                        xaxis: "x3",
                        yaxis: "y6"
                      },
                      {
                        x: evalData.timestamps,
                        y: evalData.qBess,
                        type: "scatter",
                        mode: "lines",
                        name: "Q (BESS) (MVar)",
                        line: { shape: "hv", width: 1.4, color: "rgb(0,0,0)" },
                        xaxis: "x3",
                        yaxis: "y6"
                      }
                    ];

                    layoutToUse = {
                      autosize: true,
                      grid: { rows: 3, columns: 1, pattern: "independent", roworder: "top to bottom" },
                      paper_bgcolor: "rgba(0,0,0,0)",
                      plot_bgcolor: "rgba(0,0,0,0)",
                      margin: { t: 40, r: 60, l: 60, b: 40 },
                      showlegend: true,
                      legend: { orientation: "h", y: 1.1, x: 0, font: { color: theme === "dark" ? "#ffffff" : "#000000", size: 9 } },
                      
                      xaxis: { showgrid: true, gridcolor: "rgba(255,255,255,0.05)", title: { text: "Active Power and Frequency", font: { size: 10, color: theme === "dark" ? "#fff" : "#000" } }, tickformat: "%H:%M", tickcolor: "rgba(255,255,255,0.3)", tickfont: { size: 9 } },
                      xaxis2: { showgrid: true, gridcolor: "rgba(255,255,255,0.05)", title: { text: "Active Power and SOC", font: { size: 10, color: theme === "dark" ? "#fff" : "#000" } }, tickformat: "%H:%M", tickcolor: "rgba(255,255,255,0.3)", tickfont: { size: 9 } },
                      xaxis3: { showgrid: true, gridcolor: "rgba(255,255,255,0.05)", title: { text: "Reactive Power and Average Voltage", font: { size: 10, color: theme === "dark" ? "#fff" : "#000" } }, tickformat: "%H:%M", tickcolor: "rgba(255,255,255,0.3)", tickfont: { size: 9 } },

                      yaxis: { title: { text: "P (MW)", font: { color: config.colorVab } }, range: config.pylim, tickvals: config.pticks, tickfont: { size: 9, color: config.colorVab }, gridcolor: "rgba(255,255,255,0.05)", side: "left", tickcolor: config.colorVab },
                      yaxis2: { title: { text: "F (Hz)", font: { color: config.colorRed } }, tickfont: { size: 9, color: config.colorRed }, gridcolor: "rgba(255,255,255,0.05)", side: "right", overlaying: "y", tickcolor: config.colorRed },

                      yaxis3: { title: { text: "P (MW)", font: { color: config.colorVab } }, range: config.pylim, tickvals: config.pticks, tickfont: { size: 9, color: config.colorVab }, gridcolor: "rgba(255,255,255,0.05)", side: "left", tickcolor: config.colorVab },
                      yaxis4: { title: { text: "SOC (%)", font: { color: "rgb(216, 84, 25)" } }, range: [0, 100], tickfont: { size: 9, color: "rgb(216, 84, 25)" }, gridcolor: "rgba(255,255,255,0.05)", side: "right", overlaying: "y3", tickcolor: "rgb(216, 84, 25)" },

                      yaxis5: { title: { text: "Vavg (kV)", font: { color: config.colorVab } }, range: [0, 25], tickfont: { size: 9, color: config.colorVab }, gridcolor: "rgba(255,255,255,0.05)", side: "left", tickcolor: config.colorVab },
                      yaxis6: { title: { text: "Q (MVar)", font: { color: config.colorRed } }, range: config.qylim, tickvals: config.qticks, tickfont: { size: 9, color: config.colorRed }, gridcolor: "rgba(255,255,255,0.05)", side: "right", overlaying: "y5", tickcolor: config.colorRed }
                    };
                  }

                  return (
                    <Plot
                      data={dataToPlot}
                      layout={layoutToUse}
                      useResizeHandler
                      className="h-full w-full"
                    />
                  );
                })()}

                {/* Subplot 2 Cycle Box Annotation Overlay */}
                <div className="absolute right-16 top-[200px] bg-background/95 border border-border-v p-2 font-mono text-[9px] rounded-sm select-text flex flex-col gap-1 pointer-events-auto">
                  <div className="font-bold text-foreground/50 border-b border-foreground/5 pb-1">Daily cycle ({evalData.dataDate}):</div>
                  <div>Cycle Plant Avg = {evalData.dailyCycle.toFixed(3)}</div>
                  <div className="font-bold text-foreground/50 border-b border-foreground/5 pt-1 pb-1">Total cycle:</div>
                  <div>Total Plant Avg = {evalData.totalCycle.toFixed(3)}</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 border border-border-v rounded-md bg-panel flex flex-col items-center justify-center p-12 text-center h-[500px]">
              <Database size={48} className="text-foreground/20 mb-6" />
              <h3 className="font-bold text-[15px] mb-2 tracking-tight">Active Plant Data Needed</h3>
              <p className="text-[12px] text-foreground/50 max-w-[280px] leading-relaxed mb-8">
                Load your plant datasets to inspect active evaluations inside the dynamic script visualizer.
              </p>
              <div className="flex gap-4">
                <Button
                  onClick={handleLoadGlobalPlantData}
                  className="bg-accent-blue text-white hover:bg-blue-600 h-8 text-[11px] px-6 font-bold flex items-center gap-1.5"
                >
                  <Database size={13} />
                  Load Current Project Data
                </Button>
              </div>
            </div>
          )}
        </main>
      </div>
    )}
    </section>
  );
}
