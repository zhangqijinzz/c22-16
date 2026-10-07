import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import { structureSignature } from '../domain/structureFingerprint';
import type { RuleAnalysis, RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel, isAnalysisFresh } from '../viewmodels/workspaceViewModel';

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
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; } };
  }
}

class DeferredChecker {
  readonly operations: { project: RuleProject; resolve: (analysis: RuleAnalysis) => void; reject: (error: Error) => void; cancelled: boolean }[] = [];

  run(project: RuleProject): CheckOperation {
    const entry: { project: RuleProject; resolve: (analysis: RuleAnalysis) => void; reject: (error: Error) => void; cancelled: boolean } = {
      project,
      resolve: () => undefined,
      reject: () => undefined,
      cancelled: false,
    };
    const promise = new Promise<RuleAnalysis>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.operations.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; entry.reject(new DOMException('cancelled', 'AbortError')); } };
  }

  resolveLatest(): void {
    const entry = this.operations.at(-1);
    if (entry) entry.resolve(analyzeRules(entry.project));
  }

  resolveAt(index: number): void {
    const entry = this.operations[index];
    if (entry) entry.resolve(analyzeRules(entry.project));
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

  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);

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

  it('binds each check to the structure and keeps the final result aligned with the last edit', async () => {
    const checker = new DeferredChecker();
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), checker);
    await workspace.start();
    await vi.advanceTimersByTimeAsync(60);
    checker.resolveLatest();
    await Promise.resolve();
    await Promise.resolve();
    expect(isAnalysisFresh(workspace.getSnapshot())).toBe(true);
    const firstStructureId = workspace.getSnapshot().structureId;

    // 第一次结构编辑：旧结论保留但标记过期，并自动重算。
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, rules: project.rules.slice(0, 2) }, '删除规则');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    expect(isAnalysisFresh(workspace.getSnapshot())).toBe(false);
    expect(workspace.getSnapshot().structureId).not.toBe(firstStructureId);
    await vi.advanceTimersByTimeAsync(220);
    expect(checker.operations).toHaveLength(2);

    // 重算返回前再次编辑：针对中间结构的检查作废，结论仍对应第一版结构。
    const midStructureId = workspace.getSnapshot().structureId;
    const edited = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...edited, rules: edited.rules.slice(0, 1) }, '再删一条');
    const lastStructureId = workspace.getSnapshot().structureId;
    expect(lastStructureId).not.toBe(midStructureId);
    await vi.advanceTimersByTimeAsync(220);
    expect(checker.operations).toHaveLength(3);

    // 中间结构的结论迟到落地：必须被作废，且不能盖住界面。
    checker.resolveAt(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(workspace.getSnapshot().analysisStructureId).toBe(firstStructureId);
    expect(isAnalysisFresh(workspace.getSnapshot())).toBe(false);

    // 最后一版结构的检查落地：最终展示必须对应最后一次改动。
    checker.resolveAt(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(workspace.getSnapshot().analysisStructureId).toBe(lastStructureId);
    expect(isAnalysisFresh(workspace.getSnapshot())).toBe(true);
    workspace.dispose();
  });

  it('treats only structural edits as changes: title and sample edits keep the result fresh', async () => {
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), checker);
    await workspace.start();
    await vi.advanceTimersByTimeAsync(60);
    expect(isAnalysisFresh(workspace.getSnapshot())).toBe(true);
    const boundId = workspace.getSnapshot().analysisStructureId;

    const project = workspace.getSnapshot().project as RuleProject;
    workspace.renameProject('仅改标题');
    expect(workspace.getSnapshot().structureId).toBe(structureSignature(project));
    expect(isAnalysisFresh(workspace.getSnapshot())).toBe(true);
    expect(workspace.getSnapshot().analysisStructureId).toBe(boundId);
    workspace.dispose();
  });
});
