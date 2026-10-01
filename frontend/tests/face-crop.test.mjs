import assert from 'node:assert/strict';
import test from 'node:test';
import { faceCropStyle } from '../src/faceCrop.ts';

function parse(style) {
  return {
    width: Number.parseFloat(style.width),
    height: Number.parseFloat(style.height),
    left: Number.parseFloat(style.left),
    top: Number.parseFloat(style.top)
  };
}

test('a centered face is padded into a square crop', () => {
  const style = faceCropStyle({ left: 0.4, top: 0.4, width: 0.2, height: 0.2 }, 1);
  assert.ok(style);
  const crop = parse(style);
  assert.ok(crop.width > 100);
  assert.equal(crop.width, crop.height);
  assert.ok(crop.left < 0);
  assert.ok(crop.top < 0);
  const shownLeft = -crop.left / crop.width;
  const shownTop = -crop.top / crop.height;
  assert.ok(shownLeft < 0.4);
  assert.ok(shownTop < 0.4);
  assert.ok(shownLeft + 100 / crop.width > 0.6);
});

test('a face on the edge stays inside the photo', () => {
  const style = faceCropStyle({ left: 0, top: 0, width: 0.1, height: 0.1 }, 1);
  assert.ok(style);
  const crop = parse(style);
  assert.equal(crop.left, 0);
  assert.equal(crop.top, 0);
});

test('landscape photos keep a square face window', () => {
  const style = faceCropStyle({ left: 0.45, top: 0.4, width: 0.05, height: 0.2 }, 3);
  assert.ok(style);
  const crop = parse(style);
  const windowWidth = 100 / crop.width;
  const windowHeight = 100 / crop.height;
  assert.ok(Math.abs(windowWidth * 3 - windowHeight) < 0.02);
});

test('missing or invalid boxes fall back to the full thumbnail', () => {
  assert.equal(faceCropStyle(null, 1), null);
  assert.equal(faceCropStyle({ left: 0, top: 0, width: 0, height: 0.2 }, 1), null);
  assert.equal(faceCropStyle({ left: 0.2, top: 0.2, width: 0.2, height: 0.2 }, 0), null);
});
