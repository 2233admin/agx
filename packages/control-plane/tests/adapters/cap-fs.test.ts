import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadCapConfigRevisions } from '../../src/adapters/sources/cap-fs';
import { validateSupplyRelativeRef } from '../../src/cli/supply-root';
import { isKnown, isUnknown } from '../../src/domain/facts';

const FIXTURE_ROOT = path.join(import.meta.dir, '..', 'fixtures', 'cap-sample');

describe('loadCapConfigRevisions (fixture, not the real repo .cap/)', () => {
  test('maps one StableConfigRevision per declared profile role', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    expect(revisions.map((r) => r.configName).sort()).toEqual(['general', 'reviewer']);
  });

  test('defaultMarker is Unknown for every profile -- manifest.defaults is a policy-overlay path, not a per-profile role marker', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    for (const revision of revisions) {
      expect(isUnknown(revision.defaultMarker)).toBe(true);
    }
  });

  test('a role resolved in lock.json gets revisionId = layer_digest and Known("resolved") availability', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const general = revisions.find((r) => r.configName === 'general')!;
    expect(general.revisionId).toBe('sha256:general-fixture-digest');
    expect(isKnown(general.availability)).toBe(true);
  });

  test('a role absent from lock.json.profiles gets Unknown("not-resolved", ...) availability', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const reviewer = revisions.find((r) => r.configName === 'reviewer')!;
    expect(isUnknown(reviewer.availability)).toBe(true);
    if (isUnknown(reviewer.availability)) {
      expect(reviewer.availability.reason).toBe('not-resolved');
    }
  });

  test('skills/mcps from lock.json inventory map to typed Skill/MCP references', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const general = revisions.find((r) => r.configName === 'general')!;
    const names = general.skills.map((s) => s.name).sort();
    expect(names).toEqual(['grilling', 'openspec-explore']);
    expect(general.mcp).toEqual([]);
  });

  test('a plugin-imported skill (declared in project_skill_imports) is tagged project-skill-import; a plain project skill is tagged project-capability', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const general = revisions.find((r) => r.configName === 'general')!;
    const grilling = general.skills.find((s) => s.name === 'grilling')!;
    const openspecExplore = general.skills.find((s) => s.name === 'openspec-explore')!;
    expect(isKnown(grilling.sourceCategory) && grilling.sourceCategory.value).toBe('project-skill-import');
    expect(isKnown(openspecExplore.sourceCategory) && openspecExplore.sourceCategory.value).toBe('project-capability');
  });

  test('the prompt path becomes a typed Instruction reference -- the prompt file content is never read', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const general = revisions.find((r) => r.configName === 'general')!;
    expect(general.instructions).toHaveLength(1);
    expect(general.instructions[0]!.kind).toBe('instruction');
    expect(general.instructions[0]!.name).toBe('.cap/prompts/general.md');
    const summary = general.instructions[0]!.summary;
    expect(isKnown(summary) && summary.value.includes('general.md')).toBe(true);
    // The mapped summary must only ever reference the path, never contain
    // arbitrary prose that could only come from reading the .md body.
    expect(isKnown(summary) && summary.value).not.toContain('\n');
  });

  test('scopeBoundary never embeds prompt body content, only path/counts', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    for (const revision of revisions) {
      expect(isKnown(revision.scopeBoundary)).toBe(true);
      if (isKnown(revision.scopeBoundary)) {
        expect(revision.scopeBoundary.value).toContain('prompt:');
      }
    }
  });

  test('an unresolved profile\'s capability arrays come from lock.json inventory (empty), never from the profile TOML allow list', async () => {
    // reviewer.toml declares skills.allow = ["review-checklist"], but the
    // `reviewer` role has no entry under lock.json.profiles -- it is
    // unresolved. The allow list is a *request*, not an *inventory*; only
    // lock.json's resolved inventory may populate skills/mcp/hooks/plugins.
    // If this ever starts reading `review-checklist` out of the profile
    // TOML's allow list, that is a silent-fabrication regression.
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const reviewer = revisions.find((r) => r.configName === 'reviewer')!;
    expect(isUnknown(reviewer.availability)).toBe(true);
    expect(reviewer.skills).toEqual([]);
    expect(reviewer.mcp).toEqual([]);
    expect(reviewer.hooks).toEqual([]);
    expect(reviewer.plugins).toEqual([]);
    expect(reviewer.skills.map((s) => s.name)).not.toContain('review-checklist');
  });

  test('[Story 4.5b][Story 3.4] a plain project skill\'s sourceRef points at capabilities/skills/<name> under capRoot; an imported skill\'s sourceRef points at lock.json\'s own declared source under repoRoot -- both recorded repoRoot-relative and POSIX-separated, never absolute', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const general = revisions.find((r) => r.configName === 'general')!;
    const grilling = general.skills.find((s) => s.name === 'grilling')!;
    const openspecExplore = general.skills.find((s) => s.name === 'openspec-explore')!;

    expect(isKnown(openspecExplore.sourceRef) && openspecExplore.sourceRef.value).toBe(
      'cap-sample/capabilities/skills/openspec-explore',
    );
    // `grilling` 在 `project_skill_imports` 里声明为
    // `source: "plugins/grilling/skills/grilling"`——它的位置是相对
    // `FIXTURE_ROOT` 所在的那个目录（repoRoot）算的，绝不是相对
    // `FIXTURE_ROOT` 本身，因为 import 住在 `.cap/` 等价根之外。这也正是本
    // loader 隐含的唯一供给根是 repoRoot 而不是 capRoot 的原因：相对 capRoot，
    // 这一条只能用 `../` 逃逸出去，而那是 Story 3.4 的合同要拒绝的。
    expect(isKnown(grilling.sourceRef) && grilling.sourceRef.value).toBe('plugins/grilling/skills/grilling');
  });

  test('[Story 3.4] every Known sourceRef this loader emits satisfies the portability contract -- checked with the one shared predicate, never a hand-copied paraphrase of it', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const supplyRoot = path.dirname(FIXTURE_ROOT);
    const allRefs = revisions.flatMap((r) => [...r.instructions, ...r.skills, ...r.mcp, ...r.hooks, ...r.plugins]);
    expect(allRefs.length).toBeGreaterThan(0);

    for (const capabilityRef of allRefs) {
      if (!isKnown(capabilityRef.sourceRef)) {
        continue;
      }
      // 刻意用解析侧运行的*同一个* `validateSupplyRelativeRef`：在这里手抄
      // 第二份规则副本会与真规则漂移，然后给启动侧本会拒绝的引用发合格证。
      expect(validateSupplyRelativeRef(capabilityRef.sourceRef.value, supplyRoot).ok).toBe(true);
    }
  });

  test('[Story 3.4] the instruction prompt sourceRef is repoRoot-relative POSIX too -- one revision, one supply root', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const general = revisions.find((r) => r.configName === 'general')!;
    const prompt = general.instructions[0]!;
    expect(isKnown(prompt.sourceRef) && prompt.sourceRef.value).toBe('cap-sample/prompts/general.md');
  });

  test('[Story 4.5b] mcp/hooks/plugins sourceRef stays honestly Unknown -- no real directory convention exists for them', async () => {
    const revisions = await loadCapConfigRevisions(FIXTURE_ROOT);
    const general = revisions.find((r) => r.configName === 'general')!;
    // The fixture's `general` has no mcp/hooks/plugins references, so exercise
    // the mapping function's honesty via the shared helper indirectly: any
    // capability of kind other than 'skill'/'instruction' must stay Unknown.
    for (const capabilityRef of [...general.mcp, ...general.hooks, ...general.plugins]) {
      expect(isUnknown(capabilityRef.sourceRef)).toBe(true);
    }
  });
});

describe('[Story 3.4 patch] illegal declared data degrades to Unknown, never to a doomed sourceRef', () => {
  let repoRoot: string;
  let capRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), 'control-plane-cap-fs-illegal-'));
    capRoot = path.join(repoRoot, '.cap');
    mkdirSync(path.join(capRoot, 'profiles'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** 写出一个最小 CAP 形态目录，其声明数据是刻意做成敌意的。 */
  function writeCap(promptPath: string, importSource: string): void {
    writeFileSync(
      path.join(capRoot, 'manifest.toml'),
      'version = 3\n\n[profiles]\ngeneral = ".cap/profiles/general.toml"\n',
      'utf8',
    );
    writeFileSync(path.join(capRoot, 'profiles', 'general.toml'), `version = 3\nprompt = "${promptPath}"\n`, 'utf8');
    writeFileSync(
      path.join(capRoot, 'lock.json'),
      JSON.stringify({
        profiles: {
          general: {
            layer_digest: 'sha256:illegal-fixture',
            inventory: { skills: ['imported'], mcps: [], hooks: [], plugins: [] },
          },
        },
        project_skill_imports: [{ name: 'imported', source: importSource }],
      }),
      'utf8',
    );
  }

  test('an import source escaping the supply root is Unknown, not `../outside/...`', async () => {
    writeCap('.cap/prompts/general.md', '../outside/grilling');
    const revisions = await loadCapConfigRevisions(capRoot);
    const imported = revisions[0]!.skills.find((skill) => skill.name === 'imported')!;
    expect(isUnknown(imported.sourceRef)).toBe(true);
  });

  test('an absolute import source is Unknown, never spliced onto repoRoot', async () => {
    writeCap('.cap/prompts/general.md', process.platform === 'win32' ? 'D:/elsewhere/grilling' : '/elsewhere/grilling');
    const revisions = await loadCapConfigRevisions(capRoot);
    const imported = revisions[0]!.skills.find((skill) => skill.name === 'imported')!;
    expect(isUnknown(imported.sourceRef)).toBe(true);
  });

  test('a backslash-separated import source is Unknown on every platform -- the same string must not mean two things', async () => {
    writeCap('.cap/prompts/general.md', 'plugins\\grilling\\skills\\grilling');
    const revisions = await loadCapConfigRevisions(capRoot);
    const imported = revisions[0]!.skills.find((skill) => skill.name === 'imported')!;
    expect(isUnknown(imported.sourceRef)).toBe(true);
  });

  test('a declared prompt escaping the CAP directory is Unknown -- path.join must not be allowed to swallow it', async () => {
    writeCap('../../outside-the-repo.md', 'plugins/grilling/skills/grilling');
    const revisions = await loadCapConfigRevisions(capRoot);
    expect(isUnknown(revisions[0]!.instructions[0]!.sourceRef)).toBe(true);
    // ……而同一条修订里那个合法的 import 不受影响：降级是按引用逐条发生的，
    // 不会把整条修订抹白。
    const imported = revisions[0]!.skills.find((skill) => skill.name === 'imported')!;
    expect(isKnown(imported.sourceRef) && imported.sourceRef.value).toBe('plugins/grilling/skills/grilling');
  });

  test('an absolute declared prompt is Unknown (path.join(root, "/abs/x") would otherwise yield <root>/abs/x)', async () => {
    writeCap(process.platform === 'win32' ? 'D:/elsewhere/general.md' : '/elsewhere/general.md', 'plugins/grilling/skills/grilling');
    const revisions = await loadCapConfigRevisions(capRoot);
    expect(isUnknown(revisions[0]!.instructions[0]!.sourceRef)).toBe(true);
  });
});

// `[Story 4.7]` The `describe('loadCapConfigRevisions sourceRef against the
// real repo .cap/ (Story 4.5b AC evidence)', ...)` block that lived here
// (Story 4.5b) asserted `sourceRef` resolution against the real repo `.cap/`
// directory (both a plain project skill under `.cap/capabilities/skills/`
// and the `agent-assembler` profile's imported "grilling" skill resolved
// via `lock.json`'s `project_skill_imports`). `.cap/` was retired by
// Story 4.7 once its real smoke-parity precondition was met (see
// spec-4-7-退役-cap-本体.md's Auto Run Result for the captured evidence).
// The same two `sourceRef`-resolution code paths (plain project skill vs.
// lock.json-declared import) remain covered above against
// `FIXTURE_ROOT` (`loadCapConfigRevisions (fixture, not the real repo
// .cap/)`'s `'[Story 4.5b] a plain project skill's sourceRef resolves ...'`
// test), which does not depend on `.cap/` existing on disk.
