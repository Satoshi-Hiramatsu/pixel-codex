import type Phaser from 'phaser';

/**
 * DotGothic16 is a Japanese dot-matrix face, so it carries the retro-game look
 * for every label drawn inside the office. The fallbacks are bitmap-ish system
 * fonts, keeping the same feel if the webfont has not arrived yet.
 */
export const RETRO_FONT = '"DotGothic16", "MS Gothic", "Osaka-Mono", monospace';

let fontReady: Promise<void> | undefined;

/**
 * Resolves once DotGothic16 can actually be painted. Phaser rasterises text into
 * a texture the moment it is created, so the scene must not start before this.
 */
/**
 * Phaser rasterises text into a texture once, so the texture has to be made at
 * the size it will actually be shown at. The office is drawn 1 world unit to
 * 1 device pixel, so the camera zoom *is* the on-screen scale of the text.
 * Rounding up never upscales a texture, which is what looks blurry.
 */
export function textResolutionFor(scene: Phaser.Scene): number {
  const zoom = scene.cameras?.main?.zoom || 1;
  return Math.max(1, Math.min(3, Math.ceil(zoom)));
}

export async function waitForRetroFont(timeoutMs = 1200): Promise<void> {
  if (!fontReady) {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const load = Promise.all([
      fonts.load('16px "DotGothic16"', 'あア亜Ag0'),
      fonts.load('bold 16px "DotGothic16"', 'あア亜Ag0'),
    ]);
    const timeout = new Promise<void>((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    });
    // React Strict Mode mounts effects twice in development. Cache the race so
    // both mounts share one request and offline startup cannot fan out errors.
    fontReady = Promise.race([load.then(() => undefined).catch(() => undefined), timeout]);
  }
  await fontReady;
}
