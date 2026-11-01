import { useRef, useState } from 'react';
import { PlayerAvatar } from '../../components/PlayerAvatar';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { loadImage, sizeOf } from '../../lib/images';
import type { PlayCtx } from '../Play';

/** Selfies are stored this many pixels square: plenty for a circle on the big screen. */
const SELFIE_SIZE = 320;

/** The middle square of a photo, upright and shrunk, as a JPEG ready to upload. */
async function squareSelfie(file: File): Promise<Blob> {
  const image = await loadImage(file);
  const { width, height } = sizeOf(image);
  const side = Math.min(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = SELFIE_SIZE;
  canvas.height = SELFIE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser cannot prepare the picture');
  ctx.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, SELFIE_SIZE, SELFIE_SIZE);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the picture'))), 'image/jpeg', 0.85));
}

/**
 * The player's picture: their icon, or a selfie they take here. The selfie is cropped to a
 * square and shrunk on the phone, then shown in a circle in the graphs and the player key.
 */
export function AvatarEditor({ ctx, compact = false }: { ctx: PlayCtx; compact?: boolean }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const me = ctx.snapshot.players.find((p) => p.id === ctx.meId);
  if (!me) return null;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await ctx.uploadAvatar(await squareSelfie(file));
      toast('Looking good! Your picture is on the big screen.', 'success');
    } catch (e) {
      toast(errorMessage(e), 'danger');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await ctx.removeAvatar();
    } catch (e) {
      toast(errorMessage(e), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`avatar-editor${compact ? ' is-compact' : ''}`}>
      <PlayerAvatar player={me} size={compact ? 56 : 88} />
      <div className="stack gap-xs grow">
        {!compact && <strong>{me.avatar ? 'Your picture' : 'Add your face'}</strong>}
        <span className="muted small">
          {me.avatar ? 'Shown next to your name in the graphs on the big screen.' : `Take a selfie, or keep your ${me.icon} icon. It shows next to your name on the big screen.`}
        </span>
        <div className="row gap-sm wrap">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Uploading…' : me.avatar ? '📷 New selfie' : '📷 Take a selfie'}
          </button>
          {me.avatar && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void remove()}>
              Use my {me.icon} icon
            </button>
          )}
        </div>
      </div>
      <input ref={input} className="sr-only" type="file" accept="image/*" capture="user" tabIndex={-1} onChange={(e) => void pick(e.target.files?.[0])} />
    </div>
  );
}
