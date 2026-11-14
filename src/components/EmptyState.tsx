import { FolderOpen, ImagePlus, Lock, Gauge, Layers, Sparkles } from 'lucide-react';
import { canPickFolder } from '../platform/native.ts';
import { Button, Kbd } from './ui.tsx';

export function EmptyState({ onAddFiles, onAddFolder }: { onAddFiles: () => void; onAddFolder: () => void }) {
  return (
    // m-auto (not items-center) so a window too short for it scrolls instead of cutting off the top.
    <div className="scroll-thin flex h-full overflow-auto p-6 short:p-3">
      <div className="m-auto w-full max-w-2xl">
        <div
          onClick={onAddFiles}
          className="group cursor-pointer rounded-[28px] border-2 border-dashed border-line bg-panel/60 px-8 py-14 text-center short:py-6 transition-colors hover:border-brand/60 hover:bg-panel"
        >
          <div className="brand-gradient mx-auto flex h-16 w-16 items-center justify-center rounded-2xl text-white shadow-[0_12px_32px_-10px_var(--brand)] transition-transform group-hover:scale-105">
            <ImagePlus size={30} />
          </div>
          <h2 className="mt-6 text-2xl font-semibold tracking-tight">Drop pictures to shrink them</h2>
          <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-muted">
            JPEG, PNG, WebP, AVIF, HEIC, TIFF, BMP, GIF and JPEG XL. Whole folders too. Or paste with <Kbd>Ctrl</Kbd> <Kbd>V</Kbd>.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2" onClick={(e) => e.stopPropagation()}>
            <Button variant="primary" onClick={onAddFiles}>
              <ImagePlus size={16} /> Add pictures
            </Button>
            <Button variant="soft" onClick={onAddFolder}>
              <FolderOpen size={16} /> Add a folder
            </Button>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 short:mt-3">
          <Feature icon={<Lock size={16} />} title="Private" text="Nothing is uploaded. Pictures never leave this device." />
          <Feature icon={<Sparkles size={16} />} title="Auto quality" text="Finds the smallest file that still looks the same." />
          <Feature icon={<Gauge size={16} />} title="Best codecs" text="MozJPEG, WebP, AVIF and OxiPNG." />
          <Feature icon={<Layers size={16} />} title="Batch" text={canPickFolder() ? 'Hundreds at once, saved to a folder.' : 'Hundreds at once, saved as a ZIP.'} />
        </div>
      </div>
    </div>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-3.5">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-brand">{icon}</span>
        {title}
      </div>
      <p className="mt-1 text-[12px] leading-snug text-muted">{text}</p>
    </div>
  );
}
