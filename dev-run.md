# dev-workflow — план до первого реального прогона

Статус на 2026-04-18: infrastructure ~95%, real-agent coverage ~20%, end-to-end validated = 0.

**Цель:** за минимальное число шагов дойти до одного успешного live-прогона через ageflow против реального GH issue.

---

## Текущее состояние узлов

| Pipeline | Узел | Статус |
|---|---|---|
| **feature** | plan | ✅ real `defineAgent` (engineering-software-architect, codex) |
| | build | ⚠️ noop |
| | test | ⚠️ noop |
| | verify | ✅ real `defineAgent` (engineering-code-reviewer, codex) |
| | ship | ⚠️ noop |
| **bugfix** | triage | ⚠️ noop |
| | reproduce | ⚠️ noop |
| | fix | ⚠️ noop |
| | test | ⚠️ noop |
| | verify | ✅ real `defineAgent` (testing-reality-checker, codex) |
| | ship | ⚠️ noop |
| **docs** | draft / review / publish | ⚠️ всё noop |
| **release** | bump / publish / changelog / cleanup | ⚠️ всё noop (по спеке — должны стать `defineFunction`) |

**3 из 15 узлов реальные.** Инфраструктура готова: executor, budget tracker, learning hooks, sqlite store, codex runner, 7 ролей в `packages/dev-workflow/roles/`.

---

## PR A — Plumbing (без LLM-стоимости)

### Цель
Убрать dry-stub'ы из worktree helper и вызывать create/remove в `run.ts`. Добавить budget cap.

### Изменения

**`packages/dev-workflow/shared/worktree.ts`**

Заменить console.log-и в `createWorktree` и `removeWorktree` на реальные execa-вызовы:
```ts
await execa("git", ["worktree", "add", path, "-b", branch, base], { cwd: repoRoot });
await execa("git", ["worktree", "remove", path, "--force"], { cwd: repoRoot });
```

**`packages/dev-workflow/run.ts`**

Обернуть executor в try/finally с create/remove worktree:
```ts
const worktree = await createWorktree(REPO_ROOT, issue);
const input: WorkflowInput = { ...otherFields, worktreePath: worktree };
try {
  const result = await executor.run(input);
  // ...
} finally {
  await removeWorktree(REPO_ROOT, issue.number);
  store.close();
}
```

Добавить budget cap:
```ts
const budgetTracker = new BudgetTracker({ maxUsd: 5, onExceeded: "halt" });
```

### Тесты
- Обновить `worktree.test.ts` — mock execa, убедиться что `createWorktree` вызывает git с правильными args
- Smoke: `bun run dev-workflow --dry-run 194` должен по-прежнему работать

### Bump
`@ageflow/dev-workflow` 0.0.7 → 0.0.8 (private)

---

## PR B — Docs pipeline real (первый end-to-end)

### Цель
Сделать docs pipeline работающей от начала до конца. Минимальный контур для проверки `createLearningHooks` + real trace rows + reflection.

### Новая роль

**`packages/dev-workflow/roles/engineering-technical-writer.md`** — ~50 строк, пишет markdown на основе issue body + spec path.

### `packages/dev-workflow/pipelines/docs.ts`

- `draft` → `defineAgent(technical-writer, codex)` — пишет docs на основе issue.body
- `review` → `defineAgent(engineering-code-reviewer, codex)` — gate APPROVED/NEEDS_WORK
- `publish` → `defineFunction` → `git add docs/...` + commit + push + `gh pr create`

### Live-смоук
- Создать тестовый issue "docs: add short usage example to @ageflow/learning README"
- `bun run --filter @ageflow/dev-workflow dev-workflow <N>` (без `--dry-run`)
- Budget cap $3
- Ожидаемый результат: PR открыт, trace в `.ageflow/learning.sqlite` (minimum 3 task_traces)

### Bump
`@ageflow/dev-workflow` 0.0.8 → 0.0.9 (private)

---

## PR C — Feature pipeline real

### Цель
build + test + ship реальные. feature end-to-end валиден.

### `packages/dev-workflow/pipelines/feature.ts`

- `build` → `defineAgent(engineering-senior-developer, codex)` + session (для возможных retry после test FAIL)
- `test` → `defineFunction` — спавнит `bun test` в worktree, возвращает `{passed: boolean, output: string}`
- `ship` → `defineFunction` — `git add .` + commit с conventional-commits title + push + `gh pr create`

### Design-вопрос (надо решить до дispatch)
**Session на `build`**: нужна только если тест FAIL → build агент получает retry с test output в context. Альтернатива: loop-узел с cap=3. Выбор: **session** (проще для MVP, loop — потом если потребуется).

### Live-смоук
- Найти маленький feature issue ($5 cap)
- Цель — чтоб plan → build → test → verify → ship отработали и PR открылся

### Bump
`@ageflow/dev-workflow` 0.0.9 → 0.0.10

---

## PR D — Bugfix pipeline real

### Цель
Самая сложная часть. Session design для fix→test→fix итерации.

### `packages/dev-workflow/pipelines/bugfix.ts`

- `triage` → `defineFunction` (label-classifier — не агент). Возвращает `{severity, affectedPackages}`
- `reproduce` → `defineAgent(senior-developer, codex)` — пишет failing test в worktree
- `fix` → `defineAgent(senior-developer, codex)` + **session continuation от reproduce** — исправляет код, может итерировать при test FAIL
- `test` → `defineFunction` (тот же что в feature)
- `ship` → `defineFunction` (тот же что в feature)

### Design-решение — session chain
`reproduce.session = "bugfix"` и `fix.session = "bugfix"` — continuation. Это проверяет `SessionManager` в executor.

### Live-смоук
- Взять существующий баг ($5-8 cap)
- Успех: PR открыт, failing test → fix → passing test

### Bump
`@ageflow/dev-workflow` 0.0.10 → 0.0.11

---

## PR E — Release pipeline

### Цель
Детерминированные defineFunction узлы. Не агенты.

### `packages/dev-workflow/pipelines/release.ts`

- `bump` → `defineFunction` — обновляет package.json versions по списку changed packages
- `changelog` → `defineFunction` — append секции в `CHANGELOG.md` (или создание)
- `publish` → `defineFunction` — `npm publish` в dependency order (см. таблицу в `ageflow-orchestrator.md`)
- `cleanup` → `defineFunction` — `git tag`, optional worktree remove

### Bump
`@ageflow/dev-workflow` 0.0.11 → 0.0.12

---

## PR F — 10-run retrospective (sub-PR 5 #194)

После 10 реальных прогонов (ожидаем ~3 docs + 5 feature/bugfix + 2 release):

1. Audit `.ageflow/learning.sqlite` — топ failure modes
2. Cross-reference с issues label `from-dogfood`
3. Топ-5 паттернов → roadmap items
4. Reflection-generated skill records → в role prompts

Отдельный docs PR, без кода.

---

## Приоритет / минимальный MVP

Если надо **сегодня** одного live-прогона:

**PR A + PR B = MVP.** ~2-3 часа агентного времени + $3-5 LLM. docs pipeline полностью рабочая, feature/bugfix — следующими подходами.

PR C, D — потом. PR E — когда появится release-процесс, которым хочется пользоваться. PR F — после 10 прогонов.

---

## Design-решения — требуется sign-off

1. **`test` узел = `defineFunction`**, не агент. Детерминированный `bun test` надёжнее чем LLM-парсинг stdout.
2. **`ship` узел = `defineFunction`**, не агент. Механика git/gh не нуждается в LLM.
3. **`fix` использует session** (continuation от reproduce), не loop. Loop добавим позже если session не хватит.
4. **`triage` = defineFunction** (label-classifier), не агент с отдельной ролью. Агенты дороже и для классификации избыточны.
5. **Budget cap по умолчанию = $5**. Переопределяется через `--budget <N>` flag (добавить в `run.ts`).
6. **Runner = только codex** (уже установлено). Claude добавляем позже если потребуется мультиагентные пайплайны.

---

## Открытые вопросы

- Нужен ли `engineering-technical-writer` роль для docs, или переиспользовать `engineering-senior-developer`? (предложение: отдельная, короткая)
- Где хранить шаблоны PR titles/bodies? (предложение: в `shared/pr-templates.ts`, отдельный файл)
- Worktree naming: текущий шаблон `<repo>-wt-<issue>` подходит? Или переместить в `.claude/worktrees/` для консистентности с существующими?
