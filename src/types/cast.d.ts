declare namespace cast.framework {
  class CastContext {
    static getInstance(): CastContext;
    setOptions(options: any): void;
    getCurrentSession(): any;
    addEventListener(type: string, handler: (event: any) => void): void;
  }

  enum CastContextEventType {
    SESSION_STATE_CHANGED = 'sessionStateChanged',
  }

  enum SessionState {
    SESSION_STARTED = 'SESSION_STARTED',
    SESSION_ENDED = 'SESSION_ENDED',
    SESSION_RESUMED = 'SESSION_RESUMED',
  }
}

declare namespace cast.media {
  const DEFAULT_MEDIA_RECEIVER_APP_ID: string;

  class MediaInfo {
    constructor(contentId: string, contentType: string);
    metadata: any;
  }

  class GenericMediaMetadata {
    title?: string;
    images?: Array<{ url: string }>;
  }

  class LoadRequest {
    constructor(mediaInfo: any);
    autoplay: boolean;
    currentTime: number;
  }
}

declare namespace chrome.cast {
  enum AutoJoinPolicy {
    ORIGIN_SCOPED = 'origin_scoped',
  }
}
