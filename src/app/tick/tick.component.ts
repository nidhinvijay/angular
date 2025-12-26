import { CommonModule } from '@angular/common';
import { Component, Input, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatTableModule } from '@angular/material/table';
import { MatToolbarModule } from '@angular/material/toolbar';
import { combineLatest, map } from 'rxjs';
import { FsmSymbolSnapshot, TickFsmStateService, TickState } from './tick-fsm-state.service';
import { Tick, TickService } from './tick.service';

type InstrumentLookup = {
  map: Map<number, string>;
  order: Map<number, number>;
  symbolLookup: Map<string, number>;
  tokenSymbols: Map<number, string[]>;
};

type FsmState = 'NOSIGNAL' | 'NOPOSITION_SIGNAL' | 'BUYPOSITION' | 'NOPOSITION_BLOCKED';

type InstrumentFsm = {
  state: FsmState;
  threshold: number | null;
  savedBUYThreshold: number | null;
  lastBUYThreshold: number | null;
  lastSELLThreshold: number | null;
  lastSignalAtMs: number | null;
  lastCheckedAtMs: number | null;
  lastBlockedAtMs: number | null;
};

type TickRow = {
  symbol: string | null;
  ltp: number | null;
  threshold: number | null;
  noSignal: boolean;
  noPositionSignal: boolean;
  buyPosition: boolean;
  noPositionBlocked: boolean;
};

@Component({
  selector: 'app-tick',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCardModule, MatChipsModule, MatTableModule, MatToolbarModule],
  templateUrl: './tick.component.html',
  styleUrl: './tick.component.css'
})
export class TickComponent {
  private readonly fsmStateService = inject(TickFsmStateService);
  private readonly tickService = inject(TickService);
  @Input() includeBinance = false;
  @Input() title = 'Latest 6 Instruments';
  readonly displayedColumns = [
    'index',
    'symbol',
    'ltp',
    'threshold',
    'noSignal',
    'noPositionSignal',
    'buyPosition',
    'noPositionBlocked'
  ];

  readonly latestTicks$ = combineLatest([
    this.fsmStateService.tickState$,
    this.fsmStateService.getInstrumentLookup$(),
    this.fsmStateService.fsmBySymbol$
  ]).pipe(
    map(([state, instrumentLookup, snapshot]) => {
      const orderedTicks = [...state.ticks].sort((left, right) => {
        const leftToken = this.getInstrumentToken(left);
        const rightToken = this.getInstrumentToken(right);
        const leftIndex = leftToken === null
          ? Number.POSITIVE_INFINITY
          : instrumentLookup.order.get(leftToken) ?? Number.POSITIVE_INFINITY;
        const rightIndex = rightToken === null
          ? Number.POSITIVE_INFINITY
          : instrumentLookup.order.get(rightToken) ?? Number.POSITIVE_INFINITY;
        return leftIndex - rightIndex;
      });
      const tickRows = orderedTicks.map((tick) => {
        const token = this.getInstrumentToken(tick);
        const fsm = token === null ? null : this.getFsmFromState(state, token);
        return this.toRow(tick, instrumentLookup.map, fsm);
      });
      const rows = this.includeBinance
        ? this.buildBinanceRows(state, snapshot)
        : tickRows.slice(0, 6);
      return rows;
    })
  );

  formatNumber(value: number | null): string {
    if (value === null || Number.isNaN(value)) {
      return '--';
    }
    return value.toFixed(2);
  }

  clearCache(): void {
    this.tickService.clearCache();
  }

  private getFsmFromState(state: TickState, token: number): InstrumentFsm {
    const fsm = state.fsmByToken.get(token);
    if (fsm) {
      return fsm;
    }
    return this.defaultFsm();
  }

  private defaultFsm(): InstrumentFsm {
    return {
      state: 'NOSIGNAL',
      threshold: null,
      savedBUYThreshold: null,
      lastBUYThreshold: null,
      lastSELLThreshold: null,
      lastSignalAtMs: null,
      lastCheckedAtMs: null,
      lastBlockedAtMs: null
    };
  }

  private getInstrumentToken(tick: Tick): number | null {
    if (typeof tick === 'object' && tick !== null && 'instrument_token' in tick) {
      const value = (tick as { instrument_token?: unknown }).instrument_token;
      return typeof value === 'number' ? value : null;
    }
    return null;
  }

  private toRow(tick: Tick, instrumentMap: Map<number, string>, fsm: InstrumentFsm | null): TickRow {
    if (typeof tick === 'object' && tick !== null) {
      const candidate = tick as {
        instrument_token?: unknown;
        last_price?: unknown;
      };
      const instrumentToken = typeof candidate.instrument_token === 'number'
        ? candidate.instrument_token
        : null;
      const ltp = typeof candidate.last_price === 'number' ? candidate.last_price : null;
      return this.toStateRow(
        instrumentToken === null ? null : instrumentMap.get(instrumentToken) ?? null,
        ltp,
        fsm ?? this.defaultFsm()
      );
    }
    return this.toStateRow(null, null, fsm ?? this.defaultFsm());
  }

  private toStateRow(symbol: string | null, ltp: number | null, fsm: InstrumentFsm): TickRow {
    return {
      symbol,
      ltp,
      threshold: fsm.threshold,
      noSignal: fsm.state === 'NOSIGNAL',
      noPositionSignal: fsm.state === 'NOPOSITION_SIGNAL',
      buyPosition: fsm.state === 'BUYPOSITION',
      noPositionBlocked: fsm.state === 'NOPOSITION_BLOCKED'
    };
  }

  private isBinanceSymbol(symbol: string | undefined): symbol is string {
    return typeof symbol === 'string' && symbol.toUpperCase() === 'BTCUSDT';
  }

  private buildBinanceRows(state: TickState, snapshot: Map<string, FsmSymbolSnapshot>): TickRow[] {
    const rows: TickRow[] = [];
    for (const [symbol, price] of state.latestBinanceBySymbol.entries()) {
      if (!this.isBinanceSymbol(symbol)) {
        continue;
      }
      const snap = snapshot.get(symbol);
      const fsm = snap
        ? {
          ...this.defaultFsm(),
          state: snap.state,
          threshold: snap.threshold,
          lastBUYThreshold: snap.lastBUYThreshold,
          lastSELLThreshold: snap.lastSELLThreshold
        }
        : state.fsmBySymbol.get(symbol) ?? this.defaultFsm();
      rows.push(this.toStateRow(symbol, price, fsm));
    }
    return rows;
  }
}
