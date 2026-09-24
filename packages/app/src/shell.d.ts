/** The surface the Electron preload exposes. Absent when running in a plain browser. */
export interface OramicsShell {
  /** Show a save dialog and write an export. Returns the path, or null if cancelled. */
  saveFile: (bytes: Uint8Array, name: string, kind: 'pdf' | 'wav' | 'mid') => Promise<string | null>;
  /** Show a save dialog and write the performance file. Null if cancelled. */
  saveSession: (text: string) => Promise<string | null>;
  /** Show an open dialog and read a performance file. Null if cancelled. */
  openSession: () => Promise<{ path: string; text: string } | null>;
  /** Open or close the projector window on the external display. */
  toggleProjector: () => Promise<boolean>;
  /** Keep the working session for next launch. */
  autosave: (text: string) => Promise<void>;
  /** The same, blocking, for when the window is closing. */
  autosaveNow: (text: string) => void;
  /** The session kept from last time, or null. */
  restore: () => Promise<string | null>;
  /** Send to the projector window, if it is open. */
  projectorPost: (message: unknown) => void;
  /** In the projector: receive from the editor, asking for everything first. */
  onProjector: (handler: (message: unknown) => void) => () => void;
  /** Subscribe to menu commands. Returns an unsubscribe function. */
  onCommand: (handler: (command: ShellCommand) => void) => () => void;
}

/** What the menu can ask the editor window to do. */
export type ShellCommand =
  | 'open'
  | 'save'
  | 'export-pdf'
  | 'export-blank'
  | 'import-scan'
  | 'import-midi'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-fit'
  | 'theme'
  | 'pitch-mode'
  | 'mark-mode'
  | 'play-stop'
  | 'export-wav'
  | 'export-midi'
  | 'projector-ready'
  | 'clear';

declare global {
  interface Window {
    oramics?: OramicsShell;
  }
}
