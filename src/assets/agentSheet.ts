import managerSheetUrl from '../../assets/sprites/manager-sheet.png';

/**
 * 社員キャラのドット絵シート。
 *
 * Manager系は `assets/sprites/manager-sheet.png` を webpack の asset/resource で
 * 読み込みます。元絵から作り直すときは `tools/build_manager_sheet.py` を実行します。
 * 256×256（64px × 4列 × 4行）の PNG だけを受け付けます。
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
 * Manager系の256×256 PNG。`null` のときだけ手続き描画へ戻ります。
 */
export const MANAGER_SHEET_PNG: string | null = managerSheetUrl;

/**
 * 手続き描画の仮キャラが服に使っている色。
 * 本物の絵に差し替えるときは spriteforge が実際に使われた色を書き出します。
 */
export const AGENT_SHEET_PALETTE: SheetPalette = {
  shirt: ['#ffffff', '#c7c7c7'],
};
