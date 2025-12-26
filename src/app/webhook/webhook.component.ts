import { CommonModule, KeyValuePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatToolbarModule } from '@angular/material/toolbar';
import { WebhookService } from './webhook.service';

@Component({
  selector: 'app-webhook',
  standalone: true,
  imports: [
    CommonModule,
    KeyValuePipe,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatToolbarModule
  ],
  templateUrl: './webhook.component.html',
  styleUrl: './webhook.component.css'
})
export class WebhookComponent {
  private readonly webhookService = inject(WebhookService);
  
  // Direct access to engine state from server
  readonly engineState$ = this.webhookService.engineState$;
}
