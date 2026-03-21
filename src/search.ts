import type { PackageRecord, SearchHit } from './types.ts';

const FIELD_WEIGHTS = {
  id: 5,
  summary: 3,
  description: 1.75,
  resources: 1,
} as const;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const PREFIX_MATCH_WEIGHT = 0.45;
const FUZZY_MATCH_WEIGHT = 0.2;
const MAX_PREFIX_EXPANSIONS = 8;
const MAX_FUZZY_EXPANSIONS = 4;
const SCORE_EPSILON = 1e-6;

type FieldName = keyof typeof FIELD_WEIGHTS;

interface IndexedField {
  length: number;
  termFrequencies: Map<string, number>;
}

interface IndexedRecord {
  record: PackageRecord;
  fields: Record<FieldName, IndexedField>;
  normalizedId: string;
}

interface ExpansionTerm {
  token: string;
  weight: number;
}

interface SearchIndex {
  documents: IndexedRecord[];
  averageLengths: Record<FieldName, number>;
  documentFrequencies: Record<FieldName, Map<string, number>>;
  vocabulary: Set<string>;
}

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

function createIndexedField(tokens: string[]): IndexedField {
  const termFrequencies = new Map<string, number>();
  for (const token of tokens) {
    termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
  }
  return { length: tokens.length, termFrequencies };
}

function buildSearchIndex(records: PackageRecord[]): SearchIndex {
  const documents = records
    .filter((record) => record.discoverable !== false)
    .map((record) => {
      const fields = {
        id: createIndexedField(tokenize(record.id)),
        summary: createIndexedField(tokenize(record.summary ?? '')),
        description: createIndexedField(tokenize(record.description ?? '')),
        resources: createIndexedField(tokenize((record.resources ?? []).join(' '))),
      };

      return {
        record,
        fields,
        normalizedId: normalizeText(record.id),
      } satisfies IndexedRecord;
    });

  const averageLengths = {
    id: 0,
    summary: 0,
    description: 0,
    resources: 0,
  } satisfies Record<FieldName, number>;
  const documentFrequencies = {
    id: new Map<string, number>(),
    summary: new Map<string, number>(),
    description: new Map<string, number>(),
    resources: new Map<string, number>(),
  } satisfies Record<FieldName, Map<string, number>>;
  const vocabulary = new Set<string>();

  for (const document of documents) {
    for (const fieldName of Object.keys(FIELD_WEIGHTS) as FieldName[]) {
      const field = document.fields[fieldName];
      averageLengths[fieldName] += field.length;
      for (const token of field.termFrequencies.keys()) {
        vocabulary.add(token);
        documentFrequencies[fieldName].set(token, (documentFrequencies[fieldName].get(token) ?? 0) + 1);
      }
    }
  }

  if (documents.length > 0) {
    for (const fieldName of Object.keys(FIELD_WEIGHTS) as FieldName[]) {
      averageLengths[fieldName] /= documents.length;
    }
  }

  return { documents, averageLengths, documentFrequencies, vocabulary };
}

function inverseDocumentFrequency(documentCount: number, documentFrequency: number): number {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function bm25TermScore(termFrequency: number, fieldLength: number, averageLength: number, idf: number): number {
  if (termFrequency <= 0 || idf <= 0) {
    return 0;
  }
  const normalizedLength = averageLength > 0 ? fieldLength / averageLength : 1;
  const denominator = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * normalizedLength);
  return idf * ((termFrequency * (BM25_K1 + 1)) / denominator);
}

function editDistanceWithin(left: string, right: string, maxDistance: number): boolean {
  if (Math.abs(left.length - right.length) > maxDistance) {
    return false;
  }
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    let rowMinimum = previous[0];
    for (let column = 1; column <= right.length; column += 1) {
      const cached = previous[column];
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + cost);
      diagonal = cached;
      rowMinimum = Math.min(rowMinimum, previous[column]);
    }
    if (rowMinimum > maxDistance) {
      return false;
    }
  }
  return previous[right.length] <= maxDistance;
}

function buildExpansions(token: string, vocabulary: Set<string>): ExpansionTerm[] {
  const expansions: ExpansionTerm[] = [{ token, weight: 1 }];
  const vocabularyTokens = [...vocabulary];

  const prefixMatches = vocabularyTokens
    .filter((candidate) => candidate !== token && candidate.startsWith(token))
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, MAX_PREFIX_EXPANSIONS);
  for (const candidate of prefixMatches) {
    const extraLength = Math.max(0, candidate.length - token.length);
    expansions.push({ token: candidate, weight: Math.max(0.2, PREFIX_MATCH_WEIGHT - extraLength * 0.03) });
  }

  if (prefixMatches.length > 0 || vocabulary.has(token)) {
    return expansions;
  }

  const maxDistance = token.length >= 6 ? 2 : 1;
  const fuzzyMatches = vocabularyTokens
    .filter((candidate) => candidate[0] === token[0] && editDistanceWithin(candidate, token, maxDistance))
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, MAX_FUZZY_EXPANSIONS);
  for (const candidate of fuzzyMatches) {
    expansions.push({ token: candidate, weight: FUZZY_MATCH_WEIGHT });
  }

  return expansions;
}

function scoreDocument(document: IndexedRecord, index: SearchIndex, query: string, queryTokens: string[]): number {
  let score = 0;

  for (const queryToken of queryTokens) {
    const expansions = buildExpansions(queryToken, index.vocabulary);
    for (const fieldName of Object.keys(FIELD_WEIGHTS) as FieldName[]) {
      const field = document.fields[fieldName];
      for (const expansion of expansions) {
        const termFrequency = field.termFrequencies.get(expansion.token) ?? 0;
        if (termFrequency === 0) {
          continue;
        }
        const documentFrequency = index.documentFrequencies[fieldName].get(expansion.token) ?? 0;
        const idf = inverseDocumentFrequency(index.documents.length, documentFrequency);
        score += FIELD_WEIGHTS[fieldName] * expansion.weight * bm25TermScore(termFrequency, field.length, index.averageLengths[fieldName], idf);
      }
    }
  }

  const normalizedQuery = normalizeText(query);
  if (document.normalizedId === normalizedQuery) {
    score += 40;
  } else if (normalizedQuery.length > 0 && document.normalizedId.startsWith(normalizedQuery)) {
    score += 20;
  }

  const idTokens = document.fields.id.termFrequencies;
  const exactIdTokenMatches = queryTokens.filter((token) => idTokens.has(token)).length;
  if (exactIdTokenMatches === queryTokens.length && queryTokens.length > 0) {
    score += 8;
  } else if (exactIdTokenMatches > 0) {
    score += exactIdTokenMatches * 2;
  }

  return score;
}

function rankSearchPackages(records: PackageRecord[], query: string): SearchHit[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const index = buildSearchIndex(records);
  return index.documents
    .map((document) => ({ record: document.record, score: scoreDocument(document, index, query, queryTokens) }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => {
      if (Math.abs(right.score - left.score) > SCORE_EPSILON) {
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
