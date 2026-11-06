/**
 * Verbose explanations for every Settings control.
 *
 * These are shown in a hover popup rather than a native `title` tooltip: the
 * text is long enough that the OS tooltip truncates it, and the popup can wrap
 * and stay on screen inside a narrow widget window.
 */
export const SETTINGS_HELP: Record<string, string> = {
  /* ------------------------------ parameters ------------------------------ */
  'Refresh interval':
    'How often the widget re-reads your OpenRouter balance and the summary numbers at the top of each tab. ' +
    'Shorter intervals feel more live but spend more of your API rate limit. ' +
    'The default of 30 seconds is a good balance for a desktop widget.',

  'Chart refresh':
    'How often the graphs are rebuilt from stored data. Charts change slowly, so this is deliberately ' +
    'slower than the summary refresh. Raising it reduces CPU use; lowering it makes a new bucket appear sooner.',

  'Pause when hidden':
    'When on, the widget stops polling while its window is hidden or minimised, and catches up when you ' +
    'bring it back. This saves API calls and battery. Turn it off if you want the history to stay ' +
    'continuous even while the widget is out of sight.',

  'Raw retention':
    'How long individual reporting buckets are kept in the local database. Older rows are deleted. ' +
    'Longer retention lets you scroll further back through the Log and Models tabs at the cost of disk space. ' +
    'This never deletes anything from your OpenRouter account.',

  'Aggregate retention':
    'How long the rolled-up daily totals are kept. Aggregates are tiny compared with raw buckets, so this ' +
    'can be much longer. They are what the Charts subview reads when you page back beyond a day.',

  'Time zone':
    'The time zone used to decide where a day starts and ends when buckets are grouped into days. ' +
    'Use your local zone if you think in local days, or UTC to match the OpenRouter dashboard exactly.',

  'Week start':
    'Which day begins a week when weekly buckets are labelled. This only affects labels and grouping, ' +
    'not the underlying numbers.',

  'Hour format':
    'Whether times are shown as 12-hour (3:00 PM) or 24-hour (15:00). Purely a display preference.',

  'Stale threshold':
    'How old the newest data may be before the widget shows a stale warning. OpenRouter can lag by a few ' +
    'minutes, so a threshold that is too tight produces false alarms.',

  /* -------------------------------- display ------------------------------- */
  Theme:
    'Dark, Light, or System. System follows your macOS appearance setting and switches automatically ' +
    'when the OS does.',

  Density:
    'Comfortable gives rows more padding and is easier to read. Compact fits more rows on screen, ' +
    'which helps when the widget is small.',

  Opacity:
    'How opaque the widget background is. Lower values let more of the desktop show through. ' +
    'Text stays fully opaque, so readability holds up well below 100%.',

  'Always on top':
    'Normal keeps the widget above ordinary windows but lets full-screen apps cover it. ' +
    'Stronger keeps it above almost everything, including some full-screen apps. ' +
    'Off lets other windows cover the widget like any normal window.',

  'Ghost mode':
    'Makes the widget ignore mouse clicks so you can work with the windows underneath it. ' +
    'Turn it off from the menu bar icon, because the widget itself cannot be clicked while it is on.',

  'Locked mode':
    'Prevents accidental dragging and resizing. Useful once you have the widget positioned where you want it.',

  'Keep inside work area':
    'Stops the widget from being dragged off screen or under the menu bar, so it can always be reached again.',

  'Snap to edges':
    'Gently pulls the widget to screen edges and corners when you drop it nearby, for tidy alignment.',

  'Launch at login':
    'Starts the widget automatically when you log in to your Mac, so the numbers are already up to date ' +
    'when you sit down. It adds the widget to your login items; remove it there or here to stop it.',

  'Default tab':
    'Which tab the widget opens on. The tab you were last viewing is remembered separately, so this only ' +
    'applies to a fresh start.',

  'Micro window':
    'The time window used by the compact summary strip when the widget is very small and only one number fits.',

  Animations:
    'On animates transitions. Reduced keeps short fades but removes movement. Off disables animation ' +
    'entirely, which is the calmest option and the lightest on CPU.',

  'Chart time axis':
    'Log compresses older time so a long range stays readable: recent buckets get more width and older ' +
    'ones squeeze together, like a logarithmic grid. Linear gives every bucket equal width. ' +
    'You can also switch this next to any chart.',

  Currency:
    'OpenRouter bills in US dollars, so all spend values are shown in USD and cannot be changed. ' +
    'No currency conversion is applied, because a converted figure would not match your OpenRouter invoice.',

  State:
    'Whether a credential is stored and working. Connected means the widget has a key it could read ' +
    'your usage with. Not connected means it is showing sample data until you add one.',

  /* -------------------------------- api key ------------------------------- */
  'API key':
    'An OpenRouter management key, which can read usage and credit data. Create one at ' +
    'openrouter.ai/settings/keys. The key is stored in the macOS Keychain when encryption is available, ' +
    'and is never written to the log or included in diagnostics.',
};

/** Look up help text, tolerating a missing entry. */
export function helpFor(label: string): string | undefined {
  return SETTINGS_HELP[label];
}
