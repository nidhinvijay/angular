import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterModule } from '@angular/router';
import { combineLatest, interval, map, startWith } from 'rxjs';
import { TickFsmStateService } from '../tick/tick-fsm-state.service';
import { WebhookStateService } from '../webhook/webhook-state.service';
import { PaperToLiveService } from '../webhook/paper-to-live.service';

export type SymbolSummary = {
  symbol: string;
  type: 'btc' | 'options';
  fsmState: string;
  ltp: number | null;
  threshold: number | null;
  paperPnl: number;
  cumulativePnl: number;
  liveStatus: 'active' | 'idle' | 'blocked';
  blockedSeconds: number | null;
  hasOpenTrade: boolean;
  route: string;
  // For options - store token for detail view
  token?: number;
  // Additional FSM details for options
  savedBUYThreshold?: number | null;
  lastBUYThreshold?: number | null;
  lastSELLThreshold?: number | null;
  lastSignalAtMs?: number | null;
  lastCheckedAtMs?: number | null;
  lastBlockedAtMs?: number | null;
};

@Component({
  selector: 'app-combined',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatExpansionModule,
    MatIconModule,
    MatTableModule,
    MatToolbarModule
  ],
  templateUrl: './combined.component.html',
  styleUrl: './combined.component.css'
})
export class CombinedComponent {
  private readonly tickFsmService = inject(TickFsmStateService);
  private readonly webhookStateService = inject(WebhookStateService);
  private readonly paperToLiveService = inject(PaperToLiveService);

  readonly viewModel$ = combineLatest([
    this.tickFsmService.fsmBySymbol$,
    this.tickFsmService.tickState$,
    this.tickFsmService.getInstrumentLookup$(),
    this.webhookStateService.getTradeState$(),
    this.webhookStateService.signalState$('btc'),
    this.paperToLiveService.liveTradesBySymbol$,
    this.paperToLiveService.liveModeBySymbol$,
    this.paperToLiveService.blockedUntilBySymbol$,
    interval(1000).pipe(startWith(0))
  ]).pipe(
    map(([fsmBySymbol, tickState, instrumentLookup, tradeState, btcSignalState, liveTradesMap, liveModeMap, blockedUntilMap]) => {
      const now = Date.now();
      const btcSummaries: SymbolSummary[] = [];
      const optionsSummaries: SymbolSummary[] = [];

      // BTC from FSM snapshot
      for (const [symbol, snapshot] of fsmBySymbol.entries()) {
        if (symbol.toUpperCase().includes('BTC')) {
          const ltp = tickState.latestBinanceBySymbol.get(symbol) ?? null;
          
          const trades = tradeState.tradesBySymbol.get(symbol) ?? [];
          const latestTrade = trades[0];
          
          // Check if we are in a position based on FSM state
          const isPosition = snapshot.state.includes('POSITION');
          
          // Paper PnL is only relevant if we are in a position
          const paperPnl = isPosition ? (latestTrade?.unrealizedPnl ?? 0) : 0;
          
          // Cumulative PnL is always the latest value (or 0)
          const cumulativePnl = latestTrade?.cumulativePnl ?? 0;
          
          const isActive = liveModeMap.get(symbol) ?? false;
          const blockedUntil = blockedUntilMap.get(symbol);
          let liveStatus: 'active' | 'idle' | 'blocked' = 'idle';
          let blockedSeconds: number | null = null;
          
          if (isActive) {
            liveStatus = 'active';
          } else if (blockedUntil && blockedUntil > now) {
            liveStatus = 'blocked';
            blockedSeconds = Math.ceil((blockedUntil - now) / 1000);
          }

          btcSummaries.push({
            symbol,
            type: 'btc',
            fsmState: snapshot.state,
            ltp,
            threshold: snapshot.threshold,
            paperPnl,
            cumulativePnl,
            liveStatus,
            blockedSeconds,
            hasOpenTrade: isPosition,
            route: '/btc'
          });
        }
      }

      // Options from tick FSM (Zerodha instruments) - use instrument lookup for names
      const processedTokens = new Set<number>();
      for (const [token, fsm] of tickState.fsmByToken.entries()) {
        if (processedTokens.has(token)) continue;
        processedTokens.add(token);

        // Get actual instrument name from lookup
        const instrumentName = instrumentLookup.map.get(token) ?? `Unknown-${token}`;
        
        // Get LTP from ticks
        const ltp = tickState.latestLtpByToken.get(token) ?? null;

        optionsSummaries.push({
          symbol: instrumentName,
          type: 'options',
          fsmState: fsm.state,
          ltp,
          threshold: fsm.threshold,
          paperPnl: 0,
          cumulativePnl: 0,
          liveStatus: 'idle',
          blockedSeconds: null,
          hasOpenTrade: fsm.state === 'BUYPOSITION',
          route: '/app',
          token,
          // Additional FSM details for expanded view
          savedBUYThreshold: fsm.savedBUYThreshold,
          lastBUYThreshold: fsm.lastBUYThreshold,
          lastSELLThreshold: fsm.lastSELLThreshold,
          lastSignalAtMs: fsm.lastSignalAtMs,
          lastCheckedAtMs: fsm.lastCheckedAtMs,
          lastBlockedAtMs: fsm.lastBlockedAtMs
        });
      }

      // Sort options by state priority
      optionsSummaries.sort((a, b) => {
        const priority: Record<string, number> = {
          'BUYPOSITION': 0,
          'NOPOSITION_SIGNAL': 1,
          'NOPOSITION_BLOCKED': 2,
          'NOSIGNAL': 3
        };
        return (priority[a.fsmState] ?? 99) - (priority[b.fsmState] ?? 99);
      });

      // Calculate totals
      const allSummaries = [...btcSummaries, ...optionsSummaries];
      const totalPaperPnl = allSummaries.reduce((sum, s) => sum + s.paperPnl, 0);
      const totalCumulativePnl = allSummaries.reduce((sum, s) => sum + s.cumulativePnl, 0);
      const activeLiveCount = allSummaries.filter(s => s.liveStatus === 'active').length;
      const openTradesCount = allSummaries.filter(s => s.hasOpenTrade).length;
      const btcOpenTrades = btcSummaries.filter(s => s.hasOpenTrade).length;
      const optionsOpenTrades = optionsSummaries.filter(s => s.hasOpenTrade).length;

      // Get BTC signal and trade details
      const btcSymbol = btcSummaries[0]?.symbol ?? 'BTCUSDT';
      const btcSignals = btcSignalState.bySymbol.get(btcSymbol) ?? [];
      const btcTrades = tradeState.tradesBySymbol.get(btcSymbol) ?? [];
      const btcLiveTrades = liveTradesMap.get(btcSymbol) ?? [];

      return {
        btcSummaries,
        optionsSummaries,
        totalPaperPnl,
        totalCumulativePnl,
        activeLiveCount,
        openTradesCount,
        btcOpenTrades,
        optionsOpenTrades,
        // For detailed views
        btcSignals,
        btcTrades,
        btcLiveTrades,
        btcLiveMode: liveModeMap.get(btcSymbol) ?? false,
        btcBlockedUntil: blockedUntilMap.get(btcSymbol),
        btcBlockedSeconds: blockedUntilMap.get(btcSymbol) 
          ? Math.max(0, Math.ceil((blockedUntilMap.get(btcSymbol)! - now) / 1000))
          : null
      };
    })
  );

  getStatusColor(status: string): 'primary' | 'accent' | 'warn' | undefined {
    switch (status) {
      case 'BUYPOSITION': return 'primary';
      case 'NOPOSITION_SIGNAL': return 'accent';
      case 'NOPOSITION_BLOCKED': return 'warn';
      default: return undefined;
    }
  }

  getLiveStatusIcon(status: 'active' | 'idle' | 'blocked'): string {
    switch (status) {
      case 'active': return '✅';
      case 'blocked': return '🔒';
      default: return '⏸';
    }
  }

  formatPnl(value: number): string {
    if (value === 0) return '$0.00';
    const sign = value > 0 ? '+' : '';
    return `${sign}$${value.toFixed(2)}`;
  }

  formatNumber(value: number | null): string {
    if (value === null) return '--';
    return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  formatTime(ms: number | null | undefined): string {
    if (!ms) return '--';
    const date = new Date(ms);
    return date.toLocaleTimeString('en-IN', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      hour12: false 
    });
  }

  getTimeAgo(ms: number | null | undefined): string {
    if (!ms) return '--';
    const seconds = Math.floor((Date.now() - ms) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
  }
}
