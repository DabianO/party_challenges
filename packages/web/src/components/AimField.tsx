import type { CSSProperties } from 'react';
import type { AimFieldNode } from '@challenge/contract';

const pct = (v: number) => `${Math.min(1, Math.max(0, v)) * 100}%`;

/**
 * A 16:9 field with a shared crosshair, its home base and floating targets (`aim-field`), for
 * the big screen. The crosshair glides between the positions the server sends; targets bob a
 * little on their own; a burst plays once where a target was hit, a flash at every shot.
 */
export function AimField({ node }: { node: AimFieldNode }) {
  return (
    <div className="aim-field" aria-hidden="true">
      <div className="aim-home" style={{ left: pct(node.home.x), top: pct(node.home.y), width: pct(node.home.size) }} />
      {node.targets.map((t, i) => (
        <div key={t.id} className="aim-target" style={{ left: pct(t.x), top: pct(t.y), width: pct(t.size), '--target-color': t.color, '--float-delay': `${-i * 1.3}s` } as CSSProperties}>
          <div className="balloon" />
        </div>
      ))}
      {(node.bursts ?? []).map((b) => (
        <div key={b.id} className="aim-burst" style={{ left: pct(b.x), top: pct(b.y), '--target-color': b.color ?? '#ffffff' } as CSSProperties}>
          <span className="aim-burst-ring" />
          <span className="aim-burst-text">{b.text}</span>
        </div>
      ))}
      {node.shot && (
        // A new id per shot: the flash plays once for every shot.
        <span key={node.shot.id} className="aim-shot" style={{ left: pct(node.shot.x), top: pct(node.shot.y) }}>
          <span className="aim-shot-flash" />
          <span className="aim-shot-ring" />
        </span>
      )}
      <svg className="aim-crosshair" style={{ left: pct(node.crosshair.x), top: pct(node.crosshair.y) }} viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="13" />
        <path d="M20 1v11M20 28v11M1 20h11M28 20h11" />
        <circle className="aim-dot" cx="20" cy="20" r="2" />
      </svg>
    </div>
  );
}
