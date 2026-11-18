import type { Album, Entry, FaceCluster, MediaItem } from '../types/mydrive';

export type MainTabParamList = {
  Photos: undefined;
  Files: undefined;
  Shared: undefined;
  Sync: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  MainTabs: undefined;
  PhotoViewer: {
    items: MediaItem[];
    initialIndex: number;
    title?: string;
  };
  FileViewer: {
    entry: Entry;
  };
  AlbumDetail: {
    album: Album;
  };
  PersonDetail: {
    cluster: FaceCluster;
  };
  NasStorage: undefined;
  CacheManagement: undefined;
  Trash: undefined;
  ChangePassword: {
    required?: boolean;
  } | undefined;
};
