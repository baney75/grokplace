interface Window {
  GROKPLACE_API?: string;
  grokplaceFitView?: () => void;
  grokplaceToggleMute?: () => boolean;
  grokplaceSetMuted?: (muted: boolean) => boolean;
  grokplaceEnableSound?: () => boolean;
  webkitAudioContext?: typeof AudioContext;
}

interface WindowEventMap {
  "grokplace:live": CustomEvent<{ t?: string }>;
}
