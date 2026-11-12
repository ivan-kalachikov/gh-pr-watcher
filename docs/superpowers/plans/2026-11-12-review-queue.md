# Очередь ревью — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** вкладка «На ревью» в popup с ранжированной очередью PR, где ждут моего ревью. К ней добавляются скрытие PR, кнопка «Открыть в Claude», отдельные настройки и выключенные по умолчанию уведомления.

**Архитектура:**
- Чистая логика лежит в трёх новых модулях: `lib/review.js` (нормализация и ранжирование), `lib/review-state.js` (база для уведомлений и скрытые PR), `lib/claude.js` (ссылка `claude://`). Всё это покрывается тестами на `node --test`.
- Данные `background.js` получает в два шага:
  1. дешёвый поиск `search`, чтобы узнать, какие PR сейчас в очереди и в «Ждут автора»;
  2. подробности через `nodes(ids:)`, только по изменившимся PR, с кэшем в `reviewState`.
- Popup и страница настроек получают новые секции. Код вкладки ревью вынесен в отдельный модуль popup.

**Стек:** Chrome MV3, ванильный JS (ES-модули), без сборки и зависимостей, GitHub GraphQL, `node --test`.

**Спецификация:** `docs/superpowers/specs/2026-11-12-review-queue-design.md` — читать вместе с планом. Все значения ниже взяты из неё.

## Глобальные ограничения

- Без новых npm-зависимостей и без сборки. Файлы подключаются как есть: `<script type="module">`.
- Права в `manifest.json` не меняются (`storage`, `alarms`, `notifications`, `https://api.github.com/*`).
- Весь текст интерфейса на русском, в тоне существующего: «ждёт 4 д», «Скрыто · Отменить», «Вернуть».
- HTML собирается строками с экранированием через `esc()`, как в `popup.js`. Никакого `innerHTML` с неэкранированными данными GitHub.
- Новые настройки по умолчанию:
  - `review.repos = []`;
  - `review.includeTeams = false`;
  - `review.notify.requested = false`;
  - `review.notify.rerequested = false`.
- Промпты по умолчанию:
  - для ревью: `Сделай ревью pull request {url}`;
  - для своего PR: `Разбери комментарии ревьюеров в моём pull request {url} и предложи, что исправить`.
- Подстановки в промптах: `{url}`, `{title}`, `{repo}`, `{number}`, `{author}`.
- Размер PR по `additions + deletions`: XS ≤ 10, S ≤ 100, M ≤ 400, L ≤ 1000, XL > 1000.
- Цвет ожидания: обычный, жёлтый с 2 суток, красный с 5 суток.
- Ранжирование: ярус 1 всегда выше яруса 2. Поправки: ре-ревью +24 ч, никто не ревьюил +12 ч, XS/S +8 ч. Штрафа за CI нет.
- Ссылка: `claude://code/new?q=…[&folder=…]`. `q` обрезается до 14 000 символов.
- Бюджет API — около 1500 пунктов в час суммарно при интервале 2 мин. Подробности по PR перезапрашиваются, если изменился `updatedAt` или с последней загрузки прошло больше 10 мин.
- Бейдж на иконке не меняется: только непрочитанное в «Мои PR».

## На что смотреть при ревью

1. **Запрос на команду при `includeTeams = false`.** Такой PR не должен попадать в очередь, при `true` должен. Проверяется строкой поиска (Задача 2).
2. **Мой «ревью» — только ответ в чужом треде.** PR должен считаться первичным, а не ре-ревью, и не попадать в «Ждут автора» (Задача 3).
3. **`ReviewRequestedEvent` нет в последних 20 событиях.** Ожидание считается от `createdAt`, PR не падает и не получает `NaN` в счёте (Задача 3).
4. **Промпт с переносами строк, `&`, `#`, неизвестной подстановкой `{foo}` или длиннее 14 000 символов.** Ссылка корректно закодирована, `{foo}` остаётся как есть, `q` обрезан (Задача 4).
5. **Смена токена или списка репозиториев для ревью.** Не должно быть шквала уведомлений: база перезаписывается молча. При смене токена скрытые PR очищаются. Закрытый скрытый PR удаляется из скрытых (Задача 5).

---

### Задача 1: Настройки

**Файлы:**
- Изменить: `lib/settings.js` (`DEFAULT_SETTINGS`, `withDefaults`)
- Тест: `test/settings-format.test.js`

**Интерфейсы:**
- Создаёт: `withDefaults(stored)`, который дополнительно возвращает:
  ```js
  review: { repos: string[], includeTeams: boolean, notify: { requested: boolean, rerequested: boolean } },
  claude: { reviewPrompt: string, ownPrompt: string, folders: { [repoLower: string]: string } }
  ```
  Вложенные объекты сливаются с умолчаниями так же, как сейчас `notify`. Если `review.repos` или `claude.folders` неправильного типа, подставляются `[]` и `{}`.

- [ ] **Шаг 1: падающий тест** `test("review and claude settings get defaults and merge partially")`:
  - `withDefaults({})` → `review` равен `{ repos: [], includeTeams: false, notify: { requested: false, rerequested: false } }`, `claude.reviewPrompt === "Сделай ревью pull request {url}"`, `claude.folders` равен `{}`;
  - `withDefaults({ review: { notify: { rerequested: true } } }).review.notify` равен `{ requested: false, rerequested: true }`;
  - `withDefaults({ review: { repos: "x" } }).review.repos` равен `[]`.
- [ ] **Шаг 2:** `npm test` — ожидается FAIL.
- [ ] **Шаг 3:** реализовать.
- [ ] **Шаг 4:** `npm test` — ожидается PASS, все старые тесты тоже проходят.
- [ ] **Шаг 5:** коммит `feat: settings for the review queue and Claude links`.

---

### Задача 2: Запросы к GitHub для очереди ревью

**Файлы:**
- Изменить: `lib/github.js`
- Тест: `test/github.test.js`

**Интерфейсы:**
- Изменить: `buildSearchQueries(repos, prefix)`. Второй аргумент теперь полный префикс, а не логин. `fetchPullRequests` передаёт `` `is:pr is:open archived:false author:${login}` ``. Старые тесты обновить под новую сигнатуру, ожидаемые строки не меняются.
- Создаёт:
  - `reviewPrefixes(login, includeTeams) -> { queue: string, waiting: string }`:
    - `queue`: `is:pr is:open archived:false draft:false user-review-requested:<login>`. При `includeTeams` вместо `user-review-requested:` используется `review-requested:`.
    - `waiting`: `is:pr is:open archived:false draft:false reviewed-by:<login> -author:<login>`.
  - `fetchReviewList(token, login, review, fetchImpl) -> { queue: ListItem[], waiting: ListItem[], rateLimit, warnings }`:
    - `ListItem = { id: string, key: "owner/name#N", updatedAt: string }`;
    - один GraphQL-запрос с алиасами `q0..`, `w0..` по чанкам из `buildSearchQueries(review.repos, prefix)`, `first: 50`, на узле только `id number updatedAt repository { nameWithOwner }`;
    - если ключ есть и в `queue`, и в `waiting`, он остаётся только в `queue`;
    - пустой `review.repos` → пустые списки без запроса в сеть.
  - `fetchReviewDetails(token, ids, fetchImpl) -> { nodes: object[], rateLimit }`:
    - запрос `nodes(ids: $ids) { ... on PullRequest { … } }` пачками по 20 id;
    - поля по разделу «Данные» спецификации: `author`, `createdAt`, `additions`, `deletions`, `changedFiles`, `reviewDecision`, `isDraft`, `commits(last: 20)` с `committedDate` и `statusCheckRollup` у последнего, `timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT])`, `reviews(last: 50)` с `state body submittedAt author { __typename login } commit { oid } comments(first: 20) { nodes { replyTo { id } } }`, `reviewThreads(first: 50) { nodes { isResolved comments(last: 1) { nodes { author { login } } } } }`.

- [ ] **Шаг 1: падающие тесты:**
  - `test("review prefixes switch between direct and team requests")`: `reviewPrefixes("me", false).queue` содержит `user-review-requested:me`; `reviewPrefixes("me", true).queue` содержит `review-requested:me` и не содержит `user-review-requested`; `waiting` содержит `reviewed-by:me -author:me`.
  - `test("review list puts a PR in the queue only, never in both")`: фейковый `fetchImpl` возвращает один и тот же PR в `q0` и `w0`. Ожидается `queue.length === 1`, `waiting.length === 0`.
  - `test("review list skips the network when no review repos are set")`: `fetchImpl` бросает исключение при вызове, результат — пустые списки.
  - `test("details are fetched in batches of 20 ids")`: 45 id → 3 вызова `fetchImpl`, в переменных `ids` по 20, 20 и 5.
- [ ] **Шаг 2:** `npm test` — FAIL.
- [ ] **Шаг 3:** реализовать. Повторно использовать `graphql()` и `GitHubError`.
- [ ] **Шаг 4:** `npm test` — PASS.
- [ ] **Шаг 5:** коммит `feat: GitHub queries for PRs awaiting my review`.

---

### Задача 3: Нормализация и ранжирование (`lib/review.js`)

**Файлы:**
- Создать: `lib/review.js`
- Тест: `test/review.test.js`

**Интерфейсы:**
- Использует: сырые узлы из `fetchReviewDetails` (Задача 2).
- Создаёт:
  - `normalizeReviewPr(node, login, { includeTeams }) -> ReviewPr`:
    ```js
    {
      key, id, repo, number, title, url, author, createdAt, updatedAt, isDraft,
      reviewDecision, additions, deletions, changedFiles,
      ci: string | null,                          // statusCheckRollup.state последнего коммита
      requestedAt: string | null,                 // последний ReviewRequestedEvent мне (или Team при includeTeams)
      myLastReviewAt: string | null,              // последнее значимое ревью от меня (didReview)
      myLastReviewState: string | null,
      firstCommitAfterMyReview: string | null,
      approvedBy: string[], changesRequestedBy: string[],   // другие, последнее значимое состояние по каждому
      changesPendingAuthor: boolean,              // есть CR от другого, и после него нет коммитов
      reviewedByOthers: boolean,                  // есть значимое ревью от кого-то кроме меня, автора и ботов
      threads: { resolved, unresolved, unanswered, answered },
    }
    ```
  - `didReview(review, login) -> boolean`. Правило из спецификации: состояние `APPROVED` или `CHANGES_REQUESTED`, либо `COMMENTED` с непустым `body.trim()` или хотя бы одним комментарием с `replyTo == null`. Автор ревью должен быть `login` (без учёта регистра).
  - `sizeOf(pr) -> "XS"|"S"|"M"|"L"|"XL"`.
  - `reviewKind(pr) -> "first"|"rerequest"`: `rerequest`, если `myLastReviewAt` не null.
  - `waitingSince(pr) -> string`:
    - для `first`: `requestedAt ?? createdAt`;
    - для `rerequest`: более раннее из двух — `requestedAt` (если он позже `myLastReviewAt`) и `firstCommitAfterMyReview`; если обоих нет, `requestedAt ?? createdAt`.
  - `rankQueue(prs, sort, now) -> RankedItem[]`:
    - `RankedItem = { pr, tier: 1|2, score: number, hours: number, reasons: string[] }`;
    - `sort` принимает значения `"need" | "oldest" | "newest" | "unreviewed" | "smallest"`;
    - ярус 2 означает `reviewDecision === "APPROVED"` или `changesPendingAuthor`;
    - `score = hours + 24·rerequest + 12·!reviewedByOthers + 8·(size XS/S)`;
    - веса — экспортируемая константа `WEIGHTS = { rerequest: 24, unreviewed: 12, small: 8 }`;
    - `reasons` (не больше 3): сначала ярус-2-причина (`"уже хватает апрувов"` или `"ждёт автора после запроса изменений"`), затем `"ре-ревью"`, `"никто не смотрел"`, `"маленький"` по убыванию веса, затем `"ждёт N д"` / `"ждёт N ч"`;
    - для остальных сортировок `reasons` пустой;
    - `oldest` — по `hours` по убыванию; `newest` — по `waitingSince` по убыванию; `unreviewed` — сначала `!reviewedByOthers`, внутри по `hours` по убыванию; `smallest` — по `additions + deletions` по возрастанию.
  - `waitAge(hours) -> "normal"|"warn"|"late"` с порогами 48 и 120 часов.
  - `formatWait(hours) -> string`: `"6 ч"` меньше суток, иначе `"4 д"`.

- [ ] **Шаг 1: падающие тесты** с фабрикой `node(overrides)`:
  - `didReview`: `CHANGES_REQUESTED` → true; `COMMENTED` с пустым телом и одним комментарием-ответом (`replyTo: { id }`) → false; `COMMENTED` с пустым телом и одним комментарием без `replyTo` → true; ревью другого пользователя → false.
  - `test("a reply in someone else's thread does not make it a re-review")`: единственное ревью от меня — ответ. Ожидается `reviewKind === "first"`, `myLastReviewAt === null`.
  - `test("waiting falls back to createdAt without a request event")`: `timelineItems` пустой → `waitingSince(pr) === pr.createdAt`, у `rankQueue` конечный `score`.
  - `test("re-review waits from the first commit after my review")`: моё ревью `2026-11-01`, коммиты `2026-11-03` и `2026-11-05`, повторного запроса нет → `"2026-11-03…"`.
  - `test("team requests count only with includeTeams")`: событие с `requestedReviewer: { slug: "core" }` → `requestedAt` равен null при `includeTeams: false` и дате события при `true`.
  - `test("threads split into resolved, answered and unanswered")`: 2 решённых, 1 нерешённый с последним комментарием автора PR, 2 нерешённых с последним комментарием другого → `{ resolved: 2, unresolved: 3, answered: 1, unanswered: 2 }`.
  - `test("sizes follow the thresholds")`: 10 → XS, 11 → S, 100 → S, 400 → M, 1000 → L, 1001 → XL.
  - `test("tier 2 always ranks below tier 1")`: PR A одобрен (`APPROVED`) и ждёт 300 ч, PR B ждёт 1 ч → B первый, у A `reasons[0] === "уже хватает апрувов"`.
  - `test("re-review outranks an equally old first review")`: оба ждут 10 ч, оба M, оба уже ревьюились другими → `rerequest` первый, его `score === 34`.
  - `test("failed CI does not lower the rank")`: PR с `ci: "FAILURE"` и PR с `ci: "SUCCESS"` при прочих равных → одинаковый `score`.
  - `test("reasons are capped at three")`.
  - `test("other sorts order as described")` — по одному утверждению на `oldest`, `newest`, `unreviewed`, `smallest`.
- [ ] **Шаг 2:** `npm test` — FAIL.
- [ ] **Шаг 3:** реализовать. Боты определяются как в `github.js` (`__typename === "Bot"` или `[bot]` в конце логина): вынести `isBot` в экспорт `lib/github.js` и импортировать.
- [ ] **Шаг 4:** `npm test` — PASS.
- [ ] **Шаг 5:** коммит `feat: normalize and rank PRs awaiting review`.

---

### Задача 4: Ссылка в Claude (`lib/claude.js`)

**Файлы:**
- Создать: `lib/claude.js`
- Тест: `test/claude.test.js`

**Интерфейсы:**
- Создаёт:
  - `fillTemplate(template, pr) -> string`. Подставляет `{url}`, `{title}`, `{repo}`, `{number}`, `{author}`. Неизвестные `{…}` оставляет как есть. `pr.author` может отсутствовать (у своих PR) — тогда пустая строка.
  - `claudeLink({ prompt, folder }) -> string`. Формат `claude://code/new?q=<encodeURIComponent(prompt.slice(0, 14000))>`; если `folder` — непустая строка после `trim()`, добавляется `&folder=<encodeURIComponent(folder)>`.
  - `folderFor(folders, repo) -> string | null`. Ищет без учёта регистра.
  - `MAX_PROMPT = 14000`.

- [ ] **Шаг 1: падающие тесты:**
  - Подстановка всех пяти полей; `{foo}` сохраняется; повторный `{url}` заменяется дважды.
  - `claudeLink({ prompt: "a & b\n#1" })` равен `"claude://code/new?q=a%20%26%20b%0A%231"`.
  - Промпт из 15 000 символов `x` → декодированный `q` длиной 14 000.
  - `folder: "  "` → в ссылке нет `folder=`; `folder: "/home/me/repo"` → `&folder=%2Fhome%2Fme%2Frepo`.
  - `folderFor({ "o/r": "/p" }, "O/R") === "/p"`.
- [ ] **Шаг 2:** `npm test` — FAIL.
- [ ] **Шаг 3:** реализовать.
- [ ] **Шаг 4:** `npm test` — PASS.
- [ ] **Шаг 5:** коммит `feat: build claude:// links from prompt templates`.

---

### Задача 5: Состояние очереди, уведомления и скрытые PR (`lib/review-state.js`)

**Файлы:**
- Создать: `lib/review-state.js`
- Тест: `test/review-state.test.js`

**Интерфейсы:**
- Использует: `ReviewPr`, `reviewKind` (Задача 3).
- Создаёт:
  - `EMPTY_REVIEW_STATE = { queue: {}, waiting: {}, details: {}, baselined: false, reposKey: "", lastCheck: null, lastError: null }`. `details` — кэш `{ [key]: { pr: ReviewPr, fetchedAt } }`.
  - `needsDetails(listItem, cached, now) -> boolean`: true, если кэша нет, `updatedAt` отличается или `now − fetchedAt > 10 мин`.
  - `diffReviewQueue(prevState, nextQueue, settings) -> { changes: { pr, kind: "requested"|"rerequested" }[] }`:
    - при `!prevState.baselined` → изменений нет;
    - `requested`: ключа не было в `prevState.queue`, и `reviewKind(pr) === "first"`;
    - `rerequested`: `reviewKind(pr) === "rerequest"` и `requestedAt` новее, чем у того же ключа в `prevState.queue` (или ключа там не было);
    - каждое изменение проходит только при включённом `settings.review.notify[kind]`.
  - `reposKey(review) -> string`: отсортированные `repos` в нижнем регистре плюс `includeTeams`. Если `reposKey` в состоянии не совпадает с текущим, вызывающий код считает базу несохранённой.
  - `pruneIgnored(ignored, queue, waiting) -> ignored`:
    - удаляет ключи, которых нет ни в `queue`, ни в `waiting` (PR закрыт, смёржен или вышел из выбранных репозиториев);
    - удаляет ключи, у которых `queue[key].requestedAt > ignored[key].ignoredAt` (авто-возврат при повторном запросе);
    - новые коммиты PR не возвращают.

- [ ] **Шаг 1: падающие тесты:**
  - `test("first poll after enabling or changing repos is silent")`: `baselined: false`, 3 PR в очереди, все уведомления включены → `changes` пустой.
  - `test("new first-time request notifies only when enabled")`: при `requested: false` пусто, при `true` одно изменение `requested`.
  - `test("re-request notifies when requestedAt moves forward")`.
  - `test("ignored PR returns on a newer review request, not on new commits")`.
  - `test("ignored PR that is gone from both lists is pruned")`.
  - `test("details are refetched on updatedAt change or after 10 minutes")`.
- [ ] **Шаг 2:** `npm test` — FAIL.
- [ ] **Шаг 3:** реализовать.
- [ ] **Шаг 4:** `npm test` — PASS.
- [ ] **Шаг 5:** коммит `feat: review queue state, notifications and ignore list`.

---

### Задача 6: Опрос в фоне (`background.js`)

**Файлы:**
- Изменить: `background.js`, `lib/format.js` (текст уведомления)
- Тест: `test/settings-format.test.js` (для `describeReviewRequest`)

**Интерфейсы:**
- Использует: Задачи 2–5.
- Создаёт:
  - Ключи хранилища: `reviewState` (форма `EMPTY_REVIEW_STATE`; `queue` и `waiting` хранят `{ [key]: ReviewPr }`, собранные из `details`) и `reviewIgnored` (`{ [key]: { ignoredAt, title, url, repo, number } }`).
  - Сообщения из popup:
    - `{ type: "ignore", key }`;
    - `{ type: "unignore", key }`;
    - `{ type: "unignoreAll" }`;
    - `{ type: "openReview", url }` — открыть PR, не помечая прочитанным;
    - `{ type: "openClaude", url }` — открыть ссылку `claude://`.
  - `describeReviewRequest({ pr, kind }) -> { title, message, url }` в `lib/format.js`. Текст: `"Ваше ревью запрошено"` или `"Запрошено повторное ревью"`, затем `· автор`.

- [ ] **Шаг 1: падающий тест** для `describeReviewRequest`: заголовок как у `describeChange` (`prLabel · title`, обрезка 80), правильный текст для обоих `kind`, `url === pr.url`.
- [ ] **Шаг 2:** `npm test` — FAIL.
- [ ] **Шаг 3:** реализовать `describeReviewRequest`, затем переделать `poll()` в `background.js`:
  - `pollMine(settings, viewer)` и `pollReview(settings, viewer)` работают внутри одного `serial()`, каждый со своей ошибкой. Ошибка «добавьте репозитории» пишется в `state.lastError` только при пустом `settings.repos`, а в `reviewState.lastError` — только при пустом `settings.review.repos`. Отсутствие токена — общая ошибка для обоих.
  - `pollReview`:
    1. `fetchReviewList`;
    2. отбор id через `needsDetails`;
    3. `fetchReviewDetails`;
    4. `normalizeReviewPr`;
    5. сборка `queue` и `waiting`. В `waiting` попадают только PR, где `myLastReviewAt` не null и `myLastReviewState !== "APPROVED"`;
    6. `diffReviewQueue`;
    7. `pruneIgnored`;
    8. запись состояния: `baselined: true`, текущий `reposKey`, чистка `details` от ключей, которых нет в списках;
    9. уведомления для изменений, кроме скрытых PR.
  - Уведомления ревью получают id с префиксом `review:` и открывают PR по клику через тот же механизм `chrome.storage.session`. Метку прочитанного в «Мои PR» они не трогают.
  - В `storage.onChanged`:
    - при смене токена сбросить `reviewState` и `reviewIgnored`;
    - при изменении `reposKey` сбрасывать только `baselined` — это делает сам `pollReview`, сравнивая `reposKey`.
  - `openClaude`: открыть ссылку в активной вкладке через `chrome.tabs.update(tab.id, { url })`. Для внешней схемы навигации не будет, и пустая вкладка не останется. Если активной вкладки нет, использовать `chrome.tabs.create({ url, active: false })`.
- [ ] **Шаг 4:** `npm test` — PASS.
- [ ] **Шаг 5:** коммит `feat: poll the review queue in the background`.

---

### Задача 7: Popup — вкладки и очередь ревью

**Файлы:**
- Изменить: `popup.html` (вкладки вместо заголовка «Мои PR», контейнер тоста), `popup.js` (переключение вкладок, кнопка Claude на «Мои PR»), `popup.css`, `lib/icons.js` (иконки `eyeOff`, `claude`, `undo`)
- Создать: `popup-review.js` (рендер и обработчики вкладки «На ревью»)

**Интерфейсы:**
- Использует: `rankQueue`, `sizeOf`, `reviewKind`, `waitAge`, `formatWait` (Задача 3); `fillTemplate`, `claudeLink`, `folderFor` (Задача 4); сообщения из Задачи 6.
- Создаёт:
  - `renderReview(listEl, { settings, reviewState, ignored, ui }) -> void`, где `ui = { filter: "all"|"first"|"rerequest", sort, openSections: Set<string> }`;
  - `bindReview(listEl, getContext) -> void` для обработчиков.

- [ ] **Шаг 1: вкладки.** «Мои PR» с текущим счётчиком непрочитанного и «На ревью N», где N = PR в очереди без скрытых. Последняя вкладка хранится в `localStorage` под ключом `popupTab`, обращения обёрнуты в `try/catch`, как `readCollapsed`. Кнопка «Отметить всё прочитанным» видна только на «Мои PR». Строка статуса показывает время проверки и ошибку текущей вкладки.
- [ ] **Шаг 2: панель управления.**
  - Чипы «Все N · Первичные N · Ре-ревью N».
  - `<select>` сортировки с подписями «Нужнее всего», «Дольше всех ждут», «Новые», «Никто не ревьюил», «Маленькие сначала».
  - Выбор хранится в `localStorage` под ключами `reviewFilter` и `reviewSort`.
- [ ] **Шаг 3: строка PR** по разделу «Строка PR» спецификации. Нулевые бейджи не выводятся. Строка-причина только при `sort === "need"`. Подсказки (`title`): у размера `+A −D, N файлов`, у ✓ и ✗ — логины. Время ожидания окрашивается классом по `waitAge`.
- [ ] **Шаг 4: действия.**
  - Иконки «Открыть в Claude» и «Скрыть» видны при `:hover` и `:focus-within` строки.
  - Клик по строке → `openReview`. Ctrl+клик и средний клик открывают PR в фоне, как в «Мои PR».
  - «Скрыть» → сообщение `ignore` и тост «Скрыто · Отменить» на 5 с; «Отменить» → `unignore`.
  - Кнопка Claude → `openClaude` с `claudeLink({ prompt: fillTemplate(settings.claude.reviewPrompt, pr), folder: folderFor(settings.claude.folders, pr.repo) })`.
- [ ] **Шаг 5: секции и пустые состояния.**
  - `<details>` «Ждут автора · N» (бейдж «новые коммиты», если `firstCommitAfterMyReview` не null) и «Скрытые · N» (компактная строка с кнопкой «Вернуть»). Открытые секции хранятся в `localStorage` под ключом `reviewSections`.
  - Пустые состояния с текстом из спецификации.
- [ ] **Шаг 6: «Мои PR».** Иконка Claude в строке при наведении, с промптом `settings.claude.ownPrompt`. Ссылка-строка `.pr__link` должна оставаться кликабельной: кнопка вне `<a>` или с `stopPropagation`.
- [ ] **Шаг 7: проверка вручную** через стенд из Задачи 9 (вкладки, сортировки, тост, обе темы). Затем `npm test` — PASS.
- [ ] **Шаг 8:** коммит `feat: review queue tab in the popup`.

---

### Задача 8: Страница настроек

**Файлы:**
- Изменить: `options.html`, `options.js`, `options.css`, `lib/github.js` (подсказки репозиториев для ревью)
- Создать: `repo-picker.js` (UI выбора репозиториев, вынесенный из `options.js`)
- Тест: `test/github.test.js` (подсказки)

**Интерфейсы:**
- Создаёт:
  - `createRepoPicker({ chipsEl, searchEl, listEl, statusEl, loadSuggestions: (token) => Promise<{viewer, openRepos, recentRepos}>, onChange }) -> { getSelected(): string[], setSelected(ids: string[]): void, reload(token: string): Promise<void> }`. Логика из `options.js` переносится как есть: `picker`, `renderChips`, `renderList`, `scheduleSearch`, клавиши Enter и ↓. Все `$("…")` заменяются на переданные элементы.
  - `fetchReviewRepoSuggestions(token, fetchImpl) -> { viewer, openRepos, recentRepos }`. Те же поля, что у `fetchRepoSuggestions`, но поиски `is:pr is:open archived:false review-requested:@me` (open) и `is:pr reviewed-by:@me sort:updated-desc` (recent). Подходит для `buildSuggestions`.

- [ ] **Шаг 1: падающий тест** `test("review repo suggestions use review-requested and reviewed-by searches")`: фейковый `fetchImpl` проверяет, что в теле запроса есть обе строки поиска, и возвращает репозитории. Результат: `openRepos` и `recentRepos`.
- [ ] **Шаг 2:** `npm test` — FAIL. **Шаг 3:** реализовать функцию. **Шаг 4:** `npm test` — PASS.
- [ ] **Шаг 5:** вынести picker в `repo-picker.js` и подключить два экземпляра: «Репозитории» (свои PR, `fetchRepoSuggestions`) и «Репозитории для ревью» (`fetchReviewRepoSuggestions`). Убедиться вручную, что первый работает как раньше.
- [ ] **Шаг 6: секция «На ревью»:**
  - picker;
  - флажок «Учитывать запросы на мои команды»;
  - флажки «Уведомлять о новом запросе ревью» и «Уведомлять о запросе ре-ревью»;
  - список «Скрытые PR» из `reviewIgnored` с кнопками «Вернуть» и «Вернуть все», которые шлют сообщения из Задачи 6. Если скрытых нет, список не показывается. Список обновляется через `chrome.storage.onChanged`.
- [ ] **Шаг 7: секция «Открыть в Claude»:**
  - два `<textarea>`: «Промпт для ревью чужого PR» и «Промпт для своего PR»;
  - подсказка с подстановками;
  - «Папки репозиториев»: строки «репозиторий → путь» для каждого точного репозитория из обоих списков (`owner/*` пропускаются) и свободная строка для ввода `owner/name` вручную. Пустой путь означает «без папки»;
  - подсказка о том, что делает Claude Desktop без папки (по результату ручной проверки из Задачи 9), и о диалоге Chrome «Открыть Claude?» с вариантом «Всегда разрешать».
- [ ] **Шаг 8:** `readForm()` и `fill()` сохраняют и читают `review` и `claude`. Кнопка «Проверить доступ» проверяет и репозитории для ревью: `checkRepos` по объединению списков.
- [ ] **Шаг 9:** `npm test` — PASS. Коммит `feat: settings for the review queue and Claude prompts`.

---

### Задача 9: Проверка, стенд, README

**Файлы:**
- Изменить: `README.md` (раздел о вкладке «На ревью», скрытии, «Открыть в Claude», уведомлениях; права токена: для приватных репозиториев нужен ещё доступ на чтение к `Pull requests` — без изменений)
- Создать (вне репозитория, в scratchpad): стенд `popup-preview.html`, который подменяет `chrome.storage`, `chrome.runtime` и `chrome.tabs` фикстурами и подключает настоящие `popup.js` и `popup.css`

- [ ] **Шаг 1:** `npm test` — все тесты PASS.
- [ ] **Шаг 2: стенд.** Фикстура — 6 PR, которые покрывают ярус 2, ре-ревью, «никто не смотрел», XL, отсутствие события запроса, скрытый PR и PR в «Ждут автора». Проверить в браузерной панели при ширине 400px в светлой и тёмной теме:
  - порядок при «нужнее всего» и строки-причины;
  - переключение сортировок и фильтров;
  - тост и отмену;
  - раскрытие секций;
  - отсутствие горизонтального скролла.
- [ ] **Шаг 3: ручная проверка `claude://code/new?q=…` без `folder`** через `xdg-open`. Только с согласия пользователя: откроется его Claude Desktop. Записать, какая папка выбирается, и вписать это в подсказку настроек (Задача 8, шаг 7).
- [ ] **Шаг 4:** обновить README. Коммит `docs: describe the review queue`.
