import type { PackageRecord, SearchHit } from './types.ts';

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/['"]/g, ' ')
    .replace(/[^a-z0-9/_-]+/g, ' ')
    .replace(/[\/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  if (!normalized) {
    return [];
  }
  return normalized.split(' ').filter((token) => token.length > 0);
}

function scoreRecord(record: PackageRecord, queryTokens: string[]): number {
  const haystackSummary = tokenize(record.summary ?? '').join(' ');
  const haystackDescription = tokenize(record.description ?? '').join(' ');
  const haystackResources = tokenize((record.resources ?? []).join(' ')).join(' ');
  const idTokens = tokenize(record.id);
  let score = 0;

  if (record.id === queryTokens.join(' ')) {
    score += 1000;
  }
  if (record.id.startsWith(queryTokens.join(' '))) {
    score += 400;
  }

  for (const token of queryTokens) {
    if (idTokens.includes(token)) {
      score += 250;
    }
    if (record.id.includes(token)) {
      score += 150;
    }
    if (haystackSummary.includes(token)) {
      score += 60;
    }
    if (haystackDescription.includes(token)) {
      score += 30;
    }
    if (haystackResources.includes(token)) {
      score += 15;
    }
  }

  return score;
}

function rankSearchPackages(records: PackageRecord[], query: string): SearchHit[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  return records
    .filter((record) => record.discoverable !== false)
    .map((record) => ({ record, score: scoreRecord(record, queryTokens) }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.record.id.localeCompare(right.record.id);
    });
}

export function searchPackages(records: PackageRecord[], query: string, limit = 20, offset = 0): SearchHit[] {
  return rankSearchPackages(records, query).slice(offset, offset + limit);
}

export function countSearchPackages(records: PackageRecord[], query: string): number {
  return rankSearchPackages(records, query).length;
}
