/**
 * The application menu.
 *
 * Everything here is a message to the renderer rather than work done in main.
 * The renderer owns the session — the lanes, the slides, the settings — so it
 * has to be the one that decides what saving means. Main only knows how to put
 * a dialog on screen and touch the disk.
 *
 * Setting a menu at all replaces Electron's default, so the standard roles have
 * to be listed back out or the window loses copy, paste, close and quit.
 */

const { Menu, app, shell } = require('electron');

const isMac = process.platform === 'darwin';

/**
 * @param {(command: string) => void} send Deliver a command to the editor window.
 * @returns {Electron.Menu}
 */
const buildMenu = (send) => {
  /** @type {Electron.MenuItemConstructorOptions} */
  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => send('clear') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { label: 'Save…', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { type: 'separator' },
      {
        label: 'Import Scan…',
        accelerator: 'Shift+CmdOrCtrl+I',
        click: () => send('import-scan'),
      },
      { label: 'Import MIDI…', accelerator: 'Shift+CmdOrCtrl+M', click: () => send('import-midi') },
      {
        label: 'Blank Sheet PDF (Legal)…',
        accelerator: 'Shift+CmdOrCtrl+N',
        click: () => send('export-blank'),
      },
      { label: 'Blank Sheet PDF (Letter)…', click: () => send('export-blank-letter') },
      { label: 'Export PDF…', accelerator: 'Shift+CmdOrCtrl+E', click: () => send('export-pdf') },
      { label: 'Export Audio…', accelerator: 'Shift+CmdOrCtrl+A', click: () => send('export-wav') },
      { label: 'Export MIDI…', click: () => send('export-midi') },
      // Windows and Linux have no application menu to hang Quit off.
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ],
  };

  /** @type {Electron.MenuItemConstructorOptions} */
  const viewMenu = {
    label: 'View',
    submenu: [
      { label: 'Projector', accelerator: 'Shift+CmdOrCtrl+P', click: () => send('projector') },
      { type: 'separator' },
      // Bound to the timeline rather than to page zoom. This app has one thing
      // you zoom, and it is not the interface.
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => send('zoom-in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
      { label: 'Fit Whole Sheet', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-fit') },
      { type: 'separator' },
      { label: 'Next Theme', accelerator: 'CmdOrCtrl+D', click: () => send('theme') },
      { type: 'separator' },
      // Shown for discovery only. The page handles Space itself so that it
      // still types into the key and scale pickers.
      {
        label: 'Play or Stop',
        accelerator: 'Space',
        registerAccelerator: false,
        click: () => send('play-stop'),
      },
      { label: 'Pitch in Hertz or Notes', accelerator: 'Shift+CmdOrCtrl+H', click: () => send('pitch-mode') },
      { label: 'Notes as Dots or Lines', accelerator: 'Shift+CmdOrCtrl+L', click: () => send('mark-mode') },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { role: 'togglefullscreen' },
    ],
  };

  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    fileMenu,
    { role: 'editMenu' },
    viewMenu,
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Daphne on GitHub',
          click: () => shell.openExternal('https://github.com/stuart78/oramics'),
        },
      ],
    },
  ]);
};

/** Install the menu. `send` is called with a command name on every item. */
const installMenu = (send) => {
  // Unpackaged, app.name comes from package.json and the macOS menu bar would
  // read "@oramics/shell".
  app.setName('Daphne');
  Menu.setApplicationMenu(buildMenu(send));
};

module.exports = { installMenu };
