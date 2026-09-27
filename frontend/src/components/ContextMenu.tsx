import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type MenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  onSelect?: () => void;
};

type Point = { x: number; y: number };

export function ContextMenu({
  point,
  items,
  onClose,
  label = 'Actions'
}: {
  point: Point;
  items: MenuItem[];
  onClose: () => void;
  label?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: point.x, top: point.y });
  const visible = items.filter((item) => !item.hidden);

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, point.x), Math.max(margin, window.innerWidth - rect.width - margin));
    const top = Math.min(Math.max(margin, point.y), Math.max(margin, window.innerHeight - rect.height - margin));
    setPosition({ left, top });
  }, [point.x, point.y, visible.length]);

  useEffect(() => {
    function onPointer(event: MouseEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    function onLayout() {
      onClose();
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onLayout);
    window.addEventListener('scroll', onLayout, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onLayout);
      window.removeEventListener('scroll', onLayout, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top }}
    >
      {visible.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={item.danger ? 'context-menu-danger' : undefined}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect?.();
            onClose();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}

export function AnchoredMenu({
  label,
  items,
  children
}: {
  label: string;
  items: MenuItem[];
  children: ReactNode;
}) {
  const [point, setPoint] = useState<Point | null>(null);
  return (
    <>
      <button
        className="icon-button"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={point != null}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setPoint({ x: rect.left, y: rect.bottom + 4 });
        }}
        onContextMenu={(event) => event.stopPropagation()}
      >
        {children}
      </button>
      {point && <ContextMenu point={point} items={items} label={label} onClose={() => setPoint(null)} />}
    </>
  );
}
