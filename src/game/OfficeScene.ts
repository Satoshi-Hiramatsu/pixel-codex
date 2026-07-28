import Phaser from 'phaser';

import { useAgentStore } from '../stores/agentStore';
import type { AgentState } from '../types';
import { AgentSprite } from './AgentSprite';
import { RETRO_FONT, textResolutionFor } from './fonts';
import {
  buildWalkableGrid,
  center,
  COLUMNS,
  entrance,
  furniture,
  px,
  ROWS,
  stationFor,
  TILE,
  zones,
  type Furniture,
  type Tile,
  type Zone,
} from './officeLayout';
import { findFreeTile, findPath, tileKey } from './pathfinding';

export class OfficeScene extends Phaser.Scene {
  private sprites = new Map<string, AgentSprite>();
  private unsubscribe?: () => void;
  /** True between `create()` and shutdown. `sys.isActive()` is still false during create. */
  private live = false;
  private walkable: boolean[][] = buildWalkableGrid();

  constructor() {
    super('office');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#1d2b33');
    // The framebuffer is sized to the panel's real device pixels, so matching
    // the zoom to it draws the office 1:1 — no resampling, no blurred text.
    this.applyCameraFit();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.applyCameraFit, this);
    this.walkable = buildWalkableGrid();
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
    this.scale.off(Phaser.Scale.Events.RESIZE, this.applyCameraFit, this);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.sprites.clear();
  }

  /** Fits the fixed 1000x600 world into whatever framebuffer we were given. */
  private applyCameraFit(): void {
    const worldWidth = px(COLUMNS);
    const worldHeight = px(ROWS);
    const zoom = Math.min(this.scale.width / worldWidth, this.scale.height / worldHeight);
    this.cameras.main.setZoom(zoom || 1);
    this.cameras.main.centerOn(worldWidth / 2, worldHeight / 2);
  }

  private drawOffice(): void {
    this.drawFloorAndWalls();
    for (const zone of zones) this.drawZone(zone);
    for (const piece of furniture) this.drawFurniture(piece);
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

    this.drawEntrance(entrance.col, entrance.row, entrance.cols);
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

  /** Every piece of furniture is declared in `officeLayout`, so drawing is a lookup. */
  private drawFurniture(piece: Furniture): void {
    switch (piece.kind) {
      case 'desk':
      case 'deskWide':
        this.desk(piece.col, piece.row, piece.cols, piece.accent ?? 0x65b7d8);
        break;
      case 'chair':
        this.chair(piece.col, piece.row, piece.accent ?? 0x37788a, piece.facing ?? 'up');
        break;
      case 'meetingTable':
        this.meetingTable(piece.col, piece.row, piece.cols, piece.rows);
        break;
      case 'whiteboard':
        this.whiteboard(piece.col, piece.row, piece.cols, piece.rows);
        break;
      case 'noticeBoard':
        this.noticeBoard(piece.col, piece.row, piece.cols, piece.rows);
        break;
      case 'progressBoard':
        this.progressBoard(piece.col, piece.row, piece.cols, piece.rows);
        break;
      case 'locker':
        this.locker(piece.col, piece.row);
        break;
      case 'bookshelf':
        this.bookshelf(piece.col, piece.row);
        break;
      case 'filingCabinet':
        this.filingCabinet(piece.col, piece.row);
        break;
      case 'serverRack':
        this.serverRack(piece.col, piece.row);
        break;
      case 'counter':
        this.counter(piece.col, piece.row, piece.cols);
        break;
      case 'sofa':
        this.sofa(piece.col, piece.row, piece.cols);
        break;
      case 'lowTable':
        this.lowTable(piece.col, piece.row, piece.cols);
        break;
      case 'vendingMachine':
        this.vendingMachine(piece.col, piece.row);
        break;
      case 'plant':
        this.plant(piece.col, piece.row);
        break;
      case 'boxStack':
        this.boxStack(piece.col, piece.row);
        break;
      case 'safe':
        this.safe(piece.col, piece.row);
        break;
      default:
        break;
    }
  }

  private addCrispText(
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text {
    const label = this.add.text(x, y, text, {
      ...style,
      resolution: textResolutionFor(this),
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

  private drawEntrance(col: number, row: number, cols: number): void {
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

  /** A desk is `cols` tiles wide: monitor at the back edge, keyboard at the front. */
  private desk(col: number, row: number, cols: number, accent: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    const width = px(cols);
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
    if (cols > 2) {
      graphics.fillStyle(0x2c3b42, 1).fillRect(x + width - 34, y + 9, 24, 18);
      graphics.fillStyle(0x9fd7e4, 1).fillRect(x + width - 30, y + 12, 16, 12);
    }
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

  /** 進行表の掲示板。ロードマップが貼り出される場所として描いています。 */
  private progressBoard(col: number, row: number, cols: number, rows: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    const width = px(cols);
    const height = px(rows);
    graphics.fillStyle(0x3c2b1b, 1).fillRect(x, y, width, height);
    graphics.fillStyle(0x1f4a3c, 1).fillRect(x + 4, y + 4, width - 8, height - 8);
    graphics.lineStyle(2, 0x8a6a3f, 1).strokeRect(x + 4, y + 4, width - 8, height - 8);
    const rowCount = Math.max(2, Math.floor((height - 22) / 11));
    for (let line = 0; line < rowCount; line += 1) {
      const lineY = y + 14 + line * 11;
      graphics.fillStyle(0xf0e6c0, 0.85).fillRect(x + 10, lineY, 6, 5);
      graphics.fillStyle(0xdfd7b4, 0.7).fillRect(x + 19, lineY + 1, width - 32, 3);
    }
    if (cols > 1) {
      this.addCrispText(x + width / 2, y + 8, '進行表', {
        fontFamily: RETRO_FONT,
        fontSize: '9px',
        color: '#ffe9a8',
      }).setOrigin(0.5, 0).setDepth(3);
    }
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

  /** 経理室の金庫。トークン費用の管理を担当する部屋の目印です。 */
  private safe(col: number, row: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    graphics.fillStyle(0x3a3346, 1).fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
    graphics.lineStyle(2, 0x231f2e, 1).strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
    graphics.fillStyle(0x5b5175, 1).fillRect(x + 7, y + 7, TILE - 14, TILE - 14);
    graphics.fillStyle(0xf0bd55, 1).fillCircle(x + TILE / 2, y + TILE / 2, 5);
    graphics.fillStyle(0x231f2e, 1).fillRect(x + TILE / 2 - 1, y + TILE / 2 - 7, 2, 14);
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

    // 目的タイルは先に全員ぶん決めます。こうすることで、同じ席を二人が
    // 取り合ったり、すでに座っている人の上に重なったりしなくなります。
    const claimed = new Set<number>();
    const targets = new Map<string, Tile>();
    for (const agent of agents) {
      const preferred = stationFor(agent.status, agent.duty);
      const target = findFreeTile(this.walkable, preferred, claimed);
      claimed.add(tileKey(target.col, target.row));
      targets.set(agent.id, target);
    }

    for (const agent of agents) {
      const target = targets.get(agent.id) as Tile;
      let sprite = this.sprites.get(agent.id);
      if (!sprite) {
        // 新入社員は入口から歩いて入ってきます。
        const doorTile = { col: entrance.col + 1, row: entrance.row - 1 };
        sprite = new AgentSprite(this, agent, doorTile);
        sprite.on('agent-selected', (id: string) => useAgentStore.getState().selectAgent(id));
        this.sprites.set(agent.id, sprite);
      }
      sprite.updateAgent(agent);
      sprite.setSelected(agent.id === selectedId);
      this.routeTo(sprite, agent.id, target, targets);
    }
  }

  /** 他の社員を障害物として避けながら、目的タイルまでの経路を渡します。 */
  private routeTo(
    sprite: AgentSprite,
    agentId: string,
    target: Tile,
    targets: Map<string, Tile>,
  ): void {
    const from = sprite.currentTile;
    const already = sprite.targetTile;
    if (already.col === target.col && already.row === target.row) return;
    if (from.col === target.col && from.row === target.row) return;

    const blocked = new Set<number>();
    for (const [otherId, otherSprite] of this.sprites) {
      if (otherId === agentId) continue;
      // 立ち止まっている人は動かないので確実な障害物。歩いている人は
      // すれ違えるように、目的地だけを避けます。
      const otherTarget = targets.get(otherId) ?? otherSprite.targetTile;
      blocked.add(tileKey(otherTarget.col, otherTarget.row));
      if (!otherSprite.walking) {
        blocked.add(tileKey(otherSprite.currentTile.col, otherSprite.currentTile.row));
      }
    }

    const path =
      findPath(this.walkable, from, target, { blocked })
      // 同僚に囲まれて通れないときは、家具だけを避けて通ります。
      ?? findPath(this.walkable, from, target);
    if (!path) {
      sprite.snapTo(target);
      return;
    }
    sprite.walkPath(path);
  }
}
