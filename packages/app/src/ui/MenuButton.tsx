/**
 * A button that opens a short list of actions.
 *
 * For the import and export groups, which had grown to six buttons and pushed
 * the header off the side of a laptop screen. Closes on a choice, on a click
 * anywhere else, and on Escape.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  title?: string;
  /** Shown ticked, for a menu that picks one of several. */
  checked?: boolean;
  onSelect: () => void;
}

export interface MenuButtonProps {
  /** Text, or an icon for a button that has no room for words. */
  label: ReactNode;
  items: MenuItem[];
  /** Spoken name and tooltip, needed when the label is an icon. */
  title?: string;
  className?: string;
}

export const MenuButton = ({ label, items, title, className }: MenuButtonProps): JSX.Element => {
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
      <button
        className={[className, open ? 'on' : ''].filter(Boolean).join(' ')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {typeof label === 'string' ? ' ▾' : null}
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitemradio"
              aria-checked={item.checked}
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="tick">{item.checked ? '✓' : ''}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
