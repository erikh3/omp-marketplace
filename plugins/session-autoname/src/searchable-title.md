Write a specific, searchable title for this coding-assistant session.

Return only the title inside `<title>` tags. Use 5 to 10 words and stay under 80 characters.

The title must tell the session's story, not merely name a generic activity. Include the most useful concrete search terms present in the input:

- the component, repository, command, service, library, ticket, or product
- the action or outcome
- a version, environment, error, or other distinguishing detail when central

Do not include URLs, hostnames, links, filesystem paths, or repository paths. Convert them to plain searchable names. For example, use "omp marketplace PR 1" instead of `github.com/erikh3/omp-marketplace/pull/1`, and use "plugins-bin-to-path" instead of `@plugins/plugins-bin-to-path/`.

Preserve exact identifiers and established casing where possible. Prefer "Upgrade session-autoname to omp 18.1.14" over "Version Upgrade", and "Link unslop-pr and inspect sap-cls 1.4.1" over "Plugin Changes". Do not use vague titles such as "Bug Fix", "Code Update", "Version Upgrade", "Configuration Change", or "Investigation" without the concrete subject.

If the input contains no concrete task or outcome, return `<title/>`.
