import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISMISS_MIN_DY,
  DOUBLE_TAP_ZOOM,
  LB_MAX_ZOOM,
  LB_PAN_MARGIN,
  SWIPE_MIN_DX,
  SWIPE_SLOPE,
  applyZoomAt,
  clampIndex,
  clampPan,
  containScale,
  doubleTapZoom,
  edgeResist,
  fitContain,
  pinchAnchored,
  pinchZoom,
  resetZoomPan,
  resolveDragAxis,
  resolveFlick,
  resolveSwipe,
  shouldDismiss,
  shouldSnapZoomOut
} from '../src/viewerGestures.ts';

const PHONE_STAGE = { left: 0, top: 0, width: 390, height: 844 };

test('zoom / pan clamps to [1, max] and resets pan at 1x', () => {
  let state = resetZoomPan();
  assert.deepEqual(state, { zoom: 1, x: 0, y: 0 });

  state = applyZoomAt(state, 99, 195, 400, PHONE_STAGE);
  assert.equal(state.zoom, LB_MAX_ZOOM);

  state = applyZoomAt(state, 0.1, 195, 400, PHONE_STAGE);
  assert.deepEqual(state, { zoom: 1, x: 0, y: 0 });

  const zoomed = applyZoomAt(resetZoomPan(), DOUBLE_TAP_ZOOM, 80, 120, PHONE_STAGE);
  assert.equal(zoomed.zoom, DOUBLE_TAP_ZOOM);
  assert.ok(zoomed.x !== 0 || zoomed.y !== 0);
  assert.deepEqual(applyZoomAt(zoomed, 1, 80, 120, PHONE_STAGE), resetZoomPan());
});

test('double-tap and pinch helpers calculate scale and anchored pan', () => {
  assert.equal(doubleTapZoom(1), DOUBLE_TAP_ZOOM);
  assert.equal(doubleTapZoom(2.5), 1);

  assert.equal(pinchZoom(1, 40, 80), 2);
  assert.equal(pinchZoom(1, 40, 400), LB_MAX_ZOOM);

  assert.equal(shouldSnapZoomOut(1), false);
  assert.equal(shouldSnapZoomOut(1.02), true);
  assert.equal(shouldSnapZoomOut(2), false);

  const mid = { x: 195, y: 422 };
  const centered = pinchAnchored(resetZoomPan(), 100, 200, mid, mid, PHONE_STAGE);
  assert.equal(centered.zoom, 2);
  assert.ok(Math.abs(centered.x) < 1e-9 && Math.abs(centered.y) < 1e-9);

  const drifted = pinchAnchored(resetZoomPan(), 100, 200, mid, { x: 215, y: 432 }, PHONE_STAGE);
  assert.equal(drifted.x, centered.x + 20);
  assert.equal(drifted.y, centered.y + 10);
});

test('pan clamping respects stage overflow and margin', () => {
  const zoom = 3;
  const dims = { baseW: 300, baseH: 400, stageW: 390, stageH: 700 };
  const clamped = clampPan({ zoom, x: 9999, y: -9999 }, dims);
  const maxX = Math.max(0, (dims.baseW * zoom - dims.stageW) / 2 + LB_PAN_MARGIN);
  const maxY = Math.max(0, (dims.baseH * zoom - dims.stageH) / 2 + LB_PAN_MARGIN);
  assert.equal(clamped.x, maxX);
  assert.equal(clamped.y, -maxY);
  assert.deepEqual(clampPan({ zoom: 1, x: 40, y: 40 }, dims), resetZoomPan());
});

test('swipe, flick, axis lock, dismiss, and edge resist behave as expected', () => {
  assert.equal(resolveSwipe(-(SWIPE_MIN_DX + 1), 0, false), 'next');
  assert.equal(resolveSwipe(SWIPE_MIN_DX + 8, 4, false), 'prev');
  assert.equal(resolveSwipe(-(SWIPE_MIN_DX - 1), 0, false), null);
  const verticalDy = -Math.ceil((SWIPE_MIN_DX + 20) / SWIPE_SLOPE) - 1;
  assert.equal(resolveSwipe(-(SWIPE_MIN_DX + 20), verticalDy, false), null);
  assert.equal(resolveSwipe(-(SWIPE_MIN_DX + 40), 0, true), null);

  assert.equal(resolveDragAxis(3, 2), null);
  assert.equal(resolveDragAxis(20, 4), 'x');
  assert.equal(resolveDragAxis(-4, 30), 'y');

  assert.equal(resolveFlick(-24, 2, -0.9, false), 'next');
  assert.equal(resolveFlick(24, 2, 0.9, false), 'prev');
  assert.equal(resolveFlick(-24, 2, -0.1, false), null);
  assert.equal(resolveFlick(-200, 0, -2, true), null);

  assert.equal(shouldDismiss(DISMISS_MIN_DY, 0), true);
  assert.equal(shouldDismiss(40, 1.2), true);
  assert.equal(shouldDismiss(40, 0.1), false);
  assert.equal(shouldDismiss(10, 3), false);

  assert.equal(edgeResist(100, true, true), 100);
  assert.equal(edgeResist(100, false, true), 30);
  assert.equal(edgeResist(-100, true, false), -30);

  assert.equal(clampIndex(-3, 10), 0);
  assert.equal(clampIndex(42, 10), 9);
  assert.equal(clampIndex(5, 0), 0);
});

test('fitContain and containScale handle normal and rotated dimensions', () => {
  assert.deepEqual(fitContain(1000, 2000, 400, 400), { width: 200, height: 400 });
  assert.deepEqual(fitContain(100, 50, 400, 400), { width: 400, height: 200 });
  assert.equal(fitContain(0, 10, 400, 400), null);
  assert.equal(containScale(1000, 500, 400, 400, 90), 0.4);
  assert.deepEqual(fitContain(1000, 500, 400, 400, 90), { width: 400, height: 200 });
});
