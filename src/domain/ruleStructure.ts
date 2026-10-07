import type { RuleProject } from '../models/ruleModel';

const FNV_OFFSET_BIG = 0xcbf29ce484222325n;
const FNV_PRIME_BIG = 0x00000100000001b3n;
const MASK_64_BIG = 0xffffffffffffffffn;
const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

export function getStructureVersion(project: RuleProject): number {
  return project.structureVersion && project.structureVersion > 0 ? project.structureVersion : 1;
}

export function buildRuleStructureKey(project: Pick<RuleProject, 'id' | 'fields' | 'rules'>): string {
  const canonical = stableStringify({
    id: project.id,
    fields: project.fields,
    rules: project.rules,
  });
  return `${hash64(canonical)}-${hash32(canonical).toString(16).padStart(8, '0')}`;
}

export function nextStructureVersion(current: RuleProject, updated: RuleProject): number {
  const currentVersion = getStructureVersion(current);
  if (current.id !== updated.id) return getStructureVersion(updated);
  if (buildRuleStructureKey(current) === buildRuleStructureKey(updated)) return currentVersion;
  return currentVersion + 1;
}

export function withStructureVersion(project: RuleProject, version: number): RuleProject {
  return { ...project, structureVersion: version };
}

function hash64(value: string): string {
  let hash = FNV_OFFSET_BIG;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, (hash * FNV_PRIME_BIG) & MASK_64_BIG);
  }
  return hash.toString(16).padStart(16, '0');
}

function hash32(value: string): number {
  let hash = FNV_OFFSET_32;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }
  return hash;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
