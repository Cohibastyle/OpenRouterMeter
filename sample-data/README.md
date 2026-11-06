# Sample data

Safe fixtures with no real secrets and no request content.

- `requests.sample.json`: 12 normalized request records spanning the last 24
  hours, used to exercise the rolling windows, the request list, and the chart
  bins without a live account.
- `keys.sample.json`: four key identities, including one removed key, so the
  `removed` label and the historical-name behavior can be verified.

The app generates its own larger sample set at runtime when no credential is
connected, and labels every value as sample data. These files exist so tests and
manual checks can use a small, stable, reviewable fixture.
