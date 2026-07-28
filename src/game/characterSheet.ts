import Phaser from 'phaser';

/**
 * 4方向スプライトの雛形。
 *
 * 本物のドット絵を描くまでのあいだ、社員の服の色から 4方向 × 3コマ の
 * スプライトシートをその場で描き起こして Phaser のテクスチャに登録します。
 * 生成物のならびは市販のキャラチップ（LPC / ぴぽや形式）と同じで、
 *
 *   列 = アニメのコマ（0:直立 / 1:右足前 / 2:左足前）
 *   行 = 向き（0:正面 down / 1:左 left / 2:右 right / 3:背面 up）
 *
 * になっています。PNG に差し替えるときは `loadCharacterSheet()` の方を使えば、
 * フレーム名（`down-0` など）とアニメ名（`...-walk-down` など）はそのままです。
 * 詳しい手順は docs/sprite-guide.md を参照してください。
 */
export const FRAME_WIDTH = 32;
export const FRAME_HEIGHT = 40;

export type Facing = 'down' | 'left' | 'right' | 'up';

/** シートの行順。PNG に差し替えるときも、この順番に並べてください。 */
export const facings: Facing[] = ['down', 'left', 'right', 'up'];
const FRAMES_PER_FACING = 3;

const SKIN = '#e6b88c';
const SKIN_SHADE = '#c9986f';
const HAIR = '#3a2b24';
const HAIR_LIGHT = '#4b3930';
const OUTLINE = '#1e282c';
const SHOE = '#2b3238';

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** 服の色を少し暗くして、影や裾に使います。 */
function shade(color: number, amount: number): string {
  const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 0xff) * amount)));
  const g = Math.max(0, Math.min(255, Math.round(((color >> 8) & 0xff) * amount)));
  const b = Math.max(0, Math.min(255, Math.round((color & 0xff) * amount)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function box(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  context.fillStyle = color;
  context.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}

/** 縁取り付きの四角。ドット絵らしい輪郭を 1px でつけます。 */
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

function drawFacingDown(
  context: CanvasRenderingContext2D,
  shirt: number,
  frame: number,
): void {
  const legs = legOffsets(frame);
  box(context, 10, 30 + legs.left, 5, 8 - legs.left, '#3f4a52');
  box(context, 17, 30 + legs.right, 5, 8 - legs.right, '#3f4a52');
  box(context, 10, 36, 5, 2, SHOE);
  box(context, 17, 36, 5, 2, SHOE);
  outlinedBox(context, 7, 18, 18, 13, hex(shirt));
  box(context, 7, 28, 18, 3, shade(shirt, 0.78));
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
  shirt: number,
  frame: number,
  direction: -1 | 1,
): void {
  const legs = legOffsets(frame);
  const flip = direction === 1 ? 0 : 0;
  box(context, 12 + flip, 30 + legs.left, 5, 8 - legs.left, '#3f4a52');
  box(context, 15 + flip, 30 + legs.right, 5, 8 - legs.right, '#37424a');
  box(context, 12 + flip, 36, 5, 2, SHOE);
  outlinedBox(context, 9, 18, 14, 13, hex(shirt));
  box(context, 9, 28, 14, 3, shade(shirt, 0.78));
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

function drawFacingUp(
  context: CanvasRenderingContext2D,
  shirt: number,
  frame: number,
): void {
  const legs = legOffsets(frame);
  box(context, 10, 30 + legs.left, 5, 8 - legs.left, '#3f4a52');
  box(context, 17, 30 + legs.right, 5, 8 - legs.right, '#3f4a52');
  box(context, 10, 36, 5, 2, SHOE);
  box(context, 17, 36, 5, 2, SHOE);
  outlinedBox(context, 7, 18, 18, 13, hex(shirt));
  box(context, 7, 28, 18, 3, shade(shirt, 0.78));
  outlinedBox(context, 4, 19, 3, 9, SKIN);
  outlinedBox(context, 25, 19, 3, 9, SKIN);
  // 背面は後頭部だけ。顔のパーツは描きません。
  outlinedBox(context, 8, 4, 16, 15, HAIR);
  box(context, 11, 7, 10, 9, HAIR_LIGHT);
  box(context, 10, 17, 12, 2, SKIN_SHADE);
}

function drawFrame(
  context: CanvasRenderingContext2D,
  facing: Facing,
  frame: number,
  shirt: number,
): void {
  if (facing === 'down') drawFacingDown(context, shirt, frame);
  else if (facing === 'up') drawFacingUp(context, shirt, frame);
  else drawFacingSide(context, shirt, frame, facing === 'right' ? 1 : -1);
}

export function sheetKey(color: number): string {
  return `agent-sheet-${color.toString(16).padStart(6, '0')}`;
}

const portraitCache = new Map<number, string>();

/**
 * 名簿など、Phaserのキャンバスの外（HTML側）でキャラを出したいとき用に、
 * 正面向き・直立コマを PNG のデータURIとして書き出します。
 *
 * フロアのキャラとまったく同じ描画関数を通すので、絵を描き替えても
 * 名簿のアイコンは自動で追従します。色ごとに一度だけ生成して使い回します。
 */
export function characterPortrait(color: number): string {
  const cached = portraitCache.get(color);
  if (cached !== undefined) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return '';
  context.imageSmoothingEnabled = false;
  drawFrame(context, 'down', 0, color);

  const url = canvas.toDataURL('image/png');
  portraitCache.set(color, url);
  return url;
}

export function animationKey(color: number, facing: Facing, moving: boolean): string {
  return `${sheetKey(color)}-${moving ? 'walk' : 'idle'}-${facing}`;
}

/**
 * 服の色ごとにシートとアニメを 1 度だけ用意します。すでにあれば作り直しません。
 */
export function ensureCharacterSheet(scene: Phaser.Scene, color: number): string {
  const key = sheetKey(color);
  if (!scene.textures.exists(key)) {
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_WIDTH * FRAMES_PER_FACING;
    canvas.height = FRAME_HEIGHT * facings.length;
    const context = canvas.getContext('2d');
    if (!context) return key;
    context.imageSmoothingEnabled = false;

    facings.forEach((facing, rowIndex) => {
      for (let frame = 0; frame < FRAMES_PER_FACING; frame += 1) {
        context.save();
        context.translate(frame * FRAME_WIDTH, rowIndex * FRAME_HEIGHT);
        drawFrame(context, facing, frame, color);
        context.restore();
      }
    });

    const texture = scene.textures.addCanvas(key, canvas);
    if (texture) {
      facings.forEach((facing, rowIndex) => {
        for (let frame = 0; frame < FRAMES_PER_FACING; frame += 1) {
          texture.add(
            `${facing}-${frame}`,
            0,
            frame * FRAME_WIDTH,
            rowIndex * FRAME_HEIGHT,
            FRAME_WIDTH,
            FRAME_HEIGHT,
          );
        }
      });
      texture.refresh();
    }
  }

  for (const facing of facings) {
    const walk = animationKey(color, facing, true);
    if (!scene.anims.exists(walk)) {
      scene.anims.create({
        key: walk,
        // 0（直立）を挟むと、2コマでもちゃんと歩いて見えます。
        frames: [1, 0, 2, 0].map((frame) => ({ key, frame: `${facing}-${frame}` })),
        frameRate: 7,
        repeat: -1,
      });
    }
    const idle = animationKey(color, facing, false);
    if (!scene.anims.exists(idle)) {
      scene.anims.create({
        key: idle,
        frames: [{ key, frame: `${facing}-0` }],
        frameRate: 1,
        repeat: -1,
      });
    }
  }

  return key;
}

/**
 * 本物のドット絵に差し替えるときの入口。
 * 32x40 のコマを 3列 × 4行（down / left / right / up）に並べた PNG を
 * `scene.load.spritesheet(key, url, { frameWidth: 32, frameHeight: 40 })` で
 * 読み込んでから呼ぶと、生成版とまったく同じアニメ名で使えます。
 */
export function registerLoadedSheetAnimations(scene: Phaser.Scene, key: string): void {
  facings.forEach((facing, rowIndex) => {
    const base = rowIndex * FRAMES_PER_FACING;
    const walk = `${key}-walk-${facing}`;
    if (!scene.anims.exists(walk)) {
      scene.anims.create({
        key: walk,
        frames: [base + 1, base, base + 2, base].map((frame) => ({ key, frame })),
        frameRate: 7,
        repeat: -1,
      });
    }
    const idle = `${key}-idle-${facing}`;
    if (!scene.anims.exists(idle)) {
      scene.anims.create({
        key: idle,
        frames: [{ key, frame: base }],
        frameRate: 1,
        repeat: -1,
      });
    }
  });
}
