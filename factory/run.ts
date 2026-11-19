// Game factory orchestrator: a deterministic state machine over factory/pipeline.yaml.
//
//   node factory/run.ts platform                         build the shared platform (once)
//   node factory/run.ts new specs/coin.md                create a new game
//   node factory/run.ts feedback coin feedback/coin.md   apply text remarks to a ready game
//   node factory/run.ts decide coin D-003 "new value"    change one of the pipeline's decisions
//   node factory/run.ts stage GAME-001 review            run one stage by hand (classic SDLC)
//   node factory/run.ts resume GAME-001                  continue a stopped/manual task
//   node factory/run.ts games | status | summary
import fs from 'node:fs';
import YAML from 'yaml';
import { runAiStage, writablePaths, type AiCall } from './lib/ai-stages.ts';
import { CHECKS, type CheckCtx } from './lib/checks.ts';
import {
  addDecisions,
  createTask,
  findTask,
  journal,
  listTasks,
  saveTask,
  scopeDir,
  taskLink,
  upsertKb,
  type Task,
} from './lib/store.ts';
import {
  abs,
  diffHashes,
  exists,
  fmtMs,
  hashTree,
  listFiles,
  matchesAny,
  readText,
  sh,
  truncate,
  writeText,
} from './lib/util.ts';

// ---------- config ----------

interface StageDef {
  run: string;
  counter?: string;
  on: Record<string, string>;
}
interface PipelineDef {
  start: string;
  stages: Record<string, StageDef>;
}
interface Config {
  limits: Record<string, number>;
  max_turns: Record<string, number>;
  pipelines: Record<string, PipelineDef>;
}

const config = YAML.parse(readText('factory/pipeline.yaml')) as Config;

// ---------- run context ----------

interface StageMetric {
  seq: number;
  stage: string;
  kind: 'ai' | 'check';
  attempt: number;
  outcome: string;
  durationMs: number;
  trigger: 'auto' | 'manual';
  calls: Array<{ agent: string; ok: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; numTurns: number; durationMs: number }>;
}

interface Run {
  id: string;
  dir: string;
  task: Task;
  pipeline: PipelineDef;
  trigger: 'auto' | 'manual';
  started: number;
  seq: number;
  feedback: string;
  lastDetails: Record<string, string>; // last outcome details per stage, e.g. review findings
  stoppedAt: string | null;
  metrics: StageMetric[];
  events: string[];
  tamper: string[];
  appliedKb: Array<{ stage: string; ids: string[] }>;
  decisions: string[];
  disputes: string[];
  stopReason: string | null;
  learned: boolean;
  kbTouched: string[];
}

function log(run: Run, line: string): void {
  const stamped = `[${new Date().toTimeString().slice(0, 8)}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(abs(`${run.dir}/live.log`), `${stamped}\n`);
}

function nextRunId(task: Task): string {
  const n = fs.existsSync(abs('runs')) ? fs.readdirSync(abs('runs')).filter((d) => /^r-\d+/.test(d)).length : 0;
  return `r-${String(n + 1).padStart(3, '0')}-${task.data.id}`;
}

function git(args: string[]): void {
  const r = sh('git', args);
  if (r.code !== 0 && !/nothing to commit/.test(r.stdout + r.stderr)) console.warn(`git ${args.join(' ')}: ${r.stderr.trim()}`);
}

function commit(message: string): void {
  if (sh('git', ['status', '--porcelain']).stdout.trim()) {
    git(['add', '-A']);
    git(['commit', '-qm', message]);
  }
}

// ---------- integrity around AI stages ----------

interface Snapshot {
  hashes: Record<string, string>;
  contents: Map<string, Buffer>;
}

function snapshot(): Snapshot {
  const hashes = hashTree(['.']);
  const contents = new Map<string, Buffer>();
  for (const f of Object.keys(hashes)) contents.set(f, fs.readFileSync(abs(f)));
  return { hashes, contents };
}

/** Reverts every change an AI stage made outside its allowlist (layer 3 of the write protection). */
function enforceAllowlist(run: Run, before: Snapshot, allow: string[], deny: string[], stage: string): string[] {
  const changed = diffHashes(before.hashes, hashTree(['.']));
  const bad = changed.filter((f) => !matchesAny(f, allow) || matchesAny(f, deny));
  for (const f of bad) {
    const prev = before.contents.get(f);
    if (prev) writeText(f, prev.toString('utf8'));
    else fs.rmSync(abs(f), { force: true });
  }
  if (bad.length) run.tamper.push(`этап ${stage}: запись вне разрешённых путей откатана: ${bad.join(', ')}`);
  return bad;
}

// ---------- engine ----------

function runEventsText(run: Run): string {
  return truncate(
    [
      `Задача ${run.task.data.id} (${run.task.data.type}, ${run.task.data.scope}), конвейер ${run.task.data.pipeline}.`,
      ...run.events,
      run.tamper.length ? `\nНарушения защиты:\n${run.tamper.map((t) => `- ${t}`).join('\n')}` : '',
      run.disputes.length ? `\nСпоры по тестам:\n${run.disputes.map((t) => `- ${t}`).join('\n')}` : '',
      run.stopReason ? `\nЗАПУСК ОСТАНОВЛЕН: ${run.stopReason}` : '\nЗапуск завершён успешно.',
    ].join('\n'),
    30000,
  );
}

async function execStage(run: Run, stage: string): Promise<string> {
  const def = run.pipeline.stages[stage];
  const task = run.task;
  const counterKey = def.counter ?? stage;
  const isAi = def.run.startsWith('ai:');
  const attempt = (task.data.rounds[counterKey] ?? 0) + (isAi ? 1 : 0);
  if (isAi) {
    const limit = config.limits[counterKey];
    if (limit && attempt > limit) {
      run.stoppedAt = stage;
      throw new LimitStop(`лимит попыток этапа «${stage}» исчерпан (${limit}). Последний результат этапа «${stage}»:\n${truncate(run.lastDetails[stage] ?? run.feedback, 3000)}`);
    }
    task.data.rounds[counterKey] = attempt;
  }
  run.seq++;
  const stageDir = `${run.dir}/stages/${String(run.seq).padStart(2, '0')}-${stage}${isAi ? `-try${attempt}` : ''}`;
  fs.mkdirSync(abs(stageDir), { recursive: true });
  task.data.phase = stage;
  task.data.status = 'in-progress';
  saveTask(task);
  log(run, `▶ ${stage}${isAi ? ` (попытка ${attempt}${config.limits[counterKey] ? `/${config.limits[counterKey]}` : ''})` : ''}`);
  const started = Date.now();
  let outcome: string;
  let details: string;
  const metric: StageMetric = { seq: run.seq, stage, kind: isAi ? 'ai' : 'check', attempt, outcome: '', durationMs: 0, trigger: run.trigger, calls: [] };

  if (!isAi) {
    const name = def.run.slice('check:'.length);
    const ctx: CheckCtx = { task, scope: task.data.scope, dir: scopeDir(task.data.scope), stageDir, tamper: run.tamper };
    const r = CHECKS[name](ctx);
    outcome = r.outcome;
    details = r.details;
  } else {
    const before = snapshot();
    const r = await runAiStage(
      {
        task,
        scope: task.data.scope,
        dir: scopeDir(task.data.scope),
        runId: run.id,
        stageDir,
        stage,
        feedback: run.feedback,
        maxTurns: config.max_turns,
        reviewPending: task.data.review_pending ?? null,
        previousReview: run.lastDetails.review ?? task.data.last_review ?? '',
        runEvents: runEventsText(run),
        onProgress: (agent, line) => fs.appendFileSync(abs(`${run.dir}/live.log`), `    · ${agent}: ${line}\n`),
      },
      def.run,
    );
    const w = writablePaths(task.data.scope, def.run.split(':')[1]);
    const reverted = enforceAllowlist(run, before, w.allow, w.deny, stage);
    outcome = r.outcome;
    details = r.details + (reverted.length ? `\n\nОткатаны записи вне разрешённых путей: ${reverted.join(', ')}` : '');
    metric.calls = r.calls.map((c: AiCall) => ({ agent: c.agent, ok: c.ok, ...c.usage }));
    if (r.appliedKb.length) run.appliedKb.push({ stage, ids: [...new Set(r.appliedKb)] });
    if (r.decisions.length) {
      const ids = addDecisions(task.data.scope, r.decisions, { task, stage, run: run.id });
      run.decisions.push(...ids);
      journal(task, `${stage}: новые допущения ${ids.join(', ')} → [[decisions/${task.data.scope}]]`);
    }
    if (r.reviewFailed) task.data.review_pending = r.reviewFailed.length ? r.reviewFailed : undefined;
    if (r.dispute) run.disputes.push(`${r.dispute.test}: ${r.dispute.reason}`);
    // The instruction becomes this stage's details, so it is what the next (implement) stage receives.
    if (stage === 'dispute' && outcome === 'rejected') details = registerRejectedDispute(run, details);
    if (r.kbUpserts) {
      const kbBefore = `.factory/tmp/kb-before-${run.id}`;
      fs.rmSync(abs(kbBefore), { recursive: true, force: true });
      fs.mkdirSync(abs(kbBefore), { recursive: true });
      for (const f of listFiles('kb')) fs.copyFileSync(abs(f), abs(`${kbBefore}/${f.slice(3)}`));
      run.kbTouched = upsertKb(r.kbUpserts, run.id);
      const diff = sh('git', ['diff', '--no-index', '--', kbBefore, 'kb']).stdout;
      writeText(`${run.dir}/kb-diff.patch`, diff || '(база знаний не изменилась)\n');
      run.learned = true;
    }
    if (outcome === 'error') {
      // A crashed agent run is retried through the same stage (bounded by its counter).
      details = `Агент не вернул результат: ${details}`;
    }
  }

  metric.outcome = outcome;
  metric.durationMs = Date.now() - started;
  run.metrics.push(metric);
  writeText(`${stageDir}/outcome.md`, `# ${stage}: ${outcome}\n\n${details}\n`);
  run.events.push(`#${run.seq} ${stage} (попытка ${attempt}) → ${outcome}: ${truncate(details.replace(/\n+/g, ' '), 700)}`);
  log(run, `  ${outcome === 'pass' || outcome === 'done' || outcome === 'accepted' ? '✓' : '•'} ${stage} → ${outcome} (${fmtMs(metric.durationMs)})`);
  journal(task, `${stage} → ${outcome} (${fmtMs(metric.durationMs)})`);
  writeMetrics(run);
  run.feedback = details;
  run.lastDetails[stage] = details;
  if (stage === 'review') task.data.last_review = outcome === 'fail' ? truncate(details, 6000) : undefined;
  return outcome;
}

/** Records the rejected dispute as a pending human decision and returns the instruction for the developer. */
function registerRejectedDispute(run: Run, reason: string): string {
  const d = run.disputes[run.disputes.length - 1] ?? 'спор по тесту';
  const ids = addDisputeDecision(run, d, reason);
  run.task.data.needs_human = [...(run.task.data.needs_human ?? []), ...ids];
  return `Агент тестирования отклонил спор по тесту ${d}.\nОбоснование: ${reason}\n\nПо правилу «по умолчанию прав тест» реализуй поведение из теста; повторно спорить по этому тесту не нужно. Спор записан в журнал решений как ${ids.join(', ')}; человек может изменить это позже.`;
}

function addDisputeDecision(run: Run, dispute: string, reason: string): string[] {
  // The orchestrator, not an agent, records the open dispute; the human can flip it later via /game-decide.
  const ids = addDecisions(
    run.task.data.scope,
    [{ question: `Спор по тесту: ${dispute}`, assumption: 'Прав тест (правило по умолчанию)', rationale: `Агент тестирования отклонил спор: ${reason}. Человек может выбрать «code» или «test» через /game-decide.` }],
    { task: run.task, stage: 'dispute', run: run.id, status: 'спор, ждёт решения человека (работа не блокируется)' },
  );
  run.decisions.push(...ids);
  return ids;
}

class LimitStop extends Error {}

async function runPipeline(task: Task, opts: { from?: string; single?: boolean; until?: string; trigger?: 'auto' | 'manual' } = {}): Promise<Run> {
  const pipeline = config.pipelines[task.data.pipeline];
  if (!pipeline) throw new Error(`Неизвестный конвейер ${task.data.pipeline}`);
  const id = nextRunId(task);
  const run: Run = {
    id, dir: `runs/${id}`, task, pipeline, trigger: opts.trigger ?? 'auto', started: Date.now(), seq: 0, feedback: '',
    metrics: [], events: [], tamper: [], appliedKb: [], decisions: [], disputes: [], stopReason: null, learned: false, kbTouched: [], lastDetails: {}, stoppedAt: null,
  };
  fs.mkdirSync(abs(run.dir), { recursive: true });
  // The task journal links to this report from the start, so it must exist before any link check runs.
  writeReport(run);
  commit(`factory: snapshot before ${id}`);
  task.data.runs = [...task.data.runs, id];
  journal(task, `запуск [[runs/${id}/report|${id}]] (${run.trigger})${opts.from ? ` с этапа ${opts.from}` : ''}`);
  log(run, `Запуск ${id}: ${task.data.id} «${task.data.title}», конвейер ${task.data.pipeline}`);

  let stage = opts.from ?? pipeline.start;
  try {
    while (stage !== 'END') {
      if (opts.until && stage === opts.until) break;
      const def = pipeline.stages[stage];
      if (!def) throw new Error(`Этап ${stage} не описан в конвейере ${task.data.pipeline}`);
      const outcome = await execStage(run, stage);
      const next = def.on[outcome] ?? (outcome === 'error' ? stage : undefined);
      if (!next) throw new LimitStop(`этап «${stage}» вернул исход «${outcome}», для которого нет перехода`);
      stage = next;
      task.data.phase = stage;
      saveTask(task);
      if (opts.single) break;
    }
    if (stage === 'END') task.data.status = 'done';
  } catch (e) {
    run.stopReason = e instanceof Error ? e.message : String(e);
    task.data.status = 'stopped';
    task.data.stopped_at = run.stoppedAt ?? stage;
    log(run, `⛔ Остановка: ${run.stopReason.split('\n')[0]}`);
    journal(task, `⛔ остановлено: ${run.stopReason.split('\n')[0]}`);
  }
  // A failed run is a lesson too: run the retrospective unless it already ran.
  if (!opts.single && !opts.until && !run.learned && pipeline.stages.learn && !(e2eSkipLearn())) {
    try {
      await execStage(run, 'learn');
    } catch (e) {
      log(run, `ретроспектива не выполнена: ${String(e)}`);
    }
  }
  if (run.stopReason) {
    // The retrospective ran after the stop; the task stays stopped at the stage that failed.
    task.data.status = 'stopped';
    task.data.phase = task.data.stopped_at ?? task.data.phase;
  }
  saveTask(task);
  writeReport(run);
  writeSummary();
  commit(`factory: ${id} ${task.data.id} ${task.data.status}`);
  log(run, `Готово: ${task.data.status}. Отчёт ${run.dir}/report.md · всего ${fmtMs(Date.now() - run.started)}`);
  return run;
}

const e2eSkipLearn = (): boolean => process.env.FACTORY_SKIP_LEARN === '1';

// ---------- metrics & reports ----------

function totals(ms: StageMetric[]): { in: number; out: number; cacheRead: number; cacheWrite: number; turns: number } {
  const t = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  for (const m of ms) for (const c of m.calls) {
    t.in += c.inputTokens; t.out += c.outputTokens; t.cacheRead += c.cacheReadTokens; t.cacheWrite += c.cacheWriteTokens; t.turns += c.numTurns;
  }
  return t;
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function writeMetrics(run: Run): void {
  const byStage: Record<string, { iterations: number; durationMs: number; tokens: ReturnType<typeof totals> }> = {};
  for (const m of run.metrics) {
    const s = (byStage[m.stage] ??= { iterations: 0, durationMs: 0, tokens: totals([]) });
    s.iterations++;
    s.durationMs += m.durationMs;
    s.tokens = totals(run.metrics.filter((x) => x.stage === m.stage));
  }
  writeText(`${run.dir}/metrics.json`, `${JSON.stringify({ run: run.id, task: run.task.data.id, pipeline: run.task.data.pipeline, trigger: run.trigger, started: new Date(run.started).toISOString(), durationMs: Date.now() - run.started, status: run.task.data.status, stopReason: run.stopReason, totals: totals(run.metrics), byStage, stages: run.metrics }, null, 2)}\n`);
}

function writeReport(run: Run): void {
  writeMetrics(run);
  const t = totals(run.metrics);
  const order: string[] = [];
  for (const m of run.metrics) if (!order.includes(m.stage)) order.push(m.stage);
  const rows = order.map((s) => {
    const ms = run.metrics.filter((m) => m.stage === s);
    const tt = totals(ms);
    return `| ${s} | ${ms[0].kind} | ${ms.length} | ${fmtMs(ms.reduce((a, m) => a + m.durationMs, 0))} | ${k(tt.in + tt.cacheRead + tt.cacheWrite)} / ${k(tt.out)} | ${ms.map((m) => m.outcome).join(' → ')} |`;
  });
  const kbApplied = run.appliedKb.length ? run.appliedKb.map((a) => `- этап **${a.stage}** применил ${a.ids.map((id) => `[[kb/${kbFile(id)}|${id}]]`).join(', ')}`).join('\n') : '- нет';
  const report = `# Отчёт запуска ${run.id}

Задача: ${taskLink(run.task)} · конвейер **${run.task.data.pipeline}** · запуск: ${run.trigger}
Итог: **${run.task.data.status}**${run.stopReason ? `\n\nПричина остановки:\n\n\`\`\`\n${truncate(run.stopReason, 3000)}\n\`\`\`` : ''}

Время пайплайна: **${fmtMs(Date.now() - run.started)}** · AI-шагов (turns): ${t.turns} · токены вход/выход: ${k(t.in + t.cacheRead + t.cacheWrite)} / ${k(t.out)} (из них кэш: чтение ${k(t.cacheRead)}, запись ${k(t.cacheWrite)})
## Этапы

| Этап | Тип | Итераций | Время | Токены in/out | Исходы |
|---|---|---|---|---|---|
${rows.join('\n')}

Подробно по каждой попытке: \`stages/\` (prompt.md, transcript.jsonl, result.json, outcome.md), машиночитаемо — \`metrics.json\`.

## Решения, принятые в запуске

${run.decisions.length ? run.decisions.map((d) => `- [[decisions/${run.task.data.scope}#${d}|${d}]]`).join('\n') : '- нет'}

## Споры по тестам

${run.disputes.length ? run.disputes.map((d) => `- ${d}`).join('\n') : '- нет'}

## Защита тестов и платформы

${run.tamper.length ? run.tamper.map((d) => `- ${d}`).join('\n') : '- нарушений не было'}

## База знаний

Применено в этом запуске:
${kbApplied}

Изменено ретроспективой: ${run.kbTouched.length ? run.kbTouched.map((id) => `[[kb/${kbFile(id)}|${id}]]`).join(', ') : 'ничего'} · дифф: \`kb-diff.patch\`
`;
  writeText(`${run.dir}/report.md`, report);
}

function kbFile(id: string): string {
  const f = listFiles('kb').find((x) => x.includes(`${id}-`));
  return f ? f.slice(3).replace(/\.md$/, '') : id;
}

function writeSummary(): void {
  const rows: string[] = [];
  if (!exists('runs')) return;
  for (const d of fs.readdirSync(abs('runs')).filter((x) => /^r-\d+/.test(x)).sort()) {
    const p = `runs/${d}/metrics.json`;
    if (!exists(p)) continue;
    const m = JSON.parse(readText(p)) as { task: string; pipeline: string; trigger: string; status: string; durationMs: number; totals: ReturnType<typeof totals>; byStage: Record<string, { iterations: number }> };
    const iters = Object.entries(m.byStage).filter(([s]) => ['spec', 'spec_update', 'tests', 'tests_update', 'implement', 'review', 'docs', 'dispute'].includes(s)).map(([s, v]) => `${s}×${v.iterations}`).join(' ');
    rows.push(`| [[runs/${d}/report\\|${d}]] | ${m.task} | ${m.pipeline} | ${m.trigger} | ${m.status} | ${fmtMs(m.durationMs)} | ${iters} | ${k(m.totals.in + m.totals.cacheRead + m.totals.cacheWrite)} / ${k(m.totals.out)} |`);
  }
  writeText('runs/summary.md', `# Сводка по запускам\n\nОбновляется оркестратором после каждого запуска.\n\n| Запуск | Задача | Конвейер | Кто запустил | Итог | Время | Итерации AI-этапов | Токены in/out |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
}

// ---------- CLI ----------

function gameTasks(scope: string): Task[] {
  return listTasks().filter((t) => t.data.scope === scope);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const untilIdx = argv.indexOf('--until');
  // --until <stage>: run the chain up to (not including) that stage, e.g. to stop before implement and do it by hand.
  const until = untilIdx >= 0 ? argv.splice(untilIdx, 2)[1] : undefined;
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'platform': {
      const specPath = args[0] ?? 'specs/platform.md';
      const existing = gameTasks('platform').find((t) => t.data.type === 'platform');
      if (existing?.data.status === 'done') throw new Error(`Платформа уже создана задачей ${existing.data.id} и заморожена.`);
      const task = existing ?? createTask({ type: 'platform', pipeline: 'platform', scope: 'platform', title: 'Платформа', phase: 'spec' }, readText(specPath), [`Входное описание: \`${specPath}\``, 'Спецификация: [[platform/spec]]', 'Решения: [[decisions/platform]]']);
      await runPipeline(task, { from: existing ? existing.data.phase : undefined, until });
      break;
    }
    case 'new': {
      const specPath = args[0];
      if (!specPath || !exists(specPath)) throw new Error('Укажи описание игры: node factory/run.ts new specs/<game>.md');
      if (!exists('.factory/platform.lock.json')) throw new Error('Сначала создай платформу: node factory/run.ts platform');
      const id = specPath.split('/').pop()!.replace(/\.md$/, '');
      if (exists(`games/${id}`)) throw new Error(`Игра ${id} уже существует. Для изменений: feedback или decide.`);
      const text = readText(specPath);
      const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? id;
      const task = createTask({ type: 'new-game', pipeline: 'new-game', scope: id, title, phase: 'scaffold' }, text, [`Входное описание: \`${specPath}\``, `Спецификация: [[games/${id}/spec]]`, `Решения: [[decisions/${id}]]`, `Документация: [[games/${id}/README]]`]);
      await runPipeline(task, { until });
      break;
    }
    case 'feedback': {
      const [game, file] = args;
      if (!game || !file || !exists(file)) throw new Error('node factory/run.ts feedback <game> <feedback.md>');
      if (!exists(`games/${game}`)) throw new Error(`Игры ${game} нет`);
      const parent = gameTasks(game).find((t) => t.data.type === 'new-game');
      const task = createTask({ type: 'feedback', pipeline: 'feedback', scope: game, title: `Доработка ${game} по замечаниям`, phase: 'triage', parent: parent?.data.id }, `Замечания (\`${file}\`):\n\n${readText(file)}`, [`Родительская задача: ${parent ? taskLink(parent) : '—'}`, `Спецификация: [[games/${game}/spec]]`, `Решения: [[decisions/${game}]]`]);
      await runPipeline(task);
      break;
    }
    case 'decide': {
      const [scope, decisionId, ...rest] = args;
      const value = rest.join(' ').trim();
      if (!scope || !decisionId || !value) throw new Error('node factory/run.ts decide <game> D-NNN "<новое решение>"');
      const parent = gameTasks(scope).find((t) => t.data.type === 'new-game');
      const task = createTask({ type: 'decision', pipeline: 'decision', scope, title: `Изменение решения ${decisionId} (${scope})`, phase: 'apply_decision', parent: parent?.data.id, decision: { id: decisionId, value } }, `Человек меняет решение [[decisions/${scope}#${decisionId}|${decisionId}]] на: **${value}**`, [`Родительская задача: ${parent ? taskLink(parent) : '—'}`, `Решения: [[decisions/${scope}]]`]);
      await runPipeline(task);
      break;
    }
    case 'stage': {
      const [taskId, stage] = args;
      const task = findTask(taskId);
      if (!config.pipelines[task.data.pipeline].stages[stage]) throw new Error(`В конвейере ${task.data.pipeline} нет этапа ${stage}`);
      await runPipeline(task, { from: stage, single: true, trigger: 'manual' });
      break;
    }
    case 'resume': {
      const task = findTask(args[0]);
      if (task.data.status === 'stopped') {
        // A fresh resume restarts from the stage that hit the limit, with fresh attempt counters.
        task.data.rounds = {};
        task.data.phase = task.data.stopped_at ?? task.data.phase;
      }
      await runPipeline(task, { from: task.data.phase, until });
      break;
    }
    case 'status': {
      for (const t of listTasks()) console.log(`${t.data.id.padEnd(9)} ${t.data.status.padEnd(12)} ${t.data.phase.padEnd(14)} ${t.data.title}${t.data.needs_human?.length ? `  ⚑ ждёт решения: ${t.data.needs_human.join(', ')}` : ''}`);
      break;
    }
    case 'games': {
      // Game ids are folder names under games/; the same id is used by feedback and decide.
      const ids = exists('games') ? fs.readdirSync(abs('games')).filter((d) => exists(`games/${d}/manifest.json`)).sort() : [];
      if (!ids.length) console.log('Игр пока нет. Создать: node factory/run.ts new specs/<game>.md');
      for (const id of ids) {
        const manifest = JSON.parse(readText(`games/${id}/manifest.json`)) as { title?: string };
        const tasks = gameTasks(id);
        const tests = listFiles(`games/${id}/tests`).filter((f) => f.endsWith('.test.ts')).map((f) => readText(f).match(/^\s*(?:it|test)(?:\.\w+)?\(/gm)?.length ?? 0).reduce((a, b) => a + b, 0);
        const decisions = exists(`decisions/${id}.md`) ? (readText(`decisions/${id}.md`).match(/^## D-\d+/gm) ?? []).length : 0;
        const waiting = tasks.flatMap((t) => t.data.needs_human ?? []);
        console.log(`${id.padEnd(10)} ${(manifest.title ?? id).padEnd(16)} тестов ${String(tests).padEnd(4)} решений ${String(decisions).padEnd(4)} задачи ${tasks.map((t) => `${t.data.id}(${t.data.status})`).join(', ')}${waiting.length ? `  ⚑ ждёт решения: ${waiting.join(', ')}` : ''}`);
      }
      if (ids.length) console.log(`\nURL игры: http://localhost:4000/games/<id>/ · доработка: feedback <id> <файл> · решение: decide <id> D-NNN "<значение>"`);
      break;
    }
    case 'summary':
      writeSummary();
      console.log(readText('runs/summary.md'));
      break;
    default:
      console.log(readText('factory/run.ts').split('\n').slice(0, 10).join('\n'));
  }
}

main().catch((e) => {
  console.error(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

