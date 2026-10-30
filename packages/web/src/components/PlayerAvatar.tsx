import type { CSSProperties } from 'react';
import { resolveMedia } from '../lib/media';

/** What it takes to draw a player's avatar (`PlayerPublic` has all of it). */
export interface AvatarPlayer {
  color: string;
  icon: string;
  avatar: string | null;
}

/** A player's selfie in a circle, or their icon, ringed in their colour. */
export function PlayerAvatar({ player, size = 32, className }: { player: AvatarPlayer; size?: number; className?: string }) {
  const src = player.avatar ? resolveMedia(player.avatar) : undefined;
  return (
    <span
      className={`avatar${className ? ` ${className}` : ''}`}
      style={{ '--avatar-size': `${size}px`, '--avatar-color': player.color } as CSSProperties}
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" draggable={false} /> : <span className="avatar-icon">{player.icon}</span>}
    </span>
  );
}
