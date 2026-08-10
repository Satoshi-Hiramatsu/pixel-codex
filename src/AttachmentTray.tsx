import React, { useCallback, useMemo, useState } from 'react';

import type { Attachment } from './types';

/** 一度に添えられる数。多すぎると指示そのものが伝わりにくくなります。 */
const attachmentLimit = 8;

function formatSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'ファイルを添付できませんでした。';
}

/** クリップボードの画像には名前が無いので、日時から分かりやすい名前を付けます。 */
function screenshotName(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const stamp = new Date()
    .toLocaleString('ja-JP', { hour12: false })
    .replace(/[/\s:]/g, '-');
  const extension = file.type.split('/')[1] || 'png';
  return `スクリーンショット-${stamp}.${extension}`;
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // 一気に文字列化すると引数が多すぎて失敗するので、少しずつ積み上げます。
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export interface AttachmentBox {
  attachments: Attachment[];
  dragging: boolean;
  busy: boolean;
  error: string;
  clear: () => void;
  remove: (id: string) => void;
  /** 場所で外します。外から添えたものを、同じ場所を頼りに引き上げるためです。 */
  removeByPath: (filePath: string) => void;
  chooseFiles: () => Promise<void>;
  /** すでにディスクにあるものを場所で添えます。 */
  adoptPaths: (paths: string[]) => Promise<void>;
  /** スクリーンショットの貼り付け。文字だけの貼り付けはそのまま通します。 */
  handlePaste: (event: React.ClipboardEvent) => void;
  dropHandlers: {
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
  };
}

/**
 * 指示欄に添えるファイルの受け口。選択・ドラッグ＆ドロップ・貼り付けの
 * どれでも同じ形（ディスク上の絶対パス）に揃えます。
 */
export function useAttachments(): AttachmentBox {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const append = useCallback((added: Attachment[]) => {
    if (!added.length) return;
    setAttachments((current) => {
      const known = new Set(current.map((entry) => entry.path));
      const next = [...current];
      for (const attachment of added) {
        if (known.has(attachment.path)) continue;
        known.add(attachment.path);
        next.push(attachment);
      }
      if (next.length > attachmentLimit) {
        setError(`添付は${attachmentLimit}件までです。`);
        return next.slice(0, attachmentLimit);
      }
      return next;
    });
  }, []);

  /** File を、パスが分かればそのまま、分からなければ一時保存して添付にします。 */
  const adoptFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy(true);
      setError('');
      try {
        const collected: Attachment[] = [];
        const failures: string[] = [];
        for (const file of files.slice(0, attachmentLimit)) {
          const filePath = window.pixelCodex.getPathForFile(file);
          try {
            if (filePath) {
              const [described] = await window.pixelCodex.describeAttachments([filePath]);
              if (described) collected.push(described);
            } else {
              collected.push(
                await window.pixelCodex.saveAttachment(screenshotName(file), await toBase64(file)),
              );
            }
          } catch (failure) {
            failures.push(errorMessage(failure));
          }
        }
        append(collected);
        if (failures.length) setError(failures[0]);
      } finally {
        setBusy(false);
      }
    },
    [append],
  );

  const chooseFiles = useCallback(async () => {
    setError('');
    try {
      append(await window.pixelCodex.chooseAttachments());
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [append]);

  /**
   * すでにディスクにあるものを、場所を指定して添えます。赤ペン先生から届いた
   * 赤入れのように、利用者の操作を経ずに現れる添付のための入り口です。
   */
  const adoptPaths = useCallback(
    async (paths: string[]) => {
      const targets = paths.filter(Boolean);
      if (!targets.length) return;
      setError('');
      try {
        append(await window.pixelCodex.describeAttachments(targets));
      } catch (failure) {
        setError(errorMessage(failure));
      }
    },
    [append],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files = [...event.clipboardData.files];
      if (!files.length) return;
      // 画像を貼ったときに、その中身が文字として入力欄へ入るのを防ぎます。
      event.preventDefault();
      void adoptFiles(files);
    },
    [adoptFiles],
  );

  const dropHandlers = useMemo(
    () => ({
      onDragOver: (event: React.DragEvent) => {
        if (![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      },
      onDragLeave: (event: React.DragEvent) => {
        // 中の要素へ移っただけのときは、枠線を消さずに出したままにします。
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setDragging(false);
      },
      onDrop: (event: React.DragEvent) => {
        const files = [...event.dataTransfer.files];
        setDragging(false);
        if (!files.length) return;
        event.preventDefault();
        void adoptFiles(files);
      },
    }),
    [adoptFiles],
  );

  return {
    attachments,
    dragging,
    busy,
    error,
    clear: () => {
      setAttachments([]);
      setError('');
    },
    remove: (id) => setAttachments((current) => current.filter((entry) => entry.id !== id)),
    removeByPath: (filePath) =>
      setAttachments((current) => current.filter((entry) => entry.path !== filePath)),
    chooseFiles,
    adoptPaths,
    handlePaste,
    dropHandlers,
  };
}

export function AttachmentTray({
  box,
  disabled,
  hint,
}: {
  box: AttachmentBox;
  disabled?: boolean;
  hint: string;
}): React.JSX.Element {
  return (
    <div className={`attachment-tray ${box.attachments.length ? 'filled' : ''}`}>
      <button
        className="attachment-add"
        type="button"
        disabled={disabled || box.busy}
        onClick={() => void box.chooseFiles()}
      >
        {box.busy ? '読み込み中…' : '＋ 添付'}
      </button>
      <div className="attachment-chips">
        {box.attachments.map((attachment) => (
          <span className="attachment-chip" key={attachment.id} title={attachment.path}>
            {attachment.previewUrl ? (
              <img src={attachment.previewUrl} alt="" />
            ) : (
              <i aria-hidden="true">▤</i>
            )}
            <span className="attachment-name">{attachment.name}</span>
            <b>{formatSize(attachment.size)}</b>
            <button
              type="button"
              aria-label={`${attachment.name} を外す`}
              onClick={() => box.remove(attachment.id)}
            >×</button>
          </span>
        ))}
        {box.attachments.length === 0 && <small className="attachment-hint">{hint}</small>}
      </div>
      {box.error && <p className="attachment-error">{box.error}</p>}
    </div>
  );
}

/** 添付を伝えるための一文。Codexは絶対パスからファイルを開けます。 */
export function attachmentNote(attachments: Attachment[]): string {
  if (!attachments.length) return '';
  const lines = attachments.map(
    (attachment) => `- ${attachment.name}（${attachment.kind === 'image' ? '画像' : 'ファイル'}）: ${attachment.path}`,
  );
  return [
    '',
    '[添付ファイル]',
    ...lines,
    '上のファイルは必要に応じて開いて確認してください。',
  ].join('\n');
}

/** 会話ログに残す短い添え書き。 */
export function attachmentSummary(attachments: Attachment[]): string {
  if (!attachments.length) return '';
  return `\n［添付］${attachments.map((attachment) => attachment.name).join('、')}`;
}
