import Phaser from 'phaser';

import { useAgentStore } from '../stores/agentStore';
import type { AgentState, AgentStatus } from '../types';
import { AgentSprite } from './AgentSprite';
import { RETRO_FONT } from './fonts';

/**
 * The office is a straight top-down view laid out on a square grid.
 * Every piece of furniture snaps to whole tiles (a desk is 2x1, a locker 1x2),
 * so the floor reads like a tile map rather than a faked perspective.
 */
const TILE = 40;
const COLUMNS = 25;
const ROWS = 15;

const px = (tile: number): number => tile * TILE;
const center = (tile: number, span = 1): number => (tile + span / 2) * TILE;

interface Zone {
  label: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
  floor: number;
  accent: number;
}

const zones: Zone[] = [
  { label: '企画会議室', col: 1, row: 1, cols: 7, rows: 5, floor: 0x9fc4cc, accent: 0x37788a },
  { label: '開発チーム', col: 9, row: 1, cols: 7, rows: 6, floor: 0xd8ac8b, accent: 0xb4573a },
  { label: '資料・研究室', col: 17, row: 1, cols: 7, rows: 5, floor: 0xa9c79c, accent: 0x54804c },
  { label: 'テストラボ', col: 17, row: 7, cols: 7, rows: 5, floor: 0xa3aac6, accent: 0x56658f },
  { label: '休憩スペース', col: 1, row: 8, cols: 6, rows: 6, floor: 0xe0c58c, accent: 0xa76a3a },
  { label: '緊急対応デスク', col: 8, row: 11, cols: 8, rows: 3, floor: 0xd7b3a4, accent: 0x9c4a3c },
  { label: '承認カウンター', col: 17, row: 12, cols: 7, rows: 2, floor: 0xe3cf9a, accent: 0xb98130 },
];

/** Where an agent stands for each status, in tile coordinates. */
const stations: Record<AgentStatus, { col: number; row: number }> = {
  idle: { col: 2, row: 12 },
  planning: { col: 3, row: 4 },
  researching: { col: 19, row: 3 },
  coding: { col: 10, row: 3 },
  running: { col: 19, row: 9 },
  approval: { col: 19, row: 13 },
  done: { col: 4, row: 10 },
  error: { col: 11, row: 12 },
};

export class OfficeScene extends Phaser.Scene {
  private sprites = new Map<string, AgentSprite>();
  private unsubscribe?: () => void;
  /** True between `create()` and shutdown. `sys.isActive()` is still false during create. */
  private live = false;

  constructor() {
    super('office');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#1d2b33');
    // Render the 1000x600 office into a 2x framebuffer. The browser then
    // downsamples it, keeping Phaser text crisp on high-DPI/large windows.
    this.cameras.main.setZoom(2);
    this.cameras.main.centerOn(px(COLUMNS) / 2, px(ROWS) / 2);
    this.drawOffice();
    this.live = true;
    this.syncAgents(useAgentStore.getState().agents, useAgentStore.getState().selectedAgentId);
    this.unsubscribe = useAgentStore.subscribe((state) => {
      if (!this.live) {
        this.teardownStoreSubscription();
        return;
      }
      this.syncAgents(state.agents, state.selectedAgentId);
    });
    this.events.once(
      Phaser.Scenes.Events.SHUTDOWN,
      this.teardownStoreSubscription,
      this,
    );
    this.events.once(
      Phaser.Scenes.Events.DESTROY,
      this.teardownStoreSubscription,
      this,
    );
  }

  private teardownStoreSubscription(): void {
    this.live = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.sprites.clear();
  }

  private drawOffice(): void {
    this.drawFloorAndWalls();
    for (const zone of zones) this.drawZone(zone);
    this.drawFurniture();
    for (const zone of zones) {
      this.roomLabel(zone.col, zone.row, zone.label, zone.accent);
    }
  }

  private drawFloorAndWalls(): void {
    const graphics = this.add.graphics();

    // Base flooring for the whole building.
    graphics.fillStyle(0xcbb289, 1).fillRect(0, 0, px(COLUMNS), px(ROWS));

    // Outer walls: one full tile thick on every side, seen from directly above.
    graphics.fillStyle(0x53687a, 1);
    graphics.fillRect(0, 0, px(COLUMNS), TILE);
    graphics.fillRect(0, px(ROWS - 1), px(COLUMNS), TILE);
    graphics.fillRect(0, 0, TILE, px(ROWS));
    graphics.fillRect(px(COLUMNS - 1), 0, TILE, px(ROWS));
    graphics.fillStyle(0x6f889b, 1);
    graphics.fillRect(TILE - 6, TILE - 6, px(COLUMNS - 2) + 12, 6);
    graphics.fillRect(TILE - 6, px(ROWS - 1), px(COLUMNS - 2) + 12, 6);
    graphics.fillRect(TILE - 6, TILE - 6, 6, px(ROWS - 2) + 12);
    graphics.fillRect(px(COLUMNS - 1), TILE - 6, 6, px(ROWS - 2) + 12);

    // Wall tile seams so the border reads as blocks, not a flat band.
    graphics.lineStyle(1, 0x3d4f5e, 0.7);
    for (let col = 0; col <= COLUMNS; col += 1) {
      graphics.lineBetween(px(col), 0, px(col), TILE);
      graphics.lineBetween(px(col), px(ROWS - 1), px(col), px(ROWS));
    }
    for (let row = 0; row <= ROWS; row += 1) {
      graphics.lineBetween(0, px(row), TILE, px(row));
      graphics.lineBetween(px(COLUMNS - 1), px(row), px(COLUMNS), px(row));
    }

    this.entrance(11, ROWS - 1, 3);
  }

  private drawZone(zone: Zone): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(zone.floor, 1).fillRect(px(zone.col), px(zone.row), px(zone.cols), px(zone.rows));
    // Tile seams inside the room.
    graphics.lineStyle(1, 0x000000, 0.09);
    for (let col = zone.col; col <= zone.col + zone.cols; col += 1) {
      graphics.lineBetween(px(col), px(zone.row), px(col), px(zone.row + zone.rows));
    }
    for (let row = zone.row; row <= zone.row + zone.rows; row += 1) {
      graphics.lineBetween(px(zone.col), px(row), px(zone.col + zone.cols), px(row));
    }
    graphics.lineStyle(3, zone.accent, 0.85)
      .strokeRect(px(zone.col), px(zone.row), px(zone.cols), px(zone.rows));
  }

  private drawFurniture(): void {
    // 企画会議室（1行目の左端は部屋名プレートのために空けておく）
    this.meetingTable(3, 2, 4, 2);
    this.chair(3, 1, 0x37788a, 'down');
    this.chair(4, 1, 0x37788a, 'down');
    this.chair(5, 1, 0x37788a, 'down');
    this.chair(6, 1, 0x37788a, 'down');
    this.chair(3, 4, 0x37788a, 'up');
    this.chair(4, 4, 0x37788a, 'up');
    this.chair(5, 4, 0x37788a, 'up');
    this.chair(6, 4, 0x37788a, 'up');
    this.whiteboard(7, 2, 1, 2);
    this.plant(1, 4);

    // 開発チーム
    this.desk(9, 2, 0xe1775b);
    this.desk(12, 2, 0x65b7d8);
    this.desk(9, 4, 0xf0bd55);
    this.desk(12, 4, 0xb58bd4);
    this.chair(9, 3, 0xb4573a, 'up');
    this.chair(12, 3, 0xb4573a, 'up');
    this.chair(9, 5, 0xb4573a, 'up');
    this.chair(12, 5, 0xb4573a, 'up');
    this.locker(15, 1);
    this.locker(15, 4);
    this.boxStack(14, 6);

    // 資料・研究室（棚は右奥に寄せ、調査担当が立つ中央は空けておく）
    this.bookshelf(21, 2);
    this.bookshelf(22, 2);
    this.filingCabinet(23, 2);
    this.desk(18, 4, 0x54804c);
    this.chair(18, 5, 0x54804c, 'up');
    this.plant(17, 2);
    this.plant(22, 4);

    // テストラボ
    this.desk(18, 8, 0x75d38e);
    this.desk(21, 8, 0x75d38e);
    this.chair(18, 9, 0x56658f, 'up');
    this.chair(21, 9, 0x56658f, 'up');
    this.serverRack(17, 10);
    this.serverRack(23, 7);

    // 休憩スペース
    this.sofa(1, 9, 3);
    this.lowTable(1, 11, 2);
    this.vendingMachine(5, 8);
    this.plant(6, 12);
    this.plant(1, 13);

    // 緊急対応デスク
    this.desk(9, 12, 0xe65d68);
    this.chair(9, 13, 0x9c4a3c, 'up');
    this.boxStack(13, 12);

    // 承認カウンター
    this.counter(20, 12, 3);
    this.noticeBoard(23, 12, 1, 1);
  }

  private addCrispText(
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text {
    const label = this.add.text(x, y, text, {
      ...style,
      resolution: Math.max(2, Math.ceil(window.devicePixelRatio || 1)),
    });
    label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    return label;
  }

  private roomLabel(col: number, row: number, text: string, color: number): void {
    const graphics = this.add.graphics().setDepth(4);
    const width = text.length * 11 + 14;
    const x = px(col) + 5;
    const y = px(row) + 5;
    graphics.fillStyle(color, 0.94).fillRect(x, y, width, 19);
    graphics.lineStyle(2, 0x2f3b34, 0.8).strokeRect(x, y, width, 19);
    this.addCrispText(x + 7, y + 4, text, {
      fontFamily: RETRO_FONT,
      fontSize: '11px',
      color: '#fff7d9',
    }).setDepth(5);
  }

  private entrance(col: number, row: number, cols: number): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(0x8c6a45, 1).fillRect(px(col), px(row), px(cols), TILE);
    graphics.fillStyle(0xbd9159, 1).fillRect(px(col) + 4, px(row) + 4, px(cols) - 8, TILE - 8);
    graphics.lineStyle(2, 0x5d452c, 1).strokeRect(px(col) + 4, px(row) + 4, px(cols) - 8, TILE - 8);
    graphics.lineBetween(center(col, cols), px(row) + 4, center(col, cols), px(row) + TILE - 4);
    this.addCrispText(center(col, cols), px(row) + TILE / 2, 'ENTRANCE', {
      fontFamily: RETRO_FONT,
      fontSize: '9px',
      color: '#42301c',
    }).setOrigin(0.5);
  }

  /** A desk is always 2x1 tiles: monitor at the back edge, keyboard at the front. */
  private desk(col: number, row: number, accent: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    const width = TILE * 2;
    graphics.fillStyle(0x6d4a2b, 1).fillRect(x, y, width, TILE);
    graphics.fillStyle(0xa97644, 1).fillRect(x + 3, y + 3, width - 6, TILE - 6);
    graphics.lineStyle(2, 0x54371f, 1).strokeRect(x, y, width, TILE);

    // Monitor seen from above: a thin dark slab plus its glowing top edge.
    graphics.fillStyle(0x27343a, 1).fillRect(x + 8, y + 6, 26, 9);
    graphics.fillStyle(accent, 1).fillRect(x + 10, y + 8, 22, 4);
    // Keyboard and mouse.
    graphics.fillStyle(0xe4dcc6, 1).fillRect(x + 8, y + 22, 26, 10);
    graphics.fillStyle(0x8d8674, 1).fillRect(x + 11, y + 25, 20, 4);
    graphics.fillStyle(0xf1e7cd, 1).fillRect(x + 38, y + 24, 7, 8);
    // Papers and a mug on the second tile.
    graphics.fillStyle(0xf6f0dc, 1).fillRect(x + 50, y + 8, 18, 14);
    graphics.lineStyle(1, 0xbfae8b, 1).strokeRect(x + 50, y + 8, 18, 14);
    graphics.fillStyle(0xd9603f, 1).fillCircle(x + 68, y + 29, 6);
    graphics.fillStyle(0xf3c8a5, 1).fillCircle(x + 68, y + 29, 3);
  }

  /** 1x1 chair. `facing` marks which edge the backrest sits on. */
  private chair(col: number, row: number, color: number, facing: 'up' | 'down'): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x2f2924, 1).fillRect(x + 7, y + 7, 26, 26);
    graphics.fillStyle(color, 1).fillRect(x + 10, y + 10, 20, 20);
    graphics.fillStyle(0x22282c, 1);
    if (facing === 'up') graphics.fillRect(x + 7, y + 28, 26, 6);
    else graphics.fillRect(x + 7, y + 6, 26, 6);
  }

  private meetingTable(col: number, row: number, cols: number, rows: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    const width = px(cols);
    const height = px(rows);
    graphics.fillStyle(0x6a4326, 1).fillRect(x, y, width, height);
    graphics.fillStyle(0xa87a48, 1).fillRect(x + 4, y + 4, width - 8, height - 8);
    graphics.lineStyle(2, 0x54371f, 1).strokeRect(x, y, width, height);
    graphics.fillStyle(0xf6f0dc, 1).fillRect(x + 16, y + 14, 22, 16).fillRect(x + width - 46, y + 30, 24, 17);
    graphics.fillStyle(0x4f8a9c, 1).fillRect(x + width / 2 - 14, y + height / 2 - 10, 28, 20);
    graphics.fillStyle(0x9fd7e4, 1).fillRect(x + width / 2 - 10, y + height / 2 - 6, 20, 12);
  }

  /** 1x2 locker column with two doors. */
  private locker(col: number, row: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x3f5763, 1).fillRect(x, y, TILE, TILE * 2);
    graphics.lineStyle(2, 0x2b3c45, 1).strokeRect(x, y, TILE, TILE * 2);
    for (let door = 0; door < 2; door += 1) {
      const doorY = y + 4 + door * TILE;
      graphics.fillStyle(0x6d8b99, 1).fillRect(x + 4, doorY, TILE - 8, TILE - 8);
      graphics.fillStyle(0x27363d, 1).fillRect(x + TILE - 13, doorY + 12, 5, 10);
      graphics.fillStyle(0xd7e2e6, 1).fillRect(x + 10, doorY + 5, 12, 3);
    }
  }

  /** 1x2 bookshelf packed with colour-coded spines. */
  private bookshelf(col: number, row: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x4c3222, 1).fillRect(x, y, TILE, TILE * 2);
    graphics.lineStyle(2, 0x33210f, 1).strokeRect(x, y, TILE, TILE * 2);
    const spines = [0xc75e52, 0xd09b4c, 0x5e91a4, 0x769160, 0xb07fb5];
    for (let shelf = 0; shelf < 4; shelf += 1) {
      const shelfY = y + 4 + shelf * 19;
      graphics.fillStyle(0x2f2620, 1).fillRect(x + 4, shelfY, TILE - 8, 15);
      for (let book = 0; book < 5; book += 1) {
        graphics
          .fillStyle(spines[(shelf + book) % spines.length], 1)
          .fillRect(x + 6 + book * 6, shelfY + 2, 4, 11);
      }
    }
  }

  private filingCabinet(col: number, row: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x47626b, 1).fillRect(x, y, TILE, TILE * 2);
    graphics.lineStyle(2, 0x2c4149, 1).strokeRect(x, y, TILE, TILE * 2);
    for (let drawer = 0; drawer < 4; drawer += 1) {
      const drawerY = y + 5 + drawer * 18;
      graphics.fillStyle(0x7d99a1, 1).fillRect(x + 5, drawerY, TILE - 10, 14);
      graphics.fillStyle(0x293d44, 1).fillRect(x + 14, drawerY + 5, 12, 4);
    }
  }

  private serverRack(col: number, row: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x22303a, 1).fillRect(x, y, TILE, TILE * 2);
    graphics.lineStyle(2, 0x121b21, 1).strokeRect(x, y, TILE, TILE * 2);
    for (let unit = 0; unit < 6; unit += 1) {
      const unitY = y + 5 + unit * 12;
      graphics.fillStyle(0x3b4d59, 1).fillRect(x + 4, unitY, TILE - 8, 9);
      graphics.fillStyle(unit % 2 === 0 ? 0x75d38e : 0xf0bd55, 1).fillRect(x + 7, unitY + 3, 4, 3);
      graphics.fillStyle(0x65b7d8, 1).fillRect(x + 14, unitY + 3, 4, 3);
    }
  }

  private whiteboard(col: number, row: number, cols: number, rows: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x8a6a3f, 1).fillRect(x, y, px(cols), px(rows));
    graphics.fillStyle(0xf6f4e6, 1).fillRect(x + 5, y + 5, px(cols) - 10, px(rows) - 10);
    graphics.lineStyle(2, 0x5c451f, 1).strokeRect(x, y, px(cols), px(rows));
    graphics.fillStyle(0x4f8a9c, 1).fillRect(x + 10, y + 14, 20, 4).fillRect(x + 10, y + 26, 14, 4);
    graphics.fillStyle(0xd9603f, 1).fillRect(x + 10, y + 40, 18, 4);
  }

  private noticeBoard(col: number, row: number, cols: number, rows: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x5b3c23, 1).fillRect(x, y, px(cols), px(rows));
    graphics.fillStyle(0xe8d49b, 1).fillRect(x + 4, y + 4, px(cols) - 8, px(rows) - 8);
    graphics.fillStyle(0xe65d68, 1).fillRect(x + 8, y + 9, 11, 11);
    graphics.fillStyle(0xf0bd55, 1).fillRect(x + 22, y + 9, 11, 11);
    graphics.fillStyle(0x65b7d8, 1).fillRect(x + 8, y + 24, 25, 7);
  }

  private counter(col: number, row: number, cols: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x7a5330, 1).fillRect(x, y, px(cols), TILE);
    graphics.fillStyle(0xc79a5f, 1).fillRect(x + 3, y + 3, px(cols) - 6, TILE - 6);
    graphics.lineStyle(2, 0x543619, 1).strokeRect(x, y, px(cols), TILE);
    graphics.fillStyle(0xf6f0dc, 1).fillRect(x + 12, y + 12, 20, 15);
    graphics.fillStyle(0xe65d68, 1).fillRect(x + px(cols) - 34, y + 14, 16, 12);
    graphics.fillStyle(0x2c3b42, 1).fillRect(x + px(cols) / 2 - 8, y + 13, 16, 13);
  }

  private sofa(col: number, row: number, cols: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x69442e, 1).fillRect(x, y, px(cols), TILE);
    graphics.lineStyle(2, 0x4a2f1e, 1).strokeRect(x, y, px(cols), TILE);
    graphics.fillStyle(0xc27f4d, 1).fillRect(x + 4, y + 10, px(cols) - 8, TILE - 14);
    for (let cushion = 0; cushion < cols; cushion += 1) {
      graphics
        .fillStyle(0xd79a60, 1)
        .fillRect(x + 8 + cushion * TILE, y + 14, TILE - 16, TILE - 22);
    }
  }

  private lowTable(col: number, row: number, cols: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x6d4a2b, 1).fillRect(x + 3, y + 6, px(cols) - 6, TILE - 12);
    graphics.fillStyle(0xb98a54, 1).fillRect(x + 6, y + 9, px(cols) - 12, TILE - 18);
    graphics.fillStyle(0xf4ead0, 1).fillRect(x + 12, y + 14, 12, 10);
    graphics.fillStyle(0x8a5a3a, 1).fillCircle(x + px(cols) - 18, y + TILE / 2, 6);
  }

  private vendingMachine(col: number, row: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x2f5a6b, 1).fillRect(x, y, TILE, TILE * 2);
    graphics.lineStyle(2, 0x1c3a47, 1).strokeRect(x, y, TILE, TILE * 2);
    graphics.fillStyle(0x8fd0e2, 1).fillRect(x + 5, y + 5, TILE - 10, 44);
    for (let slot = 0; slot < 6; slot += 1) {
      graphics
        .fillStyle([0xe65d68, 0xf0bd55, 0x78b56c][slot % 3], 1)
        .fillRect(x + 8 + (slot % 3) * 9, y + 9 + Math.floor(slot / 3) * 18, 7, 14);
    }
    graphics.fillStyle(0x17262d, 1).fillRect(x + 8, y + 56, TILE - 16, 16);
  }

  private plant(col: number, row: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const cx = center(col);
    const cy = center(row);
    graphics.fillStyle(0x7b4d2b, 1).fillRect(cx - 11, cy - 11, 22, 22);
    graphics.fillStyle(0x4d8a4f, 1).fillCircle(cx, cy, 13);
    graphics.fillStyle(0x67a95f, 1).fillCircle(cx - 5, cy - 4, 7).fillCircle(cx + 6, cy + 3, 6);
  }

  private boxStack(col: number, row: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x9d6a3d, 1).fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
    graphics.lineStyle(2, 0x6f4826, 1).strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
    graphics.fillStyle(0xc18a51, 1).fillRect(x + 8, y + 8, TILE - 16, TILE - 16);
    graphics.fillStyle(0xe2c185, 1).fillRect(x + TILE / 2 - 3, y + 3, 6, TILE - 6);
  }

  private syncAgents(agents: AgentState[], selectedId: string): void {
    if (!this.live) return;
    const live = new Set(agents.map((agent) => agent.id));
    for (const [id, sprite] of this.sprites) {
      if (!live.has(id)) {
        sprite.destroy();
        this.sprites.delete(id);
      }
    }

    // Agents queue up on whole tiles so nobody overlaps and everyone stays on grid.
    const perStatus = new Map<AgentStatus, number>();
    agents.forEach((agent) => {
      const slot = perStatus.get(agent.status) ?? 0;
      perStatus.set(agent.status, slot + 1);
      const station = stations[agent.status];
      const col = Phaser.Math.Clamp(station.col + (slot % 3) - 1, 1, COLUMNS - 2);
      const row = Phaser.Math.Clamp(station.row + Math.floor(slot / 3), 1, ROWS - 2);

      let sprite = this.sprites.get(agent.id);
      if (!sprite) {
        sprite = new AgentSprite(this, agent, center(11, 3), center(ROWS - 2));
        sprite.on('agent-selected', (id: string) => useAgentStore.getState().selectAgent(id));
        this.sprites.set(agent.id, sprite);
      }
      sprite.updateAgent(agent);
      sprite.setSelected(agent.id === selectedId);
      sprite.walkTo(center(col), center(row));
    });
  }
}
