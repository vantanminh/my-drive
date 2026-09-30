import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Film } from 'lucide-react';
import { clampAspect, layoutJustified } from '../photoLayout';

export type MosaicItem = {
  id: string;
  name: string;
  src: string;
  aspect?: number | null;
  video?: boolean;
};

export default function PhotoMosaic({
  items,
  selected,
  selectionMode,
  onOpen,
  onSelect,
  onContextMenu
}: {
  items: MosaicItem[];
  selected?: string[];
  selectionMode?: boolean;
  onOpen: (id: string) => void;
  onSelect?: (id: string, mode: 'toggle' | 'range') => void;
  onContextMenu?: (event: ReactMouseEvent, id: string) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [aspects, setAspects] = useState<Record<string, number>>({});

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const targetHeight = width < 560 ? 132 : width < 900 ? 168 : 196;
  const rows = width > 0
    ? layoutJustified(items.map((item) => ({
      id: item.id,
      aspect: aspects[item.id] ?? (item.aspect && item.aspect > 0 ? item.aspect : 1.4)
    })), width, targetHeight, 6)
    : [];
  const placed = new Map(rows.flat().map((tile) => [tile.id, tile]));

  function remember(id: string, naturalWidth: number, naturalHeight: number) {
    if (naturalWidth <= 0 || naturalHeight <= 0) return;
    const aspect = clampAspect(naturalWidth / naturalHeight);
    setAspects((current) => current[id] === aspect ? current : { ...current, [id]: aspect });
  }

  function activate(event: ReactPointerEvent | ReactMouseEvent, id: string) {
    const selecting = selectionMode || event.metaKey || event.ctrlKey || event.shiftKey;
    if (selecting && onSelect) {
      event.preventDefault();
      onSelect(id, event.shiftKey ? 'range' : 'toggle');
      return;
    }
    onOpen(id);
  }

  return (
    <div className={'photo-mosaic' + (selectionMode ? ' selection-active' : '')} ref={frameRef}>
      {rows.map((row, index) => {
        const last = index === rows.length - 1;
        return (
        <div className="photo-mosaic-row" key={row.map((tile) => tile.id).join('-') || index}>
          {row.map((tile) => {
            const item = items.find((candidate) => candidate.id === tile.id);
            const box = placed.get(tile.id);
            if (!item || !box) return null;
            const isSelected = selected?.includes(item.id) ?? false;
            return (
              <button
                key={item.id}
                type="button"
                className={'photo-mosaic-tile' + (isSelected ? ' selected' : '')}
                style={last
                  ? { width: box.width, height: box.height, flex: '0 0 auto' }
                  : { flex: `${box.width} 1 0`, height: box.height, minWidth: 0 }}
                onClick={(event) => activate(event, item.id)}
                onContextMenu={(event) => {
                  if (!onContextMenu) return;
                  event.preventDefault();
                  onContextMenu(event, item.id);
                }}
                aria-pressed={onSelect ? isSelected : undefined}
                title={item.name}
              >
                <img
                  src={item.src}
                  alt={item.name}
                  loading="lazy"
                  decoding="async"
                  onLoad={(event) => remember(item.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
                />
                {item.video && <span className="photo-badge"><Film size={12} /> Video</span>}
                {onSelect && (
                  <label className="photo-check" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onSelect(item.id, 'toggle')}
                      aria-label={'Select ' + item.name}
                    />
                  </label>
                )}
              </button>
            );
          })}
        </div>
        );
      })}
    </div>
  );
}
