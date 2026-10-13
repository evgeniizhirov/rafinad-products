// Demonstration data for Rafinad Product Roadmap (deterministic ids so the seed is reproducible).
// 26 features, 5 epics, 6 departments, 6 resource teams, 4 releases.

export const categories = [
  ['cat_platform', 'Платформа', '#5b6b8c'],
  ['cat_webmasters', 'Вебмастерам', '#2f7d6b'],
  ['cat_advertisers', 'Рекламодателям', '#7a5bb5'],
  ['cat_finance', 'Финансы', '#b07a1f'],
  ['cat_antifraud', 'Антифрод', '#b5473b'],
  ['cat_analytics', 'Аналитика', '#2f6fb0'],
  ['cat_security', 'Безопасность', '#4d7a2a'],
] as const;

export const departments = [
  // id, code, name, weight, is_product
  ['dep_product', 'product', 'Product', 1, 1],
  ['dep_sales', 'sales', 'Продажи (рекламодатели)', 1.5, 0],
  ['dep_affiliates', 'affiliates', 'Аккаунт-менеджмент вебмастеров', 1.2, 0],
  ['dep_finance', 'finance', 'Финансы', 1, 0],
  ['dep_support', 'support', 'Служба поддержки', 0.8, 0],
  ['dep_antifraud', 'antifraud', 'Антифрод', 1, 0],
] as const;

export const teams = [
  ['team_backend', 'backend', 'Backend', '#3b6fb6'],
  ['team_frontend', 'frontend', 'Frontend', '#2f9e8f'],
  ['team_product', 'product', 'Product', '#8a5cc2'],
  ['team_qa', 'qa', 'QA', '#c4793b'],
  ['team_design', 'design', 'Design', '#c2507a'],
  ['team_devops', 'devops', 'DevOps', '#5d7a3a'],
] as const;

export const users = [
  // id, email, name, role, departments
  ['u_pm', 'anna.sokolova@rafinad.test', 'Анна Соколова', 'product', ['dep_product']],
  ['u_sales', 'igor.petrov@rafinad.test', 'Игорь Петров', 'department_lead', ['dep_sales']],
  ['u_aff', 'maria.kuznetsova@rafinad.test', 'Мария Кузнецова', 'department_lead', ['dep_affiliates', 'dep_support']],
  ['u_fin', 'oleg.smirnov@rafinad.test', 'Олег Смирнов', 'department_lead', ['dep_finance']],
  ['u_af', 'dmitry.volkov@rafinad.test', 'Дмитрий Волков', 'department_lead', ['dep_antifraud']],
] as const;

export const epics = [
  // id, number, title, description, category, status, visibility, owner, start, end
  ['ep_1', 1, 'Новый кабинет вебмастера', 'Переработка личного кабинета: статистика, каталог офферов, инструменты и безопасность.', 'cat_webmasters', 'st_e_active', 'public', 'Анна Соколова', '2026-09-01', '2027-01-31'],
  ['ep_2', 2, 'Финансовый контур и выплаты', 'Быстрые и прозрачные выплаты вебмастерам, холды, сверка и документооборот.', 'cat_finance', 'st_e_active', 'public', 'Олег Смирнов', '2026-08-15', '2027-03-31'],
  ['ep_3', 3, 'Антифрод 2.0', 'Скоринг трафика в реальном времени, KYC и автоматические правила.', 'cat_antifraud', 'st_e_new', 'internal', 'Дмитрий Волков', '2026-12-01', '2027-03-31'],
  ['ep_4', 4, 'API и интеграции для рекламодателей', 'Постбеки, API v2, лимиты и онбординг рекламодателей.', 'cat_advertisers', 'st_e_active', 'public', 'Игорь Петров', '2026-09-01', '2027-02-28'],
  ['ep_5', 5, 'Аналитика и отчётность', 'Отчёты для бизнеса и вебмастеров, скорость статистики.', 'cat_analytics', 'st_e_new', 'public', 'Анна Соколова', null, null],
] as const;

type Est = Partial<Record<'team_backend' | 'team_frontend' | 'team_product' | 'team_qa' | 'team_design' | 'team_devops', number>>;
interface F {
  n: number;
  title: string;
  desc: string;
  cat: string;
  epic?: string;
  status: string;
  stage?: string;
  vis?: 'public' | 'internal' | 'draft';
  requested: string;
  created: string;
  est?: Est;
  votes?: Record<string, number>;
  tags?: string[];
  author?: string;
  assignee?: string;
  closed?: string;
  ext?: string;
}

const B = 'team_backend', FE = 'team_frontend', P = 'team_product', Q = 'team_qa', D = 'team_design', O = 'team_devops';

export const features: F[] = [
  { n: 1, title: 'Постбеки в реальном времени', desc: 'Передача статусов конверсий рекламодателю и вебмастеру без задержки: очередь, ретраи, подпись запросов, журнал доставки.', cat: 'cat_platform', epic: 'ep_4', status: 'st_f_progress', stage: 'stg_backend', vis: 'public', requested: '2026-06-10', created: '2026-06-10T09:00:00Z', est: { [B]: 60, [P]: 8, [Q]: 24, [O]: 16 }, votes: { dep_product: 5, dep_sales: 5, dep_affiliates: 4, dep_antifraud: 3 }, tags: ['postback', 'api'], author: 'Игорь Петров', assignee: 'Сергей Ковалёв', ext: 'RAF-412' },
  { n: 2, title: 'Новая статистика в кабинете вебмастера', desc: 'Статистика по SubID, креативам и площадкам; сохранённые фильтры; сравнение периодов.', cat: 'cat_webmasters', epic: 'ep_1', status: 'st_f_progress', stage: 'stg_frontend', vis: 'public', requested: '2026-06-18', created: '2026-06-18T10:00:00Z', est: { [B]: 80, [FE]: 120, [P]: 24, [Q]: 40, [D]: 40 }, votes: { dep_product: 5, dep_affiliates: 5, dep_sales: 3, dep_support: 4 }, tags: ['кабинет', 'статистика'], author: 'Мария Кузнецова', assignee: 'Алина Руденко' },
  { n: 3, title: 'Выплаты вебмастерам через СБП', desc: 'Выплата на карту по номеру телефона через СБП, лимиты, статусы и чеки.', cat: 'cat_finance', epic: 'ep_2', status: 'st_f_planned', stage: 'stg_product', vis: 'public', requested: '2026-07-02', created: '2026-07-02T08:30:00Z', est: { [B]: 100, [FE]: 40, [P]: 16, [Q]: 32, [O]: 16 }, votes: { dep_product: 4, dep_finance: 5, dep_affiliates: 5, dep_support: 4 }, tags: ['выплаты'], author: 'Олег Смирнов' },
  { n: 4, title: 'Автоматическая сверка конверсий с рекламодателем', desc: 'Загрузка реестров рекламодателя, автоматическое сопоставление и отчёт о расхождениях.', cat: 'cat_advertisers', epic: 'ep_4', status: 'st_f_ready', vis: 'public', requested: '2026-07-15', created: '2026-07-15T12:00:00Z', est: { [B]: 120, [FE]: 30, [P]: 24, [Q]: 40 }, votes: { dep_product: 4, dep_sales: 5, dep_finance: 4 }, tags: ['сверка'], author: 'Игорь Петров' },
  { n: 5, title: 'Антифрод-скоринг трафика в реальном времени', desc: 'Оценка каждого клика и лида по набору признаков; автоматическая блокировка подозрительных источников.', cat: 'cat_antifraud', epic: 'ep_3', status: 'st_f_analysis', stage: 'stg_product', vis: 'internal', requested: '2026-07-20', created: '2026-07-20T09:15:00Z', est: { [B]: 200, [P]: 40, [Q]: 40, [O]: 40 }, votes: { dep_antifraud: 5, dep_sales: 4, dep_product: 4, dep_finance: 3 }, tags: ['антифрод', 'ml'], author: 'Дмитрий Волков' },
  { n: 6, title: 'Двухфакторная аутентификация для вебмастеров', desc: 'TOTP и подтверждение входа по email; обязательная 2FA для смены реквизитов выплат.', cat: 'cat_security', epic: 'ep_1', status: 'st_f_ready', vis: 'public', requested: '2026-07-28', created: '2026-07-28T11:00:00Z', est: { [B]: 40, [FE]: 40, [P]: 8, [Q]: 16, [D]: 8 }, votes: { dep_product: 4, dep_support: 5, dep_antifraud: 4, dep_affiliates: 3 }, tags: ['безопасность'], author: 'Мария Кузнецова' },
  { n: 7, title: 'Каталог офферов: фильтры по ГЕО и типу трафика', desc: 'Фильтры каталога: ГЕО, разрешённые источники трафика, модель оплаты, холд.', cat: 'cat_webmasters', epic: 'ep_1', status: 'st_f_ready', vis: 'public', requested: '2026-08-03', created: '2026-08-03T10:00:00Z', est: { [B]: 30, [FE]: 60, [P]: 12, [Q]: 16, [D]: 24 }, votes: { dep_affiliates: 5, dep_sales: 4, dep_product: 3 }, tags: ['каталог'], author: 'Мария Кузнецова' },
  { n: 8, title: 'Генератор диплинков и smartlink', desc: 'Генерация ссылок на конкретные страницы оффера и smartlink с ротацией по ГЕО.', cat: 'cat_webmasters', epic: 'ep_1', status: 'st_f_ready', vis: 'public', requested: '2026-08-05', created: '2026-08-05T13:20:00Z', est: { [B]: 60, [FE]: 40, [P]: 16, [Q]: 24 }, votes: { dep_affiliates: 4, dep_sales: 3, dep_product: 4 }, tags: ['инструменты'], author: 'Анна Соколова' },
  { n: 9, title: 'Холд и автоапрув конверсий по правилам', desc: 'Настраиваемый холд по офферу и правила автоматического подтверждения конверсий.', cat: 'cat_finance', epic: 'ep_2', status: 'st_f_analysis', stage: 'stg_product', vis: 'public', requested: '2026-08-11', created: '2026-08-11T09:00:00Z', est: { [B]: 80, [FE]: 30, [P]: 24, [Q]: 24 }, votes: { dep_finance: 5, dep_antifraud: 4, dep_sales: 3 }, author: 'Олег Смирнов' },
  { n: 10, title: 'Мультивалютные балансы и выплаты', desc: 'Балансы в нескольких валютах, курсы и конвертация при выплате.', cat: 'cat_finance', epic: 'ep_2', status: 'st_f_new', vis: 'internal', requested: '2026-08-20', created: '2026-08-20T15:00:00Z', votes: { dep_finance: 3, dep_affiliates: 2 }, author: 'Олег Смирнов' },
  { n: 11, title: 'Уведомления в Telegram о статусах выплат', desc: 'Бот уведомляет вебмастера о создании, отправке и зачислении выплаты.', cat: 'cat_webmasters', epic: 'ep_2', status: 'st_f_ready', vis: 'public', requested: '2026-08-22', created: '2026-08-22T10:30:00Z', est: { [B]: 24, [P]: 8, [Q]: 8 }, votes: { dep_support: 5, dep_affiliates: 4, dep_finance: 2 }, tags: ['уведомления'], author: 'Мария Кузнецова' },
  { n: 12, title: 'API v2 для рекламодателей: офферы и статистика', desc: 'REST API с токенами доступа: управление офферами, статистика, лимиты запросов.', cat: 'cat_advertisers', epic: 'ep_4', status: 'st_f_ready', vis: 'public', requested: '2026-08-25', created: '2026-08-25T09:00:00Z', est: { [B]: 140, [P]: 24, [Q]: 40, [O]: 16 }, votes: { dep_sales: 5, dep_product: 4 }, tags: ['api'], author: 'Игорь Петров' },
  { n: 13, title: 'KYC-проверка вебмастеров при регистрации', desc: 'Проверка документов и самозанятости, ручная модерация спорных случаев.', cat: 'cat_security', epic: 'ep_3', status: 'st_f_ready', vis: 'internal', requested: '2026-09-01', created: '2026-09-01T08:00:00Z', est: { [B]: 60, [FE]: 40, [P]: 16, [Q]: 24, [D]: 16 }, votes: { dep_antifraud: 5, dep_finance: 4, dep_support: 3, dep_product: 3 }, tags: ['kyc'], author: 'Дмитрий Волков' },
  { n: 14, title: 'Отчёт по когортам и LTV для рекламодателей', desc: 'Когортный анализ по дате регистрации клиента, LTV по источникам трафика.', cat: 'cat_analytics', epic: 'ep_5', status: 'st_f_analysis', vis: 'public', requested: '2026-09-03', created: '2026-09-03T12:00:00Z', est: { [B]: 80, [FE]: 60, [P]: 24, [Q]: 16, [D]: 16 }, votes: { dep_sales: 4, dep_product: 3 }, author: 'Игорь Петров' },
  { n: 15, title: 'Реферальная программа для вебмастеров', desc: 'Вознаграждение за привлечённых вебмастеров, отдельная статистика рефералов.', cat: 'cat_webmasters', epic: 'ep_1', status: 'st_f_postponed', vis: 'public', requested: '2026-09-05', created: '2026-09-05T14:00:00Z', est: { [B]: 40, [FE]: 40, [P]: 16, [Q]: 16 }, votes: { dep_affiliates: 3, dep_sales: 2 }, author: 'Мария Кузнецова' },
  { n: 16, title: 'Ролевая модель для менеджеров рекламодателя', desc: 'Несколько пользователей у рекламодателя с разными правами: финансы, статистика, офферы.', cat: 'cat_advertisers', epic: 'ep_4', status: 'st_f_ready', vis: 'public', requested: '2026-09-08', created: '2026-09-08T10:00:00Z', est: { [B]: 50, [FE]: 50, [P]: 16, [Q]: 20, [D]: 12 }, votes: { dep_sales: 4, dep_support: 3, dep_product: 3 }, author: 'Игорь Петров' },
  { n: 17, title: 'Миграция трекинга на новый кластер БД', desc: 'Перенос трекинговых таблиц на новый кластер с шардированием по дате.', cat: 'cat_platform', status: 'st_f_progress', stage: 'stg_backend', vis: 'internal', requested: '2026-09-10', created: '2026-09-10T09:00:00Z', est: { [B]: 80, [Q]: 16, [O]: 80 }, votes: { dep_product: 4, dep_antifraud: 3 }, tags: ['инфраструктура'], author: 'Анна Соколова', assignee: 'Павел Никитин' },
  { n: 18, title: 'Публичная страница статуса платформы', desc: 'Страница доступности трекинга, кабинета и API с историей инцидентов.', cat: 'cat_platform', status: 'st_f_done', vis: 'public', requested: '2026-07-01', created: '2026-07-01T09:00:00Z', est: { [B]: 16, [FE]: 16, [O]: 16 }, votes: { dep_support: 4, dep_product: 3 }, closed: '2026-09-22', author: 'Мария Кузнецова', ext: 'RAF-530' },
  { n: 19, title: 'Креативы и лендинги: библиотека материалов', desc: 'Единая библиотека баннеров, текстов и лендингов по офферам с правами использования.', cat: 'cat_webmasters', epic: 'ep_1', status: 'st_f_ready', vis: 'public', requested: '2026-09-12', created: '2026-09-12T11:00:00Z', est: { [B]: 30, [FE]: 50, [P]: 8, [Q]: 16, [D]: 40 }, votes: { dep_affiliates: 4, dep_sales: 4, dep_product: 3 }, author: 'Мария Кузнецова' },
  { n: 20, title: 'Лимиты и капы по офферу в реальном времени', desc: 'Дневные и общие капы с автоматической остановкой трафика и уведомлениями.', cat: 'cat_advertisers', epic: 'ep_4', status: 'st_f_ready', vis: 'public', requested: '2026-09-15', created: '2026-09-15T09:30:00Z', est: { [B]: 70, [FE]: 20, [P]: 12, [Q]: 24 }, votes: { dep_sales: 5, dep_finance: 3, dep_affiliates: 3 }, author: 'Игорь Петров' },
  { n: 21, title: 'Сегментация вебмастеров для менеджеров', desc: 'Сегменты по качеству трафика и активности для персональной работы менеджеров.', cat: 'cat_analytics', epic: 'ep_5', status: 'st_f_new', vis: 'internal', requested: '2026-09-18', created: '2026-09-18T10:00:00Z', votes: { dep_affiliates: 3 }, author: 'Мария Кузнецова' },
  { n: 22, title: 'Экспорт выплат в 1С', desc: 'Выгрузка реестров выплат в формате 1С. Ждём утверждённый формат от бухгалтерии.', cat: 'cat_finance', epic: 'ep_2', status: 'st_f_blocked', vis: 'internal', requested: '2026-09-20', created: '2026-09-20T12:00:00Z', est: { [B]: 40, [P]: 8, [Q]: 8 }, votes: { dep_finance: 5 }, author: 'Олег Смирнов' },
  { n: 23, title: 'Тёмная тема в кабинете', desc: 'Тёмное оформление интерфейса кабинета вебмастера.', cat: 'cat_webmasters', epic: 'ep_1', status: 'st_f_new', vis: 'public', requested: '2026-09-25', created: '2026-09-25T16:00:00Z', est: { [FE]: 24, [D]: 16 }, author: 'Анна Соколова' },
  { n: 24, title: 'Ускорение загрузки статистики (кеш агрегатов)', desc: 'Предрасчёт агрегатов по часам и дням; цель — загрузка отчёта за 30 дней быстрее 1 секунды.', cat: 'cat_platform', epic: 'ep_5', status: 'st_f_ready', vis: 'public', requested: '2026-09-28', created: '2026-09-28T09:00:00Z', est: { [B]: 60, [Q]: 16, [O]: 24 }, votes: { dep_product: 5, dep_affiliates: 4, dep_support: 4 }, tags: ['производительность'], author: 'Анна Соколова' },
  { n: 25, title: 'Шаблоны договоров и закрывающих документов', desc: 'Генерация договоров и актов для вебмастеров-юрлиц.', cat: 'cat_finance', epic: 'ep_2', status: 'st_f_new', vis: 'draft', requested: '2026-10-02', created: '2026-10-02T10:00:00Z', est: { [B]: 40, [FE]: 24 }, author: 'Олег Смирнов' },
  { n: 26, title: 'Онбординг нового рекламодателя: мастер настройки оффера', desc: 'Пошаговая настройка оффера: цели, постбек, капы, креативы; проверка интеграции.', cat: 'cat_advertisers', epic: 'ep_4', status: 'st_f_analysis', vis: 'public', requested: '2026-10-05', created: '2026-10-05T11:00:00Z', est: { [B]: 40, [FE]: 60, [P]: 24, [Q]: 16, [D]: 24 }, votes: { dep_sales: 5, dep_support: 3, dep_product: 4 }, author: 'Игорь Петров' },
];

// blocks: [from, to] — "from blocks to"
export const blocks: [number, number][] = [
  [1, 5],
  [17, 5],
  [7, 8],
  [3, 11],
  [1, 20],
  [24, 14],
  [13, 5],
];
export const related: [number, number][] = [
  [2, 24],
  [4, 9],
  [12, 26],
];

export const releases = [
  // id, name, version, description, status, planned, actual, approved, visibility, features
  ['rel_0', 'Статус-страница', 'v3.3', 'Публичная страница статуса и мелкие улучшения.', 'st_r_released', '2026-09-24', '2026-09-24', true, 'public', [18]],
  ['rel_1', 'Выплаты и постбеки', 'v3.4', 'Постбеки в реальном времени и выплаты через СБП.', 'st_r_progress', '2026-11-25', null, true, 'public', [1, 3]],
  ['rel_2', 'Кабинет вебмастера 2.0', 'v3.5', 'Новая статистика, каталог офферов и 2FA.', 'st_r_planned', '2026-12-18', null, false, 'public', [2, 7, 6]],
  ['rel_3', 'Антифрод 2.0', 'v3.6', 'Скоринг трафика и KYC.', 'st_r_planned', '2027-02-20', null, false, 'internal', [5, 13]],
] as const;

export const comments = [
  [1, 'u_sales', 'Игорь Петров', 'Три крупных рекламодателя ждут постбеки до конца ноября — это условие продления контрактов.', '2026-09-02T10:00:00Z'],
  [3, 'u_fin', 'Олег Смирнов', 'Банк-партнёр подтвердил подключение к СБП с 1 ноября.', '2026-09-20T09:00:00Z'],
  [5, 'u_af', 'Дмитрий Волков', 'Нужны исторические данные о фроде за 6 месяцев для обучения модели.', '2026-09-25T12:00:00Z'],
  [22, 'u_fin', 'Олег Смирнов', 'Формат выгрузки согласуем с бухгалтерией до 20 октября.', '2026-10-01T15:00:00Z'],
] as const;
