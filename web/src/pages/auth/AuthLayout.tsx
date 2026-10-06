import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BrandMark } from '../../layout/Shell';

export function AuthLayout({ title, intro, children, wide, xwide }: { title: string; intro?: ReactNode; children: ReactNode; wide?: boolean; xwide?: boolean }) {
  return (
    <div className="auth-wrap">
      <main className="auth-card-outer" id="main">
        <div className={`auth-card${wide ? ' wide' : ''}${xwide ? ' xwide' : ''}`}>
          <BrandMark />
          <div className="stack-sm">
            <h1>{title}</h1>
            {intro ? <p className="muted">{intro}</p> : null}
          </div>
          {children}
          <p className="muted small">
            <Link to="/privacy">Privacy notice</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
