import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, GitMerge, Image as ImageIcon, Images, Plus, ScanFace, Share2, Trash2, X } from 'lucide-react';
import { api, thumbnailUrl } from '../api';
import { formatDate, formatSize, friendlyError } from '../format';
import type { PhotosTab } from '../route';
import type { Album, FaceCluster, MediaItem } from '../types';
import MediaViewer, { mediaKindFor, type ViewerItem } from './MediaViewer';
import ShareDialog from './ShareDialog';

type Props = {
  tab: PhotosTab;
  albumId: string | null;
  personId: string | null;
  fileId: string | null;
  onNavigate: (next: { tab?: PhotosTab; albumId?: string | null; personId?: string | null; fileId?: string | null }) => void;
};

function toViewerItem(item: MediaItem): ViewerItem {
  return {
    id: item.id,
    name: item.name,
    mime_type: item.mime_type,
    size_bytes: item.size_bytes,
    created_at: item.created_at,
    updated_at: item.updated_at,
    category: item.category
  };
}

function dayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Undated';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

function groupByDay(items: MediaItem[]) {
  const groups: Array<{ key: string; label: string; items: MediaItem[] }> = [];
  for (const item of items) {
    const key = new Date(item.created_at).toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.created_at), items: [item] });
  }
  return groups;
}

export default function PhotosPage({ tab, albumId, personId, fileId, onNavigate }: Props) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [offset, setOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [faces, setFaces] = useState<FaceCluster[]>([]);
  const [faceOffset, setFaceOffset] = useState<number | null>(null);
  const [albumName, setAlbumName] = useState('');
  const [shareAlbum, setShareAlbum] = useState<Album | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [faceSelection, setFaceSelection] = useState<string[]>([]);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [library, setLibrary] = useState<MediaItem[]>([]);
  const [libraryCursor, setLibraryCursor] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const activeAlbum = albums.find((album) => album.id === albumId) ?? null;
  const activeFace = faces.find((face) => face.id === personId) ?? null;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setItems([]);
    setSelected([]);
    const load = async () => {
      try {
        if (tab === 'albums' && !albumId) {
          const page = await api.listAlbums(controller.signal);
          if (!controller.signal.aborted) setAlbums(page.albums);
          return;
        }
        if (tab === 'people' && !personId) {
          const page = await api.faceClusters(0, controller.signal);
          if (controller.signal.aborted) return;
          setFaces(page.clusters);
          setFaceOffset(page.nextOffset);
          setLabelDrafts(Object.fromEntries(page.clusters.map((cluster) => [cluster.id, cluster.label || ''])));
          return;
        }
        if (tab === 'albums' && albumId) {
          const [albumPage, itemPage] = await Promise.all([
            api.listAlbums(controller.signal),
            api.albumItems(albumId, 0, controller.signal)
          ]);
          if (controller.signal.aborted) return;
          setAlbums(albumPage.albums);
          setItems(itemPage.items);
          setOffset(itemPage.next_offset ?? null);
          setCursor(null);
          return;
        }
        if (tab === 'people' && personId) {
          const [facePage, mediaPage] = await Promise.all([
            api.faceClusters(0, controller.signal),
            api.faceMedia(personId, 0, controller.signal)
          ]);
          if (controller.signal.aborted) return;
          setFaces(facePage.clusters);
          setItems(mediaPage.items);
          setOffset(mediaPage.next_offset ?? null);
          return;
        }
        const page = await api.listPhotos(null, controller.signal);
        if (controller.signal.aborted) return;
        setItems(page.items);
        setCursor(page.next_cursor ?? null);
        setOffset(null);
      } catch (cause) {
        if (!controller.signal.aborted) setError(friendlyError(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [tab, albumId, personId]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || loading) return;
    const more = tab === 'timeline' ? cursor : offset;
    if (!more) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const request = tab === 'timeline'
        ? api.listPhotos(cursor)
        : tab === 'albums' && albumId
          ? api.albumItems(albumId, offset ?? 0)
          : personId
            ? api.faceMedia(personId, offset ?? 0)
            : null;
      if (!request) return;
      request.then((page) => {
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...page.items.filter((item) => !seen.has(item.id))];
        });
        setCursor(page.next_cursor ?? null);
        setOffset(page.next_offset ?? null);
      }).catch((cause: unknown) => setError(friendlyError(cause)));
    }, { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [albumId, cursor, loading, offset, personId, tab]);

  const groups = useMemo(() => groupByDay(items), [items]);
  const viewerItems = useMemo(() => items.map(toViewerItem), [items]);
  const viewerIndex = fileId ? viewerItems.findIndex((item) => item.id === fileId) : -1;

  async function createAlbum(event: FormEvent) {
    event.preventDefault();
    const name = albumName.trim();
    if (!name) return;
    try {
      const album = await api.createAlbum(name);
      setAlbumName('');
      setAlbums((current) => [album, ...current]);
      onNavigate({ tab: 'albums', albumId: album.id, fileId: null });
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function renameFace(cluster: FaceCluster) {
    const label = (labelDrafts[cluster.id] || '').trim();
    try {
      await api.renameFaceCluster(cluster.id, label || null);
      setFaces((current) => current.map((item) => item.id === cluster.id ? { ...item, label: label || null } : item));
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function mergeFaces() {
    if (faceSelection.length < 2) return;
    const [targetId, ...sourceIds] = faceSelection;
    try {
      await api.mergeFaceClusters(targetId, sourceIds);
      setFaceSelection([]);
      const page = await api.faceClusters();
      setFaces(page.clusters);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function addSelectedToAlbum() {
    if (!albumId || selected.length === 0) return;
    try {
      await api.addAlbumItems(albumId, selected);
      const page = await api.albumItems(albumId);
      setItems(page.items);
      setOffset(page.next_offset ?? null);
      setPickerOpen(false);
      setSelected([]);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function removeSelected() {
    if (!albumId || selected.length === 0) return;
    if (!window.confirm(`Remove ${selected.length} item${selected.length === 1 ? '' : 's'} from this album?`)) return;
    try {
      await api.removeAlbumItems(albumId, selected);
      setItems((current) => current.filter((item) => !selected.includes(item.id)));
      setSelected([]);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function openPicker() {
    setPickerOpen(true);
    setSelected([]);
    try {
      const page = await api.listPhotos();
      setLibrary(page.items);
      setLibraryCursor(page.next_cursor ?? null);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function loadMoreFaces() {
    if (faceOffset == null) return;
    try {
      const page = await api.faceClusters(faceOffset);
      setFaces((current) => {
        const seen = new Set(current.map((cluster) => cluster.id));
        return [...current, ...page.clusters.filter((cluster) => !seen.has(cluster.id))];
      });
      setLabelDrafts((current) => ({
        ...current,
        ...Object.fromEntries(page.clusters.map((cluster) => [cluster.id, cluster.label || '']))
      }));
      setFaceOffset(page.nextOffset);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function loadMoreLibrary() {
    if (!libraryCursor) return;
    try {
      const page = await api.listPhotos(libraryCursor);
      setLibrary((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setLibraryCursor(page.next_cursor ?? null);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function renameAlbum(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAlbum) return;
    const name = new FormData(event.currentTarget).get('name');
    if (typeof name !== 'string' || !name.trim()) return;
    try {
      const album = await api.renameAlbum(activeAlbum.id, name.trim());
      setAlbums((current) => current.map((item) => item.id === album.id ? album : item));
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  function toggle(id: string, list: string[], setList: (ids: string[]) => void) {
    setList(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  }

  return (
    <section className="photos-page">
      <div className="photos-tabs" role="tablist" aria-label="Photos">
        <button className={tab === 'timeline' ? 'active' : ''} onClick={() => onNavigate({ tab: 'timeline', albumId: null, personId: null, fileId: null })}><Images size={16} /> Library</button>
        <button className={tab === 'people' ? 'active' : ''} onClick={() => onNavigate({ tab: 'people', albumId: null, personId: null, fileId: null })}><ScanFace size={16} /> People</button>
        <button className={tab === 'albums' ? 'active' : ''} onClick={() => onNavigate({ tab: 'albums', albumId: null, personId: null, fileId: null })}><ImageIcon size={16} /> Albums</button>
      </div>

      {error && <div className="notice notice-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}

      {tab === 'timeline' && (
        <>
          <header className="photos-heading">
            <div>
              <span className="eyebrow">PHOTOS</span>
              <h1>Library</h1>
              <p>Images and videos from your drive, newest first.</p>
            </div>
          </header>
          <MediaGroups groups={groups} loading={loading} onOpen={(id) => onNavigate({ fileId: id })} />
        </>
      )}

      {tab === 'people' && !personId && (
        <>
          <header className="photos-heading">
            <div>
              <span className="eyebrow">PEOPLE</span>
              <h1>Faces</h1>
              <p>Name a face, open their photos, or merge clusters that belong to the same person.</p>
            </div>
            <button className="button button-secondary" disabled={faceSelection.length < 2} onClick={() => void mergeFaces()}><GitMerge size={16} /> Merge selected</button>
          </header>
          <div className="people-grid">
            {faces.map((cluster) => (
              <article className={'person-card' + (faceSelection.includes(cluster.id) ? ' selected' : '')} key={cluster.id}>
                <button className="person-open" onClick={() => onNavigate({ tab: 'people', personId: cluster.id, fileId: null })}>
                  {cluster.representativeFileId ? <img src={thumbnailUrl(cluster.representativeFileId)} alt="" /> : <ScanFace size={28} />}
                  <strong>{cluster.label || 'Unnamed face'}</strong>
                  <span>{cluster.assetCount} items</span>
                </button>
                <label className="person-select">
                  <input type="checkbox" checked={faceSelection.includes(cluster.id)} onChange={() => toggle(cluster.id, faceSelection, setFaceSelection)} />
                  Select
                </label>
                <form className="person-rename" onSubmit={(event) => { event.preventDefault(); void renameFace(cluster); }}>
                  <input value={labelDrafts[cluster.id] ?? ''} onChange={(event) => setLabelDrafts((current) => ({ ...current, [cluster.id]: event.target.value }))} placeholder="Add a name" maxLength={80} aria-label="Face name" />
                  <button className="button button-secondary" type="submit">Save</button>
                </form>
              </article>
            ))}
            {!loading && faces.length === 0 && <p className="photos-empty">No faces have been indexed yet.</p>}
          </div>
          {faceOffset != null && <button className="load-more" onClick={() => void loadMoreFaces()}>Load more people</button>}
        </>
      )}

      {tab === 'people' && personId && (
        <>
          <header className="photos-heading">
            <div>
              <button className="back-link" onClick={() => onNavigate({ tab: 'people', personId: null, fileId: null })}>All people</button>
              <h1>{activeFace?.label || 'Unnamed face'}</h1>
              <p>{items.length} indexed items in this group.</p>
            </div>
          </header>
          <MediaGroups groups={groups} loading={loading} onOpen={(id) => onNavigate({ fileId: id })} />
        </>
      )}

      {tab === 'albums' && !albumId && (
        <>
          <header className="photos-heading">
            <div>
              <span className="eyebrow">COLLECTIONS</span>
              <h1>Albums</h1>
              <p>Group photos and videos, then share an album with the same link controls as files.</p>
            </div>
            <form className="album-create" onSubmit={(event) => void createAlbum(event)}>
              <input value={albumName} onChange={(event) => setAlbumName(event.target.value)} placeholder="New album name" maxLength={120} aria-label="Album name" />
              <button className="button button-primary" type="submit"><Plus size={16} /> Create</button>
            </form>
          </header>
          <div className="album-grid">
            {albums.map((album) => (
              <button className="album-card" key={album.id} onClick={() => onNavigate({ tab: 'albums', albumId: album.id, fileId: null })}>
                {album.cover_file_id ? <img src={thumbnailUrl(album.cover_file_id)} alt="" /> : <span className="album-fallback"><ImageIcon size={28} /></span>}
                <strong>{album.name}</strong>
                <span>{album.item_count} items</span>
              </button>
            ))}
            {!loading && albums.length === 0 && <p className="photos-empty">Create an album to start a collection.</p>}
          </div>
        </>
      )}

      {tab === 'albums' && albumId && (
        <>
          <header className="photos-heading">
            <div>
              <button className="back-link" onClick={() => onNavigate({ tab: 'albums', albumId: null, fileId: null })}>All albums</button>
              <h1>{activeAlbum?.name || 'Album'}</h1>
              <p>{items.length} visible items.</p>
              {activeAlbum && (
                <form className="album-create" onSubmit={(event) => void renameAlbum(event)}>
                  <input name="name" defaultValue={activeAlbum.name} maxLength={120} aria-label="Album name" key={activeAlbum.name} />
                  <button className="button button-secondary" type="submit">Rename</button>
                </form>
              )}
            </div>
            <div className="heading-actions">
              <button className="button button-secondary" onClick={() => void openPicker()}><Plus size={16} /> Add media</button>
              <button className="button button-secondary" disabled={selected.length === 0} onClick={() => void removeSelected()}><Trash2 size={16} /> Remove</button>
              {activeAlbum && <button className="button button-primary" onClick={() => setShareAlbum(activeAlbum)}><Share2 size={16} /> Share</button>}
            </div>
          </header>
          <MediaGroups
            groups={groups}
            loading={loading}
            selected={selected}
            onToggle={(id) => toggle(id, selected, setSelected)}
            onOpen={(id) => onNavigate({ fileId: id })}
          />
        </>
      )}

      <div ref={sentinel} className="photos-sentinel" />
      {loading && <div className="photos-loading"><span className="spinner" /> Loading media…</div>}

      {pickerOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerOpen(false); }}>
          <section className="modal-card picker-card" role="dialog" aria-modal="true" aria-labelledby="picker-title">
            <h2 id="picker-title">Add to album</h2>
            <p className="modal-description">Choose images or videos already in your library.</p>
            <div className="picker-grid">
              {library.map((item) => (
                <button key={item.id} className={selected.includes(item.id) ? 'selected' : ''} onClick={() => toggle(item.id, selected, setSelected)}>
                  <img src={thumbnailUrl(item.id)} alt={item.name} />
                  {selected.includes(item.id) && <Check size={16} />}
                </button>
              ))}
            </div>
            {libraryCursor && <button className="load-more" onClick={() => void loadMoreLibrary()}>Load more media</button>}
            <div className="modal-actions">
              <button className="button button-secondary" onClick={() => setPickerOpen(false)}>Cancel</button>
              <button className="button button-primary" disabled={selected.length === 0} onClick={() => void addSelectedToAlbum()}>Add {selected.length || ''}</button>
            </div>
          </section>
        </div>
      )}

      {shareAlbum && (
        <ShareDialog
          entry={{ id: shareAlbum.id, kind: 'album', name: shareAlbum.name }}
          onClose={() => setShareAlbum(null)}
          onCreated={() => undefined}
        />
      )}

      {viewerIndex >= 0 && (
        <MediaViewer
          items={viewerItems}
          index={viewerIndex}
          onIndexChange={(next) => onNavigate({ fileId: viewerItems[next]?.id ?? null })}
          onClose={() => onNavigate({ fileId: null })}
          loadDetails={(item) => api.entryDetails(item.id).catch(() => null)}
        />
      )}
    </section>
  );
}

function MediaGroups({
  groups,
  loading,
  onOpen,
  selected,
  onToggle
}: {
  groups: Array<{ key: string; label: string; items: MediaItem[] }>;
  loading: boolean;
  onOpen: (id: string) => void;
  selected?: string[];
  onToggle?: (id: string) => void;
}) {
  if (!loading && groups.length === 0) {
    return <p className="photos-empty">No photos or videos to show yet.</p>;
  }
  return (
    <div className="photo-timeline">
      {groups.map((group) => (
        <section key={group.key} className="photo-day">
          <h2>{group.label}</h2>
          <div className="photo-grid">
            {group.items.map((item) => {
              const video = mediaKindFor({ name: item.name, mime_detected: item.mime_type }) === 'video';
              return (
                <button key={item.id} className={'photo-tile' + (selected?.includes(item.id) ? ' selected' : '')} onClick={() => onOpen(item.id)}>
                  <img src={thumbnailUrl(item.id)} alt={item.name} loading="lazy" />
                  {video && <span className="photo-badge">Video</span>}
                  {onToggle && (
                    <label className="photo-check" onClick={(event) => event.stopPropagation()}>
                      <input type="checkbox" checked={selected?.includes(item.id) ?? false} onChange={() => onToggle(item.id)} aria-label={'Select ' + item.name} />
                    </label>
                  )}
                  <span className="visually-hidden">{item.name}, {formatSize(item.size_bytes)}, {formatDate(item.created_at)}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
