import fs from 'node:fs/promises';
import path from 'node:path';

import type { Attachment } from '../types';

/** 画像だけはモデルに直接見せられるので、拡張子で見分けます。 */
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 1件あたりの上限。これを超えるものはパスだけ伝えるほうが現実的です。 */
const maxAttachmentBytes = 20 * 1024 * 1024;
/** 画面に出すプレビューだけの上限。大きな画像はサムネイル無しで並べます。 */
const maxPreviewBytes = 4 * 1024 * 1024;
export const maxAttachmentCount = 8;

function nextId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** ファイル名から、フォルダ移動に使える文字をすべて落とします。 */
function safeName(value: string): string {
  const base = path
    .basename(String(value ?? ''))
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_');
  return base.trim().slice(0, 120) || 'attachment';
}

export async function describeAttachment(filePath: string): Promise<Attachment> {
  if (!path.isAbsolute(filePath)) throw new Error('添付ファイルの場所が分かりませんでした。');
  const target = await fs.realpath(filePath);
  const stats = await fs.stat(target);
  if (stats.isDirectory()) throw new Error('フォルダは添付できません。ファイルを選んでください。');
  if (stats.size > maxAttachmentBytes) {
    throw new Error(
      `${path.basename(target)} は大きすぎます（${Math.round(maxAttachmentBytes / 1024 / 1024)}MBまで）。`,
    );
  }

  const mimeType = imageTypes[path.extname(target).toLowerCase()];
  let previewUrl: string | undefined;
  if (mimeType && stats.size <= maxPreviewBytes) {
    const data = await fs.readFile(target).catch(() => undefined);
    if (data) previewUrl = `data:${mimeType};base64,${data.toString('base64')}`;
  }

  return {
    id: nextId(),
    name: path.basename(target),
    path: target,
    size: stats.size,
    kind: mimeType ? 'image' : 'file',
    previewUrl,
  };
}

/**
 * クリップボードから貼り付けた画像のように、まだディスクに無いものを
 * 一時フォルダへ書き出します。Codexにはそのパスを伝えます。
 */
export async function saveAttachment(
  tempRoot: string,
  name: string,
  dataBase64: string,
): Promise<Attachment> {
  const data = Buffer.from(String(dataBase64 ?? ''), 'base64');
  if (!data.length) throw new Error('貼り付けられた内容を読み取れませんでした。');
  if (data.length > maxAttachmentBytes) {
    throw new Error(`貼り付けた画像が大きすぎます（${Math.round(maxAttachmentBytes / 1024 / 1024)}MBまで）。`);
  }

  await fs.mkdir(tempRoot, { recursive: true });
  const cleanName = safeName(name);
  const target = path.join(tempRoot, `${Date.now().toString(36)}-${cleanName}`);
  await fs.writeFile(target, data);

  const described = await describeAttachment(target);
  return { ...described, name: cleanName, temporary: true };
}

/** 送信時にCodexへ渡す形。パスと種類だけあれば足ります。 */
export function normalizeAttachments(value: unknown): Array<{ path: string; kind: 'image' | 'file' }> {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const filePath = (entry as Attachment)?.path;
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return [];
      const kind = (entry as Attachment)?.kind === 'image' ? 'image' : 'file';
      return [{ path: filePath, kind: kind as 'image' | 'file' }];
    })
    .slice(0, maxAttachmentCount);
}
