import { inject, Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { WebhookService, EngineState } from './webhook.service';

/**
 * Live Trade FSM States
 * Based on the FSM table:
 * - NO_POSITION: Not in a live trade
 * - POSITION: Currently in a live trade
 * - CONDN_CHECK: Checking conditions for trade execution
 */
export type LiveFsmState = 'NO_POSITION' | 'POSITION' | 'CONDN_CHECK';

export type LiveTradeRow = {
  id: string;
  timeIst: string;
  symbol: string;
  action: 'ENTRY' | 'EXIT';
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number;
  realizedPnl: number | null;
  cumulativePnl: number;
};

export type LiveFsmSnapshot = {
  state: LiveFsmState;
  isLiveActive: boolean;
  liveTradeOpen: OpenLiveTrade | null;
  cumulativePnl: number;
};

export type OpenLiveTrade = {
  id: string;
  symbol: string;
  entryPrice: number;
  quantity: number;
  lot: number;
  timeIst: string;
};

type LiveStateBySymbol = {
  state: LiveFsmState;
  openTrade: OpenLiveTrade | null;
  trades: LiveTradeRow[];
  cumulativePnl: number;
  unrealizedPnl: number;
  blockedAtMs: number | null;
  pendingPaperTrade: {
    entryPrice: number;
    quantity: number;
    lot: number;
    openedAt: number;
  } | null;
};

/**
 * Paper → Live Trade FSM Service
 * 
 * NOW SYNCS WITH SERVER-SIDE TRADING ENGINE
 * The server handles all trade logic; this service just displays the state.
 */
@Injectable({
  providedIn: 'root'
})
export class PaperToLiveService {
  private readonly webhookService = inject(WebhookService);
  private readonly stateBySymbol = new Map<string, LiveStateBySymbol>();
  
  // 🛡️ Buffer zone thresholds to prevent oscillation
  // Open live trade only when profit > this amount
  private readonly OPEN_THRESHOLD = 4;
  // Protective close only when loss > this amount  
  private readonly CLOSE_THRESHOLD = -1;
  
  private readonly liveTradesSubject = new BehaviorSubject<Map<string, LiveTradeRow[]>>(new Map());
  readonly liveTradesBySymbol$: Observable<Map<string, LiveTradeRow[]>> = this.liveTradesSubject.asObservable();
  
  private readonly liveModeSubject = new BehaviorSubject<Map<string, boolean>>(new Map());
  readonly liveModeBySymbol$: Observable<Map<string, boolean>> = this.liveModeSubject.asObservable();

  private readonly blockedUntilSubject = new BehaviorSubject<Map<string, number | null>>(new Map());
  readonly blockedUntilBySymbol$: Observable<Map<string, number | null>> = this.blockedUntilSubject.asObservable();

  constructor() {
    // Subscribe to server engine state and sync local observables
    this.webhookService.engineState$.subscribe((state) => {
      if (state) {
        this.syncFromServer(state);
      }
    });
  }

  private syncFromServer(state: EngineState): void {
    const tradesMap = new Map<string, LiveTradeRow[]>();
    const liveModeMap = new Map<string, boolean>();
    const blockedMap = new Map<string, number | null>();

    // Process LONG position
    if (state.long && state.long.liveState) {
      const symbol = state.long.paperTrade?.symbol || 'BTCUSDT';
      tradesMap.set(`${symbol}-LONG`, state.long.liveState.trades || []);
      liveModeMap.set(`${symbol}-LONG`, state.long.liveState.isLiveActive);
      blockedMap.set(`${symbol}-LONG`, state.long.liveState.blockedAtMs);
    }

    // Process SHORT position
    if (state.short && state.short.liveState) {
      const symbol = state.short.paperTrade?.symbol || 'BTCUSDT';
      tradesMap.set(`${symbol}-SHORT`, state.short.liveState.trades || []);
      liveModeMap.set(`${symbol}-SHORT`, state.short.liveState.isLiveActive);
      blockedMap.set(`${symbol}-SHORT`, state.short.liveState.blockedAtMs);
    }

    this.liveTradesSubject.next(tradesMap);
    this.liveModeSubject.next(liveModeMap);
    this.blockedUntilSubject.next(blockedMap);
  }

  private readonly BACKEND_LIVE_SIGNAL_URL = 'http://localhost:3001/live-signal';

  private async sendLiveWebhookMessage(
    kind: 'ENTRY' | 'EXIT',
    symbol: string,
    refPrice: number
  ): Promise<void> {
    try {
      console.log('[paper-to-live] 🚀 Sending live signal via backend...', { kind, symbol, refPrice });

      const response = await fetch(this.BACKEND_LIVE_SIGNAL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, symbol, refPrice }),
      });

      const result = await response.json();
      
      if (response.ok) {
        console.log('[paper-to-live] ✅ Live signal sent successfully via backend', {
          kind,
          symbol,
          refPrice,
          response: result
        });
      } else {
        console.error('[paper-to-live] ⚠️ Backend responded with error', {
          status: response.status,
          result
        });
      }
    } catch (err) {
      console.error('[paper-to-live] ❌ Failed to send live signal', {
        kind,
        symbol,
        refPrice,
        error: String(err),
      });
    }
  }

  isLiveModeActive(symbol: string): boolean {
    const state = this.stateBySymbol.get(symbol);
    if (!state) return false;
    const totalPnl = state.cumulativePnl + state.unrealizedPnl;
    return totalPnl > this.OPEN_THRESHOLD;
  }

  getTotalPnl(symbol: string): number {
    const state = this.stateBySymbol.get(symbol);
    if (!state) return 0;
    return state.cumulativePnl + state.unrealizedPnl;
  }

  getLiveState(symbol: string): LiveFsmState {
    return this.stateBySymbol.get(symbol)?.state ?? 'NO_POSITION';
  }

  getSnapshot(symbol: string): LiveFsmSnapshot {
    const state = this.stateBySymbol.get(symbol);
    return {
      state: state?.state ?? 'NO_POSITION',
      isLiveActive: this.isLiveModeActive(symbol),
      liveTradeOpen: state?.openTrade ?? null,
      cumulativePnl: state?.cumulativePnl ?? 0
    };
  }

  updateCumulativePnl(symbol: string, paperCumulativePnl: number): void {
    const state = this.getOrCreateState(symbol);
    const totalBefore = state.cumulativePnl + state.unrealizedPnl;
    state.cumulativePnl = paperCumulativePnl;
    state.unrealizedPnl = 0;
    const totalAfter = state.cumulativePnl + state.unrealizedPnl;
    
    const wasActive = totalBefore > 0;
    const isActive = totalAfter > 0;
    
    if (wasActive !== isActive) {
      console.log('[paper-to-live] Live mode changed', {
        symbol,
        wasActive,
        isActive,
        cumulativePnl: paperCumulativePnl,
        totalPnl: totalAfter
      });
      
      if (wasActive && !isActive) {
        state.blockedAtMs = Date.now();
        console.log('[paper-to-live] 🔒 1-MIN LOCK activated (cumulative update)', {
          symbol,
          blockedAt: new Date(state.blockedAtMs).toISOString()
        });
      }
      if (!wasActive && isActive) {
        state.blockedAtMs = null;
      }
    }
    
    this.emitUpdates(symbol, state);
  }

  updateUnrealizedPnl(symbol: string, unrealizedPnl: number, currentLtp?: number): void {
    const state = this.getOrCreateState(symbol);
    const totalBefore = state.cumulativePnl + state.unrealizedPnl;
    state.unrealizedPnl = unrealizedPnl;
    const totalAfter = state.cumulativePnl + state.unrealizedPnl;
    
    // 🛡️ Buffer zone: use thresholds to prevent oscillation
    const wasAboveOpenThreshold = totalBefore > this.OPEN_THRESHOLD;
    const isAboveOpenThreshold = totalAfter > this.OPEN_THRESHOLD;
    const isBelowCloseThreshold = totalAfter < this.CLOSE_THRESHOLD;
    
    let blockExpired = false;
    if (state.blockedAtMs !== null && this.isFirstSecondNextMinute(state.blockedAtMs, Date.now())) {
      state.blockedAtMs = null;
      blockExpired = true;
      console.log('[paper-to-live] 🔓 1-MIN LOCK expired', { symbol });
    }
    
    // 🛡️ PROTECTIVE CLOSE: Only close if PnL dropped below CLOSE_THRESHOLD (not just <= 0)
    if (state.state === 'POSITION' && state.openTrade && isBelowCloseThreshold) {
      const exitPrice = currentLtp ?? state.openTrade.entryPrice;
      console.log('[paper-to-live] 🛡️ PROTECTIVE CLOSE: PnL dropped below threshold, closing live trade', {
        symbol,
        entryPrice: state.openTrade.entryPrice,
        exitPrice,
        totalPnl: totalAfter,
        threshold: this.CLOSE_THRESHOLD
      });
      this.closeLiveTradeInternal(symbol, state, exitPrice);
    }
    
    const shouldActivate = ((!wasAboveOpenThreshold && isAboveOpenThreshold) || (blockExpired && isAboveOpenThreshold));

    if (shouldActivate && state.pendingPaperTrade && state.state === 'NO_POSITION' && state.blockedAtMs === null) {
      console.log('[paper-to-live] 🚀 MID-FLIGHT ACTIVATION! Opening live trade now', {
        symbol,
        entryPrice: state.pendingPaperTrade.entryPrice,
        totalPnl: totalAfter,
        reason: blockExpired ? 'Block Expired' : 'PnL Crossed 0'
      });
      
      // Use current LTP for live entry if available, otherwise fallback to paper entry
      const liveEntryPrice = currentLtp ?? state.pendingPaperTrade.entryPrice;
      
      this.openLiveTrade(
        symbol,
        state,
        liveEntryPrice,
        state.pendingPaperTrade.quantity,
        state.pendingPaperTrade.lot
      );
    }
    
    if (wasAboveOpenThreshold !== isAboveOpenThreshold) {
      console.log('[paper-to-live] Live mode changed (from unrealized PnL)', {
        symbol,
        wasAboveThreshold: wasAboveOpenThreshold,
        isAboveThreshold: isAboveOpenThreshold,
        cumulativePnl: state.cumulativePnl,
        unrealizedPnl,
        totalPnl: totalAfter,
        openThreshold: this.OPEN_THRESHOLD
      });
      
      if (wasAboveOpenThreshold && !isAboveOpenThreshold) {
        state.blockedAtMs = Date.now();
        console.log('[paper-to-live] 🔒 1-MIN LOCK activated (unrealized update)', {
          symbol,
          blockedAt: new Date(state.blockedAtMs).toISOString()
        });
      }
    }
    
    this.emitUpdates(symbol, state);
  }

  // Internal method to close live trade without checking if paper trade is closed
  private closeLiveTradeInternal(symbol: string, state: LiveStateBySymbol, exitPrice: number): void {
    if (!state.openTrade) return;
    
    const openTrade = state.openTrade;
    const realizedPnl = (exitPrice - openTrade.entryPrice) * openTrade.quantity * openTrade.lot;
    
    const exitRow: LiveTradeRow = {
      id: `${openTrade.id}-exit`,
      timeIst: this.formatIstTime(new Date()),
      symbol,
      action: 'EXIT',
      entryPrice: openTrade.entryPrice,
      exitPrice,
      quantity: openTrade.quantity,
      realizedPnl,
      cumulativePnl: state.cumulativePnl
    };
    
    state.trades = [exitRow, ...state.trades].slice(0, 50);
    state.openTrade = null;
    state.state = 'NO_POSITION';
    
    // 🛡️ FIX: Set 1-minute lock to prevent immediate re-open
    // We DO NOT clear pendingPaperTrade so that if PnL recovers, we can resume (re-enter)
    state.blockedAtMs = Date.now();
    // state.pendingPaperTrade = null;
    
    console.log('[paper-to-live] ✅ LIVE TRADE CLOSED (protective)', {
      symbol,
      entryPrice: openTrade.entryPrice,
      exitPrice,
      realizedPnl,
      cumulativePnl: state.cumulativePnl,
      blockedUntil: new Date(state.blockedAtMs + 60000).toISOString()
    });

    this.sendLiveWebhookMessage('EXIT', symbol, exitPrice);
  }

  onPaperTradeOpen(
    symbol: string,
    entryPrice: number,
    quantity: number,
    lot: number
  ): void {
    const state = this.getOrCreateState(symbol);
    const totalPnl = state.cumulativePnl + state.unrealizedPnl;
    
    state.pendingPaperTrade = {
      entryPrice,
      quantity,
      lot,
      openedAt: Date.now()
    };
    
    if (state.blockedAtMs !== null && this.isFirstSecondNextMinute(state.blockedAtMs, Date.now())) {
       state.blockedAtMs = null;
    }

    // 🛡️ Use threshold to prevent opening on small profit
    if (totalPnl <= this.OPEN_THRESHOLD || state.blockedAtMs !== null) {
      console.log('[paper-to-live] Paper trade opened, waiting for PnL > threshold to activate live', {
        symbol,
        entryPrice,
        cumulativePnl: state.cumulativePnl,
        unrealizedPnl: state.unrealizedPnl,
        totalPnl,
        threshold: this.OPEN_THRESHOLD,
        blocked: state.blockedAtMs !== null
      });
      return;
    }
    
    if (state.state !== 'NO_POSITION') {
      console.log('[paper-to-live] Already in position, skipping', {
        symbol,
        currentState: state.state
      });
      return;
    }
    
    this.openLiveTrade(symbol, state, entryPrice, quantity, lot);
  }
  
  private openLiveTrade(
    symbol: string,
    state: LiveStateBySymbol,
    entryPrice: number,
    quantity: number,
    lot: number
  ): void {
    
    const id = `live-${symbol}-${Date.now()}`;
    const timeIst = this.formatIstTime(new Date());
    
    const openTrade: OpenLiveTrade = {
      id,
      symbol,
      entryPrice,
      quantity,
      lot,
      timeIst
    };
    
    state.openTrade = openTrade;
    state.state = 'POSITION';
    
    const tradeRow: LiveTradeRow = {
      id,
      timeIst,
      symbol,
      action: 'ENTRY',
      entryPrice,
      exitPrice: null,
      quantity,
      realizedPnl: null,
      cumulativePnl: state.cumulativePnl
    };
    
    state.trades = [tradeRow, ...state.trades].slice(0, 50);
    this.emitUpdates(symbol, state);
    
    console.log('[paper-to-live] ✅ LIVE TRADE OPENED (mirrored from paper)', {
      symbol,
      entryPrice,
      quantity,
      lot,
      cumulativePnl: state.cumulativePnl
    });

    this.sendLiveWebhookMessage('ENTRY', symbol, entryPrice);
  }

  onPaperTradeClose(symbol: string, exitPrice: number): void {
    const state = this.stateBySymbol.get(symbol);
    
    if (state) {
      state.pendingPaperTrade = null;
    }
    
    if (!state || state.state !== 'POSITION' || !state.openTrade) {
      console.log('[paper-to-live] No open live trade to close', { symbol });
      return;
    }
    
    const openTrade = state.openTrade;
    const realizedPnl = (exitPrice - openTrade.entryPrice) * openTrade.quantity * openTrade.lot;
    
    const exitRow: LiveTradeRow = {
      id: `${openTrade.id}-exit`,
      timeIst: this.formatIstTime(new Date()),
      symbol,
      action: 'EXIT',
      entryPrice: openTrade.entryPrice,
      exitPrice,
      quantity: openTrade.quantity,
      realizedPnl,
      cumulativePnl: state.cumulativePnl
    };
    
    state.trades = [exitRow, ...state.trades].slice(0, 50);
    state.openTrade = null;
    state.state = 'NO_POSITION';
    
    this.emitUpdates(symbol, state);
    
    console.log('[paper-to-live] ✅ LIVE TRADE CLOSED', {
      symbol,
      entryPrice: openTrade.entryPrice,
      exitPrice,
      realizedPnl,
      cumulativePnl: state.cumulativePnl
    });

    this.sendLiveWebhookMessage('EXIT', symbol, exitPrice);
  }

  getLiveTrades(symbol: string): LiveTradeRow[] {
    return this.stateBySymbol.get(symbol)?.trades ?? [];
  }

  clearTrades(symbol: string): void {
    const state = this.stateBySymbol.get(symbol);
    if (state) {
      state.trades = [];
      state.openTrade = null;
      state.state = 'NO_POSITION';
      this.emitUpdates(symbol, state);
    }
  }

  clearAll(): void {
    this.stateBySymbol.clear();
    this.liveTradesSubject.next(new Map());
    this.liveModeSubject.next(new Map());
    this.blockedUntilSubject.next(new Map());
  }

  private getOrCreateState(symbol: string): LiveStateBySymbol {
    let state = this.stateBySymbol.get(symbol);
    if (!state) {
      state = {
        state: 'NO_POSITION',
        openTrade: null,
        trades: [],
        cumulativePnl: 0,
        unrealizedPnl: 0,
        blockedAtMs: null,
        pendingPaperTrade: null
      };
      this.stateBySymbol.set(symbol, state);
    }
    return state;
  }

  private emitUpdates(symbol: string, state: LiveStateBySymbol): void {
    const tradesMap = new Map(this.liveTradesSubject.value);
    tradesMap.set(symbol, [...state.trades]);
    this.liveTradesSubject.next(tradesMap);
    
    const totalPnl = state.cumulativePnl + state.unrealizedPnl;
    const isBlocked = state.blockedAtMs !== null && !this.isFirstSecondNextMinute(state.blockedAtMs, Date.now());
    const liveModeMap = new Map(this.liveModeSubject.value);
    liveModeMap.set(symbol, totalPnl > this.OPEN_THRESHOLD && !isBlocked);
    this.liveModeSubject.next(liveModeMap);
    
    const blockedUntilMap = new Map(this.blockedUntilSubject.value);
    if (state.blockedAtMs !== null) {
      const blockedMinute = Math.floor(state.blockedAtMs / 60000);
      const nextMinuteStart = (blockedMinute + 1) * 60000;
      blockedUntilMap.set(symbol, nextMinuteStart);
    } else {
      blockedUntilMap.set(symbol, null);
    }
    this.blockedUntilSubject.next(blockedUntilMap);
  }

  private isFirstSecondNextMinute(anchorAtMs: number, tickAtMs: number): boolean {
    const anchorMinute = Math.floor(anchorAtMs / 60000);
    const tickMinute = Math.floor(tickAtMs / 60000);
    return tickMinute > anchorMinute;
  }

  private formatIstTime(date: Date): string {
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false
    });
  }
}
