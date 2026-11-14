import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Film,
  Info,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  X
} from 'lucide-react';
import { downloadUrl, previewUrl, thumbnailUrl } from '../api';
import { formatDate, formatSize } from '../format';
import type { Entry, EntryDetails } from '../types';
import {
  LB_MAX_ZOOM,
  LB_MIN_ZOOM,
  applyZoomAt,
  clampIndex,
  clampPan,
  clampZoom,
  containScale,
  doubleTapZoom,
  edgeResist,
  fitContain,
  pinchAnchored,
  resetZoomPan,
  resolveDragAxis,
  resolveFlick,
  resolveSwipe,
  shouldDismiss,
  shouldSnapZoomOut,
  type DragAxis,
  type ZoomPan
} from '../viewerGestures';
import '../viewer.css';

export { containScale };

type MediaKind = 'image' | 'video';

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/tiff',
  'image/heic',
  'image/heif'
]);

const VIDEO_MIMES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/ogg',
  'video/mpeg',
  'video/mp2t',
  'video/x-flv',
  'video/x-ms-wmv',
  'video/3gpp'
]);

const PANEL_GAP = 28;
const SLIDE_MS = 4000;
const COACH_KEY = 'my_drive_viewer_coach';

export type ViewerItem = {
  id: string;
  name: string;
  mime_detected?: string | null;
  mime_type?: string | null;
  size_bytes: number | null;
  created_at?: string;
  updated_at?: string;
  category?: string | null;
};

export function mediaKindFor(
  entry:
    | Pick<Entry, 'name' | 'mime_detected'>
    | { name: string; mime_detected?: string | null; mime_type?: string | null }
): MediaKind | null {
  const mime =
    ('mime_detected' in entry ? entry.mime_detected : null) ||
    ('mime_type' in entry ? entry.mime_type : null);
  if (mime && IMAGE_MIMES.has(mime)) return 'image';
  if (mime && VIDEO_MIMES.has(mime)) return 'video';
  const name = entry.name.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|avif|bmp|ico|tiff?|heic|heif)$/.test(name)) return 'image';
  if (/\.(mp4|m4v|webm|mov|qt|mkv|mk3d|avi|ogv|ogg|mpg|mpeg|mpe|ts|mts|m2ts|flv|wmv|asf|3gp|3g2)$/.test(name)) {
    return 'video';
  }
  return null;
}

export type PreviewSourceSet = { preview: string; thumbnail?: string; download?: string };

export type MediaViewerProps = {
  entry?: ViewerItem;
  items?: ViewerItem[];
  index?: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
  sources?: PreviewSourceSet;
  sourceFor?: (item: ViewerItem) => PreviewSourceSet;
  showDownload?: boolean;
  loadDetails?: (item: ViewerItem) => Promise<EntryDetails | null>;
};

export function isDocumentPreviewable(entry: Pick<ViewerItem, 'name'>): boolean {
  return /\.(pdf|docx?|pptx?|xlsx?|rtf|csv|txt|md|markdown|json)$/i.test(entry.name);
}

export function isFilePreviewable(
  entry: Pick<ViewerItem, 'name' | 'mime_detected'> & { mime_type?: string | null }
): boolean {
  return mediaKindFor(entry) !== null || isDocumentPreviewable(entry);
}

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function matchesMedia(query: string): boolean {
  try {
    return Boolean(window.matchMedia?.(query).matches);
  } catch {
    return false;
  }
}

function isTouchUi(): boolean {
  return matchesMedia('(hover: none), (pointer: coarse)');
}

function isDesktopViewer(): boolean {
  return matchesMedia('(min-width: 1024px)');
}

function prefersReducedMotion(): boolean {
  return matchesMedia('(prefers-reduced-motion: reduce)');
}

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function appendBust(url: string, bust: number): string {
  if (!bust) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_r=${bust}`;
}

type PanelProps = {
  item: ViewerItem;
  slot: -1 | 0 | 1;
  isCurrent: boolean;
  resolved: PreviewSourceSet;
  kind: MediaKind;
  rotation: number;
  zoomPan: ZoomPan;
  animatingMedia: boolean;
  retryBust: number;
  mediaRef: ((node: HTMLDivElement | null) => void) | null;
  videoRef: React.RefObject<HTMLVideoElement | null> | null;
  onNaturalSize: (size: { width: number; height: number } | null) => void;
  onImageLoadState: (state: { loaded: boolean; error: boolean }) => void;
  onVideoMeta: (video: HTMLVideoElement) => void;
  onVideoTime: (video: HTMLVideoElement) => void;
  onVideoPlayState: (paused: boolean) => void;
  onVideoMuted: (muted: boolean) => void;
  onVideoError: () => void;
  videoPaused: boolean;
  onToggleVideoPlay: () => void;
};

function ViewerPanel({
  item,
  slot,
  isCurrent,
  resolved,
  kind,
  rotation,
  zoomPan,
  animatingMedia,
  retryBust,
  mediaRef,
  videoRef,
  onNaturalSize,
  onImageLoadState,
  onVideoMeta,
  onVideoTime,
  onVideoPlayState,
  onVideoMuted,
  onVideoError,
  videoPaused,
  onToggleVideoPlay
}: PanelProps) {
  const fitRef = useRef<HTMLDivElement>(null);
  const resImgRef = useRef<HTMLImageElement>(null);
  const [fitBox, setFitBox] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [resLoaded, setResLoaded] = useState(false);
  const [phHidden, setPhHidden] = useState(false);
  const [error, setError] = useState(false);

  const effectiveSrc = appendBust(resolved.preview, retryBust);

  useEffect(() => {
    setNatural(null);
    setResLoaded(false);
    setPhHidden(false);
    setError(false);
  }, [item.id, effectiveSrc, kind]);

  useLayoutEffect(() => {
    const node = fitRef.current;
    if (!node) return;
    const measure = () => setFitBox({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (kind !== 'image') return;
    const img = resImgRef.current;
    if (img && img.complete && img.naturalWidth > 0 && !resLoaded) {
      const nextNat = { width: img.naturalWidth, height: img.naturalHeight };
      setNatural(nextNat);
      setResLoaded(true);
      setError(false);
    }
  }, [kind, effectiveSrc, resLoaded]);

  useEffect(() => {
    if (!isCurrent) return;
    onNaturalSize(natural);
  }, [isCurrent, natural, onNaturalSize]);

  useEffect(() => {
    if (!isCurrent || kind !== 'image') return;
    onImageLoadState({ loaded: resLoaded, error });
  }, [isCurrent, kind, resLoaded, error, onImageLoadState]);

  const appliedRotation = isCurrent ? rotation : 0;
  const sized = natural
    ? fitContain(natural.width, natural.height, fitBox.width, fitBox.height, appliedRotation)
    : null;

  const hasTransform =
    isCurrent && (zoomPan.zoom > LB_MIN_ZOOM || zoomPan.x !== 0 || zoomPan.y !== 0 || appliedRotation !== 0);
  const mediaTransform = hasTransform
    ? `translate3d(${zoomPan.x}px, ${zoomPan.y}px, 0) scale(${zoomPan.zoom})${
        appliedRotation ? ` rotate(${appliedRotation}deg)` : ''
      }`
    : undefined;

  return (
    <div
      className={'av-panel' + (isCurrent ? ' is-current' : '')}
      style={{ '--slot': slot } as React.CSSProperties}
      aria-hidden={isCurrent ? 'false' : 'true'}
    >
      <div className="av-fit" ref={fitRef}>
        <div
          ref={mediaRef ?? undefined}
          className={
            'av-media' +
            (sized ? ' is-sized' : '') +
            (animatingMedia ? ' is-animating' : '')
          }
          style={{
            width: sized ? `${sized.width}px` : undefined,
            height: sized ? `${sized.height}px` : undefined,
            transform: mediaTransform
          }}
        >
          {kind === 'image' ? (
            <>
              <img
                ref={resImgRef}
                className={'av-res' + (resLoaded ? ' is-loaded' : '')}
                src={effectiveSrc}
                alt={item.name}
                draggable={false}
                decoding="async"
                onLoad={(event) => {
                  const img = event.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    setNatural({ width: img.naturalWidth, height: img.naturalHeight });
                  }
                  setResLoaded(true);
                  setError(false);
                }}
                onError={() => setError(true)}
              />
              {resolved.thumbnail && (
                <img
                  className={'av-ph' + (phHidden ? ' is-hidden' : '')}
                  src={resolved.thumbnail}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  decoding="async"
                  onLoad={(event) => {
                    const img = event.currentTarget;
                    if (!natural && img.naturalWidth > 0 && img.naturalHeight > 0) {
                      setNatural({ width: img.naturalWidth, height: img.naturalHeight });
                    }
                  }}
                  onError={() => setPhHidden(true)}
                />
              )}
            </>
          ) : isCurrent ? (
            <>
              <video
                ref={videoRef ?? undefined}
                key={item.id}
                className="av-res is-loaded"
                src={effectiveSrc}
                poster={resolved.thumbnail}
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  setNatural({ width: video.videoWidth || 16, height: video.videoHeight || 9 });
                  onVideoMeta(video);
                }}
                onTimeUpdate={(event) => onVideoTime(event.currentTarget)}
                onPlay={() => onVideoPlayState(false)}
                onPause={() => onVideoPlayState(true)}
                onVolumeChange={(event) => onVideoMuted(event.currentTarget.muted)}
                onError={onVideoError}
              />
              {videoPaused && !error && (
                <button
                  type="button"
                  className="av-video-play"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleVideoPlay();
                  }}
                  aria-label="Play video"
                >
                  <Play size={28} />
                </button>
              )}
            </>
          ) : resolved.thumbnail ? (
            <img
              className="av-res is-loaded"
              src={resolved.thumbnail}
              alt=""
              draggable={false}
              decoding="async"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function MediaViewer({
  entry,
  items,
  index = 0,
  onIndexChange,
  onClose,
  sources,
  sourceFor,
  showDownload = true,
  loadDetails
}: MediaViewerProps) {
  const gallery = items && items.length > 0 ? items : entry ? [entry] : [];
  const safeIndex = clampIndex(index, gallery.length);
  const current = gallery[safeIndex];
  const resolveItemSources = useCallback(
    (item: ViewerItem): PreviewSourceSet =>
      sourceFor?.(item) ??
      sources ?? {
        preview: previewUrl(item.id),
        thumbnail: thumbnailUrl(item.id),
        download: downloadUrl(item.id)
      },
    [sourceFor, sources]
  );

  const currentResolved = current ? resolveItemSources(current) : null;
  const currentKind: MediaKind = current ? mediaKindFor(current) || 'image' : 'image';

  const [opening, setOpening] = useState(true);
  const [zoomPan, setZoomPan] = useState<ZoomPan>(() => resetZoomPan());
  const [animatingMedia, setAnimatingMedia] = useState(false);
  const [panning, setPanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [retryBust, setRetryBust] = useState(0);
  const [currentNatural, setCurrentNatural] = useState<{ width: number; height: number } | null>(null);
  const [imageLoadState, setImageLoadState] = useState({ loaded: false, error: false });
  const [videoError, setVideoError] = useState(false);
  const [playbackRate, setPlaybackRateValue] = useState(1);
  const [videoProgress, setVideoProgress] = useState({ current: 0, duration: 0 });
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoMuted, setVideoMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [details, setDetails] = useState<EntryDetails | null>(null);
  const [chromeHidden, setChromeHidden] = useState(false);
  const [viewerMouse, setViewerMouse] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [slideRunKey, setSlideRunKey] = useState(0);
  const [toastMsg, setToastMsg] = useState('');
  const [slideState, setSlideState] = useState<{ dir: 'next' | 'prev'; targetIndex: number } | null>(null);

  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const curMediaRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const filmRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const zoomPanRef = useRef<ZoomPan>(zoomPan);
  zoomPanRef.current = zoomPan;
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;
  const slideStateRef = useRef(slideState);
  slideStateRef.current = slideState;

  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureModeRef = useRef<null | 'drag' | 'pan' | 'pinch'>(null);
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    axis: DragAxis;
    moved: boolean;
    samples: Array<{ t: number; x: number; y: number }>;
  }>({ startX: 0, startY: 0, axis: null, moved: false, samples: [] });
  const pinchStartRef = useRef({ dist: 0, zoom: 1, x: 0, y: 0, midX: 0, midY: 0 });
  const lastTapRef = useRef({ t: 0, x: 0, y: 0 });
  const tapTimerRef = useRef<number>(0);
  const chromeTimerRef = useRef<number>(0);
  const slideAnimTimerRef = useRef<number>(0);
  const slideFallbackTimerRef = useRef<number>(0);
  const playTimerRef = useRef<number>(0);
  const toastTimerRef = useRef<number>(0);
  const wheelNavAccRef = useRef(0);
  const wheelNavLockRef = useRef(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const stateRef = useRef({
    safeIndex,
    galleryLength: gallery.length,
    kind: currentKind,
    infoOpen,
    playing,
    viewerMouse,
    chromeHidden
  });
  stateRef.current = {
    safeIndex,
    galleryLength: gallery.length,
    kind: currentKind,
    infoOpen,
    playing,
    viewerMouse,
    chromeHidden
  };

  const showToast = useCallback((message: string) => {
    window.clearTimeout(toastTimerRef.current);
    setToastMsg(message);
    toastTimerRef.current = window.setTimeout(() => setToastMsg(''), 2600);
  }, []);

  const releaseWakeLock = useCallback(() => {
    void wakeLockRef.current?.release?.().catch(() => undefined);
    wakeLockRef.current = null;
  }, []);

  const requestWakeLock = useCallback(async () => {
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request?.('screen')) ?? null;
    } catch {
      wakeLockRef.current = null;
    }
  }, []);

  const scheduleChromeHide = useCallback((mouseOverride?: boolean, playingOverride?: boolean) => {
    window.clearTimeout(chromeTimerRef.current);
    const isMouse = mouseOverride ?? stateRef.current.viewerMouse;
    const isPlaying = playingOverride ?? stateRef.current.playing;
    if (!isMouse && !isPlaying) return;
    chromeTimerRef.current = window.setTimeout(() => {
      const shell = shellRef.current;
      if (!shell) return;
      const active = document.activeElement;
      const focusInChrome =
        active instanceof HTMLElement &&
        active !== shell &&
        shell.contains(active) &&
        active.matches(':focus-visible');
      const hovered = shell.querySelector(
        '.av-viewer-top:hover, .av-viewer-bottom:hover, .av-nav:hover, .av-info:hover'
      );
      if (focusInChrome || hovered) {
        scheduleChromeHide();
        return;
      }
      setChromeHidden(true);
    }, isPlaying ? 1200 : 2600);
  }, []);

  const showChrome = useCallback(
    (mouseOverride?: boolean) => {
      setChromeHidden(false);
      scheduleChromeHide(mouseOverride);
    },
    [scheduleChromeHide]
  );

  const toggleChrome = useCallback(() => {
    if (stateRef.current.chromeHidden) showChrome();
    else {
      window.clearTimeout(chromeTimerRef.current);
      setChromeHidden(true);
    }
  }, [showChrome]);

  // Body scroll lock, initial focus & touch coach mark
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';

    const openTimer = window.setTimeout(() => setOpening(false), 320);
    const frame = window.requestAnimationFrame(() => {
      (isTouchUi() ? shellRef.current : closeButtonRef.current)?.focus({ preventScroll: true });
    });

    if (isTouchUi() && !safeStorageGet(COACH_KEY)) {
      safeStorageSet(COACH_KEY, '1');
      window.setTimeout(() => showToast('Swipe to switch · swipe down to close · double-tap to zoom'), 450);
    }

    return () => {
      window.clearTimeout(openTimer);
      window.clearTimeout(tapTimerRef.current);
      window.clearTimeout(chromeTimerRef.current);
      window.clearTimeout(slideAnimTimerRef.current);
      window.clearTimeout(slideFallbackTimerRef.current);
      window.clearTimeout(playTimerRef.current);
      window.clearTimeout(toastTimerRef.current);
      window.cancelAnimationFrame(frame);
      releaseWakeLock();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [releaseWakeLock, showToast]);

  // Reset per-item state when switching item
  useEffect(() => {
    setZoomPan(resetZoomPan());
    setAnimatingMedia(false);
    setRotation(0);
    setRetryBust(0);
    setCurrentNatural(null);
    setImageLoadState({ loaded: false, error: false });
    setVideoError(false);
    setPlaybackRateValue(1);
    setVideoProgress({ current: 0, duration: 0 });
    setVideoPaused(true);
    setDetails(null);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      videoRef.current.playbackRate = 1;
    }
  }, [current?.id, currentKind]);

  // Clear pending slide state once parent index updates
  useLayoutEffect(() => {
    if (slideState && safeIndex === slideState.targetIndex) {
      window.clearTimeout(slideFallbackTimerRef.current);
      setSlideState(null);
      if (trackRef.current) {
        trackRef.current.style.transform = '';
      }
    }
  }, [safeIndex, slideState]);

  // Keep filmstrip active thumbnail centered
  useEffect(() => {
    const film = filmRef.current;
    if (!film) return;
    const item = film.querySelector<HTMLElement>(`[data-index="${safeIndex}"]`);
    if (!item) return;
    const left = item.offsetLeft - film.clientWidth / 2 + item.offsetWidth / 2;
    film.scrollTo?.({ left, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [safeIndex, gallery.length]);

  // Prefetch +2 image
  useEffect(() => {
    const ahead = gallery[safeIndex + 2];
    if (!ahead || mediaKindFor(ahead) !== 'image') return;
    const src = resolveItemSources(ahead).preview;
    if (!src) return;
    const img = new Image();
    img.src = src;
  }, [safeIndex, gallery, resolveItemSources]);

  // Load details when info drawer opens
  useEffect(() => {
    if (!infoOpen || !current || !loadDetails) return;
    let cancelled = false;
    loadDetails(current)
      .then((value) => {
        if (!cancelled) setDetails(value);
      })
      .catch(() => {
        if (!cancelled) setDetails(null);
      });
    return () => {
      cancelled = true;
    };
  }, [infoOpen, current, loadDetails]);

  // Track fullscreen changes
  useEffect(() => {
    function onFullscreenChange() {
      setFullscreen(document.fullscreenElement === shellRef.current);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const clampCurrentPan = useCallback((candidate: ZoomPan): ZoomPan => {
    const media = curMediaRef.current;
    const stage = stageRef.current;
    if (!media || !stage) return candidate;
    const rect = stage.getBoundingClientRect();
    const turned = ((rotationRef.current % 180) + 180) % 180 !== 0;
    const baseW = turned ? media.offsetHeight : media.offsetWidth;
    const baseH = turned ? media.offsetWidth : media.offsetHeight;
    return clampPan(candidate, { baseW, baseH, stageW: rect.width, stageH: rect.height });
  }, []);

  const resetZoom = useCallback((animate = false) => {
    const z = resetZoomPan();
    zoomPanRef.current = z;
    setAnimatingMedia(animate);
    setZoomPan(z);
    if (animate) {
      window.setTimeout(() => setAnimatingMedia(false), 280);
    }
  }, []);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, nextZoom: number, animate = false) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const applied = applyZoomAt(zoomPanRef.current, nextZoom, clientX, clientY, rect);
      const clamped = clampCurrentPan(applied);
      zoomPanRef.current = clamped;
      setAnimatingMedia(animate);
      setZoomPan(clamped);
      if (animate) {
        window.setTimeout(() => setAnimatingMedia(false), 280);
      }
    },
    [clampCurrentPan]
  );

  const stageCenter = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 };
  }, []);

  const bounce = useCallback((sign: 1 | -1) => {
    const track = trackRef.current;
    if (!track?.animate || prefersReducedMotion()) return;
    track.animate(
      [
        { transform: 'translateX(0)' },
        { transform: `translateX(${sign * 28}px)` },
        { transform: 'translateX(0)' }
      ],
      { duration: 280, easing: 'ease-out' }
    );
  }, []);

  const snapTrackBack = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    track.classList.add('is-animating');
    track.style.transform = '';
    window.setTimeout(() => track.classList.remove('is-animating'), 320);
  }, []);

  const finishSlideNow = useCallback(() => {
    window.clearTimeout(slideAnimTimerRef.current);
    const activeSlide = slideStateRef.current;
    if (!activeSlide) return;
    onIndexChange?.(activeSlide.targetIndex);
    slideFallbackTimerRef.current = window.setTimeout(() => {
      setSlideState(null);
      if (trackRef.current) trackRef.current.style.transform = '';
    }, 80);
  }, [onIndexChange]);

  const go = useCallback(
    (dir: 'prev' | 'next') => {
      const len = stateRef.current.galleryLength;
      const idx = stateRef.current.safeIndex;
      if (len < 1 || !onIndexChange) return;

      if (slideStateRef.current) {
        finishSlideNow();
        return;
      }

      if (dir === 'prev' && idx <= 0) {
        bounce(1);
        return;
      }
      if (dir === 'next' && idx >= len - 1) {
        bounce(-1);
        return;
      }

      const targetIndex = dir === 'next' ? idx + 1 : idx - 1;
      resetZoom(false);

      if (prefersReducedMotion() || !trackRef.current) {
        onIndexChange(targetIndex);
        return;
      }

      const nextSlide = { dir, targetIndex };
      slideStateRef.current = nextSlide;
      setSlideState(nextSlide);
      slideAnimTimerRef.current = window.setTimeout(() => {
        finishSlideNow();
      }, 300);
    },
    [bounce, finishSlideNow, onIndexChange, resetZoom]
  );

  // Slideshow timer
  useEffect(() => {
    window.clearTimeout(playTimerRef.current);
    if (!playing) {
      releaseWakeLock();
      return;
    }
    if (gallery.length <= 1 || currentKind === 'video') {
      setPlaying(false);
      return;
    }
    void requestWakeLock();
    setSlideRunKey((k) => k + 1);
    playTimerRef.current = window.setTimeout(() => {
      if (safeIndex >= gallery.length - 1) {
        setPlaying(false);
        showToast('Reached the last item');
        return;
      }
      go('next');
    }, SLIDE_MS);
    return () => window.clearTimeout(playTimerRef.current);
  }, [playing, safeIndex, gallery.length, currentKind, go, releaseWakeLock, requestWakeLock, showToast]);

  function toggleSlideshow() {
    if (gallery.length <= 1) return;
    if (currentKind === 'video') {
      showToast('Slideshow pauses on videos');
      return;
    }
    const next = !playing;
    setPlaying(next);
    if (next) {
      resetZoom(false);
      setChromeHidden(true);
    } else {
      showChrome();
    }
  }

  function setPlaybackRate(rate: number) {
    setPlaybackRateValue(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setVideoError(true));
    else video.pause();
  }

  function seekBy(seconds: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), video.duration);
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setVideoMuted(video.muted);
  }

  function toggleFullscreen() {
    if (!shellRef.current?.requestFullscreen) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void shellRef.current.requestFullscreen().catch(() => undefined);
  }

  function showActualSize() {
    const media = curMediaRef.current;
    if (!currentNatural || !media || !media.offsetWidth) return;
    const center = stageCenter();
    const ratio = currentNatural.width / media.offsetWidth;
    zoomAt(center.x, center.y, clampZoom(ratio, LB_MIN_ZOOM, LB_MAX_ZOOM), true);
  }

  function rotateBy(delta: number) {
    setRotation((value) => (value + delta + 360) % 360);
    setZoomPan((currentZoom) => ({ ...currentZoom, x: 0, y: 0 }));
  }

  // Non-passive wheel handler (zoom + horizontal trackpad swipe)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || currentKind !== 'image') return;
    function onWheel(event: globalThis.WheelEvent) {
      event.preventDefault();
      if (zoomPanRef.current.zoom <= LB_MIN_ZOOM && !event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5) {
        const now = performance.now();
        if (now < wheelNavLockRef.current) return;
        wheelNavAccRef.current += event.deltaX;
        if (Math.abs(wheelNavAccRef.current) > 60) {
          go(wheelNavAccRef.current > 0 ? 'next' : 'prev');
          wheelNavAccRef.current = 0;
          wheelNavLockRef.current = now + 450;
        }
        return;
      }
      const k = event.ctrlKey ? 0.01 : 0.0016;
      const nextZoom = zoomPanRef.current.zoom * Math.exp(-event.deltaY * k);
      zoomAt(event.clientX, event.clientY, nextZoom, false);
      showChrome();
    }
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [currentKind, current?.id, go, zoomAt, showChrome]);

  // Keyboard shortcuts & focus trap
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const typing = target instanceof HTMLElement && target.closest('input, select, textarea');
      const snap = stateRef.current;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (snap.infoOpen && !isDesktopViewer()) setInfoOpen(false);
        else onClose();
        return;
      }

      if (event.key === 'Tab') {
        const shell = shellRef.current;
        if (!shell) return;
        const focusable = Array.from(
          shell.querySelectorAll<HTMLElement>('button:not([disabled]):not([hidden]), a[href], select:not([disabled]), input:not([disabled])')
        ).filter((el) => el.offsetParent !== null && el.tabIndex !== -1);
        if (!focusable.length) {
          event.preventDefault();
          shell.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === shell)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (typing || event.ctrlKey || event.metaKey) return;
      if (event.altKey && snap.kind === 'video' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        go(event.key === 'ArrowLeft' ? 'prev' : 'next');
        showChrome();
        return;
      }
      if (event.altKey) return;

      const onButton = document.activeElement instanceof HTMLButtonElement;
      const key = event.key;

      if (snap.kind === 'video') {
        if (key === ' ' || key === 'k' || key === 'K') {
          event.preventDefault();
          togglePlayback();
          showChrome();
          return;
        }
        if (key === 'ArrowLeft') {
          event.preventDefault();
          seekBy(event.shiftKey ? -30 : -5);
          showChrome();
          return;
        }
        if (key === 'ArrowRight') {
          event.preventDefault();
          seekBy(event.shiftKey ? 30 : 5);
          showChrome();
          return;
        }
        if (key === 'm' || key === 'M') {
          event.preventDefault();
          toggleMute();
          showChrome();
          return;
        }
      }

      if (key === 'ArrowLeft' || key === 'j' || key === 'J') {
        event.preventDefault();
        go('prev');
        showChrome();
      } else if (key === 'ArrowRight' || key === 'k' || key === 'K') {
        event.preventDefault();
        go('next');
        showChrome();
      } else if (key === ' ' && !onButton && snap.kind === 'image') {
        event.preventDefault();
        go('next');
        showChrome();
      } else if (key === 'Home' && snap.galleryLength > 1) {
        event.preventDefault();
        onIndexChange?.(0);
        showChrome();
      } else if (key === 'End' && snap.galleryLength > 1) {
        event.preventDefault();
        onIndexChange?.(snap.galleryLength - 1);
        showChrome();
      } else if (key === 'i' || key === 'I') {
        event.preventDefault();
        setInfoOpen((open) => !open);
        showChrome();
      } else if (key === 'f' || key === 'F') {
        event.preventDefault();
        toggleFullscreen();
        showChrome();
      } else if (key === 'p' || key === 'P') {
        event.preventDefault();
        if (snap.galleryLength > 1 && snap.kind === 'image') {
          setPlaying((prev) => {
            const next = !prev;
            if (next) {
              resetZoom(false);
              setChromeHidden(true);
            } else {
              showChrome();
            }
            return next;
          });
        }
      } else if ((key === 'd' || key === 'D') && showDownload && currentResolved?.download) {
        event.preventDefault();
        const a = document.createElement('a');
        a.href = currentResolved.download;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else if (snap.kind === 'image' && (key === '+' || key === '=')) {
        event.preventDefault();
        const c = stageCenter();
        zoomAt(c.x, c.y, clampZoom(zoomPanRef.current.zoom * 1.5), true);
        showChrome();
      } else if (snap.kind === 'image' && (key === '-' || key === '_')) {
        event.preventDefault();
        const c = stageCenter();
        zoomAt(c.x, c.y, clampZoom(zoomPanRef.current.zoom / 1.5), true);
        showChrome();
      } else if (snap.kind === 'image' && key === '0') {
        event.preventDefault();
        resetZoom(true);
        showChrome();
      } else if (snap.kind === 'image' && key === '1') {
        event.preventDefault();
        showActualSize();
        showChrome();
      } else if (snap.kind === 'image' && key === 'r') {
        event.preventDefault();
        rotateBy(90);
        showChrome();
      } else if (snap.kind === 'image' && key === 'R') {
        event.preventDefault();
        rotateBy(-90);
        showChrome();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (!current || !currentResolved) return null;

  const canPrev = safeIndex > 0;
  const canNext = safeIndex < gallery.length - 1;
  const loadError = currentKind === 'image' ? imageLoadState.error : videoError;
  const loadingNow = currentKind === 'image' && !imageLoadState.loaded && !imageLoadState.error;

  function pushSample(x: number, y: number) {
    const t = performance.now();
    const samples = gestureRef.current.samples;
    samples.push({ t, x, y });
    while (samples.length > 2 && t - samples[0].t > 100) samples.shift();
  }

  function velocity() {
    const samples = gestureRef.current.samples;
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = Math.max(1, b.t - a.t);
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  function setDragVisual(dx: number, dy: number) {
    const axis = gestureRef.current.axis;
    if (axis === 'x' && trackRef.current) {
      trackRef.current.style.transform = `translate3d(${edgeResist(dx, canPrev, canNext)}px, 0, 0)`;
    } else if (axis === 'y' && curMediaRef.current) {
      const h = stageRef.current?.clientHeight || 800;
      const rot = rotationRef.current ? ` rotate(${rotationRef.current}deg)` : '';
      if (dy > 0) {
        const p = Math.min(1, dy / h);
        curMediaRef.current.style.transform = `translate3d(${dx * 0.4}px, ${dy}px, 0) scale(${1 - p * 0.3})${rot}`;
        shellRef.current?.style.setProperty('--av-dim', String(Math.min(0.85, (dy / h) * 1.6)));
      } else {
        curMediaRef.current.style.transform = `translate3d(0, ${dy * 0.25}px, 0)${rot}`;
      }
    }
  }

  function releaseDragVisual() {
    const media = curMediaRef.current;
    if (media) {
      media.classList.add('is-animating');
      media.style.transform = rotationRef.current ? `rotate(${rotationRef.current}deg)` : '';
      window.setTimeout(() => media.classList.remove('is-animating'), 280);
    }
    shellRef.current?.style.setProperty('--av-dim', '0');
  }

  function dismissFromDrag(dy: number) {
    const media = curMediaRef.current;
    const h = stageRef.current?.clientHeight || 800;
    const rot = rotationRef.current ? ` rotate(${rotationRef.current}deg)` : '';
    if (media) {
      media.classList.add('is-animating');
      media.style.transform = `translate3d(0, ${Math.max(dy, h * 0.6)}px, 0) scale(0.7)${rot}`;
    }
    shellRef.current?.style.setProperty('--av-dim', '1');
    window.setTimeout(() => onClose(), 180);
  }

  function startPinch() {
    const [a, b] = [...pointersRef.current.values()];
    if (!a || !b) return;
    pinchStartRef.current = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      zoom: zoomPanRef.current.zoom,
      x: zoomPanRef.current.x,
      y: zoomPanRef.current.y,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2
    };
    gestureModeRef.current = 'pinch';
    setPanning(true);
  }

  function handleTap(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse') {
      if (currentKind === 'video' && event.target instanceof HTMLVideoElement) {
        togglePlayback();
        return;
      }
      const m = curMediaRef.current?.getBoundingClientRect();
      const inside =
        m &&
        event.clientX >= m.left &&
        event.clientX <= m.right &&
        event.clientY >= m.top &&
        event.clientY <= m.bottom;
      if (!inside && zoomPanRef.current.zoom <= LB_MIN_ZOOM) {
        onClose();
      }
      return;
    }
    const now = performance.now();
    if (
      currentKind === 'image' &&
      now - lastTapRef.current.t < 300 &&
      Math.hypot(event.clientX - lastTapRef.current.x, event.clientY - lastTapRef.current.y) < 30
    ) {
      window.clearTimeout(tapTimerRef.current);
      lastTapRef.current.t = 0;
      zoomAt(event.clientX, event.clientY, doubleTapZoom(zoomPanRef.current.zoom), true);
      return;
    }
    lastTapRef.current = { t: now, x: event.clientX, y: event.clientY };
    window.clearTimeout(tapTimerRef.current);
    tapTimerRef.current = window.setTimeout(() => {
      if (infoOpen && !isDesktopViewer()) setInfoOpen(false);
      else toggleChrome();
    }, 260);
  }

  function onStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, input, select, a')) return;

    const isMouse = event.pointerType === 'mouse';
    if (isMouse !== viewerMouse) setViewerMouse(isMouse);

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    if (slideStateRef.current) finishSlideNow();

    if (pointersRef.current.size === 2 && currentKind === 'image') {
      if (gestureModeRef.current === 'drag') {
        if (gestureRef.current.axis === 'x') snapTrackBack();
        else if (gestureRef.current.axis === 'y') releaseDragVisual();
        setDragging(false);
      }
      window.clearTimeout(tapTimerRef.current);
      startPinch();
      return;
    }
    if (pointersRef.current.size > 2) return;

    gestureRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      axis: null,
      moved: false,
      samples: []
    };
    pushSample(event.clientX, event.clientY);

    if (currentKind === 'image' && zoomPanRef.current.zoom > LB_MIN_ZOOM) {
      gestureModeRef.current = 'pan';
      setPanning(true);
    } else {
      gestureModeRef.current = 'drag';
    }
  }

  function onStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const prev = pointersRef.current.get(event.pointerId);
    if (!prev) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (gestureModeRef.current === 'pinch' && pointersRef.current.size >= 2 && stageRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const rect = stageRef.current.getBoundingClientRect();
      const ps = pinchStartRef.current;
      const next = pinchAnchored(
        { zoom: ps.zoom, x: ps.x, y: ps.y },
        ps.dist,
        Math.hypot(a.x - b.x, a.y - b.y),
        { x: ps.midX, y: ps.midY },
        { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        rect
      );
      const clamped = clampCurrentPan(next);
      zoomPanRef.current = clamped;
      setZoomPan(clamped);
      return;
    }

    const dx = event.clientX - gestureRef.current.startX;
    const dy = event.clientY - gestureRef.current.startY;
    pushSample(event.clientX, event.clientY);
    if (!gestureRef.current.moved && Math.hypot(dx, dy) > 6) gestureRef.current.moved = true;

    if (gestureModeRef.current === 'pan') {
      const next = clampCurrentPan({
        zoom: zoomPanRef.current.zoom,
        x: zoomPanRef.current.x + (event.clientX - prev.x),
        y: zoomPanRef.current.y + (event.clientY - prev.y)
      });
      zoomPanRef.current = next;
      setZoomPan(next);
    } else if (gestureModeRef.current === 'drag') {
      if (!gestureRef.current.axis) {
        gestureRef.current.axis = resolveDragAxis(dx, dy);
        if (!gestureRef.current.axis) return;
        setDragging(true);
        window.clearTimeout(tapTimerRef.current);
      }
      setDragVisual(dx, dy);
    }
  }

  function onStagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.delete(event.pointerId);
    const cancelled = event.type === 'pointercancel';

    if (gestureModeRef.current === 'pinch') {
      if (pointersRef.current.size === 1) {
        const [rest] = [...pointersRef.current.values()];
        gestureRef.current = {
          startX: rest.x,
          startY: rest.y,
          axis: null,
          moved: true,
          samples: []
        };
        gestureModeRef.current = zoomPanRef.current.zoom > LB_MIN_ZOOM ? 'pan' : null;
        return;
      }
      if (pointersRef.current.size === 0) {
        gestureModeRef.current = null;
        setPanning(false);
        if (shouldSnapZoomOut(zoomPanRef.current.zoom) || zoomPanRef.current.zoom <= LB_MIN_ZOOM) {
          resetZoom(true);
        }
      }
      return;
    }

    if (pointersRef.current.size > 0) return;

    const mode = gestureModeRef.current;
    const axis = gestureRef.current.axis;
    const moved = gestureRef.current.moved;
    gestureModeRef.current = null;
    setPanning(false);
    setDragging(false);

    const dx = event.clientX - gestureRef.current.startX;
    const dy = event.clientY - gestureRef.current.startY;
    const { vx, vy } = velocity();

    if (mode === 'drag' && axis === 'x') {
      const zoomed = zoomPanRef.current.zoom > LB_MIN_ZOOM;
      const dir = cancelled ? null : resolveFlick(dx, dy, vx, zoomed) || resolveSwipe(dx, dy, zoomed);
      if (dir === 'prev' && canPrev) {
        if (trackRef.current) {
          trackRef.current.style.transform = '';
        }
        go('prev');
      } else if (dir === 'next' && canNext) {
        if (trackRef.current) {
          trackRef.current.style.transform = '';
        }
        go('next');
      } else {
        snapTrackBack();
      }
      return;
    }

    if (mode === 'drag' && axis === 'y') {
      if (!cancelled && shouldDismiss(dy, vy)) {
        dismissFromDrag(dy);
        return;
      }
      releaseDragVisual();
      if (!cancelled && dy < -60) setInfoOpen(true);
      return;
    }

    if (cancelled) return;
    if (!moved && (mode === 'drag' || mode === 'pan')) handleTap(event);
  }

  const slotEntries: Array<{ item: ViewerItem; idx: number; slot: -1 | 0 | 1 }> = [];
  if (safeIndex > 0) slotEntries.push({ item: gallery[safeIndex - 1], idx: safeIndex - 1, slot: -1 });
  slotEntries.push({ item: current, idx: safeIndex, slot: 0 });
  if (safeIndex < gallery.length - 1) {
    slotEntries.push({ item: gallery[safeIndex + 1], idx: safeIndex + 1, slot: 1 });
  }

  const backdropSrc = currentResolved.thumbnail || (currentKind === 'image' ? currentResolved.preview : '');
  const zoomLabel = `${Math.round(zoomPan.zoom * 10) / 10}×`;
  const width = details?.media.width ?? currentNatural?.width;
  const height = details?.media.height ?? currentNatural?.height;
  const trackSlideTransform = slideState
    ? `translate3d(calc(${slideState.dir === 'next' ? -1 : 1} * (100% + ${PANEL_GAP}px)), 0, 0)`
    : undefined;

  return (
    <div
      ref={shellRef}
      className={
        'av-viewer' +
        (opening ? ' is-opening' : '') +
        (chromeHidden ? ' chrome-hidden' : '') +
        (dragging ? ' is-dragging' : '') +
        (zoomPan.zoom > LB_MIN_ZOOM ? ' is-zoomed' : '') +
        (panning ? ' is-panning' : '') +
        (playing ? ' is-playing' : '') +
        (viewerMouse ? ' is-mouse' : '')
      }
      style={{ '--av-slide-ms': `${SLIDE_MS}ms` } as React.CSSProperties}
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      aria-busy={loadingNow ? 'true' : 'false'}
      tabIndex={-1}
      onPointerMove={(event) => {
        if (event.pointerType !== 'mouse') return;
        if (!viewerMouse) setViewerMouse(true);
        showChrome(true);
      }}
      onFocusCapture={(event) => {
        if (event.target !== shellRef.current) showChrome();
      }}
    >
      <div
        className="av-viewer-backdrop"
        aria-hidden="true"
        style={backdropSrc ? { backgroundImage: `url("${backdropSrc}")` } : undefined}
      />

      <div className="av-viewer-main">
        <div className="av-viewer-top">
          <button
            ref={closeButtonRef}
            type="button"
            className="av-vbtn"
            onClick={onClose}
            aria-label="Close preview"
            title="Close · Esc"
          >
            <ArrowLeft size={21} />
          </button>

          <div className="av-viewer-title">
            <span className="av-viewer-caption" title={current.name}>
              {current.name}
            </span>
            <span className="av-viewer-meta">
              <span>
                {gallery.length > 1
                  ? `${safeIndex + 1} / ${gallery.length}`
                  : currentKind === 'video'
                    ? 'Video'
                    : 'Photo'}
              </span>
              {current.size_bytes != null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{formatSize(current.size_bytes)}</span>
                </>
              )}
              {(current.created_at || current.updated_at) && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{formatDate(current.created_at || current.updated_at)}</span>
                </>
              )}
            </span>
          </div>

          <div className="av-viewer-top-actions">
            {currentKind === 'image' && (
              <>
                {zoomPan.zoom > LB_MIN_ZOOM && (
                  <button
                    type="button"
                    className="av-vbtn av-zoom-reset"
                    onClick={() => resetZoom(true)}
                    title="Reset zoom · 0"
                    aria-label={`Reset zoom (${zoomLabel})`}
                  >
                    {zoomLabel}
                  </button>
                )}
                <button
                  type="button"
                  className="av-vbtn av-hide-narrow"
                  onClick={() => rotateBy(-90)}
                  title="Rotate left · Shift+R"
                  aria-label="Rotate left"
                >
                  <RotateCcw size={18} />
                </button>
                <button
                  type="button"
                  className="av-vbtn av-hide-narrow"
                  onClick={() => rotateBy(90)}
                  title="Rotate right · R"
                  aria-label="Rotate right"
                >
                  <RotateCw size={18} />
                </button>
              </>
            )}

            <button
              type="button"
              className="av-vbtn av-only-desktop"
              onClick={toggleFullscreen}
              title="Fullscreen · F"
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-pressed={fullscreen}
              aria-keyshortcuts="F"
            >
              {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
            </button>

            {showDownload && currentResolved.download && (
              <a
                className="av-vbtn"
                href={currentResolved.download}
                title="Download · D"
                aria-label="Download original"
                aria-keyshortcuts="D"
              >
                <Download size={19} />
              </a>
            )}

            <button
              type="button"
              className="av-vbtn"
              onClick={() => setInfoOpen((open) => !open)}
              title="Information · I"
              aria-label="File information"
              aria-pressed={infoOpen}
              aria-keyshortcuts="I"
            >
              <Info size={19} />
            </button>
          </div>
        </div>

        <div className="av-slideshow-progress" aria-hidden="true">
          <span key={slideRunKey} />
        </div>

        <div
          ref={stageRef}
          className="av-stage"
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerCancel={onStagePointerUp}
          onDoubleClick={(event) => {
            if (!viewerMouse || currentKind !== 'image') return;
            event.preventDefault();
            zoomAt(event.clientX, event.clientY, doubleTapZoom(zoomPanRef.current.zoom), true);
          }}
        >
          <div
            ref={trackRef}
            className={'av-track' + (slideState ? ' is-animating' : '')}
            style={trackSlideTransform ? { transform: trackSlideTransform } : undefined}
          >
            {slotEntries.map(({ item, idx, slot }) => {
              const isCurrent = slot === 0;
              const panelResolved = resolveItemSources(item);
              const panelKind = mediaKindFor(item) || 'image';
              return (
                <ViewerPanel
                  key={`${idx}:${item.id}`}
                  item={item}
                  slot={slot}
                  isCurrent={isCurrent}
                  resolved={panelResolved}
                  kind={panelKind}
                  rotation={isCurrent ? rotation : 0}
                  zoomPan={isCurrent ? zoomPan : resetZoomPan()}
                  animatingMedia={isCurrent ? animatingMedia : false}
                  retryBust={isCurrent ? retryBust : 0}
                  mediaRef={isCurrent ? (node) => { curMediaRef.current = node; } : null}
                  videoRef={isCurrent ? videoRef : null}
                  onNaturalSize={setCurrentNatural}
                  onImageLoadState={setImageLoadState}
                  onVideoMeta={(video) => {
                    setVideoProgress({ current: video.currentTime, duration: video.duration });
                  }}
                  onVideoTime={(video) => {
                    setVideoProgress({ current: video.currentTime, duration: video.duration });
                  }}
                  onVideoPlayState={setVideoPaused}
                  onVideoMuted={setVideoMuted}
                  onVideoError={() => setVideoError(true)}
                  videoPaused={videoPaused}
                  onToggleVideoPlay={togglePlayback}
                />
              );
            })}
          </div>

          {loadError && (
            <div className="av-media-error" role="status" aria-live="polite">
              <AlertTriangle size={20} />
              <span>This file could not be loaded in the previewer.</span>
              <div className="av-media-error-actions">
                <button
                  type="button"
                  className="av-btn av-btn-sm"
                  onClick={() => {
                    setImageLoadState({ loaded: false, error: false });
                    setVideoError(false);
                    setRetryBust(Date.now());
                  }}
                >
                  Retry
                </button>
                {showDownload && currentResolved.download && (
                  <a className="av-btn av-btn-sm" href={currentResolved.download}>
                    <Download size={14} /> Download original
                  </a>
                )}
              </div>
            </div>
          )}

          {loadingNow && (
            <div className="av-viewer-spinner" role="status" aria-label="Loading image">
              <span className="av-spinner" />
            </div>
          )}
        </div>

        {gallery.length > 1 && (
          <>
            <button
              type="button"
              className="av-nav prev"
              disabled={!canPrev}
              onClick={(event) => {
                event.stopPropagation();
                go('prev');
              }}
              aria-label="Previous file"
              title="Previous · ←"
            >
              <ChevronLeft size={26} />
            </button>
            <button
              type="button"
              className="av-nav next"
              disabled={!canNext}
              onClick={(event) => {
                event.stopPropagation();
                go('next');
              }}
              aria-label="Next file"
              title="Next · →"
            >
              <ChevronRight size={26} />
            </button>
          </>
        )}

        {(gallery.length > 1 || (currentKind === 'video' && !loadError)) && (
          <div className="av-viewer-bottom">
            {currentKind === 'video' && !loadError && (
              <div className="av-video-bar">
                <button
                  type="button"
                  className="av-vbtn"
                  onClick={togglePlayback}
                  aria-label={videoPaused ? 'Play' : 'Pause'}
                >
                  {videoPaused ? <Play size={18} /> : <Pause size={18} />}
                </button>
                <input
                  className="av-video-scrubber"
                  type="range"
                  min={0}
                  max={videoProgress.duration || 0}
                  step={0.1}
                  value={Math.min(videoProgress.current, videoProgress.duration || 0)}
                  aria-label="Seek"
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (videoRef.current) videoRef.current.currentTime = next;
                    setVideoProgress((progress) => ({ ...progress, current: next }));
                  }}
                />
                <span className="av-video-time">
                  {formatPlaybackTime(videoProgress.current)} / {formatPlaybackTime(videoProgress.duration)}
                </span>
                <button
                  type="button"
                  className="av-vbtn"
                  onClick={toggleMute}
                  aria-label={videoMuted ? 'Unmute' : 'Mute'}
                >
                  {videoMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}
                </button>
                <label className="av-video-speed">
                  <span className="visually-hidden">Playback speed</span>
                  <select
                    value={playbackRate}
                    onChange={(event) => setPlaybackRate(Number(event.target.value))}
                  >
                    <option value="0.5">0.5×</option>
                    <option value="1">1×</option>
                    <option value="1.5">1.5×</option>
                    <option value="2">2×</option>
                  </select>
                </label>
              </div>
            )}

            {gallery.length > 1 && (
              <div
                ref={filmRef}
                className="av-film"
                role="listbox"
                aria-label="Media strip"
                aria-orientation="horizontal"
              >
                {gallery.map((item, idx) => {
                  const active = idx === safeIndex;
                  const thumb = resolveItemSources(item).thumbnail || resolveItemSources(item).preview;
                  const itemVideo = mediaKindFor(item) === 'video';
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={'av-film-item' + (active ? ' is-active' : '')}
                      data-index={idx}
                      tabIndex={-1}
                      role="option"
                      aria-selected={active}
                      aria-label={`${item.name} (${idx + 1})`}
                      onClick={() => {
                        if (idx === safeIndex) return;
                        if (Math.abs(idx - safeIndex) === 1) go(idx > safeIndex ? 'next' : 'prev');
                        else {
                          resetZoom(false);
                          onIndexChange?.(idx);
                        }
                      }}
                    >
                      {thumb && <img src={thumb} alt="" loading="lazy" decoding="async" draggable={false} />}
                      {itemVideo && (
                        <span className="av-film-video" aria-hidden="true">
                          <Film size={10} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {gallery.length > 1 && currentKind === 'image' && (
              <div className="av-tools" role="toolbar" aria-label="Viewer tools">
                <button
                  type="button"
                  className="av-tool"
                  onClick={toggleSlideshow}
                  title="Slideshow · P"
                  aria-label="Slideshow"
                  aria-pressed={playing}
                  aria-keyshortcuts="P"
                >
                  {playing ? <Pause size={17} /> : <Play size={17} />}
                  <span>{playing ? 'Pause' : 'Slideshow'}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {infoOpen && (
        <aside className="av-info" aria-label="File information">
          <div className="av-sheet-grip" aria-hidden="true" />
          <div className="av-info-head">
            <h2 className="av-info-title">Information</h2>
            <button
              type="button"
              className="av-vbtn"
              onClick={() => setInfoOpen(false)}
              aria-label="Close information"
            >
              <X size={18} />
            </button>
          </div>

          <div className="av-info-body">
            <div>
              <p className="av-info-name">{current.name}</p>
              <div className="av-info-tags">
                <span className="av-tag">
                  {details?.mime_type || current.mime_detected || current.mime_type || current.category || currentKind}
                </span>
                {gallery.length > 1 && (
                  <span className="av-tag">
                    {safeIndex + 1} / {gallery.length}
                  </span>
                )}
              </div>
            </div>

            <dl className="av-info-list">
              <dt>Size</dt>
              <dd>{formatSize(details?.size_bytes ?? current.size_bytes)}</dd>
              {width && height ? (
                <>
                  <dt>Dimensions</dt>
                  <dd>
                    {width} × {height} px
                  </dd>
                </>
              ) : null}
              <dt>Created</dt>
              <dd>{formatDate(details?.created_at || current.created_at)}</dd>
              <dt>Modified</dt>
              <dd>{formatDate(details?.updated_at || current.updated_at)}</dd>
              {details?.location && (
                <>
                  <dt>Location</dt>
                  <dd>{details.location}</dd>
                </>
              )}
              {details?.category && (
                <>
                  <dt>Category</dt>
                  <dd>{details.category}</dd>
                </>
              )}
            </dl>

            <div className="av-info-actions">
              {showDownload && currentResolved.download && (
                <a className="av-btn" href={currentResolved.download}>
                  <Download size={16} /> Download original
                </a>
              )}
              <a
                className="av-btn"
                href={currentResolved.preview}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={16} /> Open full size
              </a>
            </div>
          </div>

          <div className="av-info-keys av-only-fine">
            <p className="av-label">Shortcuts</p>
            <p className="av-keys">
              <span>
                <kbd>←</kbd>
                <kbd>→</kbd> navigate
              </span>
              <span>
                <kbd>+</kbd>
                <kbd>−</kbd>
                <kbd>0</kbd> zoom
              </span>
              <span>
                <kbd>R</kbd> rotate
              </span>
              <span>
                <kbd>P</kbd> slideshow
              </span>
              <span>
                <kbd>F</kbd> fullscreen
              </span>
              <span>
                <kbd>I</kbd> info
              </span>
              <span>
                <kbd>Esc</kbd> close
              </span>
            </p>
          </div>
        </aside>
      )}

      {toastMsg && (
        <div className="av-viewer-toast" role="status" aria-live="polite">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
