/**
 * Pan, as a dot on the stereo field.
 *
 * A slider's chrome says "a quantity from one end to the other", which is not
 * what this is: there is a middle, and the thing you want to see at a glance is
 * how far off it a timbre sits. A dot on a line shows that in the space of a
 * few pixels, and the line can carry a centre mark the dot visibly snaps to.
 *
 * It is still a slider as far as the keyboard and a screen reader are
 * concerned: arrows nudge, shift-arrows jump, Home and Enter centre it.
 */

import { useRef, type JSX, type KeyboardEvent, type PointerEvent } from 'react';

export interface PanDotProps {
  /** -1 hard left to 1 hard right. */
  value: number;
  onChange: (value: number) => void;
  label: string;
  title?: string;
  /** Set but not heard, which is how pan reads while Mono is on. */
  dim?: boolean;
}

const STEP = 0.05;
const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
/** Within this of the middle, it is the middle: a dot dragged by hand never lands on exactly 0. */
const SNAP = 0.06;

export const PanDot = ({ value, onChange, label, title, dim = false }: PanDotProps): JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);

  const fromPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const t = (event.clientX - rect.left) / rect.width;
    const next = clamp(t * 2 - 1);
    onChange(Math.abs(next) < SNAP ? 0 : next);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    fromPointer(event);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.buttons !== 1) return;
    fromPointer(event);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? STEP * 4 : STEP;
    if (event.key === 'ArrowLeft') onChange(clamp(value - step));
    else if (event.key === 'ArrowRight') onChange(clamp(value + step));
    else if (event.key === 'Home' || event.key === 'Enter') onChange(0);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={ref}
      className={dim ? 'pan-dot dim' : 'pan-dot'}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(2))}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onDoubleClick={() => onChange(0)}
      onKeyDown={onKeyDown}
    >
      <span className="field" />
      <span className="centre" />
      <span className="dot" style={{ left: `${((value + 1) / 2) * 100}%` }} />
    </div>
  );
};
