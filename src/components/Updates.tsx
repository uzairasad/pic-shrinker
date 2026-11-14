import { CheckCircle2, Download, RefreshCw, RotateCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { APP_VERSION } from '../appInfo.ts';
import { applyUpdate, canAutoCheck, checkForUpdate, loadPrefs, savePrefs, type UpdateFound } from '../platform/updates.ts';
import { Button, Toggle } from './ui.tsx';

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'found'; update: UpdateFound }
  | { kind: 'installing'; update: UpdateFound; progress: number | null }
  | { kind: 'error'; message: string; update?: UpdateFound };

/** Update state shared by the start-up check (App) and the About box. */
export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });

  /** `quiet`: an automatic check, which never shows errors or "up to date". */
  const check = useCallback(async (quiet = false): Promise<UpdateFound | null> => {
    if (!quiet) setStatus({ kind: 'checking' });
    try {
      const update = await checkForUpdate();
      if (update) setStatus({ kind: 'found', update });
      else if (!quiet) setStatus({ kind: 'current' });
      return update;
    } catch (err) {
      if (!quiet) setStatus({ kind: 'error', message: `Couldn't check for updates: ${err instanceof Error ? err.message : String(err)}` });
      return null;
    }
  }, []);

  const install = useCallback(async (update: UpdateFound) => {
    if (update.how === 'install') setStatus({ kind: 'installing', update, progress: null });
    try {
      await applyUpdate(update, (progress) => setStatus({ kind: 'installing', update, progress }));
    } catch (err) {
      setStatus({ kind: 'error', update, message: `The update didn't install: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, []);

  return { status, check, install };
}

function updateLabel(u: UpdateFound) {
  return u.version ? `Version ${u.version} is available` : 'A new version is available';
}

/** The "Updates" part of the About box. */
export function UpdatesSection({ updates }: { updates: ReturnType<typeof useUpdates> }) {
  const { status, check, install } = updates;
  const [auto, setAuto] = useState(() => loadPrefs().auto);
  const found = status.kind === 'found' || status.kind === 'installing' ? status.update : status.kind === 'error' ? status.update : undefined;

  return (
    <div className="mt-5 rounded-2xl border border-line bg-panel-2 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 text-[13px]">
          {status.kind === 'idle' && <span className="text-muted">You have version {APP_VERSION}.</span>}
          {status.kind === 'checking' && <span className="text-muted">Checking for updates…</span>}
          {status.kind === 'current' && (
            <span className="flex items-center gap-1.5 text-good">
              <CheckCircle2 size={15} /> {APP_VERSION} is the latest version.
            </span>
          )}
          {found && status.kind !== 'error' && <span className="font-semibold text-brand">{updateLabel(found)}</span>}
          {status.kind === 'installing' && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className="brand-gradient h-full transition-[width]"
                style={{ width: status.progress === null ? '30%' : `${Math.round(status.progress * 100)}%` }}
              />
            </div>
          )}
          {status.kind === 'error' && <span className="text-bad">{status.message}</span>}
        </div>
        {found && status.kind !== 'installing' ? (
          <Button variant="primary" size="sm" onClick={() => void install(found)}>
            {found.how === 'install' ? (
              <>
                <Download size={14} /> Install and restart
              </>
            ) : found.how === 'reload' ? (
              <>
                <RotateCw size={14} /> Reload to update
              </>
            ) : (
              <>
                <Download size={14} /> Download
              </>
            )}
          </Button>
        ) : (
          <Button variant="soft" size="sm" onClick={() => void check()} disabled={status.kind === 'checking' || status.kind === 'installing'}>
            <RefreshCw size={14} className={status.kind === 'checking' ? 'animate-spin' : undefined} /> Check for updates
          </Button>
        )}
      </div>
      {status.kind === 'installing' && (
        <p className="mt-2 text-[12px] text-muted">Downloading and installing. The app restarts when it's done.</p>
      )}
      {found?.how === 'download' && status.kind === 'found' && (
        <p className="mt-2 text-[12px] leading-snug text-muted">
          The download opens in your browser. Install it over this copy: your settings are kept.
        </p>
      )}
      {canAutoCheck() && (
        <div className="mt-3 border-t border-line pt-3">
          <Toggle
            label="Check for updates when the app starts"
            hint="At most once a day. Only asks GitHub for the latest release; nothing about you or your pictures is sent."
            checked={auto}
            onChange={(v) => {
              setAuto(v);
              savePrefs({ ...loadPrefs(), auto: v });
            }}
          />
        </div>
      )}
    </div>
  );
}
