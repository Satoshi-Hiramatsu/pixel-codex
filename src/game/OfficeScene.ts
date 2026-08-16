import Phaser from 'phaser';

import { useAgentStore } from '../stores/agentStore';
import type { AgentState } from '../types';
import { AgentSprite } from './AgentSprite';
import { RETRO_FONT, textResolutionFor } from './fonts';
import {
  buildWalkableGrid,
  center,
  COLUMNS,
  doorTile,
  entrance,
  furniture,
  px,
  ROWS,
  stationFacingFor,
  stationFor,
  TILE,
  zones,
  type Furniture,
  type StationFacing,
  type Tile,
  type Zone,
} from './officeLayout';
import { findFreeTile, findPath, tileKey } from './pathfinding';
import {
  lightenPixelColor,
  PIXEL_PALETTE,
  PIXEL_UNIT,
  shadePixelColor,
} from './pixelArt';

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
    graphics.fillStyle(PIXEL_PALETTE.floor, 1).fillRect(0, 0, px(COLUMNS), px(ROWS));

    // 廊下の床板。半透明やディザではなく、2px単位の不透明な差分で質感を出します。
    for (let row = 1; row < ROWS - 1; row += 1) {
      for (let col = 1; col < COLUMNS - 1; col += 1) {
        const x = px(col);
        const y = px(row);
        const light = (row + col) % 3 === 0
          ? PIXEL_PALETTE.floorLight
          : lightenPixelColor(PIXEL_PALETTE.floor, 0.05);
        graphics.fillStyle(light, 1).fillRect(x + 2, y + 2, TILE - 4, PIXEL_UNIT);
        graphics
          .fillStyle(PIXEL_PALETTE.floorShade, 1)
          .fillRect(x + TILE - 2, y + 4, PIXEL_UNIT, TILE - 6);
      }
    }

    // Outer walls: one full tile thick on every side, seen from directly above.
    graphics.fillStyle(PIXEL_PALETTE.wall, 1);
    graphics.fillRect(0, 0, px(COLUMNS), TILE);
    graphics.fillRect(0, px(ROWS - 1), px(COLUMNS), TILE);
    graphics.fillRect(0, 0, TILE, px(ROWS));
    graphics.fillRect(px(COLUMNS - 1), 0, TILE, px(ROWS));
    // 左上の明るい縁と右下の影で、壁の厚みを明確にします。
    graphics.fillStyle(PIXEL_PALETTE.wallLight, 1);
    graphics.fillRect(0, 0, px(COLUMNS), 4);
    graphics.fillRect(0, 0, 4, px(ROWS));
    graphics.fillRect(TILE - 4, TILE - 4, px(COLUMNS - 2) + 8, 4);
    graphics.fillRect(TILE - 4, TILE - 4, 4, px(ROWS - 2) + 8);
    graphics.fillStyle(PIXEL_PALETTE.wallShade, 1);
    graphics.fillRect(0, TILE - 4, px(COLUMNS), 4);
    graphics.fillRect(px(COLUMNS - 1), 0, 4, px(ROWS));
    graphics.fillRect(TILE - 4, px(ROWS - 1), px(COLUMNS - 2) + 8, 4);
    graphics.fillRect(px(COLUMNS - 1), TILE - 4, 4, px(ROWS - 2) + 8);

    // Wall tile seams so the border reads as blocks, not a flat band.
    graphics.lineStyle(2, PIXEL_PALETTE.wallShade, 1);
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
    const floorLight = lightenPixelColor(zone.floor, 0.08);
    const floorShade = shadePixelColor(zone.floor, 0.12);
    for (let row = zone.row; row < zone.row + zone.rows; row += 1) {
      for (let col = zone.col; col < zone.col + zone.cols; col += 1) {
        const x = px(col);
        const y = px(row);
        graphics.fillStyle(floorLight, 1).fillRect(x + 2, y + 2, TILE - 4, PIXEL_UNIT);
        graphics.fillStyle(floorShade, 1).fillRect(x + TILE - 2, y + 4, PIXEL_UNIT, TILE - 6);
        if ((row * 5 + col * 3) % 7 === 0) {
          graphics.fillStyle(floorShade, 1).fillRect(x + 8, y + 28, 8, PIXEL_UNIT);
        }
      }
    }
    graphics
      .lineStyle(4, shadePixelColor(zone.accent, 0.22), 1)
      .strokeRect(px(zone.col), px(zone.row), px(zone.cols), px(zone.rows));
    graphics
      .lineStyle(2, lightenPixelColor(zone.accent, 0.22), 1)
      .strokeRect(px(zone.col) + 4, px(zone.row) + 4, px(zone.cols) - 8, px(zone.rows) - 8);
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

  /** 家具の右下へ4pxだけ落とす、共通のハードエッジ影。 */
  private furnitureShadow(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    graphics
      .fillStyle(PIXEL_PALETTE.deepShadow, 0.22)
      .fillRect(x + 4, y + 4, width, height);
  }

  /** A desk is `cols` tiles wide: monitor at the back edge, keyboard at the front. */
  private desk(col: number, row: number, cols: number, accent: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    const width = px(cols);
    this.furnitureShadow(graphics, x, y, width, TILE);
    graphics.fillStyle(PIXEL_PALETTE.woodShade, 1).fillRect(x, y, width, TILE);
    graphics.fillStyle(PIXEL_PALETTE.wood, 1).fillRect(x + 2, y + 2, width - 4, TILE - 8);
    graphics.fillStyle(PIXEL_PALETTE.woodLight, 1).fillRect(x + 4, y + 4, width - 8, 4);
    graphics.fillStyle(PIXEL_PALETTE.woodShade, 1).fillRect(x + 4, y + TILE - 8, width - 8, 6);
    graphics.lineStyle(2, PIXEL_PALETTE.outline, 1).strokeRect(x, y, width, TILE);

    // モニターは枠、画面、スタンドを分けて厚みを出します。
    graphics.fillStyle(PIXEL_PALETTE.outline, 1).fillRect(x + 8, y + 8, 28, 12);
    graphics.fillStyle(shadePixelColor(accent, 0.18), 1).fillRect(x + 10, y + 10, 24, 8);
    graphics.fillStyle(lightenPixelColor(accent, 0.28), 1).fillRect(x + 12, y + 10, 16, 2);
    graphics.fillStyle(PIXEL_PALETTE.metalShade, 1).fillRect(x + 20, y + 20, 4, 4);
    // Keyboard and mouse.
    graphics.fillStyle(PIXEL_PALETTE.paperShade, 1).fillRect(x + 8, y + 26, 28, 8);
    graphics.fillStyle(PIXEL_PALETTE.paperLight, 1).fillRect(x + 10, y + 26, 24, 2);
    for (let key = 0; key < 6; key += 1) {
      graphics.fillStyle(PIXEL_PALETTE.metalShade, 1).fillRect(x + 10 + key * 4, y + 30, 2, 2);
    }
    graphics.fillStyle(PIXEL_PALETTE.paperLight, 1).fillRect(x + 40, y + 26, 6, 8);
    graphics.fillStyle(PIXEL_PALETTE.paperShade, 1).fillRect(x + 42, y + 28, 2, 2);
    // Papers and a mug on the second tile.
    graphics.fillStyle(PIXEL_PALETTE.paperShade, 1).fillRect(x + 52, y + 10, 18, 14);
    graphics.fillStyle(PIXEL_PALETTE.paperLight, 1).fillRect(x + 50, y + 8, 18, 14);
    graphics.fillStyle(PIXEL_PALETTE.paperShade, 1).fillRect(x + 54, y + 12, 10, 2);
    graphics.fillStyle(0xd9603f, 1).fillRect(x + 64, y + 28, 10, 8);
    graphics.fillStyle(0xf3c8a5, 1).fillRect(x + 66, y + 30, 6, 4);
    graphics.fillStyle(0xd9603f, 1).fillRect(x + 74, y + 30, 2, 4);
    if (cols > 2) {
      graphics.fillStyle(PIXEL_PALETTE.outline, 1).fillRect(x + width - 36, y + 8, 26, 20);
      graphics.fillStyle(PIXEL_PALETTE.screen, 1).fillRect(x + width - 32, y + 12, 18, 12);
      graphics.fillStyle(PIXEL_PALETTE.screenLight, 1).fillRect(x + width - 30, y + 14, 10, 2);
    }
  }

  /** 1x1 chair. `facing` marks which edge the backrest sits on. */
  private chair(col: number, row: number, color: number, facing: 'up' | 'down'): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    this.furnitureShadow(graphics, x + 8, y + 8, 24, 24);
    graphics.fillStyle(PIXEL_PALETTE.outline, 1).fillRect(x + 6, y + 6, 28, 28);
    graphics.fillStyle(shadePixelColor(color, 0.14), 1).fillRect(x + 8, y + 8, 24, 24);
    graphics.fillStyle(lightenPixelColor(color, 0.2), 1).fillRect(x + 10, y + 10, 20, 6);
    graphics.fillStyle(PIXEL_PALETTE.outline, 1);
    if (facing === 'up') graphics.fillRect(x + 6, y + 28, 28, 6);
    else graphics.fillRect(x + 6, y + 6, 28, 6);
    graphics.fillRect(x + 18, y + 34, 4, 4).fillRect(x + 10, y + 36, 6, 2).fillRect(x + 24, y + 36, 6, 2);
  }

  private meetingTable(col: number, row: number, cols: number, rows: number): void {
    const graphics = this.add.graphics().setDepth(2);
    const x = px(col);
    const y = px(row);
    const width = px(cols);
    const height = px(rows);
    this.furnitureShadow(graphics, x, y, width, height);
    graphics.fillStyle(PIXEL_PALETTE.woodShade, 1).fillRect(x, y, width, height);
    graphics.fillStyle(PIXEL_PALETTE.wood, 1).fillRect(x + 4, y + 4, width - 8, height - 10);
    graphics.fillStyle(PIXEL_PALETTE.woodLight, 1).fillRect(x + 6, y + 6, width - 12, 4);
    graphics.fillStyle(PIXEL_PALETTE.woodShade, 1).fillRect(x + 6, y + height - 10, width - 12, 6);
    graphics.lineStyle(2, PIXEL_PALETTE.outline, 1).strokeRect(x, y, width, height);
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
    this.furnitureShadow(graphics, x, y, TILE, TILE * 2);
    graphics.fillStyle(PIXEL_PALETTE.woodShade, 1).fillRect(x, y, TILE, TILE * 2);
    graphics.fillStyle(PIXEL_PALETTE.woodLight, 1).fillRect(x + 2, y + 2, 4, TILE * 2 - 4);
    graphics.lineStyle(2, PIXEL_PALETTE.outline, 1).strokeRect(x, y, TILE, TILE * 2);
    const spines = [0xc75e52, 0xd09b4c, 0x5e91a4, 0x769160, 0xb07fb5];
    for (let shelf = 0; shelf < 4; shelf += 1) {
      const shelfY = y + 4 + shelf * 19;
      graphics.fillStyle(PIXEL_PALETTE.outline, 1).fillRect(x + 4, shelfY, TILE - 8, 16);
      for (let book = 0; book < 5; book += 1) {
        graphics
          .fillStyle(spines[(shelf + book) % spines.length], 1)
          .fillRect(x + 6 + book * 6, shelfY + 2 + ((shelf + book) % 2) * 2, 4, 12 - ((shelf + book) % 2) * 2);
      }
      graphics.fillStyle(PIXEL_PALETTE.woodLight, 1).fillRect(x + 4, shelfY + 14, TILE - 8, 2);
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
    const lights = this.add.graphics().setDepth(3);
    const x = px(col);
    const y = px(row);
    this.furnitureShadow(graphics, x, y, TILE, TILE * 2);
    graphics.fillStyle(PIXEL_PALETTE.outline, 1).fillRect(x, y, TILE, TILE * 2);
    graphics.fillStyle(PIXEL_PALETTE.metalShade, 1).fillRect(x + 2, y + 2, TILE - 4, TILE * 2 - 4);
    graphics.fillStyle(PIXEL_PALETTE.metal, 1).fillRect(x + 4, y + 4, 4, TILE * 2 - 8);
    for (let unit = 0; unit < 6; unit += 1) {
      const unitY = y + 6 + unit * 12;
      graphics.fillStyle(0x26363e, 1).fillRect(x + 6, unitY, TILE - 12, 8);
      graphics.fillStyle(PIXEL_PALETTE.metal, 1).fillRect(x + 22, unitY + 2, 8, 2);
      lights
        .fillStyle(unit % 2 === 0 ? PIXEL_PALETTE.success : PIXEL_PALETTE.warning, 1)
        .fillRect(x + 8, unitY + 2, 4, 4);
      lights.fillStyle(PIXEL_PALETTE.screen, 1).fillRect(x + 14, unitY + 2, 4, 4);
    }
    this.tweens.add({ targets: lights, alpha: 0.42, duration: 620, yoyo: true, repeat: -1 });
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
    this.furnitureShadow(graphics, x, y, px(cols), TILE);
    graphics.fillStyle(PIXEL_PALETTE.outline, 1).fillRect(x, y, px(cols), TILE);
    graphics.fillStyle(0x9a5f3f, 1).fillRect(x + 2, y + 2, px(cols) - 4, TILE - 4);
    graphics.fillStyle(0xc27f4d, 1).fillRect(x + 4, y + 10, px(cols) - 8, TILE - 14);
    graphics.fillStyle(0xe0a46c, 1).fillRect(x + 6, y + 6, px(cols) - 12, 6);
    for (let cushion = 0; cushion < cols; cushion += 1) {
      graphics
        .fillStyle(0xd79a60, 1)
        .fillRect(x + 8 + cushion * TILE, y + 14, TILE - 16, TILE - 22);
      graphics
        .fillStyle(0xb66f48, 1)
        .fillRect(x + 8 + cushion * TILE, y + TILE - 10, TILE - 16, 4);
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
    this.furnitureShadow(graphics, cx - 12, cy - 12, 24, 24);
    graphics.fillStyle(PIXEL_PALETTE.woodShade, 1).fillRect(cx - 12, cy - 12, 24, 24);
    graphics.fillStyle(PIXEL_PALETTE.wood, 1).fillRect(cx - 8, cy - 8, 16, 16);
    // 円ではなく2px矩形で葉を構成し、他の家具とピクセル密度をそろえます。
    graphics.fillStyle(PIXEL_PALETTE.leafShade, 1).fillRect(cx - 12, cy - 6, 24, 14);
    graphics.fillStyle(PIXEL_PALETTE.leaf, 1)
      .fillRect(cx - 8, cy - 12, 10, 20)
      .fillRect(cx + 2, cy - 8, 12, 12)
      .fillRect(cx - 14, cy - 4, 10, 10);
    graphics.fillStyle(PIXEL_PALETTE.leafLight, 1)
      .fillRect(cx - 6, cy - 10, 6, 6)
      .fillRect(cx + 4, cy - 6, 6, 4);
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
    const targetFacings = new Map<string, StationFacing>();
    let loungeSeat = 0;
    for (const agent of agents) {
      const presence = agent.presence ?? 'working';
      // 退勤する人は玄関へ。もうフロアにいないので、席は確保しません。
      if (presence === 'left') {
        targets.set(agent.id, doorTile);
        targetFacings.set(agent.id, 'down');
        continue;
      }
      const seat = loungeSeat;
      const preferred = stationFor(agent.status, agent.duty, presence, seat);
      targetFacings.set(agent.id, stationFacingFor(presence, seat));
      if (presence === 'lounge') loungeSeat += 1;
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
      this.routeTo(
        sprite,
        agent.id,
        target,
        targets,
        targetFacings.get(agent.id) ?? 'up',
      );
    }
  }

  /** 他の社員を障害物として避けながら、目的タイルまでの経路を渡します。 */
  private routeTo(
    sprite: AgentSprite,
    agentId: string,
    target: Tile,
    targets: Map<string, Tile>,
    finalFacing: StationFacing,
  ): void {
    const from = sprite.currentTile;
    const already = sprite.targetTile;
    if (already.col === target.col && already.row === target.row) {
      if (!sprite.walking && from.col === target.col && from.row === target.row) {
        sprite.setFacing(finalFacing);
      }
      return;
    }
    if (from.col === target.col && from.row === target.row) {
      sprite.setFacing(finalFacing);
      return;
    }

    const blocked = new Set<number>();
    for (const [otherId, otherSprite] of this.sprites) {
      if (otherId === agentId) continue;
      // 退勤した人はフロアにいないので、通り道として数えます。
      if (otherSprite.departed) continue;
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
      sprite.snapTo(target, finalFacing);
      return;
    }
    sprite.walkPath(path, finalFacing);
  }
}
