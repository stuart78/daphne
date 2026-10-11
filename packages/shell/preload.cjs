const { contextBridge, ipcRenderer } = require('electron');

/**
 * The whole surface the renderer gets. Every file call either opens a dialog the
 * user has to answer or touches the one autosave file at a fixed path. No
 * filesystem, no shell, no node globals leak across.
 */
contextBridge.exposeInMainWorld('oramics', {
  saveFile: (bytes, name, kind) => ipcRenderer.invoke('oramics:save-file', bytes, name, kind),
  saveSession: (text) => ipcRenderer.invoke('oramics:save-session', text),
  openSession: () => ipcRenderer.invoke('oramics:open-session'),
  toggleProjector: () => ipcRenderer.invoke('oramics:toggle-projector'),

  // The working session, kept between launches in the app's own data folder.
  // Not a dialog: the one file this writes is the app's, at a fixed path.
  autosave: (text) => ipcRenderer.invoke('oramics:autosave', text),
  autosaveNow: (text) => ipcRenderer.sendSync('oramics:autosave-sync', text),
  restore: () => ipcRenderer.invoke('oramics:restore'),
  rememberBackground: (colour) => ipcRenderer.send('oramics:window-colour', colour),

  // Editor to projector, relayed by main.
  projectorPost: (message) => ipcRenderer.send('oramics:projector', message),
  onProjector: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on('oramics:projector', listener);
    ipcRenderer.send('oramics:projector-hello');
    return () => ipcRenderer.removeListener('oramics:projector', listener);
  },

  // Menu commands travel the other way. Only the command name crosses, never
  // an event object, so nothing from the main process leaks into the page.
  onCommand: (handler) => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on('oramics:command', listener);
    return () => ipcRenderer.removeListener('oramics:command', listener);
  },
});
