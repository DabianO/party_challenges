import { useState, type FormEvent } from 'react';
import type { Branding, EvaluationPreference, GameSettings, TieBreak } from '@challenge/contract';
import { api, errorMessage } from '../../lib/api';
import { isHexColor } from '../../lib/branding';
import { useInternetMode } from '../../lib/display';
import { resolveMedia } from '../../lib/media';
import type { HostCtx } from './hostApi';

const TIE_BREAKS: { value: TieBreak; label: string; help: string }[] = [
  { value: 'shared', label: 'Shared', help: 'Tied players share the same rank' },
  { value: 'wins', label: 'Most wins', help: 'Ties go to whoever won more challenges' },
  { value: 'earliest', label: 'Earliest', help: 'Ties go to whoever joined first' },
];

/** FR-70 wording. */
const EVALUATION_PREFS: { value: EvaluationPreference; label: string; help: string }[] = [
  { value: 'module-default', label: 'Module default', help: 'Each challenge uses the mode its module declares.' },
  { value: 'automatic', label: 'Automatic where possible', help: 'Modules that can score themselves do; the rest keep their own mode.' },
  { value: 'peer', label: 'Random players (peer approval)', help: 'Another player judges each submission on their phone. You only step in on escalations.' },
  { value: 'host', label: 'Host', help: 'Every judged submission lands in your queue.' },
  { value: 'hybrid', label: 'Automatic + random players + host override (hybrid)', help: 'Players judge first; rejections and timeouts come to you.' },
];

const DEADLINE_MIN = 10;
const DEADLINE_MAX = 3600;
const REASSIGN_MIN = 0;
const REASSIGN_MAX = 10;
const STANDINGS_MAX = 240;

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function MediaPicker({ label, value, onChange, upload }: { label: string; value: string | undefined; onChange: (v: string | undefined) => void; upload: (f: File) => Promise<string> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const url = resolveMedia(value);
  return (
    <div className="form-field">
      <span className="field-label">{label}</span>
      {url && (
        <div className="media-preview">
          <img src={url} alt={`${label} preview`} />
        </div>
      )}
      <div className="row gap-sm wrap">
        <label className={`btn btn-secondary btn-sm${busy ? ' is-disabled' : ''}`}>
          {busy ? 'Uploading…' : value ? 'Replace' : 'Upload image'}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setBusy(true);
              setErr(null);
              try {
                onChange(await upload(file));
              } catch (x) {
                setErr(errorMessage(x));
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {value && (
          <button type="button" className="btn btn-danger btn-ghost btn-sm" onClick={() => onChange(undefined)}>
            Remove
          </button>
        )}
      </div>
      {err && (
        <p className="field-error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

export function GameSettingsForm({ ctx }: { ctx: HostCtx }) {
  const { game } = ctx.snapshot;
  const [name, setName] = useState(game.name);
  const [settings, setSettings] = useState<GameSettings>(game.settings);
  const [branding, setBranding] = useState<Branding>(game.branding);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const internet = useInternetMode();

  const setB = <K extends keyof Branding>(key: K, value: Branding[K]) => setBranding((b) => ({ ...b, [key]: value }));
  const setS = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => setSettings((s) => ({ ...s, [key]: value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (branding.accentColor && !isHexColor(branding.accentColor)) {
      setError('Accent colour must be a hex colour like #7048e8');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const cleaned: Branding = Object.fromEntries(Object.entries(branding).filter(([, v]) => v !== undefined && v !== '')) as Branding;
      await api.patchGame(ctx.gameId, ctx.token, { name: name.trim() || game.name, settings, branding: cleaned });
      ctx.toast('Settings saved', 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pref = EVALUATION_PREFS.find((p) => p.value === settings.evaluationPreference) ?? EVALUATION_PREFS[0]!;

  return (
    <form className="stack gap-lg" onSubmit={save}>
      <fieldset className="stack gap-md">
        <legend className="section-title">Game settings</legend>
        <label className="field">
          <span className="field-label">Game name</span>
          <input className="input" type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="toggle">
          <input type="checkbox" role="switch" checked={settings.allowLateJoin} onChange={(e) => setS('allowLateJoin', e.target.checked)} />
          <span className="toggle-track" aria-hidden="true">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">
            Allow late joining <span className="muted">({settings.allowLateJoin ? 'on' : 'off'})</span>
          </span>
        </label>
        <div className="form-field">
          <label className="field-label" htmlFor="tieBreak">
            Tie break
          </label>
          <select id="tieBreak" className="input" value={settings.tieBreak} onChange={(e) => setS('tieBreak', e.target.value as TieBreak)}>
            {TIE_BREAKS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="field-help">{TIE_BREAKS.find((t) => t.value === settings.tieBreak)?.help}</p>
        </div>
      </fieldset>

      <fieldset className="stack gap-md">
        <legend className="section-title">Big screen</legend>
        <label className="field field-compact">
          <span className="field-label">Update the race by itself every (minutes)</span>
          <input
            className="input"
            type="number"
            min={0}
            max={STANDINGS_MAX}
            step={1}
            inputMode="numeric"
            value={settings.standingsEveryMinutes}
            onChange={(e) => setS('standingsEveryMinutes', clampInt(e.target.valueAsNumber, 0, STANDINGS_MAX, settings.standingsEveryMinutes))}
          />
          <span className="field-help">
            0–{STANDINGS_MAX}. The graph and ranking on the big screen refresh this often while the game runs, counted from the last update (yours
            too). 0 = only when you press “Update the big screen”.
          </span>
        </label>
        <label className="toggle">
          <input type="checkbox" role="switch" checked={settings.publicDisplay} onChange={(e) => setS('publicDisplay', e.target.checked)} />
          <span className="toggle-track" aria-hidden="true">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">
            Share the big screen online <span className="muted">({settings.publicDisplay ? 'on' : 'off'})</span>
          </span>
        </label>
        <p className="field-help">
          {internet === false
            ? 'Only matters when the party is on the internet. On a Wi-Fi party, everyone on the network can open the big screen.'
            : 'On: anyone with the link (your domain /display/CODE) can watch the big screen, the leaderboard included, from anywhere. Off: only on this computer. Turning it off disconnects screens that are watching.'}
        </p>
      </fieldset>

      <fieldset className="stack gap-md">
        <legend className="section-title">Evaluation</legend>
        <div className="form-field">
          <span className="field-label" id="evalPref-label">
            Who evaluates challenges?
          </span>
          <div className="stack gap-xs" role="radiogroup" aria-labelledby="evalPref-label">
            {EVALUATION_PREFS.map((p) => {
              const selected = settings.evaluationPreference === p.value;
              return (
                <label key={p.value} className={`picker-row${selected ? ' is-checked' : ''}`}>
                  <input type="radio" name="evaluationPreference" value={p.value} checked={selected} onChange={() => setS('evaluationPreference', p.value)} />
                  <span className="grow">{p.label}</span>
                  <span aria-hidden="true" className="picker-check">
                    {selected ? '●' : '○'}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="field-help">{pref.help} Modules that support only one mode ignore this preference.</p>
        </div>
        <div className="row gap-md wrap">
          <label className="field field-compact grow">
            <span className="field-label">Judge deadline (seconds)</span>
            <input
              className="input"
              type="number"
              min={DEADLINE_MIN}
              max={DEADLINE_MAX}
              step={1}
              inputMode="numeric"
              value={settings.judgeDeadlineSeconds}
              onChange={(e) => setS('judgeDeadlineSeconds', clampInt(e.target.valueAsNumber, DEADLINE_MIN, DEADLINE_MAX, settings.judgeDeadlineSeconds))}
            />
            <span className="field-help">
              {DEADLINE_MIN}–{DEADLINE_MAX}. How long a player has to approve or reject before the task is reassigned.
            </span>
          </label>
          <label className="field field-compact grow">
            <span className="field-label">Max reassignments</span>
            <input
              className="input"
              type="number"
              min={REASSIGN_MIN}
              max={REASSIGN_MAX}
              step={1}
              inputMode="numeric"
              value={settings.maxReassignments}
              onChange={(e) => setS('maxReassignments', clampInt(e.target.valueAsNumber, REASSIGN_MIN, REASSIGN_MAX, settings.maxReassignments))}
            />
            <span className="field-help">
              {REASSIGN_MIN}–{REASSIGN_MAX}. After this many timeouts the submission escalates to you.
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className="stack gap-md">
        <legend className="section-title">Branding</legend>
        <label className="field">
          <span className="field-label">Host name</span>
          <input className="input" type="text" maxLength={60} value={branding.hostName ?? ''} onChange={(e) => setB('hostName', e.target.value)} />
        </label>
        <div className="form-field">
          <label className="field-label" htmlFor="accent">
            Accent colour
          </label>
          <div className="row gap-sm align-center">
            <input id="accent" type="color" className="color-input" value={isHexColor(branding.accentColor) ? branding.accentColor : '#7048e8'} onChange={(e) => setB('accentColor', e.target.value)} />
            <input className="input mono" type="text" aria-label="Accent colour hex" placeholder="#7048e8" value={branding.accentColor ?? ''} onChange={(e) => setB('accentColor', e.target.value)} />
            {branding.accentColor && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setB('accentColor', undefined)}>
                Reset
              </button>
            )}
          </div>
        </div>
        <div className="form-field">
          <span className="field-label">Theme</span>
          <div className="row gap-sm" role="radiogroup" aria-label="Theme">
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={(branding.theme ?? 'dark') === t}
                className={`btn btn-secondary btn-sm${(branding.theme ?? 'dark') === t ? ' is-selected' : ''}`}
                onClick={() => setB('theme', t)}
              >
                {(branding.theme ?? 'dark') === t ? '✓ ' : ''}
                {t}
              </button>
            ))}
          </div>
        </div>
        <MediaPicker label="Logo" value={branding.logo} onChange={(v) => setB('logo', v)} upload={ctx.upload} />
        <MediaPicker label="Background image" value={branding.background} onChange={(v) => setB('background', v)} upload={ctx.upload} />
        <label className="field">
          <span className="field-label">Intro text</span>
          <textarea className="input" rows={2} maxLength={300} value={branding.introText ?? ''} onChange={(e) => setB('introText', e.target.value)} />
          <span className="field-help">Shown in the lobby.</span>
        </label>
        <label className="field">
          <span className="field-label">Final text</span>
          <textarea className="input" rows={2} maxLength={300} value={branding.finalText ?? ''} onChange={(e) => setB('finalText', e.target.value)} />
          <span className="field-help">Shown on the final results screen.</span>
        </label>
      </fieldset>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}
