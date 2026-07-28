import { COLUMNS, ROWS, type Tile } from './officeLayout';

/**
 * Staff walk like game characters: one tile at a time, only up/down/left/right,
 * never diagonally and never through a desk or a colleague. A breadth-first
 * search over the 25x15 grid is instant at this size and always returns the
 * shortest route, which is exactly what "walk round the obstacle" should look
 * like.
 */
const steps: Tile[] = [
  { col: 0, row: -1 },
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: -1, row: 0 },
];

export function tileKey(col: number, row: number): number {
  return row * COLUMNS + col;
}

function inside(col: number, row: number): boolean {
  return col >= 0 && col < COLUMNS && row >= 0 && row < ROWS;
}

export interface PathOptions {
  /** Tiles taken by other staff. The start tile is always allowed. */
  blocked?: ReadonlySet<number>;
}

/**
 * The tiles to walk through, excluding the tile currently stood on.
 * Returns an empty array when already there, or `undefined` when there is no
 * route at all (fully walled in by colleagues, for example).
 */
export function findPath(
  grid: readonly boolean[][],
  from: Tile,
  to: Tile,
  options: PathOptions = {},
): Tile[] | undefined {
  if (!inside(from.col, from.row) || !inside(to.col, to.row)) return undefined;
  if (from.col === to.col && from.row === to.row) return [];
  if (!grid[to.row][to.col]) return undefined;

  const blocked = options.blocked ?? new Set<number>();
  const start = tileKey(from.col, from.row);
  const goal = tileKey(to.col, to.row);
  const cameFrom = new Map<number, number>();
  const seen = new Set<number>([start]);
  const queue: Tile[] = [from];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const currentKey = tileKey(current.col, current.row);
    if (currentKey === goal) break;
    for (const step of steps) {
      const col = current.col + step.col;
      const row = current.row + step.row;
      if (!inside(col, row) || !grid[row][col]) continue;
      const key = tileKey(col, row);
      if (seen.has(key)) continue;
      // A colleague standing still is an obstacle, unless they are the goal
      // tile's owner — that case is handled by picking a free tile first.
      if (blocked.has(key) && key !== goal) continue;
      seen.add(key);
      cameFrom.set(key, currentKey);
      queue.push({ col, row });
    }
  }

  if (!cameFrom.has(goal) && start !== goal) return undefined;

  const path: Tile[] = [];
  let key = goal;
  while (key !== start) {
    path.push({ col: key % COLUMNS, row: Math.floor(key / COLUMNS) });
    const previous = cameFrom.get(key);
    if (previous === undefined) return undefined;
    key = previous;
  }
  return path.reverse();
}

/**
 * The closest walkable, unoccupied tile to `preferred`. Used so two people
 * never claim the same chair — the second one simply takes the next seat.
 */
export function findFreeTile(
  grid: readonly boolean[][],
  preferred: Tile,
  taken: ReadonlySet<number>,
): Tile {
  const seen = new Set<number>();
  const queue: Tile[] = [preferred];
  seen.add(tileKey(preferred.col, preferred.row));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (
      inside(current.col, current.row) &&
      grid[current.row][current.col] &&
      !taken.has(tileKey(current.col, current.row))
    ) {
      return current;
    }
    for (const step of steps) {
      const col = current.col + step.col;
      const row = current.row + step.row;
      if (!inside(col, row)) continue;
      const key = tileKey(col, row);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ col, row });
    }
  }
  return preferred;
}
