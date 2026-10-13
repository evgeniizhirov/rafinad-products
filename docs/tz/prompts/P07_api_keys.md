# Готовое задание Codex: P07 — персональные API-ключи и серверная авторизация

**Скопируй ниже весь текст в новое задание Codex и приложи `00_MASTER_TZ.md`.**

---

Реализуй этап **P07 — персональные API-ключи и серверная авторизация** в GitHub-репозитории `evgeniizhirov/rafinad-products`.

**Ветка:** `codex/07-api-keys`.  
**Требования:** FR-01, FR-04, FR-02 в `00_MASTER_TZ.md`.

**Репозиторий:** `evgeniizhirov/rafinad-products` (Cloudflare Workers/D1, React/TypeScript).  
**Источник бизнес-требований:** приложенный `00_MASTER_TZ.md` (особенно указанные ниже FR и разделы 1, 3, 4, 8).  
**Первое действие:** проверить `git status`, актуальный HEAD `main`, README и связанные тесты. Отдельный checkout/worktree; не вмешиваться в рабочий каталог другого ИИ.  
**Дисциплина:** один модуль — одна ветка/PR; обратная совместимость и аддитивные D1-миграции; проверка ролей на сервере; аудит; оптимистические версии; реальные тесты; не переходить автоматически к следующему этапу.

**В конце:** показать изменённые файлы, решения по контрактам, результаты `npm run typecheck`, `npm test`, `npm run build`, результаты теста миграций на локальных базах, номер/URL PR. Если что-то не запускал — написать почему. Без merge, `wrangler deploy` и remote D1 migrations. Не публиковать ключи и иные секреты.

## Конкретная работа

1. Работай после merge P02; независим от календаря/бюджета. Изучи `worker/lib/auth.ts`, `worker/index.ts`, `worker/routes/auth.ts`, `worker/lib/http.ts`, schema users/sessions, roles/memberships и аудит. Не ломай текущие cookie sessions и CSRF-check по Origin.
2. Введи personal API keys: name, owner, hashed token with prefix, minimal granular scopes (`tasks:read`, `tasks:create`, `tasks:update`, `priorities:write-own`, `exports:read`), expiry/revocation/last-used. Plaintext токен показывать один раз. Секрет в базе не хранить и не логировать.
3. `Authorization: Bearer` поддерживается на текущих API middleware; актуальная учётка, role, membership, `must_change_password` и visibility проверяются **каждый раз**. Effective permissions=RBAC ∩ scopes. Отзыв/блокировка немедленно работают. Обновлять аудит с `api_key_id` без значения токена.
4. API и UI управления своими ключами, admin revocation. Простое руководство как настроить Claude Code/Codex/интеграцию без пароля.
5. Отдельно проверь: запрет department_lead создавать задачи если текущая роль не даёт; чужие оценки; скрытые задачи; invalid/expired/revoked key; idempotent updates/429, отсутствие раскрытия ключа после создания.
6. По необходимости OAuth не вводить; не подменять одним общим секретом для всех пользователей.

## Критерии приёмки

- Создание задачи `product`-ключом со scope проходит; без scope или права role — 403.
- Только собственные dept votes, актуальные Membership.
- Revoked/expired/disabled user немедленно не аутентифицируются.
- Неавторизованный, department_lead не видят скрытые Product задачи.
- Cookie-login продолжает работать; API-key никогда не попадает в логи/БД в открытом виде.

## Финальная форма ответа Codex

- Реальная ветка и commit SHA / PR URL.
- Что изменено: D1 / backend / frontend / tests.
- Скриншоты или команда для ручной проверки значимого UI (если применимо).
- Вывод реальных проверок с exit-code; явно указать непроверенное.
- Миграции и предостережения о продакшене.
- Что должен знать агент, выполняющий следующий этап.
