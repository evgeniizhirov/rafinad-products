# Implementation notes (решения по модулям ТЗ)

Короткий журнал фактических решений, чтобы следующий агент не восстанавливал контекст по коду. Модули — по `docs/tz/prompts/P01…P10`. Ветки сложены стопкой: каждая следующая начинается от предыдущей, PR открыт с базой на предыдущую ветку.

## P01 — права голосования (FR-04) · ветка `claude/01-votes-acl`

- Дефектов нет. `tests/votes-acl.test.ts` покрывает матрицу ролей (см. описание PR #3).
- Членство перечитывается из `department_memberships` на каждом запросе (`loadSessionUser`), поэтому изменения действуют сразу. Будущие API-ключи обязаны проходить через тот же `perms.voteFor`.

## P02 — основа модели задач (FR-02, FR-07 база, FR-10) · ветка `claude/02-task-foundation`

**Миграция `0003_task_foundation.sql`** (аддитивная), новые столбцы `features`:

| Столбец | Значение |
| --- | --- |
| `task_kind` | `planned` / `bug` / `operational_improvement`, по умолчанию `planned` |
| `is_product_internal` | 0/1 — скрытая задача Product. **Не связана** с `visibility` (`internal` = видна всем сотрудникам) |
| `initiator_type`, `initiator_user_id`, `initiator_department_id`, `initiator_name` | инициатор; `initiator_name` хранит свободный текст или снимок имени пользователя/отдела на момент выбора |

**Скрытые задачи — одно правило в `worker/lib/world.ts`:**
- `loadWorld(db, viewer, { includeInternal })` вырезает скрытые задачи и **все ссылающиеся строки**: голоса, оценки, теги, офферы, связи, релизы. Поэтому они не попадают ни в один список, счётчик, граф или агрегат — даже как плейсхолдер «скрыта».
- `includeInternal: true` действует только для product/admin и используется только в `GET /api/features` (`?internal=1|all`) и в карточке `GET /api/features/:ref`.
- Общие виды (overview, roadmap, priorities, releases, epics, offers, graph, planning) не показывают скрытые задачи никому, включая Product.
- `resolveFeature()` отдаёт 404 «Задача не найдена» всем, кроме product/admin. Это закрывает все write-маршруты (голоса, комментарии, связи, оценки, размещение).
- История карточки для не-editor отфильтровывает записи `relation_added`/`relation_removed`, где упоминается id скрытой задачи.
- `canSeeFeature(viewer, f)` — правило для одной задачи; `visibleFeatures(w, viewer, 'general'|'internal'|'all')`.
- Раскрытие (`is_product_internal` 1→0) требует `confirm_disclose: true`, иначе 409 `confirm_disclose`; изменение идёт в аудит.
- Скрыть задачу, которая входит в релиз, нельзя (400).

**Тип работы:**
- `isPlannable(f)` = `planned` и не скрытая.
- Только такие задачи участвуют в планировщике (`plannerInput`, `currentLoad`, `versions` плана), в ёмкости (`overloadFor`), в размещении по периоду (иначе 400) и в составе релиза (новые добавления — 400).
- Плановую задачу из релиза нельзя превратить в баг (400). Баг в плановую — можно.
- Баги видны в общих списках: это реальная работа. Фильтр — `?kind=bug,operational_improvement`.

**Инициатор:**
- API: `initiator: null | {type:'free_text', name} | {type:'user', user_id} | {type:'department', department_id}`.
- DTO для сотрудников: `initiator: {type, name, user_id?/department_id?, inactive?}`. Гостям поле не отдаётся.
- Фильтр `?initiator=user:<id>|department:<id>|text:<подстрока>|none`.
- `GET /api/users/directory` (product/admin) — только `id` и `name` активных пользователей, без email.

**UI:**
- Форма задачи: тип работы, «Внутренняя задача продукта», инициатор в трёх формах.
- Карточка: тип и инициатор. В списках — бейджи «Баг» / «Оперативная доработка» / «Внутренняя продукта».
- Бэклог: фильтры типа, «Внутренние задачи продукта» (только product/admin), инициатора по отделу.

**Локальные миграции:** `scripts/sqlite-d1.ts → migrate()` теперь ведёт `d1_migrations` и применяет только недостающие миграции. `npm run dev:node` обновляет существующую `.local/dev.sqlite`. Проверено на копии с 61 задачей: все получили `planned`.

**Не входит:** процесс багов (срочность, состояние, даты устранения) — P05; спринты — P03.
