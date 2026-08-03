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

Each run starts with a deterministic coaching snapshot: the strongest material
changes against the wearer's baseline plus statistically supported relationships
between metrics. Daily reports may make one additional tool call; weekly reports
may make two. Each
scheduled run gets a fresh ephemeral thread and an output limit in its developer
instructions. Identical evidence is fingerprinted so it cannot create duplicate
reports.

The model returns a small structured report rather than a score explanation:
a plain-language headline, up to three meaningful signals, one practical action,
and one optional question that could improve future interpretation. Weights,
points, exhaustive metric lists, and missing sensors are excluded unless missing
data genuinely prevents a conclusion.

Manual runs are asynchronous. The API acknowledges the job immediately and the
UI receives started, completed, or failed state over the existing event stream,
so a long model response cannot leave the browser waiting for a proxy timeout.
Manual runs intentionally bypass report deduplication; scheduled runs do not.

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
