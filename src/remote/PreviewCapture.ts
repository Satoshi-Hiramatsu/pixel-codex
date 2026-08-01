import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, desktopCapturer, type NativeImage } from 'electron';

import type { RemotePreviewViewport } from './RemoteProtocol';

export type PreviewViewport = RemotePreviewViewport;

/** 端末で「スマホでの見た目」と「PCでの見た目」を撮り分けるための2種類だけ用意します。 */
const viewportSizes: Record<PreviewViewport, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};

/** 端末の画面に収まればよいので、これ以上大きく送っても通信量が増えるだけです。 */
const maxDeliveredWidth = 1080;
const jpegQuality = 72;
const loadTimeoutMs = 15_000;
/** 読み込み完了後の待ち。Webフォントの適用と初期アニメーションを落ち着かせます。 */
const settleMs = 400;
/** 読み込みを中断した扱い。利用者が撮り直したときなどに出るので失敗にはしません。 */
const abortedErrorCode = -3;

export interface CapturedPreview {
  filePath: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}

export interface CapturableWindow {
  id: string;
  label: string;
}

function previewTempRoot(): string {
  return path.join(app.getPath('temp'), 'pixel-codex-previews');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

/**
 * 撮ったものを端末へ渡せる形にします。PNGのままだと1枚が数百KBになるため、
 * 幅を詰めてJPEGへ落とし、1枚あたり数十KB台に収めます。
 */
async function writeImage(image: NativeImage): Promise<CapturedPreview> {
  if (image.isEmpty()) throw new Error('画面を取得できませんでした。');
  const original = image.getSize();
  const delivered = original.width > maxDeliveredWidth
    ? image.resize({ width: maxDeliveredWidth, quality: 'good' })
    : image;
  const data = delivered.toJPEG(jpegQuality);
  await fs.mkdir(previewTempRoot(), { recursive: true });
  const filePath = path.join(previewTempRoot(), `${randomUUID()}.jpg`);
  await fs.writeFile(filePath, data, { mode: 0o600 });
  const size = delivered.getSize();
  return {
    filePath,
    mimeType: 'image/jpeg',
    width: size.width,
    height: size.height,
    bytes: data.length,
  };
}

/**
 * 読み込みの完了を待ちます。時間切れになっても、そこまで描けている分は撮ります。
 * 外部リソースを1つ待ち続けるだけで何も見られないほうが困るためです。
 */
function loadWithTimeout(window: BrowserWindow, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (!window.isDestroyed()) window.webContents.stop();
      finish();
    }, loadTimeoutMs);

    window.webContents.once('did-finish-load', () => finish());
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      // 画像1枚の失敗で撮影ごと諦めないよう、本体の読み込みが落ちたときだけ止めます。
      if (!isMainFrame || errorCode === abortedErrorCode) return;
      finish(new Error(`表示できませんでした（${errorDescription || errorCode}）`));
    });
    window.loadURL(url).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * URLを非表示のウィンドウで描いて撮ります。撮るためだけの窓なので、こちらの世界へ
 * つながる口はすべて閉じ、通常のセッションとは別のpartitionに隔離します。
 */
export async function captureUrl(url: string, viewport: PreviewViewport): Promise<CapturedPreview> {
  const size = viewportSizes[viewport] ?? viewportSizes.desktop;
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: size.width,
    height: size.height,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: 'preview',
      // 非表示のままなので、描画を止められると真っ白なものを撮ってしまいます。
      backgroundThrottling: false,
    },
  });
  // 撮影用の窓から新しい窓やページ遷移を始めさせません。
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await loadWithTimeout(window, url);
    await delay(settleMs);
    return await writeImage(await window.webContents.capturePage());
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

/** PC上で開いているウィンドウと画面の一覧。要求のたびに取り直します。 */
export async function listCapturableWindows(): Promise<CapturableWindow[]> {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    // 一覧を出すだけなので画は要りません。ここを大きくすると列挙が目に見えて遅くなります。
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources
    .filter((source) => source.name.trim().length > 0)
    .map((source) => ({ id: source.id, label: source.name.trim().slice(0, 120) }));
}

export async function captureWindow(sourceId: string): Promise<CapturedPreview> {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 1600, height: 1600 },
  });
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error('そのウィンドウはもう開いていません。');
  if (source.thumbnail.isEmpty()) {
    throw new Error('そのウィンドウは最小化されているため撮影できません。');
  }
  return writeImage(source.thumbnail);
}

/** 一時ファイルの置き場ごと片付けます。アプリ終了時に呼びます。 */
export async function discardPreviews(): Promise<void> {
  await fs.rm(previewTempRoot(), { recursive: true, force: true }).catch(() => undefined);
}
