import type { Album, Entry, MediaItem } from '../types/mydrive';

export type MainTabParamList = {
  Photos: undefined;
  Files: undefined;
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
  ChangePassword: {
    required?: boolean;
  } | undefined;
};
