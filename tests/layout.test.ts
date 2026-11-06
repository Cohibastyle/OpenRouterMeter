import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutFor,
  snapToClassBoundary,
  stripCellContentWidth,
  stripDetailFor,
  widthClassOf,
  heightClassOf,
} from '../src/shared/layout.ts';
import { applySettingsPatch, DEFAULT_SETTINGS, resetGroup } from '../src/shared/settings.ts';
import { CHART_MIN_HEIGHT } from '../src/shared/constants.ts';
import { redact } from '../src/shared/redact.ts';

test('width classes match the documented boundaries', () => {
  assert.equal(widthClassOf(180), 'xs');
  assert.equal(widthClassOf(239), 'xs');
  assert.equal(widthClassOf(240), 's');
  assert.equal(widthClassOf(359), 's');
  assert.equal(widthClassOf(360), 'm');
  assert.equal(widthClassOf(519), 'm');
  assert.equal(widthClassOf(520), 'l');
  assert.equal(widthClassOf(799), 'l');
  assert.equal(widthClassOf(800), 'xl');
});

test('height classes match the documented boundaries', () => {
  assert.equal(heightClassOf(120), 'short');
  assert.equal(heightClassOf(199), 'short');
  assert.equal(heightClassOf(200), 'regular');
  assert.equal(heightClassOf(399), 'regular');
  assert.equal(heightClassOf(400), 'tall');
});

test('layout modes follow the size class rules', () => {
  assert.equal(layoutFor(180, 120).mode, 'micro', 'XS width is micro');
  assert.equal(layoutFor(320, 150).mode, 'micro', 'Short height is micro');
  assert.equal(layoutFor(320, 240).mode, 'compact', 'S/M with Regular is compact');
  assert.equal(layoutFor(480, 360).mode, 'standard', 'M with Regular is standard');
  assert.equal(layoutFor(480, 500).mode, 'standard', 'M with Tall is standard');
  assert.equal(layoutFor(900, 500).mode, 'expanded', 'L/XL with Tall is expanded');
  assert.equal(layoutFor(900, 300).mode, 'standard', 'L with Regular is standard');
});

test('the strip is one row of five intervals at every size', () => {
  for (const [w, h] of [
    [180, 120],
    [240, 160],
    [320, 240],
    [480, 360],
    [900, 500],
    [1200, 800],
  ] as Array<[number, number]>) {
    const layout = layoutFor(w, h);
    assert.equal(layout.stripColumns, 5, `five columns at ${w}x${h}`);
    assert.equal(layout.stripOverflow, false, `no overflow control at ${w}x${h}`);
  }
});

test('strip cells show the label alone when they are too narrow for a value', () => {
  // Five columns at M width leave about 78px per cell: value, no count.
  assert.equal(stripDetailFor(480, 5), 'value');
  // Five columns at L width leave about 146px per cell: everything fits.
  assert.equal(stripDetailFor(900, 5), 'full');
  // Five columns at XL width leave about 226px per cell.
  assert.equal(stripDetailFor(1200, 5), 'full');
});

test('a cell narrower than a value falls back to the label', () => {
  // Five columns in a 360px window leaves about 54px per cell, below the value
  // threshold, so only the interval is drawn.
  assert.equal(stripDetailFor(360, 5), 'label');
  assert.equal(stripDetailFor(320, 5), 'label');
  assert.equal(stripDetailFor(300, 5), 'label');
  assert.equal(stripDetailFor(180, 5), 'label');
});

test('the smallest windows show only the interval', () => {
  // The minimum window and the size the user reported are both label-only.
  assert.equal(layoutFor(180, 120).stripDetail, 'label');
  assert.equal(layoutFor(320, 240).stripDetail, 'label');
  // A value appears once the cells are wide enough for it.
  assert.equal(layoutFor(480, 360).stripDetail, 'value');
});

test('detail never decreases as the window widens', () => {
  const order = { label: 0, value: 1, full: 2 } as const;
  for (const columns of [1, 2, 5]) {
    let previous = -1;
    for (let width = 180; width <= 1400; width += 10) {
      const rank = order[stripDetailFor(width, columns)];
      assert.ok(rank >= previous, `detail regressed at ${width}px, ${columns} columns`);
      previous = rank;
    }
  }
});

test('cell content width accounts for padding and gaps', () => {
  // One column: the window minus the view padding on both sides and the cell's
  // own padding.
  assert.equal(stripCellContentWidth(180, 1), 180 - 20 - 12);
  // Five columns: the same, minus four 3px gaps, divided five ways.
  assert.equal(stripCellContentWidth(900, 5), (900 - 20 - 12) / 5 - 12);
});

test('the tab bar is an icon rail at every size below M width', () => {
  // Micro used to collapse to a single-tab pager, which hid four of the five
  // tabs behind an arrow. The rail keeps every tab reachable at every size.
  assert.equal(layoutFor(180, 120).iconRail, true);
  assert.equal(layoutFor(320, 150).iconRail, true);
  assert.equal(layoutFor(320, 240).iconRail, true);
  assert.equal(layoutFor(480, 360).iconRail, false);
  assert.equal(layoutFor(900, 500).iconRail, false);
});

test('the tab bar becomes an icon rail below M width', () => {
  assert.equal(layoutFor(320, 240).iconRail, true);
  assert.equal(layoutFor(480, 360).iconRail, false);
});

test('the chart is only drawn when there is height for a legible plot', () => {
  // Micro and Compact never have room for a chart.
  assert.equal(layoutFor(180, 120).showChart, false, 'micro at the minimum size');
  assert.equal(layoutFor(320, 240).showChart, false, 'compact');
  assert.equal(layoutFor(320, 150).showChart, false, 'micro by height');

  // Standard hides the chart below the floor instead of clipping its X axis.
  assert.equal(layoutFor(520, 260).showChart, false, 'standard just below the floor');
  assert.equal(layoutFor(520, CHART_MIN_HEIGHT - 1).showChart, false, 'standard one pixel short');
  assert.equal(layoutFor(520, CHART_MIN_HEIGHT).showChart, true, 'standard at the floor');

  // Expanded is tall by definition, so it always has one.
  assert.equal(layoutFor(900, 500).showChart, true, 'expanded');
});

test('the chart height floor only applies where the chart would be truncated', () => {
  // The gate is a height rule on Standard, not a mode change: the strip, the
  // headline, and the chart's own mode are unaffected by hiding it.
  for (const [w, h] of [
    [520, 200],
    [520, 279],
    [760, 240],
  ] as Array<[number, number]>) {
    const layout = layoutFor(w, h);
    assert.equal(layout.showChart, false, `no chart at ${w}x${h}`);
    assert.equal(layout.mode, 'standard', `still standard at ${w}x${h}`);
    assert.equal(layout.stripColumns, 5, `strip unchanged at ${w}x${h}`);
  }
});

test('the Log tab collapses filters below M width', () => {
  assert.equal(layoutFor(320, 240).collapsedFilters, true);
  assert.equal(layoutFor(480, 360).collapsedFilters, false);
});

test('every view renders at the acceptance-test sizes without an invalid mode', () => {
  const sizes: Array<[number, number]> = [
    [180, 120],
    [240, 160],
    [320, 240],
    [480, 320],
    [640, 480],
    [1200, 800],
  ];
  for (const [w, h] of sizes) {
    const layout = layoutFor(w, h);
    assert.ok(['micro', 'compact', 'standard', 'expanded'].includes(layout.mode));
    assert.ok(layout.stripColumns >= 1 && layout.stripColumns <= 5);
  }
});

test('snapping moves a size onto a nearby class boundary', () => {
  assert.deepEqual(snapToClassBoundary(243, 203), { width: 240, height: 200 });
  assert.deepEqual(snapToClassBoundary(400, 300), { width: 400, height: 300 });
});

test('settings patches reject unknown fields instead of ignoring them', () => {
  const result = applySettingsPatch(DEFAULT_SETTINGS, {
    display: { theme: 'light', bogus_field: 1 },
  });
  assert.equal(result.settings.display.theme, 'light');
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]!.key, 'bogus_field');
  assert.equal(result.rejected[0]!.reason, 'unknown_field');
});

test('settings patches reject out-of-range values and keep the previous value', () => {
  const result = applySettingsPatch(DEFAULT_SETTINGS, { display: { opacity: 10 } });
  assert.equal(result.settings.display.opacity, DEFAULT_SETTINGS.display.opacity);
  assert.equal(result.rejected[0]!.reason, 'invalid_value');
});

test('settings patches reject an unknown group', () => {
  const result = applySettingsPatch(DEFAULT_SETTINGS, { nonsense: { a: 1 } });
  assert.equal(result.rejected[0]!.reason, 'unknown_group');
});

test('reset affects only the named group', () => {
  const modified = applySettingsPatch(DEFAULT_SETTINGS, {
    display: { theme: 'light' },
    parameters: { refresh_sec: 60 },
  }).settings;

  const resetDisplay = resetGroup(modified, 'display');
  assert.equal(resetDisplay.display.theme, 'dark', 'display was reset');
  assert.equal(resetDisplay.parameters.refresh_sec, 60, 'parameters were untouched');

  const resetParameters = resetGroup(modified, 'parameters');
  assert.equal(resetParameters.parameters.refresh_sec, 10);
  assert.equal(resetParameters.display.theme, 'light');
});

test('the credential is redacted at write time', () => {
  const cases = [
    'Authorization: Bearer sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789',
    'key=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789',
    'api_key: sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789',
  ];
  for (const input of cases) {
    const { text, redacted } = redact(input);
    assert.equal(redacted, true, `should redact: ${input}`);
    assert.ok(!text.includes('abcdefghijklmnopqrstuvwxyz0123456789'), `leaked: ${text}`);
  }
});

test('prompt and completion content is redacted', () => {
  const { text, redacted } = redact('prompt: "tell me a secret"');
  assert.equal(redacted, true);
  assert.ok(!text.includes('tell me a secret'));
});

test('ordinary log text is left untouched', () => {
  const { text, redacted } = redact('collected 42 activity rows');
  assert.equal(redacted, false);
  assert.equal(text, 'collected 42 activity rows');
});

test('a credential-shaped label is detected, including masked forms', async () => {
  const { looksLikeCredential } = await import('../src/shared/redact.ts');
  assert.equal(looksLikeCredential('sk-or-v1-1a5...753'), true, 'masked key must be caught');
  assert.equal(looksLikeCredential('sk-or-v1-abcdefghijklmnop'), true);
  assert.equal(looksLikeCredential('prod-key'), false);
  assert.equal(looksLikeCredential('My OpenRouter Key'), false);
  assert.equal(looksLikeCredential(null), false);
  assert.equal(looksLikeCredential(''), false);
});
