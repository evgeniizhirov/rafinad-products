import type { ReactNode } from 'react';

const S = ({ children, ...p }: { children: ReactNode; [k: string]: any }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    {children}
  </svg>
);

export const I = {
  overview: (p: any) => <S {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></S>,
  backlog: (p: any) => <S {...p}><path d="M8 6h13M8 12h13M8 18h13" /><rect x="3" y="4.5" width="3" height="3" rx=".8" /><rect x="3" y="10.5" width="3" height="3" rx=".8" /><rect x="3" y="16.5" width="3" height="3" rx=".8" /></S>,
  epics: (p: any) => <S {...p}><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 13 9 5 9-5" /></S>,
  priorities: (p: any) => <S {...p}><rect x="3" y="14" width="5" height="7" rx="1" /><rect x="10" y="9" width="5" height="12" rx="1" /><rect x="17" y="4" width="5" height="17" rx="1" /></S>,
  roadmap: (p: any) => <S {...p}><path d="M3 6h7M3 12h12M3 18h5" /><path d="M14 6h7M19 12h2M12 18h9" /></S>,
  analytics: (p: any) => <S {...p}><path d="M3 21h18" /><rect x="5" y="11" width="3" height="7" rx=".8" /><rect x="10.5" y="6" width="3" height="12" rx=".8" /><rect x="16" y="13" width="3" height="5" rx=".8" /></S>,
  idea: (p: any) => <S {...p}><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2V16h5v-.2c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3Z" /></S>,
  calendar: (p: any) => <S {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></S>,
  releases: (p: any) => <S {...p}><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></S>,
  sync: (p: any) => <S {...p}><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" /><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></S>,
  admin: (p: any) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></S>,
  search: (p: any) => <S {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></S>,
  plus: (p: any) => <S {...p}><path d="M12 5v14M5 12h14" /></S>,
  x: (p: any) => <S {...p}><path d="M18 6 6 18M6 6l12 12" /></S>,
  chevron: (p: any) => <S {...p}><path d="m9 6 6 6-6 6" /></S>,
  lock: (p: any) => <S {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></S>,
  eye: (p: any) => <S {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></S>,
  eyeOff: (p: any) => <S {...p}><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6" /></S>,
  draft: (p: any) => <S {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></S>,
  alert: (p: any) => <S {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></S>,
  info: (p: any) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></S>,
  check: (p: any) => <S {...p}><path d="M20 6 9 17l-5-5" /></S>,
  link: (p: any) => <S {...p}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></S>,
  logout: (p: any) => <S {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></S>,
  menu: (p: any) => <S {...p}><path d="M4 6h16M4 12h16M4 18h16" /></S>,
  sheet: (p: any) => <S {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></S>,
  upload: (p: any) => <S {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></S>,
  download: (p: any) => <S {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></S>,
  file: (p: any) => <S {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></S>,
  user: (p: any) => <S {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></S>,
  board: (p: any) => <S {...p}><rect x="3" y="3" width="5" height="18" rx="1.5" /><rect x="10" y="3" width="5" height="12" rx="1.5" /><rect x="17" y="3" width="4" height="8" rx="1.5" /></S>,
  table: (p: any) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M10 10v10" /></S>,
  chain: (p: any) => <S {...p}><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" /></S>,
  merge: (p: any) => <S {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M6 8.5v7M8.3 7.2C12 9 13 12 15.5 12" /></S>,
};

/** Rafinad sugar-cube mark */
export function CubeMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="cube-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3 28 9.5v13L16 29 4 22.5v-13Z" fill="#8c1d4f" />
      <path d="M16 3 28 9.5 16 16 4 9.5Z" fill="#b14f7c" />
      <path d="M16 16v13l12-6.5v-13Z" fill="#6e1440" />
      <path d="M9.5 6.5 21.5 13M13 4.8 25 11.2" stroke="#f0d6e2" strokeOpacity=".35" strokeWidth="1" />
    </svg>
  );
}
