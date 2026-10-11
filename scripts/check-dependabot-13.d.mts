export interface BraceAdvisoryRow {
  path: string;
  version: unknown;
  development: boolean;
  affected: boolean | "unknown";
}
export function affectedBraceVersion(version: unknown): boolean | undefined;
export function inspectBraceLock(lock: unknown): BraceAdvisoryRow[];
