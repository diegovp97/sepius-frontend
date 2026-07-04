import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { environment } from '../../environments/environment';

export const authGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const token = localStorage.getItem('sepius_token');

  if (token) return true;

  const username = prompt('Usuario:');
  if (!username) return router.createUrlTree(['/']);

  const password = prompt('Contraseña:');
  if (!password) return router.createUrlTree(['/']);

  try {
    const res = await fetch(`${environment.apiUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      const data = await res.json();
      localStorage.setItem('sepius_token', data.token);
      return true;
    }

    alert('Credenciales incorrectas.');
    return router.createUrlTree(['/']);
  } catch {
    alert('Error de conexión con el servidor.');
    return router.createUrlTree(['/']);
  }
};
