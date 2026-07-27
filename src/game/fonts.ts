/**
 * DotGothic16 is a Japanese dot-matrix face, so it carries the retro-game look
 * for every label drawn inside the office. The fallbacks are bitmap-ish system
 * fonts, keeping the same feel if the webfont has not arrived yet.
 */
export const RETRO_FONT = '"DotGothic16", "MS Gothic", "Osaka-Mono", monospace';

/**
 * Resolves once DotGothic16 can actually be painted. Phaser rasterises text into
 * a texture the moment it is created, so the scene must not start before this.
 */
export async function waitForRetroFont(timeoutMs = 4000): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  const load = Promise.all([
    fonts.load('16px "DotGothic16"', 'あア亜Ag0'),
    fonts.load('bold 16px "DotGothic16"', 'あア亜Ag0'),
  ]);
  const timeout = new Promise<void>((resolve) => {
    window.setTimeout(resolve, timeoutMs);
  });
  // Never block the office on a slow or offline font host.
  await Promise.race([load.then(() => undefined).catch(() => undefined), timeout]);
}
