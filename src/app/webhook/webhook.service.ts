import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject, Observable, shareReplay } from 'rxjs';

export type WebhookPayload = {
  symbol?: string;
  stoppx?: number;
  intent?: string;
  side?: string;
  ALTERNATE_SIGNAL?: string;
  BUY_SELL_SELL?: string;
  SELL_BUY_BUY?: string;
  raw?: unknown;
};

// Types for server-side trading engine state
export type EngineSignal = {
  timeIst: string;
  intent: string;
  stoppx: number | null;
  ltp: number | null;
  receivedAt: number;
};

export type EnginePaperTrade = {
  id: string;
  timeIst: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  unrealizedPnl: number;
};

export type EnginePaperTradeHistory = EnginePaperTrade & {
  exitPrice: number;
  exitTimeIst: string;
  realizedPnl: number;
  reason: string;
  closedAt: number;
};

export type EngineLiveState = {
  state: 'NO_POSITION' | 'POSITION';
  cumulativePnl: number;
  unrealizedPnl: number;
  isLiveActive: boolean;
  blockedAtMs: number | null;
  openTrade: any;
  trades: any[];
};

export type PeakPnlRecord = {
  pnl: number;
  timeIst: string;
  timestamp: number;
};

export type EnginePositionState = {
  fsmState: string;
  threshold: number | null;
  paperTrade: EnginePaperTrade | null;
  paperTrades: EnginePaperTradeHistory[];
  peakPnlHistory: PeakPnlRecord[];
  currentPeakPnl: number | null;
  liveState: EngineLiveState;
  signals: EngineSignal[];
  cumPaperPnl: number;      // unrealized + sum of paper trades history PnL
  cumLivePnl: number;       // sum of live trades realized PnL only
  paperTradeCount: number;  // total paper trades (closed + open)
  liveTradeCount: number;   // total live trades (closed + open)
};

export type EngineState = {
  long: EnginePositionState;
  short: EnginePositionState;
  ltp: Record<string, number>;
  fsm: Record<string, { state: string; threshold: number | null }>;
};

@Injectable({ providedIn: 'root' })
export class WebhookService implements OnDestroy {
  private readonly socket: Socket;
  readonly webhook$: Observable<WebhookPayload>;
  
  // Engine state from server
  private readonly engineStateSubject = new BehaviorSubject<EngineState | null>(null);
  readonly engineState$ = this.engineStateSubject.asObservable();

  constructor() {
    // Use same origin - works when Angular is served from the same server
    this.socket = io();

    this.socket.on('connect', () => {
      console.log('[webhook] socket connected', this.socket.id);
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('[webhook] socket disconnected', reason);
    });

    this.socket.on('connect_error', (error) => {
      console.error('[webhook] socket connect error', error);
    });

    this.webhook$ = new Observable<WebhookPayload>((subscriber) => {
      const handler = (payload: WebhookPayload) => {
        console.log('[webhook] payload received', payload);
        subscriber.next(payload);
      };
      this.socket.on('webhook', handler);
      return () => this.socket.off('webhook', handler);
    }).pipe(shareReplay({ bufferSize: 1, refCount: true }));

    // Listen for engine state updates
    this.socket.on('engine_state', (state: EngineState) => {
      this.engineStateSubject.next(state);
    });
  }

  ngOnDestroy(): void {
    this.socket.disconnect();
  }
}

