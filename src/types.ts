export interface PackageRecord {
  id: string;
  remotes: string[];
  subpath?: string;
  summary?: string;
  description?: string;
  resources?: string[];
  pinned?: boolean;
  kept?: boolean;
  discoverable?: boolean;
  frozen?: boolean;
  commit?: string;
}

export interface StorageConfig {
  root: string;
  temp_root: string;
  max_temp_size_mb: number;
}

export interface NetworkConfig {
  git_timeout_sec: number;
  allow_lfs: boolean;
}

export interface HooksConfig {
  pre_load: string;
  pre_expose: string;
  post_load: string;
  pre_update: string;
  post_update: string;
}

export interface RuntimeConfig {
  storage: StorageConfig;
  network: NetworkConfig;
  hooks: HooksConfig;
}

export interface RepoState {
  path: string;
  selectedRemote: string;
  defaultBranch: string;
  lastCommit: string;
  updatedAt: string;
}

export interface TempState {
  path: string;
  repoKey: string;
  selectedRemote: string;
  defaultBranch: string;
  lastAccessedAt: string;
  materializedAt: string;
}

export interface ToolState {
  repos: Record<string, RepoState>;
  temps: Record<string, TempState>;
}

export interface ToolPaths {
  home: string;
  indexPath: string;
  configPath: string;
  logPath: string;
  statePath: string;
  storageRoot: string;
  reposRoot: string;
  tempRoot: string;
}

export interface SearchHit {
  record: PackageRecord;
  score: number;
}

export interface AddInspection {
  source: string;
  remote: string;
  subpath?: string;
  preview: string[];
  readmeExcerpt?: string;
}

export interface AddDraft {
  summary: string;
  description: string;
  resources: string[];
  pinned: boolean;
  kept: boolean;
  discoverable: boolean;
}

export interface CommandContext {
  paths: ToolPaths;
  config: RuntimeConfig;
}
