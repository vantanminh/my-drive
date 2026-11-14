/**
 * Pure lightbox gesture and fit math adapted from beauty-plus/public/album-gestures.js.
 */

export const LB_MIN_ZOOM = 1;
export const LB_MAX_ZOOM = 5;
export const LB_PAN_MARGIN = 48;
export const SWIPE_MIN_DX = 48;
export const SWIPE_SLOPE = 1.2;
export const DOUBLE_TAP_ZOOM = 2.5;
export const ZOOM_SNAP = 1.05;
export const DRAG_AXIS_LOCK = 8;
export const FLICK_VELOCITY = 0.45; // px/ms
export const FLICK_MIN_DX = 16;
export const DISMISS_MIN_DY = 120;
export const DISMISS_VELOCITY = 0.55; // px/ms
export const EDGE_RESIST = 0.3;

export type ZoomPan = { zoom: number; x: number; y: number };
export type DragAxis = 'x' | 'y' | null;
export type SwipeDirection = 'next' | 'prev' | null;
export type StageRect = { left: number; top: number; width: number; height: number };
export type ContainSize = { width: number; height: number };

export function clampZoom(z: number, min = LB_MIN_ZOOM, max = LB_MAX_ZOOM): number {
  const num = Number(z);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

export function resetZoomPan(): ZoomPan {
  return { zoom: LB_MIN_ZOOM, x: 0, y: 0 };
}

export function shouldSnapZoomOut(zoom: number): boolean {
  return zoom > LB_MIN_ZOOM && zoom < ZOOM_SNAP;
}

/** Zoom toward a stage point. Scale is clamped to [1, max]; at 1× pan resets. */
export function applyZoomAt(
  state: ZoomPan,
  nextZoom: number,
  clientX: number,
  clientY: number,
  stageRect: StageRect
): ZoomPan {
  const prev = state.zoom;
  const next = clampZoom(nextZoom);
  if (next <= LB_MIN_ZOOM) return resetZoomPan();
  if (next === prev) return { zoom: next, x: state.x, y: state.y };
  const px = clientX - (stageRect.left + stageRect.width / 2);
  const py = clientY - (stageRect.top + stageRect.height / 2);
  return {
    zoom: next,
    x: px - (px - state.x) * (next / prev),
    y: py - (py - state.y) * (next / prev)
  };
}

export function clampPan(
  state: ZoomPan,
  dims: { baseW: number; baseH: number; stageW: number; stageH: number; margin?: number }
): ZoomPan {
  if (state.zoom <= LB_MIN_ZOOM) return resetZoomPan();
  const baseW = dims.baseW || 0;
  const baseH = dims.baseH || 0;
  if (!baseW || !baseH) return state;
  const margin = dims.margin ?? LB_PAN_MARGIN;
  const maxX = Math.max(0, (baseW * state.zoom - dims.stageW) / 2 + margin);
  const maxY = Math.max(0, (baseH * state.zoom - dims.stageH) / 2 + margin);
  return {
    zoom: state.zoom,
    x: Math.min(maxX, Math.max(-maxX, state.x)),
    y: Math.min(maxY, Math.max(-maxY, state.y))
  };
}

export function pinchZoom(startZoom: number, startDist: number, dist: number): number {
  if (!(startDist > 0)) return clampZoom(startZoom);
  return clampZoom(startZoom * (dist / startDist));
}

/** Double-tap: 1× → DOUBLE_TAP_ZOOM, otherwise back to 1×. */
export function doubleTapZoom(currentZoom: number): number {
  return currentZoom > LB_MIN_ZOOM ? LB_MIN_ZOOM : DOUBLE_TAP_ZOOM;
}

/** Horizontal swipe changes media only when not zoomed. */
export function resolveSwipe(dx: number, dy: number, zoomed: boolean): SwipeDirection {
  if (zoomed) return null;
  if (Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dx) < Math.abs(dy) * SWIPE_SLOPE) {
    return null;
  }
  return dx < 0 ? 'next' : 'prev';
}

/** Lock a one-finger drag to an axis once it travels past the dead zone. */
export function resolveDragAxis(dx: number, dy: number, lock = DRAG_AXIS_LOCK): DragAxis {
  if (Math.hypot(dx, dy) < lock) return null;
  return Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
}

/** Quick flick also changes media even below SWIPE_MIN_DX. */
export function resolveFlick(dx: number, dy: number, vx: number, zoomed: boolean): SwipeDirection {
  const dir = resolveSwipe(dx, dy, zoomed);
  if (dir || zoomed) return dir;
  if (
    Math.abs(vx) >= FLICK_VELOCITY &&
    Math.abs(dx) >= FLICK_MIN_DX &&
    Math.abs(dx) > Math.abs(dy)
  ) {
    return vx < 0 ? 'next' : 'prev';
  }
  return null;
}

/** Swipe-down-to-close: far enough, or a fast downward flick. */
export function shouldDismiss(dy: number, vy: number): boolean {
  return dy >= DISMISS_MIN_DY || (dy > 24 && vy >= DISMISS_VELOCITY);
}

/** Rubber-band the track when dragging past the first / last item. */
export function edgeResist(dx: number, canPrev: boolean, canNext: boolean): number {
  if ((dx > 0 && !canPrev) || (dx < 0 && !canNext)) return dx * EDGE_RESIST;
  return dx;
}

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(Number(index) || 0)));
}

/** Two-finger pinch anchored at the starting midpoint plus midpoint drift. */
export function pinchAnchored(
  start: ZoomPan,
  startDist: number,
  dist: number,
  startMid: { x: number; y: number },
  mid: { x: number; y: number },
  stageRect: StageRect
): ZoomPan {
  const z = pinchZoom(start.zoom, startDist, dist);
  const anchored = applyZoomAt(start, z, startMid.x, startMid.y, stageRect);
  if (anchored.zoom <= LB_MIN_ZOOM) return resetZoomPan();
  return {
    zoom: anchored.zoom,
    x: anchored.x + (mid.x - startMid.x),
    y: anchored.y + (mid.y - startMid.y)
  };
}

export function containScale(
  mediaWidth: number,
  mediaHeight: number,
  boxWidth: number,
  boxHeight: number,
  rotation = 0
): number {
  if (mediaWidth <= 0 || mediaHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) return 0;
  const turned = ((rotation % 180) + 180) % 180 !== 0;
  const visualWidth = turned ? mediaHeight : mediaWidth;
  const visualHeight = turned ? mediaWidth : mediaHeight;
  return Math.min(boxWidth / visualWidth, boxHeight / visualHeight);
}

/** Fit natural media size inside a box (contain), accounting for rotation. */
export function fitContain(
  natW: number,
  natH: number,
  boxW: number,
  boxH: number,
  rotation = 0
): ContainSize | null {
  const s = containScale(natW, natH, boxW, boxH, rotation);
  if (!(s > 0)) return null;
  return { width: Math.round(natW * s), height: Math.round(natH * s) };
}
