import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { CubeMark, I } from './icons';
import { AppCtx, mutate, navigate, ROLE_LABEL, useApi, useLocation, type Me, type Meta } from './lib';
import { Admin } from './pages/Admin';
import { AcceptInvite, Account, Login } from './pages/Auth';
import { Backlog } from './pages/Backlog';
import { Epics } from './pages/Epics';
import { FeatureDrawer } from './pages/FeatureDrawer';
import { OfferDetail, Offers } from './pages/Offers';
import { Overview } from './pages/Overview';
import { Priorities } from './pages/Priorities';
import { ReleaseDetail, Releases } from './pages/Releases';
import { Calendar } from './pages/Calendar';
import { Analytics } from './pages/Analytics';
import { Budget } from './pages/Budget';
import { Roadmap } from './pages/Roadmap';
import { Sync } from './pages/Sync';
import { Avatar, Empty, Loading, Toasts } from './ui';
import './styles.css';

function Link({ to, children, className, onClick }: { to: string; children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); onClick?.(); navigate(to); }}>
      {children}
    </a>
  );
}

const NAV = [
  { to: '/', label: 'Обзор', icon: I.overview },
  { to: '/backlog', label: 'Бэклог', icon: I.backlog },
  { to: '/epics', label: 'Эпики', icon: I.epics },
  { to: '/offers', label: 'Офферы', icon: I.offers },
  { to: '/priorities', label: 'Приоритеты', icon: I.priorities },
  { to: '/roadmap', label: 'Роадмап', icon: I.roadmap },
  { to: '/releases', label: 'Релизы', icon: I.releases },
  { to: '/calendar', label: 'Спринты', icon: I.calendar },
  { to: '/budget', label: 'Бюджет', icon: I.priorities, plan: true },
  { to: '/analytics', label: 'Аналитика', icon: I.analytics, member: true },
];

function Sidebar({ me, open, onNavigate }: { me: Me | null; open: boolean; onNavigate: () => void }) {
  const { path } = useLocation();
  const active = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));
  return (
    <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Разделы">
      <div className="brand">
        <CubeMark />
        <div className="brand-name">Rafinad<small>Продуктовый роадмап</small></div>
      </div>
      <div className="nav">
        {NAV.filter((n) => (!(n as { plan?: boolean }).plan || me?.permissions.plan) && (!(n as { member?: boolean }).member || !!me)).map((n) => (
          <Link key={n.to} to={n.to} className={active(n.to) ? 'active' : ''} onClick={onNavigate}>
            <n.icon />{n.label}
          </Link>
        ))}
        {me && (me.permissions.import || me.permissions.admin) && <div className="nav-group">Управление</div>}
        {me?.permissions.import && <Link to="/sync" className={active('/sync') ? 'active' : ''} onClick={onNavigate}><I.sync />Синхронизация</Link>}
        {me?.permissions.admin && <Link to="/admin" className={active('/admin') ? 'active' : ''} onClick={onNavigate}><I.admin />Администрирование</Link>}
      </div>
      <div className="sidebar-foot">
        {me ? (
          <div className="stack tight">
            <Link to="/account" className="userbox" onClick={onNavigate}>
              <Avatar name={me.name} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 500 }}>{me.name}</div>
                <div className="small muted ellipsis">{ROLE_LABEL[me.role]}</div>
              </div>
            </Link>
            <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={async () => { await mutate('/auth/logout', 'POST', {}); location.href = '/'; }}>
              <I.logout />Выйти
            </button>
          </div>
        ) : (
          <Link to="/login" className="btn primary" onClick={onNavigate}>Войти</Link>
        )}
      </div>
    </nav>
  );
}

function Routes() {
  const { path } = useLocation();
  const seg = path.split('/').filter(Boolean);
  if (path === '/') return <Overview />;
  switch (seg[0]) {
    case 'backlog': return <Backlog />;
    case 'epics': return <Epics />;
    case 'offers': return seg[1] ? <OfferDetail id={seg[1]} /> : <Offers />;
    case 'priorities': return <Priorities />;
    case 'roadmap': return <Roadmap />;
    case 'releases': return seg[1] ? <ReleaseDetail id={seg[1]} /> : <Releases />;
    case 'calendar': return <Calendar />;
    case 'budget': return <Budget />;
    case 'analytics': return <Analytics />;
    case 'sync': return <Sync />;
    case 'admin': return <Admin />;
    case 'account': return <Account />;
    default: return <Empty title="Страница не найдена"><a href="/" style={{ color: 'var(--beet)' }}>На обзор</a></Empty>;
  }
}

function App() {
  const meQ = useApi<{ user: Me | null }>('/auth/me');
  const metaQ = useApi<Meta>('/meta');
  const { path } = useLocation();
  const [menu, setMenu] = useState(false);
  const me = meQ.data?.user ?? null;

  // a temporary password must be replaced before working
  useEffect(() => {
    if (me?.must_change_password && path !== '/account') navigate('/account', true);
  }, [me, path]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  if (path === '/login') return <Login onDone={() => { meQ.reload(); metaQ.reload(); }} />;
  if (path.startsWith('/invite/')) return <AcceptInvite token={path.split('/')[2]} onDone={() => meQ.reload()} />;
  if (!metaQ.data || meQ.loading && !meQ.data) {
    return (
      <div className="auth">
        {metaQ.error ? <Empty title="Сервис недоступен">{metaQ.error.message}</Empty> : <div style={{ width: 280 }}><Loading rows={3} /></div>}
      </div>
    );
  }
  return (
    <AppCtx.Provider value={{ me, meta: metaQ.data, refreshMe: meQ.reload }}>
      <div className="shell">
        <Sidebar me={me} open={menu} onNavigate={() => setMenu(false)} />
        {menu && <div className="scrim" style={{ zIndex: 49 }} onClick={() => setMenu(false)} />}
        <div style={{ minWidth: 0 }}>
          <div className="topbar-mobile">
            <button className="btn ghost icon" onClick={() => setMenu(true)} aria-label="Меню"><I.menu /></button>
            <CubeMark size={22} />
            <b style={{ fontFamily: 'var(--display)', fontWeight: 600 }}>Rafinad</b>
          </div>
          <main className="main">
            <Routes />
          </main>
        </div>
      </div>
      <FeatureDrawer />
      <Toasts />
    </AppCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
