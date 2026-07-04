import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

const SEPIUS_PASSWORD = 'sepius2026';

export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  const authenticated = localStorage.getItem('sepius_auth') === 'true';

  if (authenticated) return true;

  const password = prompt('Contraseña de acceso:');
  if (password === SEPIUS_PASSWORD) {
    localStorage.setItem('sepius_auth', 'true');
    return true;
  }

  alert('Contraseña incorrecta.');
  return router.createUrlTree(['/']);
};
