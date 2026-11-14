import { FileArchive, FolderDown, FolderOpen, ImagePlus, Images, Info, Monitor, Moon, SlidersHorizontal, Sun, Trash2, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_NAME } from './appInfo.ts';
import { About } from './components/About.tsx';
import { CompareView } from './components/CompareView.tsx';
import { EmptyState } from './components/EmptyState.tsx';
import { FileList } from './components/FileList.tsx';
import { Logo } from './components/Logo.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { useUpdates } from './components/Updates.tsx';
import { Button, cx } from './components/ui.tsx';
import { ACCEPT, filesFromClipboard, filesFromDataTransfer, filesFromInput, type PickedFile } from './lib/files.ts';
import { formatBytes, formatSaving, outputName, uniqueNames } from './lib/format.ts';
import { CompressPool } from './lib/pool.ts';
import { loadSettings, saveSettings } from './lib/settings.ts';
import type { CompressResult, ImageItem, Settings } from './lib/types.ts';
import { canPickFolder, isNativeApp, onFilesOpenedByOS, revealFolder, saveFile, saveMany } from './platform/native.ts';
import { autoCheckDue } from './platform/updates.ts';

type Theme = 'system' | 'light' | 'dark';
type MobileTab = 'list' | 'view' | 'settings';

interface Toast {
  id: number;
  text: string;
  tone?: 'good' | 'bad';
  action?: { label: string; run: () => void };
}

// One pool for the app's lifetime (it must survive React StrictMode's mount/unmount/mount).
let sharedPool: CompressPool | null = null;
const getPool = () => (sharedPool ??= new CompressPool());

let idCounter = 0;
const newId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('pic-shrinker:theme') as Theme) || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    try {
      localStorage.setItem('pic-shrinker:theme', theme);
    } catch {
      /* not remembered */
    }
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}

export default function App() {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [version, setVersion] = useState(1);
  const [theme, setTheme] = useTheme();
  const [about, setAbout] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('list');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const updates = useUpdates();
  const updateReady = updates.status.kind === 'found';

  const pool = getPool();

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const versionRef = useRef(version);
  versionRef.current = version;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  /** itemId → the job compressing it right now (with the settings version it uses). */
  const inflight = useRef(new Map<string, { v: number }>());

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.action ? 8000 : 4500);
  }, []);

  // A quiet update check shortly after start-up (installed apps, at most daily, can be turned off).
  const checkUpdates = updates.check;
  useEffect(() => {
    if (!autoCheckDue()) return;
    const t = setTimeout(() => {
      void checkUpdates(true).then((found) => {
        if (found) {
          toast({
            text: found.version ? `Pic Shrinker ${found.version} is available` : 'A new version is available',
            action: { label: 'Update', run: () => setAbout(true) },
          });
        }
      });
    }, 4000);
    return () => clearTimeout(t);
  }, [checkUpdates, toast]);

  // Settings changes are remembered, and recompress everything shortly after the last change.
  useEffect(() => {
    saveSettings(settings);
    const t = setTimeout(() => setVersion((v) => v + 1), 220);
    return () => clearTimeout(t);
  }, [settings]);

  const applyResult = useCallback((id: string, v: number, r: CompressResult) => {
    // Object URLs are made here, not inside the state updater (React may run updaters twice).
    const { thumb, originalPreview, ...result } = r;
    const resultUrl = URL.createObjectURL(new Blob([r.bytes], { type: r.mime }));
    const thumbUrl = thumb && URL.createObjectURL(new Blob([thumb], { type: 'image/jpeg' }));
    const previewUrl = originalPreview && URL.createObjectURL(new Blob([originalPreview], { type: 'image/jpeg' }));
    const old = itemsRef.current.find((it) => it.id === id);
    setItems((list) =>
      list.map((it) =>
        it.id !== id
          ? it
          : {
              ...it,
              status: v === versionRef.current ? 'done' : 'queued',
              version: v,
              result,
              error: undefined,
              resultUrl,
              width: r.sourceWidth,
              height: r.sourceHeight,
              thumbUrl: thumbUrl ?? it.thumbUrl,
              originalUrl: previewUrl ?? it.originalUrl,
            },
      ),
    );
    // The replaced URLs are no longer shown once React has rendered the new ones.
    setTimeout(() => {
      if (!old) return;
      if (old.resultUrl) URL.revokeObjectURL(old.resultUrl);
      if (thumbUrl && old.thumbUrl) URL.revokeObjectURL(old.thumbUrl);
      if (previewUrl && old.originalUrl) URL.revokeObjectURL(old.originalUrl);
    }, 1000);
  }, []);

  /** Queues every picture that has no result for the current settings, the selected one first. */
  const schedule = useCallback(() => {
    const v = versionRef.current;
    const s = settingsRef.current;
    for (const id of pool.clearQueue()) inflight.current.delete(id);
    const todo = itemsRef.current.filter((it) => it.version !== v && inflight.current.get(it.id)?.v !== v);
    todo.sort((a, b) => Number(b.id === selectedRef.current) - Number(a.id === selectedRef.current));
    if (!todo.length) return;
    const ids = new Set(todo.map((t) => t.id));
    setItems((list) => list.map((it) => (ids.has(it.id) && it.status !== 'queued' ? { ...it, status: 'queued' } : it)));
    for (const it of todo) {
      const job = { v };
      inflight.current.set(it.id, job);
      const first = !it.thumbUrl;
      pool
        .run(it.id, it.file, s, { wantThumb: first, wantPreview: first })
        .then((r) => {
          if (inflight.current.get(it.id) === job) inflight.current.delete(it.id);
          const current = itemsRef.current.find((x) => x.id === it.id);
          if (!current) return;
          // An older result still shows something until the current one lands; a newer one wins.
          if (current.version > v && current.version <= versionRef.current) return;
          applyResult(it.id, v, r);
        })
        .catch((err: Error) => {
          if (err.message === 'cancelled') return;
          if (inflight.current.get(it.id) === job) inflight.current.delete(it.id);
          setItems((list) => list.map((x) => (x.id === it.id ? { ...x, status: 'error', version: v, error: err.message } : x)));
        });
    }
  }, [applyResult, pool]);

  useEffect(() => {
    schedule();
  }, [version, schedule]);

  // The picture you're looking at jumps the queue.
  useEffect(() => {
    if (selectedId) schedule();
  }, [selectedId, schedule]);

  const addFiles = useCallback(
    (picked: PickedFile[]) => {
      if (!picked.length) {
        toast({ text: 'No supported pictures found.', tone: 'bad' });
        return;
      }
      const fresh: ImageItem[] = picked.map(({ file, relativePath }) => {
        const browserShows = /\.(jpe?g|jfif|png|webp|gif|bmp|avif)$/i.test(file.name);
        return {
          id: newId(),
          file,
          relativePath,
          status: 'queued',
          version: 0,
          originalUrl: browserShows ? URL.createObjectURL(file) : undefined,
        };
      });
      setItems((list) => {
        const next = [...list, ...fresh];
        itemsRef.current = next;
        return next;
      });
      setSelectedId((cur) => cur ?? fresh[0].id);
      if (!selectedRef.current) selectedRef.current = fresh[0].id;
      setMobileTab((t) => (t === 'settings' ? t : 'view'));
      queueMicrotask(schedule);
    },
    [schedule, toast],
  );

  // Pictures handed over by the OS (native app).
  useEffect(() => onFilesOpenedByOS((files) => addFiles(files.map((file) => ({ file, relativePath: file.name })))), [addFiles]);

  // Drag and drop anywhere, and paste.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = async (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles(await filesFromDataTransfer(e.dataTransfer));
    };
    const paste = (e: ClipboardEvent) => {
      const files = filesFromClipboard(e);
      if (files.length) addFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, [addFiles]);

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const removeItem = (id: string) => {
    setItems((list) => {
      const it = list.find((x) => x.id === id);
      if (it) for (const u of [it.thumbUrl, it.originalUrl, it.resultUrl]) if (u) URL.revokeObjectURL(u);
      const next = list.filter((x) => x.id !== id);
      if (selectedId === id) setSelectedId(next[0]?.id ?? null);
      return next;
    });
  };

  const clearAll = () => {
    pool.clearQueue();
    inflight.current.clear();
    for (const it of items) for (const u of [it.thumbUrl, it.originalUrl, it.resultUrl]) if (u) URL.revokeObjectURL(u);
    setItems([]);
    setSelectedId(null);
    setMobileTab('list');
  };

  const done = items.filter((it) => it.status === 'done' && it.result);
  const pending = items.filter((it) => it.status === 'queued' || it.status === 'working').length;
  const failed = items.filter((it) => it.status === 'error').length;
  const totalBefore = done.reduce((n, it) => n + it.file.size, 0);
  const totalAfter = done.reduce((n, it) => n + it.result!.bytes.byteLength, 0);

  const outputPaths = (list: ImageItem[]) => {
    const names = list.map((it, index) => {
      const r = it.result!;
      const name = outputName(settings.naming, it.file.name, r.extension, { width: r.width, height: r.height, quality: r.quality, index });
      const dir = it.relativePath.includes('/') ? it.relativePath.slice(0, it.relativePath.lastIndexOf('/') + 1) : '';
      return dir + name;
    });
    return uniqueNames(names);
  };

  const saveAll = async (preferZip = false) => {
    if (!done.length) return;
    setSaving(true);
    try {
      const paths = outputPaths(done);
      const res = await saveMany(
        done.map((it, i) => ({ path: paths[i], bytes: it.result!.bytes })),
        'Pic Shrinker.zip',
        preferZip,
      );
      if (res.kind === 'folder') {
        toast({
          text: `Saved ${res.count} ${res.count === 1 ? 'picture' : 'pictures'} to ${res.folder}`,
          tone: 'good',
          action: res.native ? { label: 'Show', run: () => void revealFolder(res.folder) } : undefined,
        });
      } else if (res.kind === 'zip') {
        toast({ text: `Saved ${res.count} pictures as ${res.name}`, tone: 'good' });
      }
    } catch (err) {
      toast({ text: `Couldn't save: ${err instanceof Error ? err.message : String(err)}`, tone: 'bad' });
    } finally {
      setSaving(false);
    }
  };

  const selected = items.find((it) => it.id === selectedId) ?? null;

  const saveOne = async (it: ImageItem) => {
    if (!it.result) return;
    const [path] = outputPaths([it]);
    try {
      const name = await saveFile(path.split('/').pop()!, it.result.bytes, it.result.mime);
      if (name && isNativeApp()) toast({ text: `Saved ${name}`, tone: 'good' });
    } catch (err) {
      toast({ text: `Couldn't save: ${err instanceof Error ? err.message : String(err)}`, tone: 'bad' });
    }
  };

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const nextTheme: Theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="flex h-14 short:h-11 shrink-0 items-center gap-1 sm:gap-2 border-b border-line bg-panel px-3 sm:px-4">
        <div className="flex items-center gap-2.5 pr-1 sm:pr-2">
          <Logo size={30} />
          <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">{APP_NAME}</span>
        </div>
        <div className="mx-1 hidden h-6 w-px bg-line sm:block" />
        <Button variant="ghost" onClick={() => fileInput.current?.click()} title="Add pictures" className="px-2.5! sm:px-3.5!">
          <ImagePlus size={17} /> <span className="hidden md:inline">Add</span>
        </Button>
        <Button variant="ghost" onClick={() => folderInput.current?.click()} title="Add a folder" className="px-2.5! sm:px-3.5!">
          <FolderOpen size={17} /> <span className="hidden md:inline">Folder</span>
        </Button>
        {items.length > 0 && (
          <Button variant="ghost" onClick={clearAll} title="Remove all pictures" className="px-2.5! sm:px-3.5!">
            <Trash2 size={16} /> <span className="hidden md:inline">Clear</span>
          </Button>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {done.length > 0 && (
            <div className="mr-2 hidden text-right text-[12px] leading-tight tabular-nums lg:block">
              <div className="text-muted">
                {formatBytes(totalBefore)} → <span className="text-fg">{formatBytes(totalAfter)}</span>
              </div>
              <div className="font-semibold text-good">
                {formatSaving(totalBefore, totalAfter)} · saved {formatBytes(Math.max(0, totalBefore - totalAfter))}
              </div>
            </div>
          )}
          <span className="hidden sm:flex">
            <Button size="icon" onClick={() => setTheme(nextTheme)} title={`Theme: ${theme}`}>
              <ThemeIcon size={17} />
            </Button>
          </span>
          <Button size="icon" onClick={() => setAbout(true)} title={updateReady ? 'An update is available' : `About ${APP_NAME}`} className="relative">
            <Info size={17} />
            {updateReady && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand ring-2 ring-panel" />}
          </Button>
          {canPickFolder() && done.length > 1 && (
            <Button variant="soft" onClick={() => void saveAll(true)} disabled={saving} title="Save everything as one ZIP file" className="hidden sm:inline-flex">
              <FileArchive size={16} /> <span className="hidden xl:inline">ZIP</span>
            </Button>
          )}
          <Button variant="primary" onClick={() => void saveAll()} disabled={!done.length || saving || pending > 0}>
            {canPickFolder() ? <FolderDown size={16} /> : <FileArchive size={16} />}
            <span className="sm:hidden">{pending > 0 ? `${items.length - pending}/${items.length}` : 'Save'}</span>
            <span className="hidden sm:inline">
              {pending > 0 ? `Compressing ${items.length - pending}/${items.length}` : `Save ${done.length > 1 ? `all ${done.length}` : ''}`}
            </span>
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {items.length > 0 && (
          <aside
            className={cx(
              'min-h-0 w-full flex-col border-r border-line bg-panel lg:flex lg:w-72 xl:w-80',
              mobileTab === 'list' ? 'flex' : 'hidden',
            )}
          >
            <div className="flex items-center justify-between px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              <span>
                {items.length} {items.length === 1 ? 'picture' : 'pictures'}
                {failed > 0 && <span className="ml-2 normal-case tracking-normal text-bad">{failed} failed</span>}
              </span>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              <FileList
                items={items}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  setMobileTab('view');
                }}
                onRemove={removeItem}
              />
            </div>
            <div className="border-t border-line p-2">
              <Button variant="ghost" className="w-full" onClick={() => fileInput.current?.click()}>
                <ImagePlus size={16} /> Add more
              </Button>
            </div>
          </aside>
        )}

        <main className={cx('min-h-0 min-w-0 flex-1 flex-col lg:flex', mobileTab === 'view' || !items.length ? 'flex' : 'hidden')}>
          {selected ? (
            <CompareView item={selected} onSave={() => void saveOne(selected)} />
          ) : (
            <EmptyState onAddFiles={() => fileInput.current?.click()} onAddFolder={() => folderInput.current?.click()} />
          )}
        </main>

        <aside
          className={cx(
            'scroll-thin min-h-0 w-full overflow-y-auto border-l border-line bg-panel lg:block lg:w-[320px]',
            mobileTab === 'settings' ? 'block' : 'hidden',
          )}
        >
          <SettingsPanel settings={settings} onChange={setSettings} />
        </aside>
      </div>

      {/* Phone / narrow window tabs */}
      <nav className="grid shrink-0 grid-cols-3 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] lg:hidden">
        {(
          [
            ['list', Images, 'Pictures'],
            ['view', Monitor, 'Preview'],
            ['settings', SlidersHorizontal, 'Settings'],
          ] as const
        ).map(([tab, Icon, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => setMobileTab(tab)}
            className={cx('flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium short:flex-row short:justify-center short:gap-2 short:py-1.5', mobileTab === tab ? 'text-brand' : 'text-muted')}
          >
            <Icon size={19} />
            {label}
          </button>
        ))}
      </nav>

      <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (addFiles(filesFromInput(e.target.files)), (e.target.value = ''))} />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: '', directory: '' } as object)}
        onChange={(e) => (addFiles(filesFromInput(e.target.files)), (e.target.value = ''))}
      />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
          <div className="flex flex-col items-center rounded-[28px] border-2 border-dashed border-brand bg-panel px-14 py-12 shadow-2xl">
            <UploadCloud size={44} className="text-brand" />
            <div className="mt-4 text-lg font-semibold">Drop to add</div>
            <div className="text-sm text-muted">Pictures or folders</div>
          </div>
        </div>
      )}

      <div className="pointer-events-none fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2 lg:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto flex items-center gap-3 rounded-2xl bg-panel px-4 py-2.5 text-[13px] shadow-2xl ring-1',
              t.tone === 'bad' ? 'ring-bad/50 text-bad' : 'ring-line',
            )}
          >
            <span className="max-w-[70vw] truncate">{t.text}</span>
            {t.action && (
              <button type="button" onClick={t.action.run} className="font-semibold text-brand hover:underline">
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      {about && <About onClose={() => setAbout(false)} updates={updates} />}
    </div>
  );
}
