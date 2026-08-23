/**
 * Preload script exposing safe Electron APIs to renderer
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectArchivePath: () => ipcRenderer.invoke('select-archive-path'),
    getPathForFile: (file) => {
        try {
            if (webUtils && typeof webUtils.getPathForFile === 'function') {
                return webUtils.getPathForFile(file);
            }
            return file.path || '';
        } catch {
            return file.path || '';
        }
    }
});
