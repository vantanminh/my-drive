export type SelectionGesture = 'toggle' | 'range' | 'replace';

export function nextSelection(
  current: string[],
  orderedIds: string[],
  id: string,
  mode: SelectionGesture,
  anchor: string | null
): { ids: string[]; anchor: string } {
  if (mode === 'toggle') {
    const ids = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    return { ids, anchor: id };
  }
  if (mode === 'range') {
    const origin = anchor && orderedIds.includes(anchor) ? anchor : id;
    const start = orderedIds.indexOf(origin);
    const end = orderedIds.indexOf(id);
    if (start < 0 || end < 0) return { ids: [id], anchor: id };
    const [from, to] = start < end ? [start, end] : [end, start];
    return { ids: orderedIds.slice(from, to + 1), anchor: origin };
  }
  return { ids: [id], anchor: id };
}

export function selectionGesture(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, selectionMode: boolean): SelectionGesture | null {
  if (event.shiftKey) return 'range';
  if (event.metaKey || event.ctrlKey || selectionMode) return 'toggle';
  return null;
}
