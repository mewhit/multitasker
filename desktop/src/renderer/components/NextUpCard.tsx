import React from 'react';

interface NextUpCardProps {
  key: string;
  nextUpKey: string;
  title: string;
  description?: string;
  source?: 'slack' | 'calendar' | 'manual' | 'session';
  onDone: (key: string) => void;
  onMove: (key: string, direction: 'up' | 'down') => void;
  onContextMenu?: (e: React.MouseEvent, key: string) => void;
}

export function NextUpCard({
  nextUpKey,
  title,
  description,
  source,
  onDone,
  onMove,
  onContextMenu,
}: NextUpCardProps) {
  return (
    <div
      className="next-up-card"
      data-next-up-key={nextUpKey}
      onContextMenu={(e) => onContextMenu?.(e, nextUpKey)}
      draggable
    >
      <div className="next-up-card-header">
        <h3 className="next-up-card-title">{title}</h3>
        {source && <span className="next-up-source-badge">{source.toUpperCase()}</span>}
      </div>

      {description && <p className="next-up-card-description">{description}</p>}

      <div className="next-up-card-actions">
        <button
          id="btn-next-up-move-up"
          className="btn-move-up"
          onClick={() => onMove(nextUpKey, 'up')}
          title="Move up"
        >
          ↑
        </button>
        <button
          id="btn-next-up-move-down"
          className="btn-move-down"
          onClick={() => onMove(nextUpKey, 'down')}
          title="Move down"
        >
          ↓
        </button>
        <button
          id="btn-next-up-done"
          className="btn-done"
          onClick={() => onDone(nextUpKey)}
          title="Mark as done"
        >
          ✓ Done
        </button>
      </div>
    </div>
  );
}
