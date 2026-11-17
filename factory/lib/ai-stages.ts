// AI stages: what each agent gets (prompt, writable paths, output schema) and how its
// structured output is turned into an OUTCOME. Outcomes are computed here from fields,
// e.g. the review verdict is recomputed from findings, not taken from the agent's word.
import { runAgent, type AgentUsage } from './claude.ts';
import { decisionSection, kbForAgent, scopeDir, type DecisionInput, type KbUpsert, type Task } from './store.ts';
import { exists, readTextIfExists } from './util.ts';

export interface AiCtx {
  task: Task;
  scope: string;
  dir: string;
  runId: string;
  stageDir: string;
  stage: string;
  feedback: string; // from the previous stage (failures, findings, dispute answer)
  maxTurns: Record<string, number>;
  reviewPending: string[] | null;
  previousReview: string; // findings of the previous review round, so reviewers do not move the goalposts
  runEvents: string; // condensed log for the librarian
  onProgress: (agent: string, line: string) => void;
}

export interface AiCall {
  agent: string;
  usage: AgentUsage;
  ok: boolean;
  error: string | null;
}

export interface AiResult {
  outcome: string;
  details: string;
  calls: AiCall[];
  appliedKb: string[];
  decisions: DecisionInput[]; // recorded by the orchestrator after the write-protection check
  dispute?: { test: string; reason: string; proposal: string };
  kbUpserts?: KbUpsert[];
  reviewFailed?: string[];
}

// ---------- schemas ----------

const decisionsSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: { question: { type: 'string' }, assumption: { type: 'string' }, rationale: { type: 'string' } },
    required: ['question', 'assumption', 'rationale'],
  },
};
const appliedKb = { type: 'array', items: { type: 'string' }, description: 'IDs of knowledge-base entries you actually applied, e.g. ["KB-002"]' };

const SCHEMAS: Record<string, object> = {
  analyst: {
    type: 'object',
    properties: { outcome: { enum: ['done'] }, summary: { type: 'string' }, scenarios: { type: 'array', items: { type: 'string' } }, decisions: decisionsSchema, applied_kb: appliedKb },
    required: ['outcome', 'summary', 'scenarios', 'decisions', 'applied_kb'],
  },
  'test-writer': {
    type: 'object',
    properties: { outcome: { enum: ['done'] }, summary: { type: 'string' }, covered_scenarios: { type: 'array', items: { type: 'string' } }, decisions: decisionsSchema, applied_kb: appliedKb },
    required: ['outcome', 'summary', 'covered_scenarios', 'decisions', 'applied_kb'],
  },
  'test-writer:dispute': {
    type: 'object',
    properties: { outcome: { enum: ['accepted', 'rejected'] }, reason: { type: 'string' }, applied_kb: appliedKb },
    required: ['outcome', 'reason', 'applied_kb'],
  },
  developer: {
    type: 'object',
    properties: {
      outcome: { enum: ['done', 'dispute'] },
      summary: { type: 'string' },
      dispute: {
        type: 'object',
        properties: { test: { type: 'string' }, reason: { type: 'string' }, proposal: { type: 'string' } },
        required: ['test', 'reason', 'proposal'],
      },
      decisions: decisionsSchema,
      applied_kb: appliedKb,
    },
    required: ['outcome', 'summary', 'decisions', 'applied_kb'],
  },
  reviewer: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: { severity: { enum: ['blocking', 'minor'] }, file: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } },
          required: ['severity', 'file', 'text'],
        },
      },
      summary: { type: 'string' },
      applied_kb: appliedKb,
    },
    required: ['findings', 'summary', 'applied_kb'],
  },
  'docs-writer': {
    type: 'object',
    properties: { outcome: { enum: ['done'] }, summary: { type: 'string' }, applied_kb: appliedKb },
    required: ['outcome', 'summary', 'applied_kb'],
  },
  triage: {
    type: 'object',
    properties: {
      outcome: { enum: ['behavior', 'ui_only'] },
      items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, kind: { enum: ['behavior', 'ui_only'] }, rationale: { type: 'string' } }, required: ['text', 'kind', 'rationale'] } },
      summary: { type: 'string' },
    },
    required: ['outcome', 'items', 'summary'],
  },
  librarian: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Existing KB id to update; omit for a new entry' },
            title: { type: 'string' },
            stages: { type: 'array', items: { enum: ['analyst', 'test-writer', 'developer', 'reviewer-rules', 'reviewer-integrity', 'docs-writer', 'triage', 'all'] } },
            problem: { type: 'string' },
            cause: { type: 'string' },
            rule: { type: 'string' },
          },
          required: ['title', 'stages', 'problem', 'cause', 'rule'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['entries', 'summary'],
  },
};

// ---------- prompt ----------

function kbBlock(agent: string): string {
  const entries = kbForAgent(agent);
  if (!entries.length) return 'База знаний для твоей роли пока пуста.';
  return entries.map((e) => `### ${e.id} (из запуска ${e.created_by_run})\n${e.body}`).join('\n\n');
}

/** Paths an agent may write on its stage. Used by the hook (layer 1) and the post-stage revert (layer 3). */
export function writablePaths(scope: string, agent: string): { allow: string[]; deny: string[] } {
  const d = scopeDir(scope);
  const platform = scope === 'platform';
  switch (agent) {
    case 'analyst':
      return { allow: [`${d}/spec.md`, `${d}/docs/**`], deny: [] };
    case 'test-writer':
      return { allow: [`${d}/tests/**`], deny: [] };
    case 'developer':
      return platform
        ? { allow: ['platform/**'], deny: ['platform/tests/**', 'platform/spec.md'] }
        : { allow: [`${d}/server/**`, `${d}/ui/**`, `${d}/manifest.json`], deny: [] };
    case 'docs-writer':
      return platform
        ? { allow: ['platform/**'], deny: ['platform/tests/**', 'platform/spec.md'] }
        : { allow: [`${d}/README.md`, `${d}/docs/**`, `${d}/server/**`, `${d}/ui/**`], deny: [] };
    default:
      return { allow: [], deny: [] };
  }
}

function header(ctx: AiCtx, agent: string, mode: string, allow: string[]): string {
  const t = ctx.task;
  const human = t.data.decision ? `\n## Решение человека (старше спецификации и тестов)\n\n${decisionSection(ctx.scope, t.data.decision.id) ?? ''}\nНовое значение: **${t.data.decision.value}**\n` : '';
  return [
    `# Этап «${ctx.stage}» · роль ${agent}${mode ? ` (${mode})` : ''}`,
    '',
    `Задача: \`${t.file}\` (${t.data.id}, тип ${t.data.type}). Прочитай её целиком — там описание и журнал.`,
    `Область: \`${ctx.dir}/\` · спецификация: \`${ctx.dir}/spec.md\` · журнал решений: \`decisions/${ctx.scope}.md\``,
    `Конвенции проекта: \`docs/conventions.md\` (обязательно). Контракт платформы: \`platform/spec.md\`${exists('platform/sdk/types.ts') ? ', `platform/sdk/types.ts`, `platform/testkit/`' : ''}.`,
    '',
    `Можно писать только в: ${allow.length ? allow.map((a) => `\`${a}\``).join(', ') : 'никуда (этап только читает)'}. Запись в другие места техническим образом заблокирована.`,
    'Человек в этом запуске не участвует: ничего не спрашивай. Не хватает информации — прими разумное допущение и верни его в поле `decisions`.',
    human,
    '## База знаний (уроки прошлых запусков)',
    '',
    kbBlock(agent),
    '',
    'Если применил запись — укажи её ID в `applied_kb`.',
    '',
  ].join('\n');
}

function taskInstruction(ctx: AiCtx, agent: string, mode: string): string {
  const fb = ctx.feedback ? `\n## Вход от предыдущего этапа\n\n${ctx.feedback}\n` : '';
  const platform = ctx.scope === 'platform';
  switch (`${agent}:${mode}`) {
    case 'analyst:':
      return `## Что сделать\n\nНапиши \`${ctx.dir}/spec.md\` по описанию из задачи: коротко, без пересказа платформы — ссылайся на неё вики-ссылками. Сценарии приёмки на Gherkin с ID ${platform ? 'PL-N' : 'SC-N'}. Все недостающие детали — допущения в \`decisions\`.${fb}`;
    case 'analyst:update':
      return `## Что сделать\n\nОбнови \`${ctx.dir}/spec.md\` по замечаниям или решению человека из задачи. Изменённые сценарии сохраняют ID, новые получают следующий номер, удалённые помечаются «удалён» (номер не переиспользуется).${fb}`;
    case 'test-writer:':
      return `## Что сделать\n\nПо спецификации напиши приёмочные тесты в \`${ctx.dir}/tests/\` ДО реализации. Каждый сценарий — минимум один тест, ID сценария в названии теста. Кода реализации не читай и под него не подстраивайся: ${platform ? 'реализации ещё нет' : 'сейчас там заглушка NOT_IMPLEMENTED, тесты на ней должны падать'}.${fb}`;
    case 'test-writer:update':
      return `## Что сделать\n\nОбнови тесты в \`${ctx.dir}/tests/\` под изменённую спецификацию. Тесты меняешь только ты.${fb}`;
    case 'test-writer:dispute':
      return `## Спор разработчика по тесту\n\nРазработчик считает, что тест нельзя выполнить по техническим причинам:\n\n${ctx.feedback}\n\nРазбери по спецификации. Если разработчик прав — исправь тест сам и верни outcome "accepted". Если тест верен — ничего не меняй и верни "rejected" с обоснованием.`;
    case 'developer:':
      return `## Что сделать\n\nРеализуй ${platform ? 'платформу' : 'игру'} так, чтобы проходили заблокированные тесты в \`${ctx.dir}/tests/\`. Тесты менять нельзя. Если тест невозможно выполнить по технической причине — верни outcome "dispute" с полем dispute (test, reason, proposal), не обходи тест. Проверяй себя: \`pnpm exec vitest run ${ctx.dir}/tests\` и \`pnpm exec tsc --noEmit -p tsconfig.json\`.${fb}`;
    case 'docs-writer:':
      return `## Что сделать\n\nНапиши документацию кода: \`${ctx.dir}/README.md\` (устройство, состояние раунда, как определяется результат, вики-ссылки на спеку, решения и платформу) и TSDoc-комментарий над каждым \`export\` в коде. Логику не меняй.${fb}`;
    case 'triage:':
      return '## Что сделать\n\nРазбери замечания из задачи. Для каждого определи: меняет ли оно поведение игры (правила, выплаты, исходы, допустимые действия) — "behavior", или только интерфейс/анимацию/тексты — "ui_only". Общий outcome — "behavior", если хотя бы одно замечание меняет поведение.';
    case 'librarian:':
      return `## Что сделать\n\nЭто ретроспектива запуска. Ниже события запуска. Найди проблемы, их причины и правило, которое помешает им повториться. Не дублируй существующие записи — обнови их (поле id). Пиши только то, что реально пригодится следующим запускам; пустой список — нормальный ответ.\n\n## События запуска\n\n${ctx.runEvents}`;
    default:
      return fb;
  }
}

// ---------- execution ----------

async function call(ctx: AiCtx, agent: string, mode: string, schemaKey: string, extra = ''): Promise<{ out: Record<string, unknown> | null; call: AiCall }> {
  const w = writablePaths(ctx.scope, agent);
  const prompt = `${header(ctx, agent, mode, w.allow)}\n${extra || taskInstruction(ctx, agent, mode)}`;
  const r = await runAgent({
    agent,
    prompt,
    schema: SCHEMAS[schemaKey],
    stageDir: agent.startsWith('reviewer') ? `${ctx.stageDir}/${agent}` : ctx.stageDir,
    allowWrite: w.allow,
    denyWrite: w.deny,
    readOnly: w.allow.length === 0,
    maxTurns: ctx.maxTurns[agent] ?? 40,
    onProgress: (l) => ctx.onProgress(agent, l),
  });
  return { out: r.output, call: { agent, usage: r.usage, ok: r.ok, error: r.error } };
}

const decisionInputs = (out: Record<string, unknown> | null): DecisionInput[] =>
  ((out?.decisions as DecisionInput[]) ?? []).filter((d) => d.question && d.assumption);

const kbIds = (out: Record<string, unknown> | null): string[] => ((out?.applied_kb as string[]) ?? []).filter((x) => /^KB-\d+$/.test(x));

export async function runAiStage(ctx: AiCtx, spec: string): Promise<AiResult> {
  const [, agent, mode = ''] = spec.split(':');

  if (agent === 'reviewers') {
    const all = ['reviewer-rules', 'reviewer-integrity'];
    const pending = ctx.reviewPending?.length ? ctx.reviewPending : all;
    const repeat = ctx.previousReview
      ? `## Повторный круг ревью\n\nЗамечания прошлого круга:\n\n${ctx.previousReview}\n\nПроверь, что прежние блокирующие замечания исправлены, и нет регрессий. Новое блокирующее замечание допустимо только если его вызвала правка или оно нарушает спецификацию, контракт платформы или конвенции. Всё остальное новое — minor.\n\n## Вход от предыдущего этапа\n\n${ctx.feedback}`
      : `## Что сделать\n\nПроведи ревью изменений по своей роли. Найди все блокирующие проблемы за один проход.\n\n## Вход от предыдущего этапа\n\n${ctx.feedback}`;
    const results = await Promise.all(pending.map((a) => call(ctx, a, '', 'reviewer', repeat)));
    const failed: string[] = [];
    const lines: string[] = [];
    let n = 0;
    const applied: string[] = [];
    results.forEach((r, i) => {
      const name = pending[i];
      applied.push(...kbIds(r.out));
      if (!r.call.ok || !r.out) {
        failed.push(name);
        lines.push(`### ${name}: ошибка запуска — ${r.call.error}`);
        return;
      }
      const findings = (r.out.findings as Array<{ severity: string; file: string; line?: number; text: string }>) ?? [];
      const blocking = findings.filter((f) => f.severity === 'blocking');
      // Verdict is computed by the orchestrator from the findings, not taken from the agent.
      if (blocking.length) failed.push(name);
      lines.push(`### ${name}: ${blocking.length ? 'НЕ пройдено' : 'пройдено'} (${findings.length} замечаний)`);
      for (const f of findings) lines.push(`- R-${++n} [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.text}`);
    });
    return { outcome: failed.length ? 'fail' : 'pass', details: lines.join('\n'), calls: results.map((r) => r.call), appliedKb: applied, decisions: [], reviewFailed: failed };
  }

  const schemaKey = mode === 'dispute' ? 'test-writer:dispute' : agent;
  const { out, call: c } = await call(ctx, agent, mode, schemaKey);
  const base = { calls: [c], appliedKb: kbIds(out) };
  if (!c.ok || !out) return { ...base, outcome: 'error', details: c.error ?? 'нет результата', decisions: [] };

  const decisions = decisionInputs(out);
  const outcome = String(out.outcome ?? 'done');
  const summary = String(out.summary ?? out.reason ?? '');

  if (agent === 'developer' && outcome === 'dispute') {
    const d = out.dispute as { test: string; reason: string; proposal: string } | undefined;
    if (!d) return { ...base, outcome: 'done', details: `${summary}\n(dispute без деталей — считаю обычным завершением)`, decisions };
    return { ...base, outcome: 'dispute', details: `Тест: ${d.test}\nПричина: ${d.reason}\nПредложение: ${d.proposal}`, decisions, dispute: d };
  }
  if (agent === 'librarian') {
    return { ...base, outcome: 'done', details: summary, decisions, kbUpserts: (out.entries as KbUpsert[]) ?? [] };
  }
  if (agent === 'triage') {
    const items = (out.items as Array<{ text: string; kind: string; rationale: string }>) ?? [];
    // The branch is chosen from the per-item classification, not from a free-form answer.
    const computed = items.some((i) => i.kind === 'behavior') ? 'behavior' : 'ui_only';
    return { ...base, outcome: computed, details: items.map((i) => `- [${i.kind}] ${i.text} — ${i.rationale}`).join('\n'), decisions };
  }
  return { ...base, outcome, details: summary, decisions };
}

export const specExists = (scope: string): boolean => readTextIfExists(`${scopeDir(scope)}/spec.md`) !== null;
