import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

const API_BASE = environment.apiUrl;

export interface Clip {
  id: string;
  channel: string;
  platform: string;
  title: string;
  nickname: string;
  createdAt: string;
  durationSeconds: number;
  videoUrl: string;
  thumbUrl: string | null;
}

export interface CreateClipRequest {
  channel: string;
  seconds: number;
  behindSeconds: number;
  title: string;
  nickname: string;
}

/** Error con un mensaje listo para enseñar al usuario. */
export class ClipError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class ClipsService {
  /** Las URLs del API vienen relativas (/clips/xxx.mp4): se completan con el origen de la API. */
  abs(url: string | null): string {
    if (!url) return '';
    return url.startsWith('/') ? `${API_BASE}${url}` : url;
  }

  async list(take = 24, skip = 0): Promise<Clip[]> {
    const res = await fetch(`${API_BASE}/api/clips?take=${take}&skip=${skip}`);
    if (!res.ok) throw new ClipError('No se pudieron cargar los clips.', res.status);
    return res.json();
  }

  async get(id: string): Promise<Clip | null> {
    const res = await fetch(`${API_BASE}/api/clips/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new ClipError('No se pudo cargar el clip.', res.status);
    return res.json();
  }

  async create(req: CreateClipRequest): Promise<Clip> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/clips`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
    } catch {
      throw new ClipError('Sin conexión con el servidor. Inténtalo de nuevo.', 0);
    }

    if (res.ok) return res.json();
    if (res.status === 429)
      throw new ClipError('Has creado demasiados clips seguidos. Espera unos minutos.', 429);

    let msg = 'No se pudo crear el clip.';
    try {
      const body = await res.json();
      if (typeof body?.error === 'string') msg = body.error;
    } catch { /* sin cuerpo JSON */ }
    throw new ClipError(msg, res.status);
  }
}
