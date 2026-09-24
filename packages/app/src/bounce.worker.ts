/**
 * The bounce, off the main thread.
 *
 * A full sheet takes a second or two to render, which is long enough to freeze
 * the window if it ran there.
 */

import { bounce, type BounceInput, type BounceResult } from './bounce.js';

export type BounceReply =
  | { kind: 'progress'; fraction: number }
  | { kind: 'done'; result: BounceResult }
  | { kind: 'error'; message: string };

self.onmessage = (event: MessageEvent<BounceInput>) => {
  const post = (reply: BounceReply, transfer: Transferable[] = []): void =>
    (self as unknown as Worker).postMessage(reply, transfer);
  try {
    const result = bounce(event.data, (fraction) => post({ kind: 'progress', fraction }));
    const transfer: Transferable[] = [result.audio.buffer];
    if (result.right) transfer.push(result.right.buffer);
    post({ kind: 'done', result }, transfer);
  } catch (err) {
    post({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
