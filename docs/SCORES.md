# Composite Scores

OpenFit computes three scores — Recovery, Load, and Sleep quality — entirely
on the device, from measurements Google Health or Fitbit already returned.

These are not Readiness, Strain, Cardio Load, Sleep Score, or Stress Score.
Google Health and Fitbit do not expose those proprietary numbers, and OpenFit
does not try to reproduce them. What follows is OpenFit's own arithmetic: a
documented formula, applied to the wearer's own history, with every factor's
contribution shown next to the number so it can be checked or argued with.
Nothing about a score is sent anywhere; it is recomputed locally each time the
dashboard renders. Source: `src/lib/scores.ts` and `src/lib/home-analysis.ts`.

## How a reading becomes a score

Every factor except Load's is scored the same way:

1. Take the last `BASELINE_WINDOW` (60) days of trend data before the
   selected day.
2. Compute a **robust baseline**: the median and the median absolute
   deviation (MAD), scaled by `MAD_TO_SIGMA` (1.4826) so the spread is
   comparable to a standard deviation. Median and MAD are used instead of
   mean and standard deviation because one feverish night or a missed strap
   should not move the baseline that every other day is judged against — a
   mean and a standard deviation would both shift; a median and a MAD barely
   do.
3. Turn today's reading into a **z-score**: `(current - median) / spread`,
   clamped to ±3 spread units so one extreme reading saturates a factor
   instead of dominating it. The z-score is `null` (and the factor is
   dropped, not scored as zero) when there is no current reading or the
   baseline has no center or spread yet.
4. Convert the z-score to a **0–1 goodness value** with one of three shapes,
   depending on which direction is good for that factor:
   - `higherIsBetter(z) = clamp(0.5 + z/4)` — a reading 2 spread-units above
     baseline already saturates the factor at 1.
   - `lowerIsBetter(z) = clamp(0.5 - z/4)` — mirror image; 2 spread-units
     below baseline saturates at 1.
   - `closerIsBetter(z) = clamp(1 - |z|/3)` — departure from personal normal
     in either direction is worse; saturates at 0 once the reading is 3
     spread-units from baseline in either direction.

Load does not use a z-score; see its own section below.

## Weights and renormalisation

Each score is a weighted sum of its factors' goodness values, scaled to
0–100. If a factor has no reading (sensor not returned by the device, no
baseline yet, etc.), it is **dropped, not scored as zero**: its weight is
redistributed proportionally across the remaining factors, and its label is
added to a `missing` list that the interface can show alongside the score.
If every factor for a score is missing, the score has no value.

Contribution numbers ("points") are rounded with a largest-remainder method
so the listed per-factor contributions always add up to exactly the
displayed score, rather than to something a point off either side.

## Baseline requirements

- Below `MINIMUM_BASELINE_DAYS` (14) days of history, the score shows no
  number at all — the confidence is `insufficient` and `value` is `null`
  regardless of what the factors compute to.
- From 14 up to `SETTLED_BASELINE_DAYS` (30) days, the score is shown but
  marked `building`: treat it as provisional, since the personal baseline it
  is measured against is still forming.
- At 30 days and beyond, confidence is `ready`.

Each score status is `low` below 40, `high` above 70, and `typical` in
between.

## Recovery

**Question it answers:** given last night and the recent trend, how
recovered is the body today, relative to this person's own normal?

| Factor | Weight | Direction |
|---|---|---|
| Heart rate variability (HRV) | 0.35 | higher is better |
| Resting heart rate | 0.25 | lower is better |
| Sleep quality (this run's Sleep quality score) | 0.25 | higher is better |
| Breathing rate | 0.10 | closer to personal baseline is better |
| Skin temperature | 0.05 | closer to personal baseline is better |

HRV, resting heart rate, breathing rate, and skin temperature each get their
own 60-day robust baseline and z-score, per the general method above. The
sleep-quality factor is not a z-score: it plugs in that day's Sleep quality
score (0–100) directly as a 0–1 goodness value, so a night with no
sleep-quality score contributes nothing and its weight is redistributed like
any other missing factor. Baseline days for confidence purposes is the count
of trend points in the 60-day window before the selected date.

## Load

**Question it answers:** how hard has the body worked today, relative to
this person's own hardest recent days?

Load has a single factor, "Time in heart rate zones," weighted 1. Each
zone's minutes are weighted by intensity before being summed:

| Zone | Weight |
|---|---|
| Light | 1 |
| Moderate | 2 |
| Vigorous | 4 |
| Peak | 6 |

That weighted-minutes total is not compared against a baseline z-score.
Instead, OpenFit looks at the wearer's own load values over the trailing
`LOAD_WINDOW` (90) days (excluding the selected day) and takes the **95th
percentile** of those values as the ceiling; the ceiling reads as 100.
Today's goodness is `clamp01(today's load / ceiling)`.

A fixed scale would either be too easy for an athlete training hard every
day or unreachable for someone whose "hard day" is genuinely lighter — there
is no population norm for what a hard day of heart-rate-zone minutes looks
like across trackers, bodies, and sports. Anchoring to the wearer's own 95th
percentile means the scale always means the same thing for that person: 100
is "about as hard as your hardest recent days," regardless of fitness level.
The 95th percentile (rather than the maximum) is used so a single outlier
day does not permanently push the ceiling out of reach. Baseline days for
confidence is the count of past days in the window that actually produced a
load value, not the width of the window itself.

## Sleep quality

**Question it answers:** how good was last night's sleep, not just how long
was it?

| Factor | Weight | Direction |
|---|---|---|
| Duration against personal need | 0.35 | higher is better (capped) |
| Efficiency | 0.20 | higher is better (linear) |
| Deep and REM share | 0.20 | higher is better (z-score) |
| Time to fall asleep (latency) | 0.10 | lower is better (z-score) |
| Time awake during the night (WASO) | 0.10 | lower is better (z-score) |
| Bedtime consistency | 0.05 | tighter spread is better |

- **Duration** is judged against a personal sleep need rather than a fixed
  number: the median of the last 60 days of sleep minutes, clamped to
  420–540 minutes (7–9 hours) so a run of short nights cannot redefine
  "enough sleep" downward. Goodness is `clamp01(minutes slept / need)`.
- **Efficiency** goes straight from the reported percentage to goodness:
  `clamp01((efficiency - 70) / 25)` — 70% efficiency or below scores 0, 95%
  or above scores 1.
- **Deep and REM share** sums deep-sleep and REM minutes, compares that sum
  to its own 60-day robust baseline, and applies `higherIsBetter`.
- **Latency** and **WASO** each get a 60-day robust baseline and
  `lowerIsBetter`.
- **Bedtime consistency** is read from the spread (not a single-night
  z-score) of the midpoint-of-sleep time over the last 14 nights: goodness
  is `clamp01(1 - spread / 90)` minutes. If the spread is degenerate (e.g.
  too few distinct values) but at least 3 nights of data exist, consistency
  is scored 1; with fewer than 3 nights it is missing.

Baseline days for confidence is the count of trend points in the 60-day
window before the selected date, same as Recovery.

## Limitations

- Every factor depends on the sensor actually being present and populated
  by the device, plan, and region — not every tracker or account reports
  HRV, breathing rate, skin temperature, or heart-rate zones. A missing
  factor is listed, not hidden, but the score is only as informative as the
  sensors behind it.
- A sparse archive weakens all three scores: fewer days means a noisier
  robust baseline, a lower-confidence badge, or no score at all below the
  14-day minimum.
- These are not medical assessments. They do not diagnose, and they should
  not be treated as clinical readiness, fitness, or sleep-disorder scores.
