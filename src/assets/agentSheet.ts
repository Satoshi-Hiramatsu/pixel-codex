import managerSheetUrl from '../../assets/sprites/manager-sheet.png';
import plannerSheetUrl from '../../assets/sprites/planner-sheet.png';
import researcherSheetUrl from '../../assets/sprites/researcher-sheet.png';
import coderSheetUrl from '../../assets/sprites/coder-sheet.png';
import testerSheetUrl from '../../assets/sprites/tester-sheet.png';
import reviewerSheetUrl from '../../assets/sprites/reviewer-sheet.png';
import designerSheetUrl from '../../assets/sprites/designer-sheet.png';
import accountantSheetUrl from '../../assets/sprites/accountant-sheet.png';
import communicatorSheetUrl from '../../assets/sprites/communicator-sheet.png';
import writerSheetUrl from '../../assets/sprites/writer-sheet.png';
import generalSheetUrl from '../../assets/sprites/general-sheet.png';

import type { AgentDuty } from '../types';

/**
 * 社員キャラのドット絵シート。
 *
 * 全担当の `assets/sprites/*-sheet.png` を webpack の asset/resource で読み込みます。
 * 統括は `tools/build_manager_sheet.py`、ほか10担当は
 * `tools/build_character_sheets.py` で元絵から作り直します。
 * すべて256×256（64px × 4列 × 4行）のPNGです。
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
 * 担当別の専用256×256 PNG。読み込めない担当だけ手続き描画へ戻ります。
 */
export const AGENT_SHEET_PNGS: Record<AgentDuty, string> = {
  director: managerSheetUrl,
  planner: plannerSheetUrl,
  researcher: researcherSheetUrl,
  coder: coderSheetUrl,
  tester: testerSheetUrl,
  reviewer: reviewerSheetUrl,
  designer: designerSheetUrl,
  accountant: accountantSheetUrl,
  communicator: communicatorSheetUrl,
  writer: writerSheetUrl,
  general: generalSheetUrl,
};

/** 既存ツールとの互換用。新規コードでは `AGENT_SHEET_PNGS` を使います。 */
export const MANAGER_SHEET_PNG: string = AGENT_SHEET_PNGS.director;

/**
 * パレット差し替えの対象にする白いシャツの基準色。
 * 専用画像に同じ色が無い場合、その色はそのまま保持されます。
 */
export const AGENT_SHEET_PALETTE: SheetPalette = {
  shirt: ['#ffffff', '#c7c7c7'],
};
