---
name: unslop-pr
condition:
  - '(?i)\u2014|\\u2014|\b(?:additionally|crucial|delv(?:e[sd]?|ing)|enduring|enhanc(?:e[sd]?|ing)|foster(?:s|ed|ing)?|garner(?:s|ed|ing)?|interplay|intricat(?:e|ely|es|ies)|landscape|pivotal|showcas(?:e[sd]?|ing)|tapestr(?:y|ies)|testament|underscor(?:e[sd]?|ing)|vibrant|utili[sz](?:e[sd]?|ing|ation)|leverag(?:e[sd]?|ing)|facilitat(?:e[sd]?|ing)|numerous|comprehensive|meticulous(?:ly)?|seamless(?:ly)?|groundbreaking|revolutionary)\b'
  - '(?i)\b(?:it(?: is|\x27s) (?:important to note|worth noting)(?: that)?|in order to|due to the fact that|in the event that|experts believe|industry reports suggest|some critics argue|i hope this helps|let me know if|great question|you(?: are|\x27re) absolutely right|of course|certainly|as an ai(?: language model)?|in conclusion|in summary|to summarize|serves as|stands as|plays? a (?:crucial|vital|pivotal|significant) role|in today(?:\x27s|\u2019s) (?:fast[- ]paced world|digital age)|in an era of|game[- ]changer|cutting[- ]edge|unlock(?:s|ed|ing)? (?:potential|value|growth))\b|\bnot (?:just|only)\b[^.!?\r\n]{0,160}\bbut\b'
scope: "tool:write(*create_pull_request), tool:write(*update_pull_request)"
interruptMode: always
---

Apply skill://unslop; rewrite PR wording only if warranted, preserve necessary terms and literals, then retry.
