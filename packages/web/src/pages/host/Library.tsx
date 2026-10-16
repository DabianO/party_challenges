import type { ModuleInfo } from '@challenge/contract';
import { EvaluationBadge, ResultsTimingBadge, evaluationLabel } from '../../components/PhaseBadge';
import { formatDuration } from '../../lib/time';
import { supportedModesOf } from './InstanceOptionsFields';

const CATEGORY_ORDER = ['knowledge', 'skill', 'social', 'memory', 'chaos', 'other'];

function playersRange(p: { min: number; max: number | null }): string {
  if (p.max === null) return `${p.min}+ players`;
  if (p.max === p.min) return `${p.min} players`;
  return `${p.min}–${p.max} players`;
}

function snippet(text: string, max = 110): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function Library({ modules, onPick, onClose }: { modules: ModuleInfo[]; onPick: (m: ModuleInfo) => void; onClose: () => void }) {
  const groups = new Map<string, ModuleInfo[]>();
  for (const m of modules) {
    const list = groups.get(m.manifest.category) ?? [];
    list.push(m);
    groups.set(m.manifest.category, list);
  }
  const categories = [...groups.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

  return (
    <section className="library stack gap-md" aria-label="Challenge library">
      <div className="row align-center justify-between">
        <h2 className="section-title">Challenge library</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      {modules.length === 0 && <p className="muted">No challenge modules are installed on this server.</p>}
      {categories.map((cat) => (
        <div key={cat} className="stack gap-sm">
          <h3 className="eyebrow">{cat}</h3>
          <div className="library-grid">
            {(groups.get(cat) ?? []).map((m) => {
              const man = m.manifest;
              const supported = supportedModesOf(m);
              return (
                <button key={man.id} type="button" className="module-card" onClick={() => onPick(m)}>
                  <span className="module-name">{man.name}</span>
                  <span className="module-desc">{man.description}</span>
                  <span className="module-meta">
                    <span className="badge tone-muted">{playersRange(man.players)}</span>
                    <span className="badge tone-muted">~{formatDuration(man.duration.typicalSeconds)}</span>
                    <EvaluationBadge mode={man.evaluation.mode} />
                    <ResultsTimingBadge timing={man.results} />
                  </span>
                  {supported.length > 1 && (
                    <span className="module-caps">Also supports: {supported.filter((s) => s !== man.evaluation.mode).map((s) => evaluationLabel(s).toLowerCase()).join(', ')}</span>
                  )}
                  {man.evaluation.criteria && <span className="module-criteria">“{snippet(man.evaluation.criteria)}”</span>}
                  {man.capabilities.length > 0 && <span className="module-caps">{man.capabilities.join(' · ')}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
