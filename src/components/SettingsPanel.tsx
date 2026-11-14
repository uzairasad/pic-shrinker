import { RotateCcw, Sparkles } from 'lucide-react';
import { defaultSettings, presets } from '../lib/settings.ts';
import type { MetadataMode, OutputFormat, QualityMode, ResizeMethod, ResizeMode, Settings } from '../lib/types.ts';
import { Button, cx, Field, NumberInput, Section, Segmented, Select, Slider, Toggle } from './ui.tsx';

const QUANT_TABLES = [
  { value: 3, label: 'MS-SSIM tuned (best, default)' },
  { value: 0, label: 'JPEG standard (Annex K)' },
  { value: 1, label: 'Flat' },
  { value: 2, label: 'MS-SSIM (Kodak)' },
  { value: 4, label: 'PSNR-HVS-M' },
  { value: 5, label: 'Klein, Silverstein & Carney' },
  { value: 6, label: 'Watson, Taylor & Borthwick' },
  { value: 7, label: 'Ahumada, Watson & Peterson' },
  { value: 8, label: 'Peterson, Ahumada & Watson' },
];

export function SettingsPanel({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const s = settings;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...s, [k]: v });
  const fmt = s.format;
  const showJpeg = fmt === 'jpeg' || fmt === 'original';
  const lossless = fmt === 'png' || (fmt === 'webp' && s.webp.lossless) || (fmt === 'avif' && s.avif.lossless);

  return (
    <div className="pb-6">
      <Section
        title="Presets"
        aside={
          <Button size="sm" title="Reset all settings" onClick={() => onChange(structuredClone(defaultSettings))}>
            <RotateCcw size={13} />
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              onClick={() => onChange(p.apply(structuredClone(s)))}
              className="rounded-xl border border-line bg-panel-2 px-3 py-2 text-left transition-colors hover:border-brand/60 hover:bg-raised"
            >
              <div className="text-[13px] font-medium">{p.label}</div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted">{p.hint}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Output">
        <Field label="Format">
          <Select<OutputFormat>
            label="Output format"
            value={fmt}
            onChange={(v) => set('format', v)}
            options={[
              { value: 'original', label: 'Same as original' },
              { value: 'jpeg', label: 'JPEG (MozJPEG)' },
              { value: 'webp', label: 'WebP' },
              { value: 'avif', label: 'AVIF (smallest)' },
              { value: 'png', label: 'PNG (OxiPNG, lossless)' },
            ]}
          />
        </Field>

        {!lossless && (
          <>
            <Field label="Compression">
              <Segmented<QualityMode>
                value={s.mode}
                onChange={(v) => set('mode', v)}
                options={[
                  { value: 'quality', label: 'Quality', title: 'Choose the quality yourself' },
                  { value: 'size', label: 'Target size', title: 'Best quality that fits a file size' },
                  {
                    value: 'auto',
                    label: (
                      <span className="inline-flex items-center gap-1">
                        <Sparkles size={12} /> Auto
                      </span>
                    ),
                    title: 'Smallest file that still looks like the original',
                  },
                ]}
              />
            </Field>

            {s.mode === 'quality' && (
              <Field label="Quality" value={s.quality}>
                <Slider label="Quality" min={1} max={100} value={s.quality} onChange={(v) => set('quality', v)} />
                <div className="flex justify-between text-[11px] text-faint">
                  <span>Smaller</span>
                  <span>Better</span>
                </div>
              </Field>
            )}
            {s.mode === 'size' && (
              <Field label="Maximum file size" hint="Each picture gets the highest quality that fits. Resizing helps reach very small sizes.">
                <NumberInput label="Target size in KB" value={s.targetKB} min={5} max={100000} suffix="KB" onChange={(v) => set('targetKB', v)} />
              </Field>
            )}
            {s.mode === 'auto' && (
              <Field
                label="Look"
                hint="Searches for the lowest quality whose similarity (SSIM) to the original stays above this level."
                value={`${(s.autoTarget * 100).toFixed(1)}%`}
              >
                <Segmented<number>
                  value={s.autoTarget}
                  onChange={(v) => set('autoTarget', v)}
                  options={[
                    { value: 0.97, label: 'Good', title: 'SSIM ≥ 97%' },
                    { value: 0.985, label: 'Identical', title: 'SSIM ≥ 98.5%' },
                    { value: 0.993, label: 'Pristine', title: 'SSIM ≥ 99.3%' },
                  ]}
                />
              </Field>
            )}
          </>
        )}

        <Toggle
          label="Never larger than original"
          hint="If a compressed picture comes out bigger in the same format and size, the original is kept (with metadata removed as chosen)."
          checked={s.neverLarger}
          onChange={(v) => set('neverLarger', v)}
        />
      </Section>

      <Section title="Resize">
        <Segmented<ResizeMode>
          size="sm"
          value={s.resize.mode}
          onChange={(v) => set('resize', { ...s.resize, mode: v })}
          options={[
            { value: 'none', label: 'Off' },
            { value: 'fit', label: 'Fit' },
            { value: 'width', label: 'Width' },
            { value: 'height', label: 'Height' },
            { value: 'percent', label: '%' },
          ]}
        />
        {(s.resize.mode === 'fit' || s.resize.mode === 'width' || s.resize.mode === 'height') && (
          <div className="grid grid-cols-2 gap-2">
            {s.resize.mode !== 'height' && (
              <Field label={s.resize.mode === 'fit' ? 'Max width' : 'Width'}>
                <NumberInput label="Width" value={s.resize.width} min={1} max={30000} suffix="px" onChange={(v) => set('resize', { ...s.resize, width: v })} />
              </Field>
            )}
            {s.resize.mode !== 'width' && (
              <Field label={s.resize.mode === 'fit' ? 'Max height' : 'Height'}>
                <NumberInput label="Height" value={s.resize.height} min={1} max={30000} suffix="px" onChange={(v) => set('resize', { ...s.resize, height: v })} />
              </Field>
            )}
          </div>
        )}
        {s.resize.mode === 'percent' && (
          <Field label="Scale" value={`${s.resize.percent}%`}>
            <Slider label="Scale" min={5} max={200} value={s.resize.percent} onChange={(v) => set('resize', { ...s.resize, percent: v })} />
          </Field>
        )}
        {s.resize.mode !== 'none' && (
          <>
            <Field label="Resampling">
              <Select<ResizeMethod>
                label="Resampling filter"
                value={s.resize.method}
                onChange={(v) => set('resize', { ...s.resize, method: v })}
                options={[
                  { value: 'lanczos3', label: 'Lanczos3 (sharpest)' },
                  { value: 'magicKernelSharp2021', label: 'Magic Kernel Sharp' },
                  { value: 'mitchell', label: 'Mitchell (smooth)' },
                  { value: 'catrom', label: 'Catmull-Rom' },
                  { value: 'triangle', label: 'Bilinear (fast)' },
                ]}
              />
            </Field>
            <Toggle label="Don't enlarge small pictures" checked={s.resize.noEnlarge} onChange={(v) => set('resize', { ...s.resize, noEnlarge: v })} />
          </>
        )}
      </Section>

      <Section title="Metadata & privacy">
        <Segmented<MetadataMode>
          size="sm"
          value={s.metadata}
          onChange={(v) => set('metadata', v)}
          options={[
            { value: 'strip', label: 'Remove all', title: 'Removes camera data, GPS location, comments and colour profile' },
            { value: 'icc', label: 'Colour only', title: 'Keeps only the colour profile' },
            { value: 'nogps', label: 'No GPS', title: 'Keeps EXIF and colour profile, removes the location' },
            { value: 'keep', label: 'Keep', title: 'Keeps EXIF and colour profile' },
          ]}
        />
        <p className="text-[11.5px] leading-relaxed text-muted">
          {s.metadata === 'strip'
            ? 'Camera details, GPS location and comments are removed. Colours are converted to sRGB so they look right everywhere.'
            : 'EXIF and colour profiles are carried over for JPEG → JPEG. Orientation is applied to the pixels, so pictures stay upright.'}
        </p>
      </Section>

      {showJpeg && (
        <Section title="JPEG (MozJPEG)" defaultOpen={false}>
          <Toggle label="Progressive" hint="Loads gradually on the web and is usually a little smaller." checked={s.jpeg.progressive} onChange={(v) => set('jpeg', { ...s.jpeg, progressive: v })} />
          <Field label="Chroma subsampling" hint="4:2:0 halves colour resolution (smaller). 4:4:4 keeps colour edges crisp: better for text, logos and screenshots.">
            <Segmented<string>
              size="sm"
              value={s.jpeg.autoSubsample ? 'auto' : String(s.jpeg.chromaSubsample)}
              onChange={(v) =>
                set('jpeg', v === 'auto' ? { ...s.jpeg, autoSubsample: true, chromaSubsample: 2 } : { ...s.jpeg, autoSubsample: false, chromaSubsample: Number(v) as 1 | 2 })
              }
              options={[
                { value: 'auto', label: 'Auto' },
                { value: '2', label: '4:2:0' },
                { value: '1', label: '4:4:4' },
              ]}
            />
          </Field>
          <Field label="Smoothing" value={s.jpeg.smoothing} hint="Smooths grain and noise before encoding. Helps scans and high-ISO photos.">
            <Slider label="Smoothing" min={0} max={100} value={s.jpeg.smoothing} onChange={(v) => set('jpeg', { ...s.jpeg, smoothing: v })} />
          </Field>
          <Toggle label="Extra trellis passes" hint="MozJPEG always uses trellis quantization. This adds multi-pass optimisation: 2–3× slower for a few percent smaller files." checked={s.jpeg.trellis} onChange={(v) => set('jpeg', { ...s.jpeg, trellis: v })} />
          <Toggle label="Grayscale" checked={s.jpeg.grayscale} onChange={(v) => set('jpeg', { ...s.jpeg, grayscale: v })} />
          <Toggle
            label="Separate colour quality"
            checked={s.jpeg.separateChromaQuality}
            onChange={(v) => set('jpeg', { ...s.jpeg, separateChromaQuality: v })}
          />
          {s.jpeg.separateChromaQuality && (
            <Field label="Colour quality" value={s.jpeg.chromaQuality}>
              <Slider label="Colour quality" min={1} max={100} value={s.jpeg.chromaQuality} onChange={(v) => set('jpeg', { ...s.jpeg, chromaQuality: v })} />
            </Field>
          )}
          <Field label="Quantization tables">
            <Select<number> label="Quantization tables" value={s.jpeg.quantTable} onChange={(v) => set('jpeg', { ...s.jpeg, quantTable: v })} options={QUANT_TABLES} />
          </Field>
          <Field label="Background for transparency">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Background colour"
                value={s.background}
                onChange={(e) => set('background', e.target.value)}
                className="h-9 w-12 cursor-pointer rounded-lg border border-line bg-panel-2 p-1"
              />
              <span className="font-mono text-xs uppercase text-muted">{s.background}</span>
            </div>
          </Field>
        </Section>
      )}

      {(fmt === 'webp' || fmt === 'original') && (
        <Section title="WebP" defaultOpen={fmt === 'webp'}>
          <Field label="Effort" value={s.webp.effort} hint="Higher is slower and smaller.">
            <Slider label="WebP effort" min={0} max={6} value={s.webp.effort} onChange={(v) => set('webp', { ...s.webp, effort: v })} />
          </Field>
          <Toggle label="Lossless" checked={s.webp.lossless} onChange={(v) => set('webp', { ...s.webp, lossless: v })} />
          {s.webp.lossless && (
            <Field label="Near-lossless" value={s.webp.nearLossless === 100 ? 'Off' : s.webp.nearLossless} hint="Lower values let tiny pixel changes in, for much smaller lossless files.">
              <Slider label="Near-lossless" min={0} max={100} value={s.webp.nearLossless} onChange={(v) => set('webp', { ...s.webp, nearLossless: v })} />
            </Field>
          )}
          <Toggle label="Sharp YUV" hint="Keeps colour edges sharper (slightly slower)." checked={s.webp.sharpYuv} onChange={(v) => set('webp', { ...s.webp, sharpYuv: v })} />
        </Section>
      )}

      {(fmt === 'avif' || fmt === 'original') && (
        <Section title="AVIF" defaultOpen={fmt === 'avif'}>
          <Field label="Effort" value={10 - s.avif.speed} hint="Higher is much slower and a little smaller.">
            <Slider label="AVIF effort" min={0} max={10} value={10 - s.avif.speed} onChange={(v) => set('avif', { ...s.avif, speed: 10 - v })} />
          </Field>
          <Field label="Colour">
            <Segmented<number>
              size="sm"
              value={s.avif.subsample}
              onChange={(v) => set('avif', { ...s.avif, subsample: v as 1 | 3 })}
              options={[
                { value: 1, label: '4:2:0 (smaller)' },
                { value: 3, label: '4:4:4 (sharper)' },
              ]}
            />
          </Field>
          <Toggle label="Lossless" checked={s.avif.lossless} onChange={(v) => set('avif', { ...s.avif, lossless: v })} />
        </Section>
      )}

      {(fmt === 'png' || fmt === 'original') && (
        <Section title="PNG (OxiPNG)" defaultOpen={fmt === 'png'}>
          <Field label="Effort" value={s.png.level} hint="Lossless either way. Higher tries more filters (slower).">
            <Slider label="PNG effort" min={1} max={6} value={s.png.level} onChange={(v) => set('png', { ...s.png, level: v })} />
          </Field>
          <Toggle label="Interlaced" hint="Loads gradually, but is larger." checked={s.png.interlace} onChange={(v) => set('png', { ...s.png, interlace: v })} />
        </Section>
      )}

      <Section title="File names">
        <Field label="Name pattern" hint="{name} original name · {w} {h} size · {q} quality · {n} number · {ext} original extension">
          <input
            value={s.naming}
            onChange={(e) => set('naming', e.target.value)}
            spellCheck={false}
            aria-label="File name pattern"
            className="h-9 w-full rounded-xl border border-line bg-panel-2 px-3 font-mono text-[13px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
          />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {['{name}', '{name}-min', '{name}-{w}px', '{name}_q{q}'].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => set('naming', p)}
              className={cx(
                'rounded-lg border px-2 py-1 font-mono text-[11px]',
                s.naming === p ? 'border-brand/60 bg-brand/10 text-fg' : 'border-line text-muted hover:text-fg',
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
