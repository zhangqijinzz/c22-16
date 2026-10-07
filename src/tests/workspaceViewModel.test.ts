import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import { buildRuleStructureKey, getStructureVersion } from '../domain/ruleStructure';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation, CheckResult } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel, isAnalysisCurrent } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    return {
      promise: Promise.resolve({
        analysis: analyzeRules(project),
        structureKey: buildRuleStructureKey(project),
        structureVersion: getStructureVersion(project),
      }),
      cancel: () => { this.cancelled = true; },
    };
  }
}

class DeferredChecker {
  readonly operations: { project: RuleProject; key: string; version: number; resolve: (result: CheckResult) => void; reject: (error: Error) => void; cancelled: boolean }[] = [];

  run(project: RuleProject): CheckOperation {
    const operation = {
      project,
      key: buildRuleStructureKey(project),
      version: getStructureVersion(project),
      resolve: undefined as unknown as (result: CheckResult) => void,
      reject: undefined as unknown as (error: Error) => void,
      cancelled: false,
    };
    this.operations.push(operation);
    return {
      promise: new Promise<CheckResult>((resolve, reject) => {
        operation.resolve = resolve;
        operation.reject = reject;
      }),
      cancel: () => { operation.cancelled = true; },
    };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('keeps successful analysis bound to its structure version and marks later structural edits stale', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    await workspace.runCheck();

    const firstState = workspace.getSnapshot();
    expect(firstState.structureVersion).toBe(1);
    expect(firstState.analysisMeta?.structureVersion).toBe(1);
    expect(isAnalysisCurrent(firstState)).toBe(true);

    const sameStructure = firstState.project as RuleProject;
    workspace.commitProject({ ...sameStructure, title: '只改名称' }, '非结构编辑', { recheck: false });
    expect(workspace.getSnapshot().structureVersion).toBe(1);
    expect(isAnalysisCurrent(workspace.getSnapshot())).toBe(true);

    const changedStructure = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({
      ...changedStructure,
      rules: changedStructure.rules.map((rule, index) => index === 0 ? { ...rule, result: `${rule.result}（新）` } : rule),
    }, '调整规则结果');
    expect(workspace.getSnapshot().structureVersion).toBe(2);
    expect(workspace.getSnapshot().analysisMeta?.structureVersion).toBe(1);
    expect(workspace.getSnapshot().checkStatus).toBe('scheduled');
    expect(isAnalysisCurrent(workspace.getSnapshot())).toBe(false);

    await vi.advanceTimersByTimeAsync(220);
    const refreshed = workspace.getSnapshot();
    expect(refreshed.checkStatus).toBe('success');
    expect(refreshed.analysisMeta?.structureVersion).toBe(2);
    expect(isAnalysisCurrent(refreshed)).toBe(true);
    workspace.dispose();
  });

  it('rejects a worker result whose structure key does not match the requested structure', async () => {
    const checker = new DeferredChecker();
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), checker);
    await workspace.start();
    const staleCheck = workspace.runCheck();
    const stale = checker.operations[0];
    stale.resolve({ analysis: analyzeRules(stale.project), structureKey: 'stale-structure-key', structureVersion: stale.version });
    await staleCheck;
    await Promise.resolve();

    expect(workspace.getSnapshot().analysis).toBeNull();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toContain('已作废');

    const retry = workspace.runCheck();
    const latest = checker.operations[1];
    latest.resolve({ analysis: analyzeRules(latest.project), structureKey: latest.key, structureVersion: latest.version });
    await retry;

    expect(workspace.getSnapshot().analysisMeta?.structureKey).toBe(latest.key);
    expect(isAnalysisCurrent(workspace.getSnapshot())).toBe(true);
    workspace.dispose();
  });

  it('uses only the last scheduled structure after repeated edits and cancellations', async () => {
    const checker = new DeferredChecker();
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), checker);
    await workspace.start();
    void workspace.runCheck();
    const firstOperation = checker.operations[0];

    const changeRuleResult = (suffix: string) => {
      const project = workspace.getSnapshot().project as RuleProject;
      workspace.commitProject({
        ...project,
        rules: project.rules.map((rule, index) => index === 0 ? { ...rule, result: `${rule.result}${suffix}` } : rule),
      }, '连续编辑规则');
    };

    changeRuleResult(' · 第二版');
    expect(workspace.getSnapshot().structureVersion).toBe(2);
    expect(firstOperation.cancelled).toBe(true);
    await Promise.resolve();
    changeRuleResult(' · 第三版');
    expect(workspace.getSnapshot().structureVersion).toBe(3);
    expect(checker.operations).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(220);
    expect(checker.operations).toHaveLength(2);
    const lastOperation = checker.operations[1];
    expect(lastOperation.cancelled).toBe(false);
    lastOperation.resolve({ analysis: analyzeRules(lastOperation.project), structureKey: lastOperation.key, structureVersion: lastOperation.version });
    await Promise.resolve();

    const finalState = workspace.getSnapshot();
    expect(finalState.checkStatus).toBe('success');
    expect(finalState.structureVersion).toBe(3);
    expect(finalState.analysisMeta?.structureVersion).toBe(3);
    expect(isAnalysisCurrent(finalState)).toBe(true);
    workspace.dispose();
  });
  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);
    expect(savedVersion?.structureVersion).toBe(1);
    expect(workspace.getSnapshot().structureVersion).toBe(1);

    workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.copyVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });
});
