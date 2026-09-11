# hai-proxy-companion

Shows HAI Proxy usage estimates below the omp prompt. It tracks final response usage for models whose provider URL matches the configured HAI host and port.

```text
HAI ~€1.42 session · ~€12.67/50 today · ~€54.22/500 month · ctx 118k (+9k)
```

`/hai-status` displays the current local estimate plus any manual HAI TUI baseline. `/hai-baseline <daily> <monthly>` records the current HAI TUI or Desktop App values for the current UTC day and month. `/hai-baseline clear` removes it.

## Daily cap

When HAI returns `402 DAILY_CAP_EXCEEDED`, the extension records the event, shows:

```text
HAI daily cap hit. The wallet has requested a lie-down.
```

Then it aborts and gracefully shuts down omp before the retry loop can wait past its configured delay. The current prompt remains resumable through omp's normal shutdown flow.

## Configuration

Plugin settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Shows the widget and tracks HAI usage. |
| `proxyHost` | `localhost` | HAI Proxy host. |
| `proxyPort` | `6655` | HAI Proxy port. |
| `dailyBudgetEur` | `50` | Advisory daily estimate budget. |
| `monthlyBudgetEur` | `500` | Advisory monthly estimate budget. |
| `warningPercentages` | `[50, 80]` | One notification per daily threshold. |
| `contextGrowthWarningTokens` | `100000` | Warn when one completed HAI turn grows context by at least this many tokens. |

## Limits

HAI streaming responses return final token usage but no authoritative cost event or `X-HAI-Usage-Cost` header. The companion prices the completed `turn_end` usage with omp's configured model rates and marks every euro figure with `~`. It never subscribes to streaming `message_update` snapshots, so it records one final usage record per completed turn.

The configured local proxy API key can access documented inference routes but cannot retrieve HAI account usage or caps. The HAI TUI or Desktop App remains authoritative, especially when work occurs from other tools or machines. Use `/hai-baseline` to add the latest HAI UI total to the local ledger.

## Manual baseline

The local companion sees only omp requests after it starts. To include existing HAI activity or work from another client, copy the authoritative `Today` and `This month` figures from HAI TUI or Desktop App:

```text
/hai-baseline 12.67 54.22
```

The companion adds that baseline to its local estimate until UTC day or month rollover. Re-run the command whenever the external HAI total changes.
