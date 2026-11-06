import { CHART_MIN_HEIGHT, HEIGHT_CLASS, SIZE_CLASS } from './constants.js';

export type WidthClass = 'xs' | 's' | 'm' | 'l' | 'xl';
export type HeightClass = 'short' | 'regular' | 'tall';
export type LayoutMode = 'micro' | 'compact' | 'standard' | 'expanded';

/**
 * How much a summary strip cell shows.
 *
 * The interval label is always drawn, because it is the cell's identity and the
 * range button. The value and then the request count are added as the cell
 * grows, so a narrow window degrades to a row of range buttons instead of a row
 * of truncated numbers.
 */
export type StripDetail = 'label' | 'value' | 'full';

/**
 * Content width, in CSS pixels, at which each detail level stops truncating.
 *
 * `value` stacks the interval above the figure, so it only needs room for the
 * wider of the two: about 58px covers `$0.7837` and `66.6M`.
 *
 * `full` puts all three on one line, which is what makes it a distinct level
 * rather than the same layout with one more row. That needs the interval, the
 * figure, and the count side by side: about 132px covers `24h $1,234.56 12 req`
 * with the gaps between them.
 */
export const STRIP_CELL_MIN_WIDTH: Record<StripDetail, number> = {
  label: 0,
  value: 58,
  full: 132,
};

/** Horizontal space the strip spends before any cell content is drawn. */
const VIEW_PAD_X = 10;
const STRIP_GAP = 3;
const CELL_PAD_X = 12;

/**
 * Width available for a cell's own content.
 *
 * The strip is a grid of equal columns inside the view's padding, so this is
 * the window width minus the padding and the gaps between cells, divided by the
 * column count, minus the cell's own horizontal padding.
 */
export function stripCellContentWidth(width: number, columns: number): number {
  const count = Math.max(1, columns);
  const usable = width - VIEW_PAD_X * 2 - STRIP_GAP * (count - 1);
  return usable / count - CELL_PAD_X;
}

/** The richest detail level that fits the cells at this window width. */
export function stripDetailFor(width: number, columns: number): StripDetail {
  const content = stripCellContentWidth(width, columns);
  if (content >= STRIP_CELL_MIN_WIDTH.full) return 'full';
  if (content >= STRIP_CELL_MIN_WIDTH.value) return 'value';
  return 'label';
}

export interface LayoutInfo {
  width: number;
  height: number;
  widthClass: WidthClass;
  heightClass: HeightClass;
  mode: LayoutMode;
  /** Number of summary strip cells visible in one row. */
  stripColumns: number;
  /** True when the strip needs an overflow control. */
  stripOverflow: boolean;
  /** How much each strip cell shows at this width. */
  stripDetail: StripDetail;
  /** True when tabs render as an icon rail. */
  iconRail: boolean;
  /** True when the Log tab collapses its filter row into one button. */
  collapsedFilters: boolean;
  /** True when Settings group headers stack label above value. */
  stackedHeaders: boolean;
  /**
   * True when the home card has room for a real chart. FSD section 7.2 places
   * the chart in Expanded; Standard only gets one when it is tall enough that
   * the chart would still be legible after the metrics and notes.
   */
  showChart: boolean;
}

export function widthClassOf(width: number): WidthClass {
  if (width < SIZE_CLASS.xs) return 'xs';
  if (width < SIZE_CLASS.s) return 's';
  if (width < SIZE_CLASS.m) return 'm';
  if (width < SIZE_CLASS.l) return 'l';
  return 'xl';
}

export function heightClassOf(height: number): HeightClass {
  if (height < HEIGHT_CLASS.short) return 'short';
  if (height < HEIGHT_CLASS.regular) return 'regular';
  return 'tall';
}

export function layoutFor(width: number, height: number): LayoutInfo {
  const widthClass = widthClassOf(width);
  const heightClass = heightClassOf(height);

  let mode: LayoutMode;
  if (widthClass === 'xs' || heightClass === 'short') {
    mode = 'micro';
  } else if (widthClass === 's') {
    // Compact is the S-width mode.
    mode = heightClass === 'tall' ? 'standard' : 'compact';
  } else if (widthClass === 'm') {
    // M is Standard at every height; Expanded requires L or XL.
    mode = 'standard';
  } else {
    mode = heightClass === 'tall' ? 'expanded' : 'standard';
  }

  // The strip is always one row of all five intervals, at every size. Splitting
  // it into a grid with an overflow control hid intervals behind a click and
  // pushed the strip onto two rows, which cost more height than the values it
  // revealed were worth. Narrow windows drop the value and the request count
  // instead, per stripDetailFor.
  const stripColumns = 5;
  const stripOverflow = false;

  return {
    width,
    height,
    widthClass,
    heightClass,
    mode,
    stripDetail: stripDetailFor(width, stripColumns),
    stripColumns,
    stripOverflow,
    iconRail: widthClass === 'xs' || widthClass === 's',
    collapsedFilters: widthClass === 'xs' || widthClass === 's',
    stackedHeaders: widthClass === 'xs',
    // The chart is the point of the range buttons, so it appears whenever there
    // is room for a legible plot. Micro and Compact are too short to draw one.
    // Expanded is tall by definition, so only Standard needs the height test: at
    // Regular height the strip, the headline, and the source note can leave too
    // little for the plot, and the inline chart cannot shrink past its floor, so
    // its X-axis labels would be clipped instead of the chart being dropped.
    showChart: mode === 'expanded' || (mode === 'standard' && height >= CHART_MIN_HEIGHT),
  };
}

/** Snap a proposed size to a nearby size class boundary, per FSD section 7.4. */
export function snapToClassBoundary(width: number, height: number, threshold = 8): { width: number; height: number } {
  const widthBoundaries = [SIZE_CLASS.xs, SIZE_CLASS.s, SIZE_CLASS.m, SIZE_CLASS.l];
  const heightBoundaries = [HEIGHT_CLASS.short, HEIGHT_CLASS.regular];
  let snappedWidth = width;
  let snappedHeight = height;
  for (const b of widthBoundaries) {
    if (Math.abs(width - b) <= threshold) snappedWidth = b;
  }
  for (const b of heightBoundaries) {
    if (Math.abs(height - b) <= threshold) snappedHeight = b;
  }
  return { width: snappedWidth, height: snappedHeight };
}
