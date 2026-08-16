import Phaser from 'phaser';

import { AGENT_SHEET_PALETTE, MANAGER_SHEET_PNG, type SheetPalette } from '../assets/agentSheet';
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
 *   Manager系は `assets/sprites/manager-sheet.png` を使い、ほかの担当は
 *   下の手続き描画でキャラを描きます。どちらも共有アトラスへまとめます。
 *
 * ■ なぜ 1枚のアトラスに焼くのか
 *   社員の色ごとにテクスチャを作ると、色の数だけテクスチャが切り替わって
 *   スプライトのバッチ描画が分断されます。FC/SFC が実機でやっていたのと同じく
 *   「絵は1枚、パレットだけ差し替える」形にして、全員を 1テクスチャにまとめています。
 */
export const FRAME_WIDTH = 64;
export const FRAME_HEIGHT = 64;

export type Facing = 'down' | 'left' | 'right' | 'up';
export type CharacterVariant = 'manager' | 'scout' | 'builder' | 'checker';

/** 担当から、遠目でも判別できる4種類のシルエットへ振り分けます。 */
export function characterVariantForDuty(duty: AgentDuty): CharacterVariant {
  if (duty === 'director' || duty === 'planner') return 'manager';
  if (duty === 'researcher' || duty === 'writer' || duty === 'communicator') return 'scout';
  if (duty === 'coder' || duty === 'designer') return 'builder';
  return 'checker';
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
// 仮キャラの手続き描画（本物の絵が来るまでのつなぎ）
// ---------------------------------------------------------------------------

const SKIN = '#e6b88c';
const SKIN_SHADE = '#c9986f';
const OUTLINE = `#${PIXEL_PALETTE.outline.toString(16).padStart(6, '0')}`;
const SHOE = '#2b3238';
const TROUSER = '#3f4a52';
const TROUSER_SHADE = '#37424a';
const GLASSES = '#b98130';
const DEVICE = '#344951';
const DEVICE_LIGHT = '#718a98';
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
}

const VARIANT_COLORS: Record<CharacterVariant, VariantColors> = {
  manager: { hair: '#5a3828', hairLight: '#8a5733' },
  scout: { hair: '#263d4b', hairLight: '#3f6372' },
  builder: { hair: '#663628', hairLight: '#9a5034' },
  checker: { hair: '#294844', hairLight: '#477064' },
};

function drawLegs(context: CanvasRenderingContext2D, frame: number, side = false): void {
  const legs = legOffsets(frame);
  const leftX = side ? 9 : 7;
  const rightX = side ? 11 : 13;
  box(context, leftX, 20 + legs.left, 4, 7 - legs.left, TROUSER);
  box(context, rightX, 20 + legs.right, 4, 7 - legs.right, side ? TROUSER_SHADE : TROUSER);
  box(context, leftX, 26, 4, 2, SHOE);
  if (!side) box(context, rightX, 26, 4, 2, SHOE);
}

function drawSideLegs(
  context: CanvasRenderingContext2D,
  frame: number,
  direction: -1 | 1,
): void {
  const stride = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  const leftX = stride === 0 ? 9 : 10 - direction * stride * 3;
  const rightX = stride === 0 ? 11 : 10 + direction * stride * 3;
  const leftLift = stride < 0 ? 1 : 0;
  const rightLift = stride > 0 ? 1 : 0;

  box(context, leftX, 20 + leftLift, 4, 7 - leftLift, TROUSER);
  box(context, rightX, 20 + rightLift, 4, 7 - rightLift, TROUSER_SHADE);
  box(context, leftX + (direction < 0 ? -1 : 0), 26, 5, 2, SHOE);
  box(context, rightX + (direction < 0 ? -1 : 0), 26, 5, 2, SHOE);
}

function drawFrontAccessory(
  context: CanvasRenderingContext2D,
  variant: CharacterVariant,
): void {
  if (variant === 'manager') {
    // ベストの前合わせ、ポケット、眼鏡、ヘッドセット。
    box(context, 11, 12, 1, 8, SHIRT_DARK);
    box(context, 6, 16, 3, 2, SHIRT_DARK);
    box(context, 15, 16, 3, 2, SHIRT_DARK);
    box(context, 6, 8, 5, 3, GLASSES);
    box(context, 13, 8, 5, 3, GLASSES);
    box(context, 11, 9, 2, 1, GLASSES);
    box(context, 7, 9, 3, 1, OUTLINE);
    box(context, 14, 9, 3, 1, OUTLINE);
    box(context, 18, 6, 2, 5, DEVICE);
    box(context, 19, 7, 1, 2, GLASSES);
    box(context, 17, 11, 2, 1, DEVICE);
  } else if (variant === 'scout') {
    // 斜め掛けバッグと小型スキャナ。
    box(context, 7, 12, 2, 8, DEVICE);
    box(context, 8, 13, 8, 2, DEVICE);
    box(context, 15, 16, 4, 4, DEVICE);
    box(context, 16, 17, 2, 1, DEVICE_LIGHT);
  } else if (variant === 'builder') {
    // 工具ベルトと胸ポケット。
    box(context, 5, 18, 14, 2, DEVICE);
    box(context, 10, 18, 4, 2, GLASSES);
    box(context, 15, 14, 3, 3, SHIRT_DARK);
  } else {
    // チェッカーの角眼鏡と胸のチェックマーク。
    box(context, 6, 8, 5, 3, DEVICE);
    box(context, 13, 8, 5, 3, DEVICE);
    box(context, 11, 9, 2, 1, DEVICE);
    box(context, 7, 9, 3, 1, DEVICE_LIGHT);
    box(context, 14, 9, 3, 1, DEVICE_LIGHT);
    box(context, 15, 14, 1, 3, DEVICE);
    box(context, 16, 16, 2, 1, DEVICE);
  }
}

function drawFacingDown(
  context: CanvasRenderingContext2D,
  frame: number,
  variant: CharacterVariant,
): void {
  const colors = VARIANT_COLORS[variant];
  const arms = armOffsets(frame);
  drawLegs(context, frame);
  outlinedBox(context, 5, 11, 14, 9, SHIRT_LIGHT);
  box(context, 5, 18, 14, 2, SHIRT_DARK);
  outlinedBox(context, 3, 12 + arms.left, 2, 7, SKIN);
  outlinedBox(context, 19, 12 + arms.right, 2, 7, SKIN);
  outlinedBox(context, 5, 1, 14, 10, colors.hair);
  box(context, 6, 5, 12, 6, SKIN);
  box(context, 7, 10, 10, 1, SKIN_SHADE);
  box(context, 7, 2, variant === 'builder' ? 4 : 7, 2, colors.hairLight);
  if (variant === 'builder') box(context, 16, 0, 2, 3, colors.hair);
  if (variant === 'scout') box(context, 5, 3, 14, 2, DEVICE_LIGHT);
  if (variant !== 'manager' && variant !== 'checker') {
    box(context, 8, 8, 1, 1, OUTLINE);
    box(context, 15, 8, 1, 1, OUTLINE);
  }
  drawFrontAccessory(context, variant);
}

function drawFacingSide(
  context: CanvasRenderingContext2D,
  frame: number,
  direction: -1 | 1,
  variant: CharacterVariant,
): void {
  const colors = VARIANT_COLORS[variant];
  drawSideLegs(context, frame, direction);
  outlinedBox(context, 7, 11, 10, 9, SHIRT_LIGHT);
  box(context, 7, 18, 10, 2, SHIRT_DARK);
  const armX = direction === 1 ? 17 : 5;
  const armSwing = frame === 1 ? -2 : frame === 3 ? 2 : 0;
  outlinedBox(context, armX, 12 + armSwing, 2, 7, SKIN);
  outlinedBox(context, 6, 1, 12, 10, colors.hair);
  const cheekX = direction === 1 ? 13 : 7;
  box(context, cheekX, 5, 5, 6, SKIN);
  box(context, cheekX, 10, 5, 1, SKIN_SHADE);
  box(context, direction === 1 ? 15 : 8, 8, 1, 1, OUTLINE);
  box(context, 7, 2, 6, 2, colors.hairLight);
  if (variant === 'builder') box(context, direction === 1 ? 16 : 6, 0, 2, 3, colors.hair);
  if (variant === 'scout') box(context, 6, 3, 12, 2, DEVICE_LIGHT);
  if (variant === 'manager') {
    const deviceX = direction === 1 ? 7 : 16;
    box(context, deviceX, 5, 2, 5, DEVICE);
    box(context, deviceX, 6, 2, 2, GLASSES);
    box(context, direction === 1 ? 15 : 7, 8, 3, 1, GLASSES);
  } else if (variant === 'scout') {
    box(context, direction === 1 ? 8 : 14, 12, 2, 8, DEVICE);
  } else if (variant === 'builder') {
    box(context, 7, 18, 10, 2, DEVICE);
  } else {
    box(context, direction === 1 ? 14 : 7, 7, 4, 2, DEVICE);
  }
}

function drawFacingUp(
  context: CanvasRenderingContext2D,
  frame: number,
  variant: CharacterVariant,
): void {
  const colors = VARIANT_COLORS[variant];
  const arms = armOffsets(frame);
  drawLegs(context, frame);
  outlinedBox(context, 5, 11, 14, 9, SHIRT_LIGHT);
  box(context, 5, 18, 14, 2, SHIRT_DARK);
  outlinedBox(context, 3, 12 + arms.left, 2, 7, SKIN);
  outlinedBox(context, 19, 12 + arms.right, 2, 7, SKIN);
  outlinedBox(context, 5, 1, 14, 10, colors.hair);
  box(context, 8, 3, 8, 6, colors.hairLight);
  box(context, 7, 10, 10, 1, SKIN_SHADE);
  if (variant === 'manager') {
    box(context, 5, 12, 14, 2, SHIRT_DARK);
    box(context, 18, 5, 2, 4, DEVICE);
  } else if (variant === 'scout') {
    box(context, 5, 3, 14, 2, DEVICE_LIGHT);
    box(context, 14, 12, 4, 7, DEVICE);
  } else if (variant === 'builder') {
    box(context, 5, 18, 14, 2, DEVICE);
    box(context, 16, 0, 2, 3, colors.hair);
  } else {
    box(context, 6, 13, 12, 1, SHIRT_DARK);
  }
}

function drawFrame(
  context: CanvasRenderingContext2D,
  facing: Facing,
  frame: number,
  variant: CharacterVariant,
): void {
  if (facing === 'down') drawFacingDown(context, frame, variant);
  else if (facing === 'up') drawFacingUp(context, frame, variant);
  else drawFacingSide(context, frame, facing === 'right' ? 1 : -1, variant);
}

/** 手続き描画で 256×256 のマスターシートを 1枚こしらえます。 */
function drawProceduralMaster(
  context: CanvasRenderingContext2D,
  variant: CharacterVariant,
): void {
  facings.forEach((facing, rowIndex) => {
    for (let frame = 0; frame < FRAMES_PER_FACING; frame += 1) {
      context.save();
      context.translate(
        frame * FRAME_WIDTH + ART_OFFSET_X,
        rowIndex * FRAME_HEIGHT + ART_OFFSET_Y,
      );
      drawFrame(context, facing, frame, variant);
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

/** マスターシートの服の色だけを差し替えた ImageData を返します。 */
function swappedSheet(variant: CharacterVariant, color: number): ImageData | null {
  const master = ensureMaster(variant);
  if (!master) return null;

  const copy = new ImageData(
    new Uint8ClampedArray(master.data),
    master.width,
    master.height,
  );
  const map = buildShirtMap(AGENT_SHEET_PALETTE, color);
  if (map.size === 0) return copy;

  const data = copy.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const replacement = map.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    if (replacement === undefined) continue;
    data[i] = (replacement >> 16) & 0xff;
    data[i + 1] = (replacement >> 8) & 0xff;
    data[i + 2] = replacement & 0xff;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// マスターシートの用意（同期の仮絵 → 非同期で本物に差し替え）
// ---------------------------------------------------------------------------

const proceduralMasters = new Map<CharacterVariant, ImageData>();
const artMasters = new Map<CharacterVariant, ImageData>();
const artRequested = new Set<CharacterVariant>();
let sheetVersion = 0;
const versionListeners = new Set<() => void>();

/**
 * マスターシートを用意します。最初の呼び出しでは手続き描画の仮絵を
 * **同期で**返し、Manager PNG があれば裏で読み込んで差し替えます。
 * 名簿（React 側）が同期で絵を欲しがるので、この二段構えにしています。
 */
function ensureMaster(variant: CharacterVariant): ImageData | null {
  const artMaster = artMasters.get(variant);
  if (artMaster) return artMaster;
  const existing = proceduralMasters.get(variant);
  if (existing) return existing;

  const canvas = document.createElement('canvas');
  canvas.width = SHEET_WIDTH;
  canvas.height = SHEET_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  drawProceduralMaster(context, variant);
  const master = context.getImageData(0, 0, SHEET_WIDTH, SHEET_HEIGHT);
  proceduralMasters.set(variant, master);

  loadArtMaster(variant);
  return master;
}

/** 本物のドット絵シートを読み込み、間に合ったところで丸ごと差し替えます。 */
function loadArtMaster(variant: CharacterVariant): void {
  if (variant !== 'manager' || artRequested.has(variant) || !MANAGER_SHEET_PNG) return;
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
  image.src = MANAGER_SHEET_PNG;
}

/** 絵が差し替わったら、アトラスも名簿のアイコンも作り直します。 */
function onMasterChanged(): void {
  portraitCache.clear();
  for (const [slot, details] of slotDetails) paintSlot(slot, details.variant, details.color);
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

function slotKey(variant: CharacterVariant, color: number): string {
  return `${variant}:${color}`;
}

/** 枠 1つぶんを、服の色を差し替えたうえでアトラスへ焼きます。 */
function paintSlot(slot: number, variant: CharacterVariant, color: number): void {
  if (!atlasCanvas) return;
  const context = atlasCanvas.getContext('2d');
  if (!context) return;
  const sheet = swappedSheet(variant, color);
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
    for (const [slot, details] of slotDetails) paintSlot(slot, details.variant, details.color);
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

function allocateSlot(key: string, variant: CharacterVariant, color: number): number {
  if (slots.size < MAX_SLOTS) {
    const slot = slots.size;
    slots.set(key, slot);
    slotDetails.set(slot, { variant, color });
    addSlotFrames(slot);
    return slot;
  }
  // 枠を使いきったら、一番古い組み合わせの枠を明け渡します。
  const [oldest] = slots.keys();
  const slot = slots.get(oldest) as number;
  slots.delete(oldest);
  slots.set(key, slot);
  slotDetails.set(slot, { variant, color });
  return slot;
}

/**
 * 服の色ごとに、アトラスの枠とアニメを 1度だけ用意します。
 * 返すのは枠番号で、テクスチャはいつでも `ATLAS_KEY` です。
 */
export function ensureCharacterSheet(
  scene: Phaser.Scene,
  color: number,
  duty: AgentDuty,
): number {
  ensureAtlas(scene);

  const variant = characterVariantForDuty(duty);
  const key = slotKey(variant, color);
  const existing = slots.get(key);
  const slot = existing ?? allocateSlot(key, variant, color);
  if (existing === undefined) {
    paintSlot(slot, variant, color);
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
 * 絵を差し替えれば名簿のアイコンも自動で追従します。色ごとに一度だけ作ります。
 */
export function characterPortrait(color: number, duty: AgentDuty): string {
  const variant = characterVariantForDuty(duty);
  const key = slotKey(variant, color);
  const cached = portraitCache.get(key);
  if (cached !== undefined) return cached;

  const sheet = swappedSheet(variant, color);
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
