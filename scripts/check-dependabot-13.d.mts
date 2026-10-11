export interface BraceAdvisoryRow {
  path: string;
  version: unknown;
  development: boolean;
  affected: boolean | "unknown";
}
export function affectedBraceVersion(version: unknown): boolean | undefined;
export function inspectBraceLock(lock: unknown): BraceAdvisoryRow[];
export function inspectBraceInstall(root: string, rows: BraceAdvisoryRow[]): Array<{ path: string; version: unknown; affected: boolean | "unknown"; matchesLock: boolean }>;
