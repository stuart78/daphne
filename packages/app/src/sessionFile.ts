/**
 * Getting a performance file in and out of the app.
 *
 * The Electron shell gets real dialogs and real paths. A plain browser gets a
 * download and a file picker, which is worse but keeps `pnpm dev` a complete
 * app rather than one with a hole in it.
 */

import { SESSION_EXTENSION, decodeSession, encodeSession, type Session, type SessionSettings } from './session.js';

const DEFAULT_NAME = `performance.${SESSION_EXTENSION}`;

/** Returns where it went, or null if the user cancelled. */
export const saveSession = async (session: Session): Promise<string | null> => {
  const text = encodeSession(session);

  const shell = window.oramics;
  if (shell) return shell.saveSession(text);

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = DEFAULT_NAME;
  a.click();
  URL.revokeObjectURL(url);
  return DEFAULT_NAME;
};

/** Returns the loaded session and where it came from, or null if cancelled. */
export const openSession = async (
  fallback: SessionSettings,
): Promise<{ session: Session; path: string } | null> => {
  const shell = window.oramics;
  if (shell) {
    const opened = await shell.openSession();
    if (!opened) return null;
    return { session: decodeSession(opened.text, fallback), path: opened.path };
  }

  const file = await pickFile();
  if (!file) return null;
  return { session: decodeSession(await file.text(), fallback), path: file.name };
};

/*
 * The session kept between launches. The shell writes it into the app's data
 * folder; a plain browser keeps it in local storage, which can be missing or
 * full, so every call here fails quietly.
 */
const AUTOSAVE_KEY = 'daphne.autosave';

export const readAutosave = async (): Promise<string | null> => {
  const shell = window.oramics;
  if (shell) return shell.restore();
  try {
    return localStorage.getItem(AUTOSAVE_KEY);
  } catch {
    return null;
  }
};

export const writeAutosave = (text: string): void => {
  const shell = window.oramics;
  if (shell) {
    shell.autosave(text).catch((err: unknown) => console.warn('autosave failed', err));
    return;
  }
  try {
    localStorage.setItem(AUTOSAVE_KEY, text);
  } catch {
    // Full or blocked: the session still works, it just will not be kept.
  }
};

/** Blocking, for the moment the window closes. */
export const writeAutosaveNow = (text: string): void => {
  const shell = window.oramics;
  if (shell) return shell.autosaveNow(text);
  writeAutosave(text);
};

/** Ask for an image of a printed sheet. Always the browser picker: the shell has no image dialog. */
export const pickImage = (): Promise<File | null> => pickFile('image/*');

/** Ask for a MIDI file. */
export const pickMidi = (): Promise<File | null> => pickFile('.mid,.midi,audio/midi');

/**
 * A file picker in a plain browser.
 *
 * Resolves null on cancel, which the input element has no event for — hence
 * the focus race: the window regains focus when the dialog closes either way,
 * and a change event that has not arrived shortly after means cancelled.
 */
const pickFile = (accept = `.${SESSION_EXTENSION},.json,application/json`): Promise<File | null> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    let settled = false;
    const finish = (file: File | null): void => {
      if (settled) return;
      settled = true;
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    window.addEventListener(
      'focus',
      () => window.setTimeout(() => finish(null), 400),
      { once: true },
    );
    input.click();
  });
