import { Injectable, NgZone } from '@angular/core';

declare const cast: any;
declare const chrome: any;

@Injectable({ providedIn: 'root' })
export class ChromecastService {
  private session: any = null;
  private castContext: any = null;

  readonly isAvailable = signal(false);
  readonly isCasting = signal(false);

  constructor(private zone: NgZone) {
    this.init();
  }

  private init(): void {
    const checkCast = () => {
      if (typeof cast === 'undefined' || !cast.framework) {
        setTimeout(checkCast, 500);
        return;
      }

      this.castContext = cast.framework.CastContext.getInstance();
      this.castContext.setOptions({
        receiverApplicationId: cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });

      this.isAvailable.set(true);

      this.castContext.addEventListener(
        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        (event: any) => {
          this.zone.run(() => {
            if (event.sessionState === cast.framework.SessionState.SESSION_STARTED) {
              this.session = this.castContext.getCurrentSession();
              this.isCasting.set(true);
            } else if (
              event.sessionState === cast.framework.SessionState.SESSION_ENDED ||
              event.sessionState === cast.framework.SessionState.SESSION_RESUMED
            ) {
              this.isCasting.set(false);
              this.session = null;
            }
          });
        }
      );
    };

    window['__onApiLoaded'] = () => checkCast();
    setTimeout(checkCast, 1000);
  }

  castHls(hlsUrl: string, title: string, thumbnail?: string): void {
    if (!this.session) {
      this.session = this.castContext?.getCurrentSession();
    }
    if (!this.session) return;

    const mediaInfo = new cast.media.MediaInfo(hlsUrl, 'application/x-mpegURL');
    mediaInfo.metadata = new cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = title;
    if (thumbnail) {
      mediaInfo.metadata.images = [{ url: thumbnail }];
    }

    const request = new cast.media.LoadRequest(mediaInfo);
    request.autoplay = true;
    request.currentTime = 0;

    this.session.loadMedia(request);
  }

  stopCasting(): void {
    this.session?.end(true);
  }
}
