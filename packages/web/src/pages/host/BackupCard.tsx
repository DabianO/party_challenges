import { useState } from 'react';
import { errorMessage } from '../../lib/api';
import { downloadSetup } from '../../lib/setupFile';
import type { HostCtx } from './hostApi';
import { StartOverButton } from './StartOverButton';

/** Saving is automatic; this offers a portable JSON copy of the setup as a backup. */
export function BackupCard({ ctx }: { ctx: HostCtx }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await downloadSetup(ctx.gameId, ctx.token, ctx.snapshot.game.name);
      ctx.toast('Setup file downloaded', 'success');
    } catch (e) {
      ctx.toast(errorMessage(e), 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack gap-sm" aria-label="Backup">
      <h2 className="section-title">Backup &amp; start over</h2>
      <p className="muted small">
        Every change is saved automatically on the server, so this game is still here after a restart. For extra safety, download the setup as a file: it holds the
        challenges, titles, settings, branding and uploaded images (not players or scores). Import it from the Host page to continue on any computer.
      </p>
      <div className="row gap-sm wrap">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void download()}>
          {busy ? 'Preparing…' : '⬇ Download setup (.json)'}
        </button>
        <StartOverButton ctx={ctx} />
      </div>
      <p className="field-help">
        “New game with this setup” starts a clean copy (new code, no players or scores), handy after a test run. This game is kept and can be continued later.
      </p>
    </section>
  );
}
