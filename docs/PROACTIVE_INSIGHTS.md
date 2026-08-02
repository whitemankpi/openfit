# Proactive health insights

OpenFit's proactive layer follows the useful product pattern behind WHOOP's
Journal, coaching, and performance assessments without copying proprietary
scores or formulas:

- daily feedback is short and timely;
- weekly feedback separates signal from one-day noise;
- observations are compared with the wearer's own baseline;
- behaviour and life events can explain a physiological change;
- every claim keeps its date window, sample size, and data-coverage limits;
- the report ends with one practical action rather than a diagnosis.

## Pipeline

Health collection and deterministic analytics run before a model. Codex gets a
compact manifest, user-approved relevant memory, and read-only aggregate tools.
It never receives the raw archive and never performs statistics from remembered
numbers.

Daily reports use at most four tool calls and focus on recent sleep, recovery,
prior-day load, and coverage. Weekly reports use at most six calls and compare
the last seven days with the prior seven and longer personal baselines. Each
scheduled run gets a fresh ephemeral thread and an output limit in its developer
instructions. Identical evidence is fingerprinted so it cannot create duplicate
reports.

## Memory boundaries

Conversation history, user memory, and reports are distinct:

- conversation history is transient;
- facts, preferences, episodes, and confirmed conclusions are encrypted user
  memory;
- daily and weekly conclusions remain reports unless the user explicitly
  promotes one into memory.

Memory is capped at 50 entries or 4096 serialized bytes. Facts and preferences
are present in the compact manifest. Dated episodes and metric-bound conclusions
are fetched with the `recall` tool only when relevant.

## Privacy

Proactive insights are disabled by default. Enabling them explicitly permits a
compact evidence package and requested aggregates to leave the VPS while the
chat is closed. OAuth credentials, API tokens, raw provider errors, display
name, and the raw archive never enter model context.
