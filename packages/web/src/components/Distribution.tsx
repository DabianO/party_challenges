import type { DistributionNode } from '@challenge/contract';

/**
 * How a group answered on a scale: columns as tall as their share of the answers, with the
 * share on top, labels underneath, words along the axis and an optional marker (the average).
 */
export function Distribution({ node }: { node: DistributionNode }) {
  const counts = node.columns.map((c) => Math.max(0, c.count));
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  const marker = node.marker && Number.isFinite(node.marker.at) ? { ...node.marker, at: Math.min(1, Math.max(0, node.marker.at)) } : null;
  // Compact: only the tallest column says how big its share is.
  const showShare = (count: number) => count > 0 && (!node.compact || count === max);
  return (
    <figure className={`ui-distribution${marker ? ' has-marker' : ''}${node.compact ? ' is-compact' : ''}`} aria-label={`${total} answers`}>
      <div className="ui-dist-plot">
        {node.columns.map((col, i) => {
          const share = total > 0 ? Math.round((counts[i]! / total) * 100) : 0;
          return (
            <div key={i} className={`ui-dist-col tone-${col.tone ?? 'primary'}${node.highlight === i ? ' is-highlight' : ''}`} title={`${col.label}: ${counts[i]}`}>
              <span className="ui-dist-share mono">{showShare(counts[i]!) ? `${share}%` : ''}</span>
              <span className="ui-dist-bar" style={{ height: `${(counts[i]! / max) * 100}%` }} />
            </div>
          );
        })}
        {marker && (
          <div className="ui-dist-marker" style={{ left: `${marker.at * 100}%` }}>
            <span className="ui-dist-marker-label">{marker.label}</span>
          </div>
        )}
      </div>
      {!node.compact && (
        <div className="ui-dist-labels" aria-hidden="true">
          {node.columns.map((col, i) => (
            <span key={i} className={node.highlight === i ? 'is-highlight' : undefined}>
              {col.label}
            </span>
          ))}
        </div>
      )}
      {node.axis && (
        <figcaption className="ui-dist-axis">
          <span>{node.axis.start ?? ''}</span>
          <span>{node.axis.middle ?? ''}</span>
          <span>{node.axis.end ?? ''}</span>
        </figcaption>
      )}
    </figure>
  );
}
