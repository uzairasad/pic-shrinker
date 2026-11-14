import { Code, Globe, Scale, X } from 'lucide-react';
import { useEffect } from 'react';
import { APP_NAME, APP_VERSION, AUTHOR } from '../appInfo.ts';
import { openProjectLink } from '../platform/native.ts';
import { Button } from './ui.tsx';
import { Logo } from './Logo.tsx';

export function About({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`About ${APP_NAME}`}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md rounded-3xl bg-panel p-7 shadow-2xl ring-1 ring-line"
      >
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 rounded-lg p-1.5 text-muted hover:bg-panel-2 hover:text-fg">
          <X size={16} />
        </button>
        <div className="flex items-center gap-4">
          <Logo size={56} />
          <div>
            <h2 className="text-xl font-semibold tracking-tight">{APP_NAME}</h2>
            <p className="text-sm text-muted">Version {APP_VERSION}</p>
          </div>
        </div>
        <p className="mt-5 text-[13.5px] leading-relaxed text-fg/90">
          Fast, private image compression. Every picture is processed on this device with MozJPEG, libwebp, libavif and
          OxiPNG, compiled to WebAssembly. Nothing is uploaded.
        </p>
        <p className="mt-3 text-[13.5px]">
          Created by <span className="font-semibold">{AUTHOR}</span>
        </p>
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
          Free and open-source software under the GNU General Public License v3.0 or later. Codecs and libraries keep
          their own licenses.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="soft" size="sm" onClick={() => void openProjectLink('website')}>
            <Globe size={14} /> Website
          </Button>
          <Button variant="soft" size="sm" onClick={() => void openProjectLink('source')}>
            <Code size={14} /> Source code
          </Button>
          <Button variant="soft" size="sm" onClick={() => void openProjectLink('license')}>
            <Scale size={14} /> License
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void openProjectLink('notices')}>
            Third-party notices
          </Button>
        </div>
        <p className="mt-6 text-[11.5px] text-faint">© 2026 {AUTHOR}</p>
      </div>
    </div>
  );
}
