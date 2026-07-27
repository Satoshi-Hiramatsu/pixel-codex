import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CodexExecutable {
  executable: string;
  version: string;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

interface ParsedVersion {
  core: number[];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion {
  const [core, prerelease = ''] = version.split('-', 2);
  return {
    core: core.split('.').map((part) => Number(part) || 0),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  const length = Math.max(leftVersion.core.length, rightVersion.core.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);
    if (difference) return difference;
  }
  if (!leftVersion.prerelease.length && rightVersion.prerelease.length) return 1;
  if (leftVersion.prerelease.length && !rightVersion.prerelease.length) return -1;
  const prereleaseLength = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
    } else if (leftNumber !== undefined) {
      return -1;
    } else if (rightNumber !== undefined) {
      return 1;
    } else {
      const difference = leftPart.localeCompare(rightPart);
      if (difference) return difference;
    }
  }
  return 0;
}

async function probe(candidate: string): Promise<CodexExecutable | undefined> {
  if (!(await exists(candidate))) return undefined;
  try {
    const { stdout } = await execFileAsync(candidate, ['--version'], {
      timeout: 5_000,
      windowsHide: true,
    });
    const version = stdout.match(/codex-cli\s+([^\s]+)/i)?.[1];
    return version ? { executable: candidate, version } : undefined;
  } catch {
    return undefined;
  }
}

async function desktopRuntimeCandidates(): Promise<string[]> {
  if (!process.env.LOCALAPPDATA) return [];
  const runtimeRoot = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  const candidates: string[] = [];
  try {
    const entries = await readdir(runtimeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidates.push(path.join(runtimeRoot, entry.name, 'codex.exe'));
      }
    }
  } catch {
    // Continue with the stable per-user path and PATH discovery.
  }
  candidates.push(path.join(runtimeRoot, 'codex.exe'));
  return candidates;
}

export async function findCodexExecutable(preferred?: string): Promise<CodexExecutable> {
  if (preferred) {
    const selected = await probe(preferred);
    if (!selected) throw new Error('指定されたCodex実行ファイルを起動できません。');
    return selected;
  }

  const candidates = await desktopRuntimeCandidates();
  try {
    const { stdout } = await execFileAsync('where.exe', ['codex']);
    candidates.push(
      ...stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    // Continue with known npm installation locations.
  }

  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'codex.cmd'));
    candidates.push(path.join(process.env.APPDATA, 'npm', 'codex.exe'));
  }

  const available = (
    await Promise.all([...new Set(candidates)].map((candidate) => probe(candidate)))
  ).filter((candidate): candidate is CodexExecutable => Boolean(candidate));
  available.sort((left, right) => compareVersions(right.version, left.version));
  if (available[0]) return available[0];

  throw new Error(
    'Codex CLIが見つかりません。設定からcodex.exeを選択してください。',
  );
}
