import crypto from 'node:crypto';
import MiniSearch from 'minisearch';
import type { PackageRecord, RepoArtifacts, SearchHit, ToolState } from './types.ts';

interface SearchDocument {
  id: string;
  summary: string;
  description: string;
  resourcesText: string;
  subpath: string;
  skillsText: string;
  readmeText: string;
  record: PackageRecord;
}

function repoKeyFor(record: PackageRecord): string {
  const normalized = [...record.remotes].map((entry) => entry.trim()).filter(Boolean).sort();
  return crypto.createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 24);
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/['"]/g, ' ')
    .replace(/[^a-z0-9/_-]+/g, ' ')
    .replace(/[\/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function artifactsForRecord(record: PackageRecord, state: ToolState): RepoArtifacts | undefined {
  return record.kept ? state.repos[repoKeyFor(record)]?.artifacts : state.temps[record.id]?.artifacts;
}

function buildDocument(record: PackageRecord, state: ToolState): SearchDocument {
  const artifacts = artifactsForRecord(record, state);
  const skillsText = Object.entries(artifacts?.skills ?? {})
    .map(([name, description]) => `${name} ${description}`)
    .join(' ');
  return {
    id: record.id,
    summary: record.summary ?? '',
    description: record.description ?? '',
    resourcesText: (record.resources ?? []).join(' '),
    subpath: record.subpath ?? '',
    skillsText,
    readmeText: artifacts?.readmeText ?? '',
    record,
  };
}

function rankSearchPackages(records: PackageRecord[], state: ToolState, query: string): SearchHit[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return [];
  }
  const documents = records.filter((record) => record.discoverable !== false).map((record) => buildDocument(record, state));
  const miniSearch = new MiniSearch<SearchDocument>({
    fields: ['id', 'summary', 'description', 'resourcesText', 'subpath', 'skillsText', 'readmeText'],
    storeFields: ['record'],
    searchOptions: {
      boost: {
        id: 8,
        summary: 5,
        description: 5,
        resourcesText: 3,
        subpath: 3,
        skillsText: 2,
        readmeText: 1,
      },
      prefix: true,
      fuzzy: 0.2,
    },
  });
  miniSearch.addAll(documents);
  return miniSearch
    .search(query)
    .map((result) => {
      const record = result.record as PackageRecord;
      const normalizedId = normalizeText(record.id);
      let score = result.score;
      if (normalizedId === normalizedQuery) {
        score += 1000;
      } else if (normalizedId.startsWith(normalizedQuery)) {
        score += 500;
      }
      return { record, score } satisfies SearchHit;
    })
    .sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id));
}

export function searchPackages(
  records: PackageRecord[],
  state: ToolState,
  limit = 20,
  offset = 0,
  query = '',
): SearchHit[] {
  return rankSearchPackages(records, state, query).slice(offset, offset + limit);
}

export function countSearchPackages(records: PackageRecord[], state: ToolState, query: string): number {
  return rankSearchPackages(records, state, query).length;
}
