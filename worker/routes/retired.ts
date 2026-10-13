// vNext v2-10 (owner decision 13.10 №11): the old planning periods, the period auto-planner, plan alerts and the
// «Роадмап» by periods were removed (migration 0018). Their routes answer 410 Gone with a hint, so an old client or
// an integration gets a clear answer instead of a 404. Planning lives in sprints: «Планировщик», «Бюджет», «Обзор».
import { HttpError, type Router } from '../lib/http';

const gone = () => {
  throw new HttpError(410, 'gone', 'Плановые периоды и старый автопланировщик удалены: планирование ведётся по спринтам — разделы «Планировщик», «Бюджет» и Гант в «Обзоре».');
};

export function registerRetiredRoutes(r: Router) {
  r.get('/api/roadmap', gone);
  r.get('/api/planning', gone);
  r.put('/api/planning/capacity', gone);
  r.post('/api/planning/propose', gone);
  r.get('/api/planning/runs/:id', gone);
  r.post('/api/planning/runs/:id/discard', gone);
  r.post('/api/planning/runs/:id/approve', gone);
  r.get('/api/planning/alerts', gone);
  r.post('/api/planning/alerts/:id/resolve', gone);
  r.patch('/api/features/:id/placement', gone);
}
