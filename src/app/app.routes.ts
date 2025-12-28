import { Routes } from '@angular/router';
import { BinanceComponent } from './binance/binance.component';
import { CurrentAppComponent } from './current-app/current-app.component';
import { MainPageComponent } from './main-page/main-page.component';
import { CombinedComponent } from './combined/combined.component';
import { WebhookComponent } from './webhook/webhook.component';

export const routes: Routes = [
  { path: '', component: MainPageComponent },
  { path: 'app', component: CurrentAppComponent },
  { path: 'btc', component: WebhookComponent },
  { path: 'btc-old', component: BinanceComponent },
  { path: 'combined', component: CombinedComponent },
  { path: '**', redirectTo: '' }
];

