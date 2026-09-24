/**
 * The wire between the editor and the projector.
 *
 * In the app it goes through the main process, because pages loaded from disk
 * share no origin and a BroadcastChannel between them carries nothing. In a
 * plain browser, where both pages come from the dev server, a BroadcastChannel
 * does the job.
 *
 * The projector holds no state of its own, so when it starts listening it asks
 * for everything: through main in the app, on the channel in a browser.
 */

import type { PitchMode } from '@oramics/engine';

import type { LaneTrack } from './lanes.js';

/**
 * Split in two because the head positions arrive about thirty times a second
 * and the lane drawings are tens of kilobytes. Sending both together meant
 * structured-cloning every lane on every meter tick.
 */
export type ProjectorMessage =
  | {
      kind: 'lanes';
      lanes: Record<string, LaneTrack>;
      pitchMode: PitchMode;
      /** The note and octave as read, in Notes mode. */
      reading: { pitch: Float32Array; octave: Float32Array } | null;
      /** Note rows to shade: the sharps, or whatever is outside the key. */
      shaded: number[];
    }
  | { kind: 'transport'; heads: Record<string, number>; hz: number; playing: boolean }
  | { kind: 'hello' };

const CHANNEL = 'oramics';

/** Editor side. `onHello` fires when a projector wants the full picture. */
export const openEditorLink = (
  onHello: () => void,
): { post: (message: ProjectorMessage) => void; close: () => void } => {
  const shell = window.oramics;
  if (shell) return { post: (m) => shell.projectorPost(m), close: () => {} };

  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e: MessageEvent<ProjectorMessage>) => {
    if (e.data.kind === 'hello') onHello();
  };
  return { post: (m) => channel.postMessage(m), close: () => channel.close() };
};

/** Projector side. Returns an unsubscribe function. */
export const openProjectorLink = (onMessage: (message: ProjectorMessage) => void): (() => void) => {
  const shell = window.oramics;
  if (shell) return shell.onProjector((m) => onMessage(m as ProjectorMessage));

  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e: MessageEvent<ProjectorMessage>) => onMessage(e.data);
  channel.postMessage({ kind: 'hello' } satisfies ProjectorMessage);
  return () => channel.close();
};
