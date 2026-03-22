import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './fs.ts';
import type { PackageRecord, RepoArtifacts } from './types.ts';

const DEFAULT_PREVIEW_DEPTH = 2;
const DEFAULT_PREVIEW_LIMIT = 12;
const README_CAP = 16_384;

function trimScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

async function listDirectoryPreview(targetPath: string, depth: number, limit: number): Promise<string[]> {
  const entries: string[] = [];

  async function walk(currentPath: string, currentDepth: number, prefix: string): Promise<void> {
    if (entries.length >= limit || currentDepth < 0) {
      return;
    }
    const items = await fs.readdir(currentPath, { withFileTypes: true });
    for (const item of items) {
      if (entries.length >= limit) {
        break;
      }
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      entries.push(item.isDirectory() ? `${relative}/` : relative);
      if (item.isDirectory() && currentDepth > 0) {
        await walk(path.join(currentPath, item.name), currentDepth - 1, relative);
      }
    }
  }

  await walk(targetPath, depth, '');
  return entries;
}

function readmeCandidates(repoPath: string, subpath?: string): string[] {
  const candidates = [path.join(repoPath, 'README.md'), path.join(repoPath, 'README'), path.join(repoPath, 'readme.md')];
  if (!subpath) {
    return candidates;
  }
  return [
    path.join(repoPath, subpath, 'README.md'),
    path.join(repoPath, subpath, 'README'),
    path.join(repoPath, subpath, 'readme.md'),
    ...candidates,
  ];
}

async function readReadmeArtifact(repoPath: string, subpath?: string): Promise<Pick<RepoArtifacts, 'readmeText' | 'readmeSource'>> {
  for (const candidate of readmeCandidates(repoPath, subpath)) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const readmeText = (await fs.readFile(candidate, 'utf8')).slice(0, README_CAP);
    return { readmeText, readmeSource: path.relative(repoPath, candidate).replace(/\\/g, '/') };
  }
  return {};
}

function parseSkillFrontmatter(text: string): { name: string; description: string } | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }
  let name = '';
  let description = '';
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const nameMatch = line.match(/^name:\s*(.+)$/);
    const descriptionMatch = line.match(/^description:\s*(.+)$/);
    if (nameMatch) {
      name = trimScalar(nameMatch[1]);
    }
    if (descriptionMatch) {
      description = trimScalar(descriptionMatch[1]);
    }
  }
  return name && description ? { name, description } : null;
}

async function collectSkillFiles(basePath: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [basePath];
  while (stack.length > 0) {
    const currentPath = stack.pop() as string;
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        files.push(entryPath);
      }
    }
  }
  return files;
}

async function readSkills(basePath: string): Promise<Record<string, string>> {
  if (!(await pathExists(basePath))) {
    return {};
  }
  const skills: Record<string, string> = {};
  for (const filePath of await collectSkillFiles(basePath)) {
    const parsed = parseSkillFrontmatter(await fs.readFile(filePath, 'utf8'));
    if (parsed) {
      skills[parsed.name] = parsed.description;
    }
  }
  return skills;
}

export async function previewVisiblePath(repoPath: string, subpath?: string): Promise<string[]> {
  const basePath = subpath ? path.join(repoPath, subpath) : repoPath;
  if (!(await pathExists(basePath))) {
    return [];
  }
  return listDirectoryPreview(basePath, DEFAULT_PREVIEW_DEPTH, DEFAULT_PREVIEW_LIMIT);
}

export async function collectRepoArtifacts(repoPath: string, record: PackageRecord, commit: string): Promise<RepoArtifacts> {
  const visiblePath = record.subpath ? path.join(repoPath, record.subpath) : repoPath;
  const [preview, readme, skills] = await Promise.all([
    previewVisiblePath(repoPath, record.subpath),
    readReadmeArtifact(repoPath, record.subpath),
    readSkills(visiblePath),
  ]);
  return {
    ...readme,
    preview,
    skills,
    collectedCommit: commit,
  };
}
