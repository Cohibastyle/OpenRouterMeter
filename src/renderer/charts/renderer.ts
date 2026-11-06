import {
  createLinearAxis,
  createLogAxis,
  generateTicks,
  generateValueTicks,
  hitTest,
  type LogAxis,
} from '../../shared/logAxis.js';
import { formatAge, formatSpend, formatSpendCompact, formatTokensCompact } from '../../shared/format.js';
import type { ChartData } from '../../shared/types.js';

export interface ChartOptions {
  axis: 'log' | 'linear';
  metric: 'spend' | 'tokens';
  onBinClick?: (index: number) => void;
}

interface RenderedBin {
  start: number;
  end: number;
  value: number;
  input: number;
  output: number;
  partial: boolean;
  missing: boolean;
}

/** Share of a bar's width left empty on each side, and the pixel bounds. */
const BAR_GAP_RATIO = 0.3;
const BAR_GAP_MIN_PX = 2;
const BAR_GAP_MAX_PX = 16;

/**
 * Smallest vertical gap between two value-axis labels, in CSS pixels.
 *
 * The labels are drawn at 9px, so this keeps a grid line and its neighbour from
 * running together when the plot is compressed by a short window.
 */
const VALUE_TICK_MIN_GAP = 26;

const COLORS = {
  spend: '#34d399',
  // Tokens use the tab's orange accent so the chart, the selected interval, and
  // the interval values all read as one measure. Output is a lighter tint of the
  // same hue rather than a second colour, so the stack still reads as one bar.
  input: '#fb923c',
  output: '#fdba74',
  gridMajor: 'rgba(240,246,252,0.16)',
  gridMinor: 'rgba(240,246,252,0.07)',
  label: '#6e7681',
  partial: 'rgba(251,191,36,0.55)',
  missing: 'rgba(240,246,252,0.06)',
  crosshair: 'rgba(240,246,252,0.35)',
};

/**
 * Canvas chart renderer. Every graph uses the logarithmic time axis from FSD
 * section 10.11.1 unless the accessibility override is enabled, in which case a
 * persistent "Linear axis" label is drawn.
 */
export class ChartRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tooltip: HTMLDivElement;
  private data: ChartData | null = null;
  private options: ChartOptions;
  private axis: LogAxis | null = null;
  private bins: RenderedBin[] = [];
  private hoverIndex = -1;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private observer: ResizeObserver | null = null;
  private rafId = 0;

  constructor(container: HTMLElement, options: ChartOptions) {
    this.options = options;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.setAttribute('role', 'img');
    container.appendChild(this.canvas);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    container.appendChild(this.tooltip);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.observer = new ResizeObserver(() => this.scheduleRender());
    this.observer.observe(container);

    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerleave', () => this.onPointerLeave());
    this.canvas.addEventListener('click', (e) => this.onClick(e));

    this.scheduleRender();
  }

  setData(data: ChartData): void {
    this.data = data;
    this.scheduleRender();
  }

  setOptions(options: Partial<ChartOptions>): void {
    this.options = { ...this.options, ...options };
    this.scheduleRender();
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.canvas.remove();
    this.tooltip.remove();
  }

  private scheduleRender(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.render();
    });
  }

  private render(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;

    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    if (!this.data || this.data.bins.length === 0) {
      ctx.fillStyle = COLORS.label;
      ctx.font = '11px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data for this period', this.width / 2, this.height / 2);
      return;
    }

    const padTop = 8;
    const padBottom = 14;
    // A left gutter holds the value labels. Without it the Y axis has nowhere
    // to draw and the plot starts at the very edge.
    const padLeft = 46;
    const padRight = 6;
    const plotWidth = Math.max(1, this.width - padLeft - padRight);
    const plotHeight = Math.max(1, this.height - padTop - padBottom);

    const tEnd = new Date(this.data.period_end).getTime();
    const tStart = new Date(this.data.period_start).getTime();
    const finest = this.finestBin();

    this.axis =
      this.options.axis === 'linear'
        ? createLinearAxis(tStart, tEnd)
        : createLogAxis(tStart, tEnd, finest);

    this.bins = this.data.bins.map((bin) => ({
      start: new Date(bin.start).getTime(),
      end: new Date(bin.end).getTime(),
      value: this.options.metric === 'spend' ? (bin.spend_micro ?? 0) : (bin.input_tokens ?? 0) + (bin.output_tokens ?? 0),
      input: bin.input_tokens ?? 0,
      output: bin.output_tokens ?? 0,
      partial: bin.partial,
      missing: bin.missing,
    }));

    const rawMax = Math.max(
      0,
      ...this.bins.map((b) => (this.options.metric === 'spend' ? b.value : b.input + b.output)),
    );
    // Round the top of the scale up to a labelled tick so the tallest bar never
    // touches an unlabelled edge. A short plot gets fewer grid lines: the labels
    // are 9px tall, so packing five of them into a compressed chart would make
    // them collide.
    const valueTickCount = Math.min(4, Math.max(1, Math.floor(plotHeight / VALUE_TICK_MIN_GAP)));
    const valueTicks = generateValueTicks(rawMax, valueTickCount);
    const maxValue = Math.max(1, valueTicks[valueTicks.length - 1] ?? rawMax);

    // Grid lines first, so data sits above them.
    this.drawGrid(ctx, padLeft, padTop, plotWidth, plotHeight);
    this.drawValueAxis(ctx, padLeft, padTop, plotWidth, plotHeight, valueTicks, maxValue);

    // Bars.
    const barTop = padTop;
    const barHeight = plotHeight;
    for (const bin of this.bins) {
      const rawStart = padLeft + this.axis.positionOf(bin.start) * plotWidth;
      const rawEnd = padLeft + this.axis.positionOf(bin.end) * plotWidth;
      const rawWidth = Math.max(1, rawEnd - rawStart);

      // Inset each bar so neighbouring bars are separated. The gap is a share of
      // the bar's own width, so it stays proportional on the log axis where
      // widths differ by orders of magnitude, and it is capped so a wide bar
      // does not lose most of its area.
      const gap = Math.min(BAR_GAP_MAX_PX, Math.max(BAR_GAP_MIN_PX, rawWidth * BAR_GAP_RATIO));
      const inset = Math.min(gap / 2, Math.max(0, (rawWidth - 1) / 2));
      const xStart = rawStart + inset;
      const w = Math.max(1, rawWidth - inset * 2);

      if (bin.missing) {
        // A visible gap, never a zero-height bar pretending to be zero usage.
        ctx.fillStyle = COLORS.missing;
        ctx.fillRect(xStart, barTop + barHeight - 2, w, 2);
        continue;
      }

      if (this.options.metric === 'spend') {
        const h = Math.max(1, (bin.value / maxValue) * barHeight);
        ctx.fillStyle = bin.partial ? COLORS.partial : COLORS.spend;
        ctx.fillRect(xStart, barTop + barHeight - h, w, h);
      } else {
        const total = bin.input + bin.output;
        const totalH = Math.max(1, (total / maxValue) * barHeight);
        const inputH = total > 0 ? (bin.input / total) * totalH : 0;
        const outputH = totalH - inputH;
        ctx.fillStyle = COLORS.input;
        ctx.fillRect(xStart, barTop + barHeight - inputH, w, inputH);
        ctx.fillStyle = COLORS.output;
        ctx.fillRect(xStart, barTop + barHeight - inputH - outputH, w, outputH);
      }

      if (bin.partial) {
        ctx.fillStyle = COLORS.partial;
        ctx.fillRect(xStart, barTop, w, 1.5);
      }
    }

    // Crosshair.
    if (this.hoverIndex >= 0 && this.hoverIndex < this.bins.length) {
      const bin = this.bins[this.hoverIndex]!;
      const cx = padLeft + this.axis.positionOf((bin.start + bin.end) / 2) * plotWidth;
      ctx.strokeStyle = COLORS.crosshair;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, padTop);
      ctx.lineTo(Math.round(cx) + 0.5, padTop + plotHeight);
      ctx.stroke();
    }

    // Baseline.
    ctx.strokeStyle = COLORS.gridMajor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop + plotHeight + 0.5);
    ctx.lineTo(padLeft + plotWidth, padTop + plotHeight + 0.5);
    ctx.stroke();

    // Axis labels.
    this.drawLabels(ctx, padLeft, padTop + plotHeight + 2, plotWidth);

    // The linear override must be unmistakable, so the label is drawn on the
    // canvas rather than as an overlay that could be covered.
    if (this.options.axis === 'linear') {
      const text = 'Linear axis';
      ctx.font = '9px -apple-system, system-ui, sans-serif';
      const metrics = ctx.measureText(text);
      const boxW = metrics.width + 8;
      const boxH = 13;
      // Inside the plot at the top left. The bottom edge belongs to the X axis
      // labels and the top edge outside the plot belongs to the range header,
      // so this is the only corner that stays clear at every range.
      const boxX = padLeft + 3;
      const boxY = padTop + 3;
      ctx.fillStyle = 'rgba(251,191,36,0.18)';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeStyle = 'rgba(251,191,36,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
      ctx.fillStyle = '#fbbf24';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, boxX + boxW / 2, boxY + boxH / 2 + 0.5);
    }
  }

  /**
   * The nominal bin width, taken as the most common width across the bins. The
   * current partial bin is clamped to the axis end, so using the minimum width
   * would shrink a_min and distort the whole axis.
   */
  private finestBin(): number {
    const counts = new Map<number, number>();
    for (const bin of this.data?.bins ?? []) {
      const w = new Date(bin.end).getTime() - new Date(bin.start).getTime();
      if (w > 0) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const [w, count] of counts) {
      if (count > bestCount || (count === bestCount && w < best)) {
        best = w;
        bestCount = count;
      }
    }
    return best > 0 ? best : 1000;
  }

  /**
   * Horizontal grid lines and their value labels.
   *
   * The X axis is logarithmic by default, but the value axis is always linear:
   * a log value axis would make a bar's height meaningless to read.
   */
  private drawValueAxis(
    ctx: CanvasRenderingContext2D,
    padLeft: number,
    padTop: number,
    plotWidth: number,
    plotHeight: number,
    ticks: ReadonlyArray<number>,
    maxValue: number,
  ): void {
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';

    for (const value of ticks) {
      const y = padTop + plotHeight - (value / maxValue) * plotHeight;
      ctx.strokeStyle = value === 0 ? COLORS.gridMajor : COLORS.gridMinor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, Math.round(y) + 0.5);
      ctx.lineTo(padLeft + plotWidth, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = COLORS.label;
      ctx.fillText(this.formatValue(value), padLeft - 6, y);
    }
  }

  /** Compact label for a value-axis tick, in the chart's own units. */
  private formatValue(value: number): string {
    if (this.options.metric === 'spend') {
      // Values are micro-dollars.
      return formatSpendCompact(value);
    }
    return formatTokensCompact(value);
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    padLeft: number,
    padTop: number,
    plotWidth: number,
    plotHeight: number,
  ): void {
    if (!this.axis) return;
    const ticks = generateTicks(this.axis, {
      width: plotWidth,
      minLabelSpacing: 48,
      calendarNatural: this.data?.scale === '24h',
      nowLabel: 'now',
    });

    for (const tick of ticks) {
      const x = padLeft + tick.position * plotWidth;
      ctx.strokeStyle = tick.major ? COLORS.gridMajor : COLORS.gridMinor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padTop);
      ctx.lineTo(Math.round(x) + 0.5, padTop + plotHeight);
      ctx.stroke();
    }
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    padLeft: number,
    y: number,
    plotWidth: number,
  ): void {
    if (!this.axis) return;
    const ticks = generateTicks(this.axis, {
      width: plotWidth,
      minLabelSpacing: 48,
      calendarNatural: this.data?.scale === '24h',
      nowLabel: 'now',
    });

    ctx.fillStyle = COLORS.label;
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'top';

    for (const tick of ticks) {
      if (!tick.label) continue;
      const x = padLeft + tick.position * plotWidth;
      ctx.textAlign = tick.position > 0.92 ? 'right' : tick.position < 0.08 ? 'left' : 'center';
      ctx.fillText(tick.label, x, y);
    }
  }

  private pointerToIndex(event: PointerEvent): number {
    if (!this.axis) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left - 2;
    const plotWidth = Math.max(1, rect.width - 4);
    return hitTest(this.axis, this.bins, x, plotWidth, 8);
  }

  private onPointerMove(event: PointerEvent): void {
    const index = this.pointerToIndex(event);
    if (index === this.hoverIndex) {
      this.positionTooltip(event);
      return;
    }
    this.hoverIndex = index;
    this.scheduleRender();
    this.updateTooltip();
    this.positionTooltip(event);
  }

  private onPointerLeave(): void {
    this.hoverIndex = -1;
    this.tooltip.hidden = true;
    this.scheduleRender();
  }

  private onClick(event: PointerEvent): void {
    const index = this.pointerToIndex(event);
    if (index >= 0) this.options.onBinClick?.(index);
  }

  private positionTooltip(event: PointerEvent): void {
    if (this.tooltip.hidden) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const tw = this.tooltip.offsetWidth;
    const th = this.tooltip.offsetHeight;
    const left = Math.min(Math.max(2, x + 10), rect.width - tw - 2);
    const top = Math.max(2, y - th - 8);
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  private updateTooltip(): void {
    if (this.hoverIndex < 0 || !this.data) {
      this.tooltip.hidden = true;
      return;
    }
    const bin = this.bins[this.hoverIndex];
    const raw = this.data.bins[this.hoverIndex];
    if (!bin || !raw) {
      this.tooltip.hidden = true;
      return;
    }

    const age = this.axis ? this.axis.tEnd - (bin.start + bin.end) / 2 : 0;
    const title = `${formatAge(age)} ago`;
    const rows: string[] = [];

    if (bin.missing) {
      rows.push('<div class="tt-row"><span>No data</span><span>\u2013</span></div>');
    } else if (this.options.metric === 'spend') {
      rows.push(
        `<div class="tt-row"><span>Spend</span><span>${formatSpend(raw.spend_micro)}</span></div>`,
      );
    } else {
      rows.push(
        `<div class="tt-row"><span>Input</span><span>${formatTokensCompact(raw.input_tokens)}</span></div>`,
        `<div class="tt-row"><span>Output</span><span>${formatTokensCompact(raw.output_tokens)}</span></div>`,
      );
    }

    if (bin.partial) {
      rows.push('<div class="tt-row"><span>Partial</span><span>in progress</span></div>');
    }

    const start = new Date(bin.start);
    const end = new Date(bin.end);
    rows.push(
      `<div class="tt-row"><span>${start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}</span><span>${end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}</span></div>`,
    );

    this.tooltip.innerHTML = `<div class="tt-title">${title}</div>${rows.join('')}`;
    this.tooltip.hidden = false;
  }
}
