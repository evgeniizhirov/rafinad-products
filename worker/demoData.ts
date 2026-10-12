// Demonstration spreadsheet (same layout as the Google Sheets template).
// Used by the "demo CSV source" and served as downloadable templates — lets you test the import
// without any Google credentials. The files in /samples are generated from these strings.

export const DEMO_SHEETS: Record<'epics' | 'features' | 'offers' | 'relations', string> = {
  epics: [
    'external_id,title,description,category,status,visibility',
    'GS-EP-10,Мобильное приложение вебмастера,"Нативное приложение iOS/Android: статистика, уведомления о конверсиях, выплаты.",Вебмастерам,Идея,internal',
    'GS-EP-11,Аналитика и отчётность,Сводные отчёты для бизнеса и вебмастеров.,Аналитика,В работе,public',
  ].join('\r\n'),
  offers: [
    'external_id,name,description,category,status,visibility',
    'OF-2051,Кредитная карта «Платина 120 дней»,"Обновлённые условия: 120 дней без процентов, кэшбэк 5%.",Рекламодателям,Активен,public',
    'OF-3010,Страхование ипотеки онлайн,Полис для заёмщиков любых банков.,Рекламодателям,Подготовка к запуску,internal',
    'OF-3011,Онлайн-курс «Аналитик данных»,"CPA за оплату первого месяца, холд 30 дней.",Рекламодателям,Подготовка к запуску,internal',
  ].join('\r\n'),
  features: [
    'external_id,title,description,category,epic_external_id,status,stage,requested_at,backend_hours,frontend_hours,product_hours,qa_hours,design_hours,devops_hours,visibility',
    'GS-101,Push-уведомления о новых конверсиях,"Мгновенные push в мобильном приложении при одобрении/отклонении лида.",Вебмастерам,GS-EP-10,Новая,Product,2026-09-28,40,0,16,16,24,8,internal',
    'GS-102,Экран статистики в мобильном приложении,"Графики по дням, фильтры по офферам и SubID.",Вебмастерам,GS-EP-10,Новая,Design,2026-09-30,24,0,12,16,32,,internal',
    'GS-103,Авторизация в приложении по биометрии,Face ID / Touch ID поверх 2FA.,Безопасность,GS-EP-10,Новая,,2026-10-01,16,,8,8,8,,internal',
    'GS-104,Конструктор отчётов для рекламодателя,"Сохранённые отчёты, выгрузка в XLSX, расписание отправки на почту.",Аналитика,GS-EP-11,На проработке,Product,15.09.2026,80,60,24,24,16,,public',
    'GS-105,Ежедневная сводка по офферу в Telegram,Бот присылает сводку конверсий и выплат по офферу.,Рекламодателям,,Новая,,2026-10-05,24,,8,8,,4,internal',
    'GS-106,Постбеки в реальном времени,"Дубль существующей задачи — должен попасть в «подозрение на дубль».",Платформа,,Новая,,2026-10-06,40,,8,16,,8,internal',
    'GS-107,Экспорт отчётов в Google Sheets,"Вебмастер подключает свою таблицу и получает выгрузку статистики.",Аналитика,GS-EP-11,Новая,,2026-10-07,32,24,8,12,,,internal',
  ].join('\r\n'),
  relations: [
    'from_type,from_external_id,relation_type,to_type,to_external_id',
    'feature,GS-101,blocks,feature,GS-102',
    'feature,GS-103,blocks,feature,GS-101',
    'feature,GS-104,affects_offer,offer,OF-3011',
    'feature,GS-105,affects_offer,offer,OF-2051',
    'feature,GS-107,related_to,feature,GS-104',
    'feature,GS-105,belongs_to_epic,epic,GS-EP-11',
  ].join('\r\n'),
};
