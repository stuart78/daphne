/**
 * A button that opens a short list of actions.
 *
 * For the import and export groups, which had grown to six buttons and pushed
 * the header off the side of a laptop screen. Closes on a choice, on a click
 * anywhere else, and on Escape.
 */

import { useEffect, useRef, useState, type JSX } from 'react';

export interface MenuItem {
  label: string;
  title?: string;
  onSelect: () => void;
}

export const MenuButton = ({ label, items }: { label: string; items: MenuItem[] }): JSX.Element => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu-button" ref={ref}>
      <button className={open ? 'on' : ''} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label} ▾
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
