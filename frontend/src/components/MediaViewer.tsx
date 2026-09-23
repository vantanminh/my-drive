import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
  Maximize2,
  Minimize2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  X
} from 'lucide-react';
import { formatDate, formatSize } from '../format';
import { previewUrl, thumbnailUrl, downloadUrl } from '../api';
import type { Entry, EntryDetails } from '../types';

type MediaKind = 'image' | 'video';

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
  'image/tiff', 'image/heic', 'image/heif'
]);
const VIDEO_MIMES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo',
  'video/ogg', 'video/mpeg', 'video/mp2t', 'video/x-flv', 'video/x-ms-wmv', 'video/3gpp'
]);

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

export function mediaKindFor(entry: Pick<Entry, 'name' | 'mime_detected'> | { name: string; mime_detected?: string | null; mime_type?: string | null }): MediaKind | null {
  const mime = ('mime_detected' in entry ? entry.mime_detected : null) || ('mime_type' in entry ? entry.mime_type : null);
  if (mime && IMAGE_MIMES.has(mime)) return 'image';
  if (mime && VIDEO_MIMES.has(mime)) return 'video';
  const name = entry.name.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|avif|bmp|ico|tiff?|heic|heif)$/.test(name)) return 'image';
  if (/\.(mp4|m4v|webm|mov|qt|mkv|mk3d|avi|ogv|ogg|mpg|mpeg|mpe|ts|mts|m2ts|flv|wmv|asf|3gp|3g2)$/.test(name)) return 'video';
  return null;
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

type SourceSet = { preview: string; thumbnail?: string; download?: string };

type Props = {
  entry?: ViewerItem;
  items?: ViewerItem[];
  index?: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
  sources?: SourceSet;
  sourceFor?: (item: ViewerItem) => SourceSet;
  showDownload?: boolean;
  loadDetails?: (item: ViewerItem) => Promise<EntryDetails | null>;
};

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
}: Props) {
  const gallery = items && items.length > 0 ? items : entry ? [entry] : [];
  const safeIndex = Math.min(Math.max(index, 0), Math.max(gallery.length - 1, 0));
  const current = gallery[safeIndex];
  const kind = current ? mediaKindFor(current) || 'image' : 'image';
  const resolved = current
    ? sourceFor?.(current) ?? sources ?? {
      preview: previewUrl(current.id),
      thumbnail: thumbnailUrl(current.id),
      download: downloadUrl(current.id)
    }
    : null;

  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [loadError, setLoadError] = useState(false);
  const [playbackRate, setPlaybackRateValue] = useState(1);
  const [videoProgress, setVideoProgress] = useState({ current: 0, duration: 0 });
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoMuted, setVideoMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [details, setDetails] = useState<EntryDetails | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; pointer: number } | null>(null);
  const touchRef = useRef<{ x: number; y: number; at: number } | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    setLoadError(false);
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    setPlaybackRateValue(1);
    setVideoProgress({ current: 0, duration: 0 });
    setVideoPaused(true);
    setDetails(null);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      videoRef.current.playbackRate = 1;
    }
  }, [current?.id, kind]);

  useEffect(() => {
    if (!infoOpen || !current || !loadDetails) return;
    let cancelled = false;
    loadDetails(current)
      .then((value) => { if (!cancelled) setDetails(value); })
      .catch(() => { if (!cancelled) setDetails(null); });
    return () => { cancelled = true; };
  }, [infoOpen, current, loadDetails]);

  useEffect(() => {
    function onFullscreenChange() {
      setFullscreen(document.fullscreenElement === shellRef.current);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  function go(delta: number) {
    if (!onIndexChange || gallery.length < 2) return;
    const next = safeIndex + delta;
    if (next < 0 || next >= gallery.length) return;
    onIndexChange(next);
  }

  function setPlaybackRate(rate: number) {
    setPlaybackRateValue(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setLoadError(true));
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
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shellRef.current?.requestFullscreen();
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const typing = target instanceof HTMLElement && target.closest('input, select, textarea');
      if (event.key === 'Escape') {
        event.preventDefault();
        if (infoOpen) setInfoOpen(false);
        else onClose();
        return;
      }
      if (typing) return;
      if (event.key === 'ArrowLeft' && (kind === 'image' || event.altKey)) {
        event.preventDefault();
        go(-1);
        return;
      }
      if (event.key === 'ArrowRight' && (kind === 'image' || event.altKey)) {
        event.preventDefault();
        go(1);
        return;
      }
      if (event.key === 'i' || event.key === 'I') {
        event.preventDefault();
        setInfoOpen((open) => !open);
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      if (kind === 'video') {
        const video = videoRef.current;
        if (!video) return;
        if (event.key === ' ' || event.key === 'k') {
          event.preventDefault();
          togglePlayback();
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          seekBy(event.shiftKey ? -30 : -5);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          seekBy(event.shiftKey ? 30 : 5);
        } else if (event.key === 'm' || event.key === 'M') {
          event.preventDefault();
          toggleMute();
        }
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom((value) => Math.min(6, value + 0.25));
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoom((value) => Math.max(1, value - 0.25));
      } else if (event.key === '0') {
        event.preventDefault();
        setZoom(1);
        setRotation(0);
        setPan({ x: 0, y: 0 });
      } else if (event.key === 'r') {
        event.preventDefault();
        setRotation((value) => (value + 90) % 360);
      } else if (event.key === 'R') {
        event.preventDefault();
        setRotation((value) => (value + 270) % 360);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (!current || !resolved) return null;
  const canPrev = safeIndex > 0;
  const canNext = safeIndex < gallery.length - 1;

  function onWheel(event: WheelEvent) {
    if (kind !== 'image') return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.15 : -0.15;
    setZoom((value) => Math.min(6, Math.max(1, value + delta)));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (kind !== 'image' || zoom <= 1) {
      touchRef.current = { x: event.clientX, y: event.clientY, at: Date.now() };
      return;
    }
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, pointer: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y });
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = touchRef.current;
    dragRef.current = null;
    touchRef.current = null;
    if (!start || zoom > 1 || kind !== 'image') return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) return;
    go(dx < 0 ? 1 : -1);
  }

  const width = details?.media.width;
  const height = details?.media.height;

  return (
    <div className="viewer-backdrop" role="presentation">
      <section
        className={'viewer-shell' + (infoOpen ? ' viewer-with-info' : '')}
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-label={current.name}
      >
        <header className="viewer-topbar">
          <button ref={closeButtonRef} className="viewer-icon" onClick={onClose} aria-label="Close preview"><X size={20} /></button>
          <div className="viewer-title">
            <strong title={current.name}>{current.name}</strong>
            <span>
              {gallery.length > 1 ? `${safeIndex + 1} of ${gallery.length}` : kind === 'video' ? 'Video' : 'Photo'}
              {current.size_bytes != null ? ` · ${formatSize(current.size_bytes)}` : ''}
            </span>
          </div>
          <div className="viewer-top-actions">
            {kind === 'image' && (
              <>
                <button className="viewer-icon" onClick={() => setZoom((value) => Math.max(1, value - 0.25))} aria-label="Zoom out"><Minus size={18} /></button>
                <span className="viewer-zoom">{Math.round(zoom * 100)}%</span>
                <button className="viewer-icon" onClick={() => setZoom((value) => Math.min(6, value + 0.25))} aria-label="Zoom in"><Plus size={18} /></button>
                <button className="viewer-icon viewer-hide-narrow" onClick={() => setRotation((value) => (value + 270) % 360)} aria-label="Rotate left"><RotateCcw size={17} /></button>
                <button className="viewer-icon viewer-hide-narrow" onClick={() => setRotation((value) => (value + 90) % 360)} aria-label="Rotate right"><RotateCw size={17} /></button>
              </>
            )}
            <button className={'viewer-icon' + (infoOpen ? ' viewer-icon-active' : '')} onClick={() => setInfoOpen((open) => !open)} aria-label="File information" aria-pressed={infoOpen}><Info size={18} /></button>
            <button className="viewer-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
              {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </button>
            {showDownload && resolved.download && (
              <a className="viewer-icon" href={resolved.download} aria-label="Download original"><Download size={18} /></a>
            )}
          </div>
        </header>

        <div className="viewer-stage" onWheel={onWheel}>
          {canPrev && (
            <button className="viewer-nav viewer-nav-prev" onClick={() => go(-1)} aria-label="Previous file"><ChevronLeft size={28} /></button>
          )}
          {loadError ? (
            <div className="viewer-error" role="status">
              <strong>This file cannot be previewed in the browser.</strong>
              <span>The original file is still available.</span>
              {showDownload && resolved.download && <a className="button button-secondary" href={resolved.download}><Download size={15} /> Download original</a>}
            </div>
          ) : kind === 'image' ? (
            <div
              className="viewer-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={() => setZoom((value) => value > 1 ? 1 : 2)}
            >
              <img
                src={resolved.preview}
                alt={current.name}
                draggable={false}
                onError={() => setLoadError(true)}
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)` }}
              />
            </div>
          ) : (
            <video
              ref={videoRef}
              key={current.id}
              className="viewer-video"
              src={resolved.preview}
              poster={resolved.thumbnail}
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => setVideoProgress({ current: event.currentTarget.currentTime, duration: event.currentTarget.duration })}
              onTimeUpdate={(event) => setVideoProgress({ current: event.currentTarget.currentTime, duration: event.currentTarget.duration })}
              onPlay={() => setVideoPaused(false)}
              onPause={() => setVideoPaused(true)}
              onVolumeChange={(event) => setVideoMuted(event.currentTarget.muted)}
              onError={() => setLoadError(true)}
            />
          )}
          {canNext && (
            <button className="viewer-nav viewer-nav-next" onClick={() => go(1)} aria-label="Next file"><ChevronRight size={28} /></button>
          )}
        </div>

        {kind === 'video' && !loadError && (
          <footer className="viewer-video-bar">
            <button className="viewer-icon" onClick={togglePlayback} aria-label={videoPaused ? 'Play' : 'Pause'}>
              {videoPaused ? <Play size={18} /> : <Pause size={18} />}
            </button>
            <input
              className="viewer-scrubber"
              type="range"
              min={0}
              max={videoProgress.duration || 0}
              step={0.1}
              value={videoProgress.current}
              aria-label="Seek"
              onChange={(event) => {
                const next = Number(event.target.value);
                if (videoRef.current) videoRef.current.currentTime = next;
                setVideoProgress((progress) => ({ ...progress, current: next }));
              }}
            />
            <span className="viewer-time">{formatPlaybackTime(videoProgress.current)} / {formatPlaybackTime(videoProgress.duration)}</span>
            <button className="viewer-icon" onClick={toggleMute} aria-label={videoMuted ? 'Unmute' : 'Mute'}>
              {videoMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </button>
            <label className="viewer-speed">
              <span className="visually-hidden">Playback speed</span>
              <select value={playbackRate} onChange={(event) => setPlaybackRate(Number(event.target.value))}>
                <option value="0.5">0.5×</option>
                <option value="1">1×</option>
                <option value="1.5">1.5×</option>
                <option value="2">2×</option>
              </select>
            </label>
          </footer>
        )}

        {infoOpen && (
          <aside className="viewer-info" aria-label="File information">
            <header>
              <strong>Information</strong>
              <button className="viewer-icon" onClick={() => setInfoOpen(false)} aria-label="Close information"><X size={16} /></button>
            </header>
            <dl>
              <div><dt>Name</dt><dd>{current.name}</dd></div>
              <div><dt>Type</dt><dd>{details?.mime_type || current.mime_detected || current.mime_type || current.category || kind}</dd></div>
              <div><dt>Size</dt><dd>{formatSize(details?.size_bytes ?? current.size_bytes)}</dd></div>
              {(width && height) ? <div><dt>Dimensions</dt><dd>{width} × {height}</dd></div> : null}
              <div><dt>Created</dt><dd>{formatDate(details?.created_at || current.created_at)}</dd></div>
              <div><dt>Modified</dt><dd>{formatDate(details?.updated_at || current.updated_at)}</dd></div>
              {details?.location && <div><dt>Location</dt><dd>{details.location}</dd></div>}
              {details?.category && <div><dt>Index</dt><dd>{details.category}</dd></div>}
            </dl>
          </aside>
        )}
      </section>
    </div>
  );
}
