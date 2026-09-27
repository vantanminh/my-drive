export type JustifiedTile = {
  id: string;
  aspect: number;
};

export type PlacedTile = {
  id: string;
  width: number;
  height: number;
};

const MIN_ASPECT = 0.42;
const MAX_ASPECT = 2.75;

export function clampAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return 1;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

/** Rows fill the width until the next photo would fall under the target height. The last row keeps that height instead of stretching. */
export function layoutJustified(
  items: JustifiedTile[],
  containerWidth: number,
  targetHeight = 188,
  gap = 6
): PlacedTile[][] {
  const width = Math.max(1, Math.floor(containerWidth));
  const rows: PlacedTile[][] = [];
  let row: JustifiedTile[] = [];
  let aspectSum = 0;

  const commit = (last: boolean) => {
    if (row.length === 0) return;
    const gaps = gap * Math.max(row.length - 1, 0);
    const fitted = (width - gaps) / aspectSum;
    const height = Math.max(72, last ? Math.min(targetHeight, fitted) : fitted);
    rows.push(row.map((tile) => ({
      id: tile.id,
      width: Math.max(1, height * tile.aspect),
      height
    })));
    row = [];
    aspectSum = 0;
  };

  for (const item of items) {
    const aspect = clampAspect(item.aspect);
    const nextSum = aspectSum + aspect;
    const nextCount = row.length + 1;
    const gaps = gap * Math.max(nextCount - 1, 0);
    const height = (width - gaps) / nextSum;
    row.push({ id: item.id, aspect });
    aspectSum = nextSum;
    if (nextCount > 1 && height <= targetHeight) commit(false);
  }
  commit(true);
  return rows;
}
