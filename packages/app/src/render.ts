/**
 * Exporting what the sheet sounds like: a WAV of the bounce, or MIDI written
 * from the same bounce's trace.
 */

import { transcribe, writeMidi } from '@oramics/midi';

import type { BounceInput, BounceResult } from './bounce.js';
import { encodeWav } from './bounce.js';
import type { BounceReply } from './bounce.worker.js';
import { saveBytes } from './save.js';

/** Render in a worker, reporting progress from 0 to 1. */
export const renderInWorker = (
  input: BounceInput,
  onProgress: (fraction: number) => void,
): Promise<BounceResult> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bounce.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<BounceReply>) => {
      const reply = event.data;
      if (reply.kind === 'progress') return onProgress(reply.fraction);
      worker.terminate();
      if (reply.kind === 'done') resolve(reply.result);
      else reject(new Error(reply.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'the render failed'));
    };
    worker.postMessage(input);
  });

export const exportWav = async (
  input: BounceInput,
  onProgress: (fraction: number) => void,
): Promise<{ path: string | null; truncated: boolean }> => {
  const result = await renderInWorker(input, onProgress);
  const path = await saveBytes(encodeWav(result.audio, result.sampleRate, result.right), 'daphne.wav', 'wav');
  return { path, truncated: result.truncated };
};

export const exportMidi = async (
  input: BounceInput,
  onProgress: (fraction: number) => void,
): Promise<{ path: string | null; notes: number }> => {
  const result = await renderInWorker(input, onProgress);
  const t = transcribe(result.trace);
  const bytes = writeMidi(t.notes, t.controls, { bendRange: t.bendRange, name: 'Daphne' });
  const path = await saveBytes(bytes, 'daphne.mid', 'mid');
  return { path, notes: t.notes.length };
};
