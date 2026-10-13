import { useEffect, useState } from 'react';
import { CubeMark } from '../icons';
import { api, invalidate, navigate, ROLE_LABEL, toast, useApi, useApp } from '../lib';
import { ErrorBox, Field, Notice, PageHead } from '../ui';
import { MyApiKeys } from './ApiKeys';

function Brand() {
  return (
    <div className="brand">
      <CubeMark size={32} />
      <div className="brand-name" style={{ fontSize: 17 }}>Rafinad<small>Продуктовый роадмап</small></div>
    </div>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = 'Вход — Rafinad Roadmap'; }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<any>('/auth/login', { method: 'POST', body: { email, password } });
      onDone();
      invalidate();
      navigate(r.must_change_password ? '/account' : '/');
    } catch (err) {
      setError(err as Error);
    }
    setBusy(false);
  };
  return (
    <div className="auth">
      <form className="auth-card stack" onSubmit={submit}>
        <Brand />
        <h1 style={{ fontSize: 18 }}>Вход для сотрудников</h1>
        <p className="small muted">Просматривать опубликованный роадмап можно без входа. Вход нужен, чтобы голосовать за отдел, комментировать и планировать.</p>
        <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Пароль"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <ErrorBox error={error} />
        <button className="btn primary" disabled={busy || !email || !password}>{busy ? 'Входим…' : 'Войти'}</button>
        <p className="small muted">Нет учётной записи или забыли пароль — обратитесь к администратору: регистрации нет, доступ выдаёт администратор.</p>
        <a className="small" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }} style={{ color: 'var(--beet)' }}>Смотреть опубликованный роадмап</a>
      </form>
    </div>
  );
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const info = useApi<any>(`/auth/invite/${encodeURIComponent(token)}`);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw !== pw2) { setError(new Error('Пароли не совпадают')); return; }
    try {
      await api('/auth/accept-invite', { method: 'POST', body: { token, password: pw } });
      onDone();
      invalidate();
      toast('Пароль установлен');
      navigate('/');
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <div className="auth">
      <form className="auth-card stack" onSubmit={submit}>
        <Brand />
        <h1 style={{ fontSize: 18 }}>Приглашение</h1>
        {info.error && <ErrorBox error={info.error} />}
        {info.data && (
          <>
            <p>{info.data.name}, придумайте пароль для входа под {info.data.email}.</p>
            <Field label="Новый пароль" hint="Не короче 10 символов, буквы и цифры"><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus /></Field>
            <Field label="Повторите пароль"><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
            <ErrorBox error={error} />
            <button className="btn primary" disabled={!pw || !pw2}>Сохранить и войти</button>
          </>
        )}
      </form>
    </div>
  );
}

export function Account() {
  const { me, meta, refreshMe } = useApp();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<Error | null>(null);
  if (!me) return <Notice kind="info">Войдите, чтобы открыть профиль.</Notice>;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw !== pw2) { setError(new Error('Пароли не совпадают')); return; }
    try {
      await api('/auth/change-password', { method: 'POST', body: { current_password: cur, new_password: pw } });
      toast('Пароль изменён');
      setCur(''); setPw(''); setPw2('');
      refreshMe();
      invalidate();
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <>
      <PageHead title="Профиль" />
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2>{me.name}</h2></div>
          <div className="panel-body">
            <dl className="dl">
              <dt>Email</dt><dd>{me.email}</dd>
              <dt>Роль</dt><dd>{ROLE_LABEL[me.role]}</dd>
              <dt>Голосую за отделы</dt><dd>{me.department_ids.map((id) => meta.departments.find((d) => d.id === id)?.name).filter(Boolean).join(', ') || '—'}</dd>
            </dl>
          </div>
        </section>
        <form className="panel" onSubmit={submit}>
          <div className="panel-head"><h2>Смена пароля</h2></div>
          <div className="panel-body stack">
            {me.must_change_password && <Notice kind="warn">Вы вошли с временным паролем. Задайте свой пароль, чтобы продолжить работу.</Notice>}
            <Field label="Текущий пароль"><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
            <Field label="Новый пароль" hint="Не короче 10 символов, буквы и цифры"><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
            <Field label="Повторите пароль"><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
            <ErrorBox error={error} />
            <div><button className="btn primary" disabled={!cur || !pw || !pw2}>Сменить пароль</button></div>
            <p className="small muted">После смены пароля остальные ваши сессии будут завершены.</p>
          </div>
        </form>
      </div>
      {!me.must_change_password && <MyApiKeys />}
    </>
  );
}
