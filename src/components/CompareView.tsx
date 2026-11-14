import { Columns2, Download, Eye, Maximize, Minus, Plus, ScanSearch } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatBytes, formatSaving } from '../lib/format.ts';
import type { ImageItem } from '../lib/types.ts';
import { Button, cx, Kbd, Segmented } from './ui.tsx';

type ViewMode = 'split' | 'original' | 'result';

export function qualityLabel(ssim: number): { text: string; tone: string } {
  if (!Number.isFinite(ssim)) return { text: '–', tone: 'text-muted' };
  if (ssim >= 0.995) return { text: 'Identical', tone: 'text-good' };
  if (ssim >= 0.985) return { text: 'Excellent', tone: 'text-good' };
  if (ssim >= 0.97) return { text: 'Very good', tone: 'text-good' };
  if (ssim >= 0.94) return { text: 'Good', tone: 'text-warn' };
  if (ssim >= 0.9) return { text: 'Fair', tone: 'text-warn' };
  return { text: 'Visible loss', tone: 'text-bad' };
}

export function CompareView({ item, onSave }: { item: ImageItem; onSave: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [boxSize, setBoxSize] = useState({ w: 800, h: 600 });
  const [split, setSplit] = useState(50);
  const [mode, setMode] = useState<ViewMode>('split');
  const [peek, setPeek] = useState(false);
  // View transform: zoom 1 = actual pixels.
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0, fit: true });
  const drag = useRef<{ kind: 'pan' | 'split'; sx: number; sy: number; ox: number; oy: number } | null>(null);

  const r = item.result;
  // Until the first result arrives, the original's own size (from the <img>) sets the frame.
  const [natural, setNatural] = useState<{ id: string; w: number; h: number } | null>(null);
  const nat = natural?.id === item.id ? natural : null;
  const w = r?.sourceWidth ?? item.width ?? nat?.w ?? 1;
  const h = r?.sourceHeight ?? item.height ?? nat?.h ?? 1;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBoxSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fitZoom = Math.min((boxSize.w - 48) / w, (boxSize.h - 48) / h, 1);
  const zoom = view.fit ? fitZoom : view.zoom;
  const ox = view.fit ? 0 : view.x;
  const oy = view.fit ? 0 : view.y;

  // A different picture starts fitted.
  useEffect(() => setView((v) => ({ ...v, fit: true, x: 0, y: 0 })), [item.id]);

  const zoomTo = useCallback(
    (z: number, cx?: number, cy?: number) => {
      const nz = Math.max(0.05, Math.min(16, z));
      setView(() => {
        // Keep the point under the cursor still.
        const px = cx ?? 0;
        const py = cy ?? 0;
        const k = nz / zoom;
        return { fit: false, zoom: nz, x: px - (px - ox) * k, y: py - (py - oy) * k };
      });
    },
    [zoom, ox, oy],
  );

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      zoomTo(zoom * Math.exp(-e.deltaY * 0.0015), cx, cy);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, zoomTo]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, select, textarea')) return;
      if (e.key === ' ') {
        e.preventDefault();
        setPeek(true);
      } else if (e.key === '0') setView((v) => ({ ...v, fit: true }));
      else if (e.key === '1') zoomTo(1);
      else if (e.key === '+' || e.key === '=') zoomTo(zoom * 1.25);
      else if (e.key === '-') zoomTo(zoom / 1.25);
    };
    const up = (e: KeyboardEvent) => e.key === ' ' && setPeek(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [zoom, zoomTo]);

  const splitX = boxSize.w / 2 + ox - (w * zoom) / 2 + (w * zoom * split) / 100;

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = box.current!.getBoundingClientRect();
    const nearSplit = mode === 'split' && Math.abs(e.clientX - rect.left - splitX) < 18;
    drag.current = { kind: nearSplit ? 'split' : 'pan', sx: e.clientX, sy: e.clientY, ox, oy };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'split') {
      const rect = box.current!.getBoundingClientRect();
      const left = rect.width / 2 + ox - (w * zoom) / 2;
      setSplit(Math.max(0, Math.min(100, ((e.clientX - rect.left - left) / (w * zoom)) * 100)));
    } else {
      setView({ fit: false, zoom, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy });
    }
  };
  const onPointerUp = () => (drag.current = null);

  const showMode: ViewMode = peek ? 'original' : mode;
  const imgStyle: React.CSSProperties = {
    width: w * zoom,
    height: h * zoom,
    left: boxSize.w / 2 + ox - (w * zoom) / 2,
    top: boxSize.h / 2 + oy - (h * zoom) / 2,
    imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
  };

  const label = r ? qualityLabel(r.ssim) : null;
  const working = item.status === 'working' || item.status === 'queued';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={box}
        className={cx('checker relative min-h-0 flex-1 overflow-hidden touch-none', drag.current?.kind === 'pan' ? 'cursor-grabbing' : 'cursor-grab')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => (view.fit ? zoomTo(1) : setView((v) => ({ ...v, fit: true })))}
      >
        {item.originalUrl && (
          <img
            src={item.originalUrl}
            alt="Original"
            draggable={false}
            onLoad={(e) => setNatural({ id: item.id, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} className="pointer-events-none absolute max-w-none select-none" style={imgStyle} />
        )}
        {item.resultUrl && showMode !== 'original' && (
          <img
            src={item.resultUrl}
            alt="Compressed"
            draggable={false}
            className="pointer-events-none absolute max-w-none select-none"
            style={{
              ...imgStyle,
              clipPath: showMode === 'split' ? `inset(0 0 0 ${split}%)` : undefined,
            }}
          />
        )}

        {showMode === 'split' && item.resultUrl && (
          <div className="pointer-events-none absolute top-0 bottom-0" style={{ left: splitX }}>
            <div className="absolute inset-y-0 -left-px w-0.5 bg-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.25)]" />
            <div className="absolute top-1/2 -left-4 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white text-slate-900 shadow-lg">
              <Columns2 size={15} />
            </div>
          </div>
        )}

        {/* Corner labels */}
        <div className="pointer-events-none absolute left-3 top-3 flex gap-2">
          <span className="rounded-lg bg-black/55 px-2.5 py-1 text-[11.5px] font-medium text-white backdrop-blur">
            Original · {formatBytes(item.file.size)}
          </span>
        </div>
        {showMode !== 'original' && r && (
          <div className="pointer-events-none absolute right-3 top-3">
            <span className="rounded-lg bg-black/55 px-2.5 py-1 text-[11.5px] font-medium text-white backdrop-blur">
              {r.extension.toUpperCase()} · {formatBytes(r.bytes.byteLength)}
            </span>
          </div>
        )}
        {working && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 shimmer" />
        )}
        {item.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="rounded-2xl bg-panel px-5 py-4 text-sm text-bad shadow-xl ring-1 ring-line">{item.error}</div>
          </div>
        )}

        {/* Zoom controls */}
        <div className="absolute bottom-3 left-1/2 flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-0.5 sm:gap-1 rounded-2xl bg-panel/90 p-1 shadow-xl ring-1 ring-line backdrop-blur">
          <Button size="icon" title="Zoom out (−)" onClick={() => zoomTo(zoom / 1.25)}>
            <Minus size={16} />
          </Button>
          <button
            type="button"
            className="w-11 text-center text-xs font-medium tabular-nums text-muted hover:text-fg sm:w-14"
            title="Actual pixels (1)"
            onClick={() => zoomTo(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button size="icon" title="Zoom in (+)" onClick={() => zoomTo(zoom * 1.25)}>
            <Plus size={16} />
          </Button>
          <Button size="icon" title="Fit (0)" onClick={() => setView((v) => ({ ...v, fit: true }))}>
            <Maximize size={15} />
          </Button>
          <span className="hidden sm:flex">
            <Button size="icon" title="Zoom 400% to inspect detail" onClick={() => zoomTo(4)}>
              <ScanSearch size={16} />
            </Button>
          </span>
          <div className="mx-1 h-5 w-px bg-line" />
          <div className="w-44 sm:w-56">
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'split', label: 'Split', title: 'Drag the divider to compare' },
                { value: 'original', label: 'Original' },
                { value: 'result', label: 'Result' },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line bg-panel px-4 py-2.5 text-[12.5px]">
        <div className="min-w-0 max-w-[40%] truncate font-medium" title={item.relativePath}>
          {item.file.name}
        </div>
        <Stat label="Original" value={`${formatBytes(item.file.size)} · ${w}×${h}`} />
        {r ? (
          <>
            <Stat label="Result" value={`${formatBytes(r.bytes.byteLength)} · ${r.width}×${r.height}`} />
            <Stat
              label="Saved"
              value={r.keptOriginal ? 'Kept original' : formatSaving(item.file.size, r.bytes.byteLength)}
              tone={r.bytes.byteLength < item.file.size ? 'text-good' : 'text-warn'}
            />
            {!r.keptOriginal && r.quality < 100 && <Stat label="Quality" value={String(Math.round(r.quality))} />}
            {label && (
              <Stat
                label="Similarity"
                value={Number.isFinite(r.ssim) ? `${label.text} · ${(r.ssim * 100).toFixed(1)}%` : '–'}
                tone={label.tone}
                title="SSIM: how closely the result matches the original's structure (100% = identical)"
              />
            )}
            <Stat label="Time" value={`${(r.ms / 1000).toFixed(r.ms < 1000 ? 2 : 1)} s`} />
          </>
        ) : (
          <span className="text-muted">{item.status === 'error' ? 'Failed' : 'Compressing…'}</span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-faint lg:flex">
            <Eye size={13} /> hold <Kbd>Space</Kbd> for original
          </span>
          <Button variant="soft" size="sm" onClick={onSave} disabled={!r}>
            <Download size={14} /> Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div className="flex items-baseline gap-1.5" title={title}>
      <span className="text-faint">{label}</span>
      <span className={cx('font-medium tabular-nums', tone ?? 'text-fg')}>{value}</span>
    </div>
  );
}
