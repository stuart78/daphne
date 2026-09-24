/**
 * Saving bytes the user asked for: a save dialog in the shell, a download in a
 * plain browser.
 */

export type SaveKind = 'pdf' | 'wav' | 'mid';

const TYPES: Record<SaveKind, string> = {
  pdf: 'application/pdf',
  wav: 'audio/wav',
  mid: 'audio/midi',
};

/** Returns where it went, or null if the user cancelled. */
export const saveBytes = async (bytes: Uint8Array, name: string, kind: SaveKind): Promise<string | null> => {
  const shell = window.oramics;
  if (shell) return shell.saveFile(bytes, name, kind);

  const blob = new Blob([bytes as BlobPart], { type: TYPES[kind] });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
};
