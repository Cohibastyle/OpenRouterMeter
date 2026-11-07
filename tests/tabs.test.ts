import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABS, TAB_LABELS, WINDOWS } from '../src/shared/constants.ts';
import { CHART_BIN_MS, CHART_RANGE_MS } from '../src/shared/chart.ts';
import { DEFAULT_SETTINGS, applySettingsPatch, metricForTab } from '../src/shared/settings.ts';
import { SETTINGS_HELP } from '../src/renderer/settingsHelp.ts';

test('tabs appear in the documented order', () => {
  assert.deepEqual(TABS, ['spending', 'requests', 'api', 'models', 'settings']);
});

test('Log is not a tab; it lives inside Settings', () => {
  assert.ok(!TABS.includes('log' as never), 'Log must not be a tab');
  assert.ok(TABS.includes('settings' as never), 'Settings holds the log');
});

test('the Tokens and Keys tabs are labelled by purpose, not by data source', () => {
  assert.equal(TAB_LABELS.requests, 'Tokens');
  assert.equal(TAB_LABELS.api, 'Keys');
  assert.equal(TAB_LABELS.models, 'Models');
});

test('every tab has a label', () => {
  for (const tab of TABS) {
    assert.ok(TAB_LABELS[tab], `${tab} has no label`);
  }
});

test('the Models tab resolves its own metric', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.display.metric_models = 'spend';
  assert.equal(metricForTab(settings, 'models'), 'spend');
  settings.display.metric_models = 'tokens';
  assert.equal(metricForTab(settings, 'models'), 'tokens');
});

test('the Models tab is a valid default tab and can be selected', () => {
  const asDefault = applySettingsPatch(DEFAULT_SETTINGS, { display: { default_tab: 'models' } });
  assert.deepEqual(asDefault.rejected, []);
  assert.equal(asDefault.settings.display.default_tab, 'models');

  const selected = applySettingsPatch(DEFAULT_SETTINGS, { view: { tab: 'models' } });
  assert.deepEqual(selected.rejected, []);
  assert.equal(selected.settings.view.tab, 'models');
});

test('settings that predate the Models tab still load', () => {
  // A stored settings file written before metric_models existed must not fail.
  const legacy = { display: { theme: 'light' as const } };
  const merged = applySettingsPatch(structuredClone(DEFAULT_SETTINGS), legacy);
  assert.deepEqual(merged.rejected, []);
  assert.equal(merged.settings.display.metric_models, DEFAULT_SETTINGS.display.metric_models);
  assert.equal(merged.settings.display.theme, 'light');
});

test('every documented settings control has help text', () => {
  const labels = [
    'Refresh interval',
    'Chart refresh',
    'Pause when hidden',
    'Raw retention',
    'Aggregate retention',
    'Time zone',
    'Week start',
    'Hour format',
    'Stale threshold',
    'Theme',
    'Density',
    'Opacity',
    'Always on top',
    'Ghost mode',
    'Locked mode',
    'Keep inside work area',
    'Snap to edges',
    'Launch at login',
    'Default tab',
    'Micro window',
    'Animations',
  ];
  for (const label of labels) {
    const text = SETTINGS_HELP[label];
    assert.ok(text, `${label} has no help text`);
    // A verbose explanation, not a restatement of the label.
    assert.ok(text.length > 80, `${label} help text is too short: ${text.length}`);
  }
});

test('the window set is the five short rolling ranges', () => {
  const labels = WINDOWS.map((w) => w.key);
  assert.deepEqual(labels, ['10m', '1h', '3h', '6h', '24h']);
  // Shortest first, and every window is strictly longer than the previous one.
  for (let i = 1; i < WINDOWS.length; i += 1) {
    assert.ok(WINDOWS[i]!.ms > WINDOWS[i - 1]!.ms, `${WINDOWS[i]!.key} must be longer`);
  }
});

test('every window has a chart range and bin width', () => {
  for (const window of WINDOWS) {
    assert.ok(CHART_RANGE_MS[window.key] > 0, `${window.key} has no chart range`);
    assert.ok(CHART_BIN_MS[window.key] > 0, `${window.key} has no bin width`);
    // The chart range must match the button, or the axis contradicts the label.
    assert.equal(CHART_RANGE_MS[window.key], window.ms, `${window.key} range mismatch`);
    // Bins must never be finer than the granularity the collector retains.
    assert.ok(
      CHART_BIN_MS[window.key] >= 60_000,
      `${window.key} bins are finer than minute granularity`,
    );
  }
});
