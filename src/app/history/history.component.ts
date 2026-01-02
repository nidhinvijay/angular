import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatExpansionModule } from '@angular/material/expansion';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';

interface DailySnapshot {
  date: string;
  resetTimestamp: number;
  endTimestamp: number;
  long: {
    paperTrades: any[];
    peakPnlHistory: any[];
    liveTrades: any[];
    signals: any[];
    cumPaperPnl: number;
    cumLivePnl: number;
  };
  short: {
    paperTrades: any[];
    peakPnlHistory: any[];
    liveTrades: any[];
    signals: any[];
    cumPaperPnl: number;
    cumLivePnl: number;
  };
}

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatToolbarModule, MatExpansionModule, RouterLink],
  templateUrl: './history.component.html',
  styleUrl: './history.component.css'
})
export class HistoryComponent implements OnInit {
  history: DailySnapshot[] = [];
  loading = true;
  error: string | null = null;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.loadHistory();
  }

  loadHistory(): void {
    this.loading = true;
    this.http.get<DailySnapshot[]>('/api/history').subscribe({
      next: (data) => {
        this.history = data;
        this.loading = false;
      },
      error: (err) => {
        this.error = err.message;
        this.loading = false;
      }
    });
  }

  formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  }

  getTotalPnl(day: DailySnapshot): number {
    return day.long.cumPaperPnl + day.long.cumLivePnl + day.short.cumPaperPnl + day.short.cumLivePnl;
  }

  getTradeCount(day: DailySnapshot): number {
    return day.long.paperTrades.length + day.short.paperTrades.length;
  }

  getLiveTradeCount(day: DailySnapshot): number {
    return day.long.liveTrades.filter(t => t.action === 'EXIT').length + 
           day.short.liveTrades.filter(t => t.action === 'EXIT').length;
  }
}
