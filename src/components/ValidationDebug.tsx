import React, { useState, useRef } from "react";
import { GridFormingResponseAnimation } from "./GridFormingResponseAnimation";
import { 
  Activity, 
  Upload, 
  FileSpreadsheet,
  CheckCircle2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  hcBulkImport,
  hcAcceptFiles,
  hcRunExport,
  getHcBusy,
  hcForceStop,
  hcResetActiveProject,
  expandZip,
  getHcActiveProject,
  hcByProject,
  HC_CATS,
} from "../lib/audit-engine.js";

function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

interface ValidationDebugProps {
  progress: { pct: number; active: boolean; label: string };
  setProgress: React.Dispatch<React.SetStateAction<{ pct: number; active: boolean; label: string }>>;
}

export function ValidationDebug({ progress, setProgress }: ValidationDebugProps) {
  const project = getHcActiveProject();
  const currentPlants = hcByProject[project] || [];
  
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; size: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<{ file: File; path: string }[]>([]);

  const isRunning = getHcBusy() || progress.active;

  const showUploadSuccess = () => {
    setUploadMessage("Folder data successfully uploaded and validated!");
    setTimeout(() => setUploadMessage(""), 5000);
  };

  const [isDragging, setIsDragging] = useState(false);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  // Helper to resolve webkit entry recursive file tree traversal
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

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!e.dataTransfer.files) return;
    setUploadMessage("Unpacking dropped archives...");
    
    try {
      const filesArray = await getFilesFromDataTransfer(e.dataTransfer);
      
      // Expand any archives (zip/rar/7z) in the dropped files
      const expanded: { file: File; path: string }[] = [];
      for (const item of filesArray) {
        if (/\.(zip|rar|7z)$/i.test(item.file.name)) {
          try {
            const inner = await expandZip(item.file, item.path);
            expanded.push(...inner);
          } catch (err) {
            console.error("Error expanding archive:", err);
          }
        } else {
          expanded.push(item);
        }
      }

      const filesList = expanded.slice(0, 15).map((f) => ({
        name: f.path || f.file.name,
        size: formatBytes(f.file.size),
      }));
      if (expanded.length > 15) {
        filesList.push({
          name: `... and ${expanded.length - 15} more files`,
          size: "",
        });
      }
      setUploadedFiles(filesList);
      setPendingFiles(expanded);
      
      setUploadMessage("Files dropped and unpacked! Click RUN to start audit.");
      setTimeout(() => setUploadMessage(""), 5000);
    } catch (err: any) {
      setUploadMessage(`Error: Failed to process dropped items: ${err.message || String(err)}`);
    }
  };

  return (
    <section className="flex-1 bg-panel border border-border-v rounded-sm flex flex-col relative overflow-hidden h-full min-h-[600px]">
      {progress.active && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-md flex flex-col items-center justify-center z-50 transition-all duration-300">
          <div className="bg-surface/90 border border-border-v/50 rounded-xl p-8 max-w-md w-full shadow-2xl flex flex-col items-center gap-6">
            <div className="relative w-16 h-16">
              <div className="absolute inset-0 rounded-full border-4 border-accent-blue/10"></div>
              <div className="absolute inset-0 rounded-full border-4 border-t-accent-blue animate-spin"></div>
            </div>
            
            <div className="text-center space-y-2">
              <h3 className="font-bold text-foreground text-xs tracking-wider uppercase font-mono">{progress.label}</h3>
              <p className="text-[10px] text-foreground/50 font-mono">Do not refresh or close this tab.</p>
            </div>

            <div className="w-full space-y-2">
              <div className="w-full bg-foreground/5 h-2 rounded-full overflow-hidden border border-border-v/30">
                <div 
                  className="bg-accent-blue h-full transition-all duration-300 ease-out shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                  style={{ width: `${progress.pct}%` }}
                ></div>
              </div>
              <div className="flex justify-between text-[9px] font-mono text-foreground/40">
                <span>{progress.pct.toFixed(0)}% COMPLETE</span>
                <span>STATUS: ACTIVE</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden h-full">
         <div className="flex-1 overflow-y-auto p-4 bg-panel space-y-6 select-text h-full">
            {currentPlants.length === 0 ? (
              <div className="flex items-center justify-center h-full text-foreground/30 font-mono text-[12px] uppercase tracking-widest">
                No Plants Found for Selected Project
              </div>
            ) : currentPlants.map(plant => {
              const totalFiles = HC_CATS.reduce((s, c) => s + (plant.files[c.key]?.length || 0), 0);
              
              return (
                <div key={plant.id} className="bg-surface border border-border-v rounded-lg p-4 shadow-sm flex flex-col">
                  {/* Plant Header */}
                  <div className="flex items-center gap-4 mb-4 border-b border-border-v/50 pb-3">
                    <div className="font-bold text-[14px] text-foreground tracking-wide bg-background/50 px-3 py-1 rounded border border-border-v">
                      {plant.name}
                    </div>
                    <div className="text-[11px] text-foreground/50 ml-auto font-mono">
                      {totalFiles} files
                    </div>
                  </div>
                  
                  {/* Category Grid */}
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {HC_CATS.map(cat => {
                      const list = plant.files[cat.key] || [];
                      const expected = plant.expected?.[cat.key];
                      const okC = list.filter(r => r.report?.status === "ok").length;
                      const wC  = list.filter(r => r.report?.status === "warning").length;
                      const cC  = list.filter(r => r.report?.status === "critical").length;
                      
                      return (
                        <div key={cat.key} className="border border-border-v bg-background/30 rounded-md p-3 flex flex-col">
                          {/* Category Header */}
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <span className="text-[12px] font-bold text-foreground/80">{cat.label}</span>
                            <span className={cn(
                              "text-[10px] px-2 py-0.5 rounded font-mono border",
                              expected && list.length < expected ? "bg-red-500/10 text-red-400 border-red-500/20" :
                              expected && list.length > expected ? "bg-yellow-400/10 text-yellow-400 border-yellow-500/20" :
                              "bg-surface text-foreground/60 border-border-v"
                            )}>
                              {list.length} {expected ? `/ ${expected}` : ""} files {expected && list.length < expected ? `- short ${expected - list.length}` : ""}
                            </span>
                            
                            {/* Status Badges */}
                            <div className="ml-auto flex gap-1">
                              {okC > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 font-mono">✓ {okC}</span>}
                              {wC > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-400/10 text-yellow-400 font-mono">⚠ {wC}</span>}
                              {cC > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 font-mono">✗ {cC}</span>}
                            </div>
                          </div>
                          
                          {/* Dropzone & Reference */}
                          <div className="flex items-stretch gap-2 h-20 mb-2">
                            <label 
                              className={cn(
                                "flex-1 border-2 border-dashed rounded bg-accent-blue/5 hover:bg-accent-blue/10 border-accent-blue/30 hover:border-accent-blue/60 transition-colors flex flex-col items-center justify-center cursor-pointer text-[11px] text-accent-blue font-mono"
                              )}
                              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("bg-accent-blue/20"); }}
                              onDragLeave={(e) => { e.preventDefault(); e.currentTarget.classList.remove("bg-accent-blue/20"); }}
                              onDrop={async (e) => {
                                e.preventDefault();
                                e.currentTarget.classList.remove("bg-accent-blue/20");
                                if (!e.dataTransfer.files) return;
                                const filesArray = await getFilesFromDataTransfer(e.dataTransfer);
                                await hcAcceptFiles(plant, cat, filesArray);
                                showUploadSuccess();
                              }}
                            >
                              <span>Drop {cat.label} xlsx (or click)</span>
                              <input type="file" multiple className="hidden" accept=".xlsx,.xls" onChange={async (e) => {
                                if (!e.target.files) return;
                                const filesArray = Array.from(e.target.files).map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
                                e.target.value = "";
                                await hcAcceptFiles(plant, cat, filesArray);
                                showUploadSuccess();
                              }}/>
                            </label>
                            
                            <div className="w-36 shrink-0 bg-surface border border-border-v rounded flex flex-col p-1.5 relative overflow-hidden">
                              <span className="text-[7px] uppercase font-bold text-foreground/40 mb-1 tracking-wider">Filename Example</span>
                              <div className="flex-1 flex flex-col items-center justify-center text-center opacity-70">
                                <FileSpreadsheet size={20} className="text-green-500/70 mb-1" />
                                <div className="text-[8px] font-mono leading-tight max-w-full overflow-hidden text-ellipsis px-1">
                                  {cat.examples ? cat.examples[0] : "example_file.xlsx"}
                                </div>
                              </div>
                            </div>
                          </div>
                          
                          {/* File List */}
                          <div className="flex-1 bg-surface/50 rounded border border-border-v/50 p-2 overflow-y-auto max-h-32 text-[10px] font-mono scrollbar-thin">
                            {list.length === 0 ? (
                              <div className="text-center text-foreground/30 py-2">no files yet</div>
                            ) : (
                              <div className="space-y-1">
                                {list.map((fileEntry: any, i: number) => {
                                  const status = fileEntry.report?.status;
                                  const isCritical = status === "critical";
                                  const isWarning = status === "warning";
                                  const isOk = status === "ok";
                                  
                                  return (
                                    <div key={i} className={cn(
                                      "flex items-center gap-2 p-1 rounded",
                                      isCritical ? "bg-red-500/10 text-red-400" :
                                      isWarning ? "bg-yellow-400/10 text-yellow-400" :
                                      isOk ? "text-foreground/80" : "text-foreground/60"
                                    )}>
                                      <div className="w-4 text-center">
                                        {isCritical ? "✗" : isWarning ? "⚠" : isOk ? "✓" : "•"}
                                      </div>
                                      <div className="flex-1 truncate font-bold" title={fileEntry.path}>{fileEntry.path.split("/").pop()}</div>
                                      {fileEntry.report?.reasons?.length > 0 && (
                                        <div className="text-[9px] opacity-70 truncate max-w-[120px]">
                                          {fileEntry.report.reasons[0]}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Auto-looping Grid-Forming Response flow animation */}
                  <GridFormingResponseAnimation />
                </div>
              );
            })}
         </div>
      </div>
    </section>
  );
}
