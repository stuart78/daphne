/**
 * Electron main process.
 *
 * Two responsibilities: put the editor on the primary display and the projector
 * on the external one, and give the renderer a save dialog. Everything else —
 * audio, drawing, PDF generation — happens in the renderer, because the engine
 * and the template both run fine in a browser context and keeping them there
 * means they stay testable without Electron.
 */

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, screen } = require('electron');
const fs = require('node:fs');
const { readFile, rename, writeFile } = require('node:fs/promises');
const path = require('node:path');

const { installMenu } = require('./menu.cjs');

const DEV_URL = process.env.ORAMICS_DEV_URL;

// Packaged builds carry a staged copy (see stage.mjs); running unpackaged
// against a plain `pnpm build` reaches across the workspace.
const STAGED = path.join(__dirname, 'renderer');
const RENDERER_DIR = fs.existsSync(STAGED) ? STAGED : path.join(__dirname, '../app/dist');

/** @type {BrowserWindow | null} */
let editorWindow = null;
/** @type {BrowserWindow | null} */
let projectorWindow = null;

/**
 * The colour the window is painted before the page has loaded.
 *
 * Electron fills the frame with this the moment the window appears, so a dark
 * value on a light desktop is a flash of the wrong theme every launch.
 *
 * There are more themes than there are system preferences, so the renderer
 * tells us the colour it settled on and we keep it in a one-line file. Without
 * one — a fresh install — the system preference is the better guess, which is
 * also what the renderer starts from.
 */
const colourPath = () => path.join(app.getPath('userData'), 'window-colour');

const windowBackground = () => {
  try {
    const kept = fs.readFileSync(colourPath(), 'utf8').trim();
    if (/^#[0-9a-f]{6}$/i.test(kept)) return kept;
  } catch {
    // No file yet, or it cannot be read. Fall through to the system preference.
  }
  return nativeTheme.shouldUseDarkColors ? '#0a090c' : '#f4f2ee';
};

ipcMain.on('oramics:window-colour', (_event, colour) => {
  // A colour and nothing else: this string is written to disk and handed back
  // to Electron on the next launch.
  if (typeof colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(colour)) return;
  try {
    fs.writeFileSync(colourPath(), colour, 'utf8');
  } catch (err) {
    console.error('could not keep the window colour', err);
  }
});

/** The projector has no light theme; see projector.tsx. */
const PROJECTOR_BACKGROUND = '#08070a';

const baseWebPreferences = {
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
};

/** Load either the dev server or the built file, for a given HTML entry. */
const loadEntry = (win, entry) => {
  if (DEV_URL) return win.loadURL(new URL(entry, DEV_URL).href);
  return win.loadFile(path.join(RENDERER_DIR, entry));
};

const createEditorWindow = () => {
  editorWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: windowBackground(),
    title: 'Daphne',
    titleBarStyle: 'hiddenInset',
    webPreferences: baseWebPreferences,
  });
  loadEntry(editorWindow, 'index.html');
  editorWindow.on('closed', () => {
    editorWindow = null;
  });
};

/**
 * Put the projector on a display that is not the one the editor is on. Falls
 * back to a window on the primary display so the feature still works on a
 * single-screen laptop while you are building.
 */
const externalDisplay = () => {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return displays.find((d) => d.id !== primary.id) ?? null;
};

const createProjectorWindow = () => {
  const target = externalDisplay();
  const bounds = target
    ? target.bounds
    : { x: undefined, y: undefined, width: 1280, height: 800 };

  projectorWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fullscreen: Boolean(target),
    // The projector is always dark: it is pointed at a wall in a dim room.
    backgroundColor: PROJECTOR_BACKGROUND,
    title: 'Daphne — Projector',
    webPreferences: baseWebPreferences,
  });
  loadEntry(projectorWindow, 'projector.html');
  projectorWindow.on('closed', () => {
    projectorWindow = null;
  });
};

const toggleProjector = () => {
  if (projectorWindow) {
    projectorWindow.close();
    return false;
  }
  createProjectorWindow();
  return true;
};

ipcMain.handle('oramics:toggle-projector', toggleProjector);

/**
 * Hand a menu command to the editor window.
 *
 * Addressed to the editor specifically, not to whatever is focused. The
 * projector holds no state and would not know what to do with Save, and on a
 * two-screen setup it is often the window in front.
 */
const sendCommand = (command) => {
  if (command === 'projector') return void toggleProjector();
  editorWindow?.webContents.send('oramics:command', command);
};

// The performance file. Plain JSON text, so the dialogs offer .json as well
// and nothing stops anyone opening one in an editor.
const SESSION_FILTERS = [
  { name: 'Daphne performance', extensions: ['daphne'] },
  { name: 'JSON', extensions: ['json'] },
];

ipcMain.handle('oramics:save-session', async (_event, text) => {
  const { canceled, filePath } = await dialog.showSaveDialog(editorWindow ?? undefined, {
    title: 'Save performance',
    defaultPath: 'performance.daphne',
    filters: SESSION_FILTERS,
  });
  if (canceled || !filePath) return null;
  await writeFile(filePath, text, 'utf8');
  return filePath;
});

ipcMain.handle('oramics:open-session', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(editorWindow ?? undefined, {
    title: 'Open performance',
    properties: ['openFile'],
    filters: SESSION_FILTERS,
  });
  const filePath = filePaths?.[0];
  if (canceled || !filePath) return null;
  return { path: filePath, text: await readFile(filePath, 'utf8') };
});

// Exports: the printable sheet, a bounce of the audio, and MIDI.
const SAVE_KINDS = {
  pdf: { title: 'Export sheet', name: 'PDF', extensions: ['pdf'] },
  wav: { title: 'Export audio', name: 'WAV audio', extensions: ['wav'] },
  mid: { title: 'Export MIDI', name: 'MIDI', extensions: ['mid'] },
};

ipcMain.handle('oramics:save-file', async (_event, bytes, name, kind) => {
  const spec = SAVE_KINDS[kind];
  if (!spec) throw new Error(`unknown export kind ${kind}`);
  const { canceled, filePath } = await dialog.showSaveDialog(editorWindow ?? undefined, {
    title: spec.title,
    defaultPath: name || `daphne.${spec.extensions[0]}`,
    filters: [{ name: spec.name, extensions: spec.extensions }],
  });
  if (canceled || !filePath) return null;
  await writeFile(filePath, Buffer.from(bytes));
  return filePath;
});

/*
 * The session as it stands, kept between launches.
 *
 * Written a moment after every change, and once more, synchronously, as the
 * window closes, so quitting mid-stroke loses nothing. Written to a temporary
 * file and renamed into place, so a crash halfway through a write leaves the
 * previous copy rather than half of this one.
 */
const autosavePath = () => path.join(app.getPath('userData'), 'autosave.daphne');

ipcMain.handle('oramics:autosave', async (_event, text) => {
  const target = autosavePath();
  await writeFile(`${target}.tmp`, text, 'utf8');
  await rename(`${target}.tmp`, target);
});

ipcMain.on('oramics:autosave-sync', (event, text) => {
  try {
    const target = autosavePath();
    fs.writeFileSync(`${target}.tmp`, text, 'utf8');
    fs.renameSync(`${target}.tmp`, target);
  } catch (err) {
    console.error('autosave failed', err);
  }
  event.returnValue = true;
});

ipcMain.handle('oramics:restore', async () => {
  try {
    return await readFile(autosavePath(), 'utf8');
  } catch {
    return null;
  }
});

/*
 * The projector's feed.
 *
 * Relayed through here rather than over a BroadcastChannel. Pages loaded from
 * disk have no shared origin to broadcast on, which is why the projector sat
 * on "waiting" in the packaged app.
 */
ipcMain.on('oramics:projector', (_event, message) => {
  projectorWindow?.webContents.send('oramics:projector', message);
});

// A projector that opens after the drawing was made has missed every update so
// far. It says so once it is listening, and the editor sends the lot again.
ipcMain.on('oramics:projector-hello', () => {
  editorWindow?.webContents.send('oramics:command', 'projector-ready');
});

app.whenReady().then(() => {
  installMenu(sendCommand);
  createEditorWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createEditorWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
