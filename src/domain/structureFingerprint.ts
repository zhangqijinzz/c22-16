import type { RuleProject } from '../models/ruleModel';

/**
 * 规则结构指纹：仅由参与一致性检查的结构（字段定义 + 规则）决定。
 * 项目标题、样例输入、版本记录等非结构内容不会影响指纹。
 * 同一份结构必然得到同一个指纹；结构一旦改动，指纹立即变化。
 */
export function structureSignature(project: Pick<RuleProject, 'fields' | 'rules'>): string {
  return cyrb53(canonicalJson({ fields: project.fields, rules: project.rules }), 0x5f3a9c21).toString(16).padStart(14, '0');
}

/** 界面上展示的结构版本短号。 */
export function shortStructureId(signature: string): string {
  return signature.slice(0, 7).toUpperCase();
}

/** 按键名排序的确定性 JSON，避免字段顺序导致的指纹漂移。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function cyrb53(input: string, seed: number): number {
  let hash1 = 0xdeadbeef ^ seed;
  let hash2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < input.length; index += 1) {
    const char = input.charCodeAt(index);
    hash1 = Math.imul(hash1 ^ char, 2654435761);
    hash2 = Math.imul(hash2 ^ char, 1597334677);
  }
  hash1 = Math.imul(hash1 ^ (hash1 >>> 16), 2246822507) ^ Math.imul(hash2 ^ (hash2 >>> 13), 3266489909);
  hash2 = Math.imul(hash2 ^ (hash2 >>> 16), 2246822507) ^ Math.imul(hash1 ^ (hash1 >>> 13), 3266489909);
  return 0x100000000 * (0x1fffff & hash2) + (hash1 >>> 0);
}
