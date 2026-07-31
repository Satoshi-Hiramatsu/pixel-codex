/**
 * 社員キャラのドット絵シート。
 *
 * `tools/spriteforge.html` に画像生成AIで描いた 4方向（正面・左・右・背面）の
 * 立ち絵を投入すると、このファイルまるごとを書き出してくれます。
 * 中身を丸ごと貼り替えるだけで、フロアのキャラと名簿のアイコンが差し替わります。
 *
 * PNG を webpack の `asset/resource` で読まず data URI で持っているのは、
 *
 *   - 絵がまだ無くてもビルドが通る（＝先にコード側を進められる）
 *   - パッケージ版でも読み込みパスの心配がいらない
 *   - Phaser のローダーを経由しないので `preload()` が不要
 *
 * ためです。192×256（64px × 3列 × 4行）の PNG しか受け付けません。
 */

/** シートの中で「塗り替えてよい色」の定義。 */
export interface SheetPalette {
  /**
   * 服として社員の色に塗り替える色。**明るい順**にならべます。
   *
   * 一番明るい色を基準にした相対的な明るさをそのまま保つので、
   * 何色のグラデーションでも（2色でも4色でも）そのまま扱えます。
   * シート側の服は白〜グレーで描いておいてください。
   */
  shirt: string[];
}

/**
 * 192×256 の PNG を `data:image/png;base64,...` の形で入れます。
 * `null` のあいだは `characterSheet.ts` が手続き描画の仮キャラを使います。
 */
export const AGENT_SHEET_PNG: string | null = null;

/**
 * 手続き描画の仮キャラが服に使っている色。
 * 本物の絵に差し替えるときは spriteforge が実際に使われた色を書き出します。
 */
export const AGENT_SHEET_PALETTE: SheetPalette = {
  shirt: ['#ffffff', '#c7c7c7'],
};
