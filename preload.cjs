const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  /** Opens a native folder-picker dialog. Returns the selected folder path or null. */
  selectFolder: () => ipcRenderer.invoke("select-folder"),

  /** Opens a native folder dialog and recursively reads all Excel files inside. */
  selectAndReadFolder: () => ipcRenderer.invoke("select-and-read-folder"),

  /**
   * Writes a base64-encoded file to the given absolute path.
   * @param {string} filePath  Absolute destination path (e.g. "D:/output/chart.png")
   * @param {string} base64Data  The base64-encoded content (no data-URI prefix)
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  saveFile: (filePath, base64Data) =>
    ipcRenderer.invoke("save-file", filePath, base64Data),

  /**
   * Calls a background MATLAB runner to save native .fig (and .png) files.
   * @param {string} outputFolder  Folder to save figures to
   * @param {object} projectData  The serializable daily evaluation data
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  saveMatlabFigures: (outputFolder, projectData) =>
    ipcRenderer.invoke("save-matlab-figures", outputFolder, projectData),

  /**
   * Saves an imported MATLAB script to the local engine plugins directory.
   * @param {string} projectCode  Project ID (e.g. "SNTB")
   * @param {string} scriptContent  The MATLAB script code
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  saveMatlabScript: (projectCode, scriptContent) =>
    ipcRenderer.invoke("save-matlab-script", projectCode, scriptContent),

  /**
   * Loads a saved MATLAB script from the local engine plugins directory.
   * @param {string} projectCode  Project ID (e.g. "SNTB")
   * @returns {Promise<{ok: boolean, content?: string, error?: string}>}
   */
  loadMatlabScript: (projectCode) =>
    ipcRenderer.invoke("load-matlab-script", projectCode),

  /**
   * Checks if specific exported files exist in the given subfolder.
   * @param {string} folderPath
   * @returns {Promise<{exists: boolean, files: string[], error?: string}>}
   */
  checkExportedFiles: (folderPath) =>
    ipcRenderer.invoke("check-exported-files", folderPath),

  /**
   * Reads and parses a result_output.json from the disk.
   * @param {string} filePath
   * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
   */
  loadResultJson: (filePath) =>
    ipcRenderer.invoke("load-result-json", filePath),

  loadCycleHistory: () =>
    ipcRenderer.invoke("load-cycle-history"),

  saveCycleHistory: (history) =>
    ipcRenderer.invoke("save-cycle-history", history),
});
