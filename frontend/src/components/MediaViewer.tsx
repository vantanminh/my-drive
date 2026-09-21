import { useEffect, useRef, useState } from 'react';
import { Download, Expand, Minus, Plus, RotateCcw, RotateCw, X } from 'lucide-react';
import { formatSize } from '../format';
import { previewUrl, thumbnailUrl, downloadUrl } from '../api';
import type { Entry } from '../types';

type MediaKind = 'image' | 'video';

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon'
]);
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm']);

export function mediaKindFor(entry: Pick<Entry, 'name' | 'mime_detected'>): MediaKind | null {
  if (entry.mime_detected && IMAGE_MIMES.has(entry.mime_detected)) return 'image';
  if (entry.mime_detected && VIDEO_MIMES.has(entry.mime_detected)) return 'video';
  const name = entry.name.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|avif|bmp|ico)$/.test(name)) return 'image';
  if (/\.(mp4|m4v|webm)$/.test(name)) return 'video';
  return null;
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  function setPlaybackRate(rate: number) {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (stageRef.current?.requestFullscreen) {
      void stageRef.current.requestFullscreen();
    }
  }

  return (
    <div
      className="media-viewer-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="media-viewer" role="dialog" aria-modal="true" aria-label={'Preview ' + entry.name}>
        <header className="media-viewer-header">
          <div className="media-viewer-file">
            <strong title={entry.name}>{entry.name}</strong>
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
              <label className="media-speed-label">Speed
                <select className="media-speed" aria-label="Playback speed" defaultValue="1" onChange={(event) => setPlaybackRate(Number(event.target.value))}>
                  <option value="0.5">0.5×</option>
                  <option value="0.75">0.75×</option>
                  <option value="1">1×</option>
                  <option value="1.25">1.25×</option>
                  <option value="1.5">1.5×</option>
                  <option value="2">2×</option>
                </select>
              </label>
            )}
            <a className="media-tool media-download" href={downloadUrl(entry.id)} aria-label="Download original" title="Download original"><Download size={17} /></a>
            <button className="media-tool media-close" onClick={onClose} aria-label="Close preview" title="Close preview"><X size={18} /></button>
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
