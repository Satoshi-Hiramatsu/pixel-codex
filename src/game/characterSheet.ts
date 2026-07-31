import Phaser from 'phaser';

import { AGENT_SHEET_PALETTE, AGENT_SHEET_PNG, type SheetPalette } from '../assets/agentSheet';

/**
 * 4方向スプライトの土台。
 *
 * 絵のならびは市販のキャラチップ（LPC / ぴぽや形式）と同じで、
 *
 *   列 = アニメのコマ（0:直立 / 1:右足前 / 2:左足前）
 *   行 = 向き（0:正面 down / 1:左 left / 2:右 right / 3:背面 up）
 *
 * 1コマ 64×64、シート全体で 192×256 です。
 *
 * ■ 絵の出どころ（マスターシート）
 *   `src/assets/agentSheet.ts` に data URI があればそれを使い、無ければ
 *   下の手続き描画で仮のキャラを描きます。どちらの場合も服は白〜グレーで、
 *   社員ごとの色は「パレット差し替え」で後から入れます。
 *
 * ■ なぜ 1枚のアトラスに焼くのか
 *   社員の色ごとにテクスチャを作ると、色の数だけテクスチャが切り替わって
 *   スプライトのバッチ描画が分断されます。FC/SFC が実機でやっていたのと同じく
 *   「絵は1枚、パレットだけ差し替える」形にして、全員を 1テクスチャにまとめています。
 */
export const FRAME_WIDTH = 64;
export const FRAME_HEIGHT = 64;

export type Facing = 'down' | 'left' | 'right' | 'up';

/** シートの行順。PNG に差し替えるときも、この順番に並べてください。 */
export const facings: Facing[] = ['down', 'left', 'right', 'up'];
const FRAMES_PER_FACING = 3;

/** マスターシート 1枚ぶんの大きさ。 */
export const SHEET_WIDTH = FRAME_WIDTH * FRAMES_PER_FACING;
export const SHEET_HEIGHT = FRAME_HEIGHT * 4;

/** 全社員が共有する、たった 1枚のテクスチャ。 */
export const ATLAS_KEY = 'agent-atlas';
/** アトラスに並べられる色の数。これを超えたら古い枠から使い回します。 */
const MAX_SLOTS = 16;
const SLOTS_PER_ROW = 4;
const ATLAS_WIDTH = SHEET_WIDTH * SLOTS_PER_ROW;
const ATLAS_HEIGHT = SHEET_HEIGHT * Math.ceil(MAX_SLOTS / SLOTS_PER_ROW);

// ---------------------------------------------------------------------------
// 仮キャラの手続き描画（本物の絵が来るまでのつなぎ）
// ---------------------------------------------------------------------------

const SKIN = '#e6b88c';
const SKIN_SHADE = '#c9986f';
const HAIR = '#3a2b24';
const HAIR_LIGHT = '#4b3930';
const OUTLINE = '#1e282c';
const SHOE = '#2b3238';
const TROUSER = '#3f4a52';
const TROUSER_SHADE = '#37424a';
/** 服は必ずこの 2色で描きます。`AGENT_SHEET_PALETTE.shirt` と一致させてください。 */
const SHIRT_LIGHT = '#ffffff';
const SHIRT_DARK = '#c7c7c7';

/**
 * 下絵は 32×40 の座標で描き、この倍率で 48×60 に引き伸ばします。
 * `box()` が拡大後に整数へ丸めるので、斜めのにじみは出ません。
 */
const ART_SCALE = 1.5;
const ART_WIDTH = 32 * ART_SCALE;
const ART_HEIGHT = 40 * ART_SCALE;
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
  // 左上と右下をそれぞれ丸めることで、四角どうしのすき間をなくします。
  const left = Math.round(x * ART_SCALE);
  const top = Math.round(y * ART_SCALE);
  const right = Math.round((x + width) * ART_SCALE);
  const bottom = Math.round((y + height) * ART_SCALE);
  context.fillStyle = color;
  context.fillRect(left, top, right - left, bottom - top);
}

/** 縁取り付きの四角。ドット絵らしい輪郭を 1px ぶんつけます。 */
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

/** 3コマぶんの足の上下。0コマ目は直立、1/2コマ目で左右の足を交互に出します。 */
function legOffsets(frame: number): LegOffsets {
  if (frame === 1) return { left: -2, right: 1 };
  if (frame === 2) return { left: 1, right: -2 };
  return { left: 0, right: 0 };
}

function drawFacingDown(context: CanvasRenderingContext2D, frame: number): void {
  const legs = legOffsets(frame);
  box(context, 10, 30 + legs.left, 5, 8 - legs.left, TROUSER);
  box(context, 17, 30 + legs.right, 5, 8 - legs.right, TROUSER);
  box(context, 10, 36, 5, 2, SHOE);
  box(context, 17, 36, 5, 2, SHOE);
  outlinedBox(context, 7, 18, 18, 13, SHIRT_LIGHT);
  box(context, 7, 28, 18, 3, SHIRT_DARK);
  outlinedBox(context, 4, 19, 3, 9, SKIN);
  outlinedBox(context, 25, 19, 3, 9, SKIN);
  // 顔は正面だけ全部見えます。
  outlinedBox(context, 8, 4, 16, 15, HAIR);
  box(context, 10, 11, 12, 8, SKIN);
  box(context, 10, 17, 12, 2, SKIN_SHADE);
  box(context, 12, 13, 2, 2, OUTLINE);
  box(context, 18, 13, 2, 2, OUTLINE);
  box(context, 9, 5, 7, 2, HAIR_LIGHT);
}

function drawFacingSide(
  context: CanvasRenderingContext2D,
  frame: number,
  direction: -1 | 1,
): void {
  const legs = legOffsets(frame);
  box(context, 12, 30 + legs.left, 5, 8 - legs.left, TROUSER);
  box(context, 15, 30 + legs.right, 5, 8 - legs.right, TROUSER_SHADE);
  box(context, 12, 36, 5, 2, SHOE);
  outlinedBox(context, 9, 18, 14, 13, SHIRT_LIGHT);
  box(context, 9, 28, 14, 3, SHIRT_DARK);
  // 前に出したうでは、進む向き側にだけ見えます。
  outlinedBox(context, direction === 1 ? 22 : 7, 19 + (frame === 1 ? -1 : 0), 3, 9, SKIN);
  outlinedBox(context, 9, 4, 14, 15, HAIR);
  // よこ顔：ほおが見えるのは進む向き側だけ。
  const cheekX = direction === 1 ? 18 : 10;
  box(context, cheekX, 11, 5, 8, SKIN);
  box(context, cheekX, 17, 5, 2, SKIN_SHADE);
  box(context, direction === 1 ? 20 : 11, 13, 2, 2, OUTLINE);
  box(context, 10, 5, 7, 2, HAIR_LIGHT);
}

function drawFacingUp(context: CanvasRenderingContext2D, frame: number): void {
  const legs = legOffsets(frame);
  box(context, 10, 30 + legs.left, 5, 8 - legs.left, TROUSER);
  box(context, 17, 30 + legs.right, 5, 8 - legs.right, TROUSER);
  box(context, 10, 36, 5, 2, SHOE);
  box(context, 17, 36, 5, 2, SHOE);
  outlinedBox(context, 7, 18, 18, 13, SHIRT_LIGHT);
  box(context, 7, 28, 18, 3, SHIRT_DARK);
  outlinedBox(context, 4, 19, 3, 9, SKIN);
  outlinedBox(context, 25, 19, 3, 9, SKIN);
  // 背面は後頭部だけ。顔のパーツは描きません。
  outlinedBox(context, 8, 4, 16, 15, HAIR);
  box(context, 11, 7, 10, 9, HAIR_LIGHT);
  box(context, 10, 17, 12, 2, SKIN_SHADE);
}

function drawFrame(context: CanvasRenderingContext2D, facing: Facing, frame: number): void {
  if (facing === 'down') drawFacingDown(context, frame);
  else if (facing === 'up') drawFacingUp(context, frame);
  else drawFacingSide(context, frame, facing === 'right' ? 1 : -1);
}

/** 手続き描画で 192×256 のマスターシートを 1枚こしらえます。 */
function drawProceduralMaster(context: CanvasRenderingContext2D): void {
  facings.forEach((facing, rowIndex) => {
    for (let frame = 0; frame < FRAMES_PER_FACING; frame += 1) {
      context.save();
      context.translate(
        frame * FRAME_WIDTH + ART_OFFSET_X,
        rowIndex * FRAME_HEIGHT + ART_OFFSET_Y,
      );
      drawFrame(context, facing, frame);
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
function swappedSheet(color: number): ImageData | null {
  const master = ensureMaster();
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

let masterData: ImageData | null = null;
let artRequested = false;
let sheetVersion = 0;
const versionListeners = new Set<() => void>();

/**
 * マスターシートを用意します。最初の呼び出しでは手続き描画の仮絵を
 * **同期で**返し、`AGENT_SHEET_PNG` があれば裏で読み込んで差し替えます。
 * 名簿（React 側）が同期で絵を欲しがるので、この二段構えにしています。
 */
function ensureMaster(): ImageData | null {
  if (masterData) return masterData;

  const canvas = document.createElement('canvas');
  canvas.width = SHEET_WIDTH;
  canvas.height = SHEET_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  drawProceduralMaster(context);
  masterData = context.getImageData(0, 0, SHEET_WIDTH, SHEET_HEIGHT);

  loadArtMaster();
  return masterData;
}

/** 本物のドット絵シートを読み込み、間に合ったところで丸ごと差し替えます。 */
function loadArtMaster(): void {
  if (artRequested || !AGENT_SHEET_PNG) return;
  artRequested = true;

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
    masterData = context.getImageData(0, 0, SHEET_WIDTH, SHEET_HEIGHT);
    onMasterChanged();
  };
  image.onerror = () => {
    console.warn('[characterSheet] シートを読み込めませんでした。仮キャラのまま続行します。');
  };
  image.src = AGENT_SHEET_PNG;
}

/** 絵が差し替わったら、アトラスも名簿のアイコンも作り直します。 */
function onMasterChanged(): void {
  portraitCache.clear();
  for (const [color, slot] of slots) paintSlot(slot, color);
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

/** 服の色 → アトラスの枠番号。 */
const slots = new Map<number, number>();
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

/** 枠 1つぶんを、服の色を差し替えたうえでアトラスへ焼きます。 */
function paintSlot(slot: number, color: number): void {
  if (!atlasCanvas) return;
  const context = atlasCanvas.getContext('2d');
  if (!context) return;
  const sheet = swappedSheet(color);
  if (!sheet) return;
  const { x, y } = slotOrigin(slot);
  // putImageData は合成せずに置き換えるので、先に消す必要はありません。
  context.putImageData(sheet, x, y);
}

/** 枠 1つぶんの 12コマを、テクスチャのフレームとして登録します。 */
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
    for (const [color, slot] of slots) paintSlot(slot, color);
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

function allocateSlot(color: number): number {
  if (slots.size < MAX_SLOTS) {
    const slot = slots.size;
    slots.set(color, slot);
    addSlotFrames(slot);
    return slot;
  }
  // 枠を使いきったら、一番古い色の枠を明け渡します。社員が 16人を超えて
  // なお全員の服の色が違う、というときだけの保険です。
  const [oldest] = slots.keys();
  const slot = slots.get(oldest) as number;
  slots.delete(oldest);
  slots.set(color, slot);
  return slot;
}

/**
 * 服の色ごとに、アトラスの枠とアニメを 1度だけ用意します。
 * 返すのは枠番号で、テクスチャはいつでも `ATLAS_KEY` です。
 */
export function ensureCharacterSheet(scene: Phaser.Scene, color: number): number {
  ensureAtlas(scene);

  const existing = slots.get(color);
  const slot = existing ?? allocateSlot(color);
  if (existing === undefined) {
    paintSlot(slot, color);
    atlasTexture?.refresh();
  }

  for (const facing of facings) {
    const walk = animationKey(slot, facing, true);
    if (!scene.anims.exists(walk)) {
      scene.anims.create({
        key: walk,
        // 0（直立）を挟むと、2コマでもちゃんと歩いて見えます。
        frames: [1, 0, 2, 0].map((frame) => ({
          key: ATLAS_KEY,
          frame: frameName(slot, facing, frame),
        })),
        frameRate: 7,
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

const portraitCache = new Map<number, string>();

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
export function characterPortrait(color: number): string {
  const cached = portraitCache.get(color);
  if (cached !== undefined) return cached;

  const sheet = swappedSheet(color);
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
  portraitCache.set(color, url);
  return url;
}
