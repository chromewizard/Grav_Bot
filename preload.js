const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('gravbot', {
  getInitialState: () => ipcRenderer.invoke('gb:get-initial-state'),
  sendMessage: (payload) => ipcRenderer.invoke('gb:send-message', payload),
  toggleReaction: (payload) => ipcRenderer.invoke('gb:toggle-reaction', payload),
  respondWidget: (payload) => ipcRenderer.invoke('gb:respond-widget', payload),
  createBot: (payload) => ipcRenderer.invoke('gb:create-bot', payload),
  updateBot: (payload) => ipcRenderer.invoke('gb:update-bot', payload),
  deleteBot: (agentId) => ipcRenderer.invoke('gb:delete-bot', agentId),
  clearTranscript: (agentId) => ipcRenderer.invoke('gb:clear-transcript', agentId),
  setPrimaryBot: (agentId) => ipcRenderer.invoke('gb:set-primary-bot', agentId),
  resetStudioMode: (mode) => ipcRenderer.invoke('gb:reset-studio-mode', mode),
  readWorkspaceFile: (relPath) => ipcRenderer.invoke('gb:read-workspace-file', relPath),
  revealWorkspaceFile: (payload) => ipcRenderer.invoke('gb:reveal-workspace-file', payload),
  listWorkspaceFiles: () => ipcRenderer.invoke('gb:list-workspace-files'),
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        const p = webUtils.getPathForFile(file);
        if (p) return p;
      }
    } catch (e) {}
    return (file && file.path) || '';
  },
  ingestDroppedPaths: (payload) => ipcRenderer.invoke('gb:ingest-dropped-paths', payload),
  ingestDroppedEntries: (payload) => ipcRenderer.invoke('gb:ingest-dropped-entries', payload),
  pickFilesOrFolders: (opts) => ipcRenderer.invoke('gb:pick-files-or-folders', opts),
  setDroppedItemTag: (payload) => ipcRenderer.invoke('gb:set-dropped-item-tag', payload),
  removeDroppedItem: (payload) => ipcRenderer.invoke('gb:remove-dropped-item', payload),
  updateSettings: (patch) => ipcRenderer.invoke('gb:update-settings', patch),
  transcribeAudio: (base64Audio) => ipcRenderer.invoke('gb:transcribe-audio', base64Audio),
  voiceStreamStart: (opts) => ipcRenderer.invoke('gb:voice-stream-start', opts),
  voiceStreamChunk: (payload) => ipcRenderer.invoke('gb:voice-stream-chunk', payload),
  voiceStreamStop: (payload) => ipcRenderer.invoke('gb:voice-stream-stop', payload),
  startNativeDictation: () => ipcRenderer.invoke('gb:start-native-dictation'),
  openExternalPath: (targetPath) => ipcRenderer.invoke('gb:open-external-path', targetPath),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('gb:event', listener);
    return () => ipcRenderer.removeListener('gb:event', listener);
  }
});
