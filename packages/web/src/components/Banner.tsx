import type { ReactNode } from 'react';
import type { SocketStatus } from '../lib/socket';

export type BannerTone = 'info' | 'warning' | 'danger' | 'success';

export function Banner({ tone = 'info', icon, children }: { tone?: BannerTone; icon?: string; children: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon && (
        <span className="banner-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="banner-text">{children}</span>
    </div>
  );
}

/** Shown while the real-time channel is not open (FR-35). */
export function ConnectionBanner({ status }: { status: SocketStatus }) {
  if (status === 'open' || status === 'closed') return null;
  return (
    <Banner tone="warning" icon="⟳">
      {status === 'connecting' ? 'Connecting…' : 'Connection lost — reconnecting…'}
    </Banner>
  );
}

export function PausedBanner({ paused }: { paused: boolean }) {
  if (!paused) return null;
  return (
    <Banner tone="info" icon="❙❙">
      Paused — the host will resume shortly
    </Banner>
  );
}
