import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { formatBytes, formatSaving } from '../lib/format.ts';
import type { ImageItem } from '../lib/types.ts';
import { cx } from './ui.tsx';

export function FileList({
  items,
  selectedId,
  onSelect,
  onRemove,
}: {
  items: ImageItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <ul className="space-y-1 p-2" role="listbox" aria-label="Pictures">
      {items.map((it) => {
        const r = it.result;
        const after = r?.bytes.byteLength;
        const pct = after !== undefined ? 1 - after / it.file.size : 0;
        const selected = it.id === selectedId;
        return (
          <li key={it.id} role="option" aria-selected={selected}>
            <div
              onClick={() => onSelect(it.id)}
              className={cx(
                'group relative flex cursor-pointer items-center gap-3 rounded-xl p-2 pr-8 transition-colors',
                selected ? 'bg-brand/12 ring-1 ring-brand/40' : 'hover:bg-panel-2',
              )}
            >
              <div className="checker relative h-12 w-12 shrink-0 overflow-hidden rounded-lg ring-1 ring-line">
                {it.thumbUrl && <img src={it.thumbUrl} alt="" className="h-full w-full object-cover" draggable={false} />}
                {(it.status === 'working' || it.status === 'queued') && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/35">
                    <Loader2 size={16} className={cx('text-white', it.status === 'working' && 'animate-spin')} />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium" title={it.relativePath}>
                  {it.file.name}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] tabular-nums text-muted">
                  <span>{formatBytes(it.file.size)}</span>
                  {after !== undefined && (
                    <>
                      <span className="text-faint">→</span>
                      <span className="text-fg/90">{formatBytes(after)}</span>
                    </>
                  )}
                </div>
                {after !== undefined && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                    <div
                      className={cx('h-full rounded-full', pct > 0 ? 'brand-gradient' : 'bg-warn')}
                      style={{ width: `${Math.max(3, Math.min(100, Math.abs(pct) * 100))}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="flex w-12 shrink-0 flex-col items-end gap-1">
                {it.status === 'error' ? (
                  <span title={it.error}>
                    <AlertCircle size={16} className="text-bad" />
                  </span>
                ) : after !== undefined ? (
                  <>
                    <span className={cx('text-[12.5px] font-semibold tabular-nums', pct > 0 ? 'text-good' : 'text-warn')}>
                      {r?.keptOriginal ? '0%' : formatSaving(it.file.size, after)}
                    </span>
                    {it.status === 'done' && <CheckCircle2 size={12} className="text-faint" />}
                  </>
                ) : null}
              </div>
              <button
                type="button"
                title="Remove"
                aria-label={`Remove ${it.file.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(it.id);
                }}
                className="absolute right-1.5 top-1.5 rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-panel-2 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X size={13} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
