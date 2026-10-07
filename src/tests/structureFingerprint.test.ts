import { describe, expect, it } from 'vitest';
import { shortStructureId, structureSignature } from '../domain/structureFingerprint';
import type { RuleProject } from '../models/ruleModel';

const base: RuleProject = {
  id: 'p', title: '项目 A', fields: [{ id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 }],
  rules: [{ id: 'r1', name: '规则', priority: 10, result: '通过', conditions: { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 100 }] } }],
  sampleInputs: { amount: 200 }, versions: [], updatedAt: 1,
};

describe('structureSignature', () => {
  it('stays identical when only non-structural content changes', () => {
    const renamed: RuleProject = { ...base, title: '项目 B', updatedAt: 999, sampleInputs: { amount: 5 }, versions: [{ id: 'v', name: '快照', savedAt: 2, frozen: false, fields: [], rules: [], sampleInputs: {} }] };
    expect(structureSignature(renamed)).toBe(structureSignature(base));
  });

  it('changes when fields or rule structure change', () => {
    const conditionChanged: RuleProject = { ...base, rules: [{ ...base.rules[0], conditions: { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 250 }] } }] };
    const fieldChanged: RuleProject = { ...base, fields: [{ ...base.fields[0], max: 2000 }] };
    expect(structureSignature(conditionChanged)).not.toBe(structureSignature(base));
    expect(structureSignature(fieldChanged)).not.toBe(structureSignature(base));
  });

  it('is independent of object key order and exposes a short id', () => {
    const reordered = {
      ...base,
      rules: [{
        result: '通过', priority: 10, id: 'r1', name: '规则',
        conditions: { conditions: [{ value: 100, fieldId: 'amount', operator: 'gte', kind: 'predicate' }], operator: 'and', kind: 'group' },
      }],
    } as RuleProject;
    expect(structureSignature(reordered)).toBe(structureSignature(base));
    expect(shortStructureId(structureSignature(base))).toMatch(/^[0-9A-F]{7}$/);
  });
});
