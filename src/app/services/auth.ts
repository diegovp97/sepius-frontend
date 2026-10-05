const TOKEN_KEY = 'sepius_token';

/** Devuelve el JWT guardado si no ha caducado; si no, lo borra y devuelve null. */
export function getToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now() + 30_000) {
      clearToken();
      return null;
    }
    return token;
  } catch {
    clearToken();
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** fetch con la cabecera Authorization. Si la API responde 401, borra el token. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    throw new Error('Sesión caducada: vuelve a iniciar sesión (recarga la página).');
  }
  return res;
}

/** Para <video src> y enlaces de descarga, que no pueden enviar cabeceras. */
export function withToken(url: string): string {
  const token = getToken();
  return token ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : url;
}
