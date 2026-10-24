# unslop-pr

Conditional TTSR rules that prompt the agent to review PR titles and descriptions with `skill://unslop` when common AI wording appears.

## What it does

The rules watch GitHub MCP PR create/update writes and `gh pr create`/`gh pr edit` commands. Case-insensitive, whole-word regexes flag vocabulary, filler phrases, promotional claims, and em dashes. Clean text and metadata-only updates without matched wording do not trigger.

A match interrupts before execution and injects a short review reminder. The agent decides whether to rewrite or retain the wording, then retries. Necessary technical terms, quotations, and literals may stay unchanged. OMP's default repeat policy fires each rule once per session, allowing an unchanged retry after review.

Matching covers the whole payload or command, not just title/body fields. False positives are accepted; regexes do not establish AI authorship. Files referenced by `--body-file` are not inspected.

## Trigger selection

The regexes use the local `unslop` skill's vocabulary and filler list, plus common web examples. Word families include forms of `delve`, `underscore`, `showcase`, `enhance`, `utilize`, and `leverage`. Phrase matches include `it is important to note`, `in order to`, `I hope this helps`, `in today's fast-paced world`, and `not just ... but`. Common technical words such as `within`, `across`, `features`, and `vector` are not standalone triggers.

Sources for the selection, not proof of individual authorship:

- [Juzek and Ward, COLING 2025](https://aclanthology.org/2025.coling-main.426/): lexical overrepresentation in LLM-assisted writing.
- [Kobak et al., Science Advances 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12219543/): excess vocabulary and the limits of identifying individual texts.
- [Launchcraft's writing examples](https://www.launchcraft.io/signals): filler phrases and promotional wording.

## Install

```
/marketplace install unslop-pr@erikh3-omp-marketplace
```

Takes effect on the next session start.
