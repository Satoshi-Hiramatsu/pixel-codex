// レンダラーからも読む場所なので、electronに触れるモジュールへは依存させません。
import type {
  RemotePreviewSourceKind,
  RemotePreviewSourceSummary,
  RemotePreviewViewport,
} from './RemoteProtocol';

export type PreviewSourceKind = RemotePreviewSourceKind;

/**
 * 端末が選べる撮影対象。端末からは必ずこの一覧のidだけを送らせ、URLやパスは
 * 一切受け取りません。PCが登録したものしか撮れない状態を保つためです。
 */
export interface PreviewSource {
  id: string;
  kind: PreviewSourceKind;
  label: string;
  /** kind === 'url' のときの宛先。 */
  url?: string;
  /** kind === 'file' のときの作業フォルダ。 */
  workspace?: string;
  /** kind === 'file' のときの、作業フォルダからの相対パス。 */
  relativePath?: string;
}

export type PreviewSourceSummary = RemotePreviewSourceSummary;

export const maxPreviewSources = 24;
export const maxPreviewUrls = 8;

/** 撮影用ウィンドウに読ませてよい方式。file:やdata:はここでは受け付けません。 */
const allowedProtocols = new Set(['http:', 'https:']);
/** ブラウザで直接開いて意味のあるものだけ。 */
const previewableFileExtensions = new Set(['.html', '.htm', '.svg']);

export function normalizePreviewUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (!allowedProtocols.has(url.protocol)) return '';
  return url.toString();
}

export function normalizePreviewUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const url = normalizePreviewUrl(entry);
    if (url) seen.add(url);
    if (seen.size >= maxPreviewUrls) break;
  }
  return [...seen];
}

export function isPreviewableFile(relativePath: string): boolean {
  const lowered = relativePath.toLowerCase();
  const dot = lowered.lastIndexOf('.');
  return dot >= 0 && previewableFileExtensions.has(lowered.slice(dot));
}

/** レンダラーから届いた一覧を、そのまま信じずに形を整えます。 */
export function normalizePreviewSources(value: unknown): PreviewSource[] {
  if (!Array.isArray(value)) return [];
  const sources: PreviewSource[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, maxPreviewSources)) {
    const source = entry as Partial<PreviewSource> | undefined;
    const id = typeof source?.id === 'string' ? source.id.trim().slice(0, 128) : '';
    const label = typeof source?.label === 'string' ? source.label.trim().slice(0, 120) : '';
    if (!id || !label || seen.has(id)) continue;

    if (source?.kind === 'url') {
      const url = normalizePreviewUrl(source.url);
      if (!url) continue;
      sources.push({ id, kind: 'url', label, url });
    } else if (source?.kind === 'file') {
      const workspace = typeof source.workspace === 'string' ? source.workspace : '';
      const relativePath = typeof source.relativePath === 'string' ? source.relativePath : '';
      if (!workspace || !relativePath || !isPreviewableFile(relativePath)) continue;
      sources.push({ id, kind: 'file', label, workspace, relativePath });
    } else {
      continue;
    }
    seen.add(id);
  }
  return sources;
}

export function summarizePreviewSources(sources: PreviewSource[]): PreviewSourceSummary[] {
  return sources.map(({ id, kind, label }) => ({ id, kind, label }));
}

export function previewViewport(value: unknown): RemotePreviewViewport {
  return value === 'mobile' ? 'mobile' : 'desktop';
}
