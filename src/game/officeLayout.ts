import type { AgentDuty, AgentStatus } from '../types';

/**
 * The office is a straight top-down view laid out on a square grid.
 * Everything — rooms, furniture, where staff stand — is declared here in whole
 * tiles, so the drawing code, the walkable map and the pathfinder can never
 * disagree about where a desk actually is.
 */
export const TILE = 40;
export const COLUMNS = 25;
export const ROWS = 15;

export const px = (tile: number): number => tile * TILE;
export const center = (tile: number, span = 1): number => (tile + span / 2) * TILE;

export type ZoneKey =
  | 'director'
  | 'planning'
  | 'coding'
  | 'accounting'
  | 'research'
  | 'testlab'
  | 'lounge'
  | 'approval';

export interface Zone {
  key: ZoneKey;
  label: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
  floor: number;
  accent: number;
}

/**
 * Rooms are separated by one-tile corridors (column 7, column 15, row 6 and
 * row 11) so staff have somewhere to walk when they change jobs.
 */
export const zones: Zone[] = [
  { key: 'director', label: '統括本部', col: 1, row: 1, cols: 6, rows: 5, floor: 0xd9c7a2, accent: 0x8a6a2f },
  { key: 'planning', label: '企画会議室', col: 8, row: 1, cols: 7, rows: 5, floor: 0x9fc4cc, accent: 0x37788a },
  { key: 'coding', label: '開発室', col: 16, row: 1, cols: 8, rows: 5, floor: 0xd8ac8b, accent: 0xb4573a },
  { key: 'accounting', label: '経理室', col: 1, row: 7, cols: 6, rows: 4, floor: 0xcfc0d4, accent: 0x6b4f86 },
  { key: 'research', label: '資料室', col: 8, row: 7, cols: 7, rows: 4, floor: 0xa9c79c, accent: 0x54804c },
  { key: 'testlab', label: 'テストラボ', col: 16, row: 7, cols: 8, rows: 4, floor: 0xa3aac6, accent: 0x56658f },
  { key: 'lounge', label: '休憩スペース', col: 1, row: 12, cols: 13, rows: 2, floor: 0xe0c58c, accent: 0xa76a3a },
  { key: 'approval', label: '承認カウンター', col: 15, row: 12, cols: 9, rows: 2, floor: 0xe3cf9a, accent: 0xb98130 },
];

export type FurnitureKind =
  | 'desk'
  | 'deskWide'
  | 'chair'
  | 'meetingTable'
  | 'whiteboard'
  | 'noticeBoard'
  | 'progressBoard'
  | 'locker'
  | 'bookshelf'
  | 'filingCabinet'
  | 'serverRack'
  | 'counter'
  | 'sofa'
  | 'lowTable'
  | 'vendingMachine'
  | 'plant'
  | 'boxStack'
  | 'safe';

export interface Furniture {
  kind: FurnitureKind;
  col: number;
  row: number;
  cols: number;
  rows: number;
  accent?: number;
  facing?: 'up' | 'down';
}

/** Chairs are meant to be sat on, so they stay walkable; everything else blocks. */
const walkableKinds = new Set<FurnitureKind>(['chair']);

export const furniture: Furniture[] = [
  // 統括本部 — 東葛大五郎の指揮席と、ユーザー向けの進行表ボード。
  { kind: 'deskWide', col: 2, row: 2, cols: 4, rows: 1, accent: 0x8a6a2f },
  { kind: 'chair', col: 3, row: 3, cols: 1, rows: 1, accent: 0x8a6a2f, facing: 'up' },
  { kind: 'chair', col: 4, row: 3, cols: 1, rows: 1, accent: 0x8a6a2f, facing: 'up' },
  // 部屋名のプレートと重ならないよう、掲示板は左下に置いています。
  { kind: 'progressBoard', col: 1, row: 4, cols: 1, rows: 1 },
  { kind: 'filingCabinet', col: 6, row: 1, cols: 1, rows: 2 },
  { kind: 'plant', col: 6, row: 5, cols: 1, rows: 1 },

  // 企画会議室
  { kind: 'meetingTable', col: 10, row: 2, cols: 4, rows: 2 },
  { kind: 'chair', col: 10, row: 1, cols: 1, rows: 1, accent: 0x37788a, facing: 'down' },
  { kind: 'chair', col: 11, row: 1, cols: 1, rows: 1, accent: 0x37788a, facing: 'down' },
  { kind: 'chair', col: 12, row: 1, cols: 1, rows: 1, accent: 0x37788a, facing: 'down' },
  { kind: 'chair', col: 13, row: 1, cols: 1, rows: 1, accent: 0x37788a, facing: 'down' },
  { kind: 'chair', col: 10, row: 4, cols: 1, rows: 1, accent: 0x37788a, facing: 'up' },
  { kind: 'chair', col: 11, row: 4, cols: 1, rows: 1, accent: 0x37788a, facing: 'up' },
  { kind: 'chair', col: 12, row: 4, cols: 1, rows: 1, accent: 0x37788a, facing: 'up' },
  { kind: 'chair', col: 13, row: 4, cols: 1, rows: 1, accent: 0x37788a, facing: 'up' },
  { kind: 'whiteboard', col: 14, row: 2, cols: 1, rows: 2 },
  { kind: 'plant', col: 8, row: 5, cols: 1, rows: 1 },

  // 開発室
  { kind: 'desk', col: 16, row: 2, cols: 2, rows: 1, accent: 0xe1775b },
  { kind: 'desk', col: 19, row: 2, cols: 2, rows: 1, accent: 0x65b7d8 },
  { kind: 'desk', col: 16, row: 4, cols: 2, rows: 1, accent: 0xf0bd55 },
  { kind: 'desk', col: 19, row: 4, cols: 2, rows: 1, accent: 0xb58bd4 },
  { kind: 'chair', col: 16, row: 3, cols: 1, rows: 1, accent: 0xb4573a, facing: 'up' },
  { kind: 'chair', col: 19, row: 3, cols: 1, rows: 1, accent: 0xb4573a, facing: 'up' },
  { kind: 'chair', col: 16, row: 5, cols: 1, rows: 1, accent: 0xb4573a, facing: 'up' },
  { kind: 'chair', col: 19, row: 5, cols: 1, rows: 1, accent: 0xb4573a, facing: 'up' },
  { kind: 'locker', col: 22, row: 1, cols: 1, rows: 2 },
  // 22列の3行目は開けておきます。ふさぐと右端の23列が行き止まりになります。
  { kind: 'locker', col: 22, row: 4, cols: 1, rows: 2 },
  { kind: 'boxStack', col: 23, row: 5, cols: 1, rows: 1 },

  // 経理室
  { kind: 'desk', col: 2, row: 8, cols: 2, rows: 1, accent: 0x6b4f86 },
  { kind: 'chair', col: 2, row: 9, cols: 1, rows: 1, accent: 0x6b4f86, facing: 'up' },
  { kind: 'filingCabinet', col: 5, row: 7, cols: 1, rows: 2 },
  { kind: 'safe', col: 5, row: 10, cols: 1, rows: 1 },
  { kind: 'plant', col: 1, row: 7, cols: 1, rows: 1 },

  // 資料室
  { kind: 'bookshelf', col: 12, row: 7, cols: 1, rows: 2 },
  { kind: 'bookshelf', col: 13, row: 7, cols: 1, rows: 2 },
  { kind: 'filingCabinet', col: 14, row: 7, cols: 1, rows: 2 },
  { kind: 'desk', col: 9, row: 8, cols: 2, rows: 1, accent: 0x54804c },
  { kind: 'chair', col: 9, row: 9, cols: 1, rows: 1, accent: 0x54804c, facing: 'up' },
  { kind: 'chair', col: 10, row: 9, cols: 1, rows: 1, accent: 0x54804c, facing: 'up' },
  { kind: 'plant', col: 8, row: 7, cols: 1, rows: 1 },

  // テストラボ
  { kind: 'desk', col: 17, row: 8, cols: 2, rows: 1, accent: 0x75d38e },
  { kind: 'desk', col: 20, row: 8, cols: 2, rows: 1, accent: 0x75d38e },
  { kind: 'chair', col: 17, row: 9, cols: 1, rows: 1, accent: 0x56658f, facing: 'up' },
  { kind: 'chair', col: 20, row: 9, cols: 1, rows: 1, accent: 0x56658f, facing: 'up' },
  { kind: 'serverRack', col: 16, row: 7, cols: 1, rows: 2 },
  { kind: 'serverRack', col: 23, row: 7, cols: 1, rows: 2 },
  { kind: 'boxStack', col: 22, row: 10, cols: 1, rows: 1 },

  // 休憩スペース（1列目は通路として空けておかないと、左下が行き止まりになります）
  { kind: 'sofa', col: 2, row: 12, cols: 2, rows: 1 },
  { kind: 'lowTable', col: 2, row: 13, cols: 2, rows: 1 },
  { kind: 'vendingMachine', col: 6, row: 12, cols: 1, rows: 2 },
  { kind: 'progressBoard', col: 8, row: 12, cols: 2, rows: 2 },
  { kind: 'plant', col: 10, row: 12, cols: 1, rows: 1 },

  // 承認カウンター
  { kind: 'counter', col: 18, row: 12, cols: 3, rows: 1 },
  { kind: 'noticeBoard', col: 23, row: 12, cols: 1, rows: 1 },
  { kind: 'plant', col: 15, row: 13, cols: 1, rows: 1 },
];

export const entrance = { col: 11, row: ROWS - 1, cols: 3 };

export interface Tile {
  col: number;
  row: number;
}

/**
 * Where a member of staff stands. Idle staff go back to the room they belong
 * to rather than all crowding into the lounge, so the floor stays readable.
 */
const statusStations: Record<AgentStatus, Tile> = {
  idle: { col: 4, row: 13 },
  planning: { col: 11, row: 4 },
  researching: { col: 10, row: 9 },
  coding: { col: 17, row: 3 },
  running: { col: 18, row: 9 },
  accounting: { col: 3, row: 9 },
  approval: { col: 19, row: 13 },
  done: { col: 4, row: 13 },
  error: { col: 5, row: 4 },
};

const dutyStations: Partial<Record<AgentDuty, Tile>> = {
  director: { col: 3, row: 3 },
  planner: { col: 11, row: 4 },
  coder: { col: 17, row: 3 },
  researcher: { col: 10, row: 9 },
  tester: { col: 18, row: 9 },
  reviewer: { col: 12, row: 4 },
  designer: { col: 20, row: 3 },
  accountant: { col: 3, row: 9 },
  writer: { col: 11, row: 9 },
};

/**
 * Working statuses win (a coder who is researching walks to the 資料室), but an
 * agent with nothing to do returns to their own desk.
 */
export function stationFor(status: AgentStatus, duty: AgentDuty): Tile {
  if (status === 'idle' || status === 'done') {
    return dutyStations[duty] ?? statusStations[status];
  }
  if (status === 'planning' && duty === 'director') return dutyStations.director as Tile;
  return statusStations[status];
}

export function zoneAt(col: number, row: number): Zone | undefined {
  return zones.find(
    (zone) =>
      col >= zone.col && col < zone.col + zone.cols && row >= zone.row && row < zone.row + zone.rows,
  );
}

/** Human-readable room name, used for the 「〜室で作業中」 captions. */
export function roomNameFor(status: AgentStatus, duty: AgentDuty): string {
  const station = stationFor(status, duty);
  return zoneAt(station.col, station.row)?.label ?? 'フロア';
}

/**
 * A `[row][col]` map of tiles that can be walked on: inside the walls and not
 * covered by blocking furniture.
 */
export function buildWalkableGrid(): boolean[][] {
  const grid: boolean[][] = [];
  for (let row = 0; row < ROWS; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < COLUMNS; col += 1) {
      line.push(col > 0 && col < COLUMNS - 1 && row > 0 && row < ROWS - 1);
    }
    grid.push(line);
  }
  for (const piece of furniture) {
    if (walkableKinds.has(piece.kind)) continue;
    for (let row = piece.row; row < piece.row + piece.rows; row += 1) {
      for (let col = piece.col; col < piece.col + piece.cols; col += 1) {
        if (grid[row]?.[col] !== undefined) grid[row][col] = false;
      }
    }
  }
  return grid;
}
