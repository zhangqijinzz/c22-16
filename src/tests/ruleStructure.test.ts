import { describe, expect, it } from 'vitest';
import type { RuleProject } from '../models/ruleModel';
import { buildRuleStructureKey, getStructureVersion, nextStructureVersion } from '../domain/ruleStructure';

const project: RuleProject = {
  id: 'project-1',
  title: '测试项目',
  fields: [
    { id: 'amount', name: '金额', type: 'number', min: 0, max: 100 },
  ],
  rules: [
    {
      id: 'rule-1',
      name: '基础规则',
      priority: 10,
      result: '通过',
      conditions: { kind: 'group', operator: 'and', conditions: [
        { kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 10 },
      ] },
    },
  ],
  sampleInputs: { amount: 20 },
  versions: [],
  structureVersion: 3,
  updatedAt: 1,
};

describe('rule structure identity', () => {
  it('defaults missing structure versions and ignores non-structural metadata', () => {
    const withoutVersion: RuleProject = { ...project, structureVersion: undefined };
    expect(getStructureVersion(withoutVersion)).toBe(1);
    const renamed: RuleProject = { ...withoutVersion, title: '另一个标题' };
    expect(buildRuleStructureKey(project)).toBe(buildRuleStructureKey(renamed));
  });

  it('only advances the human version when fields or rules change', () => {
    expect(nextStructureVersion(project, { ...project, title: '改名' })).toBe(3);
    expect(nextStructureVersion(project, {
      ...project,
      rules: project.rules.map((rule) => rule.id === 'rule-1' ? { ...rule, result: '拒绝' } : rule),
    })).toBe(4);
  });
});
