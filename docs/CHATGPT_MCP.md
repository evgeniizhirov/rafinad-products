# Rafinad Roadmap → ChatGPT через MCP

## Статус и границы проверки

Отдельный проект `mcp/` содержит Worker `rafinad-roadmap-mcp`. Основной Worker, D1, ACL и frontend не изменяются. Подключение к Roadmap идёт только через существующий REST API.

Проверено локально: официальный MCP SDK 2.3.1, Streamable HTTP с протоколами поколения 2025 и 2026, список инструментов, OAuth JWT-проверки, REST-адаптер против настоящего backend на изолированной SQLite-базе. Данные тестов — fixtures, а не production Roadmap. Успех этих тестов **не означает**, что проверены подключение из ChatGPT, внешний OAuth login/PKCE или реальные производственные данные.

Результат локального прогона: 14 MCP-тестов и 123 существующих теста Roadmap прошли; TypeScript обоих проектов и dry-run сборки прошли. Локальный workerd запущен; незаполненная конфигурация проверена HTTP-запросом и возвращает 503. Полный OAuth/REST путь проверен в процессе Node.js, а не на опубликованном Worker.

На 13.10.2026 пользователь сообщил план **Plus**. Наличие Add custom MCP server/Developer mode и разрешение записи в конкретном аккаунте пока не подтверждены. Текущая [инструкция OpenAI](https://developers.openai.com/plugins/deploy/connect-chatgpt) описывает добавление сервера через Plugins и подчёркивает зависимость от политики аккаунта/workspace. Режим записи включён для production MCP конфигурацией `ENABLE_WRITES="true"`; фактическая доступность зависит от OAuth scope `roadmap:write`, роли и scopes персонального ключа Roadmap, а также подтверждений в ChatGPT. Нельзя обещать запись на основании одного названия тарифа.

**Развёрнуто (13.10):** Worker `rafinad-roadmap-mcp` опубликован, переменные OAuth (Auth0) и секрет заданы в Cloudflare. Сборка — Cloudflare Workers Builds из `main` (корень `/mcp`, `pnpm run build` = typecheck + тесты без backend + dry-run, затем `wrangler deploy --keep-vars`). Ранее раскрытый ключ не отозван автоматически — это должен сделать владелец.

## Адрес

Endpoint:

`https://rafinad-roadmap-mcp.ezhirov-es.workers.dev/mcp`

Если адрес изменится, измените `MCP_RESOURCE`, Auth0 API Identifier (audience) и адрес подключения в ChatGPT одновременно.

Discovery: `/.well-known/oauth-protected-resource/mcp` (также поддержан вариант без `/mcp`). Без обязательной конфигурации сервер возвращает 503; без действительного OAuth token `/mcp` возвращает 401.

## Авторизация

Архитектура рассчитана на **одного владельца**: OAuth subject точно сопоставляется с `OWNER_SUBJECT`, а специальный ключ Roadmap принадлежит этому же человеку. Для команды нужна отдельная реализация сопоставления пользователей и ключей. Не добавляйте чужие subject к одному персональному ключу.

Используйте существующий OAuth-провайдер. По [требованиям OpenAI](https://developers.openai.com/plugins/build/auth) нужны discovery, authorization-code flow с PKCE S256, точный redirect URI из интерфейса ChatGPT и привязка токена к resource. Для этой интеграции выбрана предварительная регистрация одного OAuth-клиента. Провайдер должен проверять клиента и redirect URI, требовать PKCE, выдавать токен только разрешённому владельцу и не разрешать обход через другие grants. Не создавайте собственный упрощённый OAuth-сервер.

Конкретный контракт нашего Worker:

| Настройка | Значение |
| --- | --- |
| `MCP_RESOURCE` | Полный HTTPS URL с `/mcp`; ровно это значение в `aud` access token |
| `OAUTH_ISSUER` | Точное значение `iss` провайдера, включая завершающий `/`, если он есть |
| `OAUTH_JWKS_URL` | Доверенный HTTPS URL публичного JWKS провайдера |
| `OAUTH_CLIENT_ID` | ID предварительно зарегистрированного клиента ChatGPT |
| `OWNER_SUBJECT` | Точный `sub` владельца ключа; не email, полученный из запроса |
| `ENABLE_WRITES` | Только строка `true` включает запись; иначе только чтение |
| `RAFINAD_API_KEY` | Только Cloudflare Worker Secret; никогда не переменная в Git |

Worker проверяет подпись ES256/RS256, `iss`, `aud`, `sub`, `exp`, `iat`, `client_id` (или `azp`) и scope на **каждом** запросе. Срок жизни JWT ограничен `OAUTH_MAX_TOKEN_AGE_SECONDS` (300–86400, по умолчанию 86400 — стандартный срок access token Auth0 custom API; прежний жёсткий предел 15 минут отклонял каждый токен Auth0). Неверное значение настройки закрывает сервер (503). Обязательный scope `roadmap:read`; для записи дополнительно `roadmap:write`. Если оба client claims присутствуют, они должны соответствовать настройке. ID token без нужного audience/scopes не подходит.

Настройте провайдер так, чтобы OAuth `resource` превращался в нужный `aud`. Если провайдер требует отдельный `audience` или нестандартный claim scope, настройте его адаптацию до подключения: Worker не ослабляет проверки. Получите `sub` из админ-панели провайдера. OAuth client secret, если он нужен, вводится только в интерфейсе подключения ChatGPT; Worker его не хранит.

Отзыв OAuth refresh token запрещает обновление, но уже выданный JWT может действовать до конца своего срока (не дольше `OAUTH_MAX_TOKEN_AGE_SECONDS`, по умолчанию 24 ч). Для более строгого режима уменьшите срок токена в Auth0 (API → Settings → Token Expiration) и задайте ту же величину в `OAUTH_MAX_TOKEN_AGE_SECONDS`. Для немедленного прекращения доступа остановите MCP Worker/измените допуск владельца. Отзыв ключа Roadmap применяется самим backend на следующем REST-запросе; ключ и права не кешируются. JWKS может кешироваться библиотекой для проверки подписи.

## Auth0: соответствие настроек

| Auth0 | Worker |
| --- | --- |
| APIs → custom API → **Identifier** | ровно `MCP_RESOURCE` (`https://rafinad-roadmap-mcp.ezhirov-es.workers.dev/mcp`) — попадает в `aud` |
| Tenant domain с `https://` и завершающим `/` | `OAUTH_ISSUER` |
| `https://<tenant>/.well-known/jwks.json` | `OAUTH_JWKS_URL` |
| Applications → Regular Web Application → **Client ID** | `OAUTH_CLIENT_ID` (Auth0 кладёт его в `azp`) |
| User Management → Users → **user_id** владельца | `OWNER_SUBJECT` (например `auth0|…`) |
| API → Permissions: `roadmap:read` (и при необходимости `roadmap:write`), пользователю выданы, в Access Settings разрешён **User-delegated Access** | scope в токене |
| API → Token Expiration | не больше `OAUTH_MAX_TOKEN_AGE_SECONDS` |

ChatGPT при подключении сам находит Auth0 через `/.well-known/oauth-protected-resource/mcp`. В Regular Web Application должен быть разрешён callback URL, который показывает ChatGPT, а в запросе авторизации — `audience`/`resource`, равный `MCP_RESOURCE`, иначе Auth0 выдаст токен без нужного `aud`.

## Включение записи (с 13.10.2026)

В production конфигурации MCP Worker задано `ENABLE_WRITES="true"`. Это **не** означает автоматическое предоставление прав. JWT по-прежнему должен содержать оба разрешения `roadmap:read roadmap:write`, а соответствующая роль и персональный API-ключ Roadmap должны разрешать конкретную операцию. Если у токена только `roadmap:read`, MCP предоставляет лишь 9 инструментов чтения.

Для выдачи scope со стороны Auth0: в **Applications → APIs** выберите API с идентификатором `MCP_RESOURCE` и добавьте разрешение `roadmap:write` рядом с `roadmap:read`; проверьте User-delegated Access и назначение нужному владельцу в соответствии с текущими настройками Auth0. После изменения запросите повторную авторизацию приложения в ChatGPT, чтобы выдать новый access token с запрошенным scope записи. Старые токены автоматически не получают новые права. При включённой записи заголовок `WWW-Authenticate` для нового подключения запрашивает сразу `roadmap:read roadmap:write`; существующее подключение нужно переподключить, чтобы ChatGPT прошёл OAuth заново.

При `roadmap:write` MCP объявляет пять инструментов: `create_task`, `update_task`, `set_task_priority`, `add_task_comment`, `schedule_task`. Перед каждым изменением ChatGPT обязан представить конкретные данные и получить явное подтверждение пользователя. Не выключайте подтверждения в настройках ChatGPT. Системная схема дополнительно требует `confirmed=true`, но это не заменяет подтверждение на стороне ChatGPT. Не выполняйте тестовый write-запрос на production без отдельного согласия.

В интерфейсе **Plugins** повторно подключите Rafinad Roadmap, если после обновления OAuth scopes инструменты записи не появились. Проверяйте сначала `tools/list` и вызов `get_my_profile`, не создавая тестовых задач.

## Диагностика

`node mcp/scripts/diagnose.mjs` (или `pnpm diagnose` в `mcp`) проверяет опубликованный endpoint: discovery, 401 с `WWW-Authenticate`, CORS preflight от `https://chatgpt.com`. С переменной окружения `MCP_ACCESS_TOKEN` (только локально, не в Git/чате/истории shell) — ещё `initialize` и `tools/list`. Токен не печатается, redirect не выполняются.

| Симптом | Что проверить |
| --- | --- |
| discovery/`/mcp` → 503 | Не заданы или неверны Variables/Secrets: `MCP_RESOURCE`, `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, `OAUTH_CLIENT_ID`, `OWNER_SUBJECT`, `RAFINAD_API_KEY`, `OAUTH_MAX_TOKEN_AGE_SECONDS` |
| вход в Auth0 успешен, но `/mcp` → 401 | Временно задайте Variable `AUTH_DIAGNOSTICS=true`, выполните `pnpm exec wrangler tail` в `mcp` и повторите подключение. В логе только категория `mcp_auth_denied`: `audience_mismatch` — Identifier API ≠ `MCP_RESOURCE`; `client_mismatch` — не тот Client ID; `owner_mismatch` — вошёл другой пользователь; `missing_read_scope` — нет `roadmap:read` или выключен User-delegated Access; `lifetime_too_long`/`token_too_old` — срок токена больше `OAUTH_MAX_TOKEN_AGE_SECONDS`; `issuer_mismatch` — `OAUTH_ISSUER` без/с лишним `/`; `invalid_signature`/`jwks_unavailable` — `OAUTH_JWKS_URL`. После диагностики удалите переменную |
| ChatGPT пишет «not installed» / приложение не появилось | Это состояние подключения в ChatGPT, а не ошибка сервера: при успешных discovery, 401 и `initialize`/`tools/list` создайте или включите custom MCP приложение заново |

CORS разрешён только для `https://chatgpt.com`, `https://chat.openai.com` и собственного origin сервера; preflight (`OPTIONS`) и OAuth metadata не требуют токена, ответ 401 читаем для браузера (`Access-Control-Expose-Headers: WWW-Authenticate`).

## Локальная установка и проверки

Нужен Node.js ≥22.5 (backend-тесты используют `node:sqlite`) и pnpm 11.25.0. Из корня репозитория:

```sh
pnpm install --ignore-scripts --lockfile=false
cd mcp
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
```

`build` — то, что запускает Cloudflare Workers Builds: проверка типов и тесты, которым не нужен корень репозитория (`typecheck:ci`, `test:ci`), затем `wrangler deploy --dry-run`; сам по себе он не публикует Worker (публикует отдельный шаг Workers Builds `wrangler deploy --keep-vars`). Полный набор с backend-тестом — `pnpm test` локально. Разрешения install-скриптов для pnpm 11 (`esbuild`, `workerd`) — в `mcp/pnpm-workspace.yaml`; без них установка в Workers Builds падала с `ERR_PNPM_IGNORED_BUILDS`. Тесты подменяют сетевой транспорт локальным backend и создают временные тестовые ключи. Ни production key, ни Cloudflare credentials для них не нужны. JWT-ключевая пара создаётся в памяти тестового процесса.

Для локального запуска: `pnpm dev`. Без настроек сервер намеренно закрыт. `.dev.vars` игнорируется Git: в нём допустимы только тестовые секреты и настройки тестового OAuth tenant. Не копируйте production key для локальной проверки. MCP Inspector можно использовать после настройки тестового OAuth/HTTPS endpoint; это отдельная ручная проверка, не результат unit-тестов.

## Инструменты и REST-маршруты

| Инструмент | Реальный REST API |
| --- | --- |
| `get_my_profile` | GET `/api/auth/me` |
| `get_reference_data` | GET `/api/meta` — дополнительный справочник существующих ID |
| `search_tasks` | GET `/api/features` с разрешёнными фильтрами |
| `get_task` | GET `/api/features/:id` (также RF-номер) |
| `get_sprints` | GET `/api/sprints` или `/api/sprints/:id` |
| `get_current_sprint` | GET `/api/calendar`, затем текущий спринт и его задачи |
| `get_releases` | GET `/api/releases` или `/api/releases/:id` |
| `get_overview` | GET `/api/overview` |
| `get_analytics` | GET `/api/analytics/summary` |
| `create_task` | POST `/api/features` |
| `update_task` | PATCH `/api/features/:id` |
| `set_task_priority` | PUT `/api/features/:id/votes/:departmentId` |
| `add_task_comment` | POST `/api/features/:id/comments` |
| `schedule_task` | PATCH `/api/features/:id/schedule` |

9 read tools доступны после авторизации. Ещё 5 write tools появляются только при включённой серверной записи и OAuth write scope. Вызов скрытого write tool напрямую также не разрешается. Scopes ключа Roadmap и роль владельца независимо проверяются самим Roadmap: OAuth write не повышает права.

`search_tasks` поддерживает q, status, category, epic, department, release, stage, kind, sprint, ids, assignee, initiator, visibility, tag, hide_closed, focus, internal, created_from, created_to, flag, sort. Устаревшие offer, period и offer_ids удалены из MCP-контракта вместе с vNext. Неизвестные поля запрещены. Включительные `from`/`to` аналитики обязательны. Аналитика исключает скрытые Product-задачи даже у product/admin. Метрика `done_in_period` считает задачи с текущим статусом done и closed_at в диапазоне, а не все исторические переходы в done.

Инициатор передаётся отдельно в `fields.initiator`; `author_name` через MCP не принимается. Неизвестные значения не дополняются; backend вправе применить свои штатные defaults. Нельзя передать произвольный URL, заголовки или REST-маршрут. Перенаправления REST запрещены, автоматических повторов нет. Удаление, массовая запись, административные операции и удаление голосов не реализованы.

## Подтверждения и конфликты

Перед каждым write ChatGPT должен показать точные изменения и получить подтверждение. Не включайте постоянное автоматическое разрешение записи. MCP-аннотации `readOnlyHint=false`, `destructiveHint=true` обозначают действия с изменением состояния; обязательный `confirmed=true` — дополнительная проверка аргументов, **не криптографическое доказательство согласия человека**. Подтверждение обеспечивает host ChatGPT; это нужно проверить вручную при подключении.

Для existing task сначала вызовите `get_task`, затем передайте прочитанную `version`. Адаптер повторно читает карточку перед записью и сравнивает версии. PATCH задачи/расписания получает ту же version, а backend атомарно проверяет её. При 409 карточка перечитывается, результат содержит `requires_new_confirmation`; повторной записи нет. Конфликты утверждённого релиза/бюджета требуют отдельного согласия и reason. Назначение проверяет существование целевого спринта/релиза.

Голоса имеют отдельный optimistic lock: `expected_version` из соответствующего голоса, null если его ещё нет. Адаптер также проверяет версию карточки и принадлежность отдела, backend атомарно защищает **голос**, но не совместную транзакцию «карточка + голос».

Комментарии append-only: backend принимает только body и не поддерживает атомарный lock по version. MCP делает предварительное сравнение карточки, но конкурентное изменение между GET и POST возможно. Полная гарантия для комментариев потребует отдельного изменения production API. Комментарии после сетевого сбоя нельзя автоматически повторять — возможен дубль. Такое же правило действует для создания задач.

Ошибки 401/403/404/409/429 возвращаются понятными сообщениями. Сырые тела ошибок и заголовки upstream не выдаются. В успешных данных маскируется интеграционный ключ, Bearer-строки и поля секретов. Логирование запросов/ответов не включено. Содержимое карточек и комментариев считается данными, а не инструкциями.

## Последовательность подключения владельцем — после одобрения PR

1. Проверьте наличие **Plugins → + → Add custom MCP server** в аккаунте Plus. Если интерфейс показывает Developer mode как условие, включите его. Если пункта нет или запись запрещена политикой аккаунта, оставьте read-only. Смена флага Worker не снимает ограничений ChatGPT.
2. В Roadmap отзовите ранее раскрытый ключ. Создайте новый специальный ключ с минимальными scopes: для чтения `tasks:read`; позже по необходимости `tasks:create`, `tasks:update`, `priorities:write-own`. Название — например «ChatGPT MCP». Срок — минимально удобный. Не отправляйте ключ в чат.
3. Настройте OAuth tenant/client по контракту выше. Ограничьте допуск владельцем, настройте PKCE S256 и точный callback из страницы MCP в ChatGPT. Проверьте discovery провайдера и выдаваемые claims на тестовом tenant.
4. После разрешения на публикацию заполните не секретные vars в **отдельном** `mcp/wrangler.jsonc`. Проверьте выбранный Cloudflare account и адрес. Установите секрет интерактивно из каталога `mcp`: `pnpm exec wrangler secret put RAFINAD_API_KEY`. Не передавайте значение аргументом команды. Если Worker ещё не существует, его первоначальное создание с неполной конфигурацией оставляет endpoint закрытым (503).
5. Развёртывание выполняется владельцем отдельно: `pnpm exec wrangler deploy` из `mcp`. Это не команда `deploy` основного проекта. В ходе реализации эти команды публикации/секретов не выполнялись.
6. Добавьте HTTPS `/mcp` в ChatGPT, выберите OAuth и зарегистрированный client ID (и client secret, если требует провайдер). Войдите как разрешённый владелец. Убедитесь, что discovery показывает ровно 9 read tools, запрос без токена получает 401, чужой пользователь не имеет доступа.
7. Выполните read-сценарии ниже. Сверьте результаты с UI Roadmap. Не считайте fixtures доказательством правильности production-данных.
8. Только после проверки доступности write tools/подтверждений в вашем аккаунте, расширения прав специального ключа и отдельного разрешения на тестовые изменения включите `ENABLE_WRITES="true"`, выдайте OAuth `roadmap:write`, обновите подключение (Refresh/re-authorize). Должно появиться 14 инструментов. Если host не запрашивает подтверждение — запись не включать.

Если Plus не позволяет запись: оставить сервер read-only. Альтернативы — аккаунт/workspace, в котором custom MCP write явно разрешён, либо собственный клиент Responses API с `require_approval="always"` и OAuth, за отдельный API-бюджет; [документация MCP в API](https://developers.openai.com/api/docs/guides/tools-connectors-mcp). Ни один вариант не развёрнут и не заявлен как проверенное подключение данного аккаунта. Если недоступно само добавление custom MCP, read-only режим также не обходит это ограничение.

## Ручная приёмка после подключения

| Запрос | Проверка |
| --- | --- |
| Все незакрытые задачи текущего спринта | `get_current_sprint` с hide_closed=true; сверить верхний список features с UI |
| Блокировки следующего релиза | `get_releases`, выбрать реальный следующий релиз, `get_task` для блокирующих связей; не придумывать отсутствующие зависимости |
| Найти задачу про экспорт | `search_tasks` с q, затем `get_task` выбранной задачи |
| Создать фильтр по рекламодателю, инициатор продуктовый отдел | Сначала `get_reference_data` для точного ID, показать fields, спросить подтверждение; создавать лишь после отдельного разрешения владельца на тест |
| Перенести RF-15 на следующий спринт | Прочитать карточку и календарь, выбрать существующий спринт, показать изменение и version, подтвердить |
| Сколько закрыли за 30 дней | `get_analytics` с явным включительным диапазоном; например 14.09–13.10.2026, сверить done_in_period |

Отдельно проверить OAuth login/PKCE, отклонение чужого пользователя, отсутствие секретов, отзыв специального ключа и реальные подтверждения ChatGPT. Production-создание/изменение и отзыв нового ключа — только по отдельному разрешению владельца. Не включать в автоматический smoke test.
