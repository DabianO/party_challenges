import type { Availability, ChallengePhase, EvaluationMode, GameStatus, ResultsTiming, Tone } from '@challenge/contract';

/**
 * Instance phases as the host and display see them (§7 lifecycle):
 *  PENDING = not yet available, ACTIVE = players may start, LOCKED = closed by the host,
 *  EVALUATING = waiting on the host's resolution, RESULTS = final.
 */
const PHASES: Record<ChallengePhase, { label: string; tone: Tone; icon: string }> = {
  PENDING: { label: 'Locked', tone: 'muted', icon: '🔒' },
  ACTIVE: { label: 'Open', tone: 'success', icon: '▶' },
  LOCKED: { label: 'Closed', tone: 'warning', icon: '■' },
  EVALUATING: { label: 'Judging', tone: 'warning', icon: '⚖' },
  RESULTS: { label: 'Results', tone: 'primary', icon: '★' },
};

const STATUSES: Record<GameStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'muted' },
  LOBBY: { label: 'Lobby open', tone: 'primary' },
  IN_PROGRESS: { label: 'In progress', tone: 'success' },
  GAME_RESULTS: { label: 'Final results', tone: 'primary' },
  FINISHED: { label: 'Finished', tone: 'muted' },
};

const AVAILABILITY: Record<Availability, { label: string; icon: string; help: string }> = {
  open: { label: 'Open to all', icon: '👥', help: 'Every player can start this challenge once the game runs' },
  'host-unlocked': { label: 'Host unlocks', icon: '🔑', help: 'Hidden until you unlock it' },
  assigned: { label: 'Assigned', icon: '🎯', help: 'Only the chosen players see it' },
};

const EVALUATION: Record<EvaluationMode, { label: string; short: string; tone: Tone; icon: string; help: string }> = {
  automatic: { label: 'Scored automatically', short: 'Auto', tone: 'success', icon: '⚙', help: 'The module scores every answer itself' },
  peer: { label: 'Judged by a player', short: 'Peer', tone: 'primary', icon: '🙋', help: 'A random other player approves or rejects each submission' },
  host: { label: 'Judged by the host', short: 'Host', tone: 'warning', icon: '🎤', help: 'Submissions wait in your queue' },
  hybrid: { label: 'Player first, host backup', short: 'Hybrid', tone: 'primary', icon: '🙋🎤', help: 'Players judge; rejections and timeouts come to you' },
};

export function phaseLabel(phase: ChallengePhase): string {
  return PHASES[phase].label;
}

/**
 * Pass `availability` and whether the game has started to say *why* a PENDING challenge
 * is not playable: open/assigned ones open by themselves when the game starts.
 */
export function PhaseBadge({ phase, size, availability, started }: { phase: ChallengePhase; size?: 'lg'; availability?: Availability; started?: boolean }) {
  let { label, tone, icon } = PHASES[phase];
  if (phase === 'PENDING' && availability !== undefined) {
    if (availability === 'host-unlocked') ({ label, tone, icon } = { label: 'Hidden until you unlock it', tone: 'muted', icon: '🔑' });
    else if (!started) ({ label, tone, icon } = { label: 'Opens at start', tone: 'primary', icon: '⏰' });
    else ({ label, tone, icon } = { label: 'Hidden', tone: 'muted', icon: '🔒' });
  }
  return (
    <span className={`badge tone-${tone}${size ? ` badge-${size}` : ''}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: GameStatus }) {
  const { label, tone } = STATUSES[status];
  return <span className={`badge tone-${tone}`}>{label}</span>;
}

export function availabilityLabel(availability: Availability, assignedCount?: number): string {
  if (availability === 'assigned' && assignedCount !== undefined) return `Assigned to ${assignedCount}`;
  return AVAILABILITY[availability].label;
}

export function availabilityHelp(availability: Availability): string {
  return AVAILABILITY[availability].help;
}

export function AvailabilityBadge({ availability, assignedCount }: { availability: Availability; assignedCount?: number }) {
  const a = AVAILABILITY[availability];
  return (
    <span className="badge tone-muted" title={a.help}>
      <span aria-hidden="true">{a.icon}</span> {availabilityLabel(availability, assignedCount)}
    </span>
  );
}

export function evaluationLabel(mode: EvaluationMode): string {
  return EVALUATION[mode].label;
}

export function evaluationHelp(mode: EvaluationMode): string {
  return EVALUATION[mode].help;
}

export function EvaluationBadge({ mode, short = false }: { mode: EvaluationMode; short?: boolean }) {
  const e = EVALUATION[mode];
  return (
    <span className={`badge tone-${e.tone}`} title={e.help}>
      <span aria-hidden="true">{e.icon}</span> {short ? e.short : e.label}
    </span>
  );
}

export function resultsTimingLabel(timing: ResultsTiming): string {
  return timing === 'immediate' ? 'Scored on submit' : 'Scored when closed';
}

export function ResultsTimingBadge({ timing }: { timing: ResultsTiming }) {
  return (
    <span className="badge tone-muted" title={timing === 'immediate' ? 'Each submission is scored as soon as it locks' : 'Everyone is scored together when the host closes the challenge'}>
      <span aria-hidden="true">{timing === 'immediate' ? '⚡' : '⏳'}</span> {resultsTimingLabel(timing)}
    </span>
  );
}
