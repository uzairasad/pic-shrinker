import { ChevronDown, Info } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  title,
  className,
  size = 'md',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'soft' | 'danger';
  disabled?: boolean;
  title?: string;
  className?: string;
  size?: 'sm' | 'md' | 'icon';
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all outline-none',
        'focus-visible:ring-2 focus-visible:ring-brand/60 disabled:opacity-40 disabled:pointer-events-none',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'sm' && 'h-7 px-2.5 text-xs rounded-lg',
        size === 'icon' && 'h-9 w-9',
        variant === 'primary' &&
          'brand-gradient text-brand-fg shadow-[0_6px_20px_-6px_var(--brand)] hover:brightness-110 active:brightness-95',
        variant === 'ghost' && 'text-muted hover:text-fg hover:bg-panel-2',
        variant === 'soft' && 'bg-panel-2 text-fg hover:bg-raised border border-line',
        variant === 'danger' && 'text-bad hover:bg-bad/10',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Section({
  title,
  children,
  defaultOpen = true,
  aside,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  aside?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line last:border-b-0">
      <div className="flex items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-2 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted hover:text-fg"
          aria-expanded={open}
        >
          <ChevronDown size={14} className={cx('transition-transform', !open && '-rotate-90')} />
          {title}
        </button>
        {aside}
      </div>
      {open && <div className="space-y-3.5 px-4 pb-4">{children}</div>}
    </section>
  );
}

export function Field({ label, hint, children, value }: { label: string; hint?: string; children: ReactNode; value?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className="flex items-center gap-1.5 text-fg/90">
          {label}
          {hint && (
            <span title={hint} className="text-faint hover:text-muted">
              <Info size={12} />
            </span>
          )}
        </span>
        {value !== undefined && <span className="tabular-nums text-muted">{value}</span>}
      </div>
      {children}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="flex rounded-xl bg-panel-2 p-1 border border-line" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 rounded-lg font-medium transition-all whitespace-nowrap',
            size === 'md' ? 'h-7 px-2 text-[12.5px]' : 'h-6 px-1.5 text-[11.5px]',
            value === o.value ? 'bg-raised text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className="slider"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ['--pct' as string]: `${pct}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center justify-between gap-3 text-[13px] text-fg/90">
      <span className="flex items-center gap-1.5">
        {label}
        {hint && (
          <span title={hint} className="text-faint hover:text-muted">
            <Info size={12} />
          </span>
        )}
      </span>
      <span className="relative inline-flex">
        <input id={id} type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-5 w-9 rounded-full bg-line transition-colors peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand/50" />
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  suffix,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  label: string;
}) {
  return (
    <div className="flex h-9 items-center rounded-xl border border-line bg-panel-2 px-3 focus-within:ring-2 focus-within:ring-brand/50">
      <input
        type="number"
        aria-label={label}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
        }}
        className="w-full min-w-0 bg-transparent text-sm tabular-nums text-fg outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      {suffix && <span className="ml-1 text-xs text-faint">{suffix}</span>}
    </div>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="relative">
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
        className="h-9 w-full appearance-none rounded-xl border border-line bg-panel-2 pl-3 pr-8 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint" />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-line bg-panel-2 px-1.5 py-0.5 font-sans text-[10.5px] font-medium text-muted">
      {children}
    </kbd>
  );
}
