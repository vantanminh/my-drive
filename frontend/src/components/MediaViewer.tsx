import { useEffect, useRef, useState } from 'react';
import {
  Download,
  Expand,
  FastForward,
  Minus,
  Pause,
  Play,
  Plus,
  Rewind,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  X
} from 'lucide-react';
import { formatSize } from '../format';
import { previewUrl, thumbnailUrl, downloadUrl } from '../api';
import type { Entry } from '../types';

type MediaKind = 'image' | 'video';

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
  'image/tiff', 'image/heic', 'image/heif'
]);
const VIDEO_MIMES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo',
  'video/ogg', 'video/mpeg', 'video/mp2t', 'video/x-flv', 'video/x-ms-wmv', 'video/3gpp'
]);

export function mediaKindFor(entry: Pick<Entry, 'name' | 'mime_detected'>): MediaKind | null {
  if (entry.mime_detected && IMAGE_MIMES.has(entry.mime_detected)) return 'image';
  if (entry.mime_detected && VIDEO_MIMES.has(entry.mime_detected)) return 'video';
  const name = entry.name.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|avif|bmp|ico|tiff?)$/.test(name) || /\.(heic|heif)$/.test(name)) return 'image';
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

type Props = {
  entry: Entry;
  onClose: () => void;
};

export default function MediaViewer({ entry, onClose }: Props) {
  const kind = mediaKindFor(entry) || 'image';
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [playbackRate, setPlaybackRateValue] = useState(1);
  const [videoProgress, setVideoProgress] = useState({ current: 0, duration: 0 });
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoMuted, setVideoMuted] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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
    setPlaybackRateValue(1);
    setVideoProgress({ current: 0, duration: 0 });
    setVideoPaused(true);
    setVideoMuted(false);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      videoRef.current.playbackRate = 1;
      videoRef.current.muted = false;
    }
  }, [entry.id, kind]);

  function setPlaybackRate(rate: number) {
    setPlaybackRateValue(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => setLoadError(true));
    } else {
      video.pause();
    }
  }

  function seekBy(seconds: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), video.duration);
  }

  function seekTo(seconds: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(seconds, 0), video.duration);
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setVideoMuted(video.muted);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (stageRef.current?.requestFullscreen) {
      void stageRef.current.requestFullscreen();
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video, [tabindex]:not([tabindex="-1"])'
        ));
        if (focusable.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      const target = event.target;
      if (target instanceof HTMLElement && target.closest('button, a, input, select, textarea, video')) return;

      if (kind === 'video') {
        const video = videoRef.current;
        if (!video) return;
        switch (event.key) {
          case ' ':
          case 'k':
            event.preventDefault();
            togglePlayback();
            break;
          case 'ArrowLeft':
            event.preventDefault();
            seekBy(event.shiftKey ? -30 : -10);
            break;
          case 'ArrowRight':
            event.preventDefault();
            seekBy(event.shiftKey ? 30 : 10);
            break;
          case 'Home':
            event.preventDefault();
            seekTo(0);
            break;
          case 'End':
            event.preventDefault();
            seekTo(video.duration);
            break;
          case 'm':
          case 'M':
            event.preventDefault();
            toggleMute();
            break;
          case 'f':
          case 'F':
            event.preventDefault();
            toggleFullscreen();
            break;
          case '[':
            event.preventDefault();
            setPlaybackRate(Math.max(0.5, Number((video.playbackRate - 0.25).toFixed(2))));
            break;
          case ']':
            event.preventDefault();
            setPlaybackRate(Math.min(2, Number((video.playbackRate + 0.25).toFixed(2))));
            break;
          default:
            break;
        }
        return;
      }

      switch (event.key) {
        case '+':
        case '=':
          event.preventDefault();
          setZoom((value) => Math.min(4, value + 0.25));
          break;
        case '-':
        case '_':
          event.preventDefault();
          setZoom((value) => Math.max(0.25, value - 0.25));
          break;
        case '0':
          event.preventDefault();
          setZoom(1);
          setRotation(0);
          break;
        case 'r':
          event.preventDefault();
          setRotation((value) => value + 90);
          break;
        case 'R':
          event.preventDefault();
          setRotation((value) => value - 90);
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [kind, onClose]);

  return (
    <div
      className="media-viewer-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        className="media-viewer"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-viewer-title"
        tabIndex={-1}
      >
        <header className="media-viewer-header">
          <div className="media-viewer-file">
            <strong id="media-viewer-title" title={entry.name}>{entry.name}</strong>
            <span>{kind === 'image' ? 'Image' : 'Video'} <i /> {formatSize(entry.size_bytes)}</span>
          </div>
          <div className="media-viewer-actions">
            {kind === 'image' ? (
              <>
                <button className="media-tool" onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))} aria-label="Zoom out" title="Zoom out"><Minus size={17} /></button>
                <span className="media-zoom-label">{Math.round(zoom * 100)}%</span>
                <button className="media-tool" onClick={() => setZoom((value) => Math.min(4, value + 0.25))} aria-label="Zoom in" title="Zoom in"><Plus size={17} /></button>
                <button className="media-tool" onClick={() => setRotation((value) => value - 90)} aria-label="Rotate left" title="Rotate left"><RotateCcw size={16} /></button>
                <button className="media-tool" onClick={() => setRotation((value) => value + 90)} aria-label="Rotate right" title="Rotate right"><RotateCw size={16} /></button>
                <button className="media-tool" onClick={() => { setZoom(1); setRotation(0); }} aria-label="Reset view" title="Reset view"><Expand size={16} /></button>
              </>
            ) : (
              <>
                <div className="media-video-controls" aria-label="Video controls">
                  <button className="media-tool media-skip-control" onClick={() => seekBy(-10)} aria-label="Back 10 seconds" title="Back 10 seconds"><Rewind size={16} /></button>
                  <button className="media-tool" onClick={togglePlayback} aria-label={videoPaused ? 'Play video' : 'Pause video'} title={videoPaused ? 'Play video' : 'Pause video'}>
                    {videoPaused ? <Play size={16} /> : <Pause size={16} />}
                  </button>
                  <button className="media-tool media-skip-control" onClick={() => seekBy(10)} aria-label="Forward 10 seconds" title="Forward 10 seconds"><FastForward size={16} /></button>
                  <button className="media-tool media-mute-control" onClick={toggleMute} aria-label={videoMuted ? 'Unmute video' : 'Mute video'} title={videoMuted ? 'Unmute video' : 'Mute video'}>
                    {videoMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                  </button>
                  <span className="media-time-label" aria-label="Video time">
                    {formatPlaybackTime(videoProgress.current)} / {formatPlaybackTime(videoProgress.duration)}
                  </span>
                </div>
                <label className="media-speed-label">Speed
                  <select className="media-speed" aria-label="Playback speed" value={playbackRate} onChange={(event) => setPlaybackRate(Number(event.target.value))}>
                    <option value="0.5">0.5×</option>
                    <option value="0.75">0.75×</option>
                    <option value="1">1×</option>
                    <option value="1.25">1.25×</option>
                    <option value="1.5">1.5×</option>
                    <option value="2">2×</option>
                  </select>
                </label>
              </>
            )}
            <a className="media-tool media-download" href={downloadUrl(entry.id)} aria-label="Download original" title="Download original"><Download size={17} /></a>
            <button ref={closeButtonRef} className="media-tool media-close" onClick={onClose} aria-label="Close preview" title="Close preview"><X size={18} /></button>
          </div>
        </header>

        <main className={'media-viewer-stage ' + (kind === 'video' ? 'video-stage' : 'image-stage')} ref={stageRef}>
          {loadError ? (
            <div className="media-viewer-error" role="status">
              <strong>This file cannot be previewed in this browser.</strong>
              <span>The file is still available in its original format.</span>
              <a className="button button-secondary" href={downloadUrl(entry.id)}><Download size={15} /> Download original</a>
            </div>
          ) : kind === 'image' ? (
            <div className="media-image-scroll">
              <img
                className="media-image"
                src={previewUrl(entry.id)}
                alt={entry.name}
                onError={() => setLoadError(true)}
                style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
              />
            </div>
          ) : (
            <video
              ref={videoRef}
              className="media-video"
              src={previewUrl(entry.id)}
              poster={thumbnailUrl(entry.id)}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => setVideoProgress({ current: event.currentTarget.currentTime, duration: event.currentTarget.duration })}
              onTimeUpdate={(event) => setVideoProgress({ current: event.currentTarget.currentTime, duration: event.currentTarget.duration })}
              onPlay={() => setVideoPaused(false)}
              onPause={() => setVideoPaused(true)}
              onVolumeChange={(event) => setVideoMuted(event.currentTarget.muted)}
              onError={() => setLoadError(true)}
            >
              Your browser cannot play this video format.
            </video>
          )}
          {kind === 'video' && !loadError && <button className="media-fullscreen" onClick={toggleFullscreen} aria-label="Toggle fullscreen" title="Toggle fullscreen"><Expand size={17} /></button>}
        </main>
      </section>
    </div>
  );
}
