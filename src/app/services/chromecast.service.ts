import { Injectable, NgZone, signal } from '@angular/core';

declare const cast: any;
declare const chrome: any;

@Injectable({ providedIn: 'root' })
export class ChromecastService {
  private session: any = null;
  private castContext: any = null;

  readonly isAvailable = signal(false);
  readonly isCasting = signal(false);

  private isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  constructor(private zone: NgZone) {
    this.init();
  }

  private init(): void {
    if (this.isLocalhost) {
      this.isAvailable.set(true);
      console.log('[Chromecast] Modo dev: botón visible sin dispositivo real');
      return;
    }

    const checkCast = () => {
      // El SDK carga por partes. Las clases de media del emisor viven en chrome.cast.media (no en cast.media).
      if (
        typeof cast === 'undefined' || !cast.framework ||
        typeof chrome === 'undefined' || !chrome.cast || !chrome.cast.media || !chrome.cast.AutoJoinPolicy
      ) {
        setTimeout(checkCast, 500);
        return;
      }

      this.castContext = cast.framework.CastContext.getInstance();
      this.castContext.setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
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

    (window as any)['__onApiLoaded'] = () => checkCast();
    setTimeout(checkCast, 1000);
  }

  async castHls(hlsUrl: string, title: string, thumbnail?: string): Promise<void> {
    if (!this.session) {
      this.session = this.castContext?.getCurrentSession();
    }
    if (!this.session) {
      if (this.isLocalhost) {
        console.log('[Chromecast] Demo mode - URL:', hlsUrl, '| Title:', title);
        alert('Chromecast: Modo demo\n\nEn producción esto enviaría el stream a tu TV.\nURL: ' + hlsUrl);
        return;
      }
      if (!this.castContext) {
        return;
      }
      // Abre el selector de dispositivos; la promesa falla si el usuario lo cierra o no hay dispositivos.
      try {
        await this.castContext.requestSession();
      } catch {
        // cancelado por el usuario o sin dispositivos
        return;
      }
      this.session = this.castContext.getCurrentSession();
      if (!this.session) return;
    }

    const mediaInfo = new chrome.cast.media.MediaInfo(hlsUrl, 'application/x-mpegURL');
    mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = title;
    if (thumbnail) {
      mediaInfo.metadata.images = [{ url: thumbnail }];
    }

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.autoplay = true;
    request.currentTime = 0;

    try {
      await this.session.loadMedia(request);
    } catch {
      // el receptor rechazó el stream
    }
  }

  stopCasting(): void {
    this.session?.end(true);
  }
}
