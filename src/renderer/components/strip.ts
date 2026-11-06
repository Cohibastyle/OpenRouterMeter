import { formatCount, formatSpendCompact, formatTokensCompact } from '../../shared/format.js';
import type { StripDetail } from '../../shared/layout.js';
import type { Metric, WindowCell } from '../../shared/types.js';
import { clear, el } from './dom.js';

export interface StripOptions {
  metric: Metric;
  /** How much each cell shows; driven by the window width. */
  detail: StripDetail;
  /** The interval whose values and chart are currently shown, if any. */
  selectedKey?: string;
  onCellClick: (cell: WindowCell) => void;
}

const REASON_LABEL: Record<string, string> = {
  source_granularity: 'Source reports coarser data than this window',
  collection_started_later: 'Collection started inside this window',
  gap: 'A known gap overlaps this window',
  retention: 'This window extends before the retention horizon',
  no_data: 'No data yet',
};

export class SummaryStrip {
  readonly root: HTMLDivElement;
  private cells: WindowCell[] = [];
  private options: StripOptions;

  constructor(options: StripOptions) {
    this.options = options;
    this.root = el('div', { class: 'strip', role: 'group', 'aria-label': 'Rolling window summary' });
    this.root.dataset.detail = options.detail;
  }

  update(cells: WindowCell[], options: Partial<StripOptions> = {}): void {
    this.cells = cells;
    this.options = { ...this.options, ...options };
    this.root.dataset.detail = this.options.detail;
    this.render();
  }

  private render(): void {
    clear(this.root);
    for (const cell of this.cells) {
      this.root.appendChild(this.renderCell(cell));
    }
  }

  private renderCell(cell: WindowCell): HTMLButtonElement {
    const unavailable = cell.coverage === 'unavailable';
    const value =
      this.options.metric === 'spend'
        ? unavailable
          ? '\u2013'
          : formatSpendCompact(cell.spend_micro)
        : unavailable
          ? '\u2013'
          : formatTokensCompact(cell.total_tokens);

    const selected = this.options.selectedKey === cell.key;
    const button = el('button', {
      class: 'cell',
      type: 'button',
      'data-coverage': cell.coverage,
      'data-window': cell.key,
      'aria-selected': String(selected),
      'aria-label': this.ariaLabel(cell, value),
      title: this.tooltip(cell),
    });

    button.appendChild(el('span', { class: 'cell-label', text: cell.label }));

    // The value and the request count are added only when the cell is wide
    // enough to draw them without clipping. The label is always drawn: it is
    // the cell's identity and the range button, so a narrow window degrades to
    // a row of range buttons rather than a row of truncated numbers.
    if (this.options.detail !== 'label') {
      button.appendChild(
        el('span', {
          class: 'cell-value',
          'data-metric': this.options.metric,
          text: value,
        }),
      );
    }

    if (this.options.detail === 'full' && cell.request_count !== null) {
      button.appendChild(
        el('span', { class: 'cell-sub', text: `${formatCount(cell.request_count)} req` }),
      );
    }

    if (cell.coverage === 'partial') {
      button.appendChild(el('span', { class: 'cell-marker', text: '~', 'aria-hidden': 'true' }));
    } else if (unavailable) {
      button.appendChild(el('span', { class: 'cell-marker', text: '\u2013', 'aria-hidden': 'true' }));
    }

    button.addEventListener('click', () => this.options.onCellClick(cell));

    return button;
  }

  private ariaLabel(cell: WindowCell, value: string): string {
    const metricName = this.options.metric === 'spend' ? 'spend' : 'tokens';
    if (cell.coverage === 'unavailable') {
      return `${cell.label} ${metricName}: unavailable, ${REASON_LABEL[cell.partial_reason ?? 'no_data'] ?? 'not computable'}`;
    }
    const partial = cell.coverage === 'partial' ? ', partial coverage' : '';
    return `${cell.label} ${metricName}: ${value}${partial}`;
  }

  private tooltip(cell: WindowCell): string {
    const lines: string[] = [`${cell.label} window`];
    if (cell.coverage === 'unavailable') {
      lines.push(REASON_LABEL[cell.partial_reason ?? 'no_data'] ?? 'Not computable');
    } else {
      lines.push(`Spend ${formatSpendCompact(cell.spend_micro)}`);
      lines.push(`Tokens ${formatTokensCompact(cell.total_tokens)}`);
      if (cell.request_count !== null) lines.push(`${formatCount(cell.request_count)} requests`);
      if (cell.coverage === 'partial') {
        lines.push(REASON_LABEL[cell.partial_reason ?? 'no_data'] ?? 'Partial coverage');
      }
    }
    return lines.join('\n');
  }
}
