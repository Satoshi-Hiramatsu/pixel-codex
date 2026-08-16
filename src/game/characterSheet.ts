import Phaser from 'phaser';

import { AGENT_SHEET_PALETTE, AGENT_SHEET_PNGS, type SheetPalette } from '../assets/agentSheet';
import type { AgentDuty } from '../types';
import { PIXEL_PALETTE, PIXEL_UNIT } from './pixelArt';

/**
 * 4方向スプライトの土台。
 *
 * 絵のならびは市販のキャラチップ（LPC / ぴぽや形式）と同じで、
 *
 *   列 = アニメのコマ（0:直立 / 1:右足前 / 2:左足前）
 *   行 = 向き（0:正面 down / 1:左 left / 2:右 right / 3:背面 up）
 *
 * 1コマ 64×64、シート全体で 256×256 です。
 *
 * ■ 絵の出どころ（マスターシート）
 *   全担当が `assets/sprites/*-sheet.png` の専用画像を使います。画像を読めない場合だけ
 *   下の手続き描画へ戻り、どちらの経路も共有アトラスへまとめます。
 *
 * ■ なぜ 1枚のアトラスに焼くのか
 *   社員の色ごとにテクスチャを作ると、色の数だけテクスチャが切り替わって
 *   スプライトのバッチ描画が分断されます。FC/SFC が実機でやっていたのと同じく
 *   「絵は1枚、パレットだけ差し替える」形にして、全員を 1テクスチャにまとめています。
 */
export const FRAME_WIDTH = 64;
export const FRAME_HEIGHT = 64;

export type Facing = 'down' | 'left' | 'right' | 'up';
export type CharacterVariant = AgentDuty;

/** 担当ごとに固有のシルエットを使います。同じ絵へまとめないことが最優先です。 */
export function characterVariantForDuty(duty: AgentDuty): CharacterVariant {
  return duty;
}

/** シートの行順。PNG に差し替えるときも、この順番に並べてください。 */
export const facings: Facing[] = ['down', 'left', 'right', 'up'];
const FRAMES_PER_FACING = 4;

/** マスターシート 1枚ぶんの大きさ。 */
export const SHEET_WIDTH = FRAME_WIDTH * FRAMES_PER_FACING;
export const SHEET_HEIGHT = FRAME_HEIGHT * 4;

/** 全社員が共有する、たった 1枚のテクスチャ。 */
export const ATLAS_KEY = 'agent-atlas';
/** アトラスに並べられる色の数。これを超えたら古い枠から使い回します。 */
const MAX_SLOTS = 32;
const SLOTS_PER_ROW = 4;
const ATLAS_WIDTH = SHEET_WIDTH * SLOTS_PER_ROW;
const ATLAS_HEIGHT = SHEET_HEIGHT * Math.ceil(MAX_SLOTS / SLOTS_PER_ROW);

// ---------------------------------------------------------------------------
// 担当別キャラの手続き描画
// ---------------------------------------------------------------------------

const OUTLINE = `#${PIXEL_PALETTE.outline.toString(16).padStart(6, '0')}`;
const GLASSES = '#b98130';
const DEVICE = '#344951';
const DEVICE_LIGHT = '#718a98';
const PAPER = '#f4e8c8';
const RED_PEN = '#b94a3b';
/** 服は必ずこの 2色で描きます。`AGENT_SHEET_PALETTE.shirt` と一致させてください。 */
const SHIRT_LIGHT = '#ffffff';
const SHIRT_DARK = '#c7c7c7';

/**
 * 下絵は 24×28 の論理座標で描き、すべてを正確に2倍します。
 * これにより輪郭も細部も常に 2px グリッドへそろいます。
 */
const ART_SCALE = PIXEL_UNIT;
const ART_WIDTH = 24 * ART_SCALE;
const ART_HEIGHT = 28 * ART_SCALE;
/** コマの中で水平中央に置き、足元を下端から 4px 上にそろえます。 */
const ART_OFFSET_X = Math.round((FRAME_WIDTH - ART_WIDTH) / 2);
const ART_OFFSET_Y = FRAME_HEIGHT - 4 - ART_HEIGHT;

function box(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  const left = x * ART_SCALE;
  const top = y * ART_SCALE;
  const right = (x + width) * ART_SCALE;
  const bottom = (y + height) * ART_SCALE;
  context.fillStyle = color;
  context.fillRect(left, top, right - left, bottom - top);
}

/** 縁取り付きの四角。論理1px＝画面2pxの輪郭をつけます。 */
function outlinedBox(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  box(context, x - 1, y - 1, width + 2, height + 2, OUTLINE);
  box(context, x, y, width, height, color);
}

interface LegOffsets {
  left: number;
  right: number;
}

/** 4コマぶんの足運び。0は直立、1/3は大股、2は足をそろえる中間姿勢です。 */
function legOffsets(frame: number): LegOffsets {
  if (frame === 1) return { left: -2, right: 1 };
  if (frame === 3) return { left: 1, right: -2 };
  return { left: 0, right: 0 };
}

function armOffsets(frame: number): LegOffsets {
  if (frame === 1) return { left: 2, right: -2 };
  if (frame === 3) return { left: -2, right: 2 };
  return { left: 0, right: 0 };
}

interface VariantColors {
  hair: string;
  hairLight: string;
  skin: string;
  skinShade: string;
  trouser: string;
  trouserShade: string;
  shoe: string;
  accent: string;
}

const VARIANT_COLORS: Record<CharacterVariant, VariantColors> = {
  director: {
    hair: '#5a3828', hairLight: '#8a5733', skin: '#e6b88c', skinShade: '#c9986f',
    trouser: '#3f4a52', trouserShade: '#37424a', shoe: '#2b3238', accent: '#b98130',
  },
  planner: {
    hair: '#71452d', hairLight: '#a96b3c', skin: '#efc39a', skinShade: '#d19a70',
    trouser: '#51453e', trouserShade: '#403833', shoe: '#302a29', accent: '#d49a2f',
  },
  researcher: {
    hair: '#263d4b', hairLight: '#3f6372', skin: '#d9aa80', skinShade: '#b98661',
    trouser: '#344d5a', trouserShade: '#293e49', shoe: '#223038', accent: '#62a9bf',
  },
  coder: {
    hair: '#663628', hairLight: '#9a5034', skin: '#e0aa82', skinShade: '#bc805f',
    trouser: '#414955', trouserShade: '#323943', shoe: '#252b33', accent: '#d36c4e',
  },
  tester: {
    hair: '#294844', hairLight: '#477064', skin: '#f0c6a0', skinShade: '#cf9b76',
    trouser: '#38504b', trouserShade: '#2b403c', shoe: '#26332f', accent: '#68a45f',
  },
  reviewer: {
    hair: '#565568', hairLight: '#8a879a', skin: '#d8a47d', skinShade: '#b67c5c',
    trouser: '#403d50', trouserShade: '#322f40', shoe: '#282630', accent: '#9a6fbd',
  },
  designer: {
    hair: '#7b3f5a', hairLight: '#b96383', skin: '#ecc09a', skinShade: '#c78f6c',
    trouser: '#5a3f56', trouserShade: '#463244', shoe: '#322832', accent: '#d77e9f',
  },
  accountant: {
    hair: '#3d3430', hairLight: '#665248', skin: '#e3b38b', skinShade: '#c18a67',
    trouser: '#42404d', trouserShade: '#33313d', shoe: '#27262d', accent: '#8d66a8',
  },
  communicator: {
    hair: '#244b48', hairLight: '#3f7871', skin: '#d7aa84', skinShade: '#b68161',
    trouser: '#34504d', trouserShade: '#293f3d', shoe: '#20312f', accent: '#4b9b8d',
  },
  writer: {
    hair: '#5b3f2f', hairLight: '#8d664a', skin: '#edbd94', skinShade: '#cb906c',
    trouser: '#4b4657', trouserShade: '#393542', shoe: '#2c2932', accent: '#d58b4b',
  },
  general: {
    hair: '#39454c', hairLight: '#62727b', skin: '#dca985', skinShade: '#b98062',
    trouser: '#424d52', trouserShade: '#333d42', shoe: '#262e32', accent: '#728a94',
  },
};

function drawLegs(
  context: CanvasRenderingContext2D,
  frame: number,
  colors: VariantColors,
  side = false,
): void {
  const legs = legOffsets(frame);
  const leftX = side ? 9 : 7;
  const rightX = side ? 11 : 13;
  box(context, leftX, 20 + legs.left, 4, 7 - legs.left, colors.trouser);
  box(context, rightX, 20 + legs.right, 4, 7 - legs.right, side ? colors.trouserShade : colors.trouser);
  box(context, leftX, 26, 4, 2, colors.shoe);
  if (!side) box(context, rightX, 26, 4, 2, colors.shoe);
}

function drawSideLegs(
  context: CanvasRenderingContext2D,
  frame: number,
  direction: -1 | 1,
  colors: VariantColors,
): void {
  const stride = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  const leftX = stride === 0 ? 9 : 10 - direction * stride * 3;
  const rightX = stride === 0 ? 11 : 10 + direction * stride * 3;
  const leftLift = stride < 0 ? 1 : 0;
  const rightLift = stride > 0 ? 1 : 0;

  box(context, leftX, 20 + leftLift, 4, 7 - leftLift, colors.trouser);
  box(context, rightX, 20 + rightLift, 4, 7 - rightLift, colors.trouserShade);
  box(context, leftX + (direction < 0 ? -1 : 0), 26, 5, 2, colors.shoe);
  box(context, rightX + (direction < 0 ? -1 : 0), 26, 5, 2, colors.shoe);
}

function drawFrontAccessory(
  context: CanvasRenderingContext2D,
  variant: CharacterVariant,
  colors: VariantColors,
): void {
  switch (variant) {
    case 'director':
      // 丸眼鏡、ベスト、ヘッドセット。PNGが読めない場合も統括だと分かる姿です。
      box(context, 11, 12, 1, 8, SHIRT_DARK);
      box(context, 6, 16, 3, 2, SHIRT_DARK);
      box(context, 15, 16, 3, 2, SHIRT_DARK);
      box(context, 6, 8, 5, 3, GLASSES);
      box(context, 13, 8, 5, 3, GLASSES);
      box(context, 11, 9, 2, 1, GLASSES);
      box(context, 7, 9, 3, 1, OUTLINE);
      box(context, 14, 9, 3, 1, OUTLINE);
      box(context, 18, 6, 2, 5, DEVICE);
      box(context, 17, 11, 2, 1, DEVICE);
      break;
    case 'planner':
      // ネクタイと、胸に抱えた黄色い企画カード。
      box(context, 11, 12, 2, 6, colors.accent);
      box(context, 10, 18, 4, 2, colors.accent);
      outlinedBox(context, 15, 14, 4, 5, PAPER);
      box(context, 16, 15, 2, 1, colors.accent);
      break;
    case 'researcher':
      // 斜め掛けバッグと青いハンディスキャナ。
      box(context, 7, 12, 2, 8, DEVICE);
      box(context, 8, 13, 8, 2, DEVICE);
      outlinedBox(context, 15, 16, 4, 4, DEVICE);
      box(context, 16, 17, 2, 1, colors.accent);
      break;
    case 'coder':
      // フードのひも、胸ポケット、工具ベルト。
      box(context, 9, 12, 1, 4, DEVICE_LIGHT);
      box(context, 14, 12, 1, 4, DEVICE_LIGHT);
      box(context, 5, 18, 14, 2, DEVICE);
      box(context, 10, 18, 4, 2, colors.accent);
      box(context, 15, 14, 3, 3, SHIRT_DARK);
      break;
    case 'tester':
      // 角眼鏡と緑のチェック徽章。
      box(context, 6, 8, 5, 3, DEVICE);
      box(context, 13, 8, 5, 3, DEVICE);
      box(context, 11, 9, 2, 1, DEVICE);
      box(context, 7, 9, 3, 1, DEVICE_LIGHT);
      box(context, 14, 9, 3, 1, DEVICE_LIGHT);
      box(context, 15, 14, 1, 3, colors.accent);
      box(context, 16, 16, 2, 1, colors.accent);
      break;
    case 'reviewer':
      // 細い銀縁眼鏡と、すぐ書き込める赤ペン。
      box(context, 6, 8, 5, 2, DEVICE_LIGHT);
      box(context, 13, 8, 5, 2, DEVICE_LIGHT);
      box(context, 11, 8, 2, 1, DEVICE_LIGHT);
      box(context, 17, 13, 1, 6, RED_PEN);
      box(context, 8, 14, 5, 1, colors.accent);
      break;
    case 'designer':
      // 首元のスカーフと、色を載せたパレット。
      box(context, 8, 12, 8, 2, colors.accent);
      box(context, 11, 14, 2, 3, colors.accent);
      outlinedBox(context, 15, 16, 4, 3, PAPER);
      box(context, 16, 16, 1, 1, '#d45656');
      box(context, 17, 17, 1, 1, '#4f8fc0');
      break;
    case 'accountant':
      // 丸眼鏡、きっちりしたベスト、紫の帳簿。
      box(context, 6, 8, 5, 3, GLASSES);
      box(context, 13, 8, 5, 3, GLASSES);
      box(context, 11, 9, 2, 1, GLASSES);
      box(context, 8, 12, 2, 8, SHIRT_DARK);
      box(context, 14, 12, 2, 8, SHIRT_DARK);
      outlinedBox(context, 15, 15, 4, 5, colors.accent);
      box(context, 16, 16, 2, 1, PAPER);
      break;
    case 'communicator':
      // 大型ヘッドセット、マイク、胸の通信ランプ。
      box(context, 4, 6, 2, 6, DEVICE);
      box(context, 18, 6, 2, 6, DEVICE);
      box(context, 19, 7, 1, 3, colors.accent);
      box(context, 17, 11, 2, 1, DEVICE);
      box(context, 16, 12, 1, 3, DEVICE);
      box(context, 16, 14, 2, 2, '#78d8b0');
      break;
    case 'writer':
      // 肩掛けの原稿鞄と、白いメモ帳。
      box(context, 7, 12, 2, 8, colors.accent);
      box(context, 8, 13, 8, 2, colors.accent);
      outlinedBox(context, 14, 15, 5, 5, PAPER);
      box(context, 15, 16, 3, 1, DEVICE_LIGHT);
      box(context, 15, 18, 2, 1, DEVICE_LIGHT);
      break;
    case 'general':
      // 汎用担当はワークベストと社員証。個体徽章で必ず見分けられます。
      box(context, 7, 12, 2, 8, DEVICE_LIGHT);
      box(context, 15, 12, 2, 8, DEVICE_LIGHT);
      outlinedBox(context, 14, 13, 4, 3, PAPER);
      box(context, 15, 14, 2, 1, colors.accent);
      break;
  }

}

const identityMarks = new Map<string, number>();
const identityMarkOwners = new Map<number, string>();

/**
 * 同名なら再起動後もほぼ同じ候補から始まり、衝突時は空いている値へ送ります。
 * 共有アトラスの上限は32人なので、8bit内で全員へ必ず別の徽章を割り当てられます。
 */
function identityMarkFor(identity: string): number {
  const existing = identityMarks.get(identity);
  if (existing !== undefined) return existing;
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const initial = (hash >>> 0) & 0xff;
  for (let offset = 0; offset < 256; offset += 1) {
    const mark = (initial + offset) & 0xff;
    if (identityMarkOwners.has(mark)) continue;
    identityMarks.set(identity, mark);
    identityMarkOwners.set(mark, identity);
    return mark;
  }
  // 到達するのは256種類を同一セッションで使った場合だけです。
  return initial;
}

function drawHairDetailsDown(
  context: CanvasRenderingContext2D,
  variant: CharacterVariant,
  colors: VariantColors,
  identityMark: number,
): void {
  const highlightShift = identityMark % 3;
  switch (variant) {
    case 'director':
      box(context, 7 + highlightShift, 2, 6, 2, colors.hairLight);
      break;
    case 'planner':
      box(context, 5, 1, 8, 3, colors.hairLight);
      box(context, 5, 4, 3, 4, colors.hair);
      box(context, 16, 0, 3, 4, colors.hair);
      break;
    case 'researcher':
      box(context, 4, 1, 16, 4, colors.accent);
      box(context, 6, 0, 12, 2, colors.hair);
      box(context, 3, 5, 10, 2, colors.accent);
      break;
    case 'coder':
      box(context, 5, 0, 3, 4, colors.hair);
      box(context, 10, 0, 3, 3, colors.hairLight);
      box(context, 16, 0, 3, 5, colors.hair);
      box(context, 5 + highlightShift, 3, 4, 2, colors.hairLight);
      break;
    case 'tester':
      box(context, 4, 4, 3, 8, colors.hair);
      box(context, 17, 4, 3, 8, colors.hair);
      box(context, 8, 2, 8, 2, colors.hairLight);
      break;
    case 'reviewer':
      box(context, 5, 0, 14, 4, colors.hair);
      box(context, 6, 1, 5, 2, colors.hairLight);
      box(context, 14, 3, 5, 2, colors.hairLight);
      break;
    case 'designer':
      box(context, 4, 1, 16, 4, colors.accent);
      box(context, 7, 0, 10, 2, colors.accent);
      box(context, 16, 4, 4, 3, colors.hairLight);
      break;
    case 'accountant':
      box(context, 6, 1, 12, 3, colors.hair);
      box(context, 11, 1, 2, 4, colors.skin);
      box(context, 7 + highlightShift, 2, 3, 1, colors.hairLight);
      break;
    case 'communicator':
      box(context, 4, 2, 16, 3, DEVICE);
      box(context, 5, 2, 14, 1, colors.accent);
      box(context, 3, 4, 3, 7, DEVICE);
      box(context, 18, 4, 3, 7, DEVICE);
      break;
    case 'writer':
      box(context, 17, 4, 4, 10, colors.hair);
      box(context, 18, 12, 3, 3, colors.hairLight);
      box(context, 7 + highlightShift, 2, 7, 2, colors.hairLight);
      break;
    case 'general':
      box(context, 5, 0, 14, 4, colors.accent);
      box(context, 4, 3, 16, 3, colors.accent);
      box(context, 9, 0, 6, 1, colors.hairLight);
      break;
  }
}

function drawHairDetailsSide(
  context: CanvasRenderingContext2D,
  variant: CharacterVariant,
  direction: -1 | 1,
  colors: VariantColors,
): void {
  const frontX = direction === 1 ? 16 : 6;
  const backX = direction === 1 ? 5 : 17;
  switch (variant) {
    case 'planner':
      box(context, frontX, 0, 3, 5, colors.hair);
      break;
    case 'researcher':
      box(context, 5, 1, 14, 4, colors.accent);
      box(context, direction === 1 ? 13 : 4, 5, 7, 2, colors.accent);
      break;
    case 'coder':
      box(context, backX, 0, 3, 5, colors.hair);
      box(context, 10, 0, 3, 3, colors.hairLight);
      break;
    case 'tester':
      box(context, backX, 4, 4, 9, colors.hair);
      break;
    case 'reviewer':
      box(context, 6, 0, 12, 4, colors.hair);
      box(context, frontX, 3, 3, 2, colors.hairLight);
      break;
    case 'designer':
      box(context, 5, 1, 14, 4, colors.accent);
      box(context, 8, 0, 9, 2, colors.accent);
      break;
    case 'accountant':
      box(context, 7, 1, 10, 3, colors.hair);
      break;
    case 'communicator':
      box(context, 5, 2, 14, 3, DEVICE);
      box(context, backX, 4, 3, 7, DEVICE);
      break;
    case 'writer':
      box(context, backX, 4, 4, 11, colors.hair);
      box(context, backX, 13, 3, 3, colors.hairLight);
      break;
    case 'general':
      box(context, 5, 0, 14, 5, colors.accent);
      box(context, 4, 4, 16, 2, colors.accent);
      break;
    case 'director':
      box(context, 7, 2, 6, 2, colors.hairLight);
      break;
  }
}

function drawHairDetailsUp(
  context: CanvasRenderingContext2D,
  variant: CharacterVariant,
  colors: VariantColors,
): void {
  switch (variant) {
    case 'researcher':
      box(context, 4, 1, 16, 4, colors.accent);
      break;
    case 'coder':
      box(context, 5, 0, 3, 4, colors.hair);
      box(context, 16, 0, 3, 5, colors.hair);
      break;
    case 'tester':
      box(context, 4, 4, 3, 8, colors.hair);
      box(context, 17, 4, 3, 8, colors.hair);
      break;
    case 'designer':
      box(context, 4, 1, 16, 4, colors.accent);
      box(context, 7, 0, 10, 2, colors.accent);
      break;
    case 'communicator':
      box(context, 4, 2, 16, 3, DEVICE);
      box(context, 3, 4, 3, 7, DEVICE);
      box(context, 18, 4, 3, 7, DEVICE);
      break;
    case 'writer':
      box(context, 17, 4, 4, 11, colors.hair);
      break;
    case 'general':
      box(context, 5, 0, 14, 4, colors.accent);
      box(context, 4, 3, 16, 3, colors.accent);
      break;
    case 'director':
    case 'planner':
    case 'reviewer':
    case 'accountant':
      box(context, 8, 3, 8, 5, colors.hairLight);
      break;
  }
}

function drawFacingDown(
  context: CanvasRenderingContext2D,
  frame: number,
  variant: CharacterVariant,
  identityMark: number,
): void {
  const colors = VARIANT_COLORS[variant];
  const arms = armOffsets(frame);
  drawLegs(context, frame, colors);
  outlinedBox(context, 5, 11, 14, 9, SHIRT_LIGHT);
  box(context, 5, 18, 14, 2, SHIRT_DARK);
  outlinedBox(context, 3, 12 + arms.left, 2, 7, colors.skin);
  outlinedBox(context, 19, 12 + arms.right, 2, 7, colors.skin);
  outlinedBox(context, 5, 1, 14, 10, colors.hair);
  box(context, 6, 5, 12, 6, colors.skin);
  box(context, 7, 10, 10, 1, colors.skinShade);
  drawHairDetailsDown(context, variant, colors, identityMark);
  if (!['director', 'tester', 'reviewer', 'accountant'].includes(variant)) {
    box(context, 8, 8, 1, 1, OUTLINE);
    box(context, 15, 8, 1, 1, OUTLINE);
  }
  drawFrontAccessory(context, variant, colors);
}

function drawFacingSide(
  context: CanvasRenderingContext2D,
  frame: number,
  direction: -1 | 1,
  variant: CharacterVariant,
): void {
  const colors = VARIANT_COLORS[variant];
  drawSideLegs(context, frame, direction, colors);
  outlinedBox(context, 7, 11, 10, 9, SHIRT_LIGHT);
  box(context, 7, 18, 10, 2, SHIRT_DARK);
  const armX = direction === 1 ? 17 : 5;
  const armSwing = frame === 1 ? -2 : frame === 3 ? 2 : 0;
  outlinedBox(context, armX, 12 + armSwing, 2, 7, colors.skin);
  outlinedBox(context, 6, 1, 12, 10, colors.hair);
  const cheekX = direction === 1 ? 13 : 7;
  box(context, cheekX, 5, 5, 6, colors.skin);
  box(context, cheekX, 10, 5, 1, colors.skinShade);
  box(context, direction === 1 ? 15 : 8, 8, 1, 1, OUTLINE);
  drawHairDetailsSide(context, variant, direction, colors);
  if (variant === 'director') {
    const deviceX = direction === 1 ? 7 : 16;
    box(context, deviceX, 5, 2, 5, DEVICE);
    box(context, deviceX, 6, 2, 2, GLASSES);
    box(context, direction === 1 ? 15 : 7, 8, 3, 1, GLASSES);
  } else if (variant === 'planner') {
    box(context, direction === 1 ? 13 : 7, 13, 4, 6, PAPER);
    box(context, direction === 1 ? 14 : 8, 14, 2, 1, colors.accent);
  } else if (variant === 'researcher' || variant === 'writer') {
    box(context, direction === 1 ? 8 : 14, 12, 2, 8, DEVICE);
  } else if (variant === 'coder') {
    box(context, 7, 18, 10, 2, DEVICE);
  } else if (variant === 'tester' || variant === 'reviewer' || variant === 'accountant') {
    box(context, direction === 1 ? 14 : 7, 7, 4, 2, DEVICE);
  } else if (variant === 'designer') {
    box(context, 8, 12, 8, 2, colors.accent);
  } else if (variant === 'communicator') {
    const micX = direction === 1 ? 16 : 6;
    box(context, micX, 9, 3, 1, DEVICE);
  } else {
    box(context, 8, 12, 2, 8, DEVICE_LIGHT);
  }
}

function drawFacingUp(
  context: CanvasRenderingContext2D,
  frame: number,
  variant: CharacterVariant,
): void {
  const colors = VARIANT_COLORS[variant];
  const arms = armOffsets(frame);
  drawLegs(context, frame, colors);
  outlinedBox(context, 5, 11, 14, 9, SHIRT_LIGHT);
  box(context, 5, 18, 14, 2, SHIRT_DARK);
  outlinedBox(context, 3, 12 + arms.left, 2, 7, colors.skin);
  outlinedBox(context, 19, 12 + arms.right, 2, 7, colors.skin);
  outlinedBox(context, 5, 1, 14, 10, colors.hair);
  box(context, 8, 3, 8, 6, colors.hairLight);
  box(context, 7, 10, 10, 1, colors.skinShade);
  drawHairDetailsUp(context, variant, colors);
  if (variant === 'director') {
    box(context, 5, 12, 14, 2, SHIRT_DARK);
    box(context, 18, 5, 2, 4, DEVICE);
  } else if (variant === 'researcher' || variant === 'writer') {
    box(context, 14, 12, 4, 7, DEVICE);
  } else if (variant === 'coder') {
    box(context, 5, 18, 14, 2, DEVICE);
  } else if (variant === 'tester' || variant === 'reviewer') {
    box(context, 6, 13, 12, 1, SHIRT_DARK);
  } else if (variant === 'designer') {
    box(context, 8, 12, 8, 2, colors.accent);
  } else if (variant === 'accountant') {
    box(context, 7, 12, 2, 8, SHIRT_DARK);
    box(context, 15, 12, 2, 8, SHIRT_DARK);
  } else if (variant === 'communicator') {
    outlinedBox(context, 8, 13, 8, 6, DEVICE);
    box(context, 10, 14, 4, 2, colors.accent);
  } else if (variant === 'planner') {
    box(context, 10, 12, 4, 2, colors.accent);
  } else {
    box(context, 7, 12, 2, 8, DEVICE_LIGHT);
  }
}

function drawFrame(
  context: CanvasRenderingContext2D,
  facing: Facing,
  frame: number,
  variant: CharacterVariant,
  identityMark: number,
): void {
  if (facing === 'down') drawFacingDown(context, frame, variant, identityMark);
  else if (facing === 'up') drawFacingUp(context, frame, variant);
  else drawFacingSide(context, frame, facing === 'right' ? 1 : -1, variant);
}

/** 手続き描画で 256×256 のマスターシートを 1枚こしらえます。 */
function drawProceduralMaster(
  context: CanvasRenderingContext2D,
  variant: CharacterVariant,
  identityMark: number,
): void {
  facings.forEach((facing, rowIndex) => {
    for (let frame = 0; frame < FRAMES_PER_FACING; frame += 1) {
      context.save();
      context.translate(
        frame * FRAME_WIDTH + ART_OFFSET_X,
        rowIndex * FRAME_HEIGHT + ART_OFFSET_Y,
      );
      drawFrame(context, facing, frame, variant, identityMark);
      context.restore();
    }
  });
}

// ---------------------------------------------------------------------------
// パレット差し替え
// ---------------------------------------------------------------------------

function parseHex(value: string): [number, number, number] {
  const clean = value.replace('#', '');
  const n = Number.parseInt(clean, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * 「シート側の色 → 社員の色」の対応表を作ります。
 *
 * 一番明るい服の色を基準にした相対的な明るさをそのまま掛けるので、
 * 服が何色のグラデーションで塗られていても、陰影の関係が崩れません。
 */
function buildShirtMap(palette: SheetPalette, color: number): Map<number, number> {
  const map = new Map<number, number>();
  const ramp = palette.shirt.map(parseHex);
  if (ramp.length === 0) return map;

  const peak = Math.max(...ramp.map(([r, g, b]) => luminance(r, g, b))) || 255;
  const cr = (color >> 16) & 0xff;
  const cg = (color >> 8) & 0xff;
  const cb = color & 0xff;

  for (const [r, g, b] of ramp) {
    const factor = luminance(r, g, b) / peak;
    const key = (r << 16) | (g << 8) | b;
    const value =
      (clampChannel(cr * factor) << 16) |
      (clampChannel(cg * factor) << 8) |
      clampChannel(cb * factor);
    map.set(key, value);
  }
  return map;
}

function putImageBlock(
  image: ImageData,
  x: number,
  y: number,
  color: [number, number, number],
): void {
  for (let py = 0; py < ART_SCALE; py += 1) {
    for (let px = 0; px < ART_SCALE; px += 1) {
      const offset = ((y + py) * image.width + x + px) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = 0xff;
    }
  }
}

/**
 * 全16コマの胸元へ2行×4列の社員徽章を焼き込みます。
 * 手続き描画だけでなく統括責任者のPNGにも適用するため、同じ担当・同じ服色でも
 * 人物名が違えば正面・横・背面のすべてで画像が重複しません。
 */
function stampIdentityMark(
  image: ImageData,
  variant: CharacterVariant,
  identityMark: number,
): void {
  const on = parseHex(VARIANT_COLORS[variant].accent);
  const off = parseHex(DEVICE_LIGHT);
  for (let facingIndex = 0; facingIndex < facings.length; facingIndex += 1) {
    for (let frame = 0; frame < FRAMES_PER_FACING; frame += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const logicalX = 10 + (bit % 4);
        const logicalY = 16 + Math.floor(bit / 4);
        const x = frame * FRAME_WIDTH + ART_OFFSET_X + logicalX * ART_SCALE;
        const y = facingIndex * FRAME_HEIGHT + ART_OFFSET_Y + logicalY * ART_SCALE;
        putImageBlock(image, x, y, ((identityMark >> bit) & 1) !== 0 ? on : off);
      }
    }
  }
}

/** マスターシートの服の色だけを差し替えた ImageData を返します。 */
function swappedSheet(
  variant: CharacterVariant,
  color: number,
  identityMark: number,
): ImageData | null {
  const master = ensureMaster(variant, identityMark);
  if (!master) return null;

  const copy = new ImageData(
    new Uint8ClampedArray(master.data),
    master.width,
    master.height,
  );
  const map = buildShirtMap(AGENT_SHEET_PALETTE, color);
  if (map.size > 0) {
    const data = copy.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const replacement = map.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (replacement === undefined) continue;
      data[i] = (replacement >> 16) & 0xff;
      data[i + 1] = (replacement >> 8) & 0xff;
      data[i + 2] = replacement & 0xff;
    }
  }
  stampIdentityMark(copy, variant, identityMark);
  return copy;
}

// ---------------------------------------------------------------------------
// マスターシートの用意（同期の仮絵 → 非同期で本物に差し替え）
// ---------------------------------------------------------------------------

const proceduralMasters = new Map<string, ImageData>();
const artMasters = new Map<CharacterVariant, ImageData>();
const artRequested = new Set<CharacterVariant>();
let sheetVersion = 0;
const versionListeners = new Set<() => void>();

/**
 * マスターシートを用意します。最初の呼び出しでは手続き描画の仮絵を
 * **同期で**返し、担当別PNGを裏で読み込んで差し替えます。
 * 名簿（React 側）が同期で絵を欲しがるので、この二段構えにしています。
 */
function proceduralMasterKey(variant: CharacterVariant, identityMark: number): string {
  return `${variant}:${identityMark}`;
}

function ensureMaster(variant: CharacterVariant, identityMark: number): ImageData | null {
  const artMaster = artMasters.get(variant);
  if (artMaster) return artMaster;
  const key = proceduralMasterKey(variant, identityMark);
  const existing = proceduralMasters.get(key);
  if (existing) return existing;

  const canvas = document.createElement('canvas');
  canvas.width = SHEET_WIDTH;
  canvas.height = SHEET_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  drawProceduralMaster(context, variant, identityMark);
  const master = context.getImageData(0, 0, SHEET_WIDTH, SHEET_HEIGHT);
  proceduralMasters.set(key, master);

  loadArtMaster(variant);
  return master;
}

/** 本物のドット絵シートを読み込み、間に合ったところで丸ごと差し替えます。 */
function loadArtMaster(variant: CharacterVariant): void {
  const sheetUrl = AGENT_SHEET_PNGS[variant];
  if (artRequested.has(variant) || !sheetUrl) return;
  artRequested.add(variant);

  const image = new Image();
  image.onload = () => {
    if (image.width !== SHEET_WIDTH || image.height !== SHEET_HEIGHT) {
      console.warn(
        `[characterSheet] シートは ${SHEET_WIDTH}×${SHEET_HEIGHT} である必要があります` +
          `（読み込んだ画像は ${image.width}×${image.height}）。仮キャラのまま続行します。`,
      );
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = SHEET_WIDTH;
    canvas.height = SHEET_HEIGHT;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
    artMasters.set(variant, context.getImageData(0, 0, SHEET_WIDTH, SHEET_HEIGHT));
    onMasterChanged();
  };
  image.onerror = () => {
    console.warn('[characterSheet] シートを読み込めませんでした。仮キャラのまま続行します。');
  };
  image.src = sheetUrl;
}

/** 絵が差し替わったら、アトラスも名簿のアイコンも作り直します。 */
function onMasterChanged(): void {
  portraitCache.clear();
  for (const [slot, details] of slotDetails) {
    paintSlot(slot, details.variant, details.color, details.identityMark);
  }
  atlasTexture?.refresh();
  sheetVersion += 1;
  for (const listener of versionListeners) listener();
}

/**
 * 絵が差し替わったことを React 側へ伝えるための購読口。
 * `useSyncExternalStore(subscribeSheetVersion, getSheetVersion)` で使います。
 */
export function subscribeSheetVersion(listener: () => void): () => void {
  versionListeners.add(listener);
  return () => versionListeners.delete(listener);
}

export function getSheetVersion(): number {
  return sheetVersion;
}

// ---------------------------------------------------------------------------
// 共有アトラス
// ---------------------------------------------------------------------------

interface SlotDetails {
  variant: CharacterVariant;
  color: number;
  identityMark: number;
}

/** キャラ型と服色の組み合わせ → アトラスの枠番号。 */
const slots = new Map<string, number>();
const slotDetails = new Map<number, SlotDetails>();
let atlasCanvas: HTMLCanvasElement | null = null;
let atlasTexture: Phaser.Textures.CanvasTexture | null = null;

function slotOrigin(slot: number): { x: number; y: number } {
  return {
    x: (slot % SLOTS_PER_ROW) * SHEET_WIDTH,
    y: Math.floor(slot / SLOTS_PER_ROW) * SHEET_HEIGHT,
  };
}

export function frameName(slot: number, facing: Facing, frame: number): string {
  return `${slot}-${facing}-${frame}`;
}

export function animationKey(slot: number, facing: Facing, moving: boolean): string {
  return `agent-${slot}-${moving ? 'walk' : 'idle'}-${facing}`;
}

function slotKey(variant: CharacterVariant, color: number, identity: string): string {
  return `${variant}:${color}:${identity}`;
}

/** 枠 1つぶんを、服の色を差し替えたうえでアトラスへ焼きます。 */
function paintSlot(
  slot: number,
  variant: CharacterVariant,
  color: number,
  identityMark: number,
): void {
  if (!atlasCanvas) return;
  const context = atlasCanvas.getContext('2d');
  if (!context) return;
  const sheet = swappedSheet(variant, color, identityMark);
  if (!sheet) return;
  const { x, y } = slotOrigin(slot);
  // putImageData は合成せずに置き換えるので、先に消す必要はありません。
  context.putImageData(sheet, x, y);
}

/** 枠 1つぶんの 16コマを、テクスチャのフレームとして登録します。 */
function addSlotFrames(slot: number): void {
  if (!atlasTexture) return;
  const origin = slotOrigin(slot);
  facings.forEach((facing, rowIndex) => {
    for (let frame = 0; frame < FRAMES_PER_FACING; frame += 1) {
      const name = frameName(slot, facing, frame);
      if (atlasTexture?.has(name)) continue;
      atlasTexture?.add(
        name,
        0,
        origin.x + frame * FRAME_WIDTH,
        origin.y + rowIndex * FRAME_HEIGHT,
        FRAME_WIDTH,
        FRAME_HEIGHT,
      );
    }
  });
}

function ensureAtlas(scene: Phaser.Scene): void {
  if (!atlasCanvas) {
    atlasCanvas = document.createElement('canvas');
    atlasCanvas.width = ATLAS_WIDTH;
    atlasCanvas.height = ATLAS_HEIGHT;
    const context = atlasCanvas.getContext('2d');
    if (context) context.imageSmoothingEnabled = false;
    for (const [slot, details] of slotDetails) {
      paintSlot(slot, details.variant, details.color, details.identityMark);
    }
  }

  // シーンが作り直されるとテクスチャは破棄されるので、そのつど登録し直します。
  if (!scene.textures.exists(ATLAS_KEY)) {
    atlasTexture = scene.textures.addCanvas(ATLAS_KEY, atlasCanvas) ?? null;
    for (const slot of slots.values()) addSlotFrames(slot);
    atlasTexture?.refresh();
    return;
  }
  atlasTexture = scene.textures.get(ATLAS_KEY) as Phaser.Textures.CanvasTexture;
}

function allocateSlot(
  key: string,
  variant: CharacterVariant,
  color: number,
  identityMark: number,
): number {
  if (slots.size < MAX_SLOTS) {
    const slot = slots.size;
    slots.set(key, slot);
    slotDetails.set(slot, { variant, color, identityMark });
    addSlotFrames(slot);
    return slot;
  }
  // 枠を使いきったら、一番古い組み合わせの枠を明け渡します。
  const [oldest] = slots.keys();
  const slot = slots.get(oldest) as number;
  slots.delete(oldest);
  slots.set(key, slot);
  slotDetails.set(slot, { variant, color, identityMark });
  return slot;
}

/**
 * 担当・服色・人物名ごとに、アトラスの枠とアニメを 1度だけ用意します。
 * 返すのは枠番号で、テクスチャはいつでも `ATLAS_KEY` です。
 */
export function ensureCharacterSheet(
  scene: Phaser.Scene,
  color: number,
  duty: AgentDuty,
  identity: string,
): number {
  ensureAtlas(scene);

  const variant = characterVariantForDuty(duty);
  const identityMark = identityMarkFor(identity);
  const key = slotKey(variant, color, identity);
  const existing = slots.get(key);
  const slot = existing ?? allocateSlot(key, variant, color, identityMark);
  if (existing === undefined) {
    paintSlot(slot, variant, color, identityMark);
    atlasTexture?.refresh();
  }

  for (const facing of facings) {
    const walk = animationKey(slot, facing, true);
    if (!scene.anims.exists(walk)) {
      scene.anims.create({
        key: walk,
        // 大股→沈み込み→反対の大股→沈み込み、で足運びを明確にします。
        frames: [1, 2, 3, 2].map((frame) => ({
          key: ATLAS_KEY,
          frame: frameName(slot, facing, frame),
        })),
        // 260ms/タイルに対して250ms/片足。1マスにつき1回だけ踏み出します。
        frameRate: 8,
        repeat: -1,
      });
    }
    const idle = animationKey(slot, facing, false);
    if (!scene.anims.exists(idle)) {
      scene.anims.create({
        key: idle,
        frames: [{ key: ATLAS_KEY, frame: frameName(slot, facing, 0) }],
        frameRate: 1,
        repeat: -1,
      });
    }
  }

  return slot;
}

// ---------------------------------------------------------------------------
// 名簿用の 1コマ書き出し
// ---------------------------------------------------------------------------

const portraitCache = new Map<string, string>();

/**
 * 名簿のアイコンの大きさ。64×64 をそのまま縮めるとドットが間引かれて
 * にじむので、正面コマの顔まわりを**等倍のまま**切り抜いて使います。
 */
export const PORTRAIT_SIZE = 40;
const PORTRAIT_CROP_X = Math.round((FRAME_WIDTH - PORTRAIT_SIZE) / 2);
const PORTRAIT_CROP_Y = 2;

/**
 * 名簿など、Phaser のキャンバスの外（HTML側）でキャラを出したいとき用に、
 * 正面向き・直立コマの顔まわりを PNG のデータURIとして書き出します。
 *
 * フロアのキャラとまったく同じマスターシートから切り出すので、
 * 絵を差し替えれば名簿のアイコンも自動で追従します。人物ごとに一度だけ作ります。
 */
export function characterPortrait(color: number, duty: AgentDuty, identity: string): string {
  const variant = characterVariantForDuty(duty);
  const identityMark = identityMarkFor(identity);
  const key = slotKey(variant, color, identity);
  const cached = portraitCache.get(key);
  if (cached !== undefined) return cached;

  const sheet = swappedSheet(variant, color, identityMark);
  if (!sheet) return '';

  const canvas = document.createElement('canvas');
  canvas.width = PORTRAIT_SIZE;
  canvas.height = PORTRAIT_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return '';
  // シート左上（正面・直立コマ）の一部だけを、拡大縮小せずに貼りつけます。
  context.putImageData(
    sheet,
    -PORTRAIT_CROP_X,
    -PORTRAIT_CROP_Y,
    PORTRAIT_CROP_X,
    PORTRAIT_CROP_Y,
    PORTRAIT_SIZE,
    PORTRAIT_SIZE,
  );

  const url = canvas.toDataURL('image/png');
  portraitCache.set(key, url);
  return url;
}
