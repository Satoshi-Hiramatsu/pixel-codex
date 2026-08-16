/** Pixel Codex の全ドット画で共有する最小描画単位。 */
export const PIXEL_UNIT = 2;

/**
 * キャラクターとオフィスで共有する基準色。
 * 各素材は light / base / shade / outline の4段階以内で構成します。
 */
export const PIXEL_PALETTE = {
  outline: 0x1e282c,
  deepShadow: 0x263136,

  wallLight: 0x718a98,
  wall: 0x53687a,
  wallShade: 0x3d4f5e,

  floorLight: 0xd8c49d,
  floor: 0xcbb289,
  floorShade: 0xb99d73,

  woodLight: 0xb98552,
  wood: 0x8a5a34,
  woodShade: 0x54371f,

  metalLight: 0x91aab2,
  metal: 0x5f7882,
  metalShade: 0x344951,

  paperLight: 0xfff7df,
  paper: 0xe4d8b7,
  paperShade: 0xb9a883,

  screen: 0x65b7d8,
  screenLight: 0x9fd7e4,
  success: 0x78b56c,
  warning: 0xf0bd55,
  danger: 0xe1775b,

  leafLight: 0x78a968,
  leaf: 0x54804c,
  leafShade: 0x355c3a,
} as const;

/** 任意の値を2pxグリッド上へ丸めます。 */
export function snapPixel(value: number): number {
  return Math.round(value / PIXEL_UNIT) * PIXEL_UNIT;
}

/** 2色を混ぜ、ドット画用の不透明な中間色を作ります。 */
export function mixPixelColor(from: number, toward: number, ratio: number): number {
  const amount = Math.max(0, Math.min(1, ratio));
  const channel = (shift: number): number => {
    const start = (from >> shift) & 0xff;
    const end = (toward >> shift) & 0xff;
    return Math.round(start + (end - start) * amount);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export function lightenPixelColor(color: number, ratio = 0.12): number {
  return mixPixelColor(color, 0xffffff, ratio);
}

export function shadePixelColor(color: number, ratio = 0.16): number {
  return mixPixelColor(color, PIXEL_PALETTE.outline, ratio);
}
