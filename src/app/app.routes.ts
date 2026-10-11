import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/dashboard/dashboard').then(m => m.DashboardComponent),
  },
  {
    path: 'clips',
    loadComponent: () => import('./pages/clips/clips').then(m => m.ClipsComponent),
  },
  {
    path: 'clips/:id',
    loadComponent: () => import('./pages/clips/clips').then(m => m.ClipsComponent),
  },
  {
    path: 'youtube',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/youtube/youtube').then(m => m.YoutubeComponent),
  },
];
