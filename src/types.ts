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
  module: string;
}

export type HookName = 'preLoad' | 'preExpose' | 'postLoad' | 'preUpdate' | 'postUpdate';

export interface HookContext {
  packageId: string;
  repoPath: string;
  visiblePath: string;
  selectedRemote: string;
  subpath: string;
  resolvedCommit: string;
  defaultBranch: string;
  hookName: HookName;
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
  artifacts?: RepoArtifacts;
}

export interface TempState {
  path: string;
  repoKey: string;
  selectedRemote: string;
  defaultBranch: string;
  lastAccessedAt: string;
  materializedAt: string;
  artifacts?: RepoArtifacts;
}

export interface RepoArtifacts {
  readmeText?: string;
  readmeSource?: string;
  preview?: string[];
  skills?: Record<string, string>;
  collectedAt?: string;
  collectedCommit?: string;
}

export interface ToolState {
  repos: Record<string, RepoState>;
  temps: Record<string, TempState>;
}

export interface BootstrapPaths {
  home: string;
  indexPath: string;
  configPath: string;
}

export interface ToolPaths extends BootstrapPaths {
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
  artifacts?: RepoArtifacts;
}

export interface PackageSourceIdentity {
  remote: string;
  subpath?: string;
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

export interface ReconcileRuntimeOptions {
  pruneOrphanRepoDirectories?: boolean;
  pruneOrphanTempDirectories?: boolean;
  clearTrackedTemps?: boolean;
}

export interface ReconcileRuntimeReport {
  removedTempStateEntries: number;
  removedRepoStateEntries: number;
  deletedTempDirectories: number;
  deletedRepoDirectories: number;
  clearedTrackedTempStateEntries: number;
}

export interface RemoveRecordResult {
  removedId: string;
  deletedTempStateEntries: number;
  deletedRepoStateEntries: number;
  deletedTempDirectories: number;
  deletedRepoDirectories: number;
  reconciliation: ReconcileRuntimeReport;
}

export interface SyncRecordsResult {
  keptPackagesProcessed: number;
  reconciliation: ReconcileRuntimeReport;
}

export interface CleanupResult extends ReconcileRuntimeReport {}

export interface DoctorReport {
  clean: boolean;
  issues: string[];
  lockStatus: 'absent' | 'active' | 'stale';
}
