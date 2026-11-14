/** Output encoders. `original` keeps each picture's own format where it can be encoded. */
export type OutputFormat = 'original' | 'jpeg' | 'webp' | 'avif' | 'png';
export type EncodableFormat = Exclude<OutputFormat, 'original'>;

/**
 * How the encoder's quality is chosen:
 * - `quality`: the quality slider, as is
 * - `size`: the highest quality that fits under a target file size
 * - `auto`: the smallest file that still looks the same as the original (SSIM threshold)
 */
export type QualityMode = 'quality' | 'size' | 'auto';

export type ResizeMode = 'none' | 'fit' | 'width' | 'height' | 'percent';
export type ResizeMethod = 'lanczos3' | 'mitchell' | 'catrom' | 'triangle' | 'magicKernelSharp2021';

/** strip: nothing kept. keep: EXIF + colour profile. nogps: like keep, minus the location. icc: colour profile only. */
export type MetadataMode = 'strip' | 'icc' | 'nogps' | 'keep';

export interface JpegOptions {
  progressive: boolean;
  /** 1 = 4:4:4 (sharpest colour), 2 = 4:2:0 (smallest). */
  chromaSubsample: 1 | 2;
  autoSubsample: boolean;
  /** 0–100: blurs fine noise before encoding, which helps scanned and noisy photos. */
  smoothing: number;
  /** MozJPEG quantization table preset (0–8). 3 = MS-SSIM tuned (MozJPEG default). */
  quantTable: number;
  /** Extra trellis passes on top of MozJPEG's standard trellis quantization (slower, a few % smaller). */
  trellis: boolean;
  grayscale: boolean;
  separateChromaQuality: boolean;
  chromaQuality: number;
}

export interface WebpOptions {
  /** 0 (fast) – 6 (smallest). */
  effort: number;
  lossless: boolean;
  /** 100 = off; lower trades exactness for size in lossless mode. */
  nearLossless: number;
  sharpYuv: boolean;
}

export interface AvifOptions {
  /** 0 (slowest, smallest) – 10 (fastest). */
  speed: number;
  /** 1 = 4:2:0, 3 = 4:4:4. */
  subsample: 1 | 3;
  lossless: boolean;
}

export interface PngOptions {
  /** OxiPNG effort, 1–6. */
  level: number;
  interlace: boolean;
}

export interface Settings {
  format: OutputFormat;
  mode: QualityMode;
  /** 1–100. */
  quality: number;
  /** Target size in kilobytes for `size` mode. */
  targetKB: number;
  /** SSIM to keep in `auto` mode, e.g. 0.985. */
  autoTarget: number;
  resize: {
    mode: ResizeMode;
    width: number;
    height: number;
    percent: number;
    method: ResizeMethod;
    /** Never make a picture larger than it was. */
    noEnlarge: boolean;
  };
  metadata: MetadataMode;
  /** Fill colour behind transparent pixels when the output has no alpha (JPEG). */
  background: string;
  /** If a compressed file comes out bigger than the original (same format), keep the original. */
  neverLarger: boolean;
  /** Output file name; {name} is the original name without extension. */
  naming: string;
  jpeg: JpegOptions;
  webp: WebpOptions;
  avif: AvifOptions;
  png: PngOptions;
}

export type ItemStatus = 'queued' | 'working' | 'done' | 'error';

export interface ImageItem {
  id: string;
  file: File;
  /** Path inside a dropped folder, kept so a folder's structure can be recreated on save. */
  relativePath: string;
  status: ItemStatus;
  /** Settings version the current result was made with. */
  version: number;
  thumbUrl?: string;
  /** A URL the <img> element can show for the original (a converted copy for HEIC, TIFF, JXL). */
  originalUrl?: string;
  width?: number;
  height?: number;
  result?: CompressResult;
  resultUrl?: string;
  error?: string;
}

/** What the worker sends back for one picture. */
export interface CompressResult {
  bytes: ArrayBuffer;
  mime: string;
  extension: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Quality the encoder ended up using (chosen by the search in size/auto modes). */
  quality: number;
  /** Structural similarity to the (resized) original, 0–1. */
  ssim: number;
  /** The original was kept because compressing made it larger. */
  keptOriginal: boolean;
  ms: number;
  /** PNG copy of the original for formats an <img> can't show (HEIC, TIFF, JXL). */
  originalPreview?: ArrayBuffer;
  /** Small JPEG thumbnail for the file list. */
  thumb?: ArrayBuffer;
}
