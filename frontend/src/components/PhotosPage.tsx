import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Check, Copy, Download, FolderInput, GitMerge, Image as ImageIcon, Images, MoreHorizontal, Plus, ScanFace, Scissors, Search, Share2, Trash2, Upload, UserRoundX, X } from 'lucide-react';
import { ApiError, api, downloadUrl, thumbnailUrl } from '../api';
import { faceCropStyle } from '../faceCrop';
import { formatDate, formatSize, friendlyError } from '../format';
import { nextSelection } from '../selection';
import { uploadFile } from '../uploadFile';
import type { PhotosTab } from '../route';
import type { Album, FaceCluster, MediaItem } from '../types';
import { AnchoredMenu, ContextMenu, type MenuItem } from './ContextMenu';
import DestinationDialog from './DestinationDialog';
import MediaViewer, { mediaKindFor, type ViewerItem } from './MediaViewer';
import PhotoMosaic, { type MosaicItem } from './PhotoMosaic';
import ShareDialog from './ShareDialog';

type Props = {
  tab: PhotosTab;
  albumId: string | null;
  personId: string | null;
  fileId: string | null;
  onNavigate: (next: { tab?: PhotosTab; albumId?: string | null; personId?: string | null; fileId?: string | null }) => void;
};

type ShareTarget = { id: string; kind: 'file' | 'folder' | 'album'; name: string };
type Destination = { action: 'move' | 'copy'; ids: string[] } | null;
type PeopleFilter = 'all' | 'named' | 'unnamed';
type NoticeAction = { label: string; personId: string };

const MAX_SEPARATE = 64;

function photoCountLabel(count: number): string {
  if (count === 1) return '1 photo';
  return `${count} photos`;
}

function peopleNamedFilter(filter: PeopleFilter): boolean | undefined {
  if (filter === 'named') return true;
  if (filter === 'unnamed') return false;
  return undefined;
}

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

function isMediaFile(file: File): boolean {
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) return true;
  return /\.(jpe?g|png|gif|webp|avif|bmp|ico|tiff?|heic|heif|mp4|m4v|webm|mov|qt|mkv|avi|ogv|ogg|mpg|mpeg)$/i.test(file.name);
}

function mosaicItems(items: MediaItem[]): MosaicItem[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    src: thumbnailUrl(item.id),
    aspect: item.media.width && item.media.height ? item.media.width / item.media.height : null,
    video: mediaKindFor({ name: item.name, mime_detected: item.mime_type }) === 'video'
  }));
}

function downloadFiles(ids: string[]) {
  ids.forEach((id, index) => {
    window.setTimeout(() => {
      const link = document.createElement('a');
      link.href = downloadUrl(id);
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }, index * 220);
  });
}

export default function PhotosPage({ tab, albumId, personId, fileId, onNavigate }: Props) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [offset, setOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNoticeMessage] = useState('');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [faces, setFaces] = useState<FaceCluster[]>([]);
  const [faceOffset, setFaceOffset] = useState<number | null>(null);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [peopleFilter, setPeopleFilter] = useState<PeopleFilter>('all');
  const [debouncedPeopleQuery, setDebouncedPeopleQuery] = useState('');
  const [activePerson, setActivePerson] = useState<FaceCluster | null>(null);
  const [personMissing, setPersonMissing] = useState(false);
  const [noticeAction, setNoticeAction] = useState<NoticeAction | null>(null);
  const [busy, setBusy] = useState('');
  const [albumName, setAlbumName] = useState('');
  const [shareTargets, setShareTargets] = useState<ShareTarget[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [faceSelection, setFaceSelection] = useState<string[]>([]);
  const [mergeTarget, setMergeTarget] = useState('');
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [library, setLibrary] = useState<MediaItem[]>([]);
  const [libraryCursor, setLibraryCursor] = useState<string | null>(null);
  const [librarySelected, setLibrarySelected] = useState<string[]>([]);
  const [uploading, setUploading] = useState('');
  const [destination, setDestination] = useState<Destination>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const anchor = useRef<string | null>(null);
  const faceAnchor = useRef<string | null>(null);
  const createFiles = useRef<HTMLInputElement>(null);
  const albumFiles = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const pagingFaces = useRef(false);
  const peopleGeneration = useRef(0);
  const renameSkip = useRef<string | null>(null);

  function setNotice(message: string, action: NoticeAction | null = null) {
    setNoticeMessage(message);
    setNoticeAction(message ? action : null);
  }

  function faceListFilter() {
    return { q: debouncedPeopleQuery || undefined, named: peopleNamedFilter(peopleFilter) };
  }

  const activeAlbum = albums.find((album) => album.id === albumId) ?? null;
  const activeFace = activePerson && activePerson.id === personId
    ? activePerson
    : faces.find((face) => face.id === personId) ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedPeopleQuery(peopleQuery.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [peopleQuery]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setItems([]);
    setSelected([]);
    setSelectionMode(false);
    setPersonMissing(false);
    anchor.current = null;
    const load = async () => {
      try {
        if (tab === 'albums' && !albumId) {
          const page = await api.listAlbums(controller.signal);
          if (!controller.signal.aborted) setAlbums(page.albums);
          return;
        }
        if (tab === 'people' && !personId) {
          setActivePerson(null);
          setFaces([]);
          setFaceOffset(null);
          setFaceSelection([]);
          faceAnchor.current = null;
          const generation = ++peopleGeneration.current;
          const page = await api.faceClusters(0, controller.signal, faceListFilter());
          if (controller.signal.aborted || peopleGeneration.current !== generation) return;
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
          setActivePerson(null);
          const [faceResult, mediaResult] = await Promise.all([
            api.getFaceCluster(personId, controller.signal).catch((cause: unknown) => {
              if (cause instanceof ApiError && cause.status === 404) return null;
              throw cause;
            }),
            api.faceMedia(personId, 0, controller.signal).catch((cause: unknown) => {
              if (cause instanceof ApiError && cause.status === 404) return null;
              throw cause;
            })
          ]);
          if (controller.signal.aborted) return;
          if (!faceResult || !mediaResult) {
            setActivePerson(null);
            setPersonMissing(true);
            setItems([]);
            setOffset(null);
            return;
          }
          setActivePerson(faceResult);
          setPersonMissing(false);
          setLabelDrafts((current) => ({ ...current, [faceResult.id]: faceResult.label || '' }));
          setItems(mediaResult.items);
          setOffset(mediaResult.next_offset ?? null);
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
  }, [tab, albumId, personId, debouncedPeopleQuery, peopleFilter]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || loading) return;
    const peopleList = tab === 'people' && !personId;
    const more = peopleList ? faceOffset != null : tab === 'timeline' ? Boolean(cursor) : offset != null;
    if (!more) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
        if (peopleList) {
        if (faceOffset == null || pagingFaces.current) return;
        const generation = peopleGeneration.current;
        pagingFaces.current = true;
        api.faceClusters(faceOffset, undefined, faceListFilter())
          .then((page) => {
            if (peopleGeneration.current !== generation) return;
            setFaces((current) => {
              const seen = new Set(current.map((cluster) => cluster.id));
              return [...current, ...page.clusters.filter((cluster) => !seen.has(cluster.id))];
            });
            setLabelDrafts((current) => ({
              ...current,
              ...Object.fromEntries(page.clusters.map((cluster) => [cluster.id, cluster.label || '']))
            }));
            setFaceOffset(page.nextOffset);
          })
          .catch((cause: unknown) => {
            if (peopleGeneration.current === generation) setError(friendlyError(cause));
          })
          .finally(() => { pagingFaces.current = false; });
        return;
      }
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
  }, [albumId, cursor, faceOffset, loading, offset, personId, tab, debouncedPeopleQuery, peopleFilter]);

  const groups = useMemo(() => groupByDay(items), [items]);
  const viewerItems = useMemo(() => items.map(toViewerItem), [items]);
  const viewerIndex = fileId ? viewerItems.findIndex((item) => item.id === fileId) : -1;
  const orderedIds = items.map((item) => item.id);

  function selectMedia(id: string, mode: 'toggle' | 'range') {
    const result = nextSelection(selected, orderedIds, id, mode, anchor.current);
    anchor.current = result.anchor;
    setSelected(result.ids);
    if (result.ids.length > 0) setSelectionMode(true);
  }

  function selectFace(id: string, mode: 'toggle' | 'range') {
    const result = nextSelection(faceSelection, faces.map((face) => face.id), id, mode, faceAnchor.current);
    faceAnchor.current = result.anchor;
    setFaceSelection(result.ids);
    setMergeTarget((current) => result.ids.includes(current) ? current : result.ids[0] ?? '');
  }

  async function uploadIntoAlbum(targetAlbumId: string, list: FileList | File[]) {
    const files = Array.from(list).filter(isMediaFile);
    if (files.length === 0) {
      setError('Choose image or video files to add to this album.');
      return;
    }
    setError('');
    setNotice('');
    const ids: string[] = [];
    try {
      const folder = await api.ensurePhotosFolder();
      for (let index = 0; index < files.length; index += 1) {
        setUploading(`Uploading ${index + 1} of ${files.length}…`);
        ids.push(await uploadFile(files[index], folder.id));
      }
      setUploading('Adding to album…');
      await api.addAlbumItems(targetAlbumId, ids);
      if (albumId === targetAlbumId) {
        const page = await api.albumItems(targetAlbumId);
        setItems(page.items);
        setOffset(page.next_offset ?? null);
      }
      setAlbums((current) => current.map((album) => album.id === targetAlbumId
        ? { ...album, item_count: album.item_count + ids.length, cover_file_id: album.cover_file_id ?? ids[0] }
        : album));
      setNotice(ids.length === 1 ? '1 photo added to the album.' : `${ids.length} photos added to the album.`);
    } catch (cause) {
      if (ids.length > 0) {
        try {
          await api.addAlbumItems(targetAlbumId, ids);
          if (albumId === targetAlbumId) {
            const page = await api.albumItems(targetAlbumId);
            setItems(page.items);
            setOffset(page.next_offset ?? null);
          }
        } catch {
          // Keep the upload error. Files that did not finish stay out of the album.
        }
      }
      setError(friendlyError(cause));
    } finally {
      setUploading('');
    }
  }

  async function createAlbum(event: FormEvent) {
    event.preventDefault();
    const name = albumName.trim();
    if (!name) return;
    const files = createFiles.current?.files;
    try {
      const album = await api.createAlbum(name);
      setAlbumName('');
      if (createFiles.current) createFiles.current.value = '';
      setAlbums((current) => [album, ...current]);
      onNavigate({ tab: 'albums', albumId: album.id, fileId: null });
      if (files && files.length > 0) await uploadIntoAlbum(album.id, files);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function renameFace(cluster: FaceCluster, label: string) {
    const next = label.trim();
    if (next === (cluster.label || '')) return;
    setBusy('rename:' + cluster.id);
    setError('');
    try {
      const result = await api.renameFaceCluster(cluster.id, next || null);
      const saved = result.label;
      setFaces((current) => current.map((item) => item.id === cluster.id ? { ...item, label: saved } : item));
      setActivePerson((current) => current && current.id === cluster.id ? { ...current, label: saved } : current);
      setLabelDrafts((current) => ({ ...current, [cluster.id]: saved || '' }));
      setNotice(saved ? `Saved “${saved}”.` : 'Name cleared.');
    } catch (cause) {
      setLabelDrafts((current) => ({ ...current, [cluster.id]: cluster.label || '' }));
      setError(friendlyError(cause));
    } finally {
      setBusy('');
    }
  }

  async function mergeFaces() {
    const target = mergeTarget || faceSelection[0];
    const sources = faceSelection.filter((id) => id !== target);
    if (!target || sources.length === 0 || busy) return;
    const name = faces.find((face) => face.id === target)?.label || 'Unnamed person';
    if (!window.confirm(`Merge ${sources.length} ${sources.length === 1 ? 'person' : 'people'} into “${name}”? Their photos will be combined.`)) return;
    setBusy('merge');
    setError('');
    try {
      await api.mergeFaceClusters(target, sources);
      setFaceSelection([]);
      setMergeTarget('');
      const page = await api.faceClusters(0, undefined, faceListFilter());
      setFaces(page.clusters);
      setFaceOffset(page.nextOffset);
      setLabelDrafts(Object.fromEntries(page.clusters.map((cluster) => [cluster.id, cluster.label || ''])));
      setNotice(`Merged into “${name}”.`);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy('');
    }
  }

  async function separateSelected(ids = selected) {
    if (!personId || ids.length === 0 || busy) return;
    if (ids.length > MAX_SEPARATE) {
      setError(`Move at most ${MAX_SEPARATE} photos at a time.`);
      return;
    }
    setBusy('separate');
    setError('');
    try {
      const result = await api.separateFace(personId, ids);
      setSelected((current) => current.filter((id) => !ids.includes(id)));
      const [mediaPage, face] = await Promise.all([
        api.faceMedia(personId),
        api.getFaceCluster(personId).catch((cause: unknown) => {
          if (cause instanceof ApiError && cause.status === 404) return null;
          throw cause;
        })
      ]);
      const action = { label: 'Open new person', personId: result.clusterId };
      if (!face) {
        setNotice('Those photos were moved to a new person.', action);
        onNavigate({ tab: 'people', personId: null, fileId: null });
        return;
      }
      setActivePerson(face);
      setFaces((current) => current.map((item) => item.id === face.id ? face : item));
      setItems(mediaPage.items);
      setOffset(mediaPage.next_offset ?? null);
      setNotice('Those photos were moved to a new person.', action);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy('');
    }
  }

  async function addSelectedToAlbum() {
    if (!albumId || librarySelected.length === 0) return;
    try {
      await api.addAlbumItems(albumId, librarySelected);
      const page = await api.albumItems(albumId);
      setItems(page.items);
      setOffset(page.next_offset ?? null);
      setPickerOpen(false);
      setLibrarySelected([]);
      setNotice('Added to the album.');
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function removeSelected(ids = selected) {
    if (!albumId || ids.length === 0) return;
    if (!window.confirm(`Remove ${ids.length} item${ids.length === 1 ? '' : 's'} from this album? The files stay in Drive.`)) return;
    try {
      await api.removeAlbumItems(albumId, ids);
      setItems((current) => current.filter((item) => !ids.includes(item.id)));
      setSelected((current) => current.filter((id) => !ids.includes(id)));
      setNotice('Removed from the album.');
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function trashSelected(ids: string[]) {
    if (ids.length === 0) return;
    if (!window.confirm(`Move ${ids.length} item${ids.length === 1 ? '' : 's'} to trash?`)) return;
    try {
      await api.batchEntries({ action: 'trash', ids });
      setItems((current) => current.filter((item) => !ids.includes(item.id)));
      setSelected([]);
      if (tab === 'people' && personId) {
        const face = await api.getFaceCluster(personId).catch(() => activeFace);
        if (face) setActivePerson(face);
      }
      setNotice(ids.length === 1 ? 'Moved to trash.' : `${ids.length} items moved to trash.`);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function confirmDestination(parentId: string | null) {
    if (!destination) return;
    const result = await api.batchEntries({ action: destination.action, ids: destination.ids, parent_id: parentId });
    setDestination(null);
    setSelected([]);
    if (destination.action === 'move') {
      setItems((current) => current.filter((item) => !destination.ids.includes(item.id)));
    }
    setNotice(`${result.count} item${result.count === 1 ? '' : 's'} ${destination.action === 'copy' ? 'copied' : 'moved'}.`);
  }

  async function openPicker() {
    setPickerOpen(true);
    setLibrarySelected([]);
    try {
      const page = await api.listPhotos();
      setLibrary(page.items);
      setLibraryCursor(page.next_cursor ?? null);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function loadMoreFaces() {
    if (faceOffset == null || pagingFaces.current) return;
    const generation = peopleGeneration.current;
    pagingFaces.current = true;
    try {
      const page = await api.faceClusters(faceOffset, undefined, faceListFilter());
      if (peopleGeneration.current !== generation) return;
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
    } finally {
      pagingFaces.current = false;
    }
  }

  function editPersonName(cluster: FaceCluster, draft: string) {
    if (renameSkip.current === cluster.id) {
      renameSkip.current = null;
      return;
    }
    void renameFace(cluster, draft);
  }

  function cancelPersonName(cluster: FaceCluster) {
    renameSkip.current = cluster.id;
    setLabelDrafts((current) => ({ ...current, [cluster.id]: cluster.label || '' }));
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
      setNotice('Album renamed.');
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function deleteAlbum(album: Album) {
    if (!window.confirm(`Delete the album “${album.name}”? Photos stay in your library.`)) return;
    try {
      await api.deleteAlbum(album.id);
      setAlbums((current) => current.filter((item) => item.id !== album.id));
      if (albumId === album.id) onNavigate({ tab: 'albums', albumId: null, fileId: null });
      setNotice('Album deleted.');
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  function shareItems(ids: string[]) {
    const targets = items.filter((item) => ids.includes(item.id)).map((item) => ({ id: item.id, kind: 'file' as const, name: item.name }));
    if (targets.length) setShareTargets(targets);
  }

  function openMenu(event: ReactMouseEvent, id: string) {
    const ids = selected.includes(id) && selected.length > 1 ? selected : [id];
    if (!selected.includes(id)) {
      setSelected([id]);
      anchor.current = id;
    }
    setMenu({ x: event.clientX, y: event.clientY, ids });
  }

  function menuItems(ids: string[]): MenuItem[] {
    const single = ids.length === 1 ? items.find((item) => item.id === ids[0]) : null;
    return [
      { id: 'open', label: 'Open', hidden: !single, onSelect: () => single && onNavigate({ fileId: single.id }) },
      { id: 'download', label: ids.length > 1 ? 'Download selected' : 'Download', icon: <Download size={15} />, onSelect: () => downloadFiles(ids) },
      { id: 'share', label: 'Share', icon: <Share2 size={15} />, onSelect: () => shareItems(ids) },
      { id: 'move', label: 'Move', icon: <FolderInput size={15} />, onSelect: () => setDestination({ action: 'move', ids }) },
      { id: 'copy', label: 'Copy', icon: <Copy size={15} />, onSelect: () => setDestination({ action: 'copy', ids }) },
      { id: 'remove', label: 'Remove from album', icon: <Trash2 size={15} />, hidden: tab !== 'albums' || !albumId, onSelect: () => void removeSelected(ids) },
      { id: 'separate', label: 'Not this person', icon: <UserRoundX size={15} />, hidden: tab !== 'people' || !personId, onSelect: () => void separateSelected(ids) },
      { id: 'trash', label: 'Move to trash', icon: <Trash2 size={15} />, danger: true, onSelect: () => void trashSelected(ids) }
    ];
  }

  const showingMedia = (tab === 'timeline' || (tab === 'albums' && !!albumId) || (tab === 'people' && !!personId));

  return (
    <section className="photos-page">
      <div className="photos-tabs" role="tablist" aria-label="Photos">
        <button className={tab === 'timeline' ? 'active' : ''} onClick={() => onNavigate({ tab: 'timeline', albumId: null, personId: null, fileId: null })}><Images size={16} /> Library</button>
        <button className={tab === 'people' ? 'active' : ''} onClick={() => onNavigate({ tab: 'people', albumId: null, personId: null, fileId: null })}><ScanFace size={16} /> People</button>
        <button className={tab === 'albums' ? 'active' : ''} onClick={() => onNavigate({ tab: 'albums', albumId: null, personId: null, fileId: null })}><ImageIcon size={16} /> Albums</button>
      </div>

      {error && <div className="notice notice-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}
      {notice && !error && (
        <div className="notice notice-success" role="status">
          <Check size={16} />
          <span>{notice}</span>
          {noticeAction && (
            <button type="button" className="notice-action" onClick={() => onNavigate({ tab: 'people', personId: noticeAction.personId, fileId: null })}>
              {noticeAction.label}
            </button>
          )}
          <button type="button" onClick={() => setNotice('')} aria-label="Dismiss"><X size={16} /></button>
        </div>
      )}
      {uploading && <div className="notice" role="status"><Upload size={16} /><span>{uploading}</span></div>}

      {tab === 'timeline' && (
        <>
          <header className="photos-heading">
            <div>
              <span className="eyebrow">PHOTOS</span>
              <h1>Library</h1>
              <p>Images and videos from your drive, newest first. Originals uploaded from an album live in the Photos folder.</p>
            </div>
            <button className={'button button-secondary' + (selectionMode ? ' is-active' : '')} type="button" aria-pressed={selectionMode} onClick={() => { setSelectionMode((value) => !value); if (selectionMode) setSelected([]); }}>Select</button>
          </header>
          <MediaGroups groups={groups} loading={loading} selected={selected} selectionMode={selectionMode} onSelect={selectMedia} onOpen={(id) => onNavigate({ fileId: id })} onContextMenu={openMenu} />
        </>
      )}

      {tab === 'people' && !personId && (
        <>
          <header className="photos-heading">
            <div>
              <span className="eyebrow">PEOPLE</span>
              <h1>People</h1>
              <p>Faces found in your photos. Open someone to see their pictures, type a name, or merge groups that are the same person.</p>
            </div>
          </header>
          <div className="people-toolbar">
            <label className="people-search">
              <Search size={16} />
              <input value={peopleQuery} onChange={(event) => setPeopleQuery(event.target.value)} placeholder="Search by name" aria-label="Search people" maxLength={80} />
              {peopleQuery && <button type="button" onClick={() => setPeopleQuery('')} aria-label="Clear search"><X size={14} /></button>}
            </label>
            <div className="people-filters" role="tablist" aria-label="Filter people">
              {(['all', 'named', 'unnamed'] as const).map((filter) => (
                <button key={filter} type="button" role="tab" aria-selected={peopleFilter === filter} className={peopleFilter === filter ? 'active' : ''} onClick={() => setPeopleFilter(filter)}>
                  {filter === 'all' ? 'All' : filter === 'named' ? 'Named' : 'Unnamed'}
                </button>
              ))}
            </div>
          </div>
          {faceSelection.length > 0 && (
            <div className="batch-bar" role="toolbar" aria-label="People actions">
              <strong>{faceSelection.length} selected</strong>
              {faceSelection.length > 1 ? (
                <>
                  <label className="batch-merge-target">Merge into
                    <select value={mergeTarget || faceSelection[0]} onChange={(event) => setMergeTarget(event.target.value)}>
                      {faces.filter((face) => faceSelection.includes(face.id)).map((face) => (
                        <option key={face.id} value={face.id}>{face.label || 'Unnamed person'}</option>
                      ))}
                    </select>
                  </label>
                  <button className="batch-action" type="button" disabled={busy === 'merge'} onClick={() => void mergeFaces()}><GitMerge size={15} /> {busy === 'merge' ? 'Merging…' : 'Merge'}</button>
                </>
              ) : <span className="batch-hint">Select another person to merge them together.</span>}
              <button className="batch-action" type="button" onClick={() => { setFaceSelection([]); setMergeTarget(''); }}>Clear</button>
            </div>
          )}
          {loading && faces.length === 0 ? (
            <div className="people-grid" aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => <div className="person-skeleton" key={index} />)}
            </div>
          ) : (
            <div className={'people-grid' + (faceSelection.length > 0 ? ' is-selecting' : '')}>
              {faces.map((cluster) => (
                <article className={'person-card' + (faceSelection.includes(cluster.id) ? ' selected' : '')} key={cluster.id}>
                  <div className="person-avatar-wrap">
                    <label className="person-select">
                      <input type="checkbox" checked={faceSelection.includes(cluster.id)} onChange={() => selectFace(cluster.id, 'toggle')} aria-label={'Select ' + (cluster.label || 'unnamed person')} />
                    </label>
                    <button
                      type="button"
                      className="person-avatar"
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey) {
                          selectFace(cluster.id, event.shiftKey ? 'range' : 'toggle');
                          return;
                        }
                        onNavigate({ tab: 'people', personId: cluster.id, fileId: null });
                      }}
                    >
                      <FacePortrait key={cluster.id + ':' + (cluster.representativeFileId ?? '')} cluster={cluster} />
                    </button>
                  </div>
                  <input
                    className="person-name-input"
                    value={labelDrafts[cluster.id] ?? ''}
                    placeholder="Add a name"
                    maxLength={80}
                    aria-label={'Name for ' + (cluster.label || 'unnamed person')}
                    disabled={busy === 'rename:' + cluster.id}
                    onChange={(event) => setLabelDrafts((current) => ({ ...current, [cluster.id]: event.target.value }))}
                    onBlur={() => editPersonName(cluster, labelDrafts[cluster.id] || '')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelPersonName(cluster);
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  <span className="person-count">{photoCountLabel(cluster.assetCount)}</span>
                </article>
              ))}
            </div>
          )}
          {!loading && !error && faces.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon"><ScanFace size={22} /></span>
              <h2>{debouncedPeopleQuery || peopleFilter !== 'all' ? 'No matching people' : 'No people yet'}</h2>
              <p>{debouncedPeopleQuery || peopleFilter !== 'all' ? 'Try another name, or show everyone.' : 'Faces appear here after photos and videos finish indexing.'}</p>
            </div>
          )}
          {faceOffset != null && <button className="load-more" type="button" onClick={() => void loadMoreFaces()}>Load more people</button>}
        </>
      )}

      {tab === 'people' && personId && (
        personMissing && !loading ? (
          <div className="empty-state">
            <span className="empty-icon"><ScanFace size={22} /></span>
            <h2>Person not found</h2>
            <p>This group was merged or removed.</p>
            <button className="button button-secondary" type="button" onClick={() => onNavigate({ tab: 'people', personId: null, fileId: null })}>Back to people</button>
          </div>
        ) : (
        <>
          <header className="photos-heading person-detail-heading">
            <div className="photos-heading-copy">
              <button className="back-link" type="button" onClick={() => onNavigate({ tab: 'people', personId: null, fileId: null })}>All people</button>
              <div className="person-detail">
                {activeFace ? <FacePortrait key={activeFace.id + ':' + (activeFace.representativeFileId ?? '')} cluster={activeFace} large /> : <span className="face-portrait face-portrait-empty large"><ScanFace size={28} /></span>}
                <div className="person-detail-copy">
                  <h1>
                    {activeFace ? <input
                      className="person-title-input"
                      value={labelDrafts[activeFace.id] ?? ''}
                      placeholder="Add a name"
                      maxLength={80}
                      aria-label="Person name"
                      disabled={busy === 'rename:' + activeFace.id}
                      onChange={(event) => {
                        if (!activeFace) return;
                        setLabelDrafts((current) => ({ ...current, [activeFace.id]: event.target.value }));
                      }}
                      onBlur={() => editPersonName(activeFace, labelDrafts[activeFace.id] || '')}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelPersonName(activeFace);
                          event.currentTarget.blur();
                        }
                      }}
                    /> : 'Loading…'}
                  </h1>
                  <p>{loading && !activeFace ? 'Loading photos…' : `${photoCountLabel(activeFace?.assetCount ?? items.length)}. Select photos of someone else, then choose Not this person.`}</p>
                </div>
              </div>
            </div>
            <div className="heading-actions">
              <button className={'button button-secondary' + (selectionMode ? ' is-active' : '')} type="button" aria-pressed={selectionMode} onClick={() => { setSelectionMode((value) => !value); if (selectionMode) setSelected([]); }}>Select</button>
              <button className="button button-secondary" type="button" disabled={selected.length === 0 || busy === 'separate'} onClick={() => void separateSelected()}><UserRoundX size={16} /> {busy === 'separate' ? 'Moving…' : 'Not this person'}</button>
            </div>
          </header>
          <MediaGroups groups={groups} loading={loading} selected={selected} selectionMode={selectionMode || selected.length > 0} onSelect={selectMedia} onOpen={(id) => onNavigate({ fileId: id })} onContextMenu={openMenu} emptyTitle="No photos in this group" emptyBody="Photos you move out show up as a new person." />
        </>
        )
      )}

      {tab === 'albums' && !albumId && (
        <>
          <header className="photos-heading">
            <div>
              <span className="eyebrow">COLLECTIONS</span>
              <h1>Albums</h1>
              <p>Create an album and upload photos from your computer. Originals are stored in the Photos folder.</p>
            </div>
            <form className="album-create" onSubmit={(event) => void createAlbum(event)}>
              <input value={albumName} onChange={(event) => setAlbumName(event.target.value)} placeholder="New album name" maxLength={120} aria-label="Album name" required />
              <label className="button button-secondary album-file-label">
                <Upload size={16} /> Photos
                <input ref={createFiles} type="file" accept="image/*,video/*" multiple />
              </label>
              <button className="button button-primary" type="submit"><Plus size={16} /> Create</button>
            </form>
          </header>
          <div className="album-grid">
            {albums.map((album) => (
              <article className="album-card" key={album.id}>
                <button className="album-cover" onClick={() => onNavigate({ tab: 'albums', albumId: album.id, fileId: null })}>
                  {album.cover_file_id ? <img src={thumbnailUrl(album.cover_file_id)} alt="" /> : <span className="album-fallback"><ImageIcon size={28} /></span>}
                </button>
                <div className="album-meta">
                  <button className="album-title" onClick={() => onNavigate({ tab: 'albums', albumId: album.id, fileId: null })}>{album.name}</button>
                  <span>{album.item_count} {album.item_count === 1 ? 'item' : 'items'}</span>
                  <AnchoredMenu label={'Actions for ' + album.name} items={[
                    { id: 'open', label: 'Open', onSelect: () => onNavigate({ tab: 'albums', albumId: album.id, fileId: null }) },
                    { id: 'share', label: 'Share', icon: <Share2 size={15} />, onSelect: () => setShareTargets([{ id: album.id, kind: 'album', name: album.name }]) },
                    { id: 'delete', label: 'Delete album', icon: <Trash2 size={15} />, danger: true, onSelect: () => void deleteAlbum(album) }
                  ]}>
                    <MoreHorizontal size={16} />
                  </AnchoredMenu>
                </div>
              </article>
            ))}
          </div>
          {!loading && albums.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon"><ImageIcon size={22} /></span>
              <h2>No albums yet</h2>
              <p>Name an album, optionally choose photos, and create it.</p>
            </div>
          )}
        </>
      )}

      {tab === 'albums' && albumId && (
        <>
          <header className="photos-heading">
            <div className="photos-heading-copy">
              <button className="back-link" onClick={() => onNavigate({ tab: 'albums', albumId: null, fileId: null })}>All albums</button>
              <h1>{activeAlbum?.name || 'Album'}</h1>
              <p>{items.length} visible item{items.length === 1 ? '' : 's'}. Uploads are saved in the Photos folder and added here.</p>
              {activeAlbum && (
                <form className="album-create" onSubmit={(event) => void renameAlbum(event)}>
                  <input name="name" defaultValue={activeAlbum.name} maxLength={120} aria-label="Album name" key={activeAlbum.name} />
                  <button className="button button-secondary" type="submit">Rename</button>
                </form>
              )}
            </div>
            <div className="heading-actions">
              <label className="button button-primary album-file-label">
                <Upload size={16} /> Upload
                <input ref={albumFiles} type="file" accept="image/*,video/*" multiple onChange={(event) => {
                  const files = event.target.files;
                  if (files && files.length && albumId) void uploadIntoAlbum(albumId, files);
                  event.target.value = '';
                }} />
              </label>
              <button className="button button-secondary" onClick={() => void openPicker()}><Plus size={16} /> From library</button>
              {activeAlbum && <button className="button button-secondary" onClick={() => setShareTargets([{ id: activeAlbum.id, kind: 'album', name: activeAlbum.name }])}><Share2 size={16} /> Share</button>}
              {activeAlbum && <button className="button button-quiet-danger" onClick={() => void deleteAlbum(activeAlbum)}>Delete album</button>}
            </div>
          </header>
          <MediaGroups groups={groups} loading={loading} selected={selected} selectionMode={selectionMode || selected.length > 0} onSelect={selectMedia} onOpen={(id) => onNavigate({ fileId: id })} onContextMenu={openMenu} />
        </>
      )}

      {showingMedia && selected.length > 0 && (
        <div className="batch-bar" role="toolbar" aria-label="Selected photos">
          <strong>{selected.length} selected</strong>
          <button className="batch-action" type="button" onClick={() => downloadFiles(selected)}><Download size={15} /> Download</button>
          <button className="batch-action" type="button" onClick={() => shareItems(selected)}><Share2 size={15} /> Share</button>
          <button className="batch-action" type="button" onClick={() => setDestination({ action: 'move', ids: selected })}><FolderInput size={15} /> Move</button>
          <button className="batch-action" type="button" onClick={() => setDestination({ action: 'copy', ids: selected })}><Copy size={15} /> Copy</button>
          {tab === 'albums' && albumId && <button className="batch-action" type="button" onClick={() => void removeSelected()}><Scissors size={15} /> Remove</button>}
          {tab === 'people' && personId && <button className="batch-action" type="button" onClick={() => void separateSelected()}><UserRoundX size={15} /> Not this person</button>}
          <button className="batch-action batch-danger" type="button" onClick={() => void trashSelected(selected)}><Trash2 size={15} /> Trash</button>
          <button className="batch-action" type="button" onClick={() => { setSelected([]); setSelectionMode(false); }}>Clear</button>
        </div>
      )}

      <div ref={sentinel} className="photos-sentinel" />
      {loading && !(tab === 'people' && !personId) && <div className="photos-loading"><span className="spinner" /> Loading photos…</div>}

      {pickerOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerOpen(false); }}>
          <section className="modal-card picker-card" role="dialog" aria-modal="true" aria-labelledby="picker-title">
            <h2 id="picker-title">Add from library</h2>
            <p className="modal-description">Choose images or videos already in your library.</p>
            <div className="picker-grid">
              {library.map((item) => (
                <button key={item.id} type="button" className={librarySelected.includes(item.id) ? 'selected' : ''} onClick={() => setLibrarySelected((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}>
                  <img src={thumbnailUrl(item.id)} alt={item.name} />
                  {librarySelected.includes(item.id) && <Check size={16} />}
                </button>
              ))}
            </div>
            {libraryCursor && <button className="load-more" onClick={() => void loadMoreLibrary()}>Load more media</button>}
            <div className="modal-actions">
              <button className="button button-secondary" onClick={() => setPickerOpen(false)}>Cancel</button>
              <button className="button button-primary" disabled={librarySelected.length === 0} onClick={() => void addSelectedToAlbum()}>Add {librarySelected.length || ''}</button>
            </div>
          </section>
        </div>
      )}

      {shareTargets && (
        <ShareDialog
          entries={shareTargets}
          onClose={() => setShareTargets(null)}
          onCreated={() => setNotice(shareTargets.length > 1 ? 'Share links created.' : 'Share link created.')}
        />
      )}

      {destination && (
        <DestinationDialog
          title={destination.action === 'copy' ? 'Copy photos' : 'Move photos'}
          description={destination.action === 'copy'
            ? 'Choose the Drive folder that should receive copies.'
            : 'Choose the Drive folder that should receive these photos.'}
          confirmLabel={destination.action === 'copy' ? 'Copy here' : 'Move here'}
          startId={null}
          excludeIds={[]}
          onCancel={() => setDestination(null)}
          onConfirm={confirmDestination}
        />
      )}

      {menu && (
        <ContextMenu
          point={{ x: menu.x, y: menu.y }}
          items={menuItems(menu.ids)}
          label="Photo actions"
          onClose={() => setMenu(null)}
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

function FacePortrait({ cluster, large = false }: { cluster: FaceCluster; large?: boolean }) {
  const [crop, setCrop] = useState<ReturnType<typeof faceCropStyle>>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const box = cluster.representativeBoxLeft != null && cluster.representativeBoxTop != null && cluster.representativeBoxWidth != null && cluster.representativeBoxHeight != null
    ? {
      left: cluster.representativeBoxLeft,
      top: cluster.representativeBoxTop,
      width: cluster.representativeBoxWidth,
      height: cluster.representativeBoxHeight
    }
    : null;
  if (!cluster.representativeFileId || failed) {
    return <span className={'face-portrait face-portrait-empty' + (large ? ' large' : '')}><ScanFace size={large ? 32 : 28} /></span>;
  }
  return (
    <span className={'face-portrait' + (large ? ' large' : '') + (ready ? ' is-ready' : '')}>
      <img
        src={thumbnailUrl(cluster.representativeFileId)}
        alt=""
        style={crop ?? undefined}
        onLoad={(event) => {
          const naturalWidth = event.currentTarget.naturalWidth;
          const naturalHeight = event.currentTarget.naturalHeight;
          if (naturalWidth > 0 && naturalHeight > 0) setCrop(faceCropStyle(box, naturalWidth / naturalHeight));
          setReady(true);
        }}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function MediaGroups({
  groups,
  loading,
  onOpen,
  selected,
  selectionMode,
  onSelect,
  onContextMenu,
  emptyTitle = 'No photos or videos yet',
  emptyBody = 'Upload into an album, or add images and videos from Drive.'
}: {
  groups: Array<{ key: string; label: string; items: MediaItem[] }>;
  loading: boolean;
  onOpen: (id: string) => void;
  selected?: string[];
  selectionMode?: boolean;
  onSelect?: (id: string, mode: 'toggle' | 'range') => void;
  onContextMenu?: (event: ReactMouseEvent, id: string) => void;
  emptyTitle?: string;
  emptyBody?: string;
}) {
  if (!loading && groups.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon"><Images size={22} /></span>
        <h2>{emptyTitle}</h2>
        <p>{emptyBody}</p>
      </div>
    );
  }
  return (
    <div className="photo-timeline">
      {groups.map((group) => (
        <section key={group.key} className="photo-day">
          <h2>{group.label}</h2>
          <PhotoMosaic
            items={mosaicItems(group.items)}
            selected={selected}
            selectionMode={selectionMode}
            onOpen={onOpen}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
          />
          <p className="visually-hidden">{group.items.map((item) => `${item.name}, ${formatSize(item.size_bytes)}, ${formatDate(item.created_at)}`).join('. ')}</p>
        </section>
      ))}
    </div>
  );
}
