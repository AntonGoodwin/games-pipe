// Deterministic stages. No AI here: outcomes are facts (exit codes, hashes, file contents).
import fs from 'node:fs';
import path from 'node:path';
import { applyHumanDecision, type Task } from './store.ts';
import {
  abs,
  diffHashes,
  exists,
  hashTree,
  listFiles,
  readText,
  readTextIfExists,
  rel,
  sh,
  truncate,
  writeText,
} from './util.ts';

export interface CheckCtx {
  task: Task;
  scope: string;
  dir: string; // scope dir: platform | games/<id>
  stageDir: string;
  tamper: string[];
}

export interface CheckResult {
  outcome: 'pass' | 'fail';
  details: string; // human/agent readable; becomes feedback for the next AI stage on failure
}

const isPlatform = (c: CheckCtx): boolean => c.scope === 'platform';
const testsDir = (c: CheckCtx): string => `${c.dir}/tests`;
const lockDir = (scope: string): string => `.factory/locked/${scope}`;
const PLATFORM_LOCK = '.factory/platform.lock.json';

// ---------- helpers ----------

interface VitestSummary {
  code: number;
  total: number;
  passed: number;
  failed: Array<{ name: string; message: string }>;
  loadErrors: string[];
  raw: string;
}

export function runVitest(paths: string[], stageDir: string, label: string): VitestSummary {
  const out = `${stageDir}/vitest-${label}.json`;
  const r = sh('pnpm', ['exec', 'vitest', 'run', ...paths, '--reporter=json', `--outputFile=${abs(out)}`]);
  const summary: VitestSummary = { code: r.code, total: 0, passed: 0, failed: [], loadErrors: [], raw: truncate(r.stdout + r.stderr, 3000) };
  const json = readTextIfExists(out);
  if (!json) {
    summary.loadErrors.push(`vitest не сформировал отчёт: ${summary.raw}`);
    return summary;
  }
  const data = JSON.parse(json) as {
    numTotalTests: number;
    numPassedTests: number;
    testResults: Array<{ name: string; status: string; message?: string; assertionResults: Array<{ fullName: string; status: string; failureMessages: string[] }> }>;
  };
  summary.total = data.numTotalTests;
  summary.passed = data.numPassedTests;
  for (const file of data.testResults) {
    if (file.status === 'failed' && file.assertionResults.length === 0) summary.loadErrors.push(`${rel(file.name)}: ${truncate(file.message ?? 'не загрузился', 1500)}`);
    for (const a of file.assertionResults) {
      if (a.status === 'failed') summary.failed.push({ name: `${rel(file.name)} › ${a.fullName}`, message: truncate(a.failureMessages.join('\n'), 1500) });
    }
  }
  return summary;
}

function formatVitest(s: VitestSummary): string {
  const lines = [`Тесты: ${s.passed}/${s.total} пройдено, упало ${s.failed.length}, ошибок загрузки ${s.loadErrors.length}.`];
  for (const e of s.loadErrors) lines.push(`\n### Ошибка загрузки\n${e}`);
  for (const f of s.failed) lines.push(`\n### ✗ ${f.name}\n\`\`\`\n${f.message}\n\`\`\``);
  return lines.join('\n');
}

function scenarioIds(c: CheckCtx): string[] {
  const spec = readTextIfExists(`${c.dir}/spec.md`) ?? '';
  const prefix = isPlatform(c) ? 'PL' : 'SC';
  return [...new Set([...spec.matchAll(new RegExp(`\\b${prefix}-\\d+\\b`, 'g'))].map((m) => m[0]))];
}

function coverageGaps(c: CheckCtx): { ids: string[]; missing: string[] } {
  const ids = scenarioIds(c);
  const testText = listFiles(testsDir(c))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readText(f))
    .join('\n');
  return { ids, missing: ids.filter((id) => !new RegExp(`\\b${id}\\b`).test(testText)) };
}

function copyTree(fromDir: string, toDir: string): void {
  fs.rmSync(abs(toDir), { recursive: true, force: true });
  for (const f of listFiles(fromDir)) {
    const target = path.join(abs(toDir), path.relative(abs(fromDir), abs(f)));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(abs(f), target);
  }
}

/** Restores the scope's tests from the locked copy if they differ. Returns true if tampering was found. */
export function enforceTestLock(c: CheckCtx): boolean {
  const manifestPath = `${lockDir(c.scope)}/manifest.json`;
  if (!exists(manifestPath)) return false;
  const manifest = JSON.parse(readText(manifestPath)) as { hashes: Record<string, string> };
  const changed = diffHashes(manifest.hashes, hashTree([testsDir(c)]));
  if (!changed.length) return false;
  copyTree(`${lockDir(c.scope)}/files`, testsDir(c));
  c.tamper.push(`тесты изменены вне агента тестирования, восстановлены из блокировки: ${changed.join(', ')}`);
  return true;
}

/** Reverts any change to the frozen platform. Returns true if tampering was found. */
export function enforcePlatformFreeze(c: CheckCtx): boolean {
  if (isPlatform(c) || !exists(PLATFORM_LOCK)) return false;
  const lock = JSON.parse(readText(PLATFORM_LOCK)) as { hashes: Record<string, string> };
  const changed = diffHashes(lock.hashes, hashTree(['platform']));
  if (!changed.length) return false;
  sh('git', ['checkout', 'HEAD', '--', 'platform']);
  sh('git', ['clean', '-fdq', 'platform']);
  c.tamper.push(`попытка изменить замороженную платформу, откат: ${changed.join(', ')}`);
  return true;
}

function boundaryViolations(c: CheckCtx): string[] {
  if (isPlatform(c)) return [];
  const out: string[] = [];
  const files = listFiles(c.dir).filter((f) => !f.startsWith(`${testsDir(c)}/`) && /\.(ts|js|mjs|html)$/.test(f));
  for (const f of files) {
    const text = readText(f);
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = rel(path.join(path.dirname(abs(f)), spec));
      if (target.startsWith('platform/') && !target.startsWith('platform/sdk/')) out.push(`${f}: импорт "${spec}" — игре доступен только platform/sdk`);
      if (target.startsWith('games/') && !target.startsWith(`${c.dir}/`)) out.push(`${f}: импорт "${spec}" — игра не может зависеть от другой игры`);
    }
    // Real wallet access only: its port or its endpoints as URL paths. Words like the platform error
    // code WALLET_UNAVAILABLE are legitimate (false positive found in r-007, KB-009).
    if (/:4001\b|['"`]\/(?:bet|payout|balance)\b/.test(text)) out.push(`${f}: прямое обращение к кошельку партнёра запрещено — баланс только через platform/sdk`);
  }
  return out;
}

function typecheck(): { ok: boolean; output: string } {
  const r = sh('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.json']);
  return { ok: r.code === 0, output: truncate(r.stdout + r.stderr, 4000) };
}

function regressionPaths(c: CheckCtx): string[] {
  return isPlatform(c) ? [testsDir(c)] : [testsDir(c), 'platform/tests'];
}

// ---------- checks ----------

export function scaffold(c: CheckCtx): CheckResult {
  const id = c.scope;
  const title = c.task.data.title;
  if (!exists(`${c.dir}/manifest.json`)) writeText(`${c.dir}/manifest.json`, `${JSON.stringify({ id, title, server: 'server/index.ts', ui: 'ui/index.html' }, null, 2)}\n`);
  if (!exists(`${c.dir}/server/index.ts`)) {
    writeText(
      `${c.dir}/server/index.ts`,
      `// Заглушка, созданная оркестратором. Реализацию пишет агент-разработчик.\nimport type { GameModule } from '../../../platform/sdk/types.ts';\n\nconst notImplemented = (): never => {\n  throw new Error('NOT_IMPLEMENTED');\n};\n\n/** Заглушка игры ${id}: все методы бросают NOT_IMPLEMENTED. */\nconst game: GameModule = {\n  id: '${id}',\n  validateParams: notImplemented,\n  start: notImplemented,\n  action: notImplemented,\n  publicView: notImplemented,\n};\n\nexport default game;\n`,
    );
  }
  if (!exists(`${c.dir}/ui/index.html`)) writeText(`${c.dir}/ui/index.html`, `<!doctype html>\n<meta charset="utf-8">\n<title>${title}</title>\n<p>NOT_IMPLEMENTED</p>\n`);
  fs.mkdirSync(abs(testsDir(c)), { recursive: true });
  return { outcome: 'pass', details: `Каркас ${c.dir}: manifest.json, server/index.ts (заглушка), ui/index.html, tests/` };
}

export function coverage(c: CheckCtx): CheckResult {
  const { ids, missing } = coverageGaps(c);
  if (!ids.length) return { outcome: 'fail', details: `В ${c.dir}/spec.md не найдено ни одного сценария (${isPlatform(c) ? 'PL' : 'SC'}-N).` };
  if (missing.length) return { outcome: 'fail', details: `Сценарии без тестов: ${missing.join(', ')}. Каждый ID сценария должен встречаться в названии теста.` };
  const typed = typecheck();
  if (!typed.ok) return { outcome: 'fail', details: `Тесты не проходят проверку типов:\n${typed.output}` };
  return { outcome: 'pass', details: `Все ${ids.length} сценариев покрыты тестами: ${ids.join(', ')}` };
}

/** Tests must exist, load and FAIL against the stub: otherwise they check nothing. */
export function red(c: CheckCtx): CheckResult {
  const cov = coverage(c);
  if (cov.outcome === 'fail') return cov;
  const s = runVitest([testsDir(c)], c.stageDir, 'red');
  if (s.loadErrors.length) return { outcome: 'fail', details: `Тесты не загружаются:\n${formatVitest(s)}` };
  if (s.total === 0) return { outcome: 'fail', details: 'Не найдено ни одного теста.' };
  if (s.failed.length === 0) return { outcome: 'fail', details: 'Все тесты проходят на заглушке NOT_IMPLEMENTED — они ничего не проверяют в игре.' };
  return { outcome: 'pass', details: `RED: на заглушке упало ${s.failed.length} из ${s.total} тестов, как и должно. ${cov.details}` };
}

export function lockTests(c: CheckCtx): CheckResult {
  const files = listFiles(testsDir(c));
  if (!files.length) return { outcome: 'fail', details: 'Нечего блокировать: тестов нет.' };
  copyTree(testsDir(c), `${lockDir(c.scope)}/files`);
  const hashes = hashTree([testsDir(c)]);
  writeText(`${lockDir(c.scope)}/manifest.json`, `${JSON.stringify({ locked_at: new Date().toISOString(), task: c.task.data.id, hashes }, null, 2)}\n`);
  return { outcome: 'pass', details: `Заблокировано тестов: ${files.length}. Копия и sha256 в ${lockDir(c.scope)}/` };
}

export function verify(c: CheckCtx): CheckResult {
  const problems: string[] = [];
  if (enforceTestLock(c)) problems.push('Тесты были изменены и восстановлены из блокировки. Тесты меняет только агент тестирования — если тест неверен, верни outcome "dispute".');
  if (enforcePlatformFreeze(c)) problems.push('Платформа заморожена; изменения откатаны. Игра работает только через platform/sdk.');
  const bounds = boundaryViolations(c);
  if (bounds.length) problems.push(`Нарушены границы игры и платформы:\n${bounds.map((b) => `- ${b}`).join('\n')}`);
  const typed = typecheck();
  if (!typed.ok) problems.push(`Проверка типов (tsc) не прошла:\n\`\`\`\n${typed.output}\n\`\`\``);
  const s = runVitest(regressionPaths(c), c.stageDir, 'verify');
  if (s.loadErrors.length || s.failed.length || s.code !== 0 || s.total === 0) problems.push(formatVitest(s));
  if (problems.length) return { outcome: 'fail', details: problems.join('\n\n') };
  return { outcome: 'pass', details: `Проверки пройдены: границы, tsc, тесты ${s.passed}/${s.total}.` };
}

function brokenWikiLinks(files: string[]): string[] {
  const broken: string[] = [];
  for (const f of files) {
    const text = readText(f).replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const target = m[1].trim();
      if (!exists(target) && !exists(`${target}.md`)) broken.push(`${f}: [[${target}]]`);
    }
  }
  return broken;
}

function missingTsDoc(c: CheckCtx): string[] {
  const files = listFiles(c.dir).filter((f) => f.endsWith('.ts') && !f.includes('/tests/'));
  const out: string[] = [];
  for (const f of files) {
    const lines = readText(f).split('\n');
    lines.forEach((line, i) => {
      if (!/^export\s+(default\s+)?(async\s+)?(function|const|class|interface|type|abstract)\b/.test(line)) return;
      let j = i - 1;
      while (j >= 0 && lines[j].trim().startsWith('@')) j--; // decorators
      if (j < 0 || !lines[j].trim().endsWith('*/')) out.push(`${f}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  }
  return out;
}

export function docs(c: CheckCtx): CheckResult {
  const problems: string[] = [];
  if (!exists(`${c.dir}/README.md`)) problems.push(`Нет ${c.dir}/README.md`);
  const mdFiles = [...listFiles(c.dir).filter((f) => f.endsWith('.md') && !f.includes('/tests/')), `decisions/${c.scope}.md`, c.task.file].filter(exists);
  const broken = brokenWikiLinks(mdFiles);
  if (broken.length) problems.push(`Битые ссылки:\n${broken.map((b) => `- ${b}`).join('\n')}`);
  const tsdoc = missingTsDoc(c);
  if (tsdoc.length) problems.push(`Экспорт без TSDoc-комментария:\n${tsdoc.map((t) => `- ${t}`).join('\n')}`);
  // The docs agent touches code comments, so the code must still compile and pass the locked tests.
  const v = verify(c);
  if (v.outcome === 'fail') problems.push(`После правок документации код не проходит проверки:\n${v.details}`);
  if (problems.length) return { outcome: 'fail', details: problems.join('\n\n') };
  return { outcome: 'pass', details: `Документация в порядке: README, TSDoc, ссылки (${mdFiles.length} файлов). ${v.details}` };
}

export function freezePlatform(c: CheckCtx): CheckResult {
  const hashes = hashTree(['platform']);
  writeText(PLATFORM_LOCK, `${JSON.stringify({ frozen_at: new Date().toISOString(), task: c.task.data.id, hashes }, null, 2)}\n`);
  return { outcome: 'pass', details: `Платформа заморожена: ${Object.keys(hashes).length} файлов, sha256 в ${PLATFORM_LOCK}` };
}

export function applyDecision(c: CheckCtx): CheckResult {
  const d = c.task.data.decision;
  if (!d) return { outcome: 'fail', details: 'В задаче нет решения человека (поле decision).' };
  applyHumanDecision(c.scope, d.id, d.value, c.task);
  return { outcome: 'pass', details: `Решение человека ${d.id} = «${d.value}» записано в decisions/${c.scope}.md` };
}

export const CHECKS: Record<string, (c: CheckCtx) => CheckResult> = {
  scaffold,
  coverage,
  red,
  lock_tests: lockTests,
  verify,
  docs,
  freeze_platform: freezePlatform,
  apply_decision: applyDecision,
};
