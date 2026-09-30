export type FaceBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FaceCropStyle = {
  width: string;
  height: string;
  left: string;
  top: string;
};

const PADDING = 1.7;

export function faceCropStyle(box: FaceBox | null, imageAspect: number): FaceCropStyle | null {
  if (!box || !Number.isFinite(imageAspect) || imageAspect <= 0) return null;
  const { left, top, width, height } = box;
  if (![left, top, width, height].every((value) => Number.isFinite(value))) return null;
  if (width <= 0 || height <= 0 || width > 1 || height > 1) return null;
  if (left < -0.001 || top < -0.001 || left + width > 1.02 || top + height > 1.02) return null;

  const centerX = (left + width / 2) * imageAspect;
  const centerY = top + height / 2;
  const faceSide = Math.max(width * imageAspect, height);
  const maxSide = Math.min(imageAspect, 1);
  const side = Math.min(maxSide, faceSide * PADDING);
  if (side <= 0) return null;

  const originX = clamp(centerX - side / 2, 0, Math.max(0, imageAspect - side));
  const originY = clamp(centerY - side / 2, 0, Math.max(0, 1 - side));
  const normLeft = originX / imageAspect;
  const normWidth = side / imageAspect;
  const normTop = originY;
  if (normWidth <= 0.0001) return null;

  const widthPercent = 100 / normWidth;
  const heightPercent = widthPercent / imageAspect;
  return {
    width: percent(widthPercent),
    height: percent(heightPercent),
    left: percent(-normLeft * widthPercent),
    top: percent(-normTop * heightPercent)
  };
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 1000}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
